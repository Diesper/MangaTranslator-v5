const {
    loadExtensionPage,
    flushAsyncTasks,
} = require('../helpers/load-extension-page.js');
const { getStorageMock } = require('../mocks/chrome-api.mock.js');

describe('OP-01/OP-02/OP-03/OP-04/OP-05/OP-06/OP-07/OP-08/OP-09/OP-10/OP-11/OP-12/OP-13/OP-14/OP-15: options.js + options.html - integracao real', () => {
    let storageMock;

    beforeEach(async () => {
        jest.resetModules();
        storageMock = getStorageMock();
        await storageMock.clear();
        document.documentElement.innerHTML = '<html><head></head><body></body></html>';
        jest.spyOn(window, 'confirm').mockReturnValue(true);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('carrega prompt salvo e renderiza os sites permitidos com HTML real', async () => {
        await storageMock.set({
            customPrompt: 'Prompt customizado de teste',
            enabledDomains: ['reader.test', 'mirror.test'],
            'siteMeta_reader.test': { title: 'Reader Oficial' },
        });

        await loadExtensionPage({
            htmlPath: 'extension/options.html',
            scriptPath: 'extension/options.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(4);

        expect(document.getElementById('prompt').value).toBe('Prompt customizado de teste');

        const siteItems = [...document.querySelectorAll('#sites-list .options-site-item')];
        expect(siteItems).toHaveLength(2);
        expect(siteItems[0].textContent).toContain('Reader Oficial (reader.test)');
        expect(siteItems[1].textContent).toContain('mirror.test (mirror.test)');
        expect(siteItems[0].textContent).toContain('Imagens específicas');
        expect(window.getComputedStyle(document.getElementById('sites-list')).overflowY).toBe('auto');

        expect(siteItems[0].classList.contains('open')).toBe(false);
        siteItems[0].querySelector('.options-site-main').click();
        await flushAsyncTasks(4);
        const openedSite = [...document.querySelectorAll('#sites-list .options-site-item')][0];
        expect(openedSite.classList.contains('open')).toBe(true);
        expect(openedSite.querySelector('.options-site-main').getAttribute('aria-expanded')).toBe('true');
        expect(openedSite.querySelector('.options-site-images').style.overflowY).toBe('auto');
    });

    test('salva o prompt editado e mostra feedback de sucesso', async () => {
        await loadExtensionPage({
            htmlPath: 'extension/options.html',
            scriptPath: 'extension/options.js',
            fireDOMContentLoaded: true,
        });

        const prompt = document.getElementById('prompt');
        const saveButton = document.getElementById('btn-save');

        prompt.value = 'Novo prompt QA';
        saveButton.click();
        await flushAsyncTasks();

        const data = await storageMock.get(['customPrompt']);
        expect(data.customPrompt).toBe('Novo prompt QA');
        expect(document.getElementById('status').textContent).toContain('Salvo com sucesso');
    });

    test('revoga permissao de um site e re-renderiza a lista', async () => {
        await storageMock.set({
            enabledDomains: ['reader.test', 'mirror.test'],
            'siteMeta_reader.test': { title: 'Reader Oficial' },
            'siteMeta_mirror.test': { title: 'Mirror Hub' },
        });

        await loadExtensionPage({
            htmlPath: 'extension/options.html',
            scriptPath: 'extension/options.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(4);

        const buttons = [...document.querySelectorAll('#sites-list button')];
        buttons[0].click();
        await flushAsyncTasks(6);

        const data = await storageMock.get(['enabledDomains']);
        expect(data.enabledDomains).toEqual(['mirror.test']);
        expect(document.querySelectorAll('#sites-list button')).toHaveLength(1);
        expect(document.getElementById('status').textContent).toContain('Permissão revogada');
    });

    test('revogar site remove a gaveta mesmo quando o dominio ainda tem imagem salva', async () => {
        const cleanUrl = 'https://reader.test/persistida.png';
        await storageMock.set({
            enabledDomains: ['reader.test'],
            'siteMeta_reader.test': { title: 'Reader Oficial' },
            chapterList: [{
                id: 'chap_options_remove',
                title: 'Capítulo Persistido',
                url: 'https://reader.test/cap',
                timestamp: 1710000000000,
            }],
            chap_options_remove_restoreMap: {
                [cleanUrl]: 'data:image/png;base64,UkVBREVS',
            },
            chap_options_remove_restoreMeta: {
                [cleanUrl]: { host: 'reader.test', sourceUrl: cleanUrl, index: 0, updatedAt: 1710000000000 },
            },
        });

        await loadExtensionPage({
            htmlPath: 'extension/options.html',
            scriptPath: 'extension/options.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(6);

        document.querySelector('#sites-list .options-site-item button').click();
        await flushAsyncTasks(8);

        const data = await storageMock.get(['enabledDomains', 'siteMeta_reader.test']);
        expect(data.enabledDomains).toEqual([]);
        expect(data['siteMeta_reader.test']).toBeUndefined();
        expect(document.querySelectorAll('#sites-list .options-site-item')).toHaveLength(0);
        expect(document.getElementById('sites-list').textContent).toContain('Nenhum site permitido');
    });

    test('agrupa imagens especificas por site e bloqueia somente a imagem escolhida', async () => {
        const readerUrl = 'https://reader.test/p1.png';
        const mirrorUrl = 'https://mirror.test/p2.png';
        await storageMock.set({
            enabledDomains: ['reader.test', 'mirror.test'],
            chapterList: [
                {
                    id: 'chap_reader',
                    title: 'Capítulo Reader',
                    url: 'https://reader.test/cap',
                    timestamp: 1710000000000,
                },
                {
                    id: 'chap_mirror',
                    title: 'Capítulo Mirror',
                    url: 'https://mirror.test/cap',
                    timestamp: 1710000000000,
                },
            ],
            chap_reader_restoreMap: {
                [readerUrl]: 'data:image/png;base64,READER',
            },
            chap_reader_restoreMeta: {
                [readerUrl]: { host: 'reader.test', sourceUrl: readerUrl, index: 0, updatedAt: 1710000002000 },
            },
            chap_mirror_restoreMap: {
                [mirrorUrl]: 'data:image/png;base64,MIRROR',
            },
            chap_mirror_restoreMeta: {
                [mirrorUrl]: { host: 'mirror.test', sourceUrl: mirrorUrl, index: 1, updatedAt: 1710000001000 },
            },
        });

        await loadExtensionPage({
            htmlPath: 'extension/options.html',
            scriptPath: 'extension/options.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(6);

        const siteItems = [...document.querySelectorAll('#sites-list .options-site-item')];
        const readerSite = siteItems.find(item => item.textContent.includes('reader.test'));
        const mirrorSite = siteItems.find(item => item.textContent.includes('mirror.test'));

        expect(readerSite.querySelectorAll('.options-image-item')).toHaveLength(1);
        expect(readerSite.textContent).toContain('Capítulo Reader');
        expect(readerSite.textContent).not.toContain('Capítulo Mirror');
        expect(mirrorSite.querySelectorAll('.options-image-item')).toHaveLength(1);
        expect(mirrorSite.textContent).toContain('Capítulo Mirror');

        readerSite.querySelector('.options-image-block-btn').click();
        await flushAsyncTasks(6);

        const data = await storageMock.get(['autoRestoreBlockedImages']);
        expect(data.autoRestoreBlockedImages[readerUrl]).toEqual(expect.objectContaining({
            cleanUrl: readerUrl,
            host: 'reader.test',
            chapterTitle: 'Capítulo Reader',
        }));
        expect(data.autoRestoreBlockedImages[mirrorUrl]).toBeUndefined();
    });

    test('botao Refazer nas opcoes apaga restoreMap, imagens, paths e cache GTC da imagem', async () => {
        const cleanUrl = 'https://reader.test/wrong.png';
        const keepUrl = 'https://reader.test/keep.png';
        const sendSpy = jest.spyOn(global.chrome.runtime, 'sendMessage').mockImplementation((message, callback) => {
            if (callback) setTimeout(() => callback({ ok: true, deleted: 1 }), 0);
        });

        await storageMock.set({
            enabledDomains: ['reader.test'],
            chapterList: [{
                id: 'chap_options_redo',
                title: 'Capítulo Options Refazer',
                url: 'https://reader.test/cap',
                timestamp: 1710000000000,
            }],
            chap_options_redo_images: {
                0: 'data:image/png;base64,ERRADA',
                1: 'data:image/png;base64,CERTA',
            },
            chap_options_redo_paths: {
                0: 'C:\\Downloads\\errada.png',
                1: 'C:\\Downloads\\certa.png',
            },
            chap_options_redo_restoreMap: {
                [cleanUrl]: 'data:image/png;base64,ERRADA',
                [keepUrl]: 'data:image/png;base64,CERTA',
            },
            chap_options_redo_restoreMeta: {
                [cleanUrl]: { host: 'reader.test', sourceUrl: cleanUrl, index: 0, updatedAt: 1710000002000 },
                [keepUrl]: { host: 'reader.test', sourceUrl: keepUrl, index: 1, updatedAt: 1710000001000 },
            },
            autoRestoreBlockedImages: {
                [cleanUrl]: { cleanUrl, host: 'reader.test' },
            },
        });

        await loadExtensionPage({
            htmlPath: 'extension/options.html',
            scriptPath: 'extension/options.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(6);

        document.querySelector('.options-image-redo-btn').click();
        await flushAsyncTasks(10);

        const data = await storageMock.get([
            'chap_options_redo_images',
            'chap_options_redo_paths',
            'chap_options_redo_restoreMap',
            'chap_options_redo_restoreMeta',
            'autoRestoreBlockedImages',
        ]);

        expect(data.chap_options_redo_restoreMap[cleanUrl]).toBeUndefined();
        expect(data.chap_options_redo_restoreMap[keepUrl]).toBe('data:image/png;base64,CERTA');
        expect(data.chap_options_redo_restoreMeta[cleanUrl]).toBeUndefined();
        expect(data.chap_options_redo_images[0]).toBeUndefined();
        expect(data.chap_options_redo_images[1]).toBe('data:image/png;base64,CERTA');
        expect(data.chap_options_redo_paths[0]).toBeUndefined();
        expect(data.autoRestoreBlockedImages[cleanUrl]).toBeUndefined();
        expect(sendSpy).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'GTC_DELETE_BY_CLEAN_URL', cleanUrl }),
            expect.any(Function)
        );
        expect(document.querySelectorAll('.options-image-item')).toHaveLength(1);
    });
    test('modo de exclusão segura é restaurado e persistido nas opções', async () => {
        await storageMock.set({ geminiExecutionMode: 'background_delete' });

        await loadExtensionPage({
            htmlPath: 'extension/options.html',
            scriptPath: 'extension/options.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(4);

        const secureMode = document.getElementById('gemini-mode-delete');
        expect(secureMode).not.toBeNull();
        expect(secureMode.checked).toBe(true);

        document.getElementById('gemini-mode-temp').checked = true;
        document.getElementById('gemini-mode-temp').dispatchEvent(new Event('change', { bubbles: true }));
        await flushAsyncTasks(4);
        expect((await storageMock.get(['geminiExecutionMode'])).geminiExecutionMode).toBe('temp_chat');

        secureMode.checked = true;
        secureMode.dispatchEvent(new Event('change', { bubbles: true }));
        await flushAsyncTasks(4);
        expect((await storageMock.get(['geminiExecutionMode'])).geminiExecutionMode).toBe('background_delete');
        expect(document.getElementById('gemini-mode-status').textContent).toContain('Exclusão Segura');
    });
});

