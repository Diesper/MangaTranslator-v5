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

const CONTENT_MANGA_PATH = path.join(ROOT, 'extension/content_manga.js');
const CM_GTC_CLIENT_PATH = path.join(ROOT, 'extension/cm-gtc-client.js');
const CM_DOM_REPLACE_PATH = path.join(ROOT, 'extension/cm-dom-replace.js');
const { loadContentScript } = require(path.join(ROOT, 'tests/helpers/load-content-script.js'));
const { getRuntimeMock, getStorageMock } = require(path.join(ROOT, 'tests/mocks/chrome-api.mock.js'));

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(assertion, { timeout = 2000, interval = 10 } = {}) {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeout) {
        const result = await assertion();
        if (result) return result;
        await delay(interval);
    }
    throw new Error('Timeout aguardando condicao');
}

function setWindowLocation(hostname, pathname = '/chapter/1') {
    Object.defineProperty(window, 'location', {
        value: {
            hostname,
            href: `https://${hostname}${pathname}`,
            pathname,
            origin: `https://${hostname}`,
        },
        configurable: true,
        writable: true,
    });
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

function defineImageState(img, {
    src = 'https://lh3.googleusercontent.com/generated.png',
    width = 800,
    height = 1200,
    complete = true,
} = {}) {
    img.src = src;
    img.scrollIntoView = jest.fn();
    Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true, writable: true });
    Object.defineProperty(img, 'complete', { value: complete, configurable: true, writable: true });
}

