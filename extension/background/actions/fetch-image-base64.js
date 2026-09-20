'use strict';
// background/actions/fetch-image-base64.js -- Busca imagens remotas para o fallback CORS.

(function(scope) {
  const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
  const FETCH_TIMEOUT_MS = 30_000;

  function validate(request) {
    let parsedUrl;
    try {
      parsedUrl = new URL(request.url);
    } catch (_error) {
      return {
        code: 'INVALID_PAYLOAD',
        message: 'URL inválida',
      };
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return {
        code: 'INVALID_PAYLOAD',
        message: 'Protocolo inválido',
      };
    }

    return null;
  }

  function readAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Falha ao ler imagem'));
      reader.readAsDataURL(blob);
    });
  }

  if (!scope.MangaTranslatorRouter ||
      typeof scope.MangaTranslatorRouter.registerAction !== 'function') {
    throw new Error('MangaTranslatorRouter indisponivel para registrar fetch-image-base64');
  }

  scope.MangaTranslatorRouter.registerAction({
    name: 'fetch-image-base64',
    meta: {
      allowedSources: ['content', 'gemini'],
    },
    validate,
    async execute(request) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const response = await fetch(request.url, {
          signal: controller.signal,
          credentials: 'omit',
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.startsWith('image/')) {
          throw new Error(`Content-Type inválido: ${contentType}`);
        }

        const blob = await response.blob();
        clearTimeout(timeout);
        if (blob.size > MAX_IMAGE_BYTES) {
          throw new Error('Imagem muito grande (>50MB)');
        }

        return { dataUrl: await readAsDataUrl(blob) };
      } finally {
        clearTimeout(timeout);
      }
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
