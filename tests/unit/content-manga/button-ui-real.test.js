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

async function waitFor(assertion, { timeout = 2000, interval = 10 } = {}) {
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

function defineButtonMetrics(btn) {
    Object.defineProperty(btn, 'offsetWidth', {
        get: () => parseFloat(btn.style.width) || 220,
        configurable: true,
    });
    Object.defineProperty(btn, 'offsetHeight', {
        get: () => parseFloat(btn.style.height) || 48,
        configurable: true,
    });
    btn.getBoundingClientRect = () => ({
        left: parseFloat(btn.style.left) || 0,
        top: parseFloat(btn.style.top) || 0,
        width: parseFloat(btn.style.width) || 220,
        height: parseFloat(btn.style.height) || 48,
        right: (parseFloat(btn.style.left) || 0) + (parseFloat(btn.style.width) || 220),
        bottom: (parseFloat(btn.style.top) || 0) + (parseFloat(btn.style.height) || 48),
    });
}

describe('CM-29/CM-30/CM-31/CM-32/CM-33/CM-34/CM-35/CM-36/CM-37/CM-38/CM-39/CM-40/CM-41/CM-42/CM-43/CM-44/CM-45/CM-46/CM-47/CM-48/CM-49/CM-50: content_manga.js - botao e interacoes reais', () => {
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
        jest.restoreAllMocks();
        await storageMock.clear();
        delete window.__manga_translator_content_injected;
        delete window.MangaTranslatorGtcFingerprint;
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    test('createTranslatorButton cria style, botao e os 8 handles de resize', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        expect(document.getElementById('manga-error-style')).toBeTruthy();
        expect(document.getElementById('manga-translator-trigger')).toBeTruthy();
        expect(document.querySelectorAll('.manga-rsz')).toHaveLength(8);
        expect(document.getElementById('manga-error-drawer-container').style.bottom).toBe('100%');
    });

    test('ENABLE_PAGE e idempotente e nao duplica o botao', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        expect(document.querySelectorAll('#manga-translator-trigger')).toHaveLength(1);

        const result = await dispatchToContent(runtimeMock, { action: 'ENABLE_PAGE' });

        expect(result.response).toEqual({ success: true });
        expect(document.querySelectorAll('#manga-translator-trigger')).toHaveLength(1);
    });

    test('aplica btnPos salvo no storage quando a pagina inicializa', async () => {
        await storageMock.set({
            btnPos: {
                top: '33px',
                left: '44px',
                width: '260px',
                height: '72px',
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        const btn = document.getElementById('manga-translator-trigger');
        expect(btn.style.top).toBe('33px');
        expect(btn.style.left).toBe('44px');
        expect(btn.style.width).toBe('260px');
        expect(btn.style.height).toBe('72px');
    });

    test('limita altura salva exagerada do botao flutuante e impede texto quebrando em coluna', async () => {
        await storageMock.set({
            btnPos: {
                top: '10px',
                left: '20px',
                width: '90px',
                height: '1200px',
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        const btn = document.getElementById('manga-translator-trigger');
        const mainContent = document.getElementById('manga-main-content');
        expect(btn.style.height).toBe('96px');
        expect(mainContent.style.whiteSpace).toBe('nowrap');
        expect(mainContent.style.textOverflow).toBe('ellipsis');
        expect(mainContent.innerHTML).toContain('TRADUZIR PÁGINAS');
    });

    test('SET_SELECTED_IMAGES atualiza o texto do botao para a contagem recebida', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                { src: 'http://localhost/page-1.png', width: 800, height: 1200 },
            ],
        });

        const result = await dispatchToContent(runtimeMock, {
            action: 'SET_SELECTED_IMAGES',
            indices: [0, 1],
        });

        expect(result.response).toEqual({ success: true });
        expect(document.getElementById('manga-main-content').textContent).toContain('TRADUZIR 2 PÁGINAS');
    });

    test('drag do botao move a posicao e persiste btnPos no storage', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        const btn = document.getElementById('manga-translator-trigger');
        const mainContent = document.getElementById('manga-main-content');
        defineButtonMetrics(btn);

        mainContent.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
            clientX: 10,
            clientY: 20,
        }));

        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: 60,
            clientY: 90,
        }));

        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        await waitFor(async () => {
            const data = await storageMock.get(['btnPos']);
            return data.btnPos && data.btnPos.left === '50px';
        });

        const data = await storageMock.get(['btnPos']);
        expect(btn.style.left).toBe('50px');
        expect(btn.style.top).toBe('70px');
        expect(data.btnPos).toEqual({
            top: '70px',
            left: '50px',
            width: '220px',
            height: '',
        });
    });

    test('movimento de ate 2px nao persiste btnPos no storage', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        const btn = document.getElementById('manga-translator-trigger');
        const mainContent = document.getElementById('manga-main-content');
        defineButtonMetrics(btn);

        mainContent.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
            clientX: 10,
            clientY: 10,
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: 11,
            clientY: 12,
        }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        await delay(50);

        const data = await storageMock.get(['btnPos']);
        expect(data.btnPos).toBeUndefined();
    });

    test('clique apos arrastar mais de 5px nao inicia traducao', async () => {
        const sendMessageSpy = jest.spyOn(global.chrome.runtime, 'sendMessage');
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        const btn = document.getElementById('manga-translator-trigger');
        const mainContent = document.getElementById('manga-main-content');
        defineButtonMetrics(btn);

        mainContent.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
            clientX: 10,
            clientY: 10,
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: 40,
            clientY: 40,
        }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        mainContent.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            clientX: 40,
            clientY: 40,
        }));

        await delay(100);

        expect(sendMessageSpy.mock.calls.some(([message]) =>
            message && message.action === 'START_BATCH'
        )).toBe(false);
    });

    test('resize east aumenta a largura e respeita a largura minima', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        const btn = document.getElementById('manga-translator-trigger');
        btn.style.left = '0px';
        btn.style.top = '0px';
        btn.style.width = '220px';
        btn.style.height = '48px';
        defineButtonMetrics(btn);

        const eastHandle = document.querySelector('.manga-rsz[data-dir="e"]');

        eastHandle.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
            clientX: 100,
            clientY: 10,
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: 150,
            clientY: 10,
        }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        expect(btn.style.width).toBe('270px');

        eastHandle.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
            clientX: 150,
            clientY: 10,
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: -500,
            clientY: 10,
        }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        expect(parseFloat(btn.style.width)).toBe(130);
    });

    test('resize west reduz largura e desloca left para compensar', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        const btn = document.getElementById('manga-translator-trigger');
        btn.style.left = '100px';
        btn.style.top = '0px';
        btn.style.width = '220px';
        btn.style.height = '48px';
        defineButtonMetrics(btn);

        const westHandle = document.querySelector('.manga-rsz[data-dir="w"]');

        westHandle.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
            clientX: 100,
            clientY: 10,
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: 130,
            clientY: 10,
        }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        expect(btn.style.width).toBe('190px');
        expect(btn.style.left).toBe('130px');
    });

    test('resize south respeita altura minima de 48px e diagonal se altera largura e altura', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        const btn = document.getElementById('manga-translator-trigger');
        btn.style.left = '0px';
        btn.style.top = '0px';
        btn.style.width = '220px';
        btn.style.height = '48px';
        defineButtonMetrics(btn);

        const southHandle = document.querySelector('.manga-rsz[data-dir="s"]');
        southHandle.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
            clientX: 20,
            clientY: 48,
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: 20,
            clientY: -500,
        }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        expect(parseFloat(btn.style.height)).toBe(48);

        const seHandle = document.querySelector('.manga-rsz[data-dir="se"]');
        seHandle.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
            clientX: 220,
            clientY: 48,
        }));
        document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true,
            clientX: 260,
            clientY: 88,
        }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

        expect(btn.style.width).toBe('260px');
        expect(btn.style.height).toBe('88px');
    });
});
