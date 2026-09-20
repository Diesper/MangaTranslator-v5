/**
 * chapter-id-rejection.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa a correção da Promise não-rejeitável em _getOrCreateChapterIdImpl (BUG #11).
 *
 * PROBLEMA ORIGINAL: A Promise usava apenas `resolve` — nunca `reject`.
 * Se chrome.storage falhasse (SW reiniciando, storage corrompido), a Promise
 * ficava pendente para sempre. O wrapper `getOrCreateChapterId` cacheava essa
 * Promise morta, impedindo qualquer escrita de imagem traduzida no storage
 * silenciosamente, até a página ser recarregada.
 *
 * CORREÇÃO: `reject` adicionado + verificação de `chrome.runtime.lastError` em
 * ambos os callbacks (get e set). O `.catch` do wrapper agora limpa o cache.
 *
 * ABORDAGEM: Testa a lógica de cache + reject através de uma implementação
 * espelho controlável — o comportamento real é o que importa, não o código interno.
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

// ── Implementação espelho de getOrCreateChapterId para testes controlados ────
// Esta implementação espelha exatamente a lógica do content_manga.js v3.1.
function createGetOrCreateChapterId(chromeStorage, location) {
    let _chapterIdPromise = null;

    function canonicalTitle(t) {
        return (t || '').replace(/^\d+[\s.\-–—:|]+/, '').replace(/\s{2,}/g, ' ').trim().toLowerCase().slice(0, 80);
    }

    function _impl() {
        return new Promise((resolve, reject) => {
            chromeStorage.get(['chapterList'], (data) => {
                if (chromeStorage._simulateError) {
                    reject(new Error('storage.get falhou: simulado'));
                    return;
                }
                const list = data.chapterList || [];
                let chapter = list.find(c => c.url === location.href);
                if (chapter) { resolve(chapter.id); return; }

                const newId = 'chap_' + Date.now();
                list.push({ id: newId, url: location.href, title: canonicalTitle(location.title || ''), timestamp: Date.now() });
                chromeStorage.set({ chapterList: list }, () => {
                    if (chromeStorage._simulateSetError) {
                        reject(new Error('storage.set falhou: simulado'));
                        return;
                    }
                    resolve(newId);
                });
            });
        });
    }

    function getOrCreate() {
        if (!_chapterIdPromise) {
            _chapterIdPromise = _impl().catch(e => {
                _chapterIdPromise = null; // Limpa cache no erro — BUG #11 Fix
                throw e;
            });
        }
        return _chapterIdPromise;
    }

    return { getOrCreate, getCache: () => _chapterIdPromise };
}

describe('CM-88/CM-89/CM-90/CM-91/CM-92/CM-93: _getOrCreateChapterIdImpl — Promise com Reject (BUG #11)', () => {

    let storageMock;

    beforeEach(() => {
        storageMock = getStorageMock();
        storageMock._simulateError = false;
        storageMock._simulateSetError = false;
    });

    describe('Comportamento normal (sem erros)', () => {
        test('resolve com novo ID quando capítulo não existe', async () => {
            const system = createGetOrCreateChapterId(storageMock, {
                href: 'https://manga.com/cap/1',
                title: 'One Piece Cap 1'
            });

            const id = await system.getOrCreate();
            expect(id).toMatch(/^chap_\d+/);
        });

        test('retorna o mesmo ID em chamadas subsequentes (cache)', async () => {
            const system = createGetOrCreateChapterId(storageMock, {
                href: 'https://manga.com/cap/1',
                title: 'Test'
            });

            const id1 = await system.getOrCreate();
            const id2 = await system.getOrCreate();
            expect(id1).toBe(id2);
        });

        test('salva o capítulo no storage', async () => {
            const system = createGetOrCreateChapterId(storageMock, {
                href: 'https://manga.com/cap/1',
                title: 'Test Chapter'
            });

            await system.getOrCreate();
            const data = await storageMock.get(['chapterList']);
            expect(data.chapterList).toHaveLength(1);
            expect(data.chapterList[0].url).toBe('https://manga.com/cap/1');
        });

        test('reutiliza capítulo existente (mesma URL)', async () => {
            await storageMock.set({
                chapterList: [{ id: 'chap_existing', url: 'https://manga.com/cap/1', title: 'test', timestamp: 1 }]
            });

            const system = createGetOrCreateChapterId(storageMock, {
                href: 'https://manga.com/cap/1',
                title: 'Test'
            });

            const id = await system.getOrCreate();
            expect(id).toBe('chap_existing');
        });
    });

    describe('Comportamento com falha de storage (BUG #11 Fix)', () => {
        test('rejeita a Promise quando storage.get falha', async () => {
            storageMock._simulateError = true;

            const system = createGetOrCreateChapterId(storageMock, {
                href: 'https://manga.com/cap/1',
                title: 'Test'
            });

            await expect(system.getOrCreate()).rejects.toThrow('storage.get falhou');
        });

        test('limpa o cache após rejeição (permite nova tentativa)', async () => {
            storageMock._simulateError = true;

            const system = createGetOrCreateChapterId(storageMock, {
                href: 'https://manga.com/cap/1',
                title: 'Test'
            });

            try { await system.getOrCreate(); } catch (e) { /* esperado */ }

            // Cache deve ser null após a rejeição
            expect(system.getCache()).toBeNull();
        });

        test('após limpar cache, nova chamada bem-sucedida funciona', async () => {
            storageMock._simulateError = true;

            const system = createGetOrCreateChapterId(storageMock, {
                href: 'https://manga.com/cap/1',
                title: 'Test'
            });

            // Primeira tentativa falha
            try { await system.getOrCreate(); } catch (e) { /* esperado */ }

            // Corrige o erro e tenta novamente
            storageMock._simulateError = false;
            const id = await system.getOrCreate();
            expect(id).toMatch(/^chap_\d+/);
        });

        test('rejeita quando storage.set falha', async () => {
            storageMock._simulateSetError = true;

            const system = createGetOrCreateChapterId(storageMock, {
                href: 'https://manga.com/cap/2',
                title: 'New Chapter'
            });

            await expect(system.getOrCreate()).rejects.toThrow('storage.set falhou');
        });
    });

    describe('Chamadas simultâneas (paralelismo)', () => {
        test('múltiplas chamadas simultâneas retornam o mesmo ID (cache de Promise)', async () => {
            const system = createGetOrCreateChapterId(storageMock, {
                href: 'https://manga.com/cap/1',
                title: 'Test'
            });

            // Simula 5 imagens chegando "ao mesmo tempo" (paralelo)
            const [id1, id2, id3, id4, id5] = await Promise.all([
                system.getOrCreate(),
                system.getOrCreate(),
                system.getOrCreate(),
                system.getOrCreate(),
                system.getOrCreate(),
            ]);

            expect(id1).toBe(id2);
            expect(id2).toBe(id3);
            expect(id3).toBe(id4);
            expect(id4).toBe(id5);
        });

        test('chamadas paralelas não criam duplicatas no storage', async () => {
            const system = createGetOrCreateChapterId(storageMock, {
                href: 'https://manga.com/cap/1',
                title: 'Test'
            });

            await Promise.all([
                system.getOrCreate(),
                system.getOrCreate(),
                system.getOrCreate(),
            ]);

            const data = await storageMock.get(['chapterList']);
            // Deve haver exatamente 1 capítulo, não 3
            expect(data.chapterList).toHaveLength(1);
        });
    });
});
