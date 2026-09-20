const {
    getRuntimeMock,
    getStorageMock,
    getTabsMock,
    getAlarmsMock,
    getDownloadsMock,
} = require('../../mocks/chrome-api.mock.js');
const { loadBackgroundModule } = require('../../helpers/load-background-module.js');
const {
    BACKGROUND_PATH,
    dispatchToBackground,
    flush,
    waitFor,
} = require('../../helpers/background-test-utils.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('background.js - processNextJob e finalizeJob reais', () => {
    let runtimeMock;
    let storageMock;
    let tabsMock;
    let alarmsMock;
    let downloadsMock;
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
        alarmsMock = getAlarmsMock();
        downloadsMock = getDownloadsMock();

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
        await storageMock.clear();
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('BG-16/BG-17/BG-18: fila vazia conclui, stopRequested bloqueia e maxConcurrentJobs é respeitado', async () => {
        const mangaTab = await tabsMock.create({ url: 'https://reader.test/chapter-1', active: true });
        const forwardedMessages = [];
        const createSpy = jest.spyOn(tabsMock, 'create');

        tabsMock._registerMessageHandler(mangaTab.id, (message, _sender, sendResponse) => {
            forwardedMessages.push(message);
            sendResponse({ ok: true });
        });

        backgroundModule.__setState({
            jobQueue: [],
            isProcessing: true,
            stopRequested: false,
            activeMangaTabId: mangaTab.id,
            extractionTabs: {},
            totalJobs: 1,
            completedJobs: 1,
            activeJobsCount: 0,
        });

        await backgroundModule.processNextJob();
        await flush(6);

        expect(forwardedMessages).toContainEqual({ action: 'BATCH_COMPLETE' });
        expect(backgroundModule.__getState()).toEqual(expect.objectContaining({
            isProcessing: false,
            activeMangaTabId: null,
        }));

        createSpy.mockClear();
        backgroundModule.__setState({
            jobQueue: [{ mangaTabId: mangaTab.id, index: 2, prompt: 'stop' }],
            stopRequested: true,
            activeJobsCount: 0,
            _cachedMaxCon: 1,
        });

        await backgroundModule.processNextJob();
        expect(createSpy).not.toHaveBeenCalled();

        backgroundModule.__setState({
            jobQueue: [{ mangaTabId: mangaTab.id, index: 3, prompt: 'full' }],
            stopRequested: false,
            activeJobsCount: 2,
            _cachedMaxCon: 2,
        });

        await backgroundModule.processNextJob();
        expect(createSpy).not.toHaveBeenCalled();
    });

    test('BG-19/BG-20/BG-22/BG-23: jobs normais, paralelismo e corrida entre chamadas', async () => {
        await storageMock.set({
            geminiBaseUrl: 'http://127.0.0.1:3999/app',
        });

        backgroundModule.__setState({
            jobQueue: [
                { mangaTabId: 70, index: 1, prompt: 'A' },
                { mangaTabId: 70, index: 2, prompt: 'B' },
            ],
            stopRequested: false,
            activeJobsCount: 0,
            totalJobs: 2,
            completedJobs: 0,
            _cachedMaxCon: 2,
        });

        await backgroundModule.processNextJob();

        const geminiJobs = await waitFor(async () => {
            const data = await storageMock.get(null);
            const keys = Object.keys(data).filter(key => key.startsWith('gemini_job_'));
            return keys.length === 2 ? keys : null;
        });

        expect(geminiJobs).toHaveLength(2);
        expect(tabsMock._tabs.size).toBe(2);
        expect(await alarmsMock.getAll()).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: expect.stringMatching(/^watchdog_/) }),
            expect.objectContaining({ name: expect.stringMatching(/^watchdog_/) }),
        ]));

        const createSpy = jest.spyOn(tabsMock, 'create');
        backgroundModule.__setState({
            jobQueue: [{ mangaTabId: 99, index: 7, prompt: 'Race' }],
            stopRequested: false,
            activeJobsCount: 0,
            totalJobs: 1,
            completedJobs: 0,
            _cachedMaxCon: 1,
        });
        tabsMock._tabs.clear();
        await storageMock.clear();
        await storageMock.set({ geminiBaseUrl: 'http://127.0.0.1:3999/app' });

        await Promise.all([
            backgroundModule.processNextJob(),
            backgroundModule.processNextJob(),
        ]);

        await waitFor(() => (tabsMock._tabs.size === 1 ? true : null));
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(backgroundModule.__getState().activeJobsCount).toBe(1);

        backgroundModule.__setState({
            jobQueue: [{ index: 10, prompt: 'no-tab' }],
            stopRequested: false,
            activeJobsCount: 0,
            totalJobs: 1,
            completedJobs: 0,
            _cachedMaxCon: 1,
        });
        tabsMock._tabs.clear();
        await storageMock.clear();
        await storageMock.set({ geminiBaseUrl: 'http://127.0.0.1:3999/app' });

        await backgroundModule.processNextJob();
        await waitFor(() => (tabsMock._tabs.size === 1 ? true : null));

        expect(backgroundModule.__getState().activeMangaTabId).toBeUndefined();
    });

    test('BG-21: erro ao criar aba Gemini decrementa contador e envia erro integrado', async () => {
        const mangaTab = await tabsMock.create({ url: 'https://reader.test/chapter-2', active: true });
        const forwardedMessages = [];

        tabsMock._registerMessageHandler(mangaTab.id, (message, _sender, sendResponse) => {
            forwardedMessages.push(message);
            sendResponse({ ok: true });
        });

        jest.spyOn(tabsMock, 'create').mockRejectedValue(new Error('create failed'));

        backgroundModule.__setState({
            jobQueue: [{ mangaTabId: mangaTab.id, index: 4, prompt: 'boom' }],
            stopRequested: false,
            activeJobsCount: 0,
            totalJobs: 1,
            completedJobs: 0,
            _cachedMaxCon: 1,
        });

        await backgroundModule.processNextJob();
        await waitFor(() => forwardedMessages.find(message => message.action === 'SHOW_ERROR_INTEGRATED') || null);

        expect(forwardedMessages).toContainEqual(expect.objectContaining({
            action: 'SHOW_ERROR_INTEGRATED',
            imgIndex: 4,
        }));
        expect(backgroundModule.__getState().activeJobsCount).toBe(0);
    });

    test('REG-11/BG-24/BG-25/BG-26/BG-28/BG-29: finalizeJob limpa estado, ignora duplicado e respeita debug/missing tab', async () => {
        const clearSpy = jest.spyOn(alarmsMock, 'clear');
        const removeSpy = jest.spyOn(tabsMock, 'remove');

        await storageMock.set({
            debugMode: false,
            deleting_urls: [],
            gemini_job_1500: { geminiTabId: 1500 },
            wd_data_1500: { mangaTabId: 55, index: 1, geminiTabId: 1500 },
        });
        tabsMock._tabs.set(1500, { id: 1500, url: 'https://reader.test/not-gemini', active: false, status: 'complete', title: '' });

        backgroundModule.__setState({
            activeJobsCount: 1,
            completedJobs: 0,
            jobQueue: [],
            stopRequested: false,
            _cachedMaxCon: 1,
        });

        backgroundModule.finalizeJob(1500, 55, false);
        await flush(8);
        await delay(650);

        expect(backgroundModule.__getState()).toEqual(expect.objectContaining({
            activeJobsCount: 0,
            completedJobs: 1,
        }));
        expect(clearSpy).toHaveBeenCalledWith('watchdog_1500', expect.any(Function));
        expect(removeSpy).toHaveBeenCalledWith(1500, expect.any(Function));
        expect((await storageMock.get(null)).gemini_job_1500).toBeUndefined();

        backgroundModule.__setState({ activeJobsCount: 1, completedJobs: 1 });
        backgroundModule.finalizeJob(1500, 55, false);
        await flush(4);

        expect(backgroundModule.__getState()).toEqual(expect.objectContaining({
            activeJobsCount: 1,
            completedJobs: 1,
        }));

        await storageMock.set({
            debugMode: true,
            gemini_job_1600: { geminiTabId: 1600 },
            wd_data_1600: { mangaTabId: 56, index: 2, geminiTabId: 1600 },
        });
        tabsMock._tabs.set(1600, { id: 1600, url: 'https://gemini.google.com/app/test', active: false, status: 'complete', title: '' });
        removeSpy.mockClear();

        backgroundModule.__setState({ activeJobsCount: 1, completedJobs: 0 });
        backgroundModule.finalizeJob(1600, 56, false);
        await flush(8);
        await delay(650);

        expect(backgroundModule.__getState()).toEqual(expect.objectContaining({
            activeJobsCount: 0,
            completedJobs: 1,
        }));
        expect(removeSpy).not.toHaveBeenCalled();

        await storageMock.set({
            debugMode: false,
            gemini_job_1700: { geminiTabId: 1700 },
            wd_data_1700: { mangaTabId: 57, index: 3, geminiTabId: 1700 },
        });
        tabsMock._tabs.delete(1700);
        removeSpy.mockClear();

        backgroundModule.__setState({ activeJobsCount: 1, completedJobs: 0 });
        backgroundModule.finalizeJob(1700, 57, true);
        await flush(8);
        await delay(650);

        expect(backgroundModule.__getState()).toEqual(expect.objectContaining({
            activeJobsCount: 0,
            completedJobs: 0,
        }));
        expect(removeSpy).toHaveBeenCalledWith(1700, expect.any(Function));
    });

    test('BG-27/BG-30/BG-31: finalizedTabs expira após 30s e cleanup de deleting_urls fecha a aba após 18s no modo minimized_window', async () => {
        await storageMock.set({
            debugMode: false,
            geminiExecutionMode: 'minimized_window',
            deleting_urls: [],
            gemini_job_1800: { geminiTabId: 1800, executionMode: 'minimized_window' },
            wd_data_1800: { mangaTabId: 60, index: 4, geminiTabId: 1800 },
        });
        tabsMock._tabs.set(1800, { id: 1800, url: 'https://gemini.google.com/app/job-1800', active: false, status: 'complete', title: '' });

        jest.useFakeTimers();

        backgroundModule.__setState({ activeJobsCount: 1, completedJobs: 0 });
        backgroundModule.finalizeJob(1800, 60, false);

        await flushFakeTimerRounds(6);

        let data = storageMock._getStore();
        expect(data.deleting_urls).toContain('https://gemini.google.com/app/job-1800');
        expect(tabsMock._tabs.has(1800)).toBe(true);

        backgroundModule.__setState({ activeJobsCount: 1, completedJobs: 1 });
        backgroundModule.finalizeJob(1800, 60, false);
        await flushFakeTimerRounds(3);

        expect(backgroundModule.__getState().activeJobsCount).toBe(1);

        await jest.advanceTimersByTimeAsync(18_001);
        await flushFakeTimerRounds(4);
        data = storageMock._getStore();
        expect(data.deleting_urls).toEqual([]);
        expect(tabsMock._tabs.has(1800)).toBe(false);

        storageMock._setStore({
            ...storageMock._getStore(),
            debugMode: false,
            geminiExecutionMode: 'minimized_window',
            deleting_urls: [],
            gemini_job_1800: { geminiTabId: 1800, executionMode: 'minimized_window' },
            wd_data_1800: { mangaTabId: 60, index: 4, geminiTabId: 1800 },
        });
        tabsMock._tabs.set(1800, { id: 1800, url: 'https://reader.test/not-gemini-1800', active: false, status: 'complete', title: '' });

        await jest.advanceTimersByTimeAsync(30_001);

        backgroundModule.__setState({ activeJobsCount: 1, completedJobs: 1 });
        backgroundModule.finalizeJob(1800, 60, false);
        await flushFakeTimerRounds(4);

        expect(backgroundModule.__getState()).toEqual(expect.objectContaining({
            activeJobsCount: 0,
            completedJobs: 2,
        }));
    });

    test('BG-77: aba do mangá fechada durante tradução não deixa job preso', async () => {
        await storageMock.set({
            debugMode: false,
            deleting_urls: [],
            gemini_job_1900: { geminiTabId: 1900, mangaTabId: 404, index: 7 },
            wd_data_1900: { mangaTabId: 404, index: 7, geminiTabId: 1900 },
        });
        tabsMock._tabs.set(1900, {
            id: 1900,
            url: 'https://gemini.google.com/app/job-1900',
            active: false,
            status: 'complete',
            title: '',
        });

        jest.useFakeTimers();
        backgroundModule.__setState({
            jobQueue: [],
            isProcessing: true,
            stopRequested: false,
            activeMangaTabId: 404,
            activeJobsCount: 1,
            totalJobs: 1,
            completedJobs: 0,
        });

        const result = await dispatchToBackground(runtimeMock, {
            action: 'GEMINI_IMAGE_EXTRACTED',
            mangaTabId: 404,
            index: 7,
            src: 'data:image/png;base64,TRANSLATED',
        }, { tab: { id: 1900 } });

        expect(result.response).toEqual({ ok: true });

        await jest.advanceTimersByTimeAsync(1500);
        await flushFakeTimerRounds(6);

        expect(backgroundModule.__getState()).toEqual(expect.objectContaining({
            activeJobsCount: 0,
            completedJobs: 1,
        }));
        expect(storageMock._getStore().gemini_job_1900).toBeUndefined();

        await jest.advanceTimersByTimeAsync(18_001);
        await flushFakeTimerRounds(4);

        expect(tabsMock._tabs.has(1900)).toBe(false);
    });
});
