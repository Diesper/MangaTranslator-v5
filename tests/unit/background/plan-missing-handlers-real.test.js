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

describe('REG-09/IPC-07/IPC-08: background.js - handlers faltantes do plano v3.1', () => {
    let runtimeMock;
    let storageMock;
    let tabsMock;
    let downloadsMock;
    let alarmsMock;
    let backgroundModule;
    let originalFetch;
    let originalFileReader;

    class MockFileReader {
        readAsDataURL(blob) {
            this.result = `data:${blob.type || 'application/octet-stream'};base64,UkVBRA==`;
            setTimeout(() => {
                if (typeof this.onloadend === 'function') this.onloadend();
            }, 0);
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

        tabsMock._tabs.clear();
        downloadsMock._downloads.clear();
        alarmsMock.clearAll();
        await storageMock.clear();

        originalFetch = global.fetch;
        originalFileReader = global.FileReader;
        global.FileReader = MockFileReader;

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
        global.fetch = originalFetch;
        global.FileReader = originalFileReader;
        alarmsMock.clearAll();
        tabsMock._tabs.clear();
        downloadsMock._downloads.clear();
        await storageMock.clear();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('BG-43: LOG_ENTRY responde ok e persiste a entrada no translatorLog', async () => {
        const result = await dispatchToBackground(runtimeMock, {
            action: 'LOG_ENTRY',
            level: 'warn',
            source: 'popup',
            action_name: 'PLAN_LOG',
            detail: 'entrada do plano',
            extra: { id: 43 },
        });

        expect(result.keepAlive).toBe(false);
        expect(result.response).toEqual({ ok: true });

        const logs = await waitFor(async () => {
            const data = await storageMock.get(['translatorLog']);
            return (data.translatorLog || []).find(entry => entry.action === 'PLAN_LOG');
        });

        expect(logs).toEqual(expect.objectContaining({
            level: 'warn',
            source: 'popup',
            action: 'PLAN_LOG',
            detail: 'entrada do plano',
            extra: { id: 43 },
        }));
    });

    test('BG-44/BG-45: START_BATCH reseta estado anterior e abre abas respeitando maxConcurrentJobs', async () => {
        await storageMock.set({
            maxConcurrentJobs: 3,
            mt_state: {
                jobQueue: [{ mangaTabId: 999, index: 99, prompt: 'velho' }],
                isProcessing: true,
                stopRequested: false,
                activeMangaTabId: 999,
                extractionTabs: {},
                totalJobs: 1,
                completedJobs: 1,
                activeJobsCount: 1,
            },
        });

        backgroundModule.__setState({
            completedJobs: 7,
            activeJobsCount: 2,
            jobQueue: [{ mangaTabId: 999, index: 99, prompt: 'velho' }],
        });

        const result = await dispatchToBackground(runtimeMock, {
            action: 'START_BATCH',
            images: Array.from({ length: 5 }, (_unused, index) => ({ index })),
            prompt: 'prompt novo',
        }, { tab: { id: 123 } });

        expect(result.keepAlive).toBe(true);
        expect(result.response).toEqual(expect.objectContaining({
            ok: true,
            batchId: expect.any(String),
        }));
        const batchId = result.response.batchId;

        await waitFor(() => tabsMock._tabs.size === 3);

        const state = backgroundModule.__getState();
        expect(state.activeMangaTabId).toBe(123);
        expect(state.totalJobs).toBe(5);
        expect(state.completedJobs).toBe(0);
        expect(state.activeJobsCount).toBe(3);
        expect(state.jobQueue).toEqual([
            { mangaTabId: 123, index: 3, prompt: 'prompt novo', batchId },
            { mangaTabId: 123, index: 4, prompt: 'prompt novo', batchId },
        ]);

        const storage = await waitFor(async () => {
            const data = await storageMock.get(null);
            const watchdogKeysNow = Object.keys(data).filter(key => key.startsWith('wd_data_'));
            return watchdogKeysNow.length === 3 ? data : null;
        });
        const geminiJobKeys = Object.keys(storage).filter(key => key.startsWith('gemini_job_'));
        const watchdogKeys = Object.keys(storage).filter(key => key.startsWith('wd_data_'));

        expect(geminiJobKeys).toHaveLength(3);
        expect(watchdogKeys).toHaveLength(3);
        Array.from(tabsMock._tabs.values()).forEach(tab => {
            const url = new URL(tab.url);
            expect(url.origin + url.pathname).toBe('https://gemini.google.com/app');
            expect(url.searchParams.get('mangatranslator')).toBe('true');
            expect(url.searchParams.get('jobId')).toEqual(expect.any(String));
        });
    });

    test('BG-46: STOP_BATCH remove abas Gemini, watchdogs, jobs e extractionTabs', async () => {
        const geminiA = await tabsMock.create({ url: 'https://gemini.google.com/app/a', active: false });
        const geminiB = await tabsMock.create({ url: 'https://gemini.google.com/app/b', active: false });
        const extractionTab = await tabsMock.create({ url: 'https://cdn.test/result.png', active: false });

        await storageMock.set({
            [`gemini_job_${geminiA.id}`]: { geminiTabId: geminiA.id, mangaTabId: 10, index: 0, jobId: 'job-a', batchId: 'batch-stop' },
            [`gemini_job_${geminiB.id}`]: { geminiTabId: geminiB.id, mangaTabId: 10, index: 1, jobId: 'job-b', batchId: 'batch-stop' },
            [`wd_data_${geminiA.id}`]: { geminiTabId: geminiA.id, mangaTabId: 10, index: 0, jobId: 'job-a' },
            [`wd_data_${geminiB.id}`]: { geminiTabId: geminiB.id, mangaTabId: 10, index: 1, jobId: 'job-b' },
        });
        alarmsMock.create('watchdog_job-a', { delayInMinutes: 4 });
        alarmsMock.create('watchdog_job-b', { delayInMinutes: 4 });
        backgroundModule.__setState({
            isProcessing: true,
            activeJobsCount: 2,
            activeMangaTabId: 10,
            extractionTabs: {
                [extractionTab.id]: { mangaTabId: 10, index: 9, geminiTabId: geminiA.id, batchId: 'batch-stop' },
            },
        });
        global.MangaTranslatorState.patch({
            currentBatchId: 'batch-stop',
            jobIndex: [
                { geminiTabId: geminiA.id, mangaTabId: 10, index: 0, jobId: 'job-a', batchId: 'batch-stop' },
                { geminiTabId: geminiB.id, mangaTabId: 10, index: 1, jobId: 'job-b', batchId: 'batch-stop' },
            ],
        });

        const result = await dispatchToBackground(runtimeMock, { action: 'STOP_BATCH', batchId: 'batch-stop' });
        expect(result.keepAlive).toBe(true);
        expect(result.response).toEqual({ ok: true });

        const storage = await storageMock.get(null);
        const state = backgroundModule.__getState();

        expect(tabsMock._tabs.has(geminiA.id)).toBe(false);
        expect(tabsMock._tabs.has(geminiB.id)).toBe(false);
        expect(tabsMock._tabs.has(extractionTab.id)).toBe(false);
        expect(Object.keys(storage).some(key => key.startsWith('gemini_job_'))).toBe(false);
        expect(Object.keys(storage).some(key => key.startsWith('wd_data_'))).toBe(false);
        expect((await alarmsMock.getAll())).toHaveLength(0);
        expect(state.extractionTabs).toEqual({});
        expect(state.activeJobsCount).toBe(0);
        expect(state.isProcessing).toBe(false);
    });

    test('BG-51/BG-53/BG-54: GEMINI_RESULT_URL registra extraction tab e CHECK_IF_EXTRACTION_TAB distingue hit/miss', async () => {
        const geminiTab = await tabsMock.create({ url: 'https://gemini.google.com/app/chat', active: false });

        await storageMock.set({
            [`gemini_job_${geminiTab.id}`]: {
                geminiTabId: geminiTab.id,
                mangaTabId: 22,
                index: 4,
                jobId: 'job-result-url',
            },
        });

        const result = await dispatchToBackground(runtimeMock, {
            action: 'GEMINI_RESULT_URL',
            mangaTabId: 22,
            index: 4,
            url: 'https://lh3.googleusercontent.com/generated.png',
            jobId: 'job-result-url',
        }, { tab: { id: geminiTab.id, url: 'https://gemini.google.com/app/chat' } });

        expect(result.response).toEqual({ ok: true });

        const extractionTab = await waitFor(() =>
            Array.from(tabsMock._tabs.values()).find(tab =>
                tab.url === 'https://lh3.googleusercontent.com/generated.png'
                && backgroundModule.__getState().extractionTabs[tab.id]
            )
        );

        const hit = await dispatchToBackground(runtimeMock, {
            action: 'CHECK_IF_EXTRACTION_TAB',
        }, { tab: { id: extractionTab.id } });

        const miss = await dispatchToBackground(runtimeMock, {
            action: 'CHECK_IF_EXTRACTION_TAB',
        }, { tab: { id: 987654 } });

        expect(hit.response).toEqual({
            isExtractionTab: true,
            mangaTabId: 22,
            index: 4,
            geminiTabId: geminiTab.id,
        });
        expect(miss.response).toEqual({ isExtractionTab: false });
        expect(backgroundModule.__getState().extractionTabs[extractionTab.id]).toEqual(expect.objectContaining({
            mangaTabId: 22,
            index: 4,
            geminiTabId: geminiTab.id,
            jobId: 'job-result-url',
        }));
    });

    test('BG-57/BG-58: FETCH_IMAGE_AS_BASE64 converte blob em dataURL e responde erro em falha de fetch', async () => {
        global.fetch = jest.fn();
        global.fetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => 'image/png' },
            blob: async () => new Blob(['image-bytes'], { type: 'image/png' }),
        });
        runtimeMock._messageListeners = [];
        backgroundModule = loadBackgroundModule(BACKGROUND_PATH);
        await flush(4);

        const contentSender = { tab: { id: 222, url: 'https://manga.test/chapter' } };
        const success = await dispatchToBackground(runtimeMock, {
            action: 'FETCH_IMAGE_AS_BASE64',
            url: 'https://cdn.test/page.png',
        }, contentSender);

        expect(success.keepAlive).toBe(true);
        expect(success.response).toEqual({
            dataUrl: 'data:image/png;base64,UkVBRA==',
        });
        expect(global.fetch).toHaveBeenCalledWith('https://cdn.test/page.png', expect.objectContaining({
            credentials: 'omit',
            cache: 'no-store',
            signal: expect.any(Object),
        }));

        global.fetch.mockRejectedValueOnce(new Error('HTTP 404'));
        const failure = await dispatchToBackground(runtimeMock, {
            action: 'FETCH_IMAGE_AS_BASE64',
            url: 'https://cdn.test/missing.png',
        }, contentSender);

        expect(failure.keepAlive).toBe(true);
        expect(failure.response).toEqual({ error: 'HTTP 404' });
    });

    test('BG-37/BG-62: SHOW_EXISTING_FOLDER com anchorId valido chama downloads.show sem novo download', async () => {
        downloadsMock._downloads.set(707, {
            id: 707,
            url: 'data:image/png;base64,ANCHOR',
            filename: 'C:/Downloads/MangaTranslator/Capitulo/_anchor.png',
            state: 'complete',
            exists: true,
        });

        const showSpy = jest.spyOn(downloadsMock, 'show').mockResolvedValue();
        const downloadSpy = jest.spyOn(downloadsMock, 'download');

        const result = await dispatchToBackground(runtimeMock, {
            action: 'SHOW_EXISTING_FOLDER',
            folderPath: 'C:/Downloads/MangaTranslator/Capitulo',
            safeTitle: 'Capitulo',
            anchorId: 707,
        });

        expect(result.keepAlive).toBe(true);
        expect(result.response).toEqual({ ok: true });
        expect(showSpy).toHaveBeenCalledWith(707);
        expect(downloadSpy).not.toHaveBeenCalled();
    });

    test('BG-65: EXPORT_ALL_AND_SHOW com lista vazia responde imediatamente sem downloads', async () => {
        const downloadSpy = jest.spyOn(downloadsMock, 'download');

        const result = await dispatchToBackground(runtimeMock, {
            action: 'EXPORT_ALL_AND_SHOW',
            allDownloads: [],
        });

        expect(result.response).toEqual({ ok: true });
        expect(downloadSpy).not.toHaveBeenCalled();
    });

    test('BG-66/BG-67: SET_DEBUG_MODE salva storage e envia DEBUG_MODE_CHANGED para todas as abas', async () => {
        const tabA = await tabsMock.create({ url: 'https://manga.test/a', active: true });
        const tabB = await tabsMock.create({ url: 'https://manga.test/b', active: false });
        const messagesA = [];
        const messagesB = [];

        tabsMock._registerMessageHandler(tabA.id, (message, _sender, sendResponse) => {
            messagesA.push(message);
            sendResponse({ ok: true });
        });
        tabsMock._registerMessageHandler(tabB.id, (message, _sender, sendResponse) => {
            messagesB.push(message);
            sendResponse({ ok: true });
        });

        const result = await dispatchToBackground(runtimeMock, {
            action: 'SET_DEBUG_MODE',
            debugOn: true,
        });

        expect(result.keepAlive).toBe(true);
        expect(result.response).toEqual({ ok: true });

        const data = await storageMock.get(['debugMode']);
        expect(data.debugMode).toBe(true);
        expect(messagesA).toContainEqual({ action: 'DEBUG_MODE_CHANGED', debugOn: true });
        expect(messagesB).toContainEqual({ action: 'DEBUG_MODE_CHANGED', debugOn: true });
    });
});
