const path = require('path');

const ROUTER_PATH = path.resolve(__dirname, '../../../extension/background/router.js');
const ACTION_PATH = path.resolve(
    __dirname,
    '../../../extension/background/actions/calculate-visual-fingerprint.js'
);

function dispatch(listener, request, sender) {
    return new Promise(resolve => {
        let keepAlive;
        let response;
        const sendResponse = result => {
            response = result;
            if (keepAlive !== undefined) resolve({ keepAlive, response });
        };

        keepAlive = listener(request, sender, sendResponse);
        if (response !== undefined || keepAlive === false) {
            resolve({ keepAlive, response });
        }
    });
}

function loadAction(logger) {
    global.self = global;
    global.MangaTranslatorLog = { log: logger };
    delete global.MangaTranslatorRouter;

    jest.isolateModules(() => {
        require(ROUTER_PATH);
        require(ACTION_PATH);
    });

    return global.MangaTranslatorRouter;
}

describe('calculate-visual-fingerprint action', () => {
    let originalFetch;
    let originalSelf;
    let originalCreateImageBitmap;
    let originalOffscreenCanvas;

    beforeEach(() => {
        jest.resetModules();
        originalFetch = global.fetch;
        originalSelf = global.self;
        originalCreateImageBitmap = global.createImageBitmap;
        originalOffscreenCanvas = global.OffscreenCanvas;
    });

    afterEach(() => {
        global.fetch = originalFetch;
        global.self = originalSelf;
        global.createImageBitmap = originalCreateImageBitmap;
        global.OffscreenCanvas = originalOffscreenCanvas;
        delete global.MangaTranslatorGtcFingerprint;
        delete global.MangaTranslatorLog;
        delete global.MangaTranslatorRouter;
    });

    test('preserves the visual-v4 response, including center-crop hashes', async () => {
        const close = jest.fn();
        const drawCalls = [];
        const fpApi = {
            calculateDHash: jest.fn(() => 'dhash'),
            calculateWHash: jest.fn()
                .mockReturnValueOnce('w-main')
                .mockReturnValueOnce('w-crop'),
            calculatePHash: jest.fn()
                .mockReturnValueOnce('p-main')
                .mockReturnValueOnce('p-crop'),
            calculateRegionalHashes: jest.fn(() => ({ topLeft: 'tl' })),
        };

        class MockOffscreenCanvas {
            constructor(width, height) {
                this.width = width;
                this.height = height;
            }

            getContext() {
                return {
                    drawImage: (...args) => drawCalls.push({ width: this.width, height: this.height, args }),
                    getImageData: () => ({
                        data: Uint8ClampedArray.from(
                            { length: this.width * this.height * 4 },
                            (_value, index) => index % 256
                        ),
                    }),
                };
            }
        }

        global.fetch = jest.fn(async () => ({ ok: true, blob: async () => ({}) }));
        global.createImageBitmap = jest.fn(async () => ({ width: 800, height: 1200, close }));
        global.OffscreenCanvas = MockOffscreenCanvas;
        global.MangaTranslatorGtcFingerprint = fpApi;
        const logger = jest.fn();
        const router = loadAction(logger);

        const result = await dispatch(router.createMessageRouter({}), {
            action: 'CALCULATE_VISUAL_FINGERPRINT',
            url: 'https://cdn.example.test/page.png',
        }, { tab: { id: 8, url: 'https://reader.example.test/chapter' } });

        expect(result).toEqual({
            keepAlive: true,
            response: {
                ok: true,
                pixelSample: expect.stringMatching(/^[0-9a-f]{512}$/),
                dHash: 'dhash',
                wHash: 'w-main',
                pHash: 'p-main',
                wHashCrop: 'w-crop',
                pHashCrop: 'p-crop',
                regionalHashes: { topLeft: 'tl' },
            },
        });
        expect(global.fetch).toHaveBeenCalledWith('https://cdn.example.test/page.png', {
            credentials: 'omit',
            cache: 'no-store',
        });
        expect(drawCalls).toEqual(expect.arrayContaining([
            expect.objectContaining({
                width: 32,
                height: 32,
                args: expect.arrayContaining([0, 200, 800, 800, 0, 0, 32, 32]),
            }),
        ]));
        expect(close).toHaveBeenCalledTimes(1);
        expect(logger).toHaveBeenCalledWith('info', 'bg', 'VISUAL_FP_OK', expect.any(String), expect.any(Object));
    });

    test('rejects data URLs without fetching them', async () => {
        global.fetch = jest.fn();
        const router = loadAction(jest.fn());

        const result = await dispatch(router.createMessageRouter({}), {
            action: 'CALCULATE_VISUAL_FINGERPRINT',
            url: 'data:image/png;base64,AAA',
        }, { tab: { id: 8, url: 'https://reader.example.test/chapter' } });

        expect(result).toEqual({
            keepAlive: true,
            response: { ok: false, error: 'URL inválida para fingerprint visual' },
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('rejects non-HTTP(S) URLs without fetching them', async () => {
        global.fetch = jest.fn();
        const router = loadAction(jest.fn());

        const result = await dispatch(router.createMessageRouter({}), {
            action: 'CALCULATE_VISUAL_FINGERPRINT',
            url: 'chrome-extension://example-id/asset.png',
        }, { tab: { id: 8, url: 'https://reader.example.test/chapter' } });

        expect(result).toEqual({
            keepAlive: true,
            response: { ok: false, error: 'URL inválida para fingerprint visual' },
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('closes the ImageBitmap when a fingerprint calculation fails', async () => {
        const close = jest.fn();
        const hashFailure = new Error('wHash indisponivel');
        global.fetch = jest.fn(async () => ({ ok: true, blob: async () => ({}) }));
        global.createImageBitmap = jest.fn(async () => ({ width: 800, height: 1200, close }));
        global.OffscreenCanvas = class {
            getContext() {
                return {
                    drawImage: jest.fn(),
                    getImageData: () => ({ data: new Uint8ClampedArray(32) }),
                };
            }
        };
        global.MangaTranslatorGtcFingerprint = {
            calculateWHash: jest.fn(() => { throw hashFailure; }),
        };
        const logger = jest.fn();
        const router = loadAction(logger);

        const result = await dispatch(router.createMessageRouter({}), {
            action: 'CALCULATE_VISUAL_FINGERPRINT',
            url: 'https://cdn.example.test/page.png',
        }, { tab: { id: 8, url: 'https://reader.example.test/chapter' } });

        expect(result).toEqual({
            keepAlive: true,
            response: { ok: false, error: 'wHash indisponivel' },
        });
        expect(close).toHaveBeenCalledTimes(1);
        expect(logger).toHaveBeenCalledWith(
            'warn',
            'bg',
            'VISUAL_FP_FAIL',
            expect.stringContaining('wHash indisponivel'),
            expect.any(Object)
        );
    });
});
