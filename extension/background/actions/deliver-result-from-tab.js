'use strict';
// background/actions/deliver-result-from-tab.js -- Entrega resultado vindo da aba temporária de extração.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'deliver-result-from-tab',
    meta: { allowedSources: ['any'] },
    async execute(request, context) {
      await context.ensureInitialized();
      const senderTabId = context.sender && context.sender.tab ? context.sender.tab.id : null;
      const mapping = (senderTabId !== null && context.state.extractionTabs[senderTabId]) || {};
      const mangaTabId = request.mangaTabId || mapping.mangaTabId;
      const index = request.index ?? mapping.index;
      const geminiTabId = request.geminiTabId || mapping.geminiTabId;
      const jobId = request.jobId || mapping.jobId;
      const batchId = request.batchId || mapping.batchId;

      const owns = await new Promise(resolve => {
        context.assertJobOwnership({ tab: { id: geminiTabId } }, jobId, result => resolve(result));
      });
      if (!owns) {
        context.log('warn', 'bg', 'SENDER_MISMATCH', 'Resultado de aba temporária descartado: job não pertence ao Gemini informado', {
          jobId: String(jobId || '').slice(0, 8),
        });
        return { ok: false, reason: 'sender_mismatch' };
      }

      if (batchId && context.state.currentBatchId && batchId !== context.state.currentBatchId) {
        if (senderTabId !== null) {
          chrome.tabs.remove(senderTabId, () => { if (chrome.runtime.lastError) {} });
          delete context.state.extractionTabs[senderTabId];
          await context.syncState();
        }
        context.finalizeJob(geminiTabId, mangaTabId, true);
        return { ok: false, reason: 'stale_batch' };
      }

      if (senderTabId !== null) {
        chrome.tabs.remove(senderTabId, () => { if (chrome.runtime.lastError) {} });
        delete context.state.extractionTabs[senderTabId];
      }
      await context.syncState();
      context.deliverResultToManga({
        mangaTabId,
        index,
        src: request.src,
        jobId,
        batchId,
        geminiTabId,
      });
      return {};
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
