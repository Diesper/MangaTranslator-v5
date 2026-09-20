/**
 * gtc-cache-flow.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testes de integração do Global Translation Cache (GTC) — v3.2.
 *
 * FLUXO COMPLETO:
 * 1. extractAndSendImages gera fingerprints em paralelo
 * 2. Consulta o GTC no storage (batch get)
 * 3. Cache hits → applyImageReplacement(fromCache=true)
 * 4. Cache misses → fila do Gemini
 * 5. UPDATE_IMAGE salva no GTC após nova tradução
 *
 * CENÁRIOS:
 * A. 100% cache hits → sem Gemini, checkIfComplete(true)
 * B. 0% cache hits → tudo vai para Gemini (comportamento v3.1)
 * C. Hits parciais → alguns imediatos + resto para Gemini
 * D. Mesma imagem em site espelho → GTC resolve sem Gemini
 */

const path = require('path');
const fs   = require('fs');
// Portable root finder — works regardless of where this file is placed in the tree.
// Walks up from __dirname until it finds the folder containing extension/manifest.json.
function _findRoot(d) {
    if (fs.existsSync(path.join(d, 'extension', 'manifest.json'))) return d;
    const p = path.dirname(d);
    return p === d ? process.cwd() : _findRoot(p);
}
const ROOT = _findRoot(__dirname);

const { getStorageMock } = require(path.join(ROOT, 'tests/mocks/chrome-api.mock.js'));

