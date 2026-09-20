'use strict';
// background/actions/open-manga-root.js -- Abre a pasta raiz de downloads.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'open-manga-root',

    meta: {
      // Contrato atual mantém esta ação disponível a qualquer contexto da extensão.
      allowedSources: ['any'],
    },

    execute(_request, context) {
      return new Promise(resolve => {
        context.handleMarkerAndShow(null, resolve);
      });
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
