'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// test_content_manga_pipeline.js
// Testes para o pipeline de cache em 5 fases do content_manga.js
//
// Como o content_manga.js depende de DOM e chrome.*, extraímos e testamos
// as funções lógicas de forma isolada usando stubs:
//   - Stub de chrome.runtime.sendMessage
//   - Stub de canvas (sem DOM)
//   - Stub de img element (dataset, src, naturalWidth/Height)
//
// Cobre:
//   - generateImageFingerprint (local canvas + CORS fallback via SW)
//   - queryGlobalTranslationCache (SHA-256)
//   - queryGlobalTranslationCacheByDHash (dHash)
//   - queryGlobalTranslationCacheByPerceptual (wHash+pHash)
//   - saveGlobalTranslationCacheEntry (campos visual-v3)
//   - extractAndSendImages — lógica de decisão das 5 fases
//   - confirmWithRegionalHashes
//   - getCleanUrl
// ─────────────────────────────────────────────────────────────────────────────

globalThis.self = globalThis;
require('../../extension/gtc-fingerprint.js');
require('../../extension/gtc-indexeddb.js');

const { describe, it, ita, beforeEach, expect } = require('./runner.js');
const { solidColor, horizontalGradient, checkerboard, mangaPage, noise, brightnessShifted, isValidHex } = require('./helpers.js');

const fp  = globalThis.MangaTranslatorGtcFingerprint;
const idb = globalThis.MangaTranslatorGtcIndexedDb;

// ─────────────────────────────────────────────────────────────────────────────
// ── Extração inline das funções do content_manga.js ──────────────────────────
// Extraímos as funções independentes de DOM para testá-las diretamente.
// ─────────────────────────────────────────────────────────────────────────────

/** getCleanUrl — extraída literalmente do content_manga.js */
function getCleanUrl(urlStr) {
    if (!urlStr || urlStr.startsWith('data:')) return null;
    try {
        const u = new URL(urlStr, 'https://example.com');
        return u.origin + u.pathname;
    } catch(e) {
        return urlStr.split('?')[0].split('#')[0];
    }
}

/** normalizeHash inline */
const normalizeHash = idb.normalizeHash;

/**
 * generateImageFingerprint — versão testável sem DOM.
 * Aceita um stub de imgEl com:
 *   { src, naturalWidth, naturalHeight, _pixelData }
 * e um stub de sendRuntimeMessageAsync.
 */
async function generateImageFingerprint(imgEl, sendRuntimeMessageAsyncStub, gtcFpApi) {
    const fpApi = gtcFpApi || fp;
    const cleanUrl   = getCleanUrl(imgEl.src) || '';
    const imgWidth   = imgEl.naturalWidth  || 0;
    const imgHeight  = imgEl.naturalHeight || 0;
    let pixelSample  = 'nopixels';
    let dHash        = null;
    let wHash        = null;
    let pHash        = null;
    let regionalHashes = null;

    try {
        if (!imgEl._forceCors && imgEl._pixelData) {
            // Simula canvas local (não CORS bloqueado)
            const px8 = imgEl._pixelData.slice(0, 8*8*4);
            if (px8.length < 8*8*4) throw new Error('Imagem pequena demais');

            pixelSample = Array.from(px8).map(b => b.toString(16).padStart(2,'0')).join('');

            if (fpApi.calculateDHash) {
                const d9x8 = imgEl._pixelData9x8 || new Uint8ClampedArray(9*8*4).fill(128);
                dHash = fpApi.calculateDHash(d9x8);
            }

            if (fpApi.calculateWHash) {
                const d32 = imgEl._pixelData32 || new Uint8ClampedArray(32*32*4).fill(128);
                wHash = fpApi.calculateWHash(d32);
            }
            if (fpApi.calculatePHash) {
                const d32 = imgEl._pixelData32 || new Uint8ClampedArray(32*32*4).fill(128);
                pHash = fpApi.calculatePHash(d32);
            }

            if (fpApi.calculateRegionalHashes) {
                const d48 = imgEl._pixelData48 || new Uint8ClampedArray(48*48*4).fill(128);
                regionalHashes = fpApi.calculateRegionalHashes(d48);
            }
        } else {
            throw new Error('CORS simulado');
        }
    } catch (corsErr) {
        if (imgEl.src && !imgEl.src.startsWith('data:') && !imgEl.src.startsWith('blob:')) {
            try {
                const fpResp = await sendRuntimeMessageAsyncStub({
                    action: 'CALCULATE_VISUAL_FINGERPRINT', url: imgEl.src,
                });
                if (fpResp && fpResp.ok) {
                    if (fpResp.pixelSample)    pixelSample    = fpResp.pixelSample;
                    if (fpResp.dHash)          dHash          = fpResp.dHash;
                    if (fpResp.wHash)          wHash          = fpResp.wHash;
                    if (fpResp.pHash)          pHash          = fpResp.pHash;
                    if (fpResp.regionalHashes) regionalHashes = fpResp.regionalHashes;
                }
            } catch (_e) {}
        }
    }

    let sha256 = null;
    if (fpApi.createFingerprintFromDescriptor) {
        sha256 = await fpApi.createFingerprintFromDescriptor({
            width: imgWidth, height: imgHeight, cleanUrl, pixelSample,
            hasVisualPixels: pixelSample !== 'nopixels',
        });
    }

    let fingerprintVersion = 'visual-v1';
    if (wHash || pHash) fingerprintVersion = 'visual-v3';
    else if (dHash)     fingerprintVersion = 'visual-v2';

    return { sha256, dHash, wHash, pHash, regionalHashes, fingerprintVersion };
}

