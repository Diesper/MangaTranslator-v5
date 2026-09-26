'use strict';
// background/actions/claim-gemini-job.js — Claim seguro de job pela aba Gemini.

(function(scope) {
  function safeJob(job, canonicalTabId) {
    if (!job) return null;
    return {
      jobId: job.jobId,
      batchId: job.batchId,
      mangaTabId: job.mangaTabId,
      index: job.index,
      prompt: job.prompt,
      executionMode: job.executionMode,
      geminiTabId: canonicalTabId,
      windowId: job.windowId,
    };
  }

  scope.MangaTranslatorRouter.registerAction({
    name: 'claim-gemini-job',
    meta: {
      allowedSources: ['gemini'],
    },

    async execute(request, context) {
      if (context && typeof context.ensureInitialized === 'function') {
        await context.ensureInitialized();
      }

      const senderTabId = context && context.sender && context.sender.tab
        ? context.sender.tab.id
        : null;
      if (!Number.isInteger(senderTabId)) return { job: null };

      const expectedJobId = typeof request.jobId === 'string' && request.jobId
        ? request.jobId
        : null;
      const tabIdentity = context.tabIdentity;
      const canonicalSenderTabId = tabIdentity
        ? await tabIdentity.resolveCanonicalTabId(senderTabId)
        : senderTabId;

      const directKey = `gemini_job_${canonicalSenderTabId}`;
      const directData = await context.storage.get([directKey]);
      const directJob = directData && directData[directKey];
      if (directJob) {
        if (expectedJobId && directJob.jobId !== expectedJobId) {
          context.log('warn', 'bg', 'TAB_CLAIM_REJECTED', 'Claim rejeitado por jobId divergente', {
            tabId: canonicalSenderTabId,
          });
          return { job: null };
        }
        context.log('info', 'bg', 'TAB_CLAIM_DIRECT', 'Job reivindicado por chave direta', {
          tabId: canonicalSenderTabId,
          jobIdPrefix: String(directJob.jobId || '').slice(0, 8),
        });
        return { job: safeJob(directJob, canonicalSenderTabId) };
      }

      if (!expectedJobId || !context.state || !Array.isArray(context.state.jobIndex)) {
        context.log('info', 'bg', 'TAB_CLAIM_REJECTED', 'Nenhum job elegível para claim', {
          tabId: canonicalSenderTabId,
        });
        return { job: null };
      }

      const indexed = context.state.jobIndex.find(entry =>
        entry && entry.jobId === expectedJobId
      );
      if (!indexed) return { job: null };

      const canonicalIndexedTabId = tabIdentity
        ? await tabIdentity.resolveCanonicalTabId(indexed.geminiTabId)
        : indexed.geminiTabId;

      if (canonicalIndexedTabId !== canonicalSenderTabId) {
        context.log('warn', 'bg', 'TAB_CLAIM_REJECTED', 'Claim rejeitado por ownership de aba', {
          tabId: canonicalSenderTabId,
          indexedTabId: canonicalIndexedTabId,
        });
        return { job: null };
      }

      if (tabIdentity && indexed.geminiTabId !== canonicalSenderTabId) {
        await tabIdentity.migrateTabIdentity(indexed.geminiTabId, canonicalSenderTabId, {
          jobId: expectedJobId,
        });
      }

      const migratedKey = `gemini_job_${canonicalSenderTabId}`;
      const migratedData = await context.storage.get([migratedKey]);
      const migratedJob = migratedData && migratedData[migratedKey];
      if (!migratedJob || migratedJob.jobId !== expectedJobId) return { job: null };

      context.log('info', 'bg', 'TAB_CLAIM_ALIAS', 'Job reivindicado após resolver alias', {
        tabId: canonicalSenderTabId,
        jobIdPrefix: expectedJobId.slice(0, 8),
      });
      return { job: safeJob(migratedJob, canonicalSenderTabId) };
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
