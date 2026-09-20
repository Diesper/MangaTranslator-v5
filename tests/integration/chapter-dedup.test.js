/**
 * chapter-dedup.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Teste de integração: Deduplicação de capítulos com canonicalTitle (BUG #12).
 *
 * CENÁRIO: O usuário traduz páginas do mesmo capítulo em duas sessões distintas.
 * Entre as sessões, o título da aba pode variar ligeiramente (sufixos do site,
 * separadores diferentes, etc.). O sistema deve reconhecer que é o mesmo capítulo
 * e agrupar todas as imagens na mesma "pasta" do banco de dados.
 *
 * Testa a integração completa: canonicalTitle + _getOrCreateChapterIdImpl +
 * persistência no chrome.storage.
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

// Implementação espelho completa de getOrCreateChapterId (mesma lógica do content_manga.js v3.1)
function buildChapterSystem(chromeStorage, location) {
    let _chapterIdPromise = null;

    function canonicalTitle(t) {
        // CORREÇÃO v3.2: alinhado com extracted-functions.js
        // 1. Prefixo textual opcional + número: "Cap 5: " além de "1050 - "
        // 2. Strip de sufixo de site: "| Ler Online", " - Mangás"
        //    Garante que o mesmo capítulo visitado com sufixos diferentes
        //    (variando entre sessões) produza a mesma chave de deduplicação.
        return (t || '')
            .replace(/^(?:[A-Za-z]+\.?\s+)?\d+[\s.\-\u2013\u2014:|]+/, '')
            .replace(/\s+[-|\u2013\u2014]\s+.+$/, '')
            .replace(/[|\u2013\u2014\u2022\u00B7\[\]()\u00AB\u00BB]/g, ' ')
            .replace(/\s*[-:]\s*$/, '')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .toLowerCase()
            .slice(0, 80);
    }

    function impl() {
        return new Promise((resolve, reject) => {
            chromeStorage.get(['chapterList'], (data) => {
                if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                const list = data.chapterList || [];
                const href = location.href;
                const hostname = location.hostname;
                const titleKey = canonicalTitle(location.title || '').replace(/[^a-z0-9]/gi, '_');

                // Busca por URL exata primeiro
                let chapter = list.find(c => c.url === href);

                // Fallback: mesmo hostname + título normalizado similar
                if (!chapter) {
                    chapter = list.find(c => {
                        if (!c.url) return false;
                        try {
                            const sameHost = new URL(c.url).hostname === hostname;
                            const cKey = canonicalTitle(c.title || '').replace(/[^a-z0-9]/gi, '_');
                            return sameHost && cKey === titleKey;
                        } catch { return false; }
                    });
                    if (chapter) {
                        chapter.url = href;
                        chapter.title = canonicalTitle(location.title || '');
                        chromeStorage.set({ chapterList: list });
                    }
                }

                if (chapter) { resolve(chapter.id); return; }

                const newId = 'chap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
                list.push({ id: newId, url: href, title: canonicalTitle(location.title || ''), timestamp: Date.now() });
                chromeStorage.set({ chapterList: list }, () => {
                    if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
                    resolve(newId);
                });
            });
        });
    }

    function getOrCreate() {
        if (!_chapterIdPromise) {
            _chapterIdPromise = impl().catch(e => { _chapterIdPromise = null; throw e; });
        }
        return _chapterIdPromise;
    }

    function resetCache() { _chapterIdPromise = null; }

    return { getOrCreate, resetCache };
}

describe('Deduplicação de Capítulos — Integração (BUG #12)', () => {

    let storageMock;

    beforeEach(() => {
        storageMock = getStorageMock();
    });

    describe('Sessão única', () => {
        test('cria novo capítulo na primeira visita', async () => {
            const system = buildChapterSystem(storageMock, {
                href: 'https://manga.com/one-piece/cap-1050',
                hostname: 'manga.com',
                title: 'One Piece Capítulo 1050 | Ler Online',
            });

            const id = await system.getOrCreate();
            expect(id).toMatch(/^chap_/);

            const data = await storageMock.get(['chapterList']);
            expect(data.chapterList).toHaveLength(1);
        });

        test('reutiliza capítulo na segunda chamada (mesma URL)', async () => {
            const system = buildChapterSystem(storageMock, {
                href: 'https://manga.com/one-piece/cap-1050',
                hostname: 'manga.com',
                title: 'One Piece Capítulo 1050 | Ler Online',
            });

            const id1 = await system.getOrCreate();
            system.resetCache();
            const id2 = await system.getOrCreate();

            expect(id1).toBe(id2);

            const data = await storageMock.get(['chapterList']);
            expect(data.chapterList).toHaveLength(1);
        });
    });

    describe('Duas sessões — mesmo capítulo, títulos variando (BUG #12)', () => {
        test('Sessão 1: "One Piece Cap 1050 | Ler" → Sessão 2: "One Piece Cap 1050 - Mangás" → mesmo ID', async () => {
            // Sessão 1
            const system1 = buildChapterSystem(storageMock, {
                href: 'https://manga.com/one-piece/1050',
                hostname: 'manga.com',
                title: 'One Piece Cap 1050 | Ler',
            });
            const id1 = await system1.getOrCreate();

            // Sessão 2 — URL diferente, título similar
            const system2 = buildChapterSystem(storageMock, {
                href: 'https://manga.com/one-piece/1050?page=2',
                hostname: 'manga.com',
                title: 'One Piece Cap 1050 - Mangás',
            });
            const id2 = await system2.getOrCreate();

            // Devem ser o mesmo capítulo
            expect(id1).toBe(id2);

            const data = await storageMock.get(['chapterList']);
            expect(data.chapterList).toHaveLength(1);
        });

        test('capítulos DIFERENTES não devem ser agrupados', async () => {
            const system1050 = buildChapterSystem(storageMock, {
                href: 'https://manga.com/one-piece/1050',
                hostname: 'manga.com',
                title: 'One Piece Cap 1050',
            });

            const system1051 = buildChapterSystem(storageMock, {
                href: 'https://manga.com/one-piece/1051',
                hostname: 'manga.com',
                title: 'One Piece Cap 1051',
            });

            const id1050 = await system1050.getOrCreate();
            const id1051 = await system1051.getOrCreate();

            expect(id1050).not.toBe(id1051);
            const data = await storageMock.get(['chapterList']);
            expect(data.chapterList).toHaveLength(2);
        });

        test('obras DIFERENTES não devem ser agrupadas', async () => {
            const naruto = buildChapterSystem(storageMock, {
                href: 'https://manga.com/naruto/1',
                hostname: 'manga.com',
                title: 'Naruto Capítulo 1',
            });

            const bleach = buildChapterSystem(storageMock, {
                href: 'https://manga.com/bleach/1',
                hostname: 'manga.com',
                title: 'Bleach Capítulo 1',
            });

            const idN = await naruto.getOrCreate();
            const idB = await bleach.getOrCreate();

            expect(idN).not.toBe(idB);
        });
    });

    describe('Imagens salvas no mesmo capítulo (integração com storage)', () => {
        test('imagens de duas sessões são salvas sob o mesmo chapterId', async () => {
            // Sessão 1: traduz página 0
            const sys1 = buildChapterSystem(storageMock, {
                href: 'https://manga.com/chapter/1',
                hostname: 'manga.com',
                title: 'Test Chapter 1',
            });
            const chapId = await sys1.getOrCreate();

            // Salva imagem da sessão 1
            await storageMock.set({ [`${chapId}_images`]: { 0: 'data:image/png;base64,sess1page0' } });

            // Sessão 2: traduz página 1 (URL ligeiramente diferente, título igual)
            const sys2 = buildChapterSystem(storageMock, {
                href: 'https://manga.com/chapter/1?p=2',
                hostname: 'manga.com',
                title: 'Test Chapter 1',
            });
            const chapId2 = await sys2.getOrCreate();

            // Deve ser o mesmo capítulo
            expect(chapId2).toBe(chapId);

            // Adiciona imagem da sessão 2
            const data = await storageMock.get([`${chapId}_images`]);
            const images = data[`${chapId}_images`] || {};
            images[1] = 'data:image/png;base64,sess2page1';
            await storageMock.set({ [`${chapId}_images`]: images });

            // Verifica que ambas estão no mesmo capítulo
            const finalData = await storageMock.get([`${chapId}_images`]);
            expect(Object.keys(finalData[`${chapId}_images`])).toHaveLength(2);
        });
    });

    describe('Domínios diferentes não interferem', () => {
        test('mesmo título em domínios diferentes gera capítulos separados', async () => {
            const siteA = buildChapterSystem(storageMock, {
                href: 'https://siteA.com/chapter/1',
                hostname: 'siteA.com',
                title: 'Same Title',
            });

            const siteB = buildChapterSystem(storageMock, {
                href: 'https://siteB.com/chapter/1',
                hostname: 'siteB.com',
                title: 'Same Title',
            });

            const idA = await siteA.getOrCreate();
            const idB = await siteB.getOrCreate();

            expect(idA).not.toBe(idB);
        });
    });
});
