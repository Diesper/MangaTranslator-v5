const path = require('path');
const { IDBFactory } = require('fake-indexeddb');

const { loadBackgroundModule } = require('../helpers/load-background-module.js');
const {
    flushAsyncTasks,
    loadExtensionPage,
} = require('../helpers/load-extension-page.js');
const {
    getStorageMock,
    getTabsMock,
} = require('../mocks/chrome-api.mock.js');
const {
    createIndexedDbRepository,
    createInMemoryRepository,
} = require('../../extension/gtc-indexeddb.js');

if (typeof globalThis.structuredClone !== 'function') {
    globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));
}

const ROOT = path.join(__dirname, '..', '..');
const BACKGROUND_PATH = path.join(ROOT, 'extension', 'background.js');
const MB = 1024 * 1024;

function delay(ms = 0) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(assertion, { timeout = 2500, interval = 5 } = {}) {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeout) {
        const result = await assertion();
        if (result) return result;
        await delay(interval);
    }
    throw new Error('Timeout aguardando condicao de performance');
}

function uniqueDbName(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createFifteenJobBatch(mangaTabId = 9001) {
    return Array.from({ length: 15 }, (_, index) => ({
        mangaTabId,
        index,
        prompt: `Translate page ${index}`,
    }));
}

function createFifteenPageImages(sizeBytes = 1024) {
    const payload = 'A'.repeat(sizeBytes);
    return Array.from({ length: 15 }, (_, index) => ({
        hash: `page-${index}`,
        translatedDataUrl: `data:image/png;base64,${payload}${String(index).padStart(2, '0')}`,
        cleanUrl: `https://reader.test/chapter/page-${index}.png`,
        width: 800,
        height: 1200,
    }));
}

function createHundredHashes() {
    return Array.from({ length: 100 }, (_, index) => `page-${index}`);
}

async function getTranslatorLog(storageMock) {
    const data = await storageMock.get(['translatorLog']);
    return data.translatorLog || [];
}

async function setWithLastError(items) {
    return new Promise(resolve => {
        chrome.storage.local.set(items, () => {
            const err = chrome.runtime.lastError
                ? new Error(chrome.runtime.lastError.message)
                : null;
            resolve(err);
        });
    });
}

function installQuotaFailingStorage(byteLimit) {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    const quotaFailures = [];

    jest.spyOn(chrome.storage.local, 'set').mockImplementation((items, callback) => {
        const serializedBytes = Buffer.byteLength(JSON.stringify(items || {}), 'utf8');
        if (serializedBytes > byteLimit) {
            quotaFailures.push(Object.keys(items || {}));
            chrome.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
            setTimeout(() => {
                if (callback) callback();
                chrome.runtime.lastError = null;
            }, 0);
            return Promise.resolve();
        }
        return originalSet(items, callback);
    });

    return quotaFailures;
}

async function saveImagesWithIndexedDbFallback({
    storageKey,
    imagesByIndex,
    repository,
}) {
    const savedInStorage = {};
    const fallbackEntries = [];

    for (const [index, translatedDataUrl] of Object.entries(imagesByIndex)) {
        const err = await setWithLastError({ [`${storageKey}_${index}`]: translatedDataUrl });
        if (err) {
            fallbackEntries.push({
                hash: `${storageKey}-${index}`,
                translatedDataUrl,
                cleanUrl: `quota://${storageKey}/${index}`,
            });
        } else {
            savedInStorage[index] = translatedDataUrl;
        }
    }

    if (fallbackEntries.length) {
        await repository.putMany(fallbackEntries);
    }

    if (Object.keys(savedInStorage).length) {
        await setWithLastError({ [storageKey]: savedInStorage });
    }

    return {
        storageCount: Object.keys(savedInStorage).length,
        fallbackCount: fallbackEntries.length,
        fallbackHashes: fallbackEntries.map(entry => entry.hash),
    };
}

describe('PERF-01/PERF-02/PERF-03/PERF-04/PERF-05/PERF-06/PERF-07/PERF-08/PERF-09: limites de performance e storage', () => {
    let storageMock;
    let tabsMock;

    beforeEach(async () => {
        jest.resetModules();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        await storageMock.clear();
        tabsMock._tabs.clear();
        document.documentElement.innerHTML = '<html><head></head><body></body></html>';
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('PERF-01 processa 500 chamadas log em burst com batching efetivo', async () => {
        const backgroundModule = loadBackgroundModule(BACKGROUND_PATH);
        await flushAsyncTasks(4);
        await storageMock.clear();

        const setSpy = jest.spyOn(chrome.storage.local, 'set');
        const startedAt = performance.now();

        for (let index = 0; index < 500; index += 1) {
            backgroundModule.log('info', 'perf', 'LOG_BURST', `entry-${index}`, { index });
        }

        await waitFor(async () => (await getTranslatorLog(storageMock)).length === 500, {
            timeout: 1000,
        });

        const elapsedMs = performance.now() - startedAt;
        const logSetCalls = setSpy.mock.calls.filter(([items]) => items && items.translatorLog);

        expect(elapsedMs).toBeLessThanOrEqual(200);
        expect(await getTranslatorLog(storageMock)).toHaveLength(500);
        expect(logSetCalls.length).toBeLessThanOrEqual(10);
    });

    test('PERF-02 _flushLog preserva cap de 500 entradas no translatorLog', async () => {
        const backgroundModule = loadBackgroundModule(BACKGROUND_PATH);
        await flushAsyncTasks(4);

        const existingEntries = Array.from({ length: 500 }, (_, index) => ({
            id: `old-${index}`,
            ts: index,
            level: 'info',
            source: 'perf',
            action: 'OLD_ENTRY',
            detail: `old-${index}`,
            extra: {},
        }));
        await storageMock.set({ translatorLog: existingEntries });

        backgroundModule.log('info', 'perf', 'NEW_ENTRY', 'newest entry');

        await waitFor(async () => {
            const log = await getTranslatorLog(storageMock);
            return log.length === 500 && log[499].action === 'NEW_ENTRY';
        });

        const log = await getTranslatorLog(storageMock);
        expect(log).toHaveLength(500);
        expect(log[0].id).toBe('old-1');
        expect(log[499]).toEqual(expect.objectContaining({
            action: 'NEW_ENTRY',
            detail: 'newest entry',
        }));
    });

    test('PERF-03 getMany consulta 100 hashes com 15 hits e 85 misses em ate 500ms', async () => {
        const repo = createInMemoryRepository();
        await repo.putMany(createFifteenPageImages(256));

        const startedAt = performance.now();
        const result = await repo.getMany(createHundredHashes());
        const elapsedMs = performance.now() - startedAt;

        expect(elapsedMs).toBeLessThanOrEqual(500);
        expect(Object.keys(result)).toHaveLength(15);
        expect(result['page-0']).toContain('data:image/png;base64,');
        expect(result['page-99']).toBeUndefined();
    });

    test('PERF-04 putMany salva 15 imagens pequenas sem truncar nem sobrescrever', async () => {
        const repo = createInMemoryRepository();
        const entries = createFifteenPageImages(1024);

        const startedAt = performance.now();
        await expect(repo.putMany(entries)).resolves.toEqual({ saved: true, count: 15 });
        const elapsedMs = performance.now() - startedAt;

        const result = await repo.getMany(entries.map(entry => entry.hash));

        expect(elapsedMs).toBeLessThanOrEqual(300);
        expect(Object.keys(result)).toHaveLength(15);
        entries.forEach(entry => {
            expect(result[entry.hash]).toBe(entry.translatedDataUrl);
        });
    });

    test('PERF-05 popup renderiza 200 capitulos com 15 paginas cada em ate 1s', async () => {
        const tab = await tabsMock.create({ url: 'https://reader.test/chapter-live', active: true });
        tabsMock._registerMessageHandler(tab.id, (message, _sender, sendResponse) => {
            if (message.action === 'GET_PAGE_IMAGES') sendResponse({ images: [] });
            else sendResponse({ success: true });
        });

        const storagePayload = {
            enabledDomains: ['reader.test'],
            chapterList: Array.from({ length: 200 }, (_, index) => ({
                id: `chap_${index}`,
                url: `https://reader.test/manga/chapter-${index}`,
                title: `Chapter ${String(index).padStart(3, '0')}`,
                timestamp: 1700000000000 + index,
            })),
            'siteMeta_reader.test': { title: 'Reader Test' },
        };
        for (let chap = 0; chap < 200; chap += 1) {
            storagePayload[`chap_${chap}_images`] = Object.fromEntries(
                Array.from({ length: 15 }, (_, page) => [
                    page,
                    `data:image/png;base64,${String(chap).padStart(3, '0')}${String(page).padStart(2, '0')}`,
                ])
            );
        }
        await storageMock.set(storagePayload);

        const heapBefore = process.memoryUsage ? process.memoryUsage().heapUsed : 0;
        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });

        const startedAt = performance.now();
        document.querySelector('[data-target="translated-tab"]').click();

        await waitFor(() => document.querySelectorAll('#chapter-list .chapter-item').length === 200, {
            timeout: 1000,
        });
        await flushAsyncTasks(8);

        const elapsedMs = performance.now() - startedAt;
        const heapAfter = process.memoryUsage ? process.memoryUsage().heapUsed : heapBefore;
        const heapDeltaMb = (heapAfter - heapBefore) / MB;

        expect(elapsedMs).toBeLessThanOrEqual(1000);
        expect(document.querySelectorAll('#chapter-list .site-folder')).toHaveLength(1);
        expect(document.querySelectorAll('#chapter-list .chapter-item')).toHaveLength(200);
        expect(document.querySelector('#chapter-list .chapter-item').textContent).toMatch(/15\s+p.g\./);
        if (heapBefore && heapAfter >= heapBefore) {
            expect(heapDeltaMb).toBeLessThan(150);
        }
    });

    test('PERF-06 maxConcurrentJobs=10 processa 15 jobs em duas ondas sem exceder limite', async () => {
        const backgroundModule = loadBackgroundModule(BACKGROUND_PATH);
        await storageMock.set({ debugMode: true });
        backgroundModule.__setState({
            jobQueue: createFifteenJobBatch(),
            isProcessing: true,
            stopRequested: false,
            activeJobsCount: 0,
            totalJobs: 15,
            completedJobs: 0,
            _cachedMaxCon: 10,
        });

        const createSpy = jest.spyOn(chrome.tabs, 'create');

        await backgroundModule.processNextJob();
        await waitFor(() => createSpy.mock.calls.length === 10);

        let state = backgroundModule.__getState();
        expect(state.activeJobsCount).toBe(10);
        expect(state.jobQueue).toHaveLength(5);

        const firstWaveTabIds = Array.from(tabsMock._tabs.keys());
        firstWaveTabIds.forEach(tabId => backgroundModule.finalizeJob(tabId, 9001, false));

        await waitFor(() => createSpy.mock.calls.length === 15);
        state = backgroundModule.__getState();

        expect(state.activeJobsCount).toBeLessThanOrEqual(10);
        expect(state.jobQueue).toHaveLength(0);
        expect(createSpy).toHaveBeenCalledTimes(15);
    });

    test('PERF-07 100 chamadas paralelas de processNextJob nao ultrapassam 5 jobs ativos', async () => {
        const backgroundModule = loadBackgroundModule(BACKGROUND_PATH);
        await storageMock.set({ debugMode: true });
        backgroundModule.__setState({
            jobQueue: createFifteenJobBatch(),
            isProcessing: true,
            stopRequested: false,
            activeJobsCount: 0,
            totalJobs: 15,
            completedJobs: 0,
            _cachedMaxCon: 5,
        });

        const originalCreate = chrome.tabs.create.bind(chrome.tabs);
        let maxActiveObserved = 0;
        const createSpy = jest.spyOn(chrome.tabs, 'create').mockImplementation((options, callback) => {
            maxActiveObserved = Math.max(
                maxActiveObserved,
                backgroundModule.__getState().activeJobsCount
            );
            return originalCreate(options, callback);
        });

        await Promise.all(Array.from({ length: 100 }, () => backgroundModule.processNextJob()));
        await waitFor(() => createSpy.mock.calls.length === 5);

        const finalized = new Set();
        while (finalized.size < 15) {
            const pendingTabs = Array.from(tabsMock._tabs.keys()).filter(tabId => !finalized.has(tabId));
            pendingTabs.forEach(tabId => {
                finalized.add(tabId);
                backgroundModule.finalizeJob(tabId, 9001, false);
            });
            await flushAsyncTasks(8);
            if (createSpy.mock.calls.length >= 15 && finalized.size >= 15) break;
            await waitFor(() => tabsMock._tabs.size > finalized.size || createSpy.mock.calls.length >= 15);
        }

        expect(createSpy).toHaveBeenCalledTimes(15);
        expect(maxActiveObserved).toBeLessThanOrEqual(5);
        expect(backgroundModule.__getState().jobQueue).toHaveLength(0);
    });

    test('PERF-08 IndexedDB persiste 15 imagens de aproximadamente 500KB em ate 2s', async () => {
        const repo = createIndexedDbRepository({
            indexedDbFactory: new IDBFactory(),
            dbName: uniqueDbName('perf-large-idb'),
        });
        const dataUrlSize = 500 * 1024;
        const entries = createFifteenPageImages(dataUrlSize);

        const startedAt = performance.now();
        await expect(repo.putMany(entries)).resolves.toEqual({ saved: true, count: 15 });
        const elapsedMs = performance.now() - startedAt;

        const result = await repo.getMany(entries.map(entry => entry.hash));
        expect(elapsedMs).toBeLessThanOrEqual(2000);
        expect(Object.keys(result)).toHaveLength(15);

        entries.forEach(entry => {
            const retrieved = result[entry.hash];
            expect(retrieved).toBeTruthy();
            expect(Math.abs(retrieved.length - entry.translatedDataUrl.length)).toBeLessThan(
                entry.translatedDataUrl.length * 0.01
            );
        });
    });

    test('PERF-09 quota em chrome.storage.local aciona lastError e envia oversized para IndexedDB', async () => {
        const repository = createInMemoryRepository();
        const quotaFailures = installQuotaFailingStorage(5 * MB);
        const largeDataUrl = `data:image/png;base64,${'B'.repeat((5 * MB) + 1024)}`;
        const smallDataUrl = `data:image/png;base64,${'C'.repeat(256 * 1024)}`;
        const imagesByIndex = Object.fromEntries(
            Array.from({ length: 15 }, (_, index) => [
                index,
                index % 3 === 0 ? smallDataUrl : largeDataUrl,
            ])
        );

        const result = await saveImagesWithIndexedDbFallback({
            storageKey: 'chap_perf_images',
            imagesByIndex,
            repository,
        });

        const fallbackEntries = await repository.getMany(result.fallbackHashes);
        const stored = await storageMock.get(['chap_perf_images']);

        expect(quotaFailures).toHaveLength(10);
        expect(result).toEqual(expect.objectContaining({
            storageCount: 5,
            fallbackCount: 10,
        }));
        expect(Object.keys(fallbackEntries)).toHaveLength(10);
        Object.values(fallbackEntries).forEach(value => {
            expect(value.length).toBeGreaterThan(5 * MB);
        });
        expect(Object.keys(stored.chap_perf_images)).toHaveLength(5);
    });
});
