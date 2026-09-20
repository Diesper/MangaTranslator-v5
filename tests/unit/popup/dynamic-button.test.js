/**
 * dynamic-button.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa o comportamento do botão de tradução com contagem dinâmica (UI #2)
 * usando a página real carregada via loadExtensionPage.
 */

const { loadExtensionPage } = require('../../helpers/load-extension-page.js');
const { getStorageMock, getTabsMock } = require('../../mocks/chrome-api.mock.js');

describe('popup.js - Botão de Tradução Dinâmico Real', () => {
    let storageMock;
    let tabsMock;

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

    test('atualiza texto e estado disabled do botão btn-translate conforme a seleção real no DOM', async () => {
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
            } else if (message.action === 'SET_SELECTED_IMAGES' || message.action === 'HIGHLIGHT_IMAGE') {
                sendResponse({ success: true });
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

        const { flushAsyncTasks } = require('../../helpers/load-extension-page.js');
        await flushAsyncTasks(8);

        const btnTranslate = document.getElementById('btn-translate');
        const selectionCount = document.getElementById('selection-count');
        expect(btnTranslate).not.toBeNull();
        expect(selectionCount).not.toBeNull();

        // Inicialmente todas estão selecionadas por padrão (2 imagens)
        expect(selectionCount.textContent).toMatch(/2 imagens selecionadas/);
        expect(btnTranslate.textContent).toBe('Traduzir 2 Páginas');
        expect(btnTranslate.disabled).toBe(false);

        // Deseleciona todas via botão "Nenhuma"
        const btnSelectNone = document.getElementById('btn-select-none');
        if (btnSelectNone) {
            btnSelectNone.click();
            expect(selectionCount.textContent).toMatch(/0 imagens selecionadas/);
            expect(btnTranslate.textContent).toBe('Traduzir Selecionadas');
            expect(btnTranslate.disabled).toBe(true);
        }

        // Seleciona uma imagem clicando no seu card
        const firstCard = document.querySelector('#image-grid .image-card');
        if (firstCard) {
            firstCard.click();
            expect(selectionCount.textContent).toMatch(/1 imagem selecionada/);
            expect(btnTranslate.textContent).toBe('Traduzir 1 Página');
            expect(btnTranslate.disabled).toBe(false);
        }
    });
});

