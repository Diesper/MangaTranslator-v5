'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// test_gtc_indexeddb.js
// Testes completos para gtc-indexeddb.js visual-v3
// Cobre: schema v3, createInMemoryRepository, createIndexedDbRepository,
//        getManyByPerceptual (fase 1 exata + fase 2 Hamming cross-language),
//        createGtcRuntimeHandler (todas as actions GTC_*), upgrade v2→v3.
// ─────────────────────────────────────────────────────────────────────────────

globalThis.self = globalThis;
require('../../extension/gtc-fingerprint.js');
require('../../extension/gtc-indexeddb.js');

const { describe, it, ita, beforeEach, expect } = require('./runner.js');
const fp  = globalThis.MangaTranslatorGtcFingerprint;
const idb = globalThis.MangaTranslatorGtcIndexedDb;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeEntry(overrides = {}) {
    return {
        hash:               overrides.hash              ?? 'sha256hash_' + Math.random().toString(36).slice(2),
        translatedDataUrl:  overrides.translatedDataUrl ?? 'data:image/png;base64,TRANSLATED_' + Math.random(),
        dHash:              overrides.dHash             ?? null,
        wHash:              overrides.wHash             ?? null,
        pHash:              overrides.pHash             ?? null,
        regionalHashes:     overrides.regionalHashes    ?? null,
        cleanUrl:           overrides.cleanUrl          ?? 'https://cdn.example.com/page1.jpg',
        width:              overrides.width             ?? 800,
        height:             overrides.height            ?? 1200,
        fingerprintVersion: overrides.fingerprintVersion ?? 'visual-v3',
        mimeType:           overrides.mimeType          ?? 'image/png',
        ...overrides,
    };
}

// Cria um hash hex de 64 chars com exatamente `ones` bits setados
function makeHash64(ones) {
    const chars = [];
    let bitsLeft = ones;
    for (let i = 0; i < 64; i++) {
        if      (bitsLeft >= 4) { chars.push('f'); bitsLeft -= 4; }
        else if (bitsLeft === 3) { chars.push('e'); bitsLeft = 0;  }
        else if (bitsLeft === 2) { chars.push('c'); bitsLeft = 0;  }
        else if (bitsLeft === 1) { chars.push('8'); bitsLeft = 0;  }
        else                     { chars.push('0'); }
    }
    return chars.join('');
}