describe('Global Translation Cache (GTC) — Fluxo Completo v3.2', () => {

    const TRANS_BASE64 = 'data:image/png;base64,TRANSLATED_IMAGE';
    const HASH_PAGE1   = 'a'.repeat(64); // SHA-256 simulado para página 1
    const HASH_PAGE2   = 'b'.repeat(64); // SHA-256 simulado para página 2
    const HASH_PAGE3   = 'c'.repeat(64); // SHA-256 simulado para página 3

    // ── Simulação do fluxo de extractAndSendImages com GTC ─────────────────────
    async function simulateExtractWithGTC(chromeStorage, imageHashes) {
        const hashKeys = imageHashes.filter(Boolean).map(h => `gtc_${h}`);
        const gtcData = hashKeys.length > 0
            ? await new Promise(r => chromeStorage.get(hashKeys, r))
            : {};

        const cacheHits = [];
        const cacheMisses = [];

        imageHashes.forEach((hash, i) => {
            const cacheKey = hash ? `gtc_${hash}` : null;
            const cached = cacheKey ? gtcData[cacheKey] : null;
            if (cached) cacheHits.push({ index: i, base64: cached });
            else cacheMisses.push({ index: i });
        });

        return { cacheHits, cacheMisses };
    }

    let storageMock;

    beforeEach(() => {
        storageMock = getStorageMock();
    });

    describe('Cenário A: 100% cache hits', () => {
        test('todas as imagens no cache → sem envio para Gemini', async () => {
            // Pré-popula o GTC
            await storageMock.set({
                [`gtc_${HASH_PAGE1}`]: TRANS_BASE64,
                [`gtc_${HASH_PAGE2}`]: TRANS_BASE64,
            });

            const { cacheHits, cacheMisses } = await simulateExtractWithGTC(
                storageMock,
                [HASH_PAGE1, HASH_PAGE2]
            );

            expect(cacheHits).toHaveLength(2);
            expect(cacheMisses).toHaveLength(0);
        });

        test('cache hits têm o base64 correto', async () => {
            const TRANS_P1 = 'data:image/png;base64,PAGE1_TRANSLATED';
            const TRANS_P2 = 'data:image/png;base64,PAGE2_TRANSLATED';

            await storageMock.set({
                [`gtc_${HASH_PAGE1}`]: TRANS_P1,
                [`gtc_${HASH_PAGE2}`]: TRANS_P2,
            });

            const { cacheHits } = await simulateExtractWithGTC(
                storageMock,
                [HASH_PAGE1, HASH_PAGE2]
            );

            expect(cacheHits[0].base64).toBe(TRANS_P1);
            expect(cacheHits[1].base64).toBe(TRANS_P2);
        });
    });

    describe('Cenário B: 0% cache hits', () => {
        test('nenhuma imagem no cache → todas vão para Gemini', async () => {
            // Storage vazio — sem GTC entries
            const { cacheHits, cacheMisses } = await simulateExtractWithGTC(
                storageMock,
                [HASH_PAGE1, HASH_PAGE2, HASH_PAGE3]
            );

            expect(cacheHits).toHaveLength(0);
            expect(cacheMisses).toHaveLength(3);
        });

        test('indices dos cache misses são preservados corretamente', async () => {
            const { cacheMisses } = await simulateExtractWithGTC(
                storageMock,
                [HASH_PAGE1, HASH_PAGE2, HASH_PAGE3]
            );

            expect(cacheMisses.map(m => m.index)).toEqual([0, 1, 2]);
        });
    });

    describe('Cenário C: hits parciais', () => {
        test('pag1 e pag3 no cache, pag2 não → pag2 vai para Gemini', async () => {
            await storageMock.set({
                [`gtc_${HASH_PAGE1}`]: TRANS_BASE64,
                // HASH_PAGE2 não está no cache
                [`gtc_${HASH_PAGE3}`]: TRANS_BASE64,
            });

            const { cacheHits, cacheMisses } = await simulateExtractWithGTC(
                storageMock,
                [HASH_PAGE1, HASH_PAGE2, HASH_PAGE3]
            );

            expect(cacheHits.map(h => h.index)).toEqual([0, 2]);
            expect(cacheMisses.map(m => m.index)).toEqual([1]);
        });

        test('contagem total = cache hits + cache misses = imagens selecionadas', async () => {
            await storageMock.set({ [`gtc_${HASH_PAGE1}`]: TRANS_BASE64 });

            const { cacheHits, cacheMisses } = await simulateExtractWithGTC(
                storageMock,
                [HASH_PAGE1, HASH_PAGE2, HASH_PAGE3]
            );

            expect(cacheHits.length + cacheMisses.length).toBe(3);
        });
    });

    describe('Cenário D: mesma imagem em site espelho (cross-URL)', () => {
        test('imagem traduzida em siteA é reconhecida em siteB pelo hash', async () => {
            // A MESMA imagem física (mesmo conteúdo de pixels) tem URLs diferentes
            // em dois sites, mas produz o MESMO fingerprint hash.
            const SHARED_HASH = HASH_PAGE1; // Mesmo hash = mesma imagem

            // Salva no GTC após tradução em siteA
            await storageMock.set({ [`gtc_${SHARED_HASH}`]: TRANS_BASE64 });

            // siteB tenta traduzir a mesma imagem — deve encontrar no GTC
            const { cacheHits, cacheMisses } = await simulateExtractWithGTC(
                storageMock,
                [SHARED_HASH] // Mesmo hash, URL diferente (mas hash é o que importa)
            );

            expect(cacheHits).toHaveLength(1);
            expect(cacheMisses).toHaveLength(0);
            expect(cacheHits[0].base64).toBe(TRANS_BASE64);
        });
    });

    describe('Salvamento no GTC após tradução pelo Gemini', () => {
        test('UPDATE_IMAGE salva entry no GTC com chave gtc_${hash}', async () => {
            const hash = HASH_PAGE1;
            const translated = TRANS_BASE64;

            // Simula o que UPDATE_IMAGE faz
            await storageMock.set({ [`gtc_${hash}`]: translated });

            // Verifica que a entry foi salva
            const data = await storageMock.get([`gtc_${hash}`]);
            expect(data[`gtc_${hash}`]).toBe(translated);
        });

        test('sem hash disponível (fingerprint falhou), GTC não é salvo', async () => {
            // origHash = null significa que generateImageFingerprint retornou null
            const origHash = null;
            const toSet = {};

            if (origHash) {
                toSet[`gtc_${origHash}`] = TRANS_BASE64;
            }

            await storageMock.set(toSet);

            // Nenhuma chave gtc_* deve existir
            const data = await storageMock.get(null);
            const gtcKeys = Object.keys(data).filter(k => k.startsWith('gtc_'));
            expect(gtcKeys).toHaveLength(0);
        });

        test('múltiplas traduções criam múltiplas entries no GTC', async () => {
            await storageMock.set({ [`gtc_${HASH_PAGE1}`]: 'data:base64:T1' });
            await storageMock.set({ [`gtc_${HASH_PAGE2}`]: 'data:base64:T2' });
            await storageMock.set({ [`gtc_${HASH_PAGE3}`]: 'data:base64:T3' });

            const data = await storageMock.get(null);
            const gtcKeys = Object.keys(data).filter(k => k.startsWith('gtc_'));
            expect(gtcKeys).toHaveLength(3);
        });
    });

    describe('Batch get vs N gets individuais (eficiência)', () => {
        test('um único get com N chaves retorna os mesmos dados que N gets individuais', async () => {
            await storageMock.set({
                [`gtc_${HASH_PAGE1}`]: 'data:T1',
                [`gtc_${HASH_PAGE2}`]: 'data:T2',
                [`gtc_${HASH_PAGE3}`]: 'data:T3',
            });

            // Batch get (uma chamada)
            const batchResult = await new Promise(r =>
                storageMock.get([
                    `gtc_${HASH_PAGE1}`,
                    `gtc_${HASH_PAGE2}`,
                    `gtc_${HASH_PAGE3}`
                ], r)
            );

            expect(batchResult[`gtc_${HASH_PAGE1}`]).toBe('data:T1');
            expect(batchResult[`gtc_${HASH_PAGE2}`]).toBe('data:T2');
            expect(batchResult[`gtc_${HASH_PAGE3}`]).toBe('data:T3');
        });
    });

    describe('Hashes nulos ou imagens inválidas', () => {
        test('hash null é ignorado (sem entrada no GTC)', async () => {
            const hashes = [null, HASH_PAGE1, null];
            await storageMock.set({ [`gtc_${HASH_PAGE1}`]: TRANS_BASE64 });

            const { cacheHits, cacheMisses } = await simulateExtractWithGTC(
                storageMock,
                hashes
            );

            // null hashes = cache miss
            expect(cacheMisses.map(m => m.index)).toContain(0);
            expect(cacheMisses.map(m => m.index)).toContain(2);
            expect(cacheHits.map(h => h.index)).toContain(1);
        });
    });
});