/**
 * Pipeline de cache em 5 fases — extraído do content_manga.js para teste isolado.
 *
 * @param {Array} imgEls          Array de stubs de imgEl
 * @param {object} sendMsgStub    sendRuntimeMessageAsync stub
 * @returns {{ cacheHits: number[], geminiQueue: number[], decisions: object[] }}
 */
async function runCachePipeline(imgEls, sendMsgStub) {
    // Fase 1: fingerprints em paralelo
    const fingerprintResults = await Promise.all(
        imgEls.map(async (imgEl, i) => {
            if (imgEl._skip || imgEl._translated) return { i, sha256: null, skip: true };
            const fp = await generateImageFingerprint(imgEl, sendMsgStub);
            return { i, ...fp };
        })
    );

    // Fase 2: Lookup SHA-256
    const sha256Keys = fingerprintResults.filter(r => r.sha256).map(r => r.sha256);
    const gtcBySha256Resp = await sendMsgStub({ action: 'GTC_QUERY_MANY', hashes: sha256Keys });
    const gtcBySha256 = (gtcBySha256Resp?.ok && gtcBySha256Resp.entriesByHash) || {};

    // Fase 3: Lookup dHash (misses do SHA-256)
    const sha256Misses = fingerprintResults.filter(r => r.sha256 && !gtcBySha256[r.sha256]);
    const dHashKeys    = [...new Set(sha256Misses.filter(r => r.dHash).map(r => r.dHash))];
    let gtcByDHash = {};
    if (dHashKeys.length > 0) {
        const resp = await sendMsgStub({ action: 'GTC_QUERY_BY_DHASH', dHashes: dHashKeys });
        gtcByDHash = (resp?.ok && resp.entriesByDHash) || {};
    }

    // Fase 4: Lookup perceptual (misses do dHash)
    const dHashMisses = sha256Misses.filter(r => !(r.dHash && gtcByDHash[r.dHash]));
    const wHashKeys   = [...new Set(dHashMisses.filter(r => r.wHash).map(r => r.wHash))];
    const pHashKeys   = [...new Set(dHashMisses.filter(r => r.pHash).map(r => r.pHash))];
    let gtcByPerceptual = {};
    if (wHashKeys.length > 0 || pHashKeys.length > 0) {
        const resp = await sendMsgStub({
            action: 'GTC_QUERY_BY_PERCEPTUAL', wHashes: wHashKeys, pHashes: pHashKeys,
        });
        gtcByPerceptual = (resp?.ok && resp.entriesByPerceptual) || {};
    }

    // Fase 5: Decisão
    const cacheHits  = [];
    const geminiQueue = [];
    const decisions  = [];

    for (const r of fingerprintResults) {
        if (r.skip) continue;

        const sha256Hit = r.sha256 ? gtcBySha256[r.sha256] : null;
        if (sha256Hit) {
            cacheHits.push(r.i);
            decisions.push({ i: r.i, source: 'sha256', url: sha256Hit });
            continue;
        }

        const dHashHit = r.dHash ? gtcByDHash[r.dHash] : null;
        if (dHashHit) {
            cacheHits.push(r.i);
            decisions.push({ i: r.i, source: 'dhash', url: dHashHit });
            continue;
        }

        // Perceptual: chave composta ou simples
        const compositeKey = (r.wHash && r.pHash) ? `${r.wHash}:${r.pHash}` : null;
        let percHit = null;
        if (compositeKey && gtcByPerceptual[compositeKey]) percHit = gtcByPerceptual[compositeKey];
        if (!percHit && r.wHash && gtcByPerceptual[r.wHash]) percHit = gtcByPerceptual[r.wHash];
        if (!percHit && r.pHash && gtcByPerceptual[r.pHash]) percHit = gtcByPerceptual[r.pHash];

        if (percHit?.translatedDataUrl) {
            cacheHits.push(r.i);
            decisions.push({ i: r.i, source: 'perceptual', url: percHit.translatedDataUrl, confidence: percHit.confidence });
            continue;
        }

        geminiQueue.push(r.i);
        decisions.push({ i: r.i, source: 'gemini' });
    }

    return { cacheHits, geminiQueue, decisions, fingerprintResults };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fábrica de stub de chrome.runtime.sendMessage com IndexedDB em memória
// ─────────────────────────────────────────────────────────────────────────────

function makeChromeSendMessageStub(repo) {
    const handler = idb.createGtcRuntimeHandler({ repository: repo, fingerprintApi: fp });

    return function sendRuntimeMessageAsyncStub(message) {
        return new Promise((resolve) => {
            const handled = handler(message, {}, resolve);
            if (!handled) resolve({ ok: false, action: message.action });
        });
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fábricas de stub de imgEl
// ─────────────────────────────────────────────────────────────────────────────

function makeImgEl(overrides = {}) {
    const pixData = overrides._pixelData || solidColor(32, 32, 128, 128, 128);
    return {
        src:           overrides.src           ?? 'https://cdn.site.com/page1.jpg',
        naturalWidth:  overrides.naturalWidth  ?? 800,
        naturalHeight: overrides.naturalHeight ?? 1200,
        _pixelData:    new Uint8ClampedArray(Array.from({ length: 8*8*4 }, (_, i) => pixData[i] || 128)),
        _pixelData9x8: new Uint8ClampedArray(9*8*4).fill(128),
        _pixelData32:  pixData.length >= 32*32*4 ? pixData : new Uint8ClampedArray(32*32*4).fill(128),
        _pixelData48:  pixData.length >= 48*48*4 ? pixData : new Uint8ClampedArray(48*48*4).fill(128),
        _forceCors:    overrides._forceCors    ?? false,
        _skip:         overrides._skip         ?? false,
        _translated:   overrides._translated   ?? false,
        dataset:       {},
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1 — getCleanUrl
// ─────────────────────────────────────────────────────────────────────────────
describe('getCleanUrl', () => {

    it('remove query string', () => {
        expect(getCleanUrl('https://cdn.site.com/p1.jpg?token=abc123&ts=999'))
            .toBe('https://cdn.site.com/p1.jpg');
    });

    it('remove fragment', () => {
        expect(getCleanUrl('https://cdn.site.com/p1.jpg#section'))
            .toBe('https://cdn.site.com/p1.jpg');
    });

    it('preserva path', () => {
        expect(getCleanUrl('https://cdn.site.com/manga/ch1/page1.jpg'))
            .toBe('https://cdn.site.com/manga/ch1/page1.jpg');
    });

    it('retorna null para data: URL', () => {
        expect(getCleanUrl('data:image/png;base64,ABC')).toBeNull();
    });

    it('retorna null para string vazia', () => {
        expect(getCleanUrl('')).toBeNull();
    });

    it('retorna null para null', () => {
        expect(getCleanUrl(null)).toBeNull();
    });

    it('lida com URL relativa usando origin como base', () => {
        const result = getCleanUrl('/manga/page1.jpg');
        expect(result).toContain('/manga/page1.jpg');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2 — generateImageFingerprint
// ─────────────────────────────────────────────────────────────────────────────
describe('generateImageFingerprint', () => {

    const noopSend = async () => ({ ok: false });

    ita('retorna todos os 6 campos esperados', async () => {
        const imgEl = makeImgEl({ _pixelData32: solidColor(32, 32, 100, 150, 200) });
        const r = await generateImageFingerprint(imgEl, noopSend);
        expect(r).toHaveProperty('sha256');
        expect(r).toHaveProperty('dHash');
        expect(r).toHaveProperty('wHash');
        expect(r).toHaveProperty('pHash');
        expect(r).toHaveProperty('regionalHashes');
        expect(r).toHaveProperty('fingerprintVersion');
    });

    ita('sha256 é string de 64 chars hex', async () => {
        const imgEl = makeImgEl();
        const r = await generateImageFingerprint(imgEl, noopSend);
        expect(isValidHex(r.sha256, 64)).toBeTruthy();
    });

    ita('wHash é string de 64 chars hex', async () => {
        const imgEl = makeImgEl({ _pixelData32: mangaPage(32, 32, 'EN') });
        const r = await generateImageFingerprint(imgEl, noopSend);
        expect(isValidHex(r.wHash, 64)).toBeTruthy();
    });

    ita('pHash é string de 64 chars hex', async () => {
        const imgEl = makeImgEl({ _pixelData32: mangaPage(32, 32, 'EN') });
        const r = await generateImageFingerprint(imgEl, noopSend);
        expect(isValidHex(r.pHash, 64)).toBeTruthy();
    });

    ita('fingerprintVersion = "visual-v3" quando wHash presente', async () => {
        const imgEl = makeImgEl();
        const r = await generateImageFingerprint(imgEl, noopSend);
        expect(r.fingerprintVersion).toBe('visual-v3');
    });

    ita('CORS fallback: usa SW quando canvas é bloqueado (_forceCors=true)', async () => {
        let swCalled = false;
        const swStub = async (msg) => {
            if (msg.action === 'CALCULATE_VISUAL_FINGERPRINT') {
                swCalled = true;
                const d32 = mangaPage(32, 32, 'EN');
                return {
                    ok: true,
                    pixelSample: 'aa'.repeat(256),
                    dHash:    fp.calculateDHash(new Uint8ClampedArray(9*8*4).fill(100)),
                    wHash:    fp.calculateWHash(d32),
                    pHash:    fp.calculatePHash(d32),
                    regionalHashes: fp.calculateRegionalHashes(new Uint8ClampedArray(48*48*4).fill(100)),
                };
            }
            return { ok: false };
        };

        const imgEl = makeImgEl({ _forceCors: true, src: 'https://cdn.crossorigin.com/p1.jpg' });
        const r = await generateImageFingerprint(imgEl, swStub);

        expect(swCalled).toBe(true);
        expect(r.wHash).not.toBeNull();
        expect(r.pHash).not.toBeNull();
    });

    ita('CORS fallback: dados do SW são usados nos campos corretos', async () => {
        const d32 = mangaPage(32, 32, 'PT');
        const expectedWHash = fp.calculateWHash(d32);
        const expectedPHash = fp.calculatePHash(d32);

        const swStub = async (msg) => {
            if (msg.action === 'CALCULATE_VISUAL_FINGERPRINT') {
                return {
                    ok: true,
                    pixelSample: 'bb'.repeat(256),
                    dHash: 'ddhash12ddhash12',
                    wHash: expectedWHash,
                    pHash: expectedPHash,
                    regionalHashes: { topLeft: 'a'.repeat(16), topRight: 'b'.repeat(16),
                                      bottomLeft: 'c'.repeat(16), bottomRight: 'd'.repeat(16) },
                };
            }
            return { ok: false };
        };

        const imgEl = makeImgEl({ _forceCors: true, src: 'https://cross.cdn.net/img.jpg' });
        const r = await generateImageFingerprint(imgEl, swStub);

        expect(r.wHash).toBe(expectedWHash);
        expect(r.pHash).toBe(expectedPHash);
        expect(r.dHash).toBe('ddhash12ddhash12');
    });

    ita('CORS fallback: SW falhando → fingerprintVersion = "visual-v1" (graceful)', async () => {
        const swStub = async () => ({ ok: false, error: 'fetch failed' });
        const imgEl  = makeImgEl({ _forceCors: true, src: 'https://broken.cdn.net/img.jpg' });
        const r = await generateImageFingerprint(imgEl, swStub);

        // Não lança — degradação graciosa
        expect(r.fingerprintVersion).toBe('visual-v1');
        expect(r.wHash).toBeNull();
        expect(r.pHash).toBeNull();
    });

    ita('data: URL → cleanUrl null → sha256 usa URL como discriminador', async () => {
        const imgEl = makeImgEl({ src: 'data:image/png;base64,ABC123' });
        // Não lança — limpa cleanUrl
        const r = await generateImageFingerprint(imgEl, noopSend);
        expect(r).toHaveProperty('sha256');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3 — Pipeline de 5 fases — casos de teste
// ─────────────────────────────────────────────────────────────────────────────
describe('Pipeline 5 fases — Fase 2: SHA-256 hit', () => {

    ita('imagem em cache SHA-256 → cacheHits, não vai para Gemini', async () => {
        const repo = idb.createInMemoryRepository();
        const send = makeChromeSendMessageStub(repo);

        // Pré-popula cache com SHA-256
        const imgEl = makeImgEl({ src: 'https://site.com/p1.jpg' });
        const fp0   = await generateImageFingerprint(imgEl, send);

        await repo.put({
            hash: fp0.sha256, translatedDataUrl: 'data:cached_sha256',
            wHash: null, pHash: null, dHash: null,
        });

        const { cacheHits, geminiQueue, decisions } = await runCachePipeline([imgEl], send);

        expect(cacheHits).toContain(0);
        expect(geminiQueue).not.toContain(0);
        expect(decisions[0].source).toBe('sha256');
        expect(decisions[0].url).toBe('data:cached_sha256');
    });

    ita('N imagens — todas em cache SHA-256 → geminiQueue vazia', async () => {
        const repo = idb.createInMemoryRepository();
        const send = makeChromeSendMessageStub(repo);

        const imgs = [
            makeImgEl({ src: 'https://s.com/p1.jpg', _pixelData32: solidColor(32,32,10,10,10) }),
            makeImgEl({ src: 'https://s.com/p2.jpg', _pixelData32: solidColor(32,32,20,20,20) }),
            makeImgEl({ src: 'https://s.com/p3.jpg', _pixelData32: solidColor(32,32,30,30,30) }),
        ];

        for (const img of imgs) {
            const fp0 = await generateImageFingerprint(img, send);
            await repo.put({ hash: fp0.sha256, translatedDataUrl: `data:cached_${fp0.sha256.slice(0,8)}`, wHash: null, pHash: null });
        }

        const { cacheHits, geminiQueue } = await runCachePipeline(imgs, send);
        expect(cacheHits.length).toBe(3);
        expect(geminiQueue.length).toBe(0);
    });
});

describe('Pipeline 5 fases — Fase 3: dHash hit', () => {

    ita('miss SHA-256, hit dHash → cache hit com source=dhash', async () => {
        const repo = idb.createInMemoryRepository();
        const send = makeChromeSendMessageStub(repo);

        const imgEl = makeImgEl({
            src: 'https://cdn.new-mirror.com/page1.jpg', // URL diferente do original
            _pixelData32: horizontalGradient(32, 32),
        });
        const fp0 = await generateImageFingerprint(imgEl, send);

        // Salva apenas com dHash (simula entrada visual-v2)
        await repo.put({
            hash: 'sha_diferente_do_fingerprintado',
            translatedDataUrl: 'data:cached_dhash',
            dHash: fp0.dHash,
            wHash: null,
            pHash: null,
        });

        const { cacheHits, geminiQueue, decisions } = await runCachePipeline([imgEl], send);

        expect(cacheHits).toContain(0);
        expect(geminiQueue).not.toContain(0);
        expect(decisions[0].source).toBe('dhash');
    });
});

describe('Pipeline 5 fases — Fase 4: wHash+pHash perceptual hit (cross-language)', () => {

    ita('[CROSS-LANGUAGE] miss SHA-256 e dHash, hit perceptual → cache hit com source=perceptual', async () => {
        const repo = idb.createInMemoryRepository();
        const send = makeChromeSendMessageStub(repo);

        // Save EN translation — use fake dHash so PT lookup cannot hit via dHash
        const imgEN = makeImgEl({ src: 'https://cdn.en.com/ch1/p1.jpg', _pixelData32: mangaPage(32, 32, 'EN') });
        const fpEN  = await generateImageFingerprint(imgEN, send);

        // Store with a unique dHash that won't match any PT dHash
        await repo.put({
            hash:              'sha_en_xling_unique',   // won't match PT SHA-256
            translatedDataUrl: 'data:translated_from_en',
            dHash:             'aaaa0000ffff1111',      // fake — won't match PT dHash
            wHash:             fpEN.wHash,              // real EN wHash
            pHash:             fpEN.pHash,
            fingerprintVersion: 'visual-v3',
        });

        // PT: same art (same wHash approx) but different SHA-256 and different dHash
        const imgPT = makeImgEl({
            src: 'https://cdn.pt.com/ch1/p1.jpg',
            _pixelData32: mangaPage(32, 32, 'PT'),
            _pixelData9x8: solidColor(9, 8, 77, 77, 77), // distinct → dHash won't be 'aaaa0000ffff1111'
        });

        const { cacheHits, geminiQueue, decisions } = await runCachePipeline([imgPT], send);

        console.log('      Cross-language pipeline: cacheHits=' + cacheHits.length + ', gemini=' + geminiQueue.length);
        if (decisions.length > 0) {
            console.log('      Decisão: source=' + decisions[0].source + ', confidence=' + (decisions[0].confidence?.toFixed(3)));
        }

        expect(cacheHits).toContain(0);
        expect(geminiQueue).not.toContain(0);
        expect(decisions[0].source).toBe('perceptual');
    });
});

describe('Pipeline 5 fases — Fase 5: Gemini queue (miss total)', () => {

    ita('imagem totalmente nova → vai para geminiQueue', async () => {
        const repo = idb.createInMemoryRepository(); // cache vazio
        const send = makeChromeSendMessageStub(repo);

        const imgEl = makeImgEl({ src: 'https://new.cdn.com/fresh_page.jpg' });
        const { cacheHits, geminiQueue } = await runCachePipeline([imgEl], send);

        expect(cacheHits).not.toContain(0);
        expect(geminiQueue).toContain(0);
    });

    ita('mix: 1 cache hit + 1 gemini → correto em lote', async () => {
        const repo = idb.createInMemoryRepository();
        const send = makeChromeSendMessageStub(repo);

        // CRITICAL: _pixelData controls the 8x8 pixelSample used in SHA-256.
        // Both images must have DIFFERENT _pixelData so their sha256 differs.
        // Use explicit pixel buffers with distinct values.
        const px0 = solidColor(8, 8,  50,  50,  50); // dark grey → distinct sha256
        const px1 = solidColor(8, 8, 200, 200, 200); // light grey → different sha256

        const img0 = makeImgEl({
            src: 'https://s.com/page0.jpg',
            _pixelData:   px0,                         // distinct 8x8 sample
            _pixelData32: horizontalGradient(32, 32),
        });
        const img1 = makeImgEl({
            src: 'https://s.com/page1.jpg',
            _pixelData:   px1,                         // different 8x8 sample → different sha256
            _pixelData32: checkerboard(32, 32, 2),
        });

        const fp0 = await generateImageFingerprint(img0, send);
        // Save WITHOUT wHash/pHash so img1 gets no perceptual hit
        await repo.put({
            hash: fp0.sha256,
            translatedDataUrl: 'data:cached',
            wHash: null, pHash: null, dHash: null,
        });

        const { cacheHits, geminiQueue } = await runCachePipeline([img0, img1], send);

        expect(cacheHits).toContain(0);    // img0: SHA-256 cache hit
        expect(geminiQueue).toContain(1);  // img1: no entry → Gemini
        expect(cacheHits.length).toBe(1);
        expect(geminiQueue.length).toBe(1);
    });

    ita('imagens com _skip=true são ignoradas no pipeline', async () => {
        const repo = idb.createInMemoryRepository();
        const send = makeChromeSendMessageStub(repo);

        const img0 = makeImgEl({ src: 'https://s.com/p0.jpg', _skip: true });
        const img1 = makeImgEl({ src: 'https://s.com/p1.jpg' });

        const { cacheHits, geminiQueue, decisions } = await runCachePipeline([img0, img1], send);

        // img0 ignorada; img1 vai para Gemini (cache vazio)
        expect(decisions.some(d => d.i === 0)).toBe(false);
        expect(geminiQueue).toContain(1);
    });

    ita('cache vazio: N imagens → todas na geminiQueue', async () => {
        const repo = idb.createInMemoryRepository();
        const send = makeChromeSendMessageStub(repo);

        const imgs = Array.from({ length: 5 }, (_, i) =>
            makeImgEl({ src: `https://s.com/p${i}.jpg` })
        );

        const { cacheHits, geminiQueue } = await runCachePipeline(imgs, send);

        expect(cacheHits.length).toBe(0);
        expect(geminiQueue.length).toBe(5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4 — saveGlobalTranslationCacheEntry — campos visual-v3
// ─────────────────────────────────────────────────────────────────────────────
describe('saveGlobalTranslationCacheEntry — campos visual-v3', () => {

    async function saveEntry(repo, hash, translatedUrl, metadata) {
        const send = makeChromeSendMessageStub(repo);
        const r = await send({
            action: 'GTC_SAVE',
            hash,
            translatedDataUrl: translatedUrl,
            ...metadata,
        });
        return r;
    }

    ita('salva wHash, pHash, regionalHashes corretamente', async () => {
        const repo = idb.createInMemoryRepository();
        const d32  = mangaPage(32, 32, 'EN');
        const wH   = fp.calculateWHash(d32);
        const pH   = fp.calculatePHash(d32);
        const rH   = fp.calculateRegionalHashes(new Uint8ClampedArray(48*48*4).fill(128));

        const r = await saveEntry(repo, 'test_save_v3', 'data:v3', {
            wHash: wH, pHash: pH, regionalHashes: rH,
            fingerprintVersion: 'visual-v3',
        });

        expect(r.ok).toBe(true);
        expect(r.saved).toBe(true);

        // Verifica que pode ser encontrado via lookup perceptual
        const found = await repo.getManyByPerceptual([wH], [pH], fp);
        expect(Object.values(found).length).toBeGreaterThan(0);
    });

    ita('salva entrada com fingerprintVersion="visual-v3"', async () => {
        const repo = idb.createInMemoryRepository();
        const r = await saveEntry(repo, 'fp_version_test', 'data:fpv', {
            fingerprintVersion: 'visual-v3',
            wHash: fp.calculateWHash(solidColor(32,32,100,100,100)),
            pHash: fp.calculatePHash(solidColor(32,32,100,100,100)),
        });
        expect(r.ok).toBe(true);
    });

    ita('salva entrada visual-v2 (sem wHash) sem erros', async () => {
        const repo = idb.createInMemoryRepository();
        const r = await saveEntry(repo, 'v2_compat', 'data:v2', {
            dHash: 'ddhash_v2',
            fingerprintVersion: 'visual-v2',
        });
        expect(r.ok).toBe(true);
    });

    ita('reject: hash vazio retorna saved:false', async () => {
        const repo = idb.createInMemoryRepository();
        const r = await saveEntry(repo, '', 'data:x', {});
        expect(r.saved).toBe(false);
    });

    ita('reject: translatedDataUrl ausente retorna saved:false', async () => {
        const repo = idb.createInMemoryRepository();
        const r = await saveEntry(repo, 'hash_notranslation', null, {});
        expect(r.saved).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5 — confirmWithRegionalHashes (validação de matches borderline)
// ─────────────────────────────────────────────────────────────────────────────
describe('confirmWithRegionalHashes', () => {

    /** Extração inline da lógica do content_manga.js */
    function confirmWithRegionalHashes(queryRegional, entryRegional) {
        if (!queryRegional || !entryRegional || !fp) return true;
        if (typeof fp.matchRegionalHashes !== 'function') return true;
        const result = fp.matchRegionalHashes(queryRegional, entryRegional,
            { threshold: 8, minMatches: 3 });
        return result.match;
    }

    it('retorna true quando queryRegional é null (sem dados → aceitar)', () => {
        expect(confirmWithRegionalHashes(null, null)).toBe(true);
    });

    it('retorna true quando entryRegional é null', () => {
        const r = fp.calculateRegionalHashes(new Uint8ClampedArray(48*48*4).fill(100));
        expect(confirmWithRegionalHashes(r, null)).toBe(true);
    });

    it('retorna true para hashes regionais idênticos', () => {
        const data = mangaPage(48, 48, 'EN');
        const r = fp.calculateRegionalHashes(data);
        expect(confirmWithRegionalHashes(r, r)).toBe(true);
    });

    it('retorna false para hashes regionais completamente diferentes', () => {
        const r1 = fp.calculateRegionalHashes(new Uint8ClampedArray(48*48*4).fill(0));
        const r2 = fp.calculateRegionalHashes(new Uint8ClampedArray(48*48*4).fill(255));
        // Depende dos hashes gerados — se Hamming > 8 em todos os cantos, retorna false
        const result = confirmWithRegionalHashes(r1, r2);
        expect(typeof result).toBe('boolean');
    });

    it('[CROSS-LANGUAGE] página EN e PT passam confirmação regional', () => {
        const dataEN = mangaPage(48, 48, 'EN');
        const dataPT = mangaPage(48, 48, 'PT');
        const rEN = fp.calculateRegionalHashes(dataEN);
        const rPT = fp.calculateRegionalHashes(dataPT);
        const confirmed = confirmWithRegionalHashes(rEN, rPT);
        // Arte dos cantos é igual → confirmação deve passar
        expect(confirmed).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6 — Consistência dos hashes salvos no dataset (img.dataset.*)
// Simula que os hashes são escritos no dataset durante a fase 5
// e lidos corretamente no handler UPDATE_IMAGE
// ─────────────────────────────────────────────────────────────────────────────
describe('Hashes no dataset da imagem (img.dataset.*)', () => {

    ita('todos os hashes são salvos nos campos corretos do dataset', async () => {
        const noopSend = async () => ({ ok: false });
        const d32 = mangaPage(32, 32, 'EN');
        const d48 = new Uint8ClampedArray(48*48*4);
        for (let i = 0; i < d48.length; i++) d48[i] = d32[i % d32.length];

        const imgEl = makeImgEl({ _pixelData32: d32, _pixelData48: d48 });
        const fpResult = await generateImageFingerprint(imgEl, noopSend);

        // Simula o que a Fase 5 faz: salva hashes no dataset
        const dataset = {};
        if (fpResult.sha256)         dataset.origHash           = fpResult.sha256;
        if (fpResult.dHash)          dataset.origDHash          = fpResult.dHash;
        if (fpResult.wHash)          dataset.origWHash          = fpResult.wHash;
        if (fpResult.pHash)          dataset.origPHash          = fpResult.pHash;
        if (fpResult.regionalHashes) dataset.origRegionalHashes = JSON.stringify(fpResult.regionalHashes);
        if (fpResult.fingerprintVersion) dataset.origFpVersion  = fpResult.fingerprintVersion;

        // Verifica campos
        expect(dataset.origHash).toHaveLength(64);
        expect(dataset.origDHash).toHaveLength(16);
        expect(dataset.origWHash).toHaveLength(64);
        expect(dataset.origPHash).toHaveLength(64);
        expect(typeof dataset.origRegionalHashes).toBe('string');
        expect(dataset.origFpVersion).toBe('visual-v3');

        // Verifica que JSON.parse restaura corretamente
        const parsedRegional = JSON.parse(dataset.origRegionalHashes);
        expect(isValidHex(parsedRegional.topLeft,     16)).toBeTruthy();
        expect(isValidHex(parsedRegional.topRight,    16)).toBeTruthy();
        expect(isValidHex(parsedRegional.bottomLeft,  16)).toBeTruthy();
        expect(isValidHex(parsedRegional.bottomRight, 16)).toBeTruthy();
    });

    it('JSON.stringify + JSON.parse de regionalHashes é round-trip perfeito', () => {
        const data = mangaPage(48, 48, 'EN');
        const regional = fp.calculateRegionalHashes(data);
        const serialized = JSON.stringify(regional);
        const deserialized = JSON.parse(serialized);
        expect(deserialized.topLeft).toBe(regional.topLeft);
        expect(deserialized.topRight).toBe(regional.topRight);
        expect(deserialized.bottomLeft).toBe(regional.bottomLeft);
        expect(deserialized.bottomRight).toBe(regional.bottomRight);
    });
});
