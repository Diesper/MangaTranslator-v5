'use strict';
// background/actions/set-debug-mode.js - Alterna e propaga o modo de depuracao.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'set-debug-mode',

    meta: {
      // O handler legado aceitava a alteração de qualquer contexto da extensão.
      allowedSources: ['any'],
      async: true,
    },

    validate(request) {
      if (typeof request.debugOn !== 'boolean') {
        return {
          code: 'INVALID_PAYLOAD',
          message: 'debugOn deve ser um booleano',
        };
      }
      return null;
    },

    async execute(request, context) {
      await context.storage.set({ debugMode: request.debugOn });

      const tabs = await new Promise(resolve => {
        chrome.tabs.query({}, resolve);
      });
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(
          tab.id,
          { action: 'DEBUG_MODE_CHANGED', debugOn: request.debugOn },
          () => { if (chrome.runtime.lastError) {} }
        );
      });
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
