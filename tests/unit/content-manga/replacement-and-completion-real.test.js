const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { TextEncoder } = require('util');

function _findRoot(d) {
    if (fs.existsSync(path.join(d, 'extension', 'manifest.json'))) return d;
    const p = path.dirname(d);
    return p === d ? process.cwd() : _findRoot(p);
}
const ROOT = _findRoot(__dirname);

Object.defineProperty(global, 'crypto', {
    value: crypto.webcrypto,
    configurable: true,
});
global.TextEncoder = TextEncoder;

const { loadContentScript } = require(path.join(ROOT, 'tests/helpers/load-content-script.js'));
const { getRuntimeMock, getStorageMock } = require(path.join(ROOT, 'tests/mocks/chrome-api.mock.js'));

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(assertion, { timeout = 2500, interval = 10 } = {}) {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeout) {
        const result = await assertion();
        if (result) return result;
        await delay(interval);
    }
    throw new Error('Timeout aguardando condicao');
}

function getContentListener(runtimeMock) {
    const listeners = runtimeMock._messageListeners || [];
    if (listeners.length !== 1) {
        throw new Error(`Esperava 1 listener do content_manga, recebi ${listeners.length}`);
    }
    return listeners[0];
}

function dispatchToContent(runtimeMock, request, sender = { tab: { id: 1 } }) {
    return new Promise((resolve) => {
        let settled = false;
        let keepAlive = false;

        const sendResponse = (response) => {
            settled = true;
            resolve({ keepAlive, response });
        };

        keepAlive = getContentListener(runtimeMock)(request, sender, sendResponse);
        if (keepAlive !== true && !settled) {
            resolve({ keepAlive, response: undefined });
        }
    });
}

async function flushFakeTimers(ms = 0) {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
}

function findOverlayByColor(color) {
    return Array.from(document.body.children).find((node) => {
        return node instanceof HTMLElement
            && node !== document.getElementById('manga-translator-trigger')
            && node.style.background === color;
    });
}

