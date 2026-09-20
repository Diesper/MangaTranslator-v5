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
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion, { timeout = 3000, interval = 20 } = {}) {
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

function defineImageMetrics(img, { width = 800, height = 1200, complete = true } = {}) {
    Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true, writable: true });
    Object.defineProperty(img, 'complete', { value: complete, configurable: true, writable: true });
}

describe('REG-04/REG-05/REG-10/CM-94/CM-95/CM-96/CM-97/CM-98/CM-107b/CM-116: content_manga.js - auto restore real', () => {
    let runtimeMock;
    let storageMock;
    let originalStorageGet;

    beforeEach(async () => {
        jest.resetModules();
        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        originalStorageGet = storageMock.get.bind(storageMock);

        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock.lastError = null;

        runtimeMock.sendMessage = jest.fn((message, callback) => {
            if (message.action === 'GTC_SAVE' && callback) {
                setTimeout(() => callback({ ok: true }), 0);
                return;
            }
            if (message.action === 'DOWNLOAD_IMAGE' && callback) {
                setTimeout(() => callback({ filePath: 'C:/tmp/page.png', downloadId: 41 }), 0);
                return;
            }
            if (callback) setTimeout(() => callback({ ok: true }), 0);
        });

        await storageMock.clear();
        delete window.__manga_translator_content_injected;
        delete window.MangaTranslatorGtcFingerprint;
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    afterEach(async () => {
        storageMock.get = originalStorageGet;
        jest.restoreAllMocks();
        await storageMock.clear();
        delete window.__manga_translator_content_injected;
        delete window.MangaTranslatorGtcFingerprint;
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    test('aplica restoreMap imediatamente na inicializacao quando a clean URL bate', async () => {
        const chapterId = 'chap_auto_restore_1';
        await storageMock.set({
            chapterList: [{
                id: chapterId,
                url: 'https://localhost/chapter/1',
                title: 'chapter_1',
            }],
            [`${chapterId}_restoreMap`]: {
                'http://localhost/page-0.png': 'data:image/png;base64,UkVTVE9SRURfT0s=',
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png?token=abc', width: 800, height: 1200 },
            ],
        });

        await waitFor(() => document.querySelector('[data-testid="img-0"]').dataset.translated === 'true');

        const img = document.querySelector('[data-testid="img-0"]');
        expect(img.getAttribute('src')).toBe('data:image/png;base64,UkVTVE9SRURfT0s=');
    });

    test('observer reaplica a traducao quando o src muda para uma clean URL conhecida', async () => {
        const chapterId = 'chap_auto_restore_2';
        await storageMock.set({
            chapterList: [{
                id: chapterId,
                url: 'https://localhost/chapter/1',
                title: 'chapter_1',
            }],
            [`${chapterId}_restoreMap`]: {
                'http://localhost/lazy-page.png': 'data:image/png;base64,UkVTVE9SRV9MQVpZ',
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/placeholder.png', width: 800, height: 1200 },
            ],
        });

        document.querySelector('[data-testid="img-0"]').setAttribute('src', 'http://localhost/lazy-page.png?cache=bypass');

        await waitFor(() => document.querySelector('[data-testid="img-0"]').dataset.translated === 'true');

        expect(document.querySelector('[data-testid="img-0"]').getAttribute('src')).toBe('data:image/png;base64,UkVTVE9SRV9MQVpZ');
    });

    test('observer restaura imagens novas adicionadas ao DOM apos a inicializacao', async () => {
        const chapterId = 'chap_auto_restore_3';
        await storageMock.set({
            chapterList: [{
                id: chapterId,
                url: 'https://localhost/chapter/1',
                title: 'chapter_1',
            }],
            [`${chapterId}_restoreMap`]: {
                'http://localhost/new-page.png': 'data:image/png;base64,TkVXX1JFU1RPUkU=',
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [],
        });

        const newImg = document.createElement('img');
        newImg.id = 'late-image';
        newImg.src = 'http://localhost/new-page.png?nonce=42';
        defineImageMetrics(newImg);
        document.body.appendChild(newImg);

        await waitFor(() => document.getElementById('late-image').dataset.translated === 'true');
        expect(document.getElementById('late-image').getAttribute('src')).toBe('data:image/png;base64,TkVXX1JFU1RPUkU=');
    });

    test('regressao REG-10: UPDATE_IMAGE antes do fim da inicializacao ainda alimenta restauracoes futuras', async () => {
        const chapterId = 'chap_auto_restore_4';
        await storageMock.set({
            chapterList: [{
                id: chapterId,
                url: 'https://localhost/chapter/1',
                title: 'chapter_1',
            }],
            [`${chapterId}_restoreMap`]: {},
        });

        storageMock.get = jest.fn((keys, callback) => {
            const shouldDelayRestoreMap = Array.isArray(keys)
                && keys.length === 1
                && keys[0] === `${chapterId}_restoreMap`;

            if (shouldDelayRestoreMap) {
                return new Promise((resolve) => {
                    setTimeout(() => {
                        originalStorageGet(keys, callback).then(resolve);
                    }, 180);
                });
            }
            return originalStorageGet(keys, callback);
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/original-page.png', width: 800, height: 1200 },
            ],
        });

        const originalImg = document.querySelector('[data-testid="img-0"]');
        originalImg.dataset.mangaIndex = '0';
        originalImg.dataset.origHash = 'hash-reg-10';

        await dispatchToContent(runtimeMock, {
            action: 'UPDATE_IMAGE',
            index: 0,
            newSrc: 'data:image/png;base64,UkVHXzEwX09L',
        });

        await waitFor(async () => {
            const data = await storageMock.get([`${chapterId}_restoreMap`]);
            return data[`${chapterId}_restoreMap`]
                && data[`${chapterId}_restoreMap`]['http://localhost/original-page.png'];
        });

        const futureImg = document.createElement('img');
        futureImg.id = 'future-restore-image';
        futureImg.src = 'http://localhost/original-page.png?late=1';
        defineImageMetrics(futureImg);
        document.body.appendChild(futureImg);

        await waitFor(() => document.getElementById('future-restore-image').dataset.translated === 'true', { timeout: 4000 });
        expect(document.getElementById('future-restore-image').getAttribute('src')).toBe('data:image/png;base64,UkVHXzEwX09L');
    });

    test('autoRestoreEnabled=false impede substituicao automatica global', async () => {
        const chapterId = 'chap_auto_restore_global_off';
        await storageMock.set({
            autoRestoreEnabled: false,
            chapterList: [{
                id: chapterId,
                url: 'https://localhost/chapter/1',
                title: 'chapter_1',
            }],
            [`${chapterId}_restoreMap`]: {
                'http://localhost/page-0.png': 'data:image/png;base64,TkFPTUFJUw==',
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png?token=abc', width: 800, height: 1200 },
            ],
        });

        await delay(250);
        const img = document.querySelector('[data-testid="img-0"]');
        expect(img.dataset.translated).not.toBe('true');
        expect(img.getAttribute('src')).toBe('http://localhost/page-0.png?token=abc');
    });

    test('autoRestoreDisabledSites impede auto-substituicao so no site bloqueado', async () => {
        const chapterId = 'chap_auto_restore_site_off';
        await storageMock.set({
            autoRestoreDisabledSites: ['localhost'],
            chapterList: [{
                id: chapterId,
                url: 'https://localhost/chapter/1',
                title: 'chapter_1',
            }],
            [`${chapterId}_restoreMap`]: {
                'http://localhost/page-0.png': 'data:image/png;base64,U0lURV9PRkY=',
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png?token=abc', width: 800, height: 1200 },
            ],
        });

        await delay(250);
        const img = document.querySelector('[data-testid="img-0"]');
        expect(img.dataset.translated).not.toBe('true');
        expect(img.getAttribute('src')).toBe('http://localhost/page-0.png?token=abc');
    });

    test('autoRestoreBlockedImages bloqueia imagem especifica sem bloquear traducao manual', async () => {
        const chapterId = 'chap_auto_restore_image_off';
        await storageMock.set({
            autoRestoreBlockedImages: {
                'http://localhost/page-0.png': {
                    cleanUrl: 'http://localhost/page-0.png',
                    host: 'localhost',
                },
            },
            chapterList: [{
                id: chapterId,
                url: 'https://localhost/chapter/1',
                title: 'chapter_1',
            }],
            [`${chapterId}_restoreMap`]: {
                'http://localhost/page-0.png': 'data:image/png;base64,QkxPQ0tFRA==',
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png?token=abc', width: 800, height: 1200 },
            ],
        });

        await delay(250);
        const img = document.querySelector('[data-testid="img-0"]');
        expect(img.dataset.translated).not.toBe('true');
        expect(img.getAttribute('src')).toBe('http://localhost/page-0.png?token=abc');

        img.dataset.mangaIndex = '0';
        img.dataset.origHash = 'hash-manual-exception';
        await dispatchToContent(runtimeMock, {
            action: 'UPDATE_IMAGE',
            index: 0,
            newSrc: 'data:image/png;base64,TUFOVUFMX09L',
        });

        expect(document.querySelector('[data-testid="img-0"]').dataset.translated).toBe('true');
        expect(document.querySelector('[data-testid="img-0"]').getAttribute('src')).toBe('data:image/png;base64,TUFOVUFMX09L');
    });

    test('visual-v4 Solucao A: preview.redd.it restaura pela chave canonica i.redd.it', async () => {
        const chapterId = 'chap_auto_restore_reddit_preview';
        await storageMock.set({
            chapterList: [{
                id: chapterId,
                url: 'https://localhost/chapter/1',
                title: 'chapter_1',
            }],
            [`${chapterId}_restoreMap`]: {
                'https://i.redd.it/7g1u3dqswqyg1.png': 'data:image/png;base64,UkVERElUX09L',
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                {
                    src: 'https://preview.redd.it/why-dont-eritreans-7g1u3dqswqyg1.png?width=640&crop=smart&auto=webp&s=token',
                    width: 800,
                    height: 1200,
                },
            ],
        });

        await waitFor(() => document.querySelector('[data-testid="img-0"]').dataset.translated === 'true');

        expect(document.querySelector('[data-testid="img-0"]').getAttribute('src')).toBe('data:image/png;base64,UkVERElUX09L');
    });

    test('visual-v4 Solucao A: imgur remove sufixo de tamanho antes do restoreMap', async () => {
        const chapterId = 'chap_auto_restore_imgur_suffix';
        await storageMock.set({
            chapterList: [{
                id: chapterId,
                url: 'https://localhost/chapter/1',
                title: 'chapter_1',
            }],
            [`${chapterId}_restoreMap`]: {
                'https://i.imgur.com/abc1234.jpg': 'data:image/png;base64,SU1HVVJfT0s=',
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'https://i.imgur.com/abc1234m.jpg?width=320&q=80', width: 800, height: 1200 },
            ],
        });

        await waitFor(() => document.querySelector('[data-testid="img-0"]').dataset.translated === 'true');

        expect(document.querySelector('[data-testid="img-0"]').getAttribute('src')).toBe('data:image/png;base64,SU1HVVJfT0s=');
    });

    test('GET_PAGE_IMAGES retorna lista vazia quando todas as imagens validas estao banidas', async () => {
        const banned = [
            'http://localhost/page-0.png',
            'http://localhost/page-1.png',
            'http://localhost/page-2.png',
        ];

        const context = await loadContentScript({
            hostname: 'localhost',
            bannedImages: banned,
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                { src: 'http://localhost/page-1.png', width: 800, height: 1200 },
                { src: 'http://localhost/page-2.png', width: 800, height: 1200 },
            ],
        });

        const response = await context.sendMessage('GET_PAGE_IMAGES');
        expect(response).toEqual({
            images: [],
            total: 0,
        });
    });

    test('UPDATE_IMAGE para indice inexistente nao quebra e nao cria estado de capitulo', async () => {
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });

        await dispatchToContent(runtimeMock, {
            action: 'UPDATE_IMAGE',
            index: 99,
            newSrc: 'data:image/png;base64,SU5FWElTVEVOVEU=',
        });

        await delay(100);
        const data = await storageMock.get(null);
        const chapterImageKey = Object.keys(data).find((key) => key.endsWith('_images'));
        expect(chapterImageKey).toBeUndefined();
        expect(document.querySelector('[data-testid="img-0"]').dataset.translated).not.toBe('true');
    });
});
