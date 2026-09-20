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

        const clearDb = (dbName, storeNames) => new Promise(resolve => {
            const req = self.indexedDB.open(dbName);
            req.onerror = () => resolve();
            req.onsuccess = () => {
                const db = req.result;
                const existing = storeNames.filter(name => db.objectStoreNames.contains(name));
                if (existing.length === 0) {
                    db.close();
                    resolve();
                    return;
                }
                const tx = db.transaction(existing, 'readwrite');
                existing.forEach(name => tx.objectStore(name).clear());
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); resolve(); };
            };
        });

        await clearDb('manga_translator_data', ['chapters', 'chapterPages', 'restoreEntries', 'assets']);
    });
}

function makeSvgDataUrl(label) {
    const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200">
            <rect width="800" height="1200" fill="#101010" />
            <text x="50%" y="50%" fill="#ffffff" font-size="72" text-anchor="middle">${label}</text>
        </svg>
    `;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

async function seedReaderChapter(backgroundWorker, {
    chapterId = 'chap_reader_e2e',
    title = 'Capitulo E2E do Reader',
    indices = [0, 2, 5, 8, 10, 11, 14, 20, 33, 50, 51, 77, 88, 99, 200],
} = {}) {
    const images = {};
    indices.forEach(index => {
        images[index] = makeSvgDataUrl(`idx-${index}`);
    });

    await backgroundWorker.evaluate(async ({ chapterId, title, images }) => {
        await new Promise(resolve => {
            chrome.storage.local.set({
                chapterList: [{
                    id: chapterId,
                    title,
                    url: 'http://localhost:3999/manga-page.html',
                    timestamp: Date.now(),
                }],
                [`${chapterId}_images`]: images,
            }, resolve);
        });
    }, { chapterId, title, images });

    return chapterId;
}

async function getReaderUrl(backgroundWorker, chapterId) {
    return backgroundWorker.evaluate(async requestedChapterId => {
        return `${chrome.runtime.getURL('reader.html')}?id=${encodeURIComponent(requestedChapterId)}`;
    }, chapterId);
}

let browserContext;
let backgroundWorker;

test.describe('E2E-19/E2E-20/E2E-21/E2E-22: E2E - reader offline real', () => {
    test.beforeAll(async () => {
        const pathToExtension = getExtensionPath(__dirname);
        const userDataDir = path.join(os.tmpdir(), `pw-manga-reader-${Date.now()}`);
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
            viewport: { width: 1280, height: 720 },
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

    test('renderiza paginas salvas em ordem numerica correta e contador inicial consistente', async () => {
        const chapterId = await seedReaderChapter(backgroundWorker, {});
        const readerPage = await browserContext.newPage();
        const readerUrl = await getReaderUrl(backgroundWorker, chapterId);

        await readerPage.goto(readerUrl);
        await expect(readerPage.locator('.reader-page-wrap')).toHaveCount(15, { timeout: 10000 });

        const decodeSrc = src => {
            if (!src) return '';
            if (src.includes(';base64,')) {
                return Buffer.from(src.split(';base64,')[1], 'base64').toString('utf8');
            }
            return decodeURIComponent(src);
        };

        const firstImg = readerPage.locator('.reader-page-wrap img').first();
        await expect(firstImg).toHaveAttribute('src', /.+/, { timeout: 10000 });
        const firstSrc = await firstImg.getAttribute('src');
        expect(decodeSrc(firstSrc)).toContain('idx-0');

        await expect(readerPage.locator('#chapter-title')).toHaveText('Capitulo E2E do Reader');
        await expect(readerPage.locator('#page-counter')).toHaveText('1 / 15');
        await expect(readerPage.locator('.page-label').first()).toHaveText('1');
        await expect(readerPage.locator('.page-label').last()).toHaveText('15');

        // O reader utiliza IntersectionObserver (lazy loading), portanto a última página (idx-200)
        // é carregada sob demanda ao rolar até ela
        const lastWrap = readerPage.locator('.reader-page-wrap').last();
        await lastWrap.scrollIntoViewIfNeeded();
        const lastImg = lastWrap.locator('img');
        await expect(lastImg).toHaveAttribute('src', /.+/, { timeout: 10000 });
        const lastSrc = await lastImg.getAttribute('src');
        expect(decodeSrc(lastSrc)).toContain('idx-200');

        await readerPage.close();
    });

    test('slider de largura persiste no localStorage ao reabrir o reader', async () => {
        const chapterId = await seedReaderChapter(backgroundWorker, {
            chapterId: 'chap_reader_width',
            indices: [0, 1, 2],
        });
        const readerUrl = await getReaderUrl(backgroundWorker, chapterId);

        const firstPage = await browserContext.newPage();
        await firstPage.goto(readerUrl);
        await expect(firstPage.locator('.reader-page-wrap')).toHaveCount(3, { timeout: 10000 });

        await firstPage.locator('#width-slider').evaluate((node, value) => {
            node.value = String(value);
            node.dispatchEvent(new Event('input', { bubbles: true }));
        }, 1000);

        await expect(firstPage.locator('#width-val')).toHaveText('1000px');
        await expect(firstPage.locator('#reader-container')).toHaveCSS('max-width', '1000px');
        await firstPage.close();

        const reopenedPage = await browserContext.newPage();
        await reopenedPage.goto(readerUrl);
        await expect(reopenedPage.locator('.reader-page-wrap')).toHaveCount(3, { timeout: 10000 });

        await expect(reopenedPage.locator('#width-slider')).toHaveValue('1000');
        await expect(reopenedPage.locator('#width-val')).toHaveText('1000px');
        await expect(reopenedPage.locator('#reader-container')).toHaveCSS('max-width', '1000px');

        await reopenedPage.close();
    });

    test('navegacao por teclado avanca paginas e atualiza contador/progresso', async () => {
        const chapterId = await seedReaderChapter(backgroundWorker, {
            chapterId: 'chap_reader_keyboard',
        });
        const readerPage = await browserContext.newPage();
        const readerUrl = await getReaderUrl(backgroundWorker, chapterId);

        await readerPage.goto(readerUrl);
        await expect(readerPage.locator('.reader-page-wrap')).toHaveCount(15, { timeout: 10000 });

        await readerPage.locator('#width-slider').evaluate(node => {
            node.value = '400';
            node.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await expect(readerPage.locator('#reader-container')).toHaveCSS('max-width', '400px');

        for (let i = 0; i < 3; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await readerPage.keyboard.press('ArrowRight');
            // eslint-disable-next-line no-await-in-loop
            await readerPage.waitForTimeout(450);
        }

        await expect(readerPage.locator('#page-counter')).toHaveText('4 / 15', { timeout: 5000 });

        await readerPage.locator('.reader-page-wrap').nth(9).evaluate(el => el.scrollIntoView({ block: 'center' }));
        await expect(readerPage.locator('#page-counter')).toHaveText('10 / 15', { timeout: 5000 });
        await expect.poll(async () => {
            return readerPage.locator('#read-progress-fill').evaluate(node => node.style.width);
        }, { timeout: 5000 }).toBe('67%');

        await readerPage.close();
    });
});
