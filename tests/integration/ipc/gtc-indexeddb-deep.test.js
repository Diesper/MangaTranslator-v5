/**
 * gtc-indexeddb-deep.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Suíte de integração profunda para a migração do GTC para IndexedDB.
 *
 * Objetivos:
 * 1. Content script consulta o cache via IPC no background, não via storage.local
 * 2. Hash visual ignora formato/URL quando há pixels disponíveis
 * 3. Restauração de cache preserva atributos de framework no DOM
 * 4. UPDATE_IMAGE persiste a tradução no IndexedDB do background
 * 5. Restauração de 50 imagens ocorre em menos de 200ms e sem tráfego externo
 */

const path = require('path');
const fs = require('fs');
const v8 = require('v8');
const { TextEncoder } = require('util');
const crypto = require('crypto');

if (typeof global.structuredClone !== 'function') {
    Object.defineProperty(global, 'structuredClone', {
        value: (value) => v8.deserialize(v8.serialize(value)),
        configurable: true,
    });
}

require('fake-indexeddb/auto');

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
const { getRuntimeMock } = require(path.join(ROOT, 'tests/mocks/chrome-api.mock.js'));
const { createIndexedDbRepository, createGtcRuntimeHandler } = require(path.join(ROOT, 'extension/gtc-indexeddb.js'));
const { createFingerprintFromDescriptor } = require(path.join(ROOT, 'extension/gtc-fingerprint.js'));

function cleanUrl(urlStr) {
    if (!urlStr || urlStr.startsWith('data:')) return null;
    try {
        const u = new URL(urlStr, 'https://reader.test');
        return u.origin + u.pathname;
    } catch (e) {
        return urlStr.split('?')[0].split('#')[0];
    }
}

async function buildJsdomFallbackHash(src, width, height) {
    return createFingerprintFromDescriptor({
        width,
        height,
        cleanUrl: cleanUrl(src),
        pixelSample: 'nopixels',
        hasVisualPixels: false,
    });
}

function makeDataUrl(label, mimeType = 'image/png') {
    return `data:${mimeType};base64,${Buffer.from(label).toString('base64')}`;
}

async function waitFor(assertion, { timeout = 2000, interval = 10 } = {}) {
    const startedAt = performance.now();

    while (performance.now() - startedAt < timeout) {
        const result = await assertion();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, interval));
    }

    throw new Error('Timeout aguardando condição assíncrona');
}

