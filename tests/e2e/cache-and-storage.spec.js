const { test, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getBrowserModeConfig() {
    const rawMode = String(process.env.MANGA_E2E_BROWSER_MODE || 'stealth').trim().toLowerCase();
    const showBrowser = ['show', 'visible', 'headed', 'ui'].includes(rawMode);

    return {
        mode: showBrowser ? 'show' : 'stealth',
        showBrowser,
        slowMo: showBrowser ? 350 : 0,
    };
}

function getExtensionPath(startDir) {
    let dir = startDir;

    while (dir !== path.parse(dir).root) {
        const candidate = path.join(dir, 'extension');
        if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
        dir = path.dirname(dir);
    }

    return path.join(process.cwd(), 'extension');
}

async function getBackgroundWorker(context) {
    const existingWorker = context.serviceWorkers()[0];
    if (existingWorker) return existingWorker;
    return context.waitForEvent('serviceworker', { timeout: 15000 });
}

async function resetExtensionState(backgroundWorker) {
    await backgroundWorker.evaluate(() => {
        return new Promise(resolve => {
            chrome.storage.local.clear(() => {
                chrome.storage.local.set({
                    enabledDomains: ['localhost', '127.0.0.1'],
                    debugMode: false,
                    maxConcurrentJobs: 1,
                    geminiBaseUrl: 'http://127.0.0.1:3999/gemini/',
                    defaultPrompt: 'Teste E2E controlado do fluxo MV3.',
                    translatorLog: [],
                    deleting_urls: [],
                    chapterList: [],
                    mt_state: {
                        jobQueue: [],
                        isProcessing: false,
                        stopRequested: false,
                        activeMangaTabId: null,
                        extractionTabs: {},
                        totalJobs: 0,
                        completedJobs: 0,
                        activeJobsCount: 0,
                    },
                }, resolve);
            });
        });
    });

    await backgroundWorker.evaluate(async () => {
        if (!self.indexedDB || typeof self.indexedDB.open !== 'function') return;

        if (typeof self.indexedDB.databases === 'function') {
            try {
                const databases = await self.indexedDB.databases();
                if (databases.some(db => db.name === 'manga_translator_gtc')) {
                    await new Promise(resolve => {
                        const req = self.indexedDB.open('manga_translator_gtc');
                        req.onerror = () => resolve();
                        req.onsuccess = () => {
                            const db = req.result;
                            if (!db.objectStoreNames.contains('translations')) {
                                db.close();
                                resolve();
                                return;
                            }
                            const tx = db.transaction('translations', 'readwrite');
                            tx.objectStore('translations').clear();
                            tx.oncomplete = () => { db.close(); resolve(); };
                            tx.onerror = () => { db.close(); resolve(); };
                        };
                    });
                }
            } catch (_e) {}
        }

        if (self.MangaTranslatorStorageManager && typeof self.MangaTranslatorStorageManager.openStorageDb === 'function') {
            try {
                const db = await self.MangaTranslatorStorageManager.openStorageDb();
                const storeNames = ['chapters', 'chapterPages', 'restoreEntries', 'assets'].filter(name => db.objectStoreNames.contains(name));
                if (storeNames.length > 0) {
                    await new Promise(resolve => {
                        const tx = db.transaction(storeNames, 'readwrite');
                        storeNames.forEach(name => tx.objectStore(name).clear());
                        tx.oncomplete = () => resolve();
                        tx.onerror = () => resolve();
                    });
                }
            } catch (_e) {}
        }
    });
}

async function readStorage(backgroundWorker, keys) {
    return backgroundWorker.evaluate(async requestedKeys => {
        return new Promise(resolve => chrome.storage.local.get(requestedKeys, resolve));
    }, keys);
}

async function removeGeminiTabs(backgroundWorker) {
    await backgroundWorker.evaluate(async () => {
        const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve));
        const geminiIds = tabs
            .filter(tab => tab.url && tab.url.includes('127.0.0.1:3999/gemini'))
            .map(tab => tab.id);

        if (geminiIds.length > 0) {
            await new Promise(resolve => chrome.tabs.remove(geminiIds, resolve));
        }
    });
}

