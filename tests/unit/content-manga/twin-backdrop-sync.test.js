/**
 * twin-backdrop-sync.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa a detecção de backdrops desfocados (Reddit, lightboxes ambientais)
 * e a sincronização automática (Twin Backdrop Sync) no content_manga.js.
 */

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
        const sendResponse = (response) => {
            settled = true;
            resolve(response);
        };
        const keepAlive = getContentListener(runtimeMock)(request, sender, sendResponse);
        if (keepAlive !== true && !settled) {
            resolve(undefined);
        }
    });
}

describe('Twin Backdrop Sync — content_manga.js', () => {
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

    test('filtra backdrop gêmeo com aria-hidden mantendo apenas a imagem nítida principal', async () => {
        const imageUrl = 'https://preview.redd.it/chapter1.png?width=1080';

        await loadContentScript({
            hostname: 'reddit.com',
            enabledDomains: ['reddit.com'],
            domImages: [
                {
                    src: imageUrl,
                    width: 1080,
                    height: 1920,
                    className: 'shreddit-aspect-ratio__blur',
                    attributes: { 'aria-hidden': 'true', id: 'bg-img' },
                },
                {
                    src: imageUrl,
                    width: 1080,
                    height: 1920,
                    attributes: { id: 'sharp-img' },
                },
            ],
        });

        const response = await dispatchToContent(runtimeMock, { action: 'GET_PAGE_IMAGES' });

        // Deve retornar apenas 1 imagem candidata (a imagem nítida) e não duplicar com o backdrop
        expect(response).toBeDefined();
        expect(response.images).toHaveLength(1);
        expect(response.images[0].src).toBe(imageUrl);
    });

    test('sincroniza o backdrop gêmeo ao aplicar a tradução na imagem principal', async () => {
        const imageUrl = 'https://i.redd.it/page1.png';
        const translatedBase64 = 'data:image/png;base64,TRANSLATED_PAGE_DATA';

        await loadContentScript({
            hostname: 'reddit.com',
            enabledDomains: ['reddit.com'],
            domImages: [
                {
                    src: imageUrl,
                    width: 800,
                    height: 1200,
                    className: 'shreddit-aspect-ratio__blur',
                    attributes: { 'aria-hidden': 'true', id: 'twin-backdrop' },
                },
                {
                    src: imageUrl,
                    width: 800,
                    height: 1200,
                    attributes: { id: 'primary-sharp', 'data-manga-index': '0' },
                },
            ],
        });

        const backdropImg = document.getElementById('twin-backdrop');

        // Envia comando para atualizar a imagem traduzida
        await dispatchToContent(runtimeMock, {
            action: 'UPDATE_IMAGE',
            index: 0,
            newSrc: translatedBase64,
        });

        // Verifica que o backdrop gêmeo foi sincronizado simultaneamente
        expect(backdropImg.src).toBe(translatedBase64);
        expect(backdropImg.dataset.translated).toBe('true');
        expect(backdropImg.style.pointerEvents).toBe('none');

        // A imagem principal clonada e substituída também deve conter a tradução
        const replacedPrimary = document.querySelector('img[data-translated="true"]:not(#twin-backdrop)');
        expect(replacedPrimary).not.toBeNull();
        expect(replacedPrimary.src).toBe(translatedBase64);
    });
});
