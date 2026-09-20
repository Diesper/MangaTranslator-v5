'use strict';
// background/actions/download-chapter.js -- Baixa um capítulo e abre sua pasta.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'download-chapter',
    meta: { allowedSources: ['any'] },
    execute(request, context) {
      return new Promise(resolve => {
        const fallbackDownload = () => {
          if (Object.keys(request.images).length === 0) {
            context.handleMarkerAndShow(request.safeTitle, resolve);
            return;
          }
          context.downloadImagesAndShow(request.images, request.safeTitle, request.chapId)
            .then(() => resolve({ ok: true }));
        };

        if (request.anchorId) {
          chrome.downloads.search({ id: request.anchorId }, results => {
            if (results?.length > 0 && results[0].exists) {
              chrome.downloads.show(request.anchorId);
              resolve({ ok: true });
            } else {
              fallbackDownload();
            }
          });
        } else {
          fallbackDownload();
        }
      });
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
