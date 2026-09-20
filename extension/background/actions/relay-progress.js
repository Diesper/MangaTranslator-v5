'use strict';
// background/actions/relay-progress.js -- Relay de progresso do Gemini para a aba do manga.

(function(scope) {
scope.MangaTranslatorRouter.registerAction({
  name: 'relay-progress',

  meta: {
    // O fallback sem aba remetente permanece por compatibilidade com o fluxo de recuperação.
    allowedSources: ['any'],
  },

  async execute(request, context) {
    const targetTabId = request.mangaTabId || context.state.activeMangaTabId;
    if (targetTabId) {
      chrome.tabs.sendMessage(targetTabId, {
        action: 'PROGRESS',
        text: request.text,
      }, () => { if (chrome.runtime.lastError) {} });
    }

    const senderTab = context.sender && context.sender.tab;
    if (senderTab) {
      const jobKey = `gemini_job_${senderTab.id}`;
      const data = await context.storage.get([jobKey]);
      const job = data && data[jobKey];

      if (job) {
        await context.storage.set({
          [jobKey]: { ...job, state: 'running', updatedAt: Date.now() },
        });
      }
    }

    return {};
  },
});
})(typeof self !== 'undefined' ? self : globalThis);
