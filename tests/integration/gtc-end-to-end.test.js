/**
 * gtc-end-to-end.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Teste de integração end-to-end das features v3.2:
 * Auto-Restore + GTC + restoreMap trabalhando juntos.
 *
 * JORNADA DO USUÁRIO SIMULADA:
 * 1. Usuário traduz "One Piece Cap 1050" no site A pela primeira vez
 *    → Gemini processa → UPDATE_IMAGE salva _images + restoreMap + GTC
 * 2. Usuário dá F5 na mesma página (tokens de CDN mudam)
 *    → initializeAutoRestorer carrega restoreMap
 *    → applyAutoRestore encontra imagem pela clean URL
 *    → Imagem restaurada SEM Gemini
 * 3. Usuário acessa o mesmo capítulo no site B (site espelho)
 *    → extractAndSendImages gera fingerprint
 *    → GTC contém o hash → cache hit
 *    → Imagem restaurada SEM Gemini
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

// ── Implementações espelho completas ─────────────────────────────────────────

function getCleanUrl(urlStr) {
    if (!urlStr || urlStr.startsWith('data:')) return null;
    try {
        const u = new URL(urlStr, 'https://siteA.com');
        return u.origin + u.pathname;
    } catch(e) { return urlStr.split('?')[0].split('#')[0]; }
}

async function simulateUpdateImage(storageMock, {
    chapterId, index, origUrl, origHash, translatedBase64, chapterList = []
}) {
    const origCleanUrl = getCleanUrl(origUrl);

    return new Promise(resolve => {
        storageMock.get([
            `${chapterId}_images`,
            `${chapterId}_restoreMap`,
        ], (data) => {
            const imgs = data[`${chapterId}_images`] || {};
            imgs[index] = translatedBase64;

            const restoreMap = data[`${chapterId}_restoreMap`] || {};
            if (origCleanUrl) restoreMap[origCleanUrl] = translatedBase64;

            const toSet = {
                [`${chapterId}_images`]: imgs,
                [`${chapterId}_restoreMap`]: restoreMap,
            };
            if (origHash) toSet[`gtc_${origHash}`] = translatedBase64;

            storageMock.set(toSet, resolve);
        });
    });
}

async function simulateAutoRestore(storageMock, chapterId, domImages) {
    return new Promise(resolve => {
        storageMock.get([`${chapterId}_restoreMap`], (data) => {
            const restoreMap = data[`${chapterId}_restoreMap`] || {};
            if (Object.keys(restoreMap).length === 0) { resolve([]); return; }

            const restored = [];
            for (const img of domImages) {
                const cleanUrl = getCleanUrl(img.src);
                if (cleanUrl && restoreMap[cleanUrl]) {
                    restored.push({ src: img.src, translated: restoreMap[cleanUrl] });
                }
            }
            resolve(restored);
        });
    });
}

async function simulateGTCLookup(storageMock, hashes) {
    const keys = hashes.filter(Boolean).map(h => `gtc_${h}`);
    if (keys.length === 0) return { hits: [], misses: hashes.map((_, i) => i) };

    return new Promise(resolve => {
        storageMock.get(keys, (data) => {
            const hits = [], misses = [];
            hashes.forEach((hash, i) => {
                if (hash && data[`gtc_${hash}`]) hits.push({ index: i, base64: data[`gtc_${hash}`] });
                else misses.push(i);
            });
            resolve({ hits, misses });
        });
    });
}

describe('GTC End-to-End — Jornada Completa do Usuário (v3.2)', () => {

    const CHAPTER_ID  = 'chap_test_e2e';
    const SITE_A_URL  = 'https://siteA.com/manga/one-piece/cap-1050/pag1.jpg';
    const SITE_A_TOKEN_2 = 'https://siteA.com/manga/one-piece/cap-1050/pag1.jpg?token=NEW123';
    const SITE_B_URL  = 'https://siteB.com/mirror/one-piece/1050/001.jpg'; // Site espelho
    const HASH_P1     = 'd'.repeat(64); // Fingerprint da imagem (mesmo conteúdo de pixels)
    const TRANSLATED  = 'data:image/png;base64,ONE_PIECE_1050_P1_TRANSLATED';

    let storageMock;

    beforeEach(() => {
        storageMock = getStorageMock();
    });

    describe('Jornada 1: Primeira tradução (Gemini processsa)', () => {
        test('UPDATE_IMAGE salva nas 3 estruturas simultaneamente', async () => {
            await simulateUpdateImage(storageMock, {
                chapterId: CHAPTER_ID,
                index: 0,
                origUrl: SITE_A_URL,
                origHash: HASH_P1,
                translatedBase64: TRANSLATED,
            });

            const data = await storageMock.get([
                `${CHAPTER_ID}_images`,
                `${CHAPTER_ID}_restoreMap`,
                `gtc_${HASH_P1}`,
            ]);

            // Leitor offline
            expect(data[`${CHAPTER_ID}_images`][0]).toBe(TRANSLATED);
            // Auto-Restore
            // CORREÇÃO: new URL('https://siteA.com/...') normaliza o hostname para MINÚSCULAS
            // (RFC 3986 — hostnames são case-insensitive, browsers normalizam para lowercase).
            // Portanto a chave do restoreMap é 'https://sitea.com/...' não 'https://siteA.com/...'
            expect(data[`${CHAPTER_ID}_restoreMap`]['https://sitea.com/manga/one-piece/cap-1050/pag1.jpg']).toBe(TRANSLATED);
            // GTC
            expect(data[`gtc_${HASH_P1}`]).toBe(TRANSLATED);
        });
    });

    describe('Jornada 2: F5 com token de CDN rotacionado', () => {
        test('imagem é restaurada automaticamente mesmo com token diferente', async () => {
            // Setup: imagem foi traduzida na sessão anterior
            await simulateUpdateImage(storageMock, {
                chapterId: CHAPTER_ID,
                index: 0,
                origUrl: SITE_A_URL,
                origHash: HASH_P1,
                translatedBase64: TRANSLATED,
            });

            // F5: DOM tem imagem com NOVO token
            const domAfterF5 = [{ src: SITE_A_TOKEN_2 }]; // Token mudou!
            const restored = await simulateAutoRestore(storageMock, CHAPTER_ID, domAfterF5);

            expect(restored).toHaveLength(1);
            expect(restored[0].translated).toBe(TRANSLATED);
        });

        test('sem tradução prévia, F5 não restaura nada (não há restoreMap)', async () => {
            const domAfterF5 = [{ src: SITE_A_URL }];
            const restored = await simulateAutoRestore(storageMock, CHAPTER_ID, domAfterF5);
            expect(restored).toHaveLength(0);
        });
    });

    describe('Jornada 3: Mesma imagem em site espelho (cross-URL)', () => {
        test('GTC reconhece a imagem pelo fingerprint, mesmo em site diferente', async () => {
            // Pré-condição: imagem foi traduzida em siteA
            await simulateUpdateImage(storageMock, {
                chapterId: CHAPTER_ID,
                index: 0,
                origUrl: SITE_A_URL,
                origHash: HASH_P1,
                translatedBase64: TRANSLATED,
            });

            // siteB: mesmo fingerprint (mesma imagem física, URL diferente)
            const { hits, misses } = await simulateGTCLookup(storageMock, [HASH_P1]);

            expect(hits).toHaveLength(1);
            expect(hits[0].base64).toBe(TRANSLATED);
            expect(misses).toHaveLength(0);
        });

        test('restoreMap de siteA NÃO restaura em siteB (restoreMap é por chapterId)', async () => {
            await simulateUpdateImage(storageMock, {
                chapterId: CHAPTER_ID, // chapterId de siteA
                index: 0,
                origUrl: SITE_A_URL,
                origHash: HASH_P1,
                translatedBase64: TRANSLATED,
            });

            // siteB usa um chapterId diferente (URL diferente = capítulo diferente no banco)
            const CHAPTER_ID_SITE_B = 'chap_siteb_001';
            const domSiteB = [{ src: SITE_B_URL }];

            const restored = await simulateAutoRestore(storageMock, CHAPTER_ID_SITE_B, domSiteB);
            // restoreMap de siteB está vazio — correto, restoreMap é por capítulo
            expect(restored).toHaveLength(0);

            // Mas o GTC encontra pelo hash — a funcionalidade cross-site!
            const { hits } = await simulateGTCLookup(storageMock, [HASH_P1]);
            expect(hits).toHaveLength(1); // GTC é GLOBAL
        });
    });

    describe('Jornada 4: Capítulo parcialmente no cache', () => {
        test('páginas no GTC são restauradas instantaneamente, resto vai para Gemini', async () => {
            const HASH_P2 = 'e'.repeat(64);
            const HASH_P3 = 'f'.repeat(64);

            // Página 1 já foi traduzida
            await storageMock.set({ [`gtc_${HASH_P1}`]: TRANSLATED });

            // Páginas 2 e 3 são novas
            const { hits, misses } = await simulateGTCLookup(
                storageMock,
                [HASH_P1, HASH_P2, HASH_P3]
            );

            expect(hits.map(h => h.index)).toEqual([0]);      // Página 1 = cache
            expect(misses).toEqual([1, 2]);                    // Páginas 2 e 3 = Gemini
        });
    });

    describe('Consistência dos dados', () => {
        test('múltiplas páginas do mesmo capítulo são armazenadas independentemente', async () => {
            const pages = [
                { index: 0, url: 'https://siteA.com/pag1.jpg', hash: '0'.repeat(64), trans: 'data:T0' },
                { index: 1, url: 'https://siteA.com/pag2.jpg', hash: '1'.repeat(64), trans: 'data:T1' },
                { index: 2, url: 'https://siteA.com/pag3.jpg', hash: '2'.repeat(64), trans: 'data:T2' },
            ];

            for (const p of pages) {
                await simulateUpdateImage(storageMock, {
                    chapterId: CHAPTER_ID,
                    index: p.index,
                    origUrl: p.url,
                    origHash: p.hash,
                    translatedBase64: p.trans,
                });
            }

            const data = await storageMock.get([`${CHAPTER_ID}_images`]);
            expect(Object.keys(data[`${CHAPTER_ID}_images`])).toHaveLength(3);
            expect(data[`${CHAPTER_ID}_images`][0]).toBe('data:T0');
            expect(data[`${CHAPTER_ID}_images`][2]).toBe('data:T2');
        });
    });
});
