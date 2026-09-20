'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// test_integration.js
// Testes de integração end-to-end — cadeia completa
//
// Simula o ciclo de vida real:
//   1. Usuário A traduz página EN → fingerprint calculado → salvo no IndexedDB
//   2. Usuário B acessa mesma página em PT → pipeline 5 fases → cache hit
//
// Também testa:
//   - Degradação graciosa quando partes do sistema estão indisponíveis
//   - Compatibilidade backward com entradas v1/v2
//   - Múltiplos capítulos no mesmo banco
//   - Performance de lote (N imagens)
// ─────────────────────────────────────────────────────────────────────────────

globalThis.self = globalThis;
require('../../extension/gtc-fingerprint.js');
require('../../extension/gtc-indexeddb.js');

const { describe, it, ita, beforeEach, expect } = require('./runner.js');
const {
    solidColor, horizontalGradient, checkerboard,
    mangaPage, noise, brightnessShifted, isValidHex,
} = require('./helpers.js');

const fp  = globalThis.MangaTranslatorGtcFingerprint;
const idb = globalThis.MangaTranslatorGtcIndexedDb;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de integração
// ─────────────────────────────────────────────────────────────────────────────

function makeRepo() { return idb.createInMemoryRepository(); }

function makeHandler(repo) {
    return idb.createGtcRuntimeHandler({ repository: repo, fingerprintApi: fp });
}

function makeSend(handler) {
    return (msg) => new Promise(resolve => {
        const handled = handler(msg, {}, resolve);
        if (!handled) resolve({ ok: false });
    });
}

function makeFullSend(repo) {
    return makeSend(makeHandler(repo));
}

