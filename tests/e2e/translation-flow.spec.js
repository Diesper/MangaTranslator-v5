/**
 * translation-flow.spec.js
 *
 * E2E real do fluxo MV3:
 * - content_manga.js seleciona imagens validas e dispara START_BATCH
 * - background.js orquestra a fila e abre abas do Gemini
 * - content_gemini.js roda na aba mockada do Gemini e devolve a imagem traduzida
 * - content_manga.js substitui o DOM com data:image/... e conclui o lote
 *
 * Observacao importante:
 * A assercao final verifica `data:image/...` no mangá, nao `translated_result.png`.
 * Isso reflete o comportamento real da extensao: o background converte a imagem
 * gerada em base64 antes de enviar `UPDATE_IMAGE` para a aba do mangá.
 */

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

async function resetExtensionState(backgroundWorker, overrides = {}) {
    await backgroundWorker.evaluate((stateOverrides) => {
        return new Promise(resolve => {
            chrome.storage.local.clear(() => {
                chrome.storage.local.set({
                    enabledDomains: ['localhost'],
                    debugMode: false,
                    maxConcurrentJobs: 1,
                    geminiBaseUrl: 'http://127.0.0.1:3999/gemini/',
                    geminiExecutionMode: 'temp_chat',
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
                    ...(stateOverrides || {}),
                }, resolve);
            });
        });
    }, overrides);
}

async function readStorage(backgroundWorker, keys) {
    return backgroundWorker.evaluate(async requestedKeys => {
        return new Promise(resolve => chrome.storage.local.get(requestedKeys, resolve));
    }, keys);
}

async function areBothOriginalPagesVisible(page) {
    return page.evaluate(() => {
        const targets = [
            document.querySelector('[data-testid="manga-image-0"]'),
            document.querySelector('[data-testid="manga-image-1"]'),
        ];

        return targets.every(img => {
            if (!img) return false;
            const rect = img.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= window.innerHeight;
        });
    });
}

let browserContext;
let backgroundWorker;

