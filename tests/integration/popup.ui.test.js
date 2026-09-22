const {
    loadExtensionPage,
    flushAsyncTasks,
} = require('../helpers/load-extension-page.js');
const {
    getStorageMock,
    getTabsMock,
} = require('../mocks/chrome-api.mock.js');

describe('REG-06/REG-07/PU-01/PU-02/PU-03/PU-04/PU-05/PU-06/PU-07/PU-08/PU-09/PU-10/PU-11/PU-12/PU-13/PU-14/PU-15/PU-16/PU-17/PU-18/PU-19/PU-20/PU-21/PU-22/PU-23/PU-23b/PU-24/PU-25/PU-26/PU-27/PU-28/PU-29/PU-30/PU-31/PU-32/PU-33/PU-34/PU-35/PU-36/PU-37/PU-38/PU-39/PU-40/PU-41/PU-42/PU-43/PU-44/PU-45/PU-46/PU-47/PU-48/PU-49/PU-49b/PU-50/PU-51/PU-52/PU-53/PU-54/PU-55/PU-56/PU-57/PU-58/PU-59/PU-60/PU-61/PU-62/PU-63/PU-64/PU-65/PU-66/PU-67/PU-68/PU-69/PU-70/PU-71/PU-72/PU-73/PU-74/PU-75/PU-76/PU-77/PU-78/PU-79/PU-80/PU-81: popup.js + popup.html - integracao real', () => {
    let storageMock;
    let tabsMock;

    async function createActiveTab(url, title = 'Manga Page') {
        const tab = await tabsMock.create({ url, active: true });
        tabsMock._tabs.get(tab.id).title = title;
        return tab;
    }

    function registerPopupTabHandler(tabId, {
        images = [],
        onEnablePage = null,
    } = {}) {
        tabsMock._registerMessageHandler(tabId, (message, _sender, sendResponse) => {
            if (message.action === 'GET_PAGE_IMAGES') {
                sendResponse({ images });
            } else if (message.action === 'SET_SELECTED_IMAGES') {
                sendResponse({ success: true });
            } else if (message.action === 'ENABLE_PAGE') {
                if (onEnablePage) onEnablePage(message);
                sendResponse({ success: true });
            } else if (message.action === 'HIGHLIGHT_IMAGE') {
                sendResponse({ success: true });
            }
        });
    }

    beforeEach(async () => {
        jest.resetModules();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        await storageMock.clear();
        document.documentElement.innerHTML = '<html><head></head><body></body></html>';
    });

    afterEach(() => {
        jest.restoreAllMocks();
        global.confirm = window.confirm;
    });

    test('carrega imagens da aba ativa e mostra indicador de traducao em andamento', async () => {
        const tab = await createActiveTab('https://reader.test/chapter-1', 'Reader Test');
        registerPopupTabHandler(tab.id, {
            images: [
                { index: 0, src: 'https://reader.test/p1.png', width: 800, height: 1200 },
                { index: 1, src: 'https://reader.test/p2.png', width: 820, height: 1180 },
            ],
        });

        await storageMock.set({
            enabledDomains: ['reader.test'],
            mt_state: { activeJobsCount: 2, completedJobs: 0, jobQueue: [] },
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });

        await flushAsyncTasks(8);

        expect(document.querySelectorAll('#image-grid .image-card')).toHaveLength(2);
        expect(document.getElementById('selection-count').textContent).toBe('2 imagens selecionadas');
        expect(document.getElementById('btn-translate').textContent).toBe('Traduzir 2 Páginas');
        expect(document.getElementById('translating-dot').classList.contains('visible')).toBe(true);
        expect(document.getElementById('translating-label').classList.contains('visible')).toBe(true);
    });

    test('abre o painel de configuracoes e renderiza os sites habilitados sem crash', async () => {
        const tab = await createActiveTab('https://reader.test/chapter-2', 'Reader Test');
        registerPopupTabHandler(tab.id, {
            images: [{ index: 0, src: 'https://reader.test/p1.png', width: 800, height: 1200 }],
        });

        await storageMock.set({
            enabledDomains: ['reader.test', 'mirror.test'],
            customPrompt: 'Prompt popup real',
            autoRestoreEnabled: false,
            autoRestoreDisabledSites: ['mirror.test'],
            chapterList: [{
                id: 'chap_popup_auto',
                title: 'Capítulo Popup',
                url: 'https://reader.test/chapter-2',
                timestamp: 1710000000000,
            }],
            chap_popup_auto_restoreMap: {
                'https://reader.test/p1.png': 'data:image/png;base64,UE9QVVBO',
            },
            chap_popup_auto_restoreMeta: {
                'https://reader.test/p1.png': {
                    host: 'reader.test',
                    sourceUrl: 'https://reader.test/p1.png',
                    index: 0,
                    updatedAt: 1710000001000,
                },
            },
            'siteMeta_reader.test': { title: 'Reader Oficial' },
            'siteMeta_mirror.test': { title: 'Mirror Hub' },
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });

        await flushAsyncTasks(8);

        document.getElementById('btn-options').click();
        await flushAsyncTasks(8);

        expect(document.getElementById('settings-page').classList.contains('active')).toBe(true);
        expect(document.getElementById('settings-prompt').value).toBe('Prompt popup real');
        expect(document.getElementById('settings-auto-restore-enabled').checked).toBe(false);
        expect(document.querySelectorAll('#settings-sites-list .settings-site-item')).toHaveLength(2);
        expect(document.getElementById('settings-sites-list').textContent).toContain('reader.test');
        expect(document.getElementById('settings-sites-list').textContent).toContain('mirror.test');
        expect(document.querySelectorAll('#settings-sites-list .settings-site-auto input')).toHaveLength(2);
        expect(Array.from(document.querySelectorAll('#settings-sites-list .settings-site-item'))
            .find(item => item.textContent.includes('reader.test'))
            .querySelector('.settings-site-auto input').checked).toBe(true);
        expect(Array.from(document.querySelectorAll('#settings-sites-list .settings-site-item'))
            .find(item => item.textContent.includes('mirror.test'))
            .querySelector('.settings-site-auto input').checked).toBe(false);
        const readerSite = Array.from(document.querySelectorAll('#settings-sites-list .settings-site-item'))
            .find(item => item.textContent.includes('reader.test'));
        const mirrorSite = Array.from(document.querySelectorAll('#settings-sites-list .settings-site-item'))
            .find(item => item.textContent.includes('mirror.test'));
        expect(window.getComputedStyle(document.getElementById('settings-sites-list')).overflowY).toBe('auto');
        expect(readerSite.classList.contains('open')).toBe(false);
        readerSite.querySelector('.settings-site-main').click();
        await flushAsyncTasks(8);
        const openedReaderSite = Array.from(document.querySelectorAll('#settings-sites-list .settings-site-item'))
            .find(item => item.textContent.includes('reader.test'));
        expect(openedReaderSite.classList.contains('open')).toBe(true);
        expect(openedReaderSite.querySelector('.settings-site-main').getAttribute('aria-expanded')).toBe('true');
        expect(window.getComputedStyle(openedReaderSite.querySelector('.settings-site-images')).overflowY).toBe('auto');
        expect(openedReaderSite.querySelectorAll('.settings-auto-image-item')).toHaveLength(1);
        expect(openedReaderSite.textContent).toContain('Capítulo Popup');
        expect(mirrorSite.querySelectorAll('.settings-auto-image-item')).toHaveLength(0);
    });

    test('remover site habilitado tira o dominio da lista mesmo quando existem imagens salvas no historico', async () => {
        const host = 'reader.test';
        const cleanUrl = `https://${host}/p1.png`;
        const tab = await createActiveTab(`https://${host}/chapter-remove`, 'Reader Test');
        registerPopupTabHandler(tab.id, {
            images: [{ index: 0, src: cleanUrl, width: 800, height: 1200 }],
        });

        await storageMock.set({
            enabledDomains: [host],
            chapterList: [{
                id: 'chap_popup_remove',
                title: 'Capítulo Remove',
                url: `https://${host}/chapter-remove`,
                timestamp: 1710000000000,
            }],
            chap_popup_remove_restoreMap: {
                [cleanUrl]: 'data:image/png;base64,UE9Q',
            },
            chap_popup_remove_restoreMeta: {
                [cleanUrl]: { host, sourceUrl: cleanUrl, index: 0, updatedAt: 1710000000000 },
            },
            [`siteMeta_${host}`]: { title: 'Reader Test' },
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);
        document.getElementById('btn-options').click();
        await flushAsyncTasks(8);

        document.querySelector('#settings-sites-list .settings-site-remove').click();
        await flushAsyncTasks(10);

        const data = await storageMock.get(['enabledDomains', `siteMeta_${host}`]);
        expect(data.enabledDomains).toEqual([]);
        expect(data[`siteMeta_${host}`]).toBeUndefined();
        expect(document.querySelectorAll('#settings-sites-list .settings-site-item')).toHaveLength(0);
        expect(document.getElementById('settings-sites-list').textContent).toContain('Nenhum site habilitado');
    });

    test('configuracoes de auto-substituicao no popup salvam global, site e imagem especifica', async () => {
        const host = 'reader.test';
        const cleanUrl = `https://${host}/p1.png`;
        const tab = await createActiveTab(`https://${host}/chapter-auto`, 'Reader Test');
        registerPopupTabHandler(tab.id, {
            images: [{ index: 0, src: cleanUrl, width: 800, height: 1200 }],
        });

        await storageMock.set({
            enabledDomains: [host],
            autoRestoreEnabled: true,
            chapterList: [{
                id: 'chap_popup_controls',
                title: 'Capítulo Controles',
                url: `https://${host}/chapter-auto`,
                timestamp: 1710000000000,
            }],
            chap_popup_controls_restoreMap: {
                [cleanUrl]: 'data:image/png;base64,QVVUTw==',
            },
            chap_popup_controls_restoreMeta: {
                [cleanUrl]: {
                    host,
                    sourceUrl: cleanUrl,
                    index: 0,
                    updatedAt: 1710000002000,
                },
            },
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });

        await flushAsyncTasks(8);
        document.getElementById('btn-options').click();
        await flushAsyncTasks(8);

        const globalToggle = document.getElementById('settings-auto-restore-enabled');
        globalToggle.checked = false;
        globalToggle.dispatchEvent(new Event('change', { bubbles: true }));
        await flushAsyncTasks(4);

        const siteAuto = document.querySelector('#settings-sites-list .settings-site-auto input');
        siteAuto.checked = false;
        siteAuto.dispatchEvent(new Event('change', { bubbles: true }));
        await flushAsyncTasks(6);

        document.querySelector('#settings-sites-list .settings-auto-image-block-btn').click();
        await flushAsyncTasks(6);

        const data = await storageMock.get([
            'autoRestoreEnabled',
            'autoRestoreDisabledSites',
            'autoRestoreBlockedImages',
        ]);

        expect(data.autoRestoreEnabled).toBe(false);
        expect(data.autoRestoreDisabledSites).toContain(host);
        expect(data.autoRestoreBlockedImages[cleanUrl]).toEqual(expect.objectContaining({
            cleanUrl,
            host,
            chapterTitle: 'Capítulo Controles',
        }));
    });

    test('botao Refazer apaga a traducao salva da imagem especifica e limpa o cache GTC por URL', async () => {
        const host = 'reader.test';
        const cleanUrl = `https://${host}/wrong.png`;
        const keepUrl = `https://${host}/keep.png`;
        const tab = await createActiveTab(`https://${host}/chapter-redo`, 'Reader Test');
        registerPopupTabHandler(tab.id, {
            images: [{ index: 0, src: cleanUrl, width: 800, height: 1200 }],
        });
        const sendSpy = jest.spyOn(global.chrome.runtime, 'sendMessage').mockImplementation((message, callback) => {
            if (callback) setTimeout(() => callback({ ok: true, deleted: 1 }), 0);
        });
        jest.spyOn(window, 'confirm').mockReturnValue(true);
        global.confirm = window.confirm;

        await storageMock.set({
            enabledDomains: [host],
            chapterList: [{
                id: 'chap_popup_redo',
                title: 'Capítulo Refazer',
                url: `https://${host}/chapter-redo`,
                timestamp: 1710000000000,
            }],
            chap_popup_redo_images: {
                0: 'data:image/png;base64,ERRADA',
                1: 'data:image/png;base64,CERTA',
            },
            chap_popup_redo_paths: {
                0: 'C:\\Downloads\\errada.png',
                1: 'C:\\Downloads\\certa.png',
            },
            chap_popup_redo_restoreMap: {
                [cleanUrl]: 'data:image/png;base64,ERRADA',
                [keepUrl]: 'data:image/png;base64,CERTA',
            },
            chap_popup_redo_restoreMeta: {
                [cleanUrl]: {
                    host,
                    sourceUrl: cleanUrl,
                    index: 0,
                    updatedAt: 1710000003000,
                },
                [keepUrl]: {
                    host,
                    sourceUrl: keepUrl,
                    index: 1,
                    updatedAt: 1710000001000,
                },
            },
            autoRestoreBlockedImages: {
                [cleanUrl]: { cleanUrl, host },
            },
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });

        await flushAsyncTasks(8);
        document.getElementById('btn-options').click();
        await flushAsyncTasks(8);

        document.querySelector('#settings-sites-list .settings-auto-image-redo-btn').click();
        await flushAsyncTasks(10);

        const data = await storageMock.get([
            'chap_popup_redo_images',
            'chap_popup_redo_paths',
            'chap_popup_redo_restoreMap',
            'chap_popup_redo_restoreMeta',
            'autoRestoreBlockedImages',
        ]);
        expect(data.chap_popup_redo_restoreMap[cleanUrl]).toBeUndefined();
        expect(data.chap_popup_redo_restoreMap[keepUrl]).toBe('data:image/png;base64,CERTA');
        expect(data.chap_popup_redo_restoreMeta[cleanUrl]).toBeUndefined();
        expect(data.chap_popup_redo_images[0]).toBeUndefined();
        expect(data.chap_popup_redo_images[1]).toBe('data:image/png;base64,CERTA');
        expect(data.chap_popup_redo_paths[0]).toBeUndefined();
        expect(data.autoRestoreBlockedImages[cleanUrl]).toBeUndefined();
        expect(sendSpy).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'GTC_DELETE_BY_CLEAN_URL', cleanUrl }),
            expect.any(Function)
        );
        expect(document.querySelectorAll('#settings-sites-list .settings-auto-image-item')).toHaveLength(1);
    });

    test('habilita um novo dominio via botao do popup e inicializa a grade', async () => {
        const tab = await createActiveTab('https://newsite.test/chapter-3', 'New Site Title');
        const onEnablePage = jest.fn();

        registerPopupTabHandler(tab.id, {
            images: [{ index: 0, src: 'https://newsite.test/p1.png', width: 900, height: 1400 }],
            onEnablePage,
        });

        await storageMock.set({
            enabledDomains: [],
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });

        await flushAsyncTasks(8);

        expect(document.getElementById('enable-page').classList.contains('active')).toBe(true);

        document.getElementById('btn-enable').click();
        await flushAsyncTasks(10);

        const data = await storageMock.get(['enabledDomains', 'siteMeta_newsite.test']);
        expect(data.enabledDomains).toEqual(['newsite.test']);
        expect(data['siteMeta_newsite.test']).toEqual(expect.objectContaining({
            title: 'New Site Title',
        }));
        expect(onEnablePage).toHaveBeenCalledTimes(1);
        expect(document.querySelectorAll('#image-grid .image-card')).toHaveLength(1);
    });

    test('ao ativar site sem imagens detectadas mostra tela de recarregar em vez de grade vazia', async () => {
        const tab = await createActiveTab('https://empty-after-enable.test/chapter-1', 'Empty Enable');
        const onEnablePage = jest.fn();
        registerPopupTabHandler(tab.id, {
            images: [],
            onEnablePage,
        });

        await storageMock.set({ enabledDomains: [] });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);

        document.getElementById('btn-enable').click();
        await flushAsyncTasks(12);

        const data = await storageMock.get(['enabledDomains']);
        expect(data.enabledDomains).toEqual(['empty-after-enable.test']);
        expect(onEnablePage).toHaveBeenCalledTimes(1);
        expect(document.getElementById('enable-page').classList.contains('active')).toBe(true);
        expect(document.getElementById('enable-section').textContent).toContain('Ctrl+F5');
        expect(document.getElementById('btn-force-reload')).toBeTruthy();
        expect(document.getElementById('image-grid').textContent).not.toContain('Nenhuma imagem detectada');
    });

    test('sincroniza campos, controles deslizantes, prévia e reset do filtro de tamanho', async () => {
        const tab = await createActiveTab('https://reader.test/chapter-filter', 'Reader Test');
        registerPopupTabHandler(tab.id, {
            images: [{ index: 0, src: 'https://reader.test/p1.png', width: 800, height: 1200 }],
        });
        await storageMock.set({
            enabledDomains: ['reader.test'],
            imageMinWidth: 180,
            imageMinHeight: 120,
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);
        document.getElementById('btn-options').click();
        await flushAsyncTasks(8);

        const widthInput = document.getElementById('settings-image-min-width');
        const heightInput = document.getElementById('settings-image-min-height');
        const widthRange = document.getElementById('settings-image-min-width-range');
        const heightRange = document.getElementById('settings-image-min-height-range');
        const shape = document.getElementById('image-filter-shape');

        expect(widthInput.value).toBe('180');
        expect(heightInput.value).toBe('120');
        expect(widthRange.value).toBe('180');
        expect(heightRange.value).toBe('120');
        expect(shape.textContent).toBe('180 × 120');

        widthRange.value = '220';
        widthRange.dispatchEvent(new Event('input', { bubbles: true }));
        heightInput.value = '160';
        heightInput.dispatchEvent(new Event('input', { bubbles: true }));
        await flushAsyncTasks(4);

        expect(widthInput.value).toBe('220');
        expect(heightRange.value).toBe('160');
        expect(shape.textContent).toBe('220 × 160');
        expect(await storageMock.get(['imageMinWidth', 'imageMinHeight'])).toEqual({
            imageMinWidth: 220,
            imageMinHeight: 160,
        });

        document.getElementById('settings-image-min-reset').click();
        await flushAsyncTasks(4);

        expect(widthInput.value).toBe('300');
        expect(heightInput.value).toBe('400');
        expect(widthRange.value).toBe('300');
        expect(heightRange.value).toBe('400');
        expect(shape.textContent).toBe('300 × 400');
        expect(await storageMock.get(['imageMinWidth', 'imageMinHeight'])).toEqual({
            imageMinWidth: 300,
            imageMinHeight: 400,
        });
    });

    test('mantém sites habilitados agrupados com a substituição automática e o filtro entre paralelo e debug', async () => {
        const tab = await createActiveTab('https://reader.test/chapter-layout', 'Reader Test');
        registerPopupTabHandler(tab.id);
        await storageMock.set({ enabledDomains: ['reader.test'] });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);
        document.getElementById('btn-options').click();
        await flushAsyncTasks(8);

        const autoRestoreSection = document.getElementById('settings-auto-restore-row').closest('.settings-section');
        expect(document.getElementById('settings-sites-list').closest('.settings-section')).toBe(autoRestoreSection);

        const parallel = document.getElementById('settings-parallel').closest('.settings-section');
        const filter = document.getElementById('image-filter-control').closest('.settings-section');
        const debug = document.getElementById('debug-toggle-label').closest('.settings-section');
        expect(parallel.compareDocumentPosition(filter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(filter.compareDocumentPosition(debug) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});
