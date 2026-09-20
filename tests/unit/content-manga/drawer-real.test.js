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

describe('CM-55/CM-56/CM-57/CM-58/CM-59/CM-60/CM-61/CM-62/CM-63/CM-64: content_manga.js - drawer de erro real', () => {
    let runtimeMock;
    let storageMock;

    beforeEach(async () => {
        jest.resetModules();
        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock.lastError = null;
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

    test('SHOW_ERROR_INTEGRATED exibe a linha de erro e marca erro pendente', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        await dispatchToContent(runtimeMock, {
            action: 'SHOW_ERROR_INTEGRATED',
            errorMsg: 'Falha no OCR',
            imgIndex: 7,
            isDebug: false,
        });

        const btn = document.getElementById('manga-translator-trigger');
        const errorLine = document.getElementById('manga-error-line');
        const content = document.getElementById('manga-error-collapsible-content');

        expect(errorLine.style.display).toBe('flex');
        expect(btn.dataset.hasError).toBe('true');
        expect(btn.dataset.collapsed).toBe('false');
        expect(content.textContent).toContain('ERRO');
        expect(content.textContent).toContain('IMAGEM 7');
        expect(content.textContent).toContain('Falha no OCR');
    });

    test('colapsar erro inicia countdown e esconde a linha ao final de 30s', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });
        await dispatchToContent(runtimeMock, {
            action: 'SHOW_ERROR_INTEGRATED',
            errorMsg: 'Erro de teste',
            imgIndex: 2,
            isDebug: false,
        });

        jest.useFakeTimers();

        const btn = document.getElementById('manga-translator-trigger');
        const errorLine = document.getElementById('manga-error-line');
        const label = errorLine.querySelector('span:first-child');

        errorLine.click();
        await flushFakeTimers(1);

        expect(btn.dataset.collapsed).toBe('true');
        expect(label.innerText).toBe('FECHANDO EM 30S');

        await flushFakeTimers(30000);

        expect(errorLine.style.display).toBe('none');
        expect(btn.dataset.hasError).toBe('false');
        expect(label.innerText).toBe('🚨 VER ÚLTIMO ERRO');
    });

    test('expandir novamente cancela o countdown de fechamento', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });
        await dispatchToContent(runtimeMock, {
            action: 'SHOW_ERROR_INTEGRATED',
            errorMsg: 'Erro persistente',
            imgIndex: 3,
            isDebug: false,
        });

        jest.useFakeTimers();

        const btn = document.getElementById('manga-translator-trigger');
        const errorLine = document.getElementById('manga-error-line');
        const label = errorLine.querySelector('span:first-child');

        errorLine.click();
        await flushFakeTimers(1);
        expect(label.innerText).toBe('FECHANDO EM 30S');

        await flushFakeTimers(5000);
        errorLine.click();
        await flushFakeTimers(1);

        expect(btn.dataset.collapsed).toBe('false');
        expect(label.innerText).toBe('🚨 VER ÚLTIMO ERRO');

        await flushFakeTimers(40000);
        expect(errorLine.style.display).toBe('flex');
        expect(btn.dataset.hasError).toBe('true');
    });

    test('DEBUG_MODE_CHANGED abre e fecha a drawer quando nao ha erro pendente', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        await dispatchToContent(runtimeMock, { action: 'DEBUG_MODE_CHANGED', debugOn: true });

        const btn = document.getElementById('manga-translator-trigger');
        const errorLine = document.getElementById('manga-error-line');
        const content = document.getElementById('manga-error-collapsible-content');

        expect(errorLine.style.display).toBe('flex');
        expect(btn.dataset.collapsed).toBe('false');
        expect(content.textContent).toContain('DEBUG MODE ATIVO');

        await dispatchToContent(runtimeMock, { action: 'DEBUG_MODE_CHANGED', debugOn: false });

        expect(errorLine.style.display).toBe('none');
        expect(btn.dataset.collapsed).toBe('true');
    });

    test('DEBUG_MODE_CHANGED false preserva a linha de erro quando existe erro pendente', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });
        await dispatchToContent(runtimeMock, {
            action: 'SHOW_ERROR_INTEGRATED',
            errorMsg: 'Erro retido',
            imgIndex: 4,
            isDebug: false,
        });

        const btn = document.getElementById('manga-translator-trigger');
        const errorLine = document.getElementById('manga-error-line');

        await dispatchToContent(runtimeMock, { action: 'DEBUG_MODE_CHANGED', debugOn: false });

        expect(btn.dataset.hasError).toBe('true');
        expect(errorLine.style.display).toBe('flex');
    });
});
