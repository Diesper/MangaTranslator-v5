'use strict';
// background/actions/get-tab-id.js — Retorna a aba do content script Gemini.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'get-tab-id',
    meta: {
      // Contrato atual de compatibilidade: responde para qualquer contexto da extensão.
      allowedSources: ['any'],
      async: false,
    },
    execute(_request, context) {
      const sender = context && context.sender;
      return { tabId: sender && sender.tab ? sender.tab.id : null };
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
