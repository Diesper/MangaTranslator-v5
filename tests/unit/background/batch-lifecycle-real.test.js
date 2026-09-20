const path = require('path');

const {
    getRuntimeMock,
    getStorageMock,
    getTabsMock,
    getAlarmsMock,
} = require('../../mocks/chrome-api.mock.js');

const BACKGROUND_PATH = path.resolve(__dirname, '../../../extension/background.js');

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function flush(rounds = 6) {
    for (let i = 0; i < rounds; i++) {
        await delay(0);
    }
}

async function waitFor(assertion, { timeout = 2000, interval = 10 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        const result = await assertion();
        if (result) return result;
        await delay(interval);
    }
    throw new Error('Timeout aguardando condição assíncrona');
}

function getBackgroundListener(runtimeMock) {
    const listeners = runtimeMock._messageListeners || [];
    if (listeners.length !== 1) {
        throw new Error(`Esperava 1 listener do background, recebi ${listeners.length}`);
    }
    return listeners[0];
}

function dispatchToBackground(runtimeMock, request, sender = { tab: null }) {
    return new Promise((resolve) => {
        let settled = false;
        let keepAlive = false;

        const sendResponse = (response) => {
            settled = true;
            resolve({ keepAlive, response });
        };

        keepAlive = getBackgroundListener(runtimeMock)(request, sender, sendResponse);
        if (keepAlive === false && !settled) {
            resolve({ keepAlive, response: undefined });
        }
    });
}

async function getSingleGeminiJob(storageMock) {
    const data = await storageMock.get(null);
    const key = Object.keys(data).find(item => item.startsWith('gemini_job_'));
    if (!key) return null;
    return { key, value: data[key], tabId: Number(key.replace('gemini_job_', '')) };
}

