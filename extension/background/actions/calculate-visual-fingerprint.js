'use strict';
// background/actions/calculate-visual-fingerprint.js -- Computes visual-v3/v4 fingerprints in the service worker.

(function(scope) {
  scope.MangaTranslatorRouter.registerAction({
    name: 'calculate-visual-fingerprint',

    meta: {
      // Compatibility contract: this action remains available to every extension context.
      allowedSources: ['any'],
    },

    async execute(request, context) {
      let bitmap = null;
      try {
        const { url } = request;
        let parsedUrl;
        try {
          parsedUrl = new URL(url);
        } catch (_error) {
          return { ok: false, error: 'URL inválida para fingerprint visual' };
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          return { ok: false, error: 'URL inválida para fingerprint visual' };
        }

        const resp = await fetch(url, { credentials: 'omit', cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ao buscar imagem`);
        const blob = await resp.blob();
        bitmap = await createImageBitmap(blob);
        const fpApi = scope.MangaTranslatorGtcFingerprint || null;

        const oc8 = new OffscreenCanvas(8, 8);
        const ctx8 = oc8.getContext('2d');
        ctx8.drawImage(bitmap, 0, 0, 8, 8);
        const id8 = ctx8.getImageData(0, 0, 8, 8);
        const pixelSample = Array.from(id8.data)
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('');

        let dHash = null;
        if (fpApi && typeof fpApi.calculateDHash === 'function') {
          const oc9 = new OffscreenCanvas(9, 8);
          const ctx9 = oc9.getContext('2d');
          ctx9.drawImage(bitmap, 0, 0, 9, 8);
          const id9 = ctx9.getImageData(0, 0, 9, 8);
          dHash = fpApi.calculateDHash(id9.data);
        }

        let wHash = null;
        let pHash = null;
        let wHashCrop = null;
        let pHashCrop = null;
        if (fpApi && (typeof fpApi.calculateWHash === 'function' || typeof fpApi.calculatePHash === 'function')) {
          const oc32 = new OffscreenCanvas(32, 32);
          const ctx32 = oc32.getContext('2d');
          ctx32.drawImage(bitmap, 0, 0, 32, 32);
          const id32 = ctx32.getImageData(0, 0, 32, 32);

          if (typeof fpApi.calculateWHash === 'function') {
            wHash = fpApi.calculateWHash(id32.data);
          }
          if (typeof fpApi.calculatePHash === 'function') {
            pHash = fpApi.calculatePHash(id32.data);
          }

          const width = bitmap.width || 0;
          const height = bitmap.height || 0;
          const side = Math.min(width, height);
          if (side > 0 && width !== height) {
            const cropX = Math.floor((width - side) / 2);
            const cropY = Math.floor((height - side) / 2);
            const ocCrop = new OffscreenCanvas(32, 32);
            const ctxCrop = ocCrop.getContext('2d');
            ctxCrop.drawImage(bitmap, cropX, cropY, side, side, 0, 0, 32, 32);
            const idCrop = ctxCrop.getImageData(0, 0, 32, 32);
            if (typeof fpApi.calculateWHash === 'function') {
              wHashCrop = fpApi.calculateWHash(idCrop.data);
            }
            if (typeof fpApi.calculatePHash === 'function') {
              pHashCrop = fpApi.calculatePHash(idCrop.data);
            }
          }
        }

        let regionalHashes = null;
        if (fpApi && typeof fpApi.calculateRegionalHashes === 'function') {
          const oc48 = new OffscreenCanvas(48, 48);
          const ctx48 = oc48.getContext('2d');
          ctx48.drawImage(bitmap, 0, 0, 48, 48);
          const id48 = ctx48.getImageData(0, 0, 48, 48);
          regionalHashes = fpApi.calculateRegionalHashes(id48.data);
        }

        bitmap.close();
        bitmap = null;

        context.log('info', 'bg', 'VISUAL_FP_OK', 'Fingerprint visual-v3 calculado via SW', {
          url: url.slice(0, 80),
          hasDHash: dHash !== null,
          hasWHash: wHash !== null,
          hasPHash: pHash !== null,
          hasCrop: wHashCrop !== null || pHashCrop !== null,
          hasRegional: regionalHashes !== null,
        });

        return {
          pixelSample,
          dHash,
          wHash,
          pHash,
          wHashCrop,
          pHashCrop,
          regionalHashes,
        };
      } catch (e) {
        context.log('warn', 'bg', 'VISUAL_FP_FAIL', `Falha no fingerprint visual-v3 via SW: ${e.message}`, {
          url: (request.url || '').slice(0, 80),
        });
        return { ok: false, error: e.message };
      } finally {
        // Calculating a hash may fail after the decoded image has been created.
        if (bitmap && typeof bitmap.close === 'function') {
          bitmap.close();
        }
      }
    },
  });
})(typeof self !== 'undefined' ? self : globalThis);
