'use strict';
// background/actions/log-entry.js — Encaminha entradas legadas ao logger central.

(function(scope) {
  if (!scope.MangaTranslatorRouter ||
      typeof scope.MangaTranslatorRouter.registerAction !== 'function') {
    throw new Error('MangaTranslatorRouter indisponível para registrar log-entry');
  }

  function validate(request) {
    const optionalStringFields = ['level', 'source', 'action_name', 'detail'];
    for (const field of optionalStringFields) {
      if (request[field] !== undefined && typeof request[field] !== 'string') {
        return {
          code: 'INVALID_PAYLOAD',
          message: field + ' deve ser uma string quando informado',
        };
      }
    }

    if (request.extra !== undefined &&
        (request.extra === null || Array.isArray(request.extra) || typeof request.extra !== 'object')) {
      return {
        code: 'INVALID_PAYLOAD',
        message: 'extra deve ser um objeto quando informado',
      };
    }

    return null;
  }

  scope.MangaTranslatorRouter.registerAction({
    name: 'log-entry',
    meta: {
      async: false,
      allowedSources: ['content', 'gemini'],
    },
    validate,
    execute(request, context) {
      context.log(
        request.level,
        request.source,
        request.action_name,
        request.detail,
        request.extra
      );
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