test.describe('E2E-01/E2E-02/E2E-03/E2E-04/E2E-05/E2E-06/E2E-07/E2E-08/E2E-09/E2E-10/E2E-11/E2E-12/E2E-13/E2E-14/E2E-15/E2E-15b/E2E-16/E2E-16b/E2E-17/E2E-18: Automacao UI: Fluxo de Traducao em Massa (E2E)', () => {
    test.beforeEach(async () => {
        const pathToExtension = getExtensionPath(__dirname);
        const userDataDir = path.join(
            os.tmpdir(),
            `pw-manga-${Date.now()}-${Math.random().toString(36).slice(2)}`
        );
        const browserMode = getBrowserModeConfig();
        const launchArgs = [
            `--disable-extensions-except=${pathToExtension}`,
            `--load-extension=${pathToExtension}`,
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ];

        if (!browserMode.showBrowser) launchArgs.unshift('--headless=new');

        console.log(`[E2E] Browser mode: ${browserMode.mode}`);

        browserContext = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            slowMo: browserMode.slowMo,
            args: launchArgs,
        });

        backgroundWorker = await getBackgroundWorker(browserContext);
        await resetExtensionState(backgroundWorker);
    });

    test.afterEach(async () => {
        if (browserContext) {
            await browserContext.close();
            browserContext = null;
            backgroundWorker = null;
        }
    });

    test('Deve traduzir as paginas validas de ponta a ponta e encerrar o lote corretamente', async () => {
        const page = await browserContext.newPage();

        await page.goto('http://localhost:3999/manga-page.html');
        await page.waitForLoadState('networkidle');

        await page.waitForFunction(() => {
            const pageImages = Array.from(document.querySelectorAll('img')).filter(img =>
                img.src && img.src.includes('page_')
            );

            return pageImages.length >= 2 &&
                pageImages.every(img => img.naturalWidth >= 300 && img.naturalHeight >= 400);
        }, { timeout: 15000 });

        const triggerBtn = page.locator('#manga-translator-trigger');
        const mainContent = page.locator('#manga-main-content');
        const pageOne = page.getByTestId('manga-image-0');
        const pageTwo = page.getByTestId('manga-image-1');
        const avatar = page.getByTestId('small-image');
        const banner = page.getByTestId('banner-image');

        await expect(triggerBtn).toBeVisible({ timeout: 10000 });
        await expect(mainContent).toContainText('TRADUZIR P', { timeout: 10000 });
        await expect.poll(async () => areBothOriginalPagesVisible(page), {
            timeout: 10000,
            message: 'Esperava ver as duas paginas originais ao mesmo tempo no viewport',
        }).toBe(true);

        const pageOneSrcBefore = await pageOne.getAttribute('src');
        const pageTwoSrcBefore = await pageTwo.getAttribute('src');

        await mainContent.click();

        await expect.poll(async () => {
            return page.evaluate(() => {
                return Array.from(document.querySelectorAll('img[data-translated="true"]')).length;
            });
        }, {
            timeout: 45000,
            message: 'Esperava 2 imagens traduzidas no DOM do mangá',
        }).toBe(2);

        await expect(pageOne).toHaveAttribute('data-translated', 'true');
        await expect(pageTwo).toHaveAttribute('data-translated', 'true');
        await expect(pageOne).toHaveAttribute('src', /^data:image\/png;base64,/);
        await expect(pageTwo).toHaveAttribute('src', /^data:image\/png;base64,/);

        const pageOneSrcAfter = await pageOne.getAttribute('src');
        const pageTwoSrcAfter = await pageTwo.getAttribute('src');

        expect(pageOneSrcAfter).not.toBe(pageOneSrcBefore);
        expect(pageTwoSrcAfter).not.toBe(pageTwoSrcBefore);
        expect(pageOneSrcAfter).not.toBe(pageTwoSrcAfter);
        expect(await avatar.getAttribute('src')).toContain('/manga-images/avatar.png');
        expect(await banner.getAttribute('src')).toContain('/manga-images/banner.png');
        expect(await avatar.getAttribute('data-translated')).toBeNull();
        expect(await banner.getAttribute('data-translated')).toBeNull();

        await expect.poll(async () => {
            backgroundWorker = await getBackgroundWorker(browserContext);
            const storage = await readStorage(backgroundWorker, ['mt_state']);
            const state = storage.mt_state || {};

            return {
                completedJobs: state.completedJobs || 0,
                activeJobsCount: state.activeJobsCount || 0,
                isProcessing: !!state.isProcessing,
                stopRequested: !!state.stopRequested,
                queueLength: Array.isArray(state.jobQueue) ? state.jobQueue.length : -1,
            };
        }, {
            timeout: 30000,
            message: 'Esperava fila vazia e lote finalizado no service worker',
        }).toEqual({
            completedJobs: 2,
            activeJobsCount: 0,
            isProcessing: false,
            stopRequested: false,
            queueLength: 0,
        });

        await expect(mainContent).toContainText('TRADUZIR 2', { timeout: 10000 });

        await page.close();
    });

    for (const scenario of [
        {
            mode: 'minimized_window',
            baseUrl: 'http://127.0.0.1:3999/gemini/',
            label: 'janela minimizada',
        },
        {
            mode: 'background_delete',
            baseUrl: 'http://127.0.0.1:3999/app/mock-chat',
            label: 'background com exclusão segura',
        },
    ]) {
        test(`Executa o lote em ${scenario.label} sem depender de ghost mousemove`, async () => {
            await resetExtensionState(backgroundWorker, {
                geminiExecutionMode: scenario.mode,
                geminiBaseUrl: scenario.baseUrl,
            });

            const page = await browserContext.newPage();
            await page.goto('http://localhost:3999/manga-page.html');
            await page.waitForLoadState('networkidle');

            // Estes cenários validam o modo de execução/anti-throttling, não
            // concorrência. Deixamos uma única página elegível para reduzir
            // ruído de cleanup entre janelas e tornar o gate determinístico.
            await page.evaluate(() => {
                const second = document.querySelector('[data-testid="manga-image-1"]');
                if (second) second.remove();
            });

            const mainContent = page.locator('#manga-main-content');
            await expect(mainContent).toContainText('TRADUZIR', { timeout: 10000 });
            await mainContent.click();

            await expect.poll(async () => {
                return page.evaluate(() =>
                    document.querySelectorAll('img[data-translated="true"]').length
                );
            }, {
                timeout: 60000,
                message: `Esperava tradução completa no modo ${scenario.mode}`,
            }).toBe(1);

            await expect.poll(async () => {
                backgroundWorker = await getBackgroundWorker(browserContext);
                const storage = await readStorage(backgroundWorker, [
                    'mt_state',
                    'translatorLog',
                ]);
                const state = storage.mt_state || {};
                const logs = Array.isArray(storage.translatorLog)
                    ? storage.translatorLog
                    : [];

                return {
                    activeJobsCount: state.activeJobsCount || 0,
                    isProcessing: !!state.isProcessing,
                    queueLength: Array.isArray(state.jobQueue)
                        ? state.jobQueue.length
                        : -1,
                    batchDone: logs.some(entry =>
                        entry && entry.action === 'BATCH_DONE'
                    ),
                };
            }, {
                timeout: 45000,
                message: `Esperava lote finalizado no modo ${scenario.mode}`,
            }).toEqual({
                activeJobsCount: 0,
                isProcessing: false,
                queueLength: 0,
                batchDone: true,
            });

            if (scenario.mode === 'background_delete') {
                await expect.poll(async () => {
                    const storage = await readStorage(backgroundWorker, ['translatorLog']);
                    const logs = Array.isArray(storage.translatorLog)
                        ? storage.translatorLog
                        : [];
                    return logs.some(entry =>
                        entry && entry.action === 'DELETE_OK'
                    );
                }, {
                    timeout: 15000,
                    message: 'Esperava exclusão segura confirmada no log',
                }).toBe(true);
            }

            await page.close();
        });
    }

});
