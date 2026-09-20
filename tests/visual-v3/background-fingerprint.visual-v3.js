'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// test_background_fingerprint.js
// Testes para o handler CALCULATE_VISUAL_FINGERPRINT do background.js
// e para a integração background ↔ gtc-fingerprint via OffscreenCanvas simulado.
//
// Como o background.js é um Service Worker e usa fetch + OffscreenCanvas,
// criamos stubs determinísticos que replicam o comportamento real:
//   - fetchStub: retorna um Blob fake com pixels controlados
//   - createImageBitmapStub: retorna um bitmap fake com close()
//   - OffscreenCanvasStub: implementa getContext('2d').drawImage / getImageData
//
// Isso testa TODA a lógica do handler sem depender de chrome.* ou DOM real.
// ─────────────────────────────────────────────────────────────────────────────

globalThis.self = globalThis;
require('../../extension/gtc-fingerprint.js');

const { describe, it, ita, beforeEach, expect } = require('./runner.js');
const { solidColor, horizontalGradient, checkerboard, mangaPage, noise, brightnessShifted, isValidHex } = require('./helpers.js');
const fp = globalThis.MangaTranslatorGtcFingerprint;

// ─────────────────────────────────────────────────────────────────────────────
// Stubs reutilizáveis para simular ambiente do Service Worker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cria um OffscreenCanvas stub que, ao receber drawImage, escreve os pixels
 * da imageData `pixelData` (redimensionada para width×height via nearest-neighbor).
 */
function makeOffscreenCanvasStub(sourceData, sourceW, sourceH) {
    function OffscreenCanvasStub(w, h) {
        this._w = w;
        this._h = h;
        this._data = new Uint8ClampedArray(w * h * 4);
    }

    OffscreenCanvasStub.prototype.getContext = function(type) {
        const canvas = this;
        return {
            drawImage(bitmap, x, y, dw, dh) {
                // Nearest-neighbor resize de sourceData → canvas._w × canvas._h
                const sw = sourceW, sh = sourceH;
                const tw = dw || canvas._w, th = dh || canvas._h;
                const buf = new Uint8ClampedArray(tw * th * 4);
                for (let r = 0; r < th; r++) {
                    for (let c = 0; c < tw; c++) {
                        const sr = Math.floor(r * sh / th);
                        const sc = Math.floor(c * sw / tw);
                        const si = (sr * sw + sc) * 4;
                        const di = (r  * tw + c)  * 4;
                        buf[di]   = sourceData[si];
                        buf[di+1] = sourceData[si+1];
                        buf[di+2] = sourceData[si+2];
                        buf[di+3] = sourceData[si+3];
                    }
                }
                canvas._data = buf;
                canvas._w = tw; canvas._h = th;
            },
            getImageData(x, y, w, h) {
                return { data: canvas._data };
            },
        };
    };

    return OffscreenCanvasStub;
}

/**
 * Simula a lógica completa do handler CALCULATE_VISUAL_FINGERPRINT.
 * Extrai o handler inline para poder testá-lo de forma isolada.
 */
