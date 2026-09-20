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

describe('CM-14/CM-15/CM-16/CM-17/CM-18/CM-19/CM-20/CM-51/CM-52/CM-53/CM-54/CM-75/CM-76/CM-77/CM-78/CM-79/CM-80/CM-81: content_manga.js - extractAndSendImages real', () => {
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

    function installRuntimeResponder({
        onQueryMany,
        onQueryDHash,
        onQueryPerceptual,
        onQueryPerceptualCrop,
        onQueryPerceptualRelaxed,
        onCalculateVisualFingerprint,
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

            if (message.action === 'GTC_QUERY_BY_DHASH') {
                const response = onQueryDHash
                    ? onQueryDHash(message)
                    : { ok: true, entriesByDHash: {} };
                if (callback) setTimeout(() => callback(response), 0);
                return;
            }

            if (message.action === 'GTC_QUERY_BY_PERCEPTUAL') {
                const response = onQueryPerceptual
                    ? onQueryPerceptual(message)
                    : { ok: true, entriesByPerceptual: {} };
                if (callback) setTimeout(() => callback(response), 0);
                return;
            }

            if (message.action === 'GTC_QUERY_BY_PERCEPTUAL_CROP') {
                const response = onQueryPerceptualCrop
                    ? onQueryPerceptualCrop(message)
                    : { ok: true, entriesByPerceptualCrop: {} };
                if (callback) setTimeout(() => callback(response), 0);
                return;
            }

            if (message.action === 'GTC_QUERY_BY_PERCEPTUAL_RELAXED') {
                const response = onQueryPerceptualRelaxed
                    ? onQueryPerceptualRelaxed(message)
                    : { ok: true, entriesByPerceptualRelaxed: {} };
                if (callback) setTimeout(() => callback(response), 0);
                return;
            }

            if (message.action === 'CALCULATE_VISUAL_FINGERPRINT') {
                const response = onCalculateVisualFingerprint
                    ? onCalculateVisualFingerprint(message)
                    : { ok: false, error: 'sem mock de fingerprint visual' };
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

    test('auto-selecao exclui banidas e pequenas e envia START_BATCH apenas com indices validos', async () => {
        installRuntimeResponder();
        await loadContentScript({
            hostname: 'localhost',
            bannedImages: ['http://localhost/page-1.png'],
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                { src: 'http://localhost/page-1.png', width: 800, height: 1200 },
                { src: 'http://localhost/page-2.png', width: 120, height: 180 },
                { src: 'http://localhost/page-3.png', width: 900, height: 1300 },
            ],
        });

        document.getElementById('manga-main-content').click();

        const startBatch = await waitFor(() => sentMessages.find(message => message.action === 'START_BATCH'));

        expect(startBatch.images).toEqual([{ index: 0 }, { index: 3 }]);
        expect(startBatch.prompt).toBe('Teste prompt');
        await waitFor(() => document.getElementById('manga-main-content').textContent.includes('TRADUZINDO'));
    });

    test('quando storage nao tem prompts envia START_BATCH com prompt vazio', async () => {
        installRuntimeResponder();
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
            ],
        });
        await storageMock.remove(['customPrompt', 'defaultPrompt']);

        document.getElementById('manga-main-content').click();

        const startBatch = await waitFor(() => sentMessages.find(message => message.action === 'START_BATCH'));
        expect(startBatch.images).toEqual([{ index: 0 }]);
        expect(startBatch.prompt).toBe('');
    });

    test('em contexto sem crypto ainda gera batchId e inicia o lote', async () => {
        const globalCryptoDescriptor = Object.getOwnPropertyDescriptor(global, 'crypto');
        const windowCryptoDescriptor = Object.getOwnPropertyDescriptor(window, 'crypto');
        Object.defineProperty(global, 'crypto', { value: undefined, configurable: true });
        Object.defineProperty(window, 'crypto', { value: undefined, configurable: true });
        try {
            installRuntimeResponder();
            await loadContentScript({
                hostname: 'localhost',
                domImages: [{ src: 'http://localhost/page-0.png', width: 800, height: 1200 }],
            });

            document.getElementById('manga-main-content').click();

            const startBatch = await waitFor(() => sentMessages.find(message => message.action === 'START_BATCH'));
            expect(startBatch.batchId).toMatch(/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
        } finally {
            if (globalCryptoDescriptor) Object.defineProperty(global, 'crypto', globalCryptoDescriptor);
            else delete global.crypto;
            if (windowCryptoDescriptor) Object.defineProperty(window, 'crypto', windowCryptoDescriptor);
            else delete window.crypto;
        }
    });

    test('quando nao ha paginas validas mostra toast e nao envia START_BATCH', async () => {
        installRuntimeResponder();
        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/small-0.png', width: 32, height: 32 },
                { src: 'http://localhost/small-1.png', width: 120, height: 180 },
            ],
        });

        document.getElementById('manga-main-content').click();

        await waitFor(() => document.body.textContent.includes('Nenhuma página de mangá detectada ou selecionada.'));
        expect(sentMessages.some(message => message.action === 'START_BATCH')).toBe(false);
    });

    test('quando o lote inteiro vem do cache aplica as imagens e nao abre START_BATCH', async () => {
        installRuntimeResponder({
            onQueryMany(message) {
                return {
                    ok: true,
                    entriesByHash: Object.fromEntries(
                        message.hashes.map((hash, index) => [hash, `data:image/png;base64,Q0FDSEVf${index}`])
                    ),
                };
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'http://localhost/page-0.png', width: 800, height: 1200 },
                { src: 'http://localhost/page-1.png', width: 800, height: 1200 },
            ],
        });

        document.getElementById('manga-main-content').click();

        await waitFor(() => {
            const translated = Array.from(document.querySelectorAll('img')).filter(img => img.dataset.translated === 'true');
            return translated.length === 2;
        });

        const translatedImages = Array.from(document.querySelectorAll('img'));
        expect(translatedImages[0].getAttribute('src')).toBe('data:image/png;base64,Q0FDSEVf0');
        expect(translatedImages[1].getAttribute('src')).toBe('data:image/png;base64,Q0FDSEVf1');
        expect(sentMessages.some(message => message.action === 'START_BATCH')).toBe(false);
        expect(document.getElementById('manga-main-content').textContent).toContain('TRADUZIR 2 PÁGINAS');
    });

    test('visual-v4: hit center-crop aplica cache depois de SHA/dHash/perceptual strict miss', async () => {
        const cropDataUrl = 'data:image/png;base64,Q1JPUF9ISVQ=';
        installRuntimeResponder({
            onCalculateVisualFingerprint() {
                return {
                    ok: true,
                    pixelSample: 'ab'.repeat(256),
                    dHash: 'd'.repeat(16),
                    wHash: 'a'.repeat(64),
                    pHash: 'b'.repeat(64),
                    wHashCrop: 'c'.repeat(64),
                    pHashCrop: 'e'.repeat(64),
                    regionalHashes: {
                        topLeft: '0'.repeat(16),
                        topRight: '1'.repeat(16),
                        bottomLeft: '2'.repeat(16),
                        bottomRight: '3'.repeat(16),
                    },
                };
            },
            onQueryPerceptualCrop(message) {
                const key = `${message.wHashesCrop[0]}:${message.pHashesCrop[0]}`;
                return {
                    ok: true,
                    entriesByPerceptualCrop: {
                        [key]: {
                            translatedDataUrl: cropDataUrl,
                            confidence: 1,
                            reason: 'crop_test',
                            wDist: 0,
                            pDist: 0,
                        },
                    },
                };
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'https://cdn.remote.test/page-0.png', width: 800, height: 1200 },
            ],
        });

        document.getElementById('manga-main-content').click();

        await waitFor(() => document.querySelector('[data-testid="img-0"]').dataset.translated === 'true');

        expect(document.querySelector('[data-testid="img-0"]').getAttribute('src')).toBe(cropDataUrl);
        expect(sentMessages.map(message => message.action)).toEqual(expect.arrayContaining([
            'CALCULATE_VISUAL_FINGERPRINT',
            'GTC_QUERY_MANY',
            'GTC_QUERY_BY_DHASH',
            'GTC_QUERY_BY_PERCEPTUAL',
            'GTC_QUERY_BY_PERCEPTUAL_CROP',
        ]));
        expect(sentMessages.some(message => message.action === 'GTC_QUERY_BY_PERCEPTUAL_RELAXED')).toBe(false);
        expect(sentMessages.some(message => message.action === 'START_BATCH')).toBe(false);
    });

    test('visual-v4: hit relaxed aplica cache apos crop miss e passa por confirmacao regional', async () => {
        const relaxedDataUrl = 'data:image/png;base64,UkVMQVhFRF9ISVQ=';
        const regional = {
            topLeft: '0'.repeat(16),
            topRight: '1'.repeat(16),
            bottomLeft: '2'.repeat(16),
            bottomRight: '3'.repeat(16),
        };

        installRuntimeResponder({
            onCalculateVisualFingerprint() {
                return {
                    ok: true,
                    pixelSample: 'cd'.repeat(256),
                    dHash: '1'.repeat(16),
                    wHash: '2'.repeat(64),
                    pHash: '3'.repeat(64),
                    wHashCrop: '4'.repeat(64),
                    pHashCrop: '5'.repeat(64),
                    regionalHashes: regional,
                };
            },
            onQueryPerceptualRelaxed(message) {
                const key = `${message.wHashes[0]}:${message.pHashes[0]}`;
                return {
                    ok: true,
                    entriesByPerceptualRelaxed: {
                        [key]: {
                            translatedDataUrl: relaxedDataUrl,
                            confidence: 0.75,
                            reason: 'relaxed_test',
                            wDist: 44,
                            pDist: 40,
                            regionalHashes: regional,
                        },
                    },
                };
            },
        });

        await loadContentScript({
            hostname: 'localhost',
            domImages: [
                { src: 'https://cdn.remote.test/page-1.png', width: 800, height: 1200 },
            ],
        });

        document.getElementById('manga-main-content').click();

        await waitFor(() => document.querySelector('[data-testid="img-0"]').dataset.translated === 'true');

        expect(document.querySelector('[data-testid="img-0"]').getAttribute('src')).toBe(relaxedDataUrl);
        expect(sentMessages.map(message => message.action)).toEqual(expect.arrayContaining([
            'GTC_QUERY_BY_PERCEPTUAL_CROP',
            'GTC_QUERY_BY_PERCEPTUAL_RELAXED',
        ]));
        expect(sentMessages.some(message => message.action === 'START_BATCH')).toBe(false);
        expect(sentMessages.some(message =>
            message.action === 'LOG_ENTRY' && message.action_name === 'GTC_F5C_REGIONAL_RESULT'
        )).toBe(true);
    });
});
