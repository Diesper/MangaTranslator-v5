/**
 * page-counter.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa o contador de páginas e a barra de leitura em tempo real do reader.js real.
 */

const { loadExtensionPage, flushAsyncTasks } = require('../../helpers/load-extension-page.js');
const { getStorageMock } = require('../../mocks/chrome-api.mock.js');

describe('RD-20/RD-21/RD-22: reader.js - Contador de Página e Progresso Real', () => {
    let storageMock;
    let observerCallbacks;

    beforeEach(async () => {
        jest.resetModules();
        storageMock = getStorageMock();
        await storageMock.clear();
        localStorage.clear();
        document.documentElement.innerHTML = '<html><head></head><body></body></html>';

        observerCallbacks = [];
        window.IntersectionObserver = jest.fn().mockImplementation((cb) => {
            observerCallbacks.push(cb);
            return {
                observe: jest.fn(),
                unobserve: jest.fn(),
                disconnect: jest.fn(),
            };
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('inicializa contador 1 / N e atualiza via callback real do IntersectionObserver', async () => {
        await storageMock.set({
            chapterList: [{ id: 'chap_count', title: 'Chapter Counter' }],
            chap_count_images: {
                0: 'data:image/png;base64,P0',
                1: 'data:image/png;base64,P1',
                2: 'data:image/png;base64,P2',
                3: 'data:image/png;base64,P3',
                4: 'data:image/png;base64,P4',
            },
        });

        await loadExtensionPage({
            htmlPath: 'extension/reader.html',
            scriptPath: 'extension/reader.js',
            url: 'https://extension.test/reader.html?id=chap_count',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(6);

        const counterEl = document.getElementById('page-counter');
        const fillEl = document.getElementById('read-progress-fill');
        const pageWraps = document.querySelectorAll('.reader-page-wrap');

        expect(pageWraps).toHaveLength(5);
        expect(counterEl.textContent).toBe('1 / 5');
        expect(fillEl.style.width).toBe('20%');
        const counterObserverCallback = observerCallbacks[0];
        expect(typeof counterObserverCallback).toBe('function');

        // Simula scroll: página 3 (índice 2) fica mais visível
        counterObserverCallback([
            { target: pageWraps[0], intersectionRatio: 0.1 },
            { target: pageWraps[2], intersectionRatio: 0.85 },
            { target: pageWraps[1], intersectionRatio: 0.3 },
        ]);

        expect(counterEl.textContent).toBe('3 / 5');
        expect(fillEl.style.width).toBe('60%');

        // Simula scroll até a última página (índice 4)
        counterObserverCallback([
            { target: pageWraps[4], intersectionRatio: 0.95 },
        ]);

        expect(counterEl.textContent).toBe('5 / 5');
        expect(fillEl.style.width).toBe('100%');
    });

    test('quando múltiplos itens têm mesmo ratio, seleciona o primeiro com ratio > maxRatio', async () => {
        await storageMock.set({
            chapterList: [{ id: 'chap_equal', title: 'Equal Ratios' }],
            chap_equal_images: {
                0: 'data:image/png;base64,P0',
                1: 'data:image/png;base64,P1',
            },
        });

        await loadExtensionPage({
            htmlPath: 'extension/reader.html',
            scriptPath: 'extension/reader.js',
            url: 'https://extension.test/reader.html?id=chap_equal',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(6);

        const counterEl = document.getElementById('page-counter');
        const pageWraps = document.querySelectorAll('.reader-page-wrap');

        counterObserverCallback([
            { target: pageWraps[0], intersectionRatio: 0.5 },
            { target: pageWraps[1], intersectionRatio: 0.5 },
        ]);

        expect(counterEl.textContent).toBe('1 / 2');
    });

    test('trata capítulo com 0 imagens exibindo 0 / 0', async () => {
        await storageMock.set({
            chapterList: [{ id: 'chap_empty', title: 'Empty' }],
            chap_empty_images: {},
        });

        await loadExtensionPage({
            htmlPath: 'extension/reader.html',
            scriptPath: 'extension/reader.js',
            url: 'https://extension.test/reader.html?id=chap_empty',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(6);

        const counterEl = document.getElementById('page-counter');
        const emptyMsg = document.getElementById('empty-msg');
        expect(counterEl.textContent).toBe('0 / 0');
        expect(emptyMsg.textContent).toContain('Nenhuma imagem salva');
    });
});