async function countGeminiTabs(backgroundWorker) {
    return backgroundWorker.evaluate(async () => {
        const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve));
        return tabs.filter(tab => tab.url && tab.url.includes('127.0.0.1:3999/gemini')).length;
    });
}

async function waitForTranslationOnPage(page) {
    await expect.poll(async () => {
        return page.evaluate(() => {
            return Array.from(document.querySelectorAll('img[data-translated="true"]')).length;
        });
    }, {
        timeout: 45000,
        message: 'Esperava imagens traduzidas no DOM da página',
    }).toBe(2);
}

async function waitForRestoreMap(backgroundWorker, chapterUrl) {
    await expect.poll(async () => {
        return backgroundWorker.evaluate(async (url) => {
            const storage = await new Promise(resolve => chrome.storage.local.get(['chapterList'], resolve));
            const chapter = (storage.chapterList || []).find(item => item.url === url);
            if (!chapter) return 0;
            if (self.MangaTranslatorStorageManager) {
                const map = await self.MangaTranslatorStorageManager.getRestoreIndex(chapter.id);
                return Object.keys(map || {}).length;
            }
            return 0;
        }, chapterUrl);
    }, {
        timeout: 15000,
        message: 'Esperava restoreMap persistido para o capitulo antes do reload',
    }).toBe(2);
}

let browserContext;
let backgroundWorker;

