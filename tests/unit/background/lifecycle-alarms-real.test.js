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
    flush,
    waitFor,
} = require('../../helpers/background-test-utils.js');

describe('background.js - lifecycle e alarms reais', () => {
    let runtimeMock;
    let storageMock;
    let tabsMock;
    let alarmsMock;
    let downloadsMock;
    let backgroundModule;

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

    test('BG-68/BG-69: onInstalled persiste defaultPrompt e onStartup com fila vazia só sincroniza estado', async () => {
        const createSpy = jest.spyOn(tabsMock, 'create');
        const initial = await storageMock.get(['defaultPrompt']);

        expect(initial.defaultPrompt).toContain('Objetivo primário');

        await storageMock.set({
            mt_state: {
                jobQueue: [],
                isProcessing: false,
                stopRequested: false,
                activeMangaTabId: null,
                extractionTabs: { 9999: { foo: 'bar' } },
                totalJobs: 0,
                completedJobs: 0,
                activeJobsCount: 0,
            },
        });

        await runtimeMock._simulateStartup();
        await flush(8);

        const state = await storageMock.get(['mt_state']);
        expect(state.mt_state).toEqual(expect.objectContaining({
            jobQueue: [],
            isProcessing: false,
            stopRequested: false,
            activeMangaTabId: null,
            extractionTabs: {},
            totalJobs: 0,
            completedJobs: 0,
            activeJobsCount: 0,
        }));
        expect(createSpy).not.toHaveBeenCalled();
    });

    test('REG-13/BG-70/BG-71: onStartup recupera fila, zera extractionTabs e reinicia processamento sem ficar preso', async () => {
        await storageMock.set({
            geminiBaseUrl: 'http://127.0.0.1:3999/app',
            maxConcurrentJobs: 1,
            mt_state: {
                jobQueue: [
                    { mangaTabId: 42, index: 0, prompt: 'A' },
                    { mangaTabId: 42, index: 1, prompt: 'B' },
                ],
                isProcessing: true,
                stopRequested: false,
                activeMangaTabId: 42,
                extractionTabs: {
                    7001: { mangaTabId: 42, index: 0, geminiTabId: 9001 },
                },
                totalJobs: 2,
                completedJobs: 0,
                activeJobsCount: 2,
            },
        });

        await runtimeMock._simulateStartup();

        await waitFor(async () => {
            const data = await storageMock.get(['mt_state', 'translatorLog']);
            return (data.mt_state && Array.isArray(data.translatorLog) && tabsMock._tabs.size === 1) ? data : null;
        });

        const data = await storageMock.get(['mt_state', 'translatorLog']);
        expect(data.mt_state).toEqual(expect.objectContaining({
            isProcessing: false,
            activeMangaTabId: 42,
            extractionTabs: {},
            totalJobs: 2,
            completedJobs: 0,
            activeJobsCount: 1,
        }));
        expect(data.mt_state.jobQueue).toEqual([
            { mangaTabId: 42, index: 1, prompt: 'B' },
        ]);
        expect(data.translatorLog).toEqual(expect.arrayContaining([
            expect.objectContaining({ action: 'STARTUP_RECOVERY' }),
        ]));
        expect(tabsMock._tabs.size).toBe(1);
    });

    test('BG-72: onConnect registra listener de disconnect para porta keep-alive', async () => {
        const keepAlivePort = runtimeMock.connect({ name: 'gemini-keep-alive' });
        const genericPort = runtimeMock.connect({ name: 'generic-port' });

        expect(keepAlivePort._disconnectListeners).toHaveLength(1);
        expect(genericPort._disconnectListeners).toHaveLength(0);
    });

    test('BG-73: nextJobAlarm dispara processNextJob e abre a próxima aba Gemini', async () => {
        await storageMock.set({ geminiBaseUrl: 'http://127.0.0.1:3999/app' });
        backgroundModule.__setState({
            jobQueue: [{ mangaTabId: 91, index: 5, prompt: 'job' }],
            stopRequested: false,
            activeJobsCount: 0,
            totalJobs: 1,
            completedJobs: 0,
            _cachedMaxCon: 1,
        });

        alarmsMock.create('nextJobAlarm', { delayInMinutes: 1 });
        alarmsMock._fire('nextJobAlarm');

        await waitFor(() => (tabsMock._tabs.size === 1 ? true : null));
        expect(tabsMock._tabs.size).toBe(1);
    });

    test('BG-74/BG-75/BG-76: watchdog com e sem wd_data trata timeout e fecha extraction tabs orfas', async () => {
        const mangaTab = await tabsMock.create({ url: 'https://reader.test/chapter-5', active: true });
        const extractionTab = await tabsMock.create({ url: 'https://cdn.reader.test/extracted.png', active: false });
        const forwardedMessages = [];
        const removeSpy = jest.spyOn(tabsMock, 'remove');

        tabsMock._registerMessageHandler(mangaTab.id, (message, _sender, sendResponse) => {
            forwardedMessages.push(message);
            sendResponse({ ok: true });
        });

        backgroundModule.__setState({
            extractionTabs: {
                [extractionTab.id]: { mangaTabId: mangaTab.id, index: 6, geminiTabId: 3003 },
            },
            activeJobsCount: 1,
            completedJobs: 0,
        });
        await storageMock.set({
            wd_data_3003: { mangaTabId: mangaTab.id, index: 6, geminiTabId: 3003 },
        });

        alarmsMock.create('watchdog_3003', { delayInMinutes: 4 });
        alarmsMock._fire('watchdog_3003');

        await waitFor(async () => {
            const data = await storageMock.get(['translatorLog']);
            return forwardedMessages.find(message => message.action === 'SHOW_ERROR_INTEGRATED') && (data.translatorLog || []).length > 0 ? data : null;
        });

        expect(forwardedMessages).toContainEqual(expect.objectContaining({
            action: 'SHOW_ERROR_INTEGRATED',
            imgIndex: 6,
            isDebug: false,
        }));
        expect(removeSpy).toHaveBeenCalledWith(extractionTab.id, expect.any(Function));
        expect(tabsMock._tabs.has(extractionTab.id)).toBe(false);
        expect(backgroundModule.__getState().activeJobsCount).toBe(0);

        const logsAfterTimeout = await storageMock.get(['translatorLog']);
        expect(logsAfterTimeout.translatorLog).toEqual(expect.arrayContaining([
            expect.objectContaining({ action: 'JOB_TIMEOUT' }),
        ]));

        removeSpy.mockClear();
        forwardedMessages.length = 0;
        alarmsMock.create('watchdog_9999', { delayInMinutes: 4 });
        alarmsMock._fire('watchdog_9999');
        await flush(6);

        expect(removeSpy).not.toHaveBeenCalled();
        expect(forwardedMessages).toEqual([]);
    });
});
