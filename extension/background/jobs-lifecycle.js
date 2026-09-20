'use strict';
// background/jobs-lifecycle.js -- Abertura, finalização e contabilidade dos jobs.
// Este módulo recebe todas as dependências explícitas para não criar outro estado
// em memória além do snapshot mantido pelo background/state.js.

(function(scope) {
  function createLifecycle(deps) {
    const {
      state, log, syncState, sendProgress, armWatchdog, clearWatchdog,
      indexAddJob, indexRemoveJob, indexJobsOfBatch, delay, generateId,
      markFinalized, isFinalized, finalizedMarkerTtlMinutes,
      releaseGeminiScriptsIfIdle,
    } = deps;

    const markerKey = tabId => `gemini_finalized_${tabId}`;
    const markerAlarm = tabId => `finalization_marker_${tabId}`;

    // chrome.storage não oferece transação entre a marca e o snapshot. O índice
    // persistido funciona como journal: enquanto accountingApplied é falso, o
    // job fica no índice. Se o worker cair nesse intervalo, a reconciliação o
    // encontra e aplica a transição exatamente uma vez.
    async function applyFinalizationAccounting(geminiTabId, job, marker, { recovery = false } = {}) {
      const transition = snapshot => {
        const indexed = Array.isArray(snapshot.jobIndex) ? snapshot.jobIndex : [];
        const belongsToJob = entry => entry && entry.geminiTabId === geminiTabId &&
          (!job.jobId || !entry.jobId || entry.jobId === job.jobId);
        const wasIndexed = indexed.some(belongsToJob);
        // Em recovery, um índice já removido prova que o snapshot com a
        // contabilidade foi salvo antes da suspensão; repetir seria duplicar.
        if (recovery && !wasIndexed) return snapshot;
        snapshot.jobIndex = indexed.filter(entry => !belongsToJob(entry));
        if (!marker.fromError) snapshot.completedJobs = (Number(snapshot.completedJobs) || 0) + 1;
        snapshot.activeJobsCount = Math.max(0, (Number(snapshot.activeJobsCount) || 0) - 1);
        return snapshot;
      };

      if (typeof state.mutate === 'function') {
        await state.mutate(transition);
        return;
      }

      // Ponte para versões que ainda usam a fachada de estado do background.
      const wasIndexed = indexJobsOfBatch(null).some(entry => entry && entry.geminiTabId === geminiTabId &&
        (!job.jobId || !entry.jobId || entry.jobId === job.jobId));
      if (recovery && !wasIndexed) return;
      indexRemoveJob(geminiTabId);
      if (!marker.fromError) state.completedJobs = (Number(state.completedJobs) || 0) + 1;
      state.activeJobsCount = Math.max(0, (Number(state.activeJobsCount) || 0) - 1);
      await syncState();
    }

    async function recoverPendingFinalization(entry) {
      if (!entry || entry.geminiTabId === null || entry.geminiTabId === undefined) return false;
      const geminiTabId = entry.geminiTabId;
      const key = markerKey(geminiTabId);
      const jobKey = `gemini_job_${geminiTabId}`;
      const data = await chrome.storage.local.get([key, jobKey]);
      const marker = data && data[key];
      if (!marker || marker.expiresAt <= Date.now()) return false;
      const job = (data && data[jobKey]) || entry;
      if (marker.jobId && job.jobId && marker.jobId !== job.jobId) return false;

      markFinalized(geminiTabId);
      if (!marker.accountingApplied) {
        await applyFinalizationAccounting(geminiTabId, job, marker, { recovery: true });
        await chrome.storage.local.set({ [key]: { ...marker, accountingApplied: true, accountingRecoveredAt: Date.now() } });
      }
      clearWatchdog(geminiTabId, job.jobId || entry.jobId);
      await chrome.storage.local.remove([jobKey, `wd_data_${geminiTabId}`]);
      return true;
    }

    function updateJobState(geminiTabId, patch = {}) {
      if (geminiTabId === null || geminiTabId === undefined) return Promise.resolve(null);
      const jobKey = `gemini_job_${geminiTabId}`;
      return chrome.storage.local.get([jobKey]).then(data => {
        const job = data && data[jobKey];
        if (!job) return null;
        const next = { ...job, ...patch, updatedAt: Date.now() };
        return chrome.storage.local.set({ [jobKey]: next }).then(() => next);
      });
    }

    async function assertJobOwnership(sender, jobId) {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      if (!jobId || tabId === null) return { owns: false, tabId };
      const data = await chrome.storage.local.get([`gemini_job_${tabId}`]);
      const job = data && data[`gemini_job_${tabId}`];
      return { owns: Boolean(job && job.jobId === jobId), tabId };
    }

    function buildGeminiJobUrl(baseUrl, jobIndex, jobId) {
      try {
        const parsed = new URL(baseUrl);
        parsed.searchParams.set('mangatranslator', 'true');
        parsed.searchParams.set('jobId', jobId);
        if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
          parsed.searchParams.set('jobIndex', String(jobIndex));
        }
        return parsed.toString();
      } catch (_error) {
        return baseUrl;
      }
    }

    async function refreshMaxConcurrency() {
      const data = await chrome.storage.local.get('maxConcurrentJobs');
      state._cachedMaxCon = parseInt(data && data.maxConcurrentJobs, 10) || 1;
      return state._cachedMaxCon;
    }

    async function openGeminiTab(url, executionMode) {
      if (executionMode === 'minimized_window') {
        try {
          const window = await chrome.windows.create({ url, focused: false, state: 'minimized' });
          let tab = (window.tabs && window.tabs[0]) || null;
          if (!tab) tab = (await chrome.tabs.query({ windowId: window.id }))[0];
          if (tab) return { tab, windowId: window.id };
        } catch (_error) { /* fallback abaixo */ }
      }
      const tab = await chrome.tabs.create({ url, active: false });
      return { tab, windowId: tab.windowId };
    }

    async function processNextJob() {
      if (state.stopRequested || (state.jobQueue.length === 0 && state.activeJobsCount === 0)) {
        const stillOpen = !state.stopRequested ? indexJobsOfBatch(state.currentBatchId).length : 0;
        if (stillOpen > 0) {
          state.activeJobsCount = Math.max(state.activeJobsCount, stillOpen);
          await syncState();
          return;
        }
        if (!state.stopRequested && state.jobQueue.length === 0 && state.activeJobsCount === 0) {
          if (state.activeMangaTabId) {
            chrome.tabs.sendMessage(state.activeMangaTabId, { action: 'BATCH_COMPLETE', batchId: state.currentBatchId }, () => { void chrome.runtime.lastError; });
          }
          log('success', 'bg', 'BATCH_DONE', 'Lote finalizado com sucesso!');
          state.isProcessing = false;
          state.activeMangaTabId = null;
          releaseGeminiScriptsIfIdle();
        }
        await syncState();
        return;
      }
      if (state.stopRequested || state.jobQueue.length === 0 || state.activeJobsCount >= state._cachedMaxCon) return;

      const job = state.jobQueue.shift();
      if (!job) return;
      state.activeJobsCount += 1;
      const { mangaTabId, index, prompt } = job;
      const jobId = generateId();
      const batchId = job.batchId || state.currentBatchId;
      state.activeMangaTabId = mangaTabId;
      await syncState();
      log('info', 'bg', 'JOB_START', 'Iniciando imagem', { index, completedJobs: state.completedJobs, totalJobs: state.totalJobs });
      sendProgress(mangaTabId, `🔄 ABRINDO GEMINI (${state.completedJobs + 1}/${state.totalJobs})...`);

      try {
        const settings = await chrome.storage.local.get(['geminiBaseUrl', 'geminiExecutionMode']);
        let baseUrl = settings.geminiBaseUrl || 'https://gemini.google.com/app';
        if (baseUrl === 'https://gemini.google.com/' || baseUrl === 'https://gemini.google.com') baseUrl = 'https://gemini.google.com/app';
        const executionMode = settings.geminiExecutionMode || 'temp_chat';
        const opened = await openGeminiTab(buildGeminiJobUrl(baseUrl, index, jobId), executionMode);
        if (!opened.tab) throw new Error('Não foi possível obter a aba do Gemini');
        const record = { jobId, batchId, mangaTabId, index, prompt, geminiTabId: opened.tab.id, windowId: opened.windowId, executionMode, state: 'opening', attempt: 1, createdAt: Date.now(), updatedAt: Date.now() };
        await chrome.storage.local.set({ [`gemini_job_${opened.tab.id}`]: record });
        indexAddJob({ geminiTabId: opened.tab.id, jobId, batchId, mangaTabId, index });
        await syncState();
        armWatchdog(mangaTabId, index, opened.tab.id, jobId);
        return processNextJob();
      } catch (error) {
        state.activeJobsCount = Math.max(0, state.activeJobsCount - 1);
        const message = error && error.message ? error.message : 'Falha ao abrir Gemini';
        log('error', 'bg', 'JOB_ERROR', 'Erro ao abrir Gemini', { index, error: message });
        chrome.tabs.sendMessage(mangaTabId, { action: 'SHOW_ERROR_INTEGRATED', errorMsg: `Erro ao abrir: ${message}`, imgIndex: index, isDebug: false }, () => { void chrome.runtime.lastError; });
        await syncState();
        return processNextJob();
      }
    }

    async function finalizeJob(geminiTabId, mangaTabId, fromError = false) {
      if (isFinalized(geminiTabId)) return false;
      const jobKey = `gemini_job_${geminiTabId}`;
      const key = markerKey(geminiTabId);
      const data = await chrome.storage.local.get([jobKey, key, 'geminiExecutionMode', 'debugMode']);
      const job = data[jobKey] || {};
      const prior = data[key];
      if (prior && prior.expiresAt > Date.now() && (!job.jobId || prior.jobId === job.jobId)) {
        markFinalized(geminiTabId);
        return false;
      }
      markFinalized(geminiTabId);
      const marker = { jobId: job.jobId || null, fromError: Boolean(fromError), finalizedAt: Date.now(), expiresAt: Date.now() + finalizedMarkerTtlMinutes * 60_000, accountingApplied: false };
      // A marca é escrita antes de qualquer efeito. No restart, a reconciliação
      // pode finalizar a contabilidade pendente usando este registro.
      await chrome.storage.local.set({ [key]: marker });
      chrome.alarms.create(markerAlarm(geminiTabId), { delayInMinutes: finalizedMarkerTtlMinutes });
      await applyFinalizationAccounting(geminiTabId, job, marker);
      await chrome.storage.local.set({ [key]: { ...marker, accountingApplied: true } });
      clearWatchdog(geminiTabId, job.jobId);
      await chrome.storage.local.remove(jobKey);

      if (data.debugMode === true) { processNextJob(); return true; }
      const executionMode = job.executionMode || data.geminiExecutionMode || 'temp_chat';
      if (executionMode === 'temp_chat') {
        setTimeout(() => chrome.tabs.remove(geminiTabId, () => { void chrome.runtime.lastError; }), 600);
        processNextJob();
        return true;
      }
      chrome.tabs.get(geminiTabId, async tab => {
        if (chrome.runtime.lastError || !tab) {
          chrome.tabs.remove(geminiTabId, () => { void chrome.runtime.lastError; });
          processNextJob();
          return;
        }
        if (executionMode !== 'minimized_window') {
          chrome.tabs.remove(geminiTabId, () => { void chrome.runtime.lastError; });
          processNextJob();
          return;
        }
        // Mantém o prazo de limpeza do modo minimizado: o Gemini recebe a
        // oportunidade de apagar a conversa antes de a janela desaparecer.
        const activeUrl = tab.url || '';
        const stored = await chrome.storage.local.get(['deleting_urls']);
        const deletingUrls = Array.isArray(stored.deleting_urls) ? stored.deleting_urls : [];
        if (activeUrl && !deletingUrls.includes(activeUrl)) deletingUrls.push(activeUrl);
        await chrome.storage.local.set({ deleting_urls: deletingUrls });
        chrome.tabs.sendMessage(geminiTabId, { action: 'DELETE_CONVERSATION' }, () => { void chrome.runtime.lastError; });
        processNextJob();
        setTimeout(() => {
          chrome.storage.local.get(['deleting_urls']).then(next => {
            const urls = (next.deleting_urls || []).filter(url => url !== activeUrl);
            return chrome.storage.local.set({ deleting_urls: urls });
          }).catch(() => {});
          if (tab.windowId) chrome.windows.remove(tab.windowId, () => { void chrome.runtime.lastError; });
          else chrome.tabs.remove(geminiTabId, () => { void chrome.runtime.lastError; });
        }, 18_000);
      });
      return true;
    }

    return { updateJobState, assertJobOwnership, refreshMaxConcurrency, processNextJob, finalizeJob, recoverPendingFinalization };
  }
  scope.MangaTranslatorJobsLifecycle = { createLifecycle };
})(typeof self !== 'undefined' ? self : globalThis);
