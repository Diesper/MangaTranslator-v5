'use strict';
// background/actions/start-batch.js -- Inicia um lote somente após reidratação do worker.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'start-batch',
    meta: { allowedSources: ['any'] },
    validate(request) {
      if (!Array.isArray(request.images)) {
        return { code: 'INVALID_PAYLOAD', message: 'images deve ser uma lista' };
      }
      if (request.images.some(image => !image || !Number.isInteger(image.index))) {
        return { code: 'INVALID_PAYLOAD', message: 'cada imagem precisa de index inteiro' };
      }
      return null;
    },
    async execute(request, context) {
      return context.startBatch(request, context.sender);
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