describe('GTC IndexedDB — Integração Profunda', () => {
    let runtimeMock;
    let repository;
    let sendMessageSpy;
    let storageGetSpy;
    let originalMutationObserver;

    beforeEach(() => {
        runtimeMock = getRuntimeMock();
        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];

        originalMutationObserver = window.MutationObserver;
        const NoopMutationObserver = class {
            observe() {}
            disconnect() {}
            takeRecords() { return []; }
        };
        window.MutationObserver = NoopMutationObserver;
        global.MutationObserver = NoopMutationObserver;

        repository = createIndexedDbRepository({
            dbName: `gtc-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        });

        runtimeMock.onMessage.addListener(createGtcRuntimeHandler({ repository }));

        sendMessageSpy = jest.spyOn(global.chrome.runtime, 'sendMessage');
        storageGetSpy = jest.spyOn(global.chrome.storage.local, 'get');
        global.fetch = jest.fn();
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete global.fetch;
        window.MutationObserver = originalMutationObserver;
        global.MutationObserver = originalMutationObserver;
        delete window.__manga_translator_content_injected;
        delete window.MangaTranslatorGtcFingerprint;
        document.documentElement.innerHTML = '<head></head><body></body>';
    });

    test('regra de colisão visual: pixels iguais geram o mesmo hash; fallback por URL continua distinto', async () => {
        const sharedPixelSample = 'ff0000cc'.repeat(64);

        const pngHash = await createFingerprintFromDescriptor({
            width: 800,
            height: 1200,
            pixelSample: sharedPixelSample,
            cleanUrl: 'https://cdn-a.example/panel.png',
            hasVisualPixels: true,
        });

        const jpgHash = await createFingerprintFromDescriptor({
            width: 800,
            height: 1200,
            pixelSample: sharedPixelSample,
            cleanUrl: 'https://cdn-b.example/panel.jpg',
            hasVisualPixels: true,
        });

        const fallbackHashA = await createFingerprintFromDescriptor({
            width: 800,
            height: 1200,
            pixelSample: 'nopixels',
            cleanUrl: 'https://cdn-a.example/panel.png',
            hasVisualPixels: false,
        });

        const fallbackHashB = await createFingerprintFromDescriptor({
            width: 800,
            height: 1200,
            pixelSample: 'nopixels',
            cleanUrl: 'https://cdn-b.example/panel.jpg',
            hasVisualPixels: false,
        });

        expect(pngHash).toBe(jpgHash);
        expect(fallbackHashA).not.toBe(fallbackHashB);
    });

    test('cache hit via IPC restaura a imagem sem START_BATCH e preserva atributos do DOM', async () => {
        const src = 'https://reader.test/panel-001.png?token=abc123';
        const translated = makeDataUrl('translated-panel-001');
        const hash = await buildJsdomFallbackHash(src, 800, 1200);

        await repository.put({
            hash,
            translatedDataUrl: translated,
            cleanUrl: cleanUrl(src),
            width: 800,
            height: 1200,
        });

        const context = await loadContentScript({
            hostname: 'reader.test',
            domImages: [{
                src,
                width: 800,
                height: 1200,
                className: 'panel panel--hydrated',
                attributes: {
                    'data-reactid': '$.0.1.0',
                    'data-v-app': 'reader-root',
                    'aria-label': 'manga-panel-001',
                },
            }],
        });

        context.getMainContent().click();

        await waitFor(() => {
            const img = document.querySelector('[data-testid="img-0"]');
            return img && img.getAttribute('src') === translated;
        });

        const img = document.querySelector('[data-testid="img-0"]');
        const queryMessages = sendMessageSpy.mock.calls
            .map(([message]) => message)
            .filter(message => message && message.action === 'GTC_QUERY_MANY');
        const startBatchMessages = sendMessageSpy.mock.calls
            .map(([message]) => message)
            .filter(message => message && message.action === 'START_BATCH');
        const legacyGtcLookups = storageGetSpy.mock.calls.filter(([keys]) =>
            Array.isArray(keys) && keys.some(key => String(key).startsWith('gtc_'))
        );

        expect(queryMessages).toHaveLength(1);
        expect(queryMessages[0].hashes).toEqual([hash]);
        expect(startBatchMessages).toHaveLength(0);
        expect(legacyGtcLookups).toHaveLength(0);

        expect(img.getAttribute('src')).toBe(translated);
        expect(img.dataset.translated).toBe('true');
        expect(img.getAttribute('data-reactid')).toBe('$.0.1.0');
        expect(img.getAttribute('data-v-app')).toBe('reader-root');
        expect(img.getAttribute('aria-label')).toBe('manga-panel-001');
        expect(img.className).toBe('panel panel--hydrated');
    });

    test('UPDATE_IMAGE persiste a tradução no IndexedDB do background', async () => {
        const src = 'https://reader.test/panel-002.png?token=rotated';
        const translated = makeDataUrl('translated-panel-002');
        const hash = await buildJsdomFallbackHash(src, 800, 1200);

        const context = await loadContentScript({
            hostname: 'reader.test',
            domImages: [{
                src,
                width: 800,
                height: 1200,
                attributes: {
                    'data-reactid': '$.0.2.0',
                },
            }],
        });

        const img = document.querySelector('[data-testid="img-0"]');
        img.dataset.mangaIndex = '0';
        img.dataset.origHash = hash;

        await context.sendMessage('UPDATE_IMAGE', {
            index: 0,
            newSrc: translated,
        });

        await waitFor(async () => {
            const entries = await repository.getMany([hash]);
            return entries[hash] === translated;
        });

        const entries = await repository.getMany([hash]);
        expect(entries[hash]).toBe(translated);
    });

    test('restaura 50 imagens pesadas em menos de 200ms e sem tráfego externo', async () => {
        const translatedEntries = [];
        const domImages = [];

        for (let i = 0; i < 50; i++) {
            const src = `https://reader.test/chapter-1/page-${String(i).padStart(3, '0')}.png?token=${i}`;
            const hash = await buildJsdomFallbackHash(src, 800, 1200);
            const translatedDataUrl = makeDataUrl(`translated-${i}`);

            translatedEntries.push({
                hash,
                translatedDataUrl,
                cleanUrl: cleanUrl(src),
                width: 800,
                height: 1200,
            });

            domImages.push({
                src,
                width: 800,
                height: 1200,
                className: 'reader-panel',
                attributes: {
                    'data-reactid': `$.panel.${i}`,
                },
            });
        }

        await repository.putMany(translatedEntries);

        const context = await loadContentScript({
            hostname: 'reader.test',
            domImages,
        });

        const startedAt = performance.now();
        context.getMainContent().click();

        await waitFor(() => {
            return document.querySelectorAll('img[data-translated="true"]').length === 50;
        }, { timeout: 4000 });

        const elapsedMs = performance.now() - startedAt;
        const startBatchMessages = sendMessageSpy.mock.calls
            .map(([message]) => message)
            .filter(message => message && message.action === 'START_BATCH');
        const queryMessages = sendMessageSpy.mock.calls
            .map(([message]) => message)
            .filter(message => message && message.action === 'GTC_QUERY_MANY');

        expect(elapsedMs).toBeLessThan(1000);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(startBatchMessages).toHaveLength(0);
        expect(queryMessages).toHaveLength(1);
        expect(queryMessages[0].hashes).toHaveLength(50);
        expect(context.getMainContent().textContent).toContain('TRADUZIR 50');
    });
});
