'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// visual-v4-crop.visual-v3.js
// Testes para as novidades do visual-v4:
//   1. Center-Crop hashes (wHashCrop, pHashCrop)
//   2. getManyByPerceptualCrop no repositório
//   3. Correspondência com thresholds relaxados para layouts responsivos
// ─────────────────────────────────────────────────────────────────────────────

globalThis.self = globalThis;
require('../../extension/gtc-fingerprint.js');
require('../../extension/gtc-indexeddb.js');

const { describe, it, ita, beforeEach, expect } = require('./runner.js');
const {
    solidColor, horizontalGradient, checkerboard,
    mangaPage, isValidHex,
} = require('./helpers.js');

const fp  = globalThis.MangaTranslatorGtcFingerprint;
const idb = globalThis.MangaTranslatorGtcIndexedDb;

function makeRepo() {
    return idb.createInMemoryRepository();
}

describe('visual-v4 — Center-Crop Hashes e Perceptual Crop Lookup', () => {
    let repo;

    beforeEach(() => {
        repo = makeRepo();
    });

    it('calculateWHash gera hash válido de 64 caracteres hex para imagem crop', () => {
        const cropData = checkerboard(32, 32, 4);
        const wHashCrop = fp.calculateWHash(cropData);
        expect(isValidHex(wHashCrop, 64)).toBeTruthy();
    });

    it('calculatePHash gera hash válido de 64 caracteres hex para imagem crop', () => {
        const cropData = horizontalGradient(32, 32);
        const pHashCrop = fp.calculatePHash(cropData);
        expect(isValidHex(pHashCrop, 64)).toBeTruthy();
    });

    ita('put persiste wHashCrop e pHashCrop no repositório', async () => {
        const entry = {
            hash: 'hash-v4-test-01',
            wHash: 'a'.repeat(64),
            pHash: 'b'.repeat(64),
            wHashCrop: 'c'.repeat(64),
            pHashCrop: 'd'.repeat(64),
            translatedDataUrl: 'data:image/png;base64,V4_TRANSLATED_IMAGE',
        };

        const putResult = await repo.put(entry);
        expect(putResult.saved).toBe(true);

        const queryResult = await repo.getMany(['hash-v4-test-01']);
        expect(queryResult['hash-v4-test-01']).toBe('data:image/png;base64,V4_TRANSLATED_IMAGE');

        const cropMatch = await repo.getManyByPerceptualCrop(['c'.repeat(64)], ['d'.repeat(64)], fp);
        expect(cropMatch[`${'c'.repeat(64)}:${'d'.repeat(64)}`]).toBeDefined();
        expect(cropMatch[`${'c'.repeat(64)}:${'d'.repeat(64)}`].translatedDataUrl).toBe('data:image/png;base64,V4_TRANSLATED_IMAGE');
    });

    ita('getManyByPerceptualCrop encontra resultado por correspondência de Center-Crop', async () => {
        const queryWHashCrop = 'e'.repeat(64);
        const queryPHashCrop = 'f'.repeat(64);

        await repo.put({
            hash: 'crop-hit-01',
            wHashCrop: queryWHashCrop,
            pHashCrop: queryPHashCrop,
            translatedDataUrl: 'data:image/png;base64,CROP_HIT_DATA',
        });

        const hits = await repo.getManyByPerceptualCrop([queryWHashCrop], [queryPHashCrop], fp);
        expect(hits).toBeDefined();
        const hitKey = `${queryWHashCrop}:${queryPHashCrop}`;
        expect(hits[hitKey]).toBeDefined();
        expect(hits[hitKey].translatedDataUrl).toBe('data:image/png;base64,CROP_HIT_DATA');
    });

    ita('getManyByPerceptualCrop ignora entradas sem wHashCrop ou pHashCrop', async () => {
        await repo.put({
            hash: 'no-crop-entry',
            wHash: '1'.repeat(64),
            pHash: '2'.repeat(64),
            translatedDataUrl: 'data:image/png;base64,NO_CROP',
        });

        const hits = await repo.getManyByPerceptualCrop(['1'.repeat(64)], ['2'.repeat(64)], fp);
        expect(Object.keys(hits)).toHaveLength(0);
    });

    it('matchPerceptualHashes suporta thresholds relaxados para variação de layout', () => {
        const hashA = '0000000000000000000000000000000000000000000000000000000000000000';
        // Variação pequena (10 bits de distância)
        const hashSimilar = '00000000000000000000000000000000000000000000000000000000000003ff';

        const match = fp.matchPerceptualHashes(hashA, hashA, hashSimilar, hashSimilar);
        expect(match.match).toBe(true);
        expect(match.confidence).toBeGreaterThan(0.7);
    });
});
