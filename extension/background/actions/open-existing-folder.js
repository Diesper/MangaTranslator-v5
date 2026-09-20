'use strict';
// background/actions/open-existing-folder.js -- Abre uma pasta existente ou cria seu marcador.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'open-existing-folder',
    meta: { allowedSources: ['any'] },
    execute(request, context) {
      const { folderPath, safeTitle, anchorId } = request;
      return new Promise(resolve => {
        const fallbackSearch = () => {
          const escapedPath = folderPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          chrome.downloads.search({ filenameRegex: escapedPath }, results => {
            if (results?.length > 0) {
              chrome.downloads.show(results[0].id);
              resolve({ ok: true });
            } else {
              context.handleMarkerAndShow(safeTitle, resolve);
            }
          });
        };

        if (anchorId) {
          chrome.downloads.search({ id: anchorId }, results => {
            if (results?.length > 0 && results[0].exists) {
              chrome.downloads.show(anchorId);
              resolve({ ok: true });
            } else {
              fallbackSearch();
            }
          });
        } else {
          fallbackSearch();
        }
      });
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