describe('background.js - lifecycle real do batch', () => {
    let runtimeMock;
    let storageMock;
    let tabsMock;
    let alarmsMock;

    beforeEach(async () => {
        jest.resetModules();

        runtimeMock = getRuntimeMock();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        alarmsMock = getAlarmsMock();

        runtimeMock._messageListeners = [];
        runtimeMock._connectListeners = [];
        runtimeMock.lastError = null;

        await storageMock.clear();

        jest.isolateModules(() => {
            require(BACKGROUND_PATH);
        });

        await flush();
    });

    afterEach(async () => {
        alarmsMock.clearAll();
        tabsMock._tabs.clear();
        await storageMock.clear();
    });

    test('START_BATCH cria a primeira aba Gemini, persiste gemini_job e atualiza mt_state real', async () => {
        await storageMock.set({
            maxConcurrentJobs: 1,
            geminiBaseUrl: 'http://127.0.0.1:3999/app',
        });

        const start = await dispatchToBackground(runtimeMock, {
            action: 'START_BATCH',
            mangaTabId: 77,
            prompt: 'Traduzir',
            images: [{ index: 4 }, { index: 9 }],
        });

        expect(start.response).toEqual({ ok: true });

        await waitFor(async () => {
            const data = await storageMock.get(['mt_state']);
            const job = await getSingleGeminiJob(storageMock);
            return data.mt_state && job;
        });

        const state = await storageMock.get(['mt_state']);
        const geminiJob = await getSingleGeminiJob(storageMock);
        const geminiTabId = geminiJob.tabId;
        expect(state.mt_state).toEqual(expect.objectContaining({
            isProcessing: true,
            activeMangaTabId: 77,
            totalJobs: 2,
            activeJobsCount: 1,
        }));
        expect(state.mt_state.jobQueue).toEqual([{ mangaTabId: 77, index: 9, prompt: 'Traduzir' }]);
        expect(geminiJob.value).toEqual(expect.objectContaining({
            mangaTabId: 77,
            index: 4,
            prompt: 'Traduzir',
            geminiTabId,
        }));

        const geminiTab = tabsMock._tabs.get(geminiTabId);
        expect(geminiTab.url).toContain('jobIndex=4');
        expect(geminiTab.active).toBe(false);
    });

    test('GEMINI_RESULT_URL registra aba de extracao e CHECK_IF_EXTRACTION_TAB reconhece o mapeamento', async () => {
        await storageMock.set({
            maxConcurrentJobs: 1,
            geminiBaseUrl: 'https://example.com/mock',
        });

        await dispatchToBackground(runtimeMock, {
            action: 'START_BATCH',
            mangaTabId: 88,
            prompt: 'Traduzir',
            images: [{ index: 1 }],
        });

        const geminiJob = await waitFor(() => getSingleGeminiJob(storageMock));
        const geminiTabId = geminiJob.tabId;
        const beforeIds = new Set(tabsMock._tabs.keys());

        const extraction = await dispatchToBackground(runtimeMock, {
            action: 'GEMINI_RESULT_URL',
            mangaTabId: 88,
            index: 1,
            url: 'https://cdn.reader.test/result.png',
        }, { tab: { id: geminiTabId } });

        expect(extraction.response).toEqual({ ok: true });
        const extractionTabId = await waitFor(() => {
            const newId = [...tabsMock._tabs.keys()].find(id => !beforeIds.has(id));
            return newId || null;
        });

        const lookup = await waitFor(async () => {
            const result = await dispatchToBackground(runtimeMock, {
                action: 'CHECK_IF_EXTRACTION_TAB',
            }, { tab: { id: extractionTabId } });
            return result.response && result.response.isExtractionTab ? result : null;
        });

        expect(lookup.response).toEqual({
            isExtractionTab: true,
            mangaTabId: 88,
            index: 1,
            geminiTabId,
        });
    });

    test('STOP_BATCH limpa estado, jobs persistidos e abas abertas do fluxo real', async () => {
        await storageMock.set({
            maxConcurrentJobs: 1,
            geminiBaseUrl: 'https://example.com/mock',
        });

        await dispatchToBackground(runtimeMock, {
            action: 'START_BATCH',
            mangaTabId: 91,
            prompt: 'Traduzir',
            images: [{ index: 1 }, { index: 2 }],
        });

        const geminiJob = await waitFor(() => getSingleGeminiJob(storageMock));
        const geminiTabId = geminiJob.tabId;
        const beforeIds = new Set(tabsMock._tabs.keys());

        await dispatchToBackground(runtimeMock, {
            action: 'GEMINI_RESULT_URL',
            mangaTabId: 91,
            index: 1,
            url: 'https://cdn.reader.test/result.png',
        }, { tab: { id: geminiTabId } });

        await waitFor(() => {
            const newId = [...tabsMock._tabs.keys()].find(id => !beforeIds.has(id));
            return newId || null;
        });

        const stop = await dispatchToBackground(runtimeMock, {
            action: 'STOP_BATCH',
        });

        expect(stop.response).toEqual({ ok: true });
        await flush(10);

        const data = await storageMock.get(null);
        expect(tabsMock._tabs.size).toBe(0);
        expect(Object.keys(data).filter(key => key.startsWith('gemini_job_'))).toHaveLength(0);
        expect(Object.keys(data).filter(key => key.startsWith('wd_data_'))).toHaveLength(0);
        expect(data.mt_state).toEqual(expect.objectContaining({
            stopRequested: true,
            isProcessing: false,
            activeJobsCount: 0,
            activeMangaTabId: null,
        }));
        expect(data.mt_state.jobQueue).toEqual([]);
    });

    test('watchdog real envia erro integrado para a aba de manga e limpa o job ativo', async () => {
        const mangaTab = await tabsMock.create({ url: 'https://reader.test/chapter-1', active: true });
        const forwardedMessages = [];

        tabsMock._registerMessageHandler(mangaTab.id, (message, _sender, sendResponse) => {
            forwardedMessages.push(message);
            sendResponse({ ok: true });
        });

        await storageMock.set({
            maxConcurrentJobs: 1,
            geminiBaseUrl: 'https://example.com/mock',
        });

        await dispatchToBackground(runtimeMock, {
            action: 'START_BATCH',
            mangaTabId: mangaTab.id,
            prompt: 'Traduzir',
            images: [{ index: 5 }],
        });

        const geminiJob = await waitFor(() => getSingleGeminiJob(storageMock));
        const geminiTabId = geminiJob.tabId;

        expect(await storageMock.get([`wd_data_${geminiTabId}`])).toEqual(expect.objectContaining({
            [`wd_data_${geminiTabId}`]: expect.objectContaining({
                mangaTabId: mangaTab.id,
                index: 5,
                geminiTabId,
            }),
        }));

        alarmsMock._fire(`watchdog_${geminiTabId}`);
        await flush(10);
        await delay(650);

        expect(forwardedMessages).toContainEqual(expect.objectContaining({
            action: 'SHOW_ERROR_INTEGRATED',
            imgIndex: 5,
        }));

        const state = await storageMock.get(null);
        expect(tabsMock._tabs.has(geminiTabId)).toBe(false);
        expect(state[`gemini_job_${geminiTabId}`]).toBeUndefined();
        expect(state[`wd_data_${geminiTabId}`]).toBeUndefined();
        expect(state.mt_state.activeJobsCount).toBe(0);
    });
});
