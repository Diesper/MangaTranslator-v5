'use strict';
// background/state.js — Estado global e persistência do MangaTranslator

(function(scope) {
  // ── Estado Global ─────────────────────────────────────────
  let jobQueue        = [];
  let isProcessing    = false;
  let stopRequested   = false;
  let activeMangaTabId = null;
  let currentBatchId = null;
  let extractionTabs  = {};   
  let totalJobs       = 0;
  let completedJobs   = 0;
  let activeJobsCount = 0;

  // ── Índice durável de jobs abertos ───────────────────────────────────────────
  let jobIndex = [];

  let _cachedMaxCon = 1;
  const _finalizedTabs = new Set();
  let _initialized = false;

  // ── Utilitários ────────────────────────────────────────────────────────────
  function generateId(prefix = '') {
      try {
          if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
              return prefix + crypto.randomUUID();
          }
      } catch (_e) {}
      return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function _markFinalized(geminiTabId) {
      _finalizedTabs.add(geminiTabId);
      const cleanupTimer = setTimeout(() => _finalizedTabs.delete(geminiTabId), 30_000);
      if (cleanupTimer && typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  }

  // ── Persistência de Estado ─────────────────────────────────────────────────
  async function restoreState() {
      const d = await chrome.storage.local.get(['mt_state']);
      if (d.mt_state) {
          jobQueue          = d.mt_state.jobQueue || [];
          isProcessing      = d.mt_state.isProcessing || false;
          stopRequested     = d.mt_state.stopRequested || false;
          activeMangaTabId  = d.mt_state.activeMangaTabId || null;
          currentBatchId = d.mt_state.currentBatchId || null;
          extractionTabs    = d.mt_state.extractionTabs || {};  
          totalJobs         = d.mt_state.totalJobs || 0;
          completedJobs     = d.mt_state.completedJobs || 0;
          activeJobsCount   = d.mt_state.activeJobsCount || 0;
          jobIndex          = Array.isArray(d.mt_state.jobIndex) ? d.mt_state.jobIndex : [];
      }
  }

  async function syncState() {
      await chrome.storage.local.set({
          mt_state: { jobQueue, isProcessing, stopRequested, activeMangaTabId, currentBatchId, extractionTabs, totalJobs, completedJobs, activeJobsCount, jobIndex }
      });
  }

  // ── Manutenção do índice de jobs ─────────────────────────────────────────────
  function indexAddJob(entry) {
      jobIndex = jobIndex.filter(j => j && j.geminiTabId !== entry.geminiTabId);
      jobIndex.push(entry);
  }
  function indexRemoveJob(geminiTabId) {
      const before = jobIndex.length;
      jobIndex = jobIndex.filter(j => j && j.geminiTabId !== geminiTabId);
      return jobIndex.length !== before;
  }
  function indexJobsOfBatch(batchId) {
      if (!batchId) return jobIndex.slice();
      return jobIndex.filter(j => j && j.batchId === batchId);
  }

  function tabExists(tabId) {
      return new Promise(resolve => {
          if (!tabId && tabId !== 0) { resolve(false); return; }
          try {
              chrome.tabs.get(tabId, (tab) => {
                  if (chrome.runtime.lastError || !tab) resolve(false);
                  else resolve(true);
              });
          } catch (_e) { resolve(false); }
      });
  }

  async function reconcileJobs() {
      if (!Array.isArray(jobIndex) || jobIndex.length === 0) {
          activeJobsCount = Math.min(activeJobsCount, 0);
          return { alive: 0, dropped: 0 };
      }

      const alive = [];
      const dropped = [];
      for (const entry of jobIndex) {
          if (!entry) continue;
          const exists = await tabExists(entry.geminiTabId);
          if (exists) alive.push(entry);
          else dropped.push(entry);
      }

      if (dropped.length > 0) {
          const keys = [];
          dropped.forEach(entry => {
              keys.push(`gemini_job_${entry.geminiTabId}`);
              keys.push(`wd_data_${entry.geminiTabId}`);
              const alarmName = entry.jobId ? `watchdog_${entry.jobId}` : `watchdog_${entry.geminiTabId}`;
              chrome.alarms.clear(alarmName, () => {});
          });
          try { await chrome.storage.local.remove(keys); } catch (_e) {}
          
          if (self.MangaTranslatorLog && typeof self.MangaTranslatorLog.log === 'function') {
              self.MangaTranslatorLog.log('warn', 'bg', 'JOB_RECONCILE_DROP', `${dropped.length} job(s) órfão(s) descartado(s) após reinício do worker`, {
                  dropped: dropped.map(j => j.geminiTabId),
              });
          } else if (typeof self.log === 'function') {
              self.log('warn', 'bg', 'JOB_RECONCILE_DROP', `${dropped.length} job(s) órfão(s) descartado(s) após reinício do worker`, {
                  dropped: dropped.map(j => j.geminiTabId),
              });
          }
      }

      jobIndex = alive;
      activeJobsCount = alive.length;
      if (alive.length > 0 && !activeMangaTabId) {
          activeMangaTabId = alive[0].mangaTabId || null;
      }
      return { alive: alive.length, dropped: dropped.length };
  }

  async function ensureInitialized() {
      if (_initialized) return;
      await restoreState();
      _initialized = true;
      try {
          const result = await reconcileJobs();
          if (result.dropped > 0 || result.alive > 0) {
              await syncState();
              if (result.dropped > 0 && typeof self.processNextJob === 'function') {
                  self.processNextJob();
              }
          }
      } catch (_e) {}
  }

  scope.MangaTranslatorState = {
      // Getters/setters for state
      get jobQueue() { return jobQueue; },
      set jobQueue(v) { jobQueue = v; },
      get isProcessing() { return isProcessing; },
      set isProcessing(v) { isProcessing = v; },
      get stopRequested() { return stopRequested; },
      set stopRequested(v) { stopRequested = v; },
      get activeMangaTabId() { return activeMangaTabId; },
      set activeMangaTabId(v) { activeMangaTabId = v; },
      get currentBatchId() { return currentBatchId; },
      set currentBatchId(v) { currentBatchId = v; },
      get extractionTabs() { return extractionTabs; },
      set extractionTabs(v) { extractionTabs = v; },
      get totalJobs() { return totalJobs; },
      set totalJobs(v) { totalJobs = v; },
      get completedJobs() { return completedJobs; },
      set completedJobs(v) { completedJobs = v; },
      get activeJobsCount() { return activeJobsCount; },
      set activeJobsCount(v) { activeJobsCount = v; },
      get jobIndex() { return jobIndex; },
      set jobIndex(v) { jobIndex = v; },
      get _cachedMaxCon() { return _cachedMaxCon; },
      set _cachedMaxCon(v) { _cachedMaxCon = v; },
      get _finalizedTabs() { return _finalizedTabs; },
      get _initialized() { return _initialized; },
      set _initialized(v) { _initialized = v; },
      
      // Functions
      generateId, 
      restoreState, 
      syncState, 
      ensureInitialized,
      indexAddJob, 
      indexRemoveJob, 
      indexJobsOfBatch,
      tabExists, 
      _markFinalized, 
      reconcileJobs
  };

})(typeof self !== 'undefined' ? self : globalThis);
