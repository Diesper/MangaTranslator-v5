const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { TextEncoder } = require('util');

function findRoot(dir) {
    if (fs.existsSync(path.join(dir, 'extension', 'manifest.json'))) return dir;
    const parent = path.dirname(dir);
    return parent === dir ? process.cwd() : findRoot(parent);
}

const ROOT = findRoot(__dirname);

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

describe('IPC-01/IPC-02/IPC-03: Image translation routing - GTC e IPC', () => {
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
        jest.restoreAllMocks();
        await storageMock.clear();
        delete window.__manga_translator_content_injected;
        delete window.MangaTranslatorGtcFingerprint;
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    function installRuntimeResponder({ onQueryMany, onStartBatch } = {}) {
        runtimeMock.sendMessage = jest.fn((message, callback) => {
            sentMessages.push(message);

            if (message.action === 'GTC_QUERY_MANY') {
                const response = onQueryMany ? onQueryMany(message) : { ok: true, entriesByHash: {} };
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

    test('GTC miss envia START_BATCH para o background', async () => {
        installRuntimeResponder();
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/higeki/page-1.png', width: 800, height: 1200 },
            ],
        });

        document.getElementById('manga-main-content').click();

        const startBatch = await waitFor(() => sentMessages.find(message => message.action === 'START_BATCH'));
        expect(startBatch.images).toEqual([{ index: 0 }]);
        expect(startBatch.prompt).toBe('Teste prompt');
    });

    test('GTC hit substitui a imagem e nao chama START_BATCH', async () => {
        installRuntimeResponder({
            onQueryMany(message) {
                return {
                    ok: true,
                    entriesByHash: {
                        [message.hashes[0]]: 'data:image/png;base64,TRANSLATED_HIT',
                    },
                };
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/higeki/page-1.png', width: 800, height: 1200 },
            ],
        });

        document.getElementById('manga-main-content').click();

        await waitFor(() => document.querySelector('img').dataset.translated === 'true');
        expect(document.querySelector('img').getAttribute('src')).toBe('data:image/png;base64,TRANSLATED_HIT');
        expect(sentMessages.some(message => message.action === 'START_BATCH')).toBe(false);
    });

    test('processamento em lote ignora imagem pequena e envia somente paginas validas', async () => {
        installRuntimeResponder();
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/witch/page-1.jpg', width: 800, height: 1200 },
                { src: 'http://localhost/witch/page-2.jpg', width: 800, height: 1200 },
                { src: 'http://localhost/witch/avatar.jpg', width: 50, height: 50 },
            ],
        });

        document.getElementById('manga-main-content').click();

        const startBatch = await waitFor(() => sentMessages.find(message => message.action === 'START_BATCH'));
        expect(startBatch.images).toEqual([{ index: 0 }, { index: 1 }]);
    });
});
