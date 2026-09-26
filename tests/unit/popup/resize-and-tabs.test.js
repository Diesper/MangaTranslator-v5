/**
 * resize-and-tabs.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa o redimensionamento bidimensional (2D resizing) do popup e o
 * agrupamento de imagens banidas por domínio em pastas colapsáveis na arquitetura atual.
 */

const { loadExtensionPage, flushAsyncTasks } = require('../../helpers/load-extension-page.js');
const { getStorageMock, getTabsMock } = require('../../mocks/chrome-api.mock.js');

describe('Popup 2D Resizing e Agrupamento de Banidas — popup.js', () => {
    let storageMock;
    let tabsMock;

    beforeEach(async () => {
        jest.resetModules();
        storageMock = getStorageMock();
        tabsMock = getTabsMock();
        await storageMock.clear();
        document.documentElement.innerHTML = '<html><head></head><body></body></html>';

        window.requestAnimationFrame = (cb) => cb();
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
            get: function() { return parseInt(this.style.width, 10) || 500; },
            configurable: true,
        });
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
            get: function() { return parseInt(this.style.height, 10) || 600; },
            configurable: true,
        });
    });

    afterEach(() => {
        delete HTMLElement.prototype.offsetWidth;
        delete HTMLElement.prototype.offsetHeight;
        jest.restoreAllMocks();
    });

    test('carrega dimensões salvas em popupSize ou aplica padrão 500x600', async () => {
        await storageMock.set({
            popupSize: { width: 650, height: 550 },
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

        expect(document.body.style.width).toBe('650px');
        expect(document.body.style.height).toBe('550px');
    });

    test('cria alças de redimensionamento e salva novas dimensões ao soltar o mouse', async () => {
        await storageMock.set({
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

        const resizerBR = document.getElementById('resizer-br');
        expect(resizerBR).not.toBeNull();

        // Simula clique e arrasto no resizer diagonal (both)
        resizerBR.dispatchEvent(new MouseEvent('mousedown', { screenX: 100, screenY: 100, bubbles: true }));

        // Simula movimento
        document.dispatchEvent(new MouseEvent('mousemove', { screenX: 250, screenY: 200, bubbles: true }));

        // Simula soltar o mouse (salva no storage)
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await flushAsyncTasks(4);

        const saved = await storageMock.get(['popupSize']);
        expect(saved.popupSize).toBeDefined();
        expect(saved.popupSize.width).toBeGreaterThanOrEqual(400);
        expect(saved.popupSize.height).toBeGreaterThanOrEqual(400);
    });

    test('agrupa imagens banidas por domínio em pastas .site-folder separadas', async () => {
        await storageMock.set({
            enabledDomains: ['site-a.com', 'site-b.com'],
            'bannedImages_site-a.com': ['https://site-a.com/ad1.png', 'https://site-a.com/ad2.png'],
            'bannedImages_site-b.com': ['https://site-b.com/banner.png'],
            'siteMeta_site-a.com': { title: '<img src=x onerror=alert(1)>' },
        });

        const activeTab = await tabsMock.create({
            url: 'https://site-a.com/read',
            active: true,
            title: 'Site A',
        });
        tabsMock._activeTabId = activeTab.id;

        await loadExtensionPage({
            htmlPath: 'extension/popup.html',
            scriptPath: 'extension/popup.js',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(8);

        // Abre a aba de banidas
        const bannedTabBtn = document.querySelector('.tab-btn[data-tab="banned-tab"]');
        if (bannedTabBtn) bannedTabBtn.click();
        await flushAsyncTasks(8);

        const folders = document.querySelectorAll('#banned-site-list .site-folder');
        expect(folders).toHaveLength(2);

        const folderCounts = Array.from(document.querySelectorAll('.site-folder-count')).map(el => el.textContent);
        expect(folderCounts).toEqual(['2 ban.', '1 ban.']);
        expect(folders[0].querySelector('.site-folder-name').textContent).toBe('<img src=x onerror=alert(1)>');
        expect(folders[0].querySelector('.site-folder-name img')).toBeNull();
    });
});
