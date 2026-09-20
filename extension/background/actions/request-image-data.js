'use strict';
// background/actions/request-image-data.js -- Encaminha a requisicao de pagina a aba do manga.

(function(scope) {
  if (!scope.MangaTranslatorRouter ||
      typeof scope.MangaTranslatorRouter.registerAction !== 'function') {
    throw new Error('MangaTranslatorRouter indisponivel para registrar request-image-data');
  }

  scope.MangaTranslatorRouter.registerAction({
    name: 'request-image-data',
    meta: {
      // O handler legado aceitava mensagens de qualquer contexto da extensao.
      allowedSources: ['any'],
    },
    execute(request) {
      return new Promise(resolve => {
        chrome.tabs.sendMessage(
          request.mangaTabId,
          { action: 'REQUEST_IMAGE_DATA', index: request.index },
          response => {
            if (chrome.runtime.lastError) {
              resolve({ error: chrome.runtime.lastError.message });
              return;
            }
            resolve(response);
          }
        );
      });
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
