const {
    loadExtensionPage,
    flushAsyncTasks,
} = require('../helpers/load-extension-page.js');
const {
    getStorageMock,
    getTabsMock,
} = require('../mocks/chrome-api.mock.js');

function buildImages(host, total = 21) {
    return Array.from({ length: total }, (_, index) => ({
        index,
        src: `https://${host}/page-${index}.png`,
        width: 800 + index,
        height: 1200 + index,
    }));
}

describe('REG-08/PU-33/PU-34/PU-35/PU-36/PU-37/PU-38/PU-39/PU-40/PU-41/PU-42/PU-43/PU-44/PU-45/PU-46/PU-47/PU-48/PU-49/PU-49b/PU-50/PU-51/PU-52/PU-53: popup.js + popup.html - fluxos avancados reais', () => {
    let storageMock;
    let tabsMock;

    async function createActiveTab(url, title = 'Manga Page') {
        const tab = await tabsMock.create({ url, active: true });
        tabsMock._tabs.get(tab.id).title = title;
        return tab;
    }

    function registerPopupTabHandler(tabId, {
        images = [],
        onStartTranslation = null,
    } = {}) {
        tabsMock._registerMessageHandler(tabId, (message, _sender, sendResponse) => {
            if (message.action === 'GET_PAGE_IMAGES') {
                sendResponse({ images, total: images.length });
                return;
            }

            if (message.action === 'SET_SELECTED_IMAGES') {
                sendResponse({ success: true });
                return;
            }

            if (message.action === 'START_TRANSLATION_FROM_POPUP') {
                if (onStartTranslation) onStartTranslation(message);
                sendResponse({ success: true });
                return;
            }

            if (message.action === 'ENABLE_PAGE' || message.action === 'HIGHLIGHT_IMAGE') {
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
    });

    test('select all/none e banir 21 imagens movem tudo para a aba de banidas', async () => {
        const host = 'reader.test';
        const images = buildImages(host, 21);
        const tab = await createActiveTab(`https://${host}/chapter-1`, 'Reader Test');

        registerPopupTabHandler(tab.id, { images });

        await storageMock.set({
            enabledDomains: [host],
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });

        await flushAsyncTasks(12);

        expect(document.querySelectorAll('#image-grid .image-card')).toHaveLength(21);
        expect(document.getElementById('selection-count').textContent).toBe('21 imagens selecionadas');

        document.getElementById('btn-select-none').click();
        await flushAsyncTasks(4);

        expect(document.querySelectorAll('#image-grid .image-card.selected')).toHaveLength(0);
        expect(document.getElementById('selection-count').textContent).toBe('0 imagens selecionadas');
        expect(document.getElementById('btn-translate').disabled).toBe(true);

        document.getElementById('btn-select-all').click();
        await flushAsyncTasks(4);

        expect(document.querySelectorAll('#image-grid .image-card.selected')).toHaveLength(21);
        expect(document.getElementById('selection-count').textContent).toBe('21 imagens selecionadas');
        expect(document.getElementById('btn-translate').disabled).toBe(false);

        document.getElementById('btn-ban-selected').click();
        await flushAsyncTasks(12);

        const data = await storageMock.get([`bannedImages_${host}`]);
        expect(data[`bannedImages_${host}`]).toHaveLength(21);
        expect(document.querySelectorAll('#image-grid .image-card')).toHaveLength(0);
        expect(document.getElementById('image-grid').textContent).toContain('Nenhuma imagem detectada');

        document.querySelector('.tab-btn[data-target="banned-tab"]').click();
        await flushAsyncTasks(8);

        expect(document.querySelectorAll('#banned-site-list .image-card')).toHaveLength(21);
        expect(document.getElementById('banned-site-list').textContent).toContain('21 ban.');
    });

    test('desbanir 21 imagens reintegra o grid principal e limpa a aba de banidas', async () => {
        const host = 'reader.test';
        const images = buildImages(host, 21);
        const bannedUrls = images.map(image => image.src);
        const tab = await createActiveTab(`https://${host}/chapter-2`, 'Reader Test');

        registerPopupTabHandler(tab.id, { images });

        await storageMock.set({
            enabledDomains: [host],
            [`bannedImages_${host}`]: bannedUrls,
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });

        await flushAsyncTasks(12);

        expect(document.querySelectorAll('#image-grid .image-card')).toHaveLength(0);

        document.querySelector('.tab-btn[data-target="banned-tab"]').click();
        await flushAsyncTasks(8);

        expect(document.querySelectorAll('#banned-site-list .image-card')).toHaveLength(21);

        document.getElementById('btn-banned-select-all').click();
        await flushAsyncTasks(4);

        expect(document.getElementById('banned-selection-count').textContent).toBe('21 imagens selecionadas');

        document.getElementById('btn-unban-selected').click();
        await flushAsyncTasks(12);

        const data = await storageMock.get([`bannedImages_${host}`]);
        expect(data[`bannedImages_${host}`]).toEqual([]);

        document.querySelector('.tab-btn[data-target="main-tab"]').click();
        await flushAsyncTasks(8);

        expect(document.querySelectorAll('#image-grid .image-card')).toHaveLength(21);
        expect(document.querySelectorAll('#image-grid .image-card.selected')).toHaveLength(21);
        expect(document.getElementById('selection-count').textContent).toBe('21 imagens selecionadas');

        document.querySelector('.tab-btn[data-target="banned-tab"]').click();
        await flushAsyncTasks(8);
        expect(document.getElementById('banned-site-list').textContent).toContain('Nenhuma imagem banida.');
    });

    test('tab Traduzidas abre o reader e envia anchorId ao abrir pasta existente', async () => {
        const host = 'reader.test';
        const tab = await createActiveTab(`https://${host}/chapter-3`, 'Reader Test');
        const sendMessageSpy = jest.spyOn(global.chrome.runtime, 'sendMessage')
            .mockImplementation((message, callback) => {
                if (callback) callback({ ok: true });
            });

        registerPopupTabHandler(tab.id, { images: buildImages(host, 3) });

        await storageMock.set({
            enabledDomains: [host],
            chapterList: [{
                id: 'chap_1',
                title: 'Chapter 10',
                url: `https://${host}/chapter-3`,
                timestamp: Date.now(),
            }],
            chap_1_images: {
                0: 'data:image/png;base64,PAGE_0',
                1: 'data:image/png;base64,PAGE_1',
            },
            chap_1_paths: {
                0: '/home/user/Downloads/MangaTranslator/Chapter_10/pagina_000.png',
                1: '/home/user/Downloads/MangaTranslator/Chapter_10/pagina_001.png',
            },
            chap_1_dlId: 77,
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });

        await flushAsyncTasks(12);

        document.querySelector('.tab-btn[data-target="translated-tab"]').click();
        await flushAsyncTasks(12);

        expect(document.querySelectorAll('#chapter-list .chapter-item')).toHaveLength(1);

        const tabIdsBeforeRead = new Set(tabsMock._tabs.keys());
        document.querySelector('.btn-read-chap').click();
        await flushAsyncTasks(6);

        const readerTabId = [...tabsMock._tabs.keys()].find(id => !tabIdsBeforeRead.has(id));
        expect(readerTabId).toBeDefined();
        expect(tabsMock._tabs.get(readerTabId).url).toBe('chrome-extension://test-extension-id/reader.html?id=chap_1');

        document.querySelector('.btn-open-chap-folder').click();
        await flushAsyncTasks(8);

        expect(sendMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
            action: 'SHOW_EXISTING_FOLDER',
            anchorId: 77,
            safeTitle: 'Chapter_10',
        }), expect.any(Function));
    });

    test('configuracoes atualizam paralelismo e disparam SET_DEBUG_MODE', async () => {
        const host = 'reader.test';
        const tab = await createActiveTab(`https://${host}/chapter-4`, 'Reader Test');
        const sendMessageSpy = jest.spyOn(global.chrome.runtime, 'sendMessage')
            .mockImplementation((message, callback) => {
                if (callback) callback({ ok: true });
            });

        registerPopupTabHandler(tab.id, { images: buildImages(host, 1) });

        await storageMock.set({
            enabledDomains: [host],
            maxConcurrentJobs: 3,
            debugMode: false,
        });

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });

        await flushAsyncTasks(10);

        document.getElementById('btn-options').click();
        await flushAsyncTasks(10);

        const parallelSlider = document.getElementById('settings-parallel');
        const parallelValue = document.getElementById('settings-parallel-val');

        expect(parallelSlider.value).toBe('3');
        expect(parallelValue.textContent).toBe('3');

        parallelSlider.value = '5';
        parallelSlider.dispatchEvent(new Event('input', { bubbles: true }));
        await flushAsyncTasks(4);

        document.getElementById('debug-toggle-label').click();
        await flushAsyncTasks(6);

        const data = await storageMock.get(['maxConcurrentJobs']);
        expect(data.maxConcurrentJobs).toBe(5);
        expect(parallelValue.textContent).toBe('5');
        expect(sendMessageSpy).toHaveBeenCalledWith({
            action: 'SET_DEBUG_MODE',
            debugOn: true,
        }, expect.any(Function));
        expect(document.getElementById('debug-toggle-text').textContent).toContain('Debug ATIVADO');
    });
});
