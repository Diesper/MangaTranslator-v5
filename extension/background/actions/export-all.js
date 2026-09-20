'use strict';
// background/actions/export-all.js -- Exporta páginas salvas e abre o último arquivo concluído.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'export-all',
    meta: { allowedSources: ['any'] },
    execute(request, context) {
      const downloads = request.allDownloads || [];
      if (downloads.length === 0) return { ok: true };

      return new Promise(resolve => {
        let lastCompletedId = null;
        let completed = 0;
        const finishOne = () => {
          completed += 1;
          if (completed !== downloads.length) return;
          if (lastCompletedId) chrome.downloads.show(lastCompletedId);
          resolve({ ok: true });
        };

        downloads.forEach(({ url, filename }) => {
          const normalizedFilename = filename.startsWith('MangaTranslator/')
            ? filename
            : `MangaTranslator/${filename}`;
          chrome.downloads.download({ url, filename: normalizedFilename, saveAs: false }, id => {
            if (chrome.runtime.lastError || id === undefined) {
              finishOne();
              return;
            }
            context.waitForDownload(id, doneId => {
              lastCompletedId = doneId;
              finishOne();
            }, finishOne);
          });
        });
      });
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
