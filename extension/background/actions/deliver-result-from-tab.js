'use strict';
// background/actions/deliver-result-from-tab.js -- Entrega resultado vindo da aba temporária de extração.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'deliver-result-from-tab',
    meta: { allowedSources: ['any'] },
    validate(request) {
      if (typeof request.jobId !== 'string' || request.jobId.trim().length === 0) {
        return { code: 'INVALID_PAYLOAD', message: 'jobId é obrigatório' };
      }
      if (typeof request.src !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(request.src)) {
        return { code: 'INVALID_PAYLOAD', message: 'src de resultado inválido' };
      }
      return null;
    },
    async execute(request, context) {
      await context.ensureInitialized();
      const senderTabId = context.sender && context.sender.tab ? context.sender.tab.id : null;
      const mapping = senderTabId !== null && context.state.extractionTabs[senderTabId];
      if (!mapping || mapping.jobId !== request.jobId) {
        context.log('warn', 'bg', 'SENDER_MISMATCH', 'Resultado de aba temporária descartado: mapeamento ou job incompatível', {
          jobId: String(request.jobId).slice(0, 8),
        });
        return { ok: false, reason: 'sender_mismatch' };
      }
      const { mangaTabId, index, geminiTabId, jobId, batchId } = mapping;

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