test.describe('E2E-23/E2E-24/E2E-25: E2E - cache e persistencia do content_manga', () => {
    test.beforeAll(async () => {
        const pathToExtension = getExtensionPath(__dirname);
        const userDataDir = path.join(os.tmpdir(), `pw-manga-cache-${Date.now()}`);
        const browserMode = getBrowserModeConfig();
        const launchArgs = [
            `--disable-extensions-except=${pathToExtension}`,
            `--load-extension=${pathToExtension}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ];

        if (!browserMode.showBrowser) launchArgs.unshift('--headless=new');

        browserContext = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            slowMo: browserMode.slowMo,
            args: launchArgs,
        });

        backgroundWorker = await getBackgroundWorker(browserContext);
    });

    test.afterAll(async () => {
        if (browserContext) await browserContext.close();
    });

    test.beforeEach(async () => {
        backgroundWorker = await getBackgroundWorker(browserContext);
        await resetExtensionState(backgroundWorker);
    });

    test('salva as paginas traduzidas no storage do capitulo real', async () => {
        const page = await browserContext.newPage();

        await page.goto('http://localhost:3999/manga-page.html');
        await page.waitForLoadState('networkidle');

        const mainContent = page.locator('#manga-main-content');
        await expect(mainContent).toBeVisible({ timeout: 10000 });

        await mainContent.click();
        await waitForTranslationOnPage(page);

        backgroundWorker = await getBackgroundWorker(browserContext);
        const storage = await readStorage(backgroundWorker, null);
        const chapterList = storage.chapterList || [];
        const chapter = chapterList.find(item => item.url === 'http://localhost:3999/manga-page.html');

        expect(chapter).toBeTruthy();

        // No v5.1, as páginas e o mapa de restauração são persistidos no StorageManager (IndexedDB)
        const smData = await backgroundWorker.evaluate(async (chapterId) => {
            const sm = self.MangaTranslatorStorageManager;
            if (!sm) return null;
            const page0 = await sm.getPageDataUrl(chapterId, 0);
            const page1 = await sm.getPageDataUrl(chapterId, 1);
            const restoreIndex = await sm.getRestoreIndex(chapterId);
            return {
                pages: { 0: page0, 1: page1 },
                restoreIndex,
            };
        }, chapter.id);

        expect(smData).toBeTruthy();
        expect(smData.pages[0]).toMatch(/^data:image\/png;base64,/);
        expect(smData.pages[1]).toMatch(/^data:image\/png;base64,/);
        expect(smData.restoreIndex).toEqual(expect.objectContaining({
            'http://localhost:3999/manga-images/page_001.png': expect.objectContaining({ index: 0 }),
            'http://localhost:3999/manga-images/page_002.png': expect.objectContaining({ index: 1 }),
        }));

        await page.close();
    });

    test('segunda traducao em host espelho usa o GTC sem abrir novas abas Gemini', async () => {
        const firstPage = await browserContext.newPage();

        await firstPage.goto('http://localhost:3999/manga-page.html');
        await firstPage.waitForLoadState('networkidle');
        await expect(firstPage.locator('#manga-main-content')).toBeVisible({ timeout: 10000 });

        await firstPage.locator('#manga-main-content').click();
        await waitForTranslationOnPage(firstPage);

        backgroundWorker = await getBackgroundWorker(browserContext);
        await removeGeminiTabs(backgroundWorker);
        expect(await countGeminiTabs(backgroundWorker)).toBe(0);

        const mirrorPage = await browserContext.newPage();
        await mirrorPage.goto('http://127.0.0.1:3999/manga-page.html');
        await mirrorPage.waitForLoadState('networkidle');
        await expect(mirrorPage.locator('#manga-main-content')).toBeVisible({ timeout: 10000 });

        await mirrorPage.locator('#manga-main-content').click();

        await expect.poll(async () => {
            return mirrorPage.evaluate(() => {
                return Array.from(document.querySelectorAll('img[data-translated="true"]')).length;
            });
        }, {
            timeout: 15000,
            message: 'Esperava reaplicacao das 2 imagens via cache GTC no host espelho',
        }).toBe(2);

        backgroundWorker = await getBackgroundWorker(browserContext);
        expect(await countGeminiTabs(backgroundWorker)).toBe(0);

        const storage = await readStorage(backgroundWorker, ['translatorLog']);
        const logActions = (storage.translatorLog || []).map(entry => entry.action);

        expect(logActions).toContain('GTC_BATCH_HIT');

        await firstPage.close();
        await mirrorPage.close();
    });

    test('reload da mesma pagina reaplica restoreMap sem abrir novas abas Gemini', async () => {
        const page = await browserContext.newPage();

        await page.goto('http://localhost:3999/manga-page.html');
        await page.waitForLoadState('networkidle');
        await expect(page.locator('#manga-main-content')).toBeVisible({ timeout: 10000 });

        await page.locator('#manga-main-content').click();
        await waitForTranslationOnPage(page);

        backgroundWorker = await getBackgroundWorker(browserContext);
        await waitForRestoreMap(backgroundWorker, 'http://localhost:3999/manga-page.html');
        await removeGeminiTabs(backgroundWorker);
        expect(await countGeminiTabs(backgroundWorker)).toBe(0);

        await page.reload({ waitUntil: 'networkidle' });
        await expect(page.locator('#manga-main-content')).toBeVisible({ timeout: 10000 });

        await expect.poll(async () => {
            return page.evaluate(() => {
                return Array.from(document.querySelectorAll('img[data-translated="true"]')).length;
            });
        }, {
            timeout: 15000,
            message: 'Esperava reaplicacao automatica via restoreMap apos reload',
        }).toBe(2);

        backgroundWorker = await getBackgroundWorker(browserContext);
        expect(await countGeminiTabs(backgroundWorker)).toBe(0);

        await page.close();
    });

    test('debug mode mantem abas Gemini abertas apos traduzir', async () => {
        const page = await browserContext.newPage();

        try {
            backgroundWorker = await getBackgroundWorker(browserContext);
            await backgroundWorker.evaluate(() => {
                return new Promise(resolve => chrome.storage.local.set({ debugMode: true }, resolve));
            });

            await page.goto('http://localhost:3999/manga-page.html');
            await page.waitForLoadState('networkidle');
            await expect(page.locator('#manga-main-content')).toBeVisible({ timeout: 10000 });

            await page.locator('#manga-main-content').click();
            await waitForTranslationOnPage(page);

            backgroundWorker = await getBackgroundWorker(browserContext);
            await expect.poll(async () => countGeminiTabs(backgroundWorker), {
                timeout: 10000,
                message: 'Esperava abas Gemini preservadas com debugMode=true',
            }).toBeGreaterThanOrEqual(2);
        } finally {
            backgroundWorker = await getBackgroundWorker(browserContext);
            await removeGeminiTabs(backgroundWorker);
            await page.close();
        }
    });
});