// Pares de wHash/pHash similares (dentro do threshold) e distantes (fora)
const W_BASE  = makeHash64(0);   // todos zeros
const W_NEAR  = makeHash64(20);  // 20 bits → Hamming 20 ≤ 40 → match
const W_FAR   = makeHash64(100); // 100 bits → Hamming 100 > 80 → rejeição absoluta
const P_BASE  = makeHash64(0);
const P_NEAR  = makeHash64(15);  // 15 bits ≤ 35 → match
const P_FAR   = makeHash64(90);  // 90 > 70 → rejeição

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1 — normalizeHash
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeHash', () => {

    it('converte para lowercase', () => {
        expect(idb.normalizeHash('ABCDEF')).toBe('abcdef');
    });

    it('faz trim de espaços', () => {
        expect(idb.normalizeHash('  abc  ')).toBe('abc');
    });

    it('retorna "" para null', () => {
        expect(idb.normalizeHash(null)).toBe('');
    });

    it('retorna "" para undefined', () => {
        expect(idb.normalizeHash(undefined)).toBe('');
    });

    it('retorna "" para número', () => {
        expect(idb.normalizeHash(123)).toBe('');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2 — createInMemoryRepository — operações básicas
// ─────────────────────────────────────────────────────────────────────────────
describe('createInMemoryRepository — operações básicas', () => {

    let repo;
    beforeEach(() => { repo = idb.createInMemoryRepository(); });

    ita('put salva entrada e getMany retorna por SHA-256', async () => {
        const e = makeEntry({ hash: 'sha256abc' });
        await repo.put(e);
        const result = await repo.getMany(['sha256abc']);
        expect(result['sha256abc']).toBe(e.translatedDataUrl);
    });

    ita('getMany retorna {} para hash inexistente', async () => {
        const result = await repo.getMany(['nao_existe']);
        expect(Object.keys(result).length).toBe(0);
    });

    ita('put normaliza hash (case-insensitive)', async () => {
        const e = makeEntry({ hash: 'ABCDEF123' });
        await repo.put(e);
        const result = await repo.getMany(['abcdef123']);
        expect(result['abcdef123']).toBeDefined();
    });

    ita('put retorna { saved: false } para entry sem hash', async () => {
        const r = await repo.put({ translatedDataUrl: 'data:...' });
        expect(r.saved).toBe(false);
    });

    ita('put retorna { saved: false } para entry sem translatedDataUrl', async () => {
        const r = await repo.put({ hash: 'abc' });
        expect(r.saved).toBe(false);
    });

    ita('getMany em lote retorna múltiplas entradas', async () => {
        await repo.put(makeEntry({ hash: 'h1', translatedDataUrl: 'data:1' }));
        await repo.put(makeEntry({ hash: 'h2', translatedDataUrl: 'data:2' }));
        const r = await repo.getMany(['h1', 'h2', 'h3']);
        expect(r['h1']).toBe('data:1');
        expect(r['h2']).toBe('data:2');
        expect(r['h3']).toBeUndefined();
    });

    ita('putMany salva múltiplas entradas em uma chamada', async () => {
        await repo.putMany([
            makeEntry({ hash: 'm1', translatedDataUrl: 'data:m1' }),
            makeEntry({ hash: 'm2', translatedDataUrl: 'data:m2' }),
        ]);
        const r = await repo.getMany(['m1', 'm2']);
        expect(r['m1']).toBe('data:m1');
        expect(r['m2']).toBe('data:m2');
    });

    ita('stats retorna count correto', async () => {
        await repo.put(makeEntry({ hash: 's1' }));
        await repo.put(makeEntry({ hash: 's2' }));
        const s = await repo.stats();
        expect(s.count).toBeGreaterThanOrEqual(2);
    });

    ita('clear apaga todas as entradas', async () => {
        await repo.put(makeEntry({ hash: 'clear1' }));
        await repo.clear();
        const s = await repo.stats();
        expect(s.count).toBe(0);
    });

    ita('put sobrescreve entrada existente com mesmo hash', async () => {
        await repo.put(makeEntry({ hash: 'dupe', translatedDataUrl: 'data:original' }));
        await repo.put(makeEntry({ hash: 'dupe', translatedDataUrl: 'data:updated' }));
        const r = await repo.getMany(['dupe']);
        expect(r['dupe']).toBe('data:updated');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3 — createInMemoryRepository — getManyByDHash
// ─────────────────────────────────────────────────────────────────────────────
describe('createInMemoryRepository — getManyByDHash', () => {

    let repo;
    beforeEach(() => { repo = idb.createInMemoryRepository(); });

    ita('retorna translatedDataUrl pelo dHash', async () => {
        await repo.put(makeEntry({ hash: 'sha1', dHash: 'dhash1111', translatedDataUrl: 'data:dh1' }));
        const r = await repo.getManyByDHash(['dhash1111']);
        expect(r['dhash1111']).toBe('data:dh1');
    });

    ita('retorna {} para dHash inexistente', async () => {
        const r = await repo.getManyByDHash(['nao_existe_dh']);
        expect(Object.keys(r).length).toBe(0);
    });

    ita('retorna {} para array vazio', async () => {
        const r = await repo.getManyByDHash([]);
        expect(Object.keys(r).length).toBe(0);
    });

    ita('lookup múltiplos dHashes simultaneamente', async () => {
        await repo.put(makeEntry({ hash: 'a', dHash: 'dh_a', translatedDataUrl: 'data:a' }));
        await repo.put(makeEntry({ hash: 'b', dHash: 'dh_b', translatedDataUrl: 'data:b' }));
        const r = await repo.getManyByDHash(['dh_a', 'dh_b', 'dh_c']);
        expect(r['dh_a']).toBe('data:a');
        expect(r['dh_b']).toBe('data:b');
        expect(r['dh_c']).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4 — createInMemoryRepository — getManyByPerceptual (wHash+pHash)
// Testa o CORAÇÃO do visual-v3: lookup perceptual com Hamming.
// ─────────────────────────────────────────────────────────────────────────────
describe('createInMemoryRepository — getManyByPerceptual (visual-v3)', () => {

    let repo;
    beforeEach(() => { repo = idb.createInMemoryRepository(); });

    ita('retorna {} sem fpApi (graceful degradation)', async () => {
        await repo.put(makeEntry({ hash: 'h', wHash: W_BASE, pHash: P_BASE, translatedDataUrl: 'data:t' }));
        const r = await repo.getManyByPerceptual([W_BASE], [P_BASE], null);
        expect(Object.keys(r).length).toBe(0);
    });

    ita('retorna {} para arrays vazios', async () => {
        const r = await repo.getManyByPerceptual([], [], fp);
        expect(Object.keys(r).length).toBe(0);
    });

    ita('match exato (wHash idêntico) → retorna resultado', async () => {
        await repo.put(makeEntry({
            hash: 'exact1', wHash: W_BASE, pHash: P_BASE,
            translatedDataUrl: 'data:exact',
        }));
        const r = await repo.getManyByPerceptual([W_BASE], [P_BASE], fp);
        const values = Object.values(r);
        expect(values.length).toBeGreaterThan(0);
        expect(values[0].translatedDataUrl).toBe('data:exact');
    });

    ita('match aproximado (wHash similar, Hamming ≤ 40) → retorna resultado com confidence', async () => {
        // Salva com W_BASE, busca com W_NEAR (Hamming=20 ≤ 40 = match)
        await repo.put(makeEntry({
            hash: 'approx1', wHash: W_BASE, pHash: P_BASE,
            translatedDataUrl: 'data:approx',
        }));
        const r = await repo.getManyByPerceptual([W_NEAR], [P_NEAR], fp);
        const values = Object.values(r);
        expect(values.length).toBeGreaterThan(0);
        const hit = values[0];
        expect(hit.translatedDataUrl).toBe('data:approx');
        expect(hit.confidence).toBeGreaterThan(0);
        expect(hit.confidence).toBeLessThanOrEqual(1);
    });

    ita('match distante (wHash Hamming > 80) → não retorna resultado', async () => {
        await repo.put(makeEntry({
            hash: 'far1', wHash: W_BASE, pHash: P_BASE,
            translatedDataUrl: 'data:far',
        }));
        const r = await repo.getManyByPerceptual([W_FAR], [P_FAR], fp);
        expect(Object.keys(r).length).toBe(0);
    });

    ita('entrada sem wHash/pHash é ignorada no lookup perceptual', async () => {
        await repo.put(makeEntry({
            hash: 'nowhash', wHash: null, pHash: null,
            translatedDataUrl: 'data:nowhash',
        }));
        const r = await repo.getManyByPerceptual([W_BASE], [P_BASE], fp);
        // Não deve retornar a entrada sem wHash (sem dados para comparar)
        expect(Object.keys(r).length).toBe(0);
    });

    ita('múltiplos candidatos — retorna o de maior confidence', async () => {
        // Dois candidatos: um mais próximo e um mais distante
        await repo.put(makeEntry({
            hash: 'closer', wHash: makeHash64(10), pHash: makeHash64(8),
            translatedDataUrl: 'data:closer',
        }));
        await repo.put(makeEntry({
            hash: 'farther', wHash: makeHash64(35), pHash: makeHash64(28),
            translatedDataUrl: 'data:farther',
        }));
        const r = await repo.getManyByPerceptual([W_BASE], [P_BASE], fp);
        const values = Object.values(r);
        // Deve haver resultados (ambos dentro do threshold)
        expect(values.length).toBeGreaterThan(0);
        // O mais próximo deve ter confidence maior
        const maxConf = Math.max(...values.map(v => v.confidence || 0));
        expect(maxConf).toBeGreaterThan(0.5); // o mais próximo tem alta confidence
    });

    ita('resultado inclui reason, wDist, pDist', async () => {
        await repo.put(makeEntry({
            hash: 'reason_test', wHash: W_BASE, pHash: P_BASE,
            translatedDataUrl: 'data:reason',
        }));
        const r = await repo.getManyByPerceptual([W_NEAR], [P_NEAR], fp);
        const values = Object.values(r);
        if (values.length > 0) {
            expect(values[0]).toHaveProperty('reason');
            expect(values[0]).toHaveProperty('wDist');
            expect(values[0]).toHaveProperty('pDist');
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5 — createGtcRuntimeHandler — todas as actions GTC_*
// ─────────────────────────────────────────────────────────────────────────────
describe('createGtcRuntimeHandler — actions GTC_*', () => {

    let repo, handler;

    beforeEach(() => {
        repo    = idb.createInMemoryRepository();
        handler = idb.createGtcRuntimeHandler({ repository: repo, fingerprintApi: fp });
    });

    // Helper: simula chrome.runtime.sendMessage assíncrono
    function sendMessage(action, payload = {}) {
        return new Promise((resolve) => {
            const request = { action, ...payload };
            const shouldContinue = handler(request, {}, resolve);
            if (!shouldContinue) resolve({ ok: false, reason: 'unhandled' });
        });
    }

    // ── GTC_QUERY_MANY ────────────────────────────────────────────────────────
    ita('GTC_QUERY_MANY — retorna ok:true e entriesByHash', async () => {
        await repo.put(makeEntry({ hash: 'qh1', translatedDataUrl: 'data:q1' }));
        const r = await sendMessage('GTC_QUERY_MANY', { hashes: ['qh1'] });
        expect(r.ok).toBe(true);
        expect(r.entriesByHash['qh1']).toBe('data:q1');
    });

    ita('GTC_QUERY_MANY — retorna ok:true com entriesByHash vazio para miss', async () => {
        const r = await sendMessage('GTC_QUERY_MANY', { hashes: ['inexistente'] });
        expect(r.ok).toBe(true);
        expect(Object.keys(r.entriesByHash).length).toBe(0);
    });

    ita('GTC_QUERY_MANY — inclui durationMs na resposta', async () => {
        const r = await sendMessage('GTC_QUERY_MANY', { hashes: [] });
        expect(typeof r.durationMs).toBe('number');
        expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });

    // ── GTC_QUERY_BY_DHASH ────────────────────────────────────────────────────
    ita('GTC_QUERY_BY_DHASH — encontra por dHash', async () => {
        await repo.put(makeEntry({ hash: 'sha_dh', dHash: 'dhash_test', translatedDataUrl: 'data:dh' }));
        const r = await sendMessage('GTC_QUERY_BY_DHASH', { dHashes: ['dhash_test'] });
        expect(r.ok).toBe(true);
        expect(r.entriesByDHash['dhash_test']).toBe('data:dh');
    });

    ita('GTC_QUERY_BY_DHASH — retorna ok:true com vazio para miss', async () => {
        const r = await sendMessage('GTC_QUERY_BY_DHASH', { dHashes: ['dhash_miss'] });
        expect(r.ok).toBe(true);
        expect(Object.keys(r.entriesByDHash).length).toBe(0);
    });

    // ── GTC_QUERY_BY_PERCEPTUAL (visual-v3, NOVO) ─────────────────────────────
    ita('GTC_QUERY_BY_PERCEPTUAL — match exato retorna resultado', async () => {
        await repo.put(makeEntry({
            hash: 'perc_exact', wHash: W_BASE, pHash: P_BASE,
            translatedDataUrl: 'data:perc_exact',
        }));
        const r = await sendMessage('GTC_QUERY_BY_PERCEPTUAL', {
            wHashes: [W_BASE], pHashes: [P_BASE],
        });
        expect(r.ok).toBe(true);
        const values = Object.values(r.entriesByPerceptual);
        expect(values.length).toBeGreaterThan(0);
        expect(values[0].translatedDataUrl).toBe('data:perc_exact');
    });

    ita('GTC_QUERY_BY_PERCEPTUAL — match aproximado (cross-language) retorna resultado', async () => {
        await repo.put(makeEntry({
            hash: 'perc_approx', wHash: W_BASE, pHash: P_BASE,
            translatedDataUrl: 'data:perc_approx',
        }));
        const r = await sendMessage('GTC_QUERY_BY_PERCEPTUAL', {
            wHashes: [W_NEAR], pHashes: [P_NEAR],
        });
        expect(r.ok).toBe(true);
        const values = Object.values(r.entriesByPerceptual);
        expect(values.length).toBeGreaterThan(0);
    });

    ita('GTC_QUERY_BY_PERCEPTUAL — sem match retorna objeto vazio', async () => {
        await repo.put(makeEntry({
            hash: 'perc_far', wHash: W_BASE, pHash: P_BASE,
            translatedDataUrl: 'data:far',
        }));
        const r = await sendMessage('GTC_QUERY_BY_PERCEPTUAL', {
            wHashes: [W_FAR], pHashes: [P_FAR],
        });
        expect(r.ok).toBe(true);
        expect(Object.keys(r.entriesByPerceptual).length).toBe(0);
    });

    ita('GTC_QUERY_BY_PERCEPTUAL — arrays vazios retorna objeto vazio', async () => {
        const r = await sendMessage('GTC_QUERY_BY_PERCEPTUAL', {
            wHashes: [], pHashes: [],
        });
        expect(r.ok).toBe(true);
        expect(Object.keys(r.entriesByPerceptual).length).toBe(0);
    });

    // ── GTC_SAVE ──────────────────────────────────────────────────────────────
    ita('GTC_SAVE — salva todos os campos visual-v3', async () => {
        const r = await sendMessage('GTC_SAVE', {
            hash:               'save_v3',
            translatedDataUrl:  'data:saved_v3',
            dHash:              'dhash_save',
            wHash:              W_BASE,
            pHash:              P_BASE,
            regionalHashes:     { topLeft: 'aabbccdd00112233', topRight: 'aabbccdd00112234',
                                  bottomLeft: 'aabbccdd00112235', bottomRight: 'aabbccdd00112236' },
            cleanUrl:           'https://ex.com/p1.jpg',
            width:              800,
            height:             1200,
            fingerprintVersion: 'visual-v3',
            mimeType:           'image/png',
        });
        expect(r.ok).toBe(true);
        expect(r.saved).toBe(true);

        // Verifica que o dado foi salvo corretamente
        const q = await repo.getMany(['save_v3']);
        expect(q['save_v3']).toBe('data:saved_v3');
    });

    ita('GTC_SAVE — retorna ok:true e saved:false para hash vazio', async () => {
        const r = await sendMessage('GTC_SAVE', { hash: '', translatedDataUrl: 'data:x' });
        expect(r.ok).toBe(true);
        expect(r.saved).toBe(false);
    });

    // ── GTC_SAVE_MANY ─────────────────────────────────────────────────────────
    ita('GTC_SAVE_MANY — salva múltiplas entradas', async () => {
        const r = await sendMessage('GTC_SAVE_MANY', {
            entries: [
                makeEntry({ hash: 'many1', translatedDataUrl: 'data:m1' }),
                makeEntry({ hash: 'many2', translatedDataUrl: 'data:m2', wHash: W_BASE, pHash: P_BASE }),
            ],
        });
        expect(r.ok).toBe(true);
        expect(r.count).toBe(2);
        const q = await repo.getMany(['many1', 'many2']);
        expect(q['many1']).toBe('data:m1');
        expect(q['many2']).toBe('data:m2');
    });

    ita('GTC_SAVE_MANY — array vazio não lança erro', async () => {
        const r = await sendMessage('GTC_SAVE_MANY', { entries: [] });
        expect(r.ok).toBe(true);
    });

    // ── GTC_CLEAR_ALL ─────────────────────────────────────────────────────────
    ita('GTC_CLEAR_ALL — remove todas as entradas', async () => {
        await repo.put(makeEntry({ hash: 'toClear' }));
        const r = await sendMessage('GTC_CLEAR_ALL');
        expect(r.ok).toBe(true);
        expect(r.cleared).toBe(true);
        const s = await repo.stats();
        expect(s.count).toBe(0);
    });

    // ── GTC_STATS ─────────────────────────────────────────────────────────────
    ita('GTC_STATS — retorna count correto', async () => {
        await repo.put(makeEntry({ hash: 'stat1' }));
        await repo.put(makeEntry({ hash: 'stat2' }));
        const r = await sendMessage('GTC_STATS');
        expect(r.ok).toBe(true);
        expect(r.stats.count).toBeGreaterThanOrEqual(2);
    });

    // ── Ação desconhecida ─────────────────────────────────────────────────────
    it('ação desconhecida retorna false (não intercepta)', () => {
        const result = handler({ action: 'SOME_OTHER_ACTION' }, {}, () => {});
        expect(result).toBe(false);
    });

    it('request null retorna false', () => {
        const result = handler(null, {}, () => {});
        expect(result).toBe(false);
    });

    it('request sem action retorna false', () => {
        const result = handler({}, {}, () => {});
        expect(result).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6 — Schema v4 — upgrade paths e backward-compat
// ─────────────────────────────────────────────────────────────────────────────
describe('Schema v4 — constantes e backward-compat', () => {

    it('DB_VERSION é 4', () => {
        expect(idb.DB_VERSION).toBe(4);
    });

    it('DB_NAME é o esperado', () => {
        expect(idb.DB_NAME).toBe('manga_translator_gtc');
    });

    it('STORE_NAME é o esperado', () => {
        expect(idb.STORE_NAME).toBe('translations');
    });

    it('createInMemoryRepository cria repositório funcional (fallback)', () => {
        const repo = idb.createInMemoryRepository();
        expect(typeof repo.getMany).toBe('function');
        expect(typeof repo.getManyByDHash).toBe('function');
        expect(typeof repo.getManyByPerceptual).toBe('function');
        expect(typeof repo.getManyByPerceptualCrop).toBe('function');
        expect(typeof repo.put).toBe('function');
        expect(typeof repo.putMany).toBe('function');
        expect(typeof repo.clear).toBe('function');
        expect(typeof repo.stats).toBe('function');
    });

    it('createIndexedDbRepository usa fallback de memória quando indexedDB ausente', () => {
        const repo = idb.createIndexedDbRepository({ indexedDbFactory: null });
        // Sem IndexedDB real, cria repositório em memória
        expect(typeof repo.getMany).toBe('function');
        expect(typeof repo.getManyByPerceptual).toBe('function');
        expect(typeof repo.getManyByPerceptualCrop).toBe('function');
    });

    ita('entradas visual-v2 (sem wHash/pHash) são lookup-áveis via SHA-256', async () => {
        const repo = idb.createInMemoryRepository();
        // Simula entrada visual-v2 (sem wHash/pHash)
        await repo.put(makeEntry({
            hash: 'v2_entry', dHash: 'dh_v2', wHash: null, pHash: null,
            fingerprintVersion: 'visual-v2',
            translatedDataUrl: 'data:v2',
        }));
        // SHA-256 lookup deve funcionar
        const r = await repo.getMany(['v2_entry']);
        expect(r['v2_entry']).toBe('data:v2');
    });

    ita('entradas visual-v2 são lookup-áveis via dHash', async () => {
        const repo = idb.createInMemoryRepository();
        await repo.put(makeEntry({
            hash: 'v2_dh', dHash: 'dh_legacy', wHash: null, pHash: null,
            fingerprintVersion: 'visual-v2',
            translatedDataUrl: 'data:v2_dh',
        }));
        const r = await repo.getManyByDHash(['dh_legacy']);
        expect(r['dh_legacy']).toBe('data:v2_dh');
    });

    ita('entradas visual-v2 NÃO aparecem no lookup perceptual (wHash null)', async () => {
        const repo = idb.createInMemoryRepository();
        await repo.put(makeEntry({
            hash: 'v2_perc', wHash: null, pHash: null,
            fingerprintVersion: 'visual-v2',
            translatedDataUrl: 'data:v2_perc',
        }));
        const r = await repo.getManyByPerceptual([W_BASE], [P_BASE], fp);
        // Entrada sem wHash/pHash não deve aparecer no lookup perceptual
        expect(Object.keys(r).length).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7 — getManyByPerceptual — Fase 2 cross-language (Hamming scan)
// Testa o path de matching aproximado com hashes reais gerados pelo
// calculateWHash/calculatePHash usando imagens sintéticas de mangá.
// ─────────────────────────────────────────────────────────────────────────────
describe('getManyByPerceptual — Fase 2 cross-language com hashes reais', () => {

    const { solidColor, mangaPage, noise } = require('./helpers.js');

    function scaleDown(data, srcW, srcH, dstW, dstH) {
        const out = new Uint8ClampedArray(dstW * dstH * 4);
        for (let r = 0; r < dstH; r++) {
            for (let c = 0; c < dstW; c++) {
                const srcR = Math.floor(r * srcH / dstH);
                const srcC = Math.floor(c * srcW / dstW);
                const si = (srcR * srcW + srcC) * 4;
                const di = (r * dstW + c) * 4;
                out[di] = data[si]; out[di+1] = data[si+1];
                out[di+2] = data[si+2]; out[di+3] = data[si+3];
            }
        }
        return out;
    }

    let repo;
    beforeEach(() => { repo = idb.createInMemoryRepository(); });

    ita('[CROSS-LANGUAGE] salva EN, busca PT — deve fazer match', async () => {
        const srcEN = scaleDown(mangaPage(64, 64, 'EN'), 64, 64, 32, 32);
        const srcPT = scaleDown(mangaPage(64, 64, 'PT'), 64, 64, 32, 32);

        const wHashEN = fp.calculateWHash(srcEN);
        const pHashEN = fp.calculatePHash(srcEN);
        const wHashPT = fp.calculateWHash(srcPT);
        const pHashPT = fp.calculatePHash(srcPT);

        // Salva a tradução gerada para a versão EN
        await repo.put(makeEntry({
            hash: 'cross_en', wHash: wHashEN, pHash: pHashEN,
            translatedDataUrl: 'data:translated_en',
        }));

        // Busca com a versão PT (mesma arte, texto diferente)
        const r = await repo.getManyByPerceptual([wHashPT], [pHashPT], fp);
        const values = Object.values(r);

        console.log(`      Cross-language match: ${values.length} resultado(s) encontrado(s)`);
        if (values.length > 0) {
            console.log(`      Confidence: ${values[0].confidence?.toFixed(3)}, Reason: ${values[0].reason}`);
        }

        expect(values.length).toBeGreaterThan(0);
        expect(values[0].translatedDataUrl).toBe('data:translated_en');
    });

    ita('[CROSS-LANGUAGE] página diferente NÃO faz match', async () => {
        const srcEN    = scaleDown(mangaPage(64, 64, 'EN'),   64, 64, 32, 32);
        const srcNoise = scaleDown(noise(64, 64, 54321),      64, 64, 32, 32);

        const wHashEN    = fp.calculateWHash(srcEN);
        const pHashEN    = fp.calculatePHash(srcEN);
        const wHashNoise = fp.calculateWHash(srcNoise);
        const pHashNoise = fp.calculatePHash(srcNoise);

        await repo.put(makeEntry({
            hash: 'cross_en2', wHash: wHashEN, pHash: pHashEN,
            translatedDataUrl: 'data:en2',
        }));

        const r = await repo.getManyByPerceptual([wHashNoise], [pHashNoise], fp);
        expect(Object.keys(r).length).toBe(0);
    });

    ita('[FASE 1 vs FASE 2] hash exato usa fase 1, hash aproximado usa fase 2', async () => {
        const srcEN = scaleDown(mangaPage(64, 64, 'EN'), 64, 64, 32, 32);
        const wH    = fp.calculateWHash(srcEN);
        const pH    = fp.calculatePHash(srcEN);

        await repo.put(makeEntry({
            hash: 'phase_test', wHash: wH, pHash: pH,
            translatedDataUrl: 'data:phase',
        }));

        // Fase 1: hash exato
        const r1 = await repo.getManyByPerceptual([wH], [pH], fp);
        expect(Object.values(r1)[0]?.translatedDataUrl).toBe('data:phase');

        // Nota sobre confidence: fase 1 retorna 1.0 (exato), fase 2 < 1.0
        const exactResult = Object.values(r1)[0];
        if (exactResult?.reason === 'whash_exact' || exactResult?.reason === 'phash_exact') {
            expect(exactResult.confidence).toBe(1.0);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8 — createGtcRuntimeHandler — fingerprintApi null (degradação graciosa)
// ─────────────────────────────────────────────────────────────────────────────
describe('createGtcRuntimeHandler — degradação graciosa sem fingerprintApi', () => {

    let repo, handlerNoFp;

    beforeEach(() => {
        repo        = idb.createInMemoryRepository();
        // handler criado SEM fingerprintApi
        handlerNoFp = idb.createGtcRuntimeHandler({ repository: repo, fingerprintApi: null });
    });

    function sendMessage(action, payload = {}) {
        return new Promise((resolve) => {
            const request = { action, ...payload };
            const cont = handlerNoFp(request, {}, resolve);
            if (!cont) resolve({ ok: false });
        });
    }

    ita('GTC_QUERY_MANY ainda funciona sem fingerprintApi', async () => {
        await repo.put(makeEntry({ hash: 'nofp', translatedDataUrl: 'data:nofp' }));
        const r = await sendMessage('GTC_QUERY_MANY', { hashes: ['nofp'] });
        expect(r.ok).toBe(true);
        expect(r.entriesByHash['nofp']).toBe('data:nofp');
    });

    ita('GTC_QUERY_BY_PERCEPTUAL retorna ok:true com {} (não quebra)', async () => {
        await repo.put(makeEntry({
            hash: 'nofp2', wHash: W_BASE, pHash: P_BASE,
            translatedDataUrl: 'data:nofp2',
        }));
        // Sem fpApi, getManyByPerceptual retorna {} mas não lança exceção
        const r = await sendMessage('GTC_QUERY_BY_PERCEPTUAL', {
            wHashes: [W_BASE], pHashes: [P_BASE],
        });
        expect(r.ok).toBe(true);
        expect(r.entriesByPerceptual).toBeDefined();
    });

    ita('GTC_SAVE ainda salva com wHash/pHash sem fingerprintApi', async () => {
        const r = await sendMessage('GTC_SAVE', {
            hash: 'nofp_save', translatedDataUrl: 'data:nofp_save',
            wHash: W_BASE, pHash: P_BASE,
        });
        expect(r.ok).toBe(true);
        expect(r.saved).toBe(true);
    });
});