describe('CM-65/CM-66/CM-67/CM-68/CM-69/CM-70/CM-71/CM-72/CM-73/CM-74/CM-82/CM-83/CM-84/CM-85/CM-86/CM-87/CM-101/CM-105/CM-106: content_manga.js - replacement e completion reais', () => {
    let runtimeMock;
    let storageMock;
    let sentMessages;

    beforeEach(async () => {
        jest.resetModules();
        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock.lastError = null;
        sentMessages = [];
        await storageMock.clear();
        delete window.__manga_translator_content_injected;
        delete window.MangaTranslatorGtcFingerprint;
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    afterEach(async () => {
        try {
            jest.useRealTimers();
        } catch (e) {}
        jest.restoreAllMocks();
        await storageMock.clear();
        delete window.__manga_translator_content_injected;
        delete window.MangaTranslatorGtcFingerprint;
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    function installRuntimeResponder({
        onQueryMany,
        onSave,
        onDownload,
        onStartBatch,
    } = {}) {
        runtimeMock.sendMessage = jest.fn((message, callback) => {
            sentMessages.push(message);

            if (message.action === 'GTC_QUERY_MANY') {
                const response = onQueryMany
                    ? onQueryMany(message)
                    : { ok: true, entriesByHash: {} };
                if (callback) setTimeout(() => callback(response), 0);
                return;
            }

            if (message.action === 'GTC_SAVE') {
                const response = onSave
                    ? onSave(message)
                    : { ok: true };
                if (callback) setTimeout(() => callback(response), 0);
                return;
            }

            if (message.action === 'DOWNLOAD_IMAGE') {
                const response = onDownload
                    ? onDownload(message)
                    : { ok: true };
                if (callback) setTimeout(() => callback(response), 0);
                return;
            }

            if (message.action === 'START_BATCH') {
                if (typeof onStartBatch === 'function') onStartBatch(message);
                if (callback) setTimeout(() => callback({ ok: true }), 0);
                return;
            }

            if (callback) setTimeout(() => callback({ ok: true }), 0);
        });
    }

    test('UPDATE_IMAGE remove sources de picture, limpa lazy attrs e desmonta o overlay vermelho apos o tempo', async () => {
        installRuntimeResponder();
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                {
                    src: 'http://localhost/page-0.png',
                    width: 800,
                    height: 1200,
                    attributes: {
                        loading: 'lazy',
                        'data-src': 'http://localhost/lazy.png',
                        'data-lazy': 'http://localhost/lazy-alt.png',
                        'data-original': 'http://localhost/original.png',
                        srcset: 'http://localhost/page-0-2x.png 2x',
                        sizes: '100vw',
                    },
                },
            ],
        });

        const originalImg = document.querySelector('[data-testid="img-0"]');
        originalImg.dataset.mangaIndex = '0';
        originalImg.dataset.origHash = 'hash-picture-0';
        originalImg.dataset.src = 'http://localhost/lazy.png';
        originalImg.dataset.lazySrc = 'http://localhost/lazy-alt.png';

        const picture = document.createElement('picture');
        const sourceWebp = document.createElement('source');
        sourceWebp.srcset = 'http://localhost/page-0.webp';
        const sourceJpg = document.createElement('source');
        sourceJpg.srcset = 'http://localhost/page-0.jpg';
        originalImg.parentNode.insertBefore(picture, originalImg);
        picture.appendChild(sourceWebp);
        picture.appendChild(sourceJpg);
        picture.appendChild(originalImg);

        const addListenerSpy = jest.spyOn(window, 'addEventListener');
        const removeListenerSpy = jest.spyOn(window, 'removeEventListener');

        jest.useFakeTimers();

        await dispatchToContent(runtimeMock, {
            action: 'UPDATE_IMAGE',
            index: 0,
            newSrc: 'data:image/png;base64,UkVQTEFDRUQ=',
        });
        await flushFakeTimers(1);

        const translatedImg = picture.querySelector('img');
        expect(picture.querySelectorAll('source')).toHaveLength(0);
        expect(translatedImg.getAttribute('src')).toBe('data:image/png;base64,UkVQTEFDRUQ=');
        expect(translatedImg.dataset.translated).toBe('true');
        expect(translatedImg.hasAttribute('loading')).toBe(false);
        expect(translatedImg.hasAttribute('data-src')).toBe(false);
        expect(translatedImg.hasAttribute('data-lazy')).toBe(false);
        expect(translatedImg.hasAttribute('data-original')).toBe(false);
        expect(translatedImg.hasAttribute('srcset')).toBe(false);
        expect(translatedImg.hasAttribute('sizes')).toBe(false);

        const redOverlay = findOverlayByColor('rgba(200, 30, 30, 0.55)');
        expect(redOverlay).toBeTruthy();
        expect(addListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });

        await flushFakeTimers(3020);

        expect(findOverlayByColor('rgba(200, 30, 30, 0.55)')).toBeUndefined();
        expect(removeListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
    });

    test('cache hit visual usa overlay verde e nao dispara START_BATCH', async () => {
        installRuntimeResponder({
            onQueryMany(message) {
                return {
                    ok: true,
                    entriesByHash: {
                        [message.hashes[0]]: 'data:image/png;base64,Q0FDSEVfR1JFRU4=',
                    },
                };
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/cache-hit-page-99.png', width: 800, height: 1200 },
            ],
        });

        document.getElementById('manga-main-content').click();
        await waitFor(() => document.querySelector('[data-testid="img-0"]').dataset.translated === 'true');

        const translatedImg = document.querySelector('[data-testid="img-0"]');
        expect(translatedImg.dataset.translated).toBe('true');
        expect(translatedImg.getAttribute('src')).toBe('data:image/png;base64,Q0FDSEVfR1JFRU4=');
        expect(sentMessages.some(message => message.action === 'START_BATCH')).toBe(false);
        expect(findOverlayByColor('rgba(76, 175, 80, 0.5)')).toBeTruthy();

        await delay(2100);
        expect(findOverlayByColor('rgba(76, 175, 80, 0.5)')).toBeUndefined();
    });

    test('UPDATE_IMAGE com autoDownload persiste paths, ultimo caminho e downloadId', async () => {
        document.title = 'Reader Download Chapter';
        installRuntimeResponder({
            onDownload() {
                return {
                    filePath: 'C:/Downloads/MangaTranslator/reader_download_chapter/pagina_000.png',
                    downloadId: 91,
                };
            },
        });
        await storageMock.set({ autoDownload: true });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        const originalImg = document.querySelector('[data-testid="img-0"]');
        originalImg.dataset.mangaIndex = '0';
        originalImg.dataset.origHash = 'hash-autodownload-0';

        await dispatchToContent(runtimeMock, {
            action: 'UPDATE_IMAGE',
            index: 0,
            newSrc: 'data:image/png;base64,RE9XTkxPQUQ=',
        });

        const storage = await waitFor(async () => {
            const data = await storageMock.get(null);
            const pathKey = Object.keys(data).find(key => key.endsWith('_paths'));
            return pathKey ? data : null;
        }, { timeout: 3000 });

        const pathKey = Object.keys(storage).find(key => key.endsWith('_paths'));
        const dlKey = Object.keys(storage).find(key => key.endsWith('_dlId'));

        expect(sentMessages).toContainEqual(expect.objectContaining({
            action: 'DOWNLOAD_IMAGE',
            filename: expect.stringContaining('pagina_000.png'),
        }));
        expect(storage[pathKey]).toEqual({
            0: 'C:/Downloads/MangaTranslator/reader_download_chapter/pagina_000.png',
        });
        expect(storage.mangaTranslatorLastPath).toBe('C:/Downloads/MangaTranslator/reader_download_chapter/pagina_000.png');
        expect(storage[dlKey]).toBe(91);
    });

    test('PROGRESS atualiza o texto do botao e a cor de fundo para laranja', async () => {
        installRuntimeResponder();
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        await dispatchToContent(runtimeMock, {
            action: 'PROGRESS',
            text: 'GEMINI PROCESSANDO...',
        });

        expect(document.getElementById('manga-main-content').textContent).toContain('GEMINI PROCESSANDO');
        expect(document.getElementById('manga-error-static-part').style.background).toBe('rgb(255, 152, 0)');
    });

    test('UPDATE_IMAGE repetido para o mesmo indice nao duplica a conclusao do batch', async () => {
        installRuntimeResponder();
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        const img = document.querySelector('[data-testid="img-0"]');
        img.dataset.origHash = 'hash-repeat-0';

        await dispatchToContent(runtimeMock, {
            action: 'START_TRANSLATION_FROM_POPUP',
            indices: [0],
        });
        await waitFor(() => sentMessages.find(message => message.action === 'START_BATCH'));

        document.querySelector('[data-testid="img-0"]').dataset.mangaIndex = '0';
        await dispatchToContent(runtimeMock, {
            action: 'UPDATE_IMAGE',
            index: 0,
            newSrc: 'data:image/png;base64,RklSU1Q=',
        });

        await waitFor(() => sentMessages.filter(message =>
            message.action === 'LOG_ENTRY' && message.action_name === 'BATCH_COMPLETE'
        ).length === 1);

        await dispatchToContent(runtimeMock, {
            action: 'UPDATE_IMAGE',
            index: 0,
            newSrc: 'data:image/png;base64,U0VDT05E',
        });
        await delay(100);

        const completionLogs = sentMessages.filter(message =>
            message.action === 'LOG_ENTRY' && message.action_name === 'BATCH_COMPLETE'
        );

        expect(completionLogs).toHaveLength(1);
        expect(document.querySelector('[data-testid="img-0"]').getAttribute('src')).toBe('data:image/png;base64,RklSU1Q=');
    });

    test('BATCH_COMPLETE em debug mode sem erros abre a drawer com mensagem positiva', async () => {
        installRuntimeResponder();
        await storageMock.set({ debugMode: true });
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        await dispatchToContent(runtimeMock, {
            action: 'START_TRANSLATION_FROM_POPUP',
            indices: [0],
        });
        await waitFor(() => sentMessages.find(message => message.action === 'START_BATCH'));

        await dispatchToContent(runtimeMock, { action: 'BATCH_COMPLETE' });
        await delay(60);

        expect(document.getElementById('manga-error-line').style.display).toBe('flex');
        expect(document.getElementById('manga-error-collapsible-content').textContent).toContain('Nenhum erro encontrado no lote.');
    });
});
