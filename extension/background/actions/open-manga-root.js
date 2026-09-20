'use strict';
// background/actions/open-manga-root.js -- Abre a pasta raiz de downloads.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'open-manga-root',

    meta: {
      // O handler legado não restringia a origem desta mensagem.
      allowedSources: ['any'],
    },

    execute(_request, context) {
      return new Promise(resolve => {
        context.handleMarkerAndShow(null, resolve);
      });
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
