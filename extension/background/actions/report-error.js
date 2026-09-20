'use strict';
// background/actions/report-error.js -- Reporta um erro Gemini à aba do mangá e encerra o job correto.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'report-error',
    meta: { allowedSources: ['any'] },
    validate(request) {
      if (typeof request.jobId !== 'string' || request.jobId.trim().length === 0) {
        return { code: 'INVALID_PAYLOAD', message: 'jobId é obrigatório' };
      }
      if (typeof request.error !== 'string' || request.error.trim().length === 0 || request.error.length > 4096) {
        return { code: 'INVALID_PAYLOAD', message: 'erro inválido' };
      }
      return null;
    },
    async execute(request, context) {
      await context.ensureInitialized();
      const { mangaTabId, index, error, jobId, batchId } = request;
      const geminiTabId = context.sender && context.sender.tab ? context.sender.tab.id : null;
      const owns = await new Promise(resolve => {
        context.assertJobOwnership(context.sender, jobId, result => resolve(result));
      });
      if (!owns) {
        context.log('warn', 'bg', 'SENDER_MISMATCH', 'Erro Gemini descartado: aba remetente não é dona do job', {
          jobId: String(jobId || '').slice(0, 8),
        });
        return { ok: false, reason: 'sender_mismatch' };
      }
      if (batchId && context.state.currentBatchId && batchId !== context.state.currentBatchId) {
        context.finalizeJob(geminiTabId, mangaTabId, true);
        return { ok: false, reason: 'stale_batch' };
      }

      const debug = await context.storage.get(['debugMode']);
      chrome.tabs.sendMessage(mangaTabId, {
        action: 'SHOW_ERROR_INTEGRATED',
        errorMsg: error,
        imgIndex: index,
        isDebug: Boolean(debug.debugMode),
        jobId,
        batchId,
      }, () => { if (chrome.runtime.lastError) {} });
      context.finalizeJob(geminiTabId, mangaTabId, true);
      return {};
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
