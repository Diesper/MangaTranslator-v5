'use strict';
// background/actions/download-image.js -- Baixa uma imagem e devolve seu caminho final.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'download-image',
    meta: { allowedSources: ['any'] },
    execute(request, context) {
      const filename = request.filename.startsWith('MangaTranslator/')
        ? request.filename
        : `MangaTranslator/${request.filename}`;

      return new Promise(resolve => {
        chrome.downloads.download({ url: request.url, filename, saveAs: false }, id => {
          if (chrome.runtime.lastError || id === undefined) {
            resolve({ error: chrome.runtime.lastError?.message || 'Falha no download' });
            return;
          }
          context.waitForDownload(
            id,
            doneId => chrome.downloads.search({ id: doneId }, results => {
              if (results?.[0]) resolve({ filePath: results[0].filename, downloadId: doneId });
              else resolve({ error: 'Arquivo não encontrado' });
            }),
            err => resolve({ error: err.message })
          );
        });
      });
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