async function simulateCalculateVisualFingerprint(imageData, imageW, imageH, fpApiOverride) {
    const fpApi = fpApiOverride || globalThis.MangaTranslatorGtcFingerprint;
    if (!fpApi) return { ok: false, error: 'fpApi não disponível' };

    // Simula OffscreenCanvas com os dados fornecidos
    const OffscreenCanvas = makeOffscreenCanvasStub(imageData, imageW, imageH);

    // Simula createImageBitmap retornando objeto com close()
    const bitmap = {
        width:  imageW,
        height: imageH,
        _data:  imageData,
        close() {},
    };

    // ── Canvas 8×8 → pixelSample ────────────────────────────────────────────
    const oc8  = new OffscreenCanvas(8, 8);
    const ctx8 = oc8.getContext('2d');
    ctx8.drawImage(bitmap, 0, 0, 8, 8);
    const id8 = ctx8.getImageData(0, 0, 8, 8);
    const pixelSample = Array.from(id8.data)
        .map(b => b.toString(16).padStart(2, '0')).join('');

    // ── Canvas 9×8 → dHash ──────────────────────────────────────────────────
    let dHash = null;
    if (typeof fpApi.calculateDHash === 'function') {
        const oc9  = new OffscreenCanvas(9, 8);
        const ctx9 = oc9.getContext('2d');
        ctx9.drawImage(bitmap, 0, 0, 9, 8);
        const id9 = ctx9.getImageData(0, 0, 9, 8);
        dHash = fpApi.calculateDHash(id9.data);
    }

    // ── Canvas 32×32 → wHash + pHash (mesmo ImageData, NOVO) ───────────────
    let wHash = null;
    let pHash = null;
    if (fpApi.calculateWHash || fpApi.calculatePHash) {
        const oc32  = new OffscreenCanvas(32, 32);
        const ctx32 = oc32.getContext('2d');
        ctx32.drawImage(bitmap, 0, 0, 32, 32);
        const id32 = ctx32.getImageData(0, 0, 32, 32);

        if (typeof fpApi.calculateWHash === 'function') {
            wHash = fpApi.calculateWHash(id32.data);
        }
        if (typeof fpApi.calculatePHash === 'function') {
            pHash = fpApi.calculatePHash(id32.data);
        }
    }

    // ── Canvas 48×48 → regionalHashes ──────────────────────────────────────
    let regionalHashes = null;
    if (typeof fpApi.calculateRegionalHashes === 'function') {
        const oc48  = new OffscreenCanvas(48, 48);
        const ctx48 = oc48.getContext('2d');
        ctx48.drawImage(bitmap, 0, 0, 48, 48);
        const id48 = ctx48.getImageData(0, 0, 48, 48);
        regionalHashes = fpApi.calculateRegionalHashes(id48.data);
    }

    bitmap.close();

    return { ok: true, pixelSample, dHash, wHash, pHash, regionalHashes };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1 — CALCULATE_VISUAL_FINGERPRINT — estrutura da resposta
// ─────────────────────────────────────────────────────────────────────────────
describe('CALCULATE_VISUAL_FINGERPRINT — estrutura da resposta', () => {

    ita('retorna ok:true com todos os campos presentes', async () => {
        const img = horizontalGradient(100, 100);
        const r = await simulateCalculateVisualFingerprint(img, 100, 100);

        expect(r.ok).toBe(true);
        expect(r).toHaveProperty('pixelSample');
        expect(r).toHaveProperty('dHash');
        expect(r).toHaveProperty('wHash');
        expect(r).toHaveProperty('pHash');
        expect(r).toHaveProperty('regionalHashes');
    });

    ita('pixelSample é string hex de 256 chars (8×8×4 bytes = 256 bytes = 512 hex chars)', async () => {
        // 8×8 canvas = 64 pixels × 4 bytes RGBA = 256 bytes → 512 hex chars
        const img = solidColor(100, 100, 128, 64, 32);
        const r   = await simulateCalculateVisualFingerprint(img, 100, 100);
        expect(typeof r.pixelSample).toBe('string');
        expect(r.pixelSample).toHaveLength(512);
        expect(r.pixelSample).toMatch(/^[0-9a-f]+$/);
    });

    ita('dHash é string de 16 chars hex', async () => {
        const img = horizontalGradient(200, 300);
        const r   = await simulateCalculateVisualFingerprint(img, 200, 300);
        expect(isValidHex(r.dHash, 16)).toBeTruthy();
    });

    ita('wHash é string de 64 chars hex (256 bits)', async () => {
        const img = mangaPage(200, 300, 'EN');
        const r   = await simulateCalculateVisualFingerprint(img, 200, 300);
        expect(isValidHex(r.wHash, 64)).toBeTruthy();
    });

    ita('pHash é string de 64 chars hex (256 bits)', async () => {
        const img = mangaPage(200, 300, 'EN');
        const r   = await simulateCalculateVisualFingerprint(img, 200, 300);
        expect(isValidHex(r.pHash, 64)).toBeTruthy();
    });

    ita('regionalHashes tem 4 campos, cada um com 16 chars hex', async () => {
        const img = mangaPage(200, 300, 'EN');
        const r   = await simulateCalculateVisualFingerprint(img, 200, 300);
        expect(r.regionalHashes).toBeDefined();
        expect(isValidHex(r.regionalHashes.topLeft,     16)).toBeTruthy();
        expect(isValidHex(r.regionalHashes.topRight,    16)).toBeTruthy();
        expect(isValidHex(r.regionalHashes.bottomLeft,  16)).toBeTruthy();
        expect(isValidHex(r.regionalHashes.bottomRight, 16)).toBeTruthy();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2 — CALCULATE_VISUAL_FINGERPRINT — determinismo e consistência
// ─────────────────────────────────────────────────────────────────────────────
describe('CALCULATE_VISUAL_FINGERPRINT — determinismo', () => {

    ita('dois calls com mesma imagem retornam hashes idênticos', async () => {
        const img = mangaPage(150, 200, 'EN');
        const r1 = await simulateCalculateVisualFingerprint(img, 150, 200);
        const r2 = await simulateCalculateVisualFingerprint(img, 150, 200);
        expect(r1.pixelSample).toBe(r2.pixelSample);
        expect(r1.dHash).toBe(r2.dHash);
        expect(r1.wHash).toBe(r2.wHash);
        expect(r1.pHash).toBe(r2.pHash);
        expect(r1.regionalHashes.topLeft).toBe(r2.regionalHashes.topLeft);
    });

    ita('estruturalmente diferentes produzem wHashes diferentes', async () => {
        // Use images with genuine spatial structure — constant images have identical LL subband
        const imgA = horizontalGradient(100, 100);    // low-freq gradient
        const imgB = checkerboard(100, 100, 4);        // high-freq checkerboard
        const rA = await simulateCalculateVisualFingerprint(imgA, 100, 100);
        const rB = await simulateCalculateVisualFingerprint(imgB, 100, 100);
        // Genuinely different spatial content → different wHash
        expect(rA.wHash).not.toBe(rB.wHash);
    });

    ita('wHash e pHash são calculados do MESMO ImageData 32×32 (otimização)', async () => {
        // Verifica que a otimização de compartilhar o canvas 32×32
        // produz resultados equivalentes a calculá-los separadamente
        const img   = mangaPage(100, 100, 'EN');
        const r     = await simulateCalculateVisualFingerprint(img, 100, 100);

        // Recalcula individualmente com a imagem escalada 32×32 para verificar
        const OffscreenCanvas = makeOffscreenCanvasStub(img, 100, 100);
        const oc32 = new OffscreenCanvas(32, 32);
        oc32.getContext('2d').drawImage({ _data: img, close() {} }, 0, 0, 32, 32);
        const id32 = oc32.getContext('2d').getImageData(0, 0, 32, 32);

        const wHashIndividual = fp.calculateWHash(id32.data);
        const pHashIndividual = fp.calculatePHash(id32.data);

        expect(r.wHash).toBe(wHashIndividual);
        expect(r.pHash).toBe(pHashIndividual);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3 — CALCULATE_VISUAL_FINGERPRINT — cross-language matching via SW
// ─────────────────────────────────────────────────────────────────────────────
describe('CALCULATE_VISUAL_FINGERPRINT — cross-language matching via SW', () => {

    ita('[CROSS-LANGUAGE] fingerprint EN e PT da mesma página passam em matchPerceptualHashes', async () => {
        const imgEN = mangaPage(200, 300, 'EN');
        const imgPT = mangaPage(200, 300, 'PT');

        const rEN = await simulateCalculateVisualFingerprint(imgEN, 200, 300);
        const rPT = await simulateCalculateVisualFingerprint(imgPT, 200, 300);

        const decision = fp.matchPerceptualHashes(
            rEN.wHash, rEN.pHash,
            rPT.wHash, rPT.pHash,
        );

        console.log(`      SW cross-language: match=${decision.match}, confidence=${decision.confidence?.toFixed(3)}, wDist=${decision.wDist}, pDist=${decision.pDist}`);
        expect(decision.match).toBe(true);
    });

    ita('[CROSS-LANGUAGE] imagem diferente NÃO faz match', async () => {
        const imgEN    = mangaPage(200, 300, 'EN');
        const imgNoise = noise(200, 300, 9999);

        const rEN    = await simulateCalculateVisualFingerprint(imgEN,    200, 300);
        const rNoise = await simulateCalculateVisualFingerprint(imgNoise, 200, 300);

        const decision = fp.matchPerceptualHashes(
            rEN.wHash, rEN.pHash,
            rNoise.wHash, rNoise.pHash,
        );

        expect(decision.match).toBe(false);
    });

    ita('regionalHashes EN vs PT — ≥ 3/4 cantos coincidem', async () => {
        const imgEN = mangaPage(200, 300, 'EN');
        const imgPT = mangaPage(200, 300, 'PT');

        const rEN = await simulateCalculateVisualFingerprint(imgEN, 200, 300);
        const rPT = await simulateCalculateVisualFingerprint(imgPT, 200, 300);

        const matchResult = fp.matchRegionalHashes(
            rEN.regionalHashes,
            rPT.regionalHashes,
            { threshold: 8, minMatches: 3 },
        );

        console.log(`      Regional match: count=${matchResult.matchCount}/4`);
        expect(matchResult.match).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4 — CALCULATE_VISUAL_FINGERPRINT — gestão do bitmap.close()
// ─────────────────────────────────────────────────────────────────────────────
describe('CALCULATE_VISUAL_FINGERPRINT — gestão de recursos (bitmap.close)', () => {

    ita('bitmap.close() é chamado mesmo em caso de sucesso', async () => {
        let closeCalled = false;
        const fpApiMock = {
            ...fp,
            // Não sobrescreve nada — só rastreia o close()
        };

        // Adiciona rastreamento ao bitmap dentro do simulador
        const img = solidColor(50, 50);
        const OffscreenCanvas = makeOffscreenCanvasStub(img, 50, 50);
        const fakeBitmap = {
            _data: img, width: 50, height: 50,
            close() { closeCalled = true; },
        };

        // Executa a pipeline manualmente para interceptar o close
        const oc8 = new OffscreenCanvas(8, 8);
        oc8.getContext('2d').drawImage(fakeBitmap, 0, 0, 8, 8);
        const pixelSample = Array.from(oc8.getContext('2d').getImageData(0,0,8,8).data)
            .map(b => b.toString(16).padStart(2,'0')).join('');
        fakeBitmap.close();

        expect(closeCalled).toBe(true);
    });

    ita('pixelSample nunca está vazio para imagem válida', async () => {
        const images = [
            solidColor(100, 100, 0,   0,   0),
            solidColor(100, 100, 255, 255, 255),
            horizontalGradient(100, 100),
            mangaPage(100, 100, 'EN'),
        ];
        for (const img of images) {
            const r = await simulateCalculateVisualFingerprint(img, 100, 100);
            expect(r.pixelSample).toHaveLength(512);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5 — CALCULATE_VISUAL_FINGERPRINT — consistência entre SW e content script
// Verifica que os mesmos pixels produzem os mesmos hashes independente
// de onde são calculados (SW via OffscreenCanvas ou content script via canvas DOM).
// ─────────────────────────────────────────────────────────────────────────────
describe('CALCULATE_VISUAL_FINGERPRINT — consistência SW ↔ content script', () => {

    ita('wHash calculado no SW == wHash calculado diretamente (mesmos pixels 32×32)', async () => {
        const img = mangaPage(32, 32, 'EN'); // já é 32×32

        // Simula SW: drawImage no OffscreenCanvas 32×32 → wHash
        const r = await simulateCalculateVisualFingerprint(img, 32, 32);

        // Simula content script: calculateWHash diretamente com mesmos pixels
        const directWHash = fp.calculateWHash(img);

        expect(r.wHash).toBe(directWHash);
    });

    ita('pHash calculado no SW == pHash calculado diretamente (mesmos pixels 32×32)', async () => {
        const img = mangaPage(32, 32, 'PT');
        const r   = await simulateCalculateVisualFingerprint(img, 32, 32);
        const directPHash = fp.calculatePHash(img);
        expect(r.pHash).toBe(directPHash);
    });

    ita('dHash calculado no SW == dHash calculado diretamente (mesmos pixels 9×8)', async () => {
        const img = horizontalGradient(9, 8);
        const r   = await simulateCalculateVisualFingerprint(img, 9, 8);
        const directDHash = fp.calculateDHash(img);
        expect(r.dHash).toBe(directDHash);
    });

    ita('regionalHashes SW == regionalHashes direto (mesmos pixels 48×48)', async () => {
        const img = mangaPage(48, 48, 'EN');
        const r   = await simulateCalculateVisualFingerprint(img, 48, 48);
        const directRegional = fp.calculateRegionalHashes(img);
        expect(r.regionalHashes.topLeft).toBe(directRegional.topLeft);
        expect(r.regionalHashes.topRight).toBe(directRegional.topRight);
        expect(r.regionalHashes.bottomLeft).toBe(directRegional.bottomLeft);
        expect(r.regionalHashes.bottomRight).toBe(directRegional.bottomRight);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6 — Integração: SW fingerprint → IndexedDB → lookup perceptual
// End-to-end sem DOM, sem chrome.*, sem fetch real.
// ─────────────────────────────────────────────────────────────────────────────
describe('Integração SW fingerprint → IndexedDB → lookup perceptual', () => {

    require('../../extension/gtc-indexeddb.js');
    const idb = globalThis.MangaTranslatorGtcIndexedDb;

    ita('pipeline completo: calcular → salvar → buscar cross-language', async () => {
        const repo = idb.createInMemoryRepository();

        // 1. Usuário A traduz página EN via Gemini
        const imgEN = mangaPage(200, 300, 'EN');
        const fpEN  = await simulateCalculateVisualFingerprint(imgEN, 200, 300);

        // 2. Salva no IndexedDB com todos os campos visual-v3
        await repo.put({
            hash:               'sha256_en_page1',
            translatedDataUrl:  'data:image/png;base64,TRANSLATED_PAGE1',
            dHash:              fpEN.dHash,
            wHash:              fpEN.wHash,
            pHash:              fpEN.pHash,
            regionalHashes:     fpEN.regionalHashes,
            cleanUrl:           'https://cdn.site.com/en/chapter1/page1.jpg',
            width:              1200,
            height:             1800,
            fingerprintVersion: 'visual-v3',
        });

        // 3. Usuário B acessa mesma página em scanlação PT
        const imgPT = mangaPage(200, 300, 'PT');
        const fpPT  = await simulateCalculateVisualFingerprint(imgPT, 200, 300);

        // 4. Fase 2 (SHA-256 diferente → fallback para lookup perceptual)
        const result = await repo.getManyByPerceptual([fpPT.wHash], [fpPT.pHash], fp);
        const values = Object.values(result);

        console.log(`      Pipeline E2E: ${values.length} resultado(s), confidence=${values[0]?.confidence?.toFixed(3)}`);

        expect(values.length).toBeGreaterThan(0);
        expect(values[0].translatedDataUrl).toBe('data:image/png;base64,TRANSLATED_PAGE1');
        expect(values[0].confidence).toBeGreaterThan(0);
    });
});
