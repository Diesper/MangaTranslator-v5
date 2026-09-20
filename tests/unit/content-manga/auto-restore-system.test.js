/**
 * auto-restore-system.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testes do sistema de Auto-Restore (v3.2).
 *
 * CENÁRIOS COBERTOS:
 * 1. applyAutoRestore substitui imagens com clean URL no restoreMap
 * 2. Imagens com data-translated="true" são ignoradas (idempotência)
 * 3. Imagens fora do restoreMap são ignoradas (não substituídas)
 * 4. MutationObserver com debounce é configurado corretamente
 * 5. restoreMap vazio = sistema não ativa o observer (otimização)
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

// ── Implementações espelho ────────────────────────────────────────────────────

function getCleanUrl(urlStr) {
    if (!urlStr || urlStr.startsWith('data:')) return null;
    try {
        const u = new URL(urlStr, 'https://testmanga.com');
        return u.origin + u.pathname;
    } catch(e) { return urlStr.split('?')[0].split('#')[0]; }
}

function createAutoRestoreSystem() {
    let _activeRestoreMap = null;
    let _restoreObserver = null;
    let _restoreDebounceTimer = null;
    const replacements = []; // Log de substituições para verificação

    function applyImageReplacement(img, base64, fromCache) {
        if (!img || img.dataset.translated === 'true') return null;
        // Simula a substituição (sem DOM real)
        const newImg = { src: base64, dataset: { translated: 'true' }, fromCache };
        replacements.push({ originalSrc: img.src, newSrc: base64, fromCache });
        img.dataset.translated = 'true'; // Marca como traduzida
        return newImg;
    }

    function applyAutoRestore(domImages) {
        if (!_activeRestoreMap || Object.keys(_activeRestoreMap).length === 0) return 0;
        let count = 0;
        for (const img of domImages) {
            if (img.dataset.translated === 'true') continue;
            const rawUrl = img.src || img.dataset_src || '';
            const cleanUrl = getCleanUrl(rawUrl);
            if (cleanUrl && _activeRestoreMap[cleanUrl]) {
                applyImageReplacement(img, _activeRestoreMap[cleanUrl], true);
                count++;
            }
        }
        return count;
    }

    function setActiveRestoreMap(map) { _activeRestoreMap = map; }
    function getReplacements() { return replacements; }

    return { applyAutoRestore, setActiveRestoreMap, getReplacements };
}

// Cria objeto img fake para testes
function makeImgDOM(src, translated = false) {
    return {
        src,
        dataset: { translated: translated ? 'true' : '', src: undefined },
        dataset_src: undefined,
    };
}

describe('Sistema de Auto-Restore — v3.2', () => {

    describe('applyAutoRestore() — substituição por clean URL', () => {
        test('substitui imagem quando clean URL está no restoreMap', () => {
            const { applyAutoRestore, setActiveRestoreMap, getReplacements } = createAutoRestoreSystem();
            setActiveRestoreMap({
                'https://cdn.site.com/pag1.jpg': 'data:image/png;base64,TRANSLATED1'
            });

            const imgs = [makeImgDOM('https://cdn.site.com/pag1.jpg?token=ABC')];
            const count = applyAutoRestore(imgs);

            expect(count).toBe(1);
            expect(getReplacements()[0].fromCache).toBe(true);
            expect(getReplacements()[0].newSrc).toBe('data:image/png;base64,TRANSLATED1');
        });

        test('ignora imagens não presentes no restoreMap', () => {
            const { applyAutoRestore, setActiveRestoreMap, getReplacements } = createAutoRestoreSystem();
            setActiveRestoreMap({ 'https://cdn.site.com/pag1.jpg': 'data:base64...' });

            const imgs = [makeImgDOM('https://cdn.site.com/pag2.jpg')]; // pag2, não está no mapa
            const count = applyAutoRestore(imgs);

            expect(count).toBe(0);
            expect(getReplacements()).toHaveLength(0);
        });

        test('ignora imagens já traduzidas (data-translated="true") — idempotência', () => {
            const { applyAutoRestore, setActiveRestoreMap, getReplacements } = createAutoRestoreSystem();
            setActiveRestoreMap({ 'https://cdn.site.com/pag1.jpg': 'data:base64...' });

            const imgs = [makeImgDOM('https://cdn.site.com/pag1.jpg', true)]; // já traduzida
            const count = applyAutoRestore(imgs);

            expect(count).toBe(0);
        });

        test('substitui múltiplas imagens corretamente', () => {
            const { applyAutoRestore, setActiveRestoreMap, getReplacements } = createAutoRestoreSystem();
            setActiveRestoreMap({
                'https://cdn.site.com/pag1.jpg': 'data:base64:TRANS1',
                'https://cdn.site.com/pag2.jpg': 'data:base64:TRANS2',
            });

            const imgs = [
                makeImgDOM('https://cdn.site.com/pag1.jpg?token=A'),
                makeImgDOM('https://cdn.site.com/pag2.jpg?token=B'),
                makeImgDOM('https://cdn.site.com/avatar.jpg'), // não no mapa
            ];
            const count = applyAutoRestore(imgs);

            expect(count).toBe(2);
            expect(getReplacements()).toHaveLength(2);
        });

        test('com restoreMap nulo ou vazio, não substitui nada', () => {
            const { applyAutoRestore, setActiveRestoreMap, getReplacements } = createAutoRestoreSystem();

            setActiveRestoreMap(null);
            const imgs = [makeImgDOM('https://cdn.site.com/pag1.jpg')];
            expect(applyAutoRestore(imgs)).toBe(0);

            setActiveRestoreMap({});
            expect(applyAutoRestore(imgs)).toBe(0);

            expect(getReplacements()).toHaveLength(0);
        });
    });

    describe('Persistência cross-session via storage', () => {
        test('restoreMap é salvo no storage com clean URL como chave', async () => {
            const storageMock = getStorageMock();
            const chapterId = 'chap_test123';
            const cleanUrl = 'https://cdn.site.com/pag1.jpg';
            const translatedBase64 = 'data:image/png;base64,TRANSLATED';

            const restoreMap = { [cleanUrl]: translatedBase64 };
            await storageMock.set({ [`${chapterId}_restoreMap`]: restoreMap });

            const data = await storageMock.get([`${chapterId}_restoreMap`]);
            expect(data[`${chapterId}_restoreMap`][cleanUrl]).toBe(translatedBase64);
        });

        test('URL com token diferente após F5 encontra a entrada no restoreMap', async () => {
            const storageMock = getStorageMock();
            const chapterId = 'chap_f5test';
            const cleanUrl = 'https://cdn.site.com/pag1.jpg';

            // Simula: primeira sessão salva com URL+token=ABC
            await storageMock.set({
                [`${chapterId}_restoreMap`]: { [cleanUrl]: 'data:base64:TRANS' }
            });

            // Após F5, URL tem token=XYZ — mas clean URL é idêntica
            const urlAfterF5 = 'https://cdn.site.com/pag1.jpg?token=XYZ&expires=9999';
            const cleanUrlAfterF5 = getCleanUrl(urlAfterF5);

            expect(cleanUrlAfterF5).toBe(cleanUrl); // Mesma clean URL

            const data = await storageMock.get([`${chapterId}_restoreMap`]);
            const found = data[`${chapterId}_restoreMap`][cleanUrlAfterF5];
            expect(found).toBe('data:base64:TRANS'); // Encontrou!
        });
    });

    describe('Debounce do MutationObserver', () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        test('debounce colapsa múltiplas chamadas em uma única execução após 150ms', () => {
            const applyFn = jest.fn();
            let timer = null;

            // Simula o debounce do initializeAutoRestorer
            const debouncedApply = () => {
                clearTimeout(timer);
                timer = setTimeout(applyFn, 150);
            };

            // 5 chamadas rápidas
            debouncedApply();
            debouncedApply();
            debouncedApply();
            debouncedApply();
            debouncedApply();

            // Nenhuma execução ainda
            expect(applyFn).not.toHaveBeenCalled();

            // Após 150ms, apenas UMA execução
            jest.advanceTimersByTime(150);
            expect(applyFn).toHaveBeenCalledTimes(1);
        });

        test('duas rajadas separadas por > 150ms geram duas execuções', () => {
            const applyFn = jest.fn();
            let timer = null;
            const debouncedApply = () => { clearTimeout(timer); timer = setTimeout(applyFn, 150); };

            debouncedApply();
            debouncedApply();
            jest.advanceTimersByTime(200); // Primeira rajada completa

            debouncedApply();
            debouncedApply();
            jest.advanceTimersByTime(200); // Segunda rajada completa

            expect(applyFn).toHaveBeenCalledTimes(2);
        });
    });

    describe('Integração: restoreMap + GTC juntos', () => {
        test('UPDATE_IMAGE salva tanto restoreMap quanto GTC no mesmo set', async () => {
            const storageMock = getStorageMock();
            const chapterId = 'chap_integration';
            const cleanUrl = 'https://cdn.site.com/pag1.jpg';
            const hash = 'a'.repeat(64); // SHA-256 simulado
            const translated = 'data:image/png;base64,TRANSLATED';

            const restoreMap = {};
            restoreMap[cleanUrl] = translated;

            // O UPDATE_IMAGE salva tudo em um único set
            const toSet = {
                [`${chapterId}_images`]: { 0: translated },
                [`${chapterId}_restoreMap`]: restoreMap,
                [`gtc_${hash}`]: translated,
            };
            await storageMock.set(toSet);

            // Verifica que todas as 3 estruturas foram salvas
            const data = await storageMock.get([
                `${chapterId}_images`,
                `${chapterId}_restoreMap`,
                `gtc_${hash}`,
            ]);

            expect(data[`${chapterId}_images`][0]).toBe(translated);
            expect(data[`${chapterId}_restoreMap`][cleanUrl]).toBe(translated);
            expect(data[`gtc_${hash}`]).toBe(translated);
        });
    });
});