async function calcAllHashes(imageData32, imageData48, imageData9x8) {
    const wHash = fp.calculateWHash(imageData32);
    const pHash = fp.calculatePHash(imageData32);
    const dHash = fp.calculateDHash(imageData9x8 || new Uint8ClampedArray(9*8*4).fill(128));
    const regionalHashes = fp.calculateRegionalHashes(imageData48);
    return { wHash, pHash, dHash, regionalHashes };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1 — Ciclo de vida completo: traduzir → salvar → encontrar
// ─────────────────────────────────────────────────────────────────────────────
describe('Ciclo de vida completo: traduzir → salvar → encontrar', () => {

    ita('Usuário A salva; Usuário A re-encontra pelo mesmo SHA-256', async () => {
        const repo   = makeRepo();
        const send   = makeFullSend(repo);
        const img32  = solidColor(32, 32, 100, 150, 200);
        const img48  = new Uint8ClampedArray(48*48*4).fill(120);
        const hashes = await calcAllHashes(img32, img48);

        // SHA-256 do fingerprint (usa pixelSample de 8×8)
        const pixelSample = Array.from(img32.slice(0, 8*8*4)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 512);
        const sha256 = await fp.hashStringSha256(`800:1200:pixels:${pixelSample}`);

        // Usuário A: salva
        await send({ action: 'GTC_SAVE', hash: sha256, translatedDataUrl: 'data:trad',
            wHash: hashes.wHash, pHash: hashes.pHash, dHash: hashes.dHash,
            regionalHashes: hashes.regionalHashes, fingerprintVersion: 'visual-v3' });

        // Usuário A: re-encontra
        const r = await send({ action: 'GTC_QUERY_MANY', hashes: [sha256] });
        expect(r.ok).toBe(true);
        expect(r.entriesByHash[sha256]).toBe('data:trad');
    });

    ita('[CROSS-LANGUAGE] Usuário A (EN) salva; Usuário B (PT) encontra via perceptual', async () => {
        const repo  = makeRepo();
        const send  = makeFullSend(repo);

        // Imagens "EN" e "PT" — mesma arte, texto diferente
        const imgEN32 = mangaPage(32, 32, 'EN');
        const imgPT32 = mangaPage(32, 32, 'PT');
        const img48   = new Uint8ClampedArray(48*48*4);
        // Preenche o 48x48 com a imagem EN escalada
        for (let i = 0; i < img48.length; i++) img48[i] = imgEN32[i % imgEN32.length];

        const hashesEN = await calcAllHashes(imgEN32, img48);
        const hashesPT = await calcAllHashes(imgPT32, img48);

        // Usuário A: salva com hashes EN
        await send({
            action: 'GTC_SAVE', hash: 'sha256_en_page3',
            translatedDataUrl: 'data:traduzida_en',
            wHash: hashesEN.wHash, pHash: hashesEN.pHash,
            dHash: hashesEN.dHash, regionalHashes: hashesEN.regionalHashes,
            fingerprintVersion: 'visual-v3',
        });

        // Usuário B: busca com hashes PT (SHA-256 diferente → recai em lookup perceptual)
        const r = await send({
            action: 'GTC_QUERY_BY_PERCEPTUAL',
            wHashes: [hashesPT.wHash],
            pHashes: [hashesPT.pHash],
        });

        expect(r.ok).toBe(true);
        const values = Object.values(r.entriesByPerceptual);
        console.log(`      [Cross-language] Resultados encontrados: ${values.length}`);
        expect(values.length).toBeGreaterThan(0);
        expect(values[0].translatedDataUrl).toBe('data:traduzida_en');
        expect(values[0].confidence).toBeGreaterThan(0);
    });

    ita('[BACKWARD-COMPAT] entrada visual-v1 encontrada via SHA-256', async () => {
        const repo = makeRepo();
        const send = makeFullSend(repo);

        const sha256 = 'old_sha256_v1_entry_hash';
        await send({
            action: 'GTC_SAVE', hash: sha256,
            translatedDataUrl: 'data:v1_entry',
            fingerprintVersion: 'visual-v1',
            // wHash/pHash/dHash ausentes (visual-v1)
        });

        const r = await send({ action: 'GTC_QUERY_MANY', hashes: [sha256] });
        expect(r.ok).toBe(true);
        expect(r.entriesByHash[sha256]).toBe('data:v1_entry');
    });

    ita('[BACKWARD-COMPAT] entrada visual-v2 encontrada via dHash', async () => {
        const repo = makeRepo();
        const send = makeFullSend(repo);

        const dHash = fp.calculateDHash(new Uint8ClampedArray(9*8*4).fill(180));

        await send({
            action: 'GTC_SAVE', hash: 'sha256_v2_page',
            translatedDataUrl: 'data:v2_entry',
            dHash,
            fingerprintVersion: 'visual-v2',
        });

        const r = await send({ action: 'GTC_QUERY_BY_DHASH', dHashes: [dHash] });
        expect(r.ok).toBe(true);
        expect(r.entriesByDHash[dHash]).toBe('data:v2_entry');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2 — Multiple capítulos — isolamento de dados
// ─────────────────────────────────────────────────────────────────────────────
describe('Múltiplos capítulos — isolamento no IndexedDB', () => {

    ita('páginas de capítulos diferentes têm wHashes diferentes', async () => {
        // Use images with genuine spatial variation so wHash differs
        const imgCap1P1 = horizontalGradient(32, 32);
        const imgCap1P2 = checkerboard(32, 32, 4);
        const imgCap2P1 = noise(32, 32, 42);

        const w1 = fp.calculateWHash(imgCap1P1);
        const w2 = fp.calculateWHash(imgCap1P2);
        const w3 = fp.calculateWHash(imgCap2P1);

        // Each structurally different image has a different wHash
        expect(w1).not.toBe(w2);
        expect(w1).not.toBe(w3);
        expect(w2).not.toBe(w3);
    });

    ita('lookup por SHA-256 não retorna entradas de outros capítulos', async () => {
        const repo = makeRepo();
        const send = makeFullSend(repo);

        await send({ action: 'GTC_SAVE', hash: 'cap1_pg1', translatedDataUrl: 'data:c1p1',
            wHash: null, pHash: null });
        await send({ action: 'GTC_SAVE', hash: 'cap2_pg1', translatedDataUrl: 'data:c2p1',
            wHash: null, pHash: null });

        const r = await send({ action: 'GTC_QUERY_MANY', hashes: ['cap1_pg1'] });
        expect(r.entriesByHash['cap1_pg1']).toBe('data:c1p1');
        expect(r.entriesByHash['cap2_pg1']).toBeUndefined();
    });

    ita('putMany com mistura de capítulos → cada um recuperável', async () => {
        const repo = makeRepo();
        const send = makeFullSend(repo);

        await send({
            action: 'GTC_SAVE_MANY',
            entries: [
                { hash: 'c1p1', translatedDataUrl: 'data:c1p1' },
                { hash: 'c1p2', translatedDataUrl: 'data:c1p2' },
                { hash: 'c2p1', translatedDataUrl: 'data:c2p1' },
                { hash: 'c3p1', translatedDataUrl: 'data:c3p1' },
            ],
        });

        const r = await send({ action: 'GTC_QUERY_MANY', hashes: ['c1p1', 'c1p2', 'c2p1', 'c3p1'] });
        expect(r.entriesByHash['c1p1']).toBe('data:c1p1');
        expect(r.entriesByHash['c2p1']).toBe('data:c2p1');
        expect(r.entriesByHash['c3p1']).toBe('data:c3p1');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3 — Robustez a variações entre scanlações
// ─────────────────────────────────────────────────────────────────────────────
describe('Robustez a variações entre scanlações', () => {

    ita('variação de brilho (+30) não destrói o match cross-language', async () => {
        const repo = makeRepo();
        const send = makeFullSend(repo);

        const imgBase    = mangaPage(32, 32, 'EN');
        const imgShifted = brightnessShifted(imgBase, 30);

        const wH_base    = fp.calculateWHash(imgBase);
        const pH_base    = fp.calculatePHash(imgBase);
        const wH_shifted = fp.calculateWHash(imgShifted);
        const pH_shifted = fp.calculatePHash(imgShifted);

        await send({ action: 'GTC_SAVE', hash: 'sha_brightness',
            translatedDataUrl: 'data:brightness_test',
            wHash: wH_base, pHash: pH_base, fingerprintVersion: 'visual-v3' });

        const r = await send({
            action: 'GTC_QUERY_BY_PERCEPTUAL',
            wHashes: [wH_shifted], pHashes: [pH_shifted],
        });

        const values = Object.values(r.entriesByPerceptual);
        console.log(`      Brilho+30: ${values.length} resultado(s)`);
        expect(values.length).toBeGreaterThan(0);
    });

    ita('imagem completamente diferente não contamina o cache', async () => {
        const repo = makeRepo();
        const send = makeFullSend(repo);

        const imgManga = mangaPage(32, 32, 'EN');
        const imgNoise = noise(32, 32, 12345);

        const wH_manga = fp.calculateWHash(imgManga);
        const pH_manga = fp.calculatePHash(imgManga);
        const wH_noise = fp.calculateWHash(imgNoise);
        const pH_noise = fp.calculatePHash(imgNoise);

        await send({ action: 'GTC_SAVE', hash: 'sha_real_manga',
            translatedDataUrl: 'data:real_manga_translation',
            wHash: wH_manga, pHash: pH_manga, fingerprintVersion: 'visual-v3' });

        // Busca com imagem completamente diferente — não deve encontrar
        const r = await send({
            action: 'GTC_QUERY_BY_PERCEPTUAL',
            wHashes: [wH_noise], pHashes: [pH_noise],
        });

        expect(Object.keys(r.entriesByPerceptual).length).toBe(0);
    });

    ita('match combinado (wHash + pHash) tem confidence maior que match simples', async () => {
        const d32 = mangaPage(32, 32, 'EN');
        const wH  = fp.calculateWHash(d32);
        const pH  = fp.calculatePHash(d32);

        // wDist=0, pDist=0 → ambos match = confidence próxima de 1
        const both = fp.matchPerceptualHashes(wH, pH, wH, pH);

        // wDist=0, pDist não disponível → só wHash match
        const single = fp.matchPerceptualHashes(wH, null, wH, null);

        expect(both.match).toBe(true);
        expect(single.match).toBe(true);
        // both_match deve ter confidence ≥ whash_only_match
        expect(both.confidence).toBeGreaterThanOrEqual(single.confidence);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4 — Performance: N imagens em lote
// ─────────────────────────────────────────────────────────────────────────────
describe('Performance: processamento em lote', () => {

    ita('calcular wHash+pHash para 20 imagens em < 500ms', async () => {
        const images = Array.from({ length: 20 }, (_, i) =>
            mangaPage(32, 32, i % 2 === 0 ? 'EN' : 'PT')
        );

        const start = Date.now();
        const results = await Promise.all(images.map(async img => ({
            wHash: fp.calculateWHash(img),
            pHash: fp.calculatePHash(img),
        })));
        const elapsed = Date.now() - start;

        console.log(`      20 imagens wHash+pHash: ${elapsed}ms`);
        expect(results.length).toBe(20);
        expect(elapsed).toBeLessThan(500);
        results.forEach(r => {
            expect(isValidHex(r.wHash, 64)).toBeTruthy();
            expect(isValidHex(r.pHash, 64)).toBeTruthy();
        });
    });

    ita('calcular regionalHashes para 20 imagens em < 500ms', async () => {
        const images = Array.from({ length: 20 }, () =>
            new Uint8ClampedArray(48*48*4).fill(Math.floor(Math.random() * 255))
        );

        const start = Date.now();
        const results = images.map(img => fp.calculateRegionalHashes(img));
        const elapsed = Date.now() - start;

        console.log(`      20 imagens regionalHashes: ${elapsed}ms`);
        expect(results.length).toBe(20);
        expect(elapsed).toBeLessThan(500);
    });

    ita('GTC_SAVE_MANY + GTC_QUERY_MANY para 50 entradas', async () => {
        const repo = makeRepo();
        const send = makeFullSend(repo);

        const entries = Array.from({ length: 50 }, (_, i) => ({
            hash:              `bulk_hash_${i}`,
            translatedDataUrl: `data:bulk_${i}`,
        }));

        const saveR = await send({ action: 'GTC_SAVE_MANY', entries });
        expect(saveR.ok).toBe(true);
        expect(saveR.count).toBe(50);

        const hashes = entries.map(e => e.hash);
        const queryR = await send({ action: 'GTC_QUERY_MANY', hashes });
        expect(queryR.ok).toBe(true);
        expect(Object.keys(queryR.entriesByHash).length).toBe(50);
    });

    ita('lookup perceptual com 10 candidatos no banco em < 200ms', async () => {
        const repo = makeRepo();

        // Popula banco com 10 entradas diversas
        for (let i = 0; i < 10; i++) {
            const d32 = solidColor(32, 32, i*20, i*15, i*10);
            await repo.put({
                hash:              `perf_hash_${i}`,
                translatedDataUrl: `data:perf_${i}`,
                wHash:             fp.calculateWHash(d32),
                pHash:             fp.calculatePHash(d32),
                fingerprintVersion: 'visual-v3',
            });
        }

        // Busca com imagem EN (cross-language scan)
        const queryD32 = mangaPage(32, 32, 'PT');
        const qW = fp.calculateWHash(queryD32);
        const qP = fp.calculatePHash(queryD32);

        const start = Date.now();
        await repo.getManyByPerceptual([qW], [qP], fp);
        const elapsed = Date.now() - start;

        console.log(`      Lookup perceptual 10 candidatos: ${elapsed}ms`);
        expect(elapsed).toBeLessThan(200);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5 — Invariantes arquiteturais
// ─────────────────────────────────────────────────────────────────────────────
describe('Invariantes arquiteturais', () => {

    it('MangaTranslatorGtcFingerprint está acessível como global', () => {
        expect(globalThis.MangaTranslatorGtcFingerprint).toBeDefined();
    });

    it('MangaTranslatorGtcIndexedDb está acessível como global', () => {
        expect(globalThis.MangaTranslatorGtcIndexedDb).toBeDefined();
    });

    it('API fingerprint expõe todos os símbolos esperados', () => {
        const expected = [
            'buildFingerprintSource', 'hashStringSha256', 'createFingerprintFromDescriptor',
            'calculateDHash',
            'calculateWHash', 'calculatePHash',
            'calculateRegionalHashes', 'matchRegionalHashes',
            'hammingDistance', 'matchPerceptualHashes', 'matchPerceptualHashesRelaxed',
            'WHASH_MATCH_THRESHOLD', 'PHASH_MATCH_THRESHOLD',
            'WHASH_REJECT_THRESHOLD', 'PHASH_REJECT_THRESHOLD',
            'WHASH_MATCH_THRESHOLD_RELAXED', 'PHASH_MATCH_THRESHOLD_RELAXED',
            'WHASH_REJECT_THRESHOLD_RELAXED', 'PHASH_REJECT_THRESHOLD_RELAXED',
        ];
        expected.forEach(key => {
            expect(fp[key]).toBeDefined();
        });
    });

    it('API indexeddb expõe todos os símbolos esperados', () => {
        const expected = [
            'DB_NAME', 'STORE_NAME', 'DB_VERSION',
            'createIndexedDbRepository', 'createInMemoryRepository',
            'createGtcRuntimeHandler', 'normalizeHash', 'cloneValue',
        ];
        expected.forEach(key => {
            expect(idb[key]).toBeDefined();
        });
    });

    it('createGtcRuntimeHandler retorna função síncrona (não async)', () => {
        const repo    = makeRepo();
        const handler = makeHandler(repo);
        // Função síncrona: typeof === 'function', toString não contém "async"
        expect(typeof handler).toBe('function');
        const fnStr = handler.toString();
        // Não deve começar com "async" — CRÍTICO para MV3 chrome.runtime.onMessage
        expect(fnStr.trimStart().startsWith('async')).toBe(false);
    });

    it('DB_VERSION é 4 (schema visual-v4)', () => {
        expect(idb.DB_VERSION).toBe(4);
    });

    it('thresholds seguem a relação REJECT > MATCH para ambos os hashes', () => {
        expect(fp.WHASH_REJECT_THRESHOLD).toBeGreaterThan(fp.WHASH_MATCH_THRESHOLD);
        expect(fp.PHASH_REJECT_THRESHOLD).toBeGreaterThan(fp.PHASH_MATCH_THRESHOLD);
    });

    it('hammingDistance(a, a) = 0 para qualquer hash válido', () => {
        const hashes = [
            '0'.repeat(16),
            'f'.repeat(16),
            'deadbeef01234567',
            '0'.repeat(64),
            'f'.repeat(64),
            fp.calculateWHash(solidColor(32,32,100,100,100)),
            fp.calculatePHash(solidColor(32,32,100,100,100)),
        ];
        hashes.forEach(h => {
            expect(fp.hammingDistance(h, h)).toBe(0);
        });
    });

    it('hammingDistance é comutativa: d(a,b) == d(b,a)', () => {
        const h1 = fp.calculateWHash(solidColor(32,32,50,50,50));
        const h2 = fp.calculateWHash(solidColor(32,32,200,200,200));
        expect(fp.hammingDistance(h1, h2)).toBe(fp.hammingDistance(h2, h1));
    });

    it('matchPerceptualHashes é simétrico para ambos os tipos de match', () => {
        const d32A = mangaPage(32, 32, 'EN');
        const d32B = mangaPage(32, 32, 'PT');
        const wA = fp.calculateWHash(d32A), pA = fp.calculatePHash(d32A);
        const wB = fp.calculateWHash(d32B), pB = fp.calculatePHash(d32B);

        const rAB = fp.matchPerceptualHashes(wA, pA, wB, pB);
        const rBA = fp.matchPerceptualHashes(wB, pB, wA, pA);

        // Match deve ser simétrico
        expect(rAB.match).toBe(rBA.match);
    });

    it('wHash e pHash de imagens diferentes têm distâncias independentes', () => {
        // A distinção entre wHash e pHash é que capturam aspectos complementares
        // Duas imagens com wHash similar podem ter pHash diferente e vice-versa
        const img1 = horizontalGradient(32, 32);
        const img2 = checkerboard(32, 32, 2);

        const dW = fp.hammingDistance(fp.calculateWHash(img1), fp.calculateWHash(img2));
        const dP = fp.hammingDistance(fp.calculatePHash(img1), fp.calculatePHash(img2));

        // Ambas são distâncias válidas (0-256)
        expect(dW).toBeGreaterThanOrEqual(0);
        expect(dW).toBeLessThanOrEqual(256);
        expect(dP).toBeGreaterThanOrEqual(0);
        expect(dP).toBeLessThanOrEqual(256);
    });

    ita('cloneValue faz deep-copy de objetos', async () => {
        const original = { hash: 'abc', nested: { x: 1 } };
        const clone    = idb.cloneValue(original);
        clone.nested.x = 999;
        expect(original.nested.x).toBe(1);
    });

    it('cloneValue retorna null para null', () => {
        expect(idb.cloneValue(null)).toBeNull();
    });

    it('cloneValue retorna undefined para undefined', () => {
        expect(idb.cloneValue(undefined)).toBeUndefined();
    });
});