describe('CM-21/CM-22/CM-23/CM-24/CM-25/CM-26/CM-27/CM-28/CM-99/CM-100/CM-102/CM-103/CM-104/CM-107/CM-108/CM-109/CM-110/CM-111/CM-112/CM-113/CM-114/CM-115: content_manga.js - modo extracao e handlers reais', () => {
    let runtimeMock;
    let storageMock;
    let originalRuntimeSendMessage;
    let originalGetContext;

    beforeEach(async () => {
        jest.resetModules();

        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        originalRuntimeSendMessage = runtimeMock.sendMessage;
        originalGetContext = window.HTMLCanvasElement.prototype.getContext;

        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock.lastError = null;

        await storageMock.clear();
        delete window.__manga_translator_content_injected;
        delete window.MangaTranslatorGtcFingerprint;
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    afterEach(async () => {
        runtimeMock.sendMessage = originalRuntimeSendMessage;
        Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
            value: originalGetContext,
            configurable: true,
            writable: true,
        });
        jest.restoreAllMocks();
        await storageMock.clear();
        delete window.__manga_translator_content_injected;
        delete window.MangaTranslatorGtcFingerprint;
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    async function loadExtractionScript({
        extractionResponse = { isExtractionTab: true, mangaTabId: 77, index: 3, geminiTabId: 999 },
        fetchFallbackResponse = { dataUrl: 'data:image/png;base64,RkFMTEJBQ0s=' },
        buildDom,
    } = {}) {
        setWindowLocation('lh3.googleusercontent.com', '/proxy/result');
        if (typeof buildDom === 'function') buildDom();

        const sentMessages = [];
        runtimeMock.sendMessage = jest.fn((message, callback) => {
            sentMessages.push(message);

            if (message.action === 'CHECK_IF_EXTRACTION_TAB') {
                if (callback) setTimeout(() => callback(extractionResponse), 0);
                return;
            }

            if (message.action === 'FETCH_IMAGE_AS_BASE64') {
                const response = typeof fetchFallbackResponse === 'function'
                    ? fetchFallbackResponse(message)
                    : fetchFallbackResponse;
                if (callback) setTimeout(() => callback(response), 0);
                return;
            }

            if (callback) setTimeout(() => callback(undefined), 0);
        });

        jest.isolateModules(() => {
            require(CM_GTC_CLIENT_PATH);
            require(CM_DOM_REPLACE_PATH);
            require(CONTENT_MANGA_PATH);
        });

        await delay(0);
        await delay(0);
        return sentMessages;
    }

    describe('modo extracao em googleusercontent', () => {
        test('envia IMAGE_READY_FROM_NEW_TAB imediatamente quando a imagem ja esta carregada', async () => {
            const sentMessages = await loadExtractionScript({
                buildDom: () => {
                    const img = document.createElement('img');
                    defineImageState(img, { complete: true, height: 900 });
                    document.body.appendChild(img);
                },
            });

            await waitFor(() => sentMessages.find(message => message.action === 'IMAGE_READY_FROM_NEW_TAB'));

            expect(sentMessages).toContainEqual(expect.objectContaining({
                action: 'CHECK_IF_EXTRACTION_TAB',
            }));
            expect(sentMessages).toContainEqual(expect.objectContaining({
                action: 'IMAGE_READY_FROM_NEW_TAB',
                mangaTabId: 77,
                index: 3,
                geminiTabId: 999,
                src: 'data:image/png;base64,TEST_CANVAS',
            }));
        });

        test('nao inicia extracao quando CHECK_IF_EXTRACTION_TAB retorna falso', async () => {
            const sentMessages = await loadExtractionScript({
                extractionResponse: { isExtractionTab: false },
                buildDom: () => {
                    const img = document.createElement('img');
                    defineImageState(img, { complete: true, height: 900 });
                    document.body.appendChild(img);
                },
            });

            await delay(50);

            expect(sentMessages.filter(message => message.action === 'IMAGE_READY_FROM_NEW_TAB')).toHaveLength(0);
            expect(sentMessages.filter(message => message.action === 'FETCH_IMAGE_AS_BASE64')).toHaveLength(0);
        });

        test('aguarda o evento load quando a imagem ainda esta carregando', async () => {
            let img;
            const sentMessages = await loadExtractionScript({
                buildDom: () => {
                    img = document.createElement('img');
                    defineImageState(img, { complete: false, height: 0 });
                    document.body.appendChild(img);
                },
            });

            expect(sentMessages.filter(message => message.action === 'IMAGE_READY_FROM_NEW_TAB')).toHaveLength(0);

            Object.defineProperty(img, 'naturalHeight', { value: 1200, configurable: true, writable: true });
            Object.defineProperty(img, 'complete', { value: true, configurable: true, writable: true });
            img.dispatchEvent(new Event('load'));

            await waitFor(() => sentMessages.find(message => message.action === 'IMAGE_READY_FROM_NEW_TAB'));

            expect(sentMessages.filter(message => message.action === 'IMAGE_READY_FROM_NEW_TAB')).toHaveLength(1);
        });

        test('faz fallback para FETCH_IMAGE_AS_BASE64 quando o canvas falha na aba de extracao', async () => {
            Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
                value: jest.fn(() => ({
                    drawImage: () => { throw new DOMException('Canvas blocked', 'SecurityError'); },
                })),
                configurable: true,
                writable: true,
            });

            const sentMessages = await loadExtractionScript({
                fetchFallbackResponse: { dataUrl: 'data:image/png;base64,RkFMTEJBQ0tfT0s=' },
                buildDom: () => {
                    const img = document.createElement('img');
                    defineImageState(img, { complete: true, height: 900 });
                    document.body.appendChild(img);
                },
            });

            await waitFor(() => sentMessages.find(message => message.action === 'IMAGE_READY_FROM_NEW_TAB'));

            expect(sentMessages).toContainEqual(expect.objectContaining({
                action: 'FETCH_IMAGE_AS_BASE64',
                url: 'https://lh3.googleusercontent.com/generated.png',
            }));
            expect(sentMessages).toContainEqual(expect.objectContaining({
                action: 'IMAGE_READY_FROM_NEW_TAB',
                src: 'data:image/png;base64,RkFMTEJBQ0tfT0s=',
            }));
        });

        test('repete a cadeia da aba auxiliar após falha transitória antes de entregar a imagem', async () => {
            Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
                value: jest.fn(() => ({
                    drawImage: () => { throw new DOMException('Canvas blocked', 'SecurityError'); },
                })),
                configurable: true,
                writable: true,
            });
            let fetchCalls = 0;
            const sentMessages = await loadExtractionScript({
                fetchFallbackResponse: () => {
                    fetchCalls += 1;
                    return fetchCalls > 1
                        ? { dataUrl: 'data:image/png;base64,UkVDVVBFUkFETw==' }
                        : { error: 'Failed to fetch' };
                },
                buildDom: () => {
                    const img = document.createElement('img');
                    defineImageState(img, { complete: true, height: 900 });
                    document.body.appendChild(img);
                },
            });

            await waitFor(() => sentMessages.find(message => message.action === 'IMAGE_READY_FROM_NEW_TAB'), { timeout: 3000 });

            expect(fetchCalls).toBeGreaterThan(1);
            expect(sentMessages).toContainEqual(expect.objectContaining({
                action: 'IMAGE_READY_FROM_NEW_TAB',
                src: 'data:image/png;base64,UkVDVVBFUkFETw==',
            }));
        });
    });

    describe('handlers onMessage reais', () => {
        test('UPDATE_IMAGE substitui a imagem, salva estado do capitulo e envia GTC_SAVE', async () => {
            const sentMessages = [];
            await loadContentScript({
                hostname: 'localhost',
                domImages: [
                    { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                ],
            });

            const originalImg = document.querySelector('[data-testid="img-0"]');
            originalImg.dataset.mangaIndex = '0';
            originalImg.dataset.origHash = 'abc123hash';

            runtimeMock.sendMessage = jest.fn((message, callback) => {
                sentMessages.push(message);
                if (message.action === 'GTC_SAVE' && callback) {
                    setTimeout(() => callback({ ok: true }), 0);
                    return;
                }
                if (message.action === 'LOG_ENTRY' && callback) {
                    setTimeout(() => callback({ ok: true }), 0);
                    return;
                }
                if (callback) setTimeout(() => callback({ ok: true }), 0);
            });

            await dispatchToContent(runtimeMock, {
                action: 'UPDATE_IMAGE',
                index: 0,
                newSrc: 'data:image/png;base64,VFJBTlNMQVRFRA==',
            });

            await waitFor(async () => {
                const data = await storageMock.get(null);
                return Object.keys(data).some(key => key.endsWith('_images'));
            }, { timeout: 3000 });

            const updatedImg = document.querySelector('[data-testid="img-0"]');
            const data = await storageMock.get(null);
            const imageKey = Object.keys(data).find(key => key.endsWith('_images'));
            const restoreKey = Object.keys(data).find(key => key.endsWith('_restoreMap'));

            expect(updatedImg.getAttribute('src')).toBe('data:image/png;base64,VFJBTlNMQVRFRA==');
            expect(updatedImg.dataset.translated).toBe('true');
            expect(data[imageKey]).toEqual({ 0: 'data:image/png;base64,VFJBTlNMQVRFRA==' });
            expect(data[restoreKey]).toEqual({ 'http://localhost/page-0.png': 'data:image/png;base64,VFJBTlNMQVRFRA==' });
            expect(sentMessages).toContainEqual(expect.objectContaining({
                action: 'GTC_SAVE',
                hash: 'abc123hash',
                translatedDataUrl: 'data:image/png;base64,VFJBTlNMQVRFRA==',
                cleanUrl: 'http://localhost/page-0.png',
            }));
        });

        test('GET_PAGE_IMAGES exclui banidas, pequenas e ja traduzidas', async () => {
            const context = await loadContentScript({
                hostname: 'localhost',
                bannedImages: ['http://localhost/page-1.png'],
                domImages: [
                    { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                    { src: 'http://localhost/page-1.png', width: 800, height: 1200 },
                    { src: 'http://localhost/page-2.png', width: 800, height: 1200 },
                    { src: 'http://localhost/page-3.png', width: 120, height: 120 },
                ],
            });

            document.querySelector('[data-testid="img-2"]').dataset.translated = 'true';

            const response = await context.sendMessage('GET_PAGE_IMAGES');

            expect(response).toEqual({
                images: [
                    {
                        index: 0,
                        src: 'http://localhost/page-0.png',
                        width: 800,
                        height: 1200,
                    },
                ],
                total: 1,
            });
        });

        test('REQUEST_IMAGE_DATA devolve base64 direto quando o canvas funciona', async () => {
            await loadContentScript({
                hostname: 'localhost',
                domImages: [
                    { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                ],
            });

            document.querySelector('[data-testid="img-0"]').dataset.mangaIndex = '0';
            const result = await dispatchToContent(runtimeMock, { action: 'REQUEST_IMAGE_DATA', index: 0 });

            expect(result.keepAlive).toBe(false);
            expect(result.response).toEqual({
                srcData: 'data:image/png;base64,TEST_CANVAS',
            });
        });

        test('REQUEST_IMAGE_DATA usa FETCH_IMAGE_AS_BASE64 quando o canvas sofre bloqueio CORS', async () => {
            Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
                value: jest.fn(() => ({
                    drawImage: () => { throw new DOMException('Canvas blocked', 'SecurityError'); },
                })),
                configurable: true,
                writable: true,
            });

            await loadContentScript({
                hostname: 'localhost',
                domImages: [
                    { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                ],
            });

            document.querySelector('[data-testid="img-0"]').dataset.mangaIndex = '0';
            runtimeMock.sendMessage = jest.fn((message, callback) => {
                if (message.action === 'FETCH_IMAGE_AS_BASE64' && callback) {
                    setTimeout(() => callback({ dataUrl: 'data:image/png;base64,RkVUQ0hFRF9PSw==' }), 0);
                }
            });

            const result = await dispatchToContent(runtimeMock, { action: 'REQUEST_IMAGE_DATA', index: 0 });
            await waitFor(() => result.response);

            expect(result.keepAlive).toBe(true);
            expect(runtimeMock.sendMessage).toHaveBeenCalledWith(
                { action: 'FETCH_IMAGE_AS_BASE64', url: 'http://localhost/page-0.png' },
                expect.any(Function)
            );
            expect(result.response).toEqual({
                srcData: 'data:image/png;base64,RkVUQ0hFRF9PSw==',
            });
        });

        test('REQUEST_IMAGE_DATA responde erro quando a imagem nao existe no DOM', async () => {
            await loadContentScript({
                hostname: 'localhost',
                domImages: [
                    { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                ],
            });

            const result = await dispatchToContent(runtimeMock, { action: 'REQUEST_IMAGE_DATA', index: 99 });

            expect(result.keepAlive).toBe(false);
            expect(result.response).toEqual({
                error: 'Image not found',
            });
        });

        test('START_TRANSLATION_FROM_POPUP usa os indices recebidos e dispara START_BATCH', async () => {
            const sendMessageSpy = jest.spyOn(global.chrome.runtime, 'sendMessage');
            const context = await loadContentScript({
                hostname: 'localhost',
                domImages: [
                    { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                    { src: 'http://localhost/page-1.png', width: 800, height: 1200 },
                    { src: 'http://localhost/page-2.png', width: 800, height: 1200 },
                ],
            });

            await context.sendMessage('START_TRANSLATION_FROM_POPUP', { indices: [0, 2] });

            await waitFor(() => sendMessageSpy.mock.calls.some(([message]) =>
                message && message.action === 'START_BATCH'
            ), { timeout: 3000 });

            expect(sendMessageSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'START_BATCH',
                    images: [{ index: 0 }, { index: 2 }],
                    prompt: 'Teste prompt',
                }),
                expect.any(Function)
            );
        });

        test('BATCH_COMPLETE força a conclusao do lote e restaura o texto do botao', async () => {
            const context = await loadContentScript({
                hostname: 'localhost',
                domImages: [
                    { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                ],
            });

            runtimeMock.sendMessage = jest.fn((message, callback) => {
                if (message.action === 'GTC_QUERY_MANY' && callback) {
                    setTimeout(() => callback({ ok: true, entriesByHash: {} }), 0);
                    return;
                }
                if (message.action === 'START_BATCH' && callback) {
                    setTimeout(() => callback({ ok: true }), 0);
                    return;
                }
                if (message.action === 'LOG_ENTRY' && callback) {
                    setTimeout(() => callback({ ok: true }), 0);
                    return;
                }
                if (callback) setTimeout(() => callback({ ok: true }), 0);
            });

            await context.sendMessage('START_TRANSLATION_FROM_POPUP', { indices: [0] });
            await waitFor(() => context.getMainContent().textContent.includes('TRADUZINDO'), { timeout: 3000 });

            await dispatchToContent(runtimeMock, { action: 'BATCH_COMPLETE' });

            await waitFor(() => context.getMainContent().textContent.includes('TRADUZIR 1 PÁGINA'), { timeout: 3000 });
            expect(document.body.textContent).toContain('Tradução Concluída!');
        });

        test('SHOW_ERROR_INTEGRATED abre a gaveta de erro e marca o botao com erro pendente', async () => {
            await loadContentScript({
                hostname: 'localhost',
                domImages: [
                    { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                ],
            });

            const btn = document.getElementById('manga-translator-trigger');
            const errorLine = document.getElementById('manga-error-line');
            const content = document.getElementById('manga-error-collapsible-content');

            await dispatchToContent(runtimeMock, {
                action: 'SHOW_ERROR_INTEGRATED',
                errorMsg: 'Falha ao processar a imagem',
                imgIndex: 7,
                isDebug: false,
            });

            expect(errorLine.style.display).toBe('flex');
            expect(btn.dataset.hasError).toBe('true');
            expect(btn.dataset.collapsed).toBe('false');
            expect(content.textContent).toContain('IMAGEM 7');
            expect(content.textContent).toContain('Falha ao processar a imagem');
        });

        test('HIGHLIGHT_IMAGE aplica destaque e depois remove o destaque ao desmarcar', async () => {
            await loadContentScript({
                hostname: 'localhost',
                domImages: [
                    { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                ],
            });

            const img = document.querySelector('[data-testid="img-0"]');
            img.dataset.mangaIndex = '0';
            window.scrollTo.mockClear();

            const onResult = await dispatchToContent(runtimeMock, {
                action: 'HIGHLIGHT_IMAGE',
                index: 0,
                highlight: true,
            });

            expect(onResult.response).toEqual({ success: true });
            expect(img.style.outline).toContain('4px solid');
            expect(window.scrollTo).toHaveBeenCalled();

            await dispatchToContent(runtimeMock, {
                action: 'HIGHLIGHT_IMAGE',
                index: 0,
                highlight: false,
            });

            await delay(450);

            expect(img.style.outline).toBe('');
            expect(img.style.boxShadow).toBe('');
            expect(img.style.transition).toBe('');
        });
    });
});

