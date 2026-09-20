/**
 * chapter-id-cache.test.js — STUB ORIGINAL (v3.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa o comportamento básico de cache de getOrCreateChapterId().
 *
 * POR QUE ESTE ARQUIVO EXISTE JUNTO COM chapter-id-rejection.test.js?
 * Este stub cobre apenas o "happy path": a Promise é cacheada e reutilizada.
 * A versão rejection (v3.1) adicionou o teste do caso de FALHA — quando
 * o storage falha, a Promise deve ser rejeitada E o cache deve ser limpo
 * para permitir nova tentativa (BUG #11 Fix).
 *
 * O código original (v3.0) NUNCA rejeitava. Se chrome.storage.get falhasse,
 * a Promise ficava pendente para sempre. O cache armazenava essa Promise
 * morta, silenciosamente bloqueando toda escrita de imagem traduzida.
 *
 * VEJA: chapter-id-rejection.test.js para o teste de BUG #11.
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

describe('getOrCreateChapterId() — Cache de Promise (stub v3.0)', () => {
    let storageMock;

    beforeEach(() => {
        storageMock = getStorageMock();
    });

    function createSystem(storageMock, location) {
        let _cache = null;

        function impl() {
            return new Promise((resolve) => {
                storageMock.get(['chapterList'], (data) => {
                    const list = data.chapterList || [];
                    let chapter = list.find(c => c.url === location.href);
                    if (chapter) { resolve(chapter.id); return; }

                    const newId = 'chap_' + Date.now();
                    list.push({ id: newId, url: location.href, title: location.title || '' });
                    storageMock.set({ chapterList: list }, () => resolve(newId));
                });
            });
        }

        return {
            getOrCreate() {
                if (!_cache) _cache = impl();
                return _cache;
            }
        };
    }

    test('cria novo capítulo na primeira chamada', async () => {
        const sys = createSystem(storageMock, { href: 'https://manga.com/1', title: 'Test' });
        const id = await sys.getOrCreate();
        expect(id).toMatch(/^chap_/);
    });

    test('reutiliza Promise cacheada em chamadas subsequentes', async () => {
        const sys = createSystem(storageMock, { href: 'https://manga.com/1', title: 'Test' });
        const id1 = await sys.getOrCreate();
        const id2 = await sys.getOrCreate();
        expect(id1).toBe(id2);
    });

    test('chamadas paralelas não criam capítulos duplicados', async () => {
        const sys = createSystem(storageMock, { href: 'https://manga.com/1', title: 'Test' });
        const [a, b, c] = await Promise.all([
            sys.getOrCreate(), sys.getOrCreate(), sys.getOrCreate()
        ]);
        expect(a).toBe(b);
        expect(b).toBe(c);

        const data = await storageMock.get(['chapterList']);
        expect(data.chapterList).toHaveLength(1);
    });
});
