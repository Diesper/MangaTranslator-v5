'use strict';
// background/actions/deliver-result-url.js -- Abre uma aba temporária para extrair o resultado Gemini.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'deliver-result-url',
    meta: { allowedSources: ['any'] },
    validate(request) {
      if (typeof request.jobId !== 'string' || request.jobId.trim().length === 0) {
        return { code: 'INVALID_PAYLOAD', message: 'jobId é obrigatório' };
      }
      if (typeof request.url !== 'string' || request.url.length === 0 ||
          !/^(https?:|blob:|data:image\/)/i.test(request.url)) {
        return { code: 'INVALID_PAYLOAD', message: 'url de resultado inválida' };
      }
      return null;
    },
    async execute(request, context) {
      const { mangaTabId, index, url, jobId, batchId } = request;
      await context.ensureInitialized();
      const owned = await new Promise(resolve => {
        context.assertJobOwnership(context.sender, jobId, owns => resolve(owns));
      });
      if (!owned) {
        context.log('warn', 'bg', 'SENDER_MISMATCH', 'URL de resultado descartada: aba remetente não é dona do job', {
          jobId: String(jobId || '').slice(0, 8),
        });
        return { ok: false, reason: 'sender_mismatch' };
      }

      const newTab = await new Promise(resolve => {
        chrome.tabs.create({ url, active: false }, resolve);
      });
      context.state.extractionTabs[newTab.id] = {
        mangaTabId,
        index,
        geminiTabId: context.sender && context.sender.tab ? context.sender.tab.id : null,
        jobId,
        batchId,
      };
      await context.syncState();
      return {};
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
