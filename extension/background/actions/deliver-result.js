'use strict';
// background/actions/deliver-result.js -- Valida e entrega o resultado direto do Gemini.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'deliver-result',
    meta: { allowedSources: ['any'] },
    validate(request) {
      if (typeof request.src !== 'string' || request.src.length === 0) {
        return { code: 'INVALID_PAYLOAD', message: 'src da imagem é obrigatório' };
      }
      return null;
    },
    async execute(request, context) {
      await context.ensureInitialized();
      const { mangaTabId, index, src, jobId, batchId } = request;
      const geminiTabId = context.sender && context.sender.tab ? context.sender.tab.id : null;
      const owns = await new Promise(resolve => {
        context.assertJobOwnership(context.sender, jobId, result => resolve(result));
      });
      if (!owns) {
        context.log('warn', 'bg', 'SENDER_MISMATCH', 'Resultado Gemini descartado: aba remetente não é dona do job', {
          jobId: String(jobId || '').slice(0, 8),
        });
        return { ok: false, reason: 'sender_mismatch' };
      }
      if (batchId && context.state.currentBatchId && batchId !== context.state.currentBatchId) {
        context.finalizeJob(geminiTabId, mangaTabId, true);
        return { ok: false, reason: 'stale_batch' };
      }
      context.deliverResultToManga({ mangaTabId, index, src, jobId, batchId, geminiTabId });
      return {};
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
