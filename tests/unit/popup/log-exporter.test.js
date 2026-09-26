/**
 * log-exporter.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa a visualização de logs, filtragem por nível de severidade, limpeza
 * e exportação formatada para arquivo de texto (.txt) via downloads API na arquitetura atual.
 */

const { loadExtensionPage, flushAsyncTasks } = require('../../helpers/load-extension-page.js');
const { getStorageMock, getTabsMock, getDownloadsMock } = require('../../mocks/chrome-api.mock.js');

describe('Log Buffer e Exportador — popup.js', () => {
    let storageMock;
    let tabsMock;
    let downloadsMock;

    beforeEach(async () => {
        jest.resetModules();
        window.alert = jest.fn();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        downloadsMock = getDownloadsMock();
        await storageMock.clear();
        document.documentElement.innerHTML = '<html><head></head><body></body></html>';
    });

    afterEach(() => {
        if (window.logPoller) {
            clearInterval(window.logPoller);
            window.logPoller = null;
        }
        jest.restoreAllMocks();
    });

    async function openLogsSection() {
        const btnSettings = document.getElementById('btn-settings');
        if (btnSettings) btnSettings.click();
        await flushAsyncTasks(4);

        const logsTabBtn = document.querySelector('.settings-tab-btn[data-target="settings-logs"]');
        if (logsTabBtn) logsTabBtn.click();
        await flushAsyncTasks(4);
    }

    test('renderiza registros de log salvos no storage e atualiza o contador', async () => {
        const sampleLogs = [
            { ts: Date.now() - 5000, level: 'info', source: 'bg', action: 'START_JOB', detail: 'Iniciando job 1' },
            { ts: Date.now() - 2000, level: 'error', source: 'gemini', action: 'OCR_FAIL', detail: 'Falha no OCR', extra: { code: 500 } },
        ];

        await storageMock.set({
            translatorLog: sampleLogs,
            enabledDomains: ['manga.test'],
        });

        const activeTab = await tabsMock.create({
            url: 'https://manga.test/ch1',
            active: true,
            title: 'Manga Test',
        });
        tabsMock._activeTabId = activeTab.id;

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);

        await openLogsSection();

        const logContainer = document.getElementById('log-container');
        const logCount = document.getElementById('log-count');

        expect(logContainer.children).toHaveLength(2);
        expect(logCount.textContent).toBe('2 / 2 registros');
        expect(logContainer.textContent).toContain('START_JOB');
        expect(logContainer.textContent).toContain('OCR_FAIL');
    });

    test('filtra logs por nível de severidade (error, warn, info, success)', async () => {
        const sampleLogs = [
            { ts: Date.now() - 5000, level: 'info', source: 'bg', action: 'LOG_INFO', detail: 'Info msg' },
            { ts: Date.now() - 2000, level: 'error', source: 'gemini', action: 'LOG_ERROR', detail: 'Error msg' },
        ];

        await storageMock.set({
            translatorLog: sampleLogs,
            enabledDomains: ['manga.test'],
        });

        const activeTab = await tabsMock.create({
            url: 'https://manga.test/ch1',
            active: true,
            title: 'Manga Test',
        });
        tabsMock._activeTabId = activeTab.id;

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);

        await openLogsSection();

        const filterLevel = document.getElementById('log-filter-level');
        const logContainer = document.getElementById('log-container');
        const logCount = document.getElementById('log-count');

        // Filtra apenas erros
        filterLevel.value = 'error';
        filterLevel.dispatchEvent(new Event('change'));
        await flushAsyncTasks(4);

        expect(logContainer.children).toHaveLength(1);
        expect(logCount.textContent).toBe('1 / 2 registros');
        expect(logContainer.textContent).toContain('LOG_ERROR');
        expect(logContainer.textContent).not.toContain('LOG_INFO');
    });

    test('exporta logs gerando arquivo mangatranslator_log.txt via downloads API', async () => {
        const downloadSpy = jest.spyOn(downloadsMock, 'download');
        window.URL.createObjectURL = jest.fn(() => 'blob:mock-log-download');

        const sampleLogs = [
            { ts: 1700000000000, level: 'info', source: 'bg', action: 'BATCH_START', detail: 'Lote iniciado' },
        ];

        await storageMock.set({
            translatorLog: sampleLogs,
            enabledDomains: ['manga.test'],
        });

        const activeTab = await tabsMock.create({
            url: 'https://manga.test/ch1',
            active: true,
            title: 'Manga Test',
        });
        tabsMock._activeTabId = activeTab.id;

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);

        await openLogsSection();

        const btnExportLog = document.getElementById('btn-log-export');
        btnExportLog.click();
        await flushAsyncTasks(4);

        expect(downloadSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                filename: 'mangatranslator_log.txt',
                saveAs: true,
            })
        );
    });

    test('alerta quando não há logs para exportar', async () => {
        await storageMock.set({
            translatorLog: [],
            enabledDomains: ['manga.test'],
        });

        const activeTab = await tabsMock.create({
            url: 'https://manga.test/ch1',
            active: true,
            title: 'Manga Test',
        });
        tabsMock._activeTabId = activeTab.id;

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);

        await openLogsSection();

        const btnExportLog = document.getElementById('btn-log-export');
        btnExportLog.click();

        expect(window.alert).toHaveBeenCalledWith('Nenhum log para exportar.');
    });

    test('copia todos os logs, inclusive os ocultos pelo filtro, para a área de transferência', async () => {
        const sampleLogs = [
            { ts: 1700000000000, level: 'warn', source: 'gemini', action: 'GEMINI_AUXILIARY_FALLBACK', detail: 'Último recurso', extra: { host: 'lh3.googleusercontent.com' } },
            { ts: 1700000001000, level: 'info', source: 'bg', action: 'BATCH_DONE', detail: 'Concluído' },
        ];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: jest.fn().mockResolvedValue() },
        });
        await storageMock.set({ translatorLog: sampleLogs, enabledDomains: ['manga.test'] });
        const activeTab = await tabsMock.create({ url: 'https://manga.test/ch1', active: true, title: 'Manga Test' });
        tabsMock._activeTabId = activeTab.id;

        await loadExtensionPage({ htmlPath: 'extension/popup.html', scriptPath: 'extension/popup.js', fireDOMContentLoaded: true });
        await flushAsyncTasks(8);
        await openLogsSection();
        const filterLevel = document.getElementById('log-filter-level');
        filterLevel.value = 'warn';
        filterLevel.dispatchEvent(new Event('change'));

        document.getElementById('btn-log-copy').click();
        await flushAsyncTasks(4);

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('GEMINI_AUXILIARY_FALLBACK'));
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('BATCH_DONE'));
        expect(document.getElementById('btn-log-copy').textContent).toBe('Copiado!');
    });
});

