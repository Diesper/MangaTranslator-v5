const {
    loadExtensionPage,
    flushAsyncTasks,
} = require('../helpers/load-extension-page.js');
const { getStorageMock } = require('../mocks/chrome-api.mock.js');

describe('RD-01/RD-02/RD-03/RD-04/RD-05/RD-06/RD-07/RD-08/RD-09/RD-10/RD-11/RD-12/RD-13/RD-19: reader.js + reader.html - integracao real', () => {
    let storageMock;

    beforeEach(async () => {
        jest.resetModules();
        storageMock = getStorageMock();
        await storageMock.clear();
        localStorage.clear();
        document.documentElement.innerHTML = '<html><head></head><body></body></html>';
        jest.spyOn(window, 'close').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('renderiza titulo, contador inicial e paginas do capitulo salvo', async () => {
        await storageMock.set({
            chapterList: [{ id: 'chap_1', title: 'One Piece 1050' }],
            chap_1_images: {
                0: 'data:image/png;base64,PAGE_0',
                1: 'data:image/png;base64,PAGE_1',
            },
        });

        await loadExtensionPage({
            htmlPath: 'extension/reader.html',
            scriptPath: 'extension/reader.js',
            url: 'https://extension.test/reader.html?id=chap_1',
        });

        await flushAsyncTasks(6);

        expect(document.getElementById('chapter-title').textContent).toBe('One Piece 1050');
        expect(document.getElementById('page-counter').textContent).toBe('1 / 2');
        expect(document.getElementById('read-progress-fill').style.width).toBe('50%');
        expect(document.querySelectorAll('.reader-page-wrap')).toHaveLength(2);
        expect(document.querySelectorAll('.reader-page-wrap img')).toHaveLength(2);
        expect(document.querySelector('.page-label').textContent).toBe('Página 1');
    });

    test('usa largura salva no localStorage e persiste nova largura ao mover o slider', async () => {
        localStorage.setItem('readerWidth', '950');
        await storageMock.set({
            chapterList: [{ id: 'chap_2', title: 'Solo Leveling 10' }],
            chap_2_images: { 0: 'data:image/png;base64,PAGE_ONLY' },
        });

        await loadExtensionPage({
            htmlPath: 'extension/reader.html',
            scriptPath: 'extension/reader.js',
            url: 'https://extension.test/reader.html?id=chap_2',
        });

        await flushAsyncTasks(6);

        const container = document.getElementById('reader-container');
        const slider = document.getElementById('width-slider');
        const widthVal = document.getElementById('width-val');

        expect(container.style.maxWidth).toBe('950px');
        expect(widthVal.textContent).toBe('950px');

        slider.value = '1100';
        slider.dispatchEvent(new Event('input', { bubbles: true }));

        expect(container.style.maxWidth).toBe('1100px');
        expect(widthVal.textContent).toBe('1100px');
        expect(localStorage.getItem('readerWidth')).toBe('1100');
    });

    test('cai para 800px quando a largura salva no localStorage está fora da faixa permitida', async () => {
        localStorage.setItem('readerWidth', '5000');
        await storageMock.set({
            chapterList: [{ id: 'chap_3', title: 'Capitulo Largo Demais' }],
            chap_3_images: { 0: 'data:image/png;base64,PAGE_ONLY' },
        });

        await loadExtensionPage({
            htmlPath: 'extension/reader.html',
            scriptPath: 'extension/reader.js',
            url: 'https://extension.test/reader.html?id=chap_3',
        });

        await flushAsyncTasks(6);

        expect(document.getElementById('reader-container').style.maxWidth).toBe('800px');
        expect(document.getElementById('width-slider').value).toBe('800');
        expect(document.getElementById('width-val').textContent).toBe('800px');
    });

    test('botao fechar delega para window.close', async () => {
        await storageMock.set({
            chapterList: [{ id: 'chap_4', title: 'Fechar Reader' }],
            chap_4_images: { 0: 'data:image/png;base64,PAGE_ONLY' },
        });

        await loadExtensionPage({
            htmlPath: 'extension/reader.html',
            scriptPath: 'extension/reader.js',
            url: 'https://extension.test/reader.html?id=chap_4',
        });

        await flushAsyncTasks(6);

        document.getElementById('close-btn').click();

        expect(window.close).toHaveBeenCalledTimes(1);
    });

    test('mostra estado vazio quando nao existe capitulo na URL ou nao ha imagens', async () => {
        await loadExtensionPage({
            htmlPath: 'extension/reader.html',
            scriptPath: 'extension/reader.js',
            url: 'https://extension.test/reader.html',
        });

        await flushAsyncTasks(4);

        expect(document.getElementById('chapter-title').textContent).toBe('ID inválido');
        expect(document.getElementById('reader-container').textContent).toContain('Nenhum capítulo especificado na URL');

        jest.resetModules();
        document.documentElement.innerHTML = '<html><head></head><body></body></html>';

        await storageMock.set({
            chapterList: [{ id: 'chap_empty', title: 'Capitulo Vazio' }],
            chap_empty_images: {},
        });

        await loadExtensionPage({
            htmlPath: 'extension/reader.html',
            scriptPath: 'extension/reader.js',
            url: 'https://extension.test/reader.html?id=chap_empty',
        });

        await flushAsyncTasks(6);

        expect(document.getElementById('chapter-title').textContent).toBe('Capitulo Vazio');
        expect(document.getElementById('reader-container').textContent).toContain('Nenhuma imagem salva neste capítulo');
        expect(document.getElementById('page-counter').textContent).toBe('0 / 0');
    });
});
