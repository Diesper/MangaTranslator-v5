/**
 * progress-panel.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa o painel de progresso inline e o indicador de atividade do popup
 * usando a página real carregada via loadExtensionPage.
 */

const { loadExtensionPage, flushAsyncTasks } = require('../../helpers/load-extension-page.js');
const { getStorageMock, getTabsMock, getRuntimeMock } = require('../../mocks/chrome-api.mock.js');

describe('popup.js - Painel de Progresso Inline Real', () => {
    let storageMock;
    let tabsMock;
    let runtimeMock;

    beforeEach(async () => {
        jest.resetModules();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        runtimeMock = getRuntimeMock();
        await storageMock.clear();
        document.documentElement.innerHTML = '<html><head></head><body></body></html>';
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('UI #7: indicador no header fica visível quando activeJobsCount > 0 na inicialização', async () => {
        await storageMock.set({
            mt_state: { activeJobsCount: 2, completedJobs: 0 },
            enabledDomains: ['manga.test'],
        });

        const activeTab = await tabsMock.create({
            url: 'https://manga.test/ch1',
            active: true,
            title: 'Manga Test',
        });
        tabsMock._activeTabId = activeTab.id;

        tabsMock._registerMessageHandler(activeTab.id, (message, _sender, sendResponse) => {
            if (message.action === 'GET_PAGE_IMAGES') {
                sendResponse({ images: [] });
            }
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);

        const dot = document.getElementById('translating-dot');
        const label = document.getElementById('translating-label');
        expect(dot.classList.contains('visible')).toBe(true);
        expect(label.classList.contains('visible')).toBe(true);
    });

    test('exibe painel de progresso com valores iniciais e atualiza via polling do storage', async () => {
        let pollCallback = null;
        jest.spyOn(window, 'setInterval').mockImplementation((cb, ms) => {
            pollCallback = cb;
            return 999;
        });

        const activeTab = await tabsMock.create({
            url: 'https://manga.test/ch1',
            active: true,
            title: 'Manga Test',
        });
        tabsMock._activeTabId = activeTab.id;

        tabsMock._registerMessageHandler(activeTab.id, (message, _sender, sendResponse) => {
            if (message.action === 'GET_PAGE_IMAGES') {
                sendResponse({
                    images: [
                        { index: 0, src: 'https://manga.test/p1.png', width: 800, height: 1200 },
                        { index: 1, src: 'https://manga.test/p2.png', width: 800, height: 1200 },
                    ],
                });
            } else if (message.action === 'START_TRANSLATION_FROM_POPUP') {
                sendResponse({ started: true });
            }
        });

        await storageMock.set({
            enabledDomains: ['manga.test'],
            mt_state: { isProcessing: false, activeJobsCount: 0 },
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);

        const progressPanel = document.getElementById('progress-panel');
        const progressText = document.getElementById('progress-text');
        const progressFill = document.getElementById('progress-bar-fill');
        const progressSub = document.getElementById('progress-sub');
        const btnTranslate = document.getElementById('btn-translate');

        expect(progressPanel.classList.contains('active')).toBe(false);

        // Clica em Traduzir
        btnTranslate.click();
        await flushAsyncTasks(8);

        // Painel deve estar ativo com estado inicial
        expect(progressPanel.classList.contains('active')).toBe(true);
        expect(progressText.textContent).toBe('Traduzindo páginas...');
        expect(progressSub.textContent).toBe('0 / 2 páginas');
        expect(progressFill.style.width).toBe('0%');
        expect(typeof pollCallback).toBe('function');

        // Simula progresso intermediário no storage
        await storageMock.set({
            mt_state: {
                isProcessing: true,
                totalJobs: 2,
                completedJobs: 1,
                activeJobsCount: 1,
                jobQueue: [],
            },
            mt_popup_state: {
                status: 'processing',
                geminiTotal: 2,
                cacheHits: 0,
            },
        });

        // Executa callback de polling
        pollCallback();
        await flushAsyncTasks(8);

        expect(progressFill.style.width).toBe('50%');
        expect(progressSub.textContent).toContain('1 / 2 Gemini');

        // Simula conclusão
        await storageMock.set({
            mt_state: {
                isProcessing: false,
                totalJobs: 2,
                completedJobs: 2,
                activeJobsCount: 0,
                jobQueue: [],
            },
            mt_popup_state: {
                status: 'complete',
                geminiTotal: 2,
                cacheHits: 0,
            },
        });

        pollCallback();
        await flushAsyncTasks(8);

        expect(progressText.textContent).toBe('✅ Tradução concluída!');
        const closeBtn = progressPanel.querySelector('.progress-close-btn');
        expect(closeBtn).not.toBeNull();
    });

    test('botão de parar cancela o lote enviando STOP_BATCH', async () => {
        const closeSpy = jest.spyOn(window, 'close').mockImplementation(() => {});
        const sendMessageSpy = jest.spyOn(chrome.runtime, 'sendMessage');

        const activeTab = await tabsMock.create({
            url: 'https://manga.test/ch1',
            active: true,
            title: 'Manga Test',
        });
        tabsMock._activeTabId = activeTab.id;

        tabsMock._registerMessageHandler(activeTab.id, (message, _sender, sendResponse) => {
            if (message.action === 'GET_PAGE_IMAGES') {
                sendResponse({
                    images: [{ index: 0, src: 'https://manga.test/p1.png', width: 800, height: 1200 }],
                });
            } else if (message.action === 'START_TRANSLATION_FROM_POPUP') {
                sendResponse({ started: true });
            }
        });

        await storageMock.set({
            enabledDomains: ['manga.test'],
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);

        // Inicia tradução
        document.getElementById('btn-translate').click();
        await flushAsyncTasks(8);

        // Clica em parar
        const stopBtn = document.getElementById('btn-progress-stop');
        expect(stopBtn).not.toBeNull();
        stopBtn.click();

        expect(sendMessageSpy).toHaveBeenCalledWith({ action: 'STOP_BATCH' });
        expect(closeSpy).toHaveBeenCalled();
    });
});
