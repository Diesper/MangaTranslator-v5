'use strict';

// GTC client for content_manga.  This is a classic content-script module (not an
// ES module) because Chromium injects the files declared in manifest.json into
// the same isolated world.  Keep its public API on window so it can also be
// loaded independently by the test harness.
(function attachContentGtcClient(rootScope) {
    function fingerprintApi() {
        return rootScope.MangaTranslatorGtcFingerprint
            || (typeof self !== 'undefined' && self.MangaTranslatorGtcFingerprint)
            || null;
    }

    function sendRuntimeMessageAsync(message) {
        return new Promise(resolve => {
            if (!rootScope.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
                resolve({ ok: false, error: 'runtime_unavailable' });
                return;
            }
            chrome.runtime.sendMessage(message, response => {
                if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
                else resolve(response || { ok: false });
            });
        });
    }

    function getCleanUrl(rawUrl) {
        if (!rawUrl || rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return null;
        try {
            const base = (rootScope.location && (rootScope.location.origin || rootScope.location.href))
                || (rootScope.document && rootScope.document.baseURI)
                || 'https://manga-translator.invalid/';
            const url = new URL(rawUrl, base);
            if (url.hostname === 'preview.redd.it' || url.hostname === 'external-preview.redd.it') {
                const match = url.pathname.match(/[-]([a-z0-9]{8,})(\.[a-z]+)$/i);
                return match ? `https://i.redd.it/${match[1]}${match[2].toLowerCase()}` : `https://i.redd.it${url.pathname}`.toLowerCase();
            }
            if (url.hostname === 'i.redd.it') return `${url.protocol}//${url.hostname}${url.pathname}`.toLowerCase();
            if (url.hostname.includes('imgur.com')) {
                const path = url.pathname.replace(/([a-zA-Z0-9]{5,})[bmlhts](\.[a-z]+)$/i, '$1$2');
                return `${url.protocol}//${url.hostname}${path}`.toLowerCase();
            }
            const resizeParams = ['width', 'w', 'h', 'height', 'size', 'quality', 'q', 'format', 'auto', 'crop', 'fit', 'resize', 'scale', 'dpr', 'webp', 'avif', 'thumb', 'thumbnail', 'tr', 'im'];
            let changed = false;
            resizeParams.forEach(param => { if (url.searchParams.has(param)) { url.searchParams.delete(param); changed = true; } });
            return `${url.protocol}//${url.host}${url.pathname}${changed && url.search ? url.search : ''}`.toLowerCase();
        } catch (_) {
            return String(rawUrl).split('?')[0].split('#')[0].toLowerCase();
        }
    }

    async function generateImageFingerprint(imgEl) {
        try {
            const api = fingerprintApi();
            const cleanUrl = getCleanUrl(imgEl.src) || '';
            const width = imgEl.naturalWidth || 0;
            const height = imgEl.naturalHeight || 0;
            let pixelSample = 'nopixels', dHash = null, wHash = null, pHash = null;
            let wHashCrop = null, pHashCrop = null, regionalHashes = null;
            try {
                const canvas = rootScope.document.createElement('canvas');
                canvas.width = 8; canvas.height = 8;
                const context = canvas.getContext('2d');
                context.drawImage(imgEl, 0, 0, 8, 8);
                pixelSample = Array.from(context.getImageData(0, 0, 8, 8).data).map(byte => byte.toString(16).padStart(2, '0')).join('');
                if (api && typeof api.calculateDHash === 'function') {
                    const c = rootScope.document.createElement('canvas'); c.width = 9; c.height = 8;
                    const ctx = c.getContext('2d'); ctx.drawImage(imgEl, 0, 0, 9, 8);
                    dHash = api.calculateDHash(ctx.getImageData(0, 0, 9, 8).data);
                }
                if (api && (typeof api.calculateWHash === 'function' || typeof api.calculatePHash === 'function')) {
                    const c = rootScope.document.createElement('canvas'); c.width = 32; c.height = 32;
                    const ctx = c.getContext('2d'); ctx.drawImage(imgEl, 0, 0, 32, 32);
                    const data = ctx.getImageData(0, 0, 32, 32).data;
                    if (typeof api.calculateWHash === 'function') wHash = api.calculateWHash(data);
                    if (typeof api.calculatePHash === 'function') pHash = api.calculatePHash(data);
                    const sourceWidth = imgEl.naturalWidth || imgEl.width || 0;
                    const sourceHeight = imgEl.naturalHeight || imgEl.height || 0;
                    const side = Math.min(sourceWidth, sourceHeight);
                    if (side > 0 && sourceWidth !== sourceHeight) {
                        const crop = rootScope.document.createElement('canvas'); crop.width = 32; crop.height = 32;
                        const cropCtx = crop.getContext('2d');
                        cropCtx.drawImage(imgEl, Math.floor((sourceWidth - side) / 2), Math.floor((sourceHeight - side) / 2), side, side, 0, 0, 32, 32);
                        const cropData = cropCtx.getImageData(0, 0, 32, 32).data;
                        if (typeof api.calculateWHash === 'function') wHashCrop = api.calculateWHash(cropData);
                        if (typeof api.calculatePHash === 'function') pHashCrop = api.calculatePHash(cropData);
                    }
                }
                if (api && typeof api.calculateRegionalHashes === 'function') {
                    const c = rootScope.document.createElement('canvas'); c.width = 48; c.height = 48;
                    const ctx = c.getContext('2d'); ctx.drawImage(imgEl, 0, 0, 48, 48);
                    regionalHashes = api.calculateRegionalHashes(ctx.getImageData(0, 0, 48, 48).data);
                }
            } catch (_) {
                if (imgEl.src && !imgEl.src.startsWith('data:') && !imgEl.src.startsWith('blob:')) {
                    const response = await sendRuntimeMessageAsync({ action: 'CALCULATE_VISUAL_FINGERPRINT', url: imgEl.src });
                    if (response && response.ok) {
                        pixelSample = response.pixelSample || pixelSample; dHash = response.dHash || dHash;
                        wHash = response.wHash || wHash; pHash = response.pHash || pHash;
                        wHashCrop = response.wHashCrop || wHashCrop; pHashCrop = response.pHashCrop || pHashCrop;
                        regionalHashes = response.regionalHashes || regionalHashes;
                    }
                }
            }
            if (!api || typeof api.createFingerprintFromDescriptor !== 'function') return null;
            const sha256 = await api.createFingerprintFromDescriptor({ width, height, cleanUrl, pixelSample, hasVisualPixels: pixelSample !== 'nopixels' });
            const fingerprintVersion = wHashCrop || pHashCrop ? 'visual-v4' : wHash || pHash ? 'visual-v3' : dHash ? 'visual-v2' : 'visual-v1';
            return { sha256, dHash, wHash, pHash, wHashCrop, pHashCrop, regionalHashes, fingerprintVersion };
        } catch (_) { return null; }
    }

    function unique(values) { return Array.from(new Set((values || []).filter(Boolean))); }
    async function queryGlobalTranslationCache(hashes) {
        const normalized = unique(hashes); if (!normalized.length) return {};
        const response = await sendRuntimeMessageAsync({ action: 'GTC_QUERY_MANY', hashes: normalized });
        if (response && response.ok && response.entriesByHash) return response.entriesByHash;
        if (!rootScope.chrome || !chrome.storage || !chrome.storage.local) return {};
        const legacy = await new Promise(resolve => chrome.storage.local.get(normalized.map(hash => `gtc_${hash}`), resolve));
        return normalized.reduce((entries, hash) => { if (legacy[`gtc_${hash}`]) entries[hash] = legacy[`gtc_${hash}`]; return entries; }, {});
    }
    async function queryGlobalTranslationCacheByDHash(dHashes) {
        const d = unique(dHashes); if (!d.length) return {};
        const response = await sendRuntimeMessageAsync({ action: 'GTC_QUERY_BY_DHASH', dHashes: d });
        return response && response.ok && response.entriesByDHash ? response.entriesByDHash : {};
    }
    async function queryGlobalTranslationCacheByPerceptual(wHashes, pHashes) {
        const w = unique(wHashes), p = unique(pHashes); if (!w.length && !p.length) return {};
        const response = await sendRuntimeMessageAsync({ action: 'GTC_QUERY_BY_PERCEPTUAL', wHashes: w, pHashes: p });
        return response && response.ok && response.entriesByPerceptual ? response.entriesByPerceptual : {};
    }
    async function queryPerceptualCorrelated(candidates, mode = 'strict') {
        const queries = (candidates || []).filter(c => c && (c.wHash || c.pHash)).map(c => ({ queryId: String(c.i), wHash: c.wHash || '', pHash: c.pHash || '', width: c.width || 0, height: c.height || 0 }));
        if (!queries.length) return {};
        const response = await sendRuntimeMessageAsync({ action: 'GTC_QUERY_PERCEPTUAL_V2', queries, mode });
        return response && response.ok && response.entriesByQueryId ? response.entriesByQueryId : {};
    }
    async function queryGlobalTranslationCacheByPerceptualCrop(wHashesCrop, pHashesCrop) {
        const w = unique(wHashesCrop), p = unique(pHashesCrop); if (!w.length && !p.length) return {};
        const response = await sendRuntimeMessageAsync({ action: 'GTC_QUERY_BY_PERCEPTUAL_CROP', wHashesCrop: w, pHashesCrop: p });
        return response && response.ok && response.entriesByPerceptualCrop ? response.entriesByPerceptualCrop : {};
    }
    async function queryGlobalTranslationCacheByPerceptualRelaxed(wHashes, pHashes) {
        const w = unique(wHashes), p = unique(pHashes); if (!w.length && !p.length) return {};
        const response = await sendRuntimeMessageAsync({ action: 'GTC_QUERY_BY_PERCEPTUAL_RELAXED', wHashes: w, pHashes: p });
        return response && response.ok && response.entriesByPerceptualRelaxed ? response.entriesByPerceptualRelaxed : {};
    }
    async function saveGlobalTranslationCacheEntry(hash, translatedDataUrl, metadata = {}) {
        if (!hash || !translatedDataUrl) return false;
        const response = await sendRuntimeMessageAsync({ action: 'GTC_SAVE', hash, translatedDataUrl, dHash: metadata.dHash || null, wHash: metadata.wHash || null, pHash: metadata.pHash || null, wHashCrop: metadata.wHashCrop || null, pHashCrop: metadata.pHashCrop || null, regionalHashes: metadata.regionalHashes || null, cleanUrl: metadata.cleanUrl || null, width: metadata.width || 0, height: metadata.height || 0, fingerprintVersion: metadata.fingerprintVersion || 'visual-v3', mimeType: metadata.mimeType || null });
        if (response && response.ok) return true;
        if (rootScope.chrome && chrome.storage && chrome.storage.local) await chrome.storage.local.set({ [`gtc_${hash}`]: translatedDataUrl });
        return false;
    }
    function confirmWithRegionalHashes(queryRegional, entryRegional) {
        const api = fingerprintApi();
        if (!queryRegional || !entryRegional || !api) return false;
        if (typeof api.matchRegionalHashes !== 'function') return true;
        return api.matchRegionalHashes(queryRegional, entryRegional, { threshold: 8, minMatches: 3 }).match;
    }
    rootScope.MangaTranslatorGtcClient = Object.freeze({ getCleanUrl, generateImageFingerprint, queryGlobalTranslationCache, queryGlobalTranslationCacheByDHash, queryGlobalTranslationCacheByPerceptual, queryPerceptualCorrelated, queryGlobalTranslationCacheByPerceptualCrop, queryGlobalTranslationCacheByPerceptualRelaxed, saveGlobalTranslationCacheEntry, confirmWithRegionalHashes, sendRuntimeMessageAsync });
})(typeof window !== 'undefined' ? window : self);
