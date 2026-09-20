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
    flush,
    dispatchToBackground,
    waitFor,
} = require('../../helpers/background-test-utils.js');

describe('background.js - handlers onMessage reais', () => {
    let runtimeMock;
    let storageMock;
    let tabsMock;
    let downloadsMock;
    let alarmsMock;
    let backgroundModule;

    async function flushFakeTimerRounds(rounds = 6, stepMs = 1) {
        for (let index = 0; index < rounds; index++) {
            // eslint-disable-next-line no-await-in-loop
            await jest.advanceTimersByTimeAsync(stepMs);
        }
    }

    beforeEach(async () => {
        jest.resetModules();
        jest.useRealTimers();

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

        backgroundModule = loadBackgroundModule(BACKGROUND_PATH);
        await flush(8);
    });

    afterEach(async () => {
        alarmsMock.clearAll();
        tabsMock._tabs.clear();
        downloadsMock._downloads.clear();
        await storageMock.clear();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('BG-47/BG-48/BG-49/BG-50: GET_TAB_ID, GEMINI_PROGRESS e REQUEST_IMAGE_DATA funcionam com relay correto', async () => {
        const mangaTab = await tabsMock.create({ url: 'https://reader.test/chapter-3', active: true });
        const forwardedMessages = [];

        tabsMock._registerMessageHandler(mangaTab.id, (message, _sender, sendResponse) => {
            forwardedMessages.push(message);
            if (message.action === 'REQUEST_IMAGE_DATA') {
                sendResponse({ base64: 'data:image/png;base64,IMG_3' });
                return;
            }
            sendResponse({ ok: true });
        });

        const tabIdResult = await dispatchToBackground(runtimeMock, {
            action: 'GET_TAB_ID',
        }, { tab: { id: mangaTab.id } });

        expect(tabIdResult.response).toEqual({ tabId: mangaTab.id });

        const explicitProgress = await dispatchToBackground(runtimeMock, {
            action: 'GEMINI_PROGRESS',
            mangaTabId: mangaTab.id,
            text: 'explicito',
        });
        expect(explicitProgress.response).toEqual({ ok: true });

        backgroundModule.__setState({ activeMangaTabId: mangaTab.id });
        const fallbackProgress = await dispatchToBackground(runtimeMock, {
            action: 'GEMINI_PROGRESS',
            text: 'fallback',
        });
        expect(fallbackProgress.response).toEqual({ ok: true });

        const requestImageData = await dispatchToBackground(runtimeMock, {
            action: 'REQUEST_IMAGE_DATA',
            mangaTabId: mangaTab.id,
            index: 3,
        });
        expect(requestImageData.response).toEqual({ base64: 'data:image/png;base64,IMG_3' });

        const requestImageDataError = await dispatchToBackground(runtimeMock, {
            action: 'REQUEST_IMAGE_DATA',
            mangaTabId: 99999,
            index: 4,
        });
        expect(requestImageDataError.response).toEqual(expect.objectContaining({
            error: expect.stringContaining('Could not establish connection'),
        }));

        expect(forwardedMessages).toContainEqual({ action: 'PROGRESS', text: 'explicito' });
        expect(forwardedMessages).toContainEqual({ action: 'PROGRESS', text: 'fallback' });
        expect(forwardedMessages).toContainEqual({ action: 'REQUEST_IMAGE_DATA', index: 3 });
    });

    test('BG-52/BG-55/BG-56: handlers de imagem e erro atualizam manga tab e disparam finalize', async () => {
        const mangaTab = await tabsMock.create({ url: 'https://reader.test/chapter-4', active: true });
        const forwardedMessages = [];

        tabsMock._registerMessageHandler(mangaTab.id, (message, _sender, sendResponse) => {
            forwardedMessages.push(message);
            sendResponse({ ok: true });
        });

        jest.useFakeTimers();

        backgroundModule.__setState({ activeJobsCount: 1, completedJobs: 0 });
        const extractedResultPromise = dispatchToBackground(runtimeMock, {
            action: 'GEMINI_IMAGE_EXTRACTED',
            mangaTabId: mangaTab.id,
            index: 7,
            src: 'data:image/png;base64,FROM_GEMINI',
        }, { tab: { id: 3333 } });
        await jest.advanceTimersByTimeAsync(1);
        const extractedResult = await extractedResultPromise;

        expect(extractedResult.response).toEqual({ ok: true });
        expect(forwardedMessages).toContainEqual(expect.objectContaining({
            action: 'UPDATE_IMAGE',
            index: 7,
            newSrc: 'data:image/png;base64,FROM_GEMINI',
            expectAck: true,
        }));

        await jest.advanceTimersByTimeAsync(1501);
        await flushFakeTimerRounds(4);
        expect(backgroundModule.__getState().activeJobsCount).toBe(0);

        const extractionTab = await tabsMock.create({ url: 'https://cdn.reader.test/result.png', active: false });
        backgroundModule.__setState({
            extractionTabs: {
                [extractionTab.id]: { mangaTabId: mangaTab.id, index: 8, geminiTabId: 4444 },
            },
            activeJobsCount: 1,
            completedJobs: 0,
        });

        const readyFromTabPromise = dispatchToBackground(runtimeMock, {
            action: 'IMAGE_READY_FROM_NEW_TAB',
            mangaTabId: mangaTab.id,
            index: 8,
            src: 'data:image/png;base64,FROM_EXTRACTION_TAB',
            geminiTabId: 4444,
        }, { tab: { id: extractionTab.id } });
        await jest.advanceTimersByTimeAsync(1);
        const readyFromTab = await readyFromTabPromise;

        expect(readyFromTab.response).toEqual({ ok: true });
        expect(tabsMock._tabs.has(extractionTab.id)).toBe(false);
        expect(forwardedMessages).toContainEqual(expect.objectContaining({
            action: 'UPDATE_IMAGE',
            index: 8,
            newSrc: 'data:image/png;base64,FROM_EXTRACTION_TAB',
            expectAck: true,
        }));

        await jest.advanceTimersByTimeAsync(1501);
        await flushFakeTimerRounds(4);
        expect(backgroundModule.__getState().activeJobsCount).toBe(0);

        storageMock._setStore({
            ...storageMock._getStore(),
            debugMode: true,
        });
        backgroundModule.__setState({ activeJobsCount: 1, completedJobs: 0 });
        const geminiErrorPromise = dispatchToBackground(runtimeMock, {
            action: 'GEMINI_ERROR',
            mangaTabId: mangaTab.id,
            index: 9,
            error: 'Falhou bonito',
        }, { tab: { id: 5555 } });

        await flushFakeTimerRounds(6);
        const geminiError = await geminiErrorPromise;
        expect(geminiError.response).toEqual({ ok: true });

        expect(forwardedMessages).toContainEqual({
            action: 'SHOW_ERROR_INTEGRATED',
            errorMsg: 'Falhou bonito',
            imgIndex: 9,
            isDebug: true,
        });
        expect(backgroundModule.__getState().activeJobsCount).toBe(0);
    });

    test('BG-59: CALCULATE_VISUAL_FINGERPRINT calcula hashes visuais via fetch do service worker', async () => {
        const originalFetch = global.fetch;
        const originalSelf = global.self;
        const originalCreateImageBitmap = global.createImageBitmap;
        const originalOffscreenCanvas = global.OffscreenCanvas;

        const closeBitmap = jest.fn();
        const makePixels = (length) => Uint8ClampedArray.from({ length }, (_value, index) => index % 256);
        const fpApi = {
            calculateDHash: jest.fn(() => 'dhash-16-hex'),
            calculateWHash: jest.fn(() => 'w'.repeat(64)),
            calculatePHash: jest.fn(() => 'p'.repeat(64)),
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
                    drawImage: jest.fn(),
                    getImageData: jest.fn(() => ({
                        data: makePixels(this.width * this.height * 4),
                    })),
                };
            }
        }

        try {
            runtimeMock._messageListeners = [];
            global.self = { MangaTranslatorGtcFingerprint: fpApi };
            global.fetch = jest.fn(async () => ({
                ok: true,
                blob: async () => new Blob(['image-bytes'], { type: 'image/png' }),
            }));
            global.createImageBitmap = jest.fn(async () => ({ close: closeBitmap }));
            global.OffscreenCanvas = MockOffscreenCanvas;

            backgroundModule = loadBackgroundModule(BACKGROUND_PATH);
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
                wHash: 'w'.repeat(64),
                pHash: 'p'.repeat(64),
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
            expect(global.createImageBitmap).toHaveBeenCalled();
            expect(fpApi.calculateDHash).toHaveBeenCalled();
            expect(fpApi.calculateWHash).toHaveBeenCalled();
            expect(fpApi.calculatePHash).toHaveBeenCalled();
            expect(fpApi.calculateRegionalHashes).toHaveBeenCalled();
            expect(closeBitmap).toHaveBeenCalled();
        } finally {
            global.fetch = originalFetch;
            global.self = originalSelf;
            global.createImageBitmap = originalCreateImageBitmap;
            global.OffscreenCanvas = originalOffscreenCanvas;
        }
    });

    test('BG-59: CALCULATE_VISUAL_FINGERPRINT rejeita data/blob URL sem tentar fetch', async () => {
        const fetchSpy = jest.spyOn(global, 'fetch');

        const result = await dispatchToBackground(runtimeMock, {
            action: 'CALCULATE_VISUAL_FINGERPRINT',
            url: 'data:image/png;base64,AAA',
        });

        expect(result.response).toEqual({
            ok: false,
            error: 'URL inválida para fingerprint visual',
        });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    test('BG-60/BG-61/BG-63/BG-64: DOWNLOAD_IMAGE, SHOW_EXISTING_FOLDER e EXPORT_ALL_AND_SHOW respeitam prefixos e completude', async () => {
        const downloadSpy = jest.spyOn(downloadsMock, 'download');
        const showSpy = jest.spyOn(downloadsMock, 'show').mockResolvedValue();

        const downloadImage = await dispatchToBackground(runtimeMock, {
            action: 'DOWNLOAD_IMAGE',
            url: 'data:image/png;base64,AAA',
            filename: 'chap/pagina_001.png',
        });

        expect(downloadImage.response).toEqual(expect.objectContaining({
            filePath: expect.stringContaining('MangaTranslator/chap/pagina_001.png'),
            downloadId: expect.any(Number),
        }));
        expect(downloadSpy).toHaveBeenCalledWith(expect.objectContaining({
            filename: 'MangaTranslator/chap/pagina_001.png',
        }), expect.any(Function));

        const downloadAlreadyPrefixed = await dispatchToBackground(runtimeMock, {
            action: 'DOWNLOAD_IMAGE',
            url: 'data:image/png;base64,BBB',
            filename: 'MangaTranslator/chap/pagina_002.png',
        });

        expect(downloadAlreadyPrefixed.response).toEqual(expect.objectContaining({
            filePath: expect.stringContaining('MangaTranslator/chap/pagina_002.png'),
        }));
        expect(downloadSpy).toHaveBeenCalledWith(expect.objectContaining({
            filename: 'MangaTranslator/chap/pagina_002.png',
        }), expect.any(Function));

        downloadsMock._downloads.set(999, {
            id: 999,
            url: 'data:image/png;base64,MARKER',
            filename: 'C:/Users/TestUser/Downloads/MangaTranslator/Chapter_10/pagina_001.png',
            state: 'complete',
            exists: true,
        });

        const existingFolder = await dispatchToBackground(runtimeMock, {
            action: 'SHOW_EXISTING_FOLDER',
            folderPath: 'C:/Users/TestUser/Downloads/MangaTranslator/Chapter_10',
            safeTitle: 'Chapter_10',
        });

        expect(existingFolder.response).toEqual({ ok: true });
        expect(showSpy).toHaveBeenCalledWith(999);

        showSpy.mockClear();
        downloadSpy.mockClear();
        const exportAll = await dispatchToBackground(runtimeMock, {
            action: 'EXPORT_ALL_AND_SHOW',
            allDownloads: [
                { url: 'data:image/png;base64,1', filename: 'alpha/pagina_001.png' },
                { url: 'data:image/png;base64,2', filename: 'alpha/pagina_002.png' },
                { url: 'data:image/png;base64,3', filename: 'alpha/pagina_003.png' },
            ],
        });

        expect(exportAll.response).toEqual({ ok: true });
        expect(downloadSpy).toHaveBeenCalledTimes(3);
        expect(showSpy).toHaveBeenCalledTimes(1);
    });

    test('OPEN_CHAPTER_FOLDER reutiliza anchorId existente sem redownload', async () => {
        downloadsMock._downloads.set(444, {
            id: 444,
            url: 'data:image/png;base64,ANCHOR',
            filename: '/home/user/Downloads/MangaTranslator/Capitulo_X/_anchor.png',
            state: 'complete',
            exists: true,
        });

        const showSpy = jest.spyOn(downloadsMock, 'show').mockResolvedValue();
        const downloadSpy = jest.spyOn(downloadsMock, 'download');

        const openFolder = await dispatchToBackground(runtimeMock, {
            action: 'OPEN_CHAPTER_FOLDER',
            anchorId: 444,
            chapId: 'chap_x',
            safeTitle: 'Capitulo_X',
            images: {
                0: 'data:image/png;base64,PAGE_0',
            },
        });

        expect(openFolder.response).toEqual({ ok: true });
        expect(showSpy).toHaveBeenCalledWith(444);
        expect(downloadSpy).not.toHaveBeenCalled();
    });
});
