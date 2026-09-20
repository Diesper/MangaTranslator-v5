const {
    getRuntimeMock,
    getStorageMock,
    getTabsMock,
    getDownloadsMock,
    getAlarmsMock,
} = require('../../mocks/chrome-api.mock.js');
const { loadBackgroundModule } = require('../../helpers/load-background-module.js');
const {
    BACKGROUND_PATH,
    dispatchToBackground,
    flush,
} = require('../../helpers/background-test-utils.js');

describe('BG-59: CALCULATE_VISUAL_FINGERPRINT real no background', () => {
    let runtimeMock;
    let storageMock;
    let tabsMock;
    let downloadsMock;
    let alarmsMock;
    let originalFetch;
    let originalSelf;
    let originalCreateImageBitmap;
    let originalOffscreenCanvas;

    beforeEach(async () => {
        jest.resetModules();
        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        downloadsMock = getDownloadsMock();
        alarmsMock = getAlarmsMock();

        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock._installedListeners = [];
        runtimeMock._startupListeners = [];
        runtimeMock.lastError = null;
        await storageMock.clear();

        global.chrome = {
            storage: { local: storageMock },
            tabs: tabsMock,
            alarms: alarmsMock,
            runtime: runtimeMock,
            downloads: downloadsMock,
            scripting: global.chrome?.scripting,
        };

        originalFetch = global.fetch;
        originalSelf = global.self;
        originalCreateImageBitmap = global.createImageBitmap;
        originalOffscreenCanvas = global.OffscreenCanvas;
    });

    afterEach(async () => {
        global.fetch = originalFetch;
        global.self = originalSelf;
        global.createImageBitmap = originalCreateImageBitmap;
        global.OffscreenCanvas = originalOffscreenCanvas;
        alarmsMock.clearAll();
        tabsMock._tabs.clear();
        downloadsMock._downloads.clear();
        await storageMock.clear();
        jest.restoreAllMocks();
    });

    test('fica no projeto background, usa o handler real e retorna hashes visual-v4 de center-crop', async () => {
        const closeBitmap = jest.fn();
        const drawCalls = [];
        const makePixels = (length) => Uint8ClampedArray.from({ length }, (_value, index) => index % 256);
        const fpApi = {
            calculateDHash: jest.fn(() => 'dhash-16-hex'),
            calculateWHash: jest.fn()
                .mockReturnValueOnce('w-main'.padEnd(64, '0'))
                .mockReturnValueOnce('w-crop'.padEnd(64, '1')),
            calculatePHash: jest.fn()
                .mockReturnValueOnce('p-main'.padEnd(64, '2'))
                .mockReturnValueOnce('p-crop'.padEnd(64, '3')),
            calculateRegionalHashes: jest.fn(() => ({
                topLeft: 'tl',
                topRight: 'tr',
                bottomLeft: 'bl',
                bottomRight: 'br',
            })),
        };

        class MockOffscreenCanvas {
            constructor(width, height) {
                this.width = width;
                this.height = height;
            }

            getContext() {
                return {
                    drawImage: jest.fn((...args) => {
                        drawCalls.push({
                            canvas: `${this.width}x${this.height}`,
                            args,
                        });
                    }),
                    getImageData: jest.fn(() => ({
                        data: makePixels(this.width * this.height * 4),
                    })),
                };
            }
        }

        global.self = { MangaTranslatorGtcFingerprint: fpApi };
        global.fetch = jest.fn(async () => ({
            ok: true,
            blob: async () => new Blob(['image-bytes'], { type: 'image/png' }),
        }));
        global.createImageBitmap = jest.fn(async () => ({
            width: 800,
            height: 1200,
            close: closeBitmap,
        }));
        global.OffscreenCanvas = MockOffscreenCanvas;

        loadBackgroundModule(BACKGROUND_PATH);
        await flush(8);

        const result = await dispatchToBackground(runtimeMock, {
            action: 'CALCULATE_VISUAL_FINGERPRINT',
            url: 'https://cdn.reader.test/page-001.png',
        });

        expect(result.keepAlive).toBe(true);
        expect(result.response).toEqual(expect.objectContaining({
            ok: true,
            pixelSample: expect.stringMatching(/^[0-9a-f]+$/),
            dHash: 'dhash-16-hex',
            wHash: 'w-main'.padEnd(64, '0'),
            pHash: 'p-main'.padEnd(64, '2'),
            wHashCrop: 'w-crop'.padEnd(64, '1'),
            pHashCrop: 'p-crop'.padEnd(64, '3'),
            regionalHashes: {
                topLeft: 'tl',
                topRight: 'tr',
                bottomLeft: 'bl',
                bottomRight: 'br',
            },
        }));
        expect(result.response.pixelSample).toHaveLength(512);
        expect(global.fetch).toHaveBeenCalledWith('https://cdn.reader.test/page-001.png', {
            credentials: 'omit',
            cache: 'no-store',
        });
        expect(fpApi.calculateDHash).toHaveBeenCalledTimes(1);
        expect(fpApi.calculateWHash).toHaveBeenCalledTimes(2);
        expect(fpApi.calculatePHash).toHaveBeenCalledTimes(2);
        expect(fpApi.calculateRegionalHashes).toHaveBeenCalledTimes(1);
        expect(drawCalls).toEqual(expect.arrayContaining([
            expect.objectContaining({
                canvas: '32x32',
                args: expect.arrayContaining([0, 200, 800, 800, 0, 0, 32, 32]),
            }),
        ]));
        expect(closeBitmap).toHaveBeenCalled();
    });
});
