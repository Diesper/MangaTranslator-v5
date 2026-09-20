'use strict';
// background/actions/stop-batch.js -- Cancela somente os recursos do lote solicitado.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'stop-batch',
    meta: { allowedSources: ['any'] },
    validate(request) {
      if (request.batchId !== undefined && typeof request.batchId !== 'string') {
        return { code: 'INVALID_PAYLOAD', message: 'batchId deve ser texto' };
      }
      return null;
    },
    async execute(request, context) {
      return context.stopBatch(request);
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
