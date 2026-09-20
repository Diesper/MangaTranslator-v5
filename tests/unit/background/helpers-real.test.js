const {
    getRuntimeMock,
    getStorageMock,
    getAlarmsMock,
    getTabsMock,
    getDownloadsMock,
} = require('../../mocks/chrome-api.mock.js');
const { loadBackgroundModule } = require('../../helpers/load-background-module.js');
const {
    BACKGROUND_PATH,
    flush,
    waitFor,
} = require('../../helpers/background-test-utils.js');

describe('background.js - helpers reais', () => {
    let runtimeMock;
    let storageMock;
    let alarmsMock;
    let tabsMock;
    let downloadsMock;
    let backgroundModule;

    beforeEach(async () => {
        jest.resetModules();

        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        alarmsMock = getAlarmsMock();
        tabsMock = getTabsMock();
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
        await storageMock.clear();
        jest.restoreAllMocks();
    });

    test('BG-01/BG-02: restoreState aplica defaults em storage vazio ou parcial', async () => {
        backgroundModule.__setState({
            jobQueue: [{ mangaTabId: 9, index: 9, prompt: 'stale' }],
            isProcessing: true,
            stopRequested: true,
            activeMangaTabId: 9,
            extractionTabs: { 5000: { index: 9 } },
            totalJobs: 9,
            completedJobs: 8,
            activeJobsCount: 7,
        });

        await storageMock.set({ mt_state: undefined });
        await backgroundModule.restoreState();

        expect(backgroundModule.__getState()).toEqual(expect.objectContaining({
            jobQueue: [{ mangaTabId: 9, index: 9, prompt: 'stale' }],
            isProcessing: true,
            stopRequested: true,
            activeMangaTabId: 9,
            extractionTabs: { 5000: { index: 9 } },
            totalJobs: 9,
            completedJobs: 8,
            activeJobsCount: 7,
        }));

        await storageMock.set({
            mt_state: {
                jobQueue: [{ mangaTabId: 11, index: 2, prompt: 'novo' }],
                completedJobs: 3,
            },
        });
        await backgroundModule.restoreState();

        expect(backgroundModule.__getState()).toEqual(expect.objectContaining({
            jobQueue: [{ mangaTabId: 11, index: 2, prompt: 'novo' }],
            isProcessing: false,
            stopRequested: false,
            activeMangaTabId: null,
            extractionTabs: {},
            totalJobs: 0,
            completedJobs: 3,
            activeJobsCount: 0,
        }));
    });

    test('BG-03/BG-04: syncState faz round-trip consistente e suporta concorrencia', async () => {
        const original = {
            jobQueue: [{ mangaTabId: 1, index: 7, prompt: 'a' }],
            isProcessing: true,
            stopRequested: false,
            activeMangaTabId: 1,
            extractionTabs: { 1234: { mangaTabId: 1, index: 7, geminiTabId: 321 } },
            totalJobs: 10,
            completedJobs: 4,
            activeJobsCount: 2,
        };

        backgroundModule.__setState(original);
        await backgroundModule.syncState();

        backgroundModule.__setState({
            jobQueue: [],
            isProcessing: false,
            stopRequested: true,
            activeMangaTabId: null,
            extractionTabs: {},
            totalJobs: 0,
            completedJobs: 0,
            activeJobsCount: 0,
        });
        await backgroundModule.restoreState();

        expect(backgroundModule.__getState()).toEqual(expect.objectContaining(original));

        const syncPromises = [];
        for (let index = 0; index < 10; index++) {
            backgroundModule.__setState({
                jobQueue: [{ mangaTabId: index, index, prompt: `p-${index}` }],
                isProcessing: index % 2 === 0,
                stopRequested: index % 3 === 0,
                activeMangaTabId: index,
                extractionTabs: {},
                totalJobs: index + 1,
                completedJobs: index,
                activeJobsCount: index % 4,
            });
            syncPromises.push(backgroundModule.syncState());
        }

        await Promise.all(syncPromises);

        const data = await storageMock.get(['mt_state']);
        expect(data.mt_state).toEqual(expect.objectContaining({
            jobQueue: [{ mangaTabId: 9, index: 9, prompt: 'p-9' }],
            isProcessing: false,
            stopRequested: true,
            activeMangaTabId: 9,
            extractionTabs: {},
            totalJobs: 10,
            completedJobs: 9,
            activeJobsCount: 1,
        }));
    });

    test('BG-05/BG-06/BG-08/BG-09: log faz batching, ids únicos e respeita a trava de flush', async () => {
        const setSpy = jest.spyOn(storageMock, 'set');
        setSpy.mockClear();

        backgroundModule.log('info', 'bg', 'ONE', 'primeira');
        await waitFor(async () => {
            const data = await storageMock.get(['translatorLog']);
            return (data.translatorLog || []).length === 1 ? data.translatorLog : null;
        });

        let translatorLogSetCalls = setSpy.mock.calls.filter(([items]) => items && items.translatorLog);
        expect(translatorLogSetCalls).toHaveLength(1);

        setSpy.mockClear();
        await storageMock.set({ translatorLog: [] });
        setSpy.mockClear();

        for (let index = 0; index < 20; index++) {
            backgroundModule.log('info', 'bg', 'BURST', `burst-${index}`, { index });
        }

        const burstEntries = await waitFor(async () => {
            const data = await storageMock.get(['translatorLog']);
            return (data.translatorLog || []).length === 20 ? data.translatorLog : null;
        });

        translatorLogSetCalls = setSpy.mock.calls.filter(([items]) => items && items.translatorLog);
        expect(translatorLogSetCalls.length).toBeLessThanOrEqual(2);

        const uniqueIds = new Set();
        burstEntries.forEach(entry => uniqueIds.add(entry.id));
        expect(uniqueIds.size).toBe(20);

        backgroundModule.__setState({ _logFlushing: true, _logQueue: [] });
        backgroundModule.log('info', 'bg', 'QUEUED', 'travado');
        expect(backgroundModule.__getState()._logQueue).toHaveLength(1);
        expect(backgroundModule.__getState()._logFlushing).toBe(true);
    });

    test('BG-07/BG-10: cap de 500 entradas e recuperacao apos falha no flush', async () => {
        const existing = Array.from({ length: 495 }, (_, index) => ({
            id: index,
            ts: index,
            level: 'info',
            source: 'seed',
            action: 'OLD',
            detail: `old-${index}`,
            extra: {},
        }));
        await storageMock.set({ translatorLog: existing });

        for (let index = 0; index < 10; index++) {
            backgroundModule.log('warn', 'bg', 'NEW', `new-${index}`);
        }

        const capped = await waitFor(async () => {
            const data = await storageMock.get(['translatorLog']);
            return (data.translatorLog || []).length === 500 ? data.translatorLog : null;
        });

        expect(capped).toHaveLength(500);
        expect(capped[0].detail).toBe('old-5');
        expect(capped[499].detail).toBe('new-9');

        await storageMock.set({ translatorLog: [] });
        backgroundModule.__setState({ _logQueue: [], _logFlushing: false });
        const originalSet = storageMock.set.bind(storageMock);
        let failedOnce = false;
        jest.spyOn(storageMock, 'set').mockImplementation((items, callback) => {
            if (!failedOnce && items && items.translatorLog) {
                failedOnce = true;
                return Promise.reject(new Error('storage down'));
            }
            return originalSet(items, callback);
        });

        backgroundModule.log('error', 'bg', 'FAIL_ONCE', 'primeira falha');
        await flush(8);

        expect(backgroundModule.__getState()._logFlushing).toBe(false);

        backgroundModule.log('info', 'bg', 'RECOVERED', 'segunda entrada');
        const recovered = await waitFor(async () => {
            const data = await storageMock.get(['translatorLog']);
            return (data.translatorLog || []).length >= 1 ? data.translatorLog : null;
        });

        expect(recovered.some(entry => entry.detail === 'segunda entrada')).toBe(true);
    });

    test('BG-11/BG-12/BG-13/BG-14/BG-15: armWatchdog e clearWatchdog orquestram alarme e storage', async () => {
        const createSpy = jest.spyOn(alarmsMock, 'create');
        const clearSpy = jest.spyOn(alarmsMock, 'clear');
        const removeSpy = jest.spyOn(storageMock, 'remove');

        backgroundModule.armWatchdog(55, 8, 2001);
        await flush(4);

        expect(createSpy).toHaveBeenCalledWith('watchdog_2001', { delayInMinutes: 4 });
        expect(await storageMock.get(['wd_data_2001'])).toEqual({
            wd_data_2001: { mangaTabId: 55, index: 8, geminiTabId: 2001 },
        });

        backgroundModule.armWatchdog(55, 9, 2001);
        await flush(4);

        expect(clearSpy).toHaveBeenCalledWith('watchdog_2001', expect.any(Function));
        expect(await storageMock.get(['wd_data_2001'])).toEqual({
            wd_data_2001: { mangaTabId: 55, index: 9, geminiTabId: 2001 },
        });

        backgroundModule.clearWatchdog(2001);
        await flush(4);

        expect(removeSpy).toHaveBeenCalledWith('wd_data_2001');
        expect(await alarmsMock.get('watchdog_2001')).toBeNull();
        expect(await storageMock.get(['wd_data_2001'])).toEqual({ wd_data_2001: undefined });

        expect(() => backgroundModule.clearWatchdog(undefined)).not.toThrow();
        expect(() => backgroundModule.clearWatchdog(null)).not.toThrow();
    });
});
