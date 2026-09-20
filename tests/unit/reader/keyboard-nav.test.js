/**
 * keyboard-nav.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa a navegação por teclado do leitor offline usando reader.html e reader.js reais.
 */

const { loadExtensionPage, flushAsyncTasks } = require('../../helpers/load-extension-page.js');
const { getStorageMock } = require('../../mocks/chrome-api.mock.js');

describe('RD-14/RD-15/RD-16/RD-17/RD-18: reader.js - Navegação por Teclado Real', () => {
    let storageMock;
    let scrollBySpy;
    let scrollToSpy;
    let requestFullscreenSpy;
    let exitFullscreenSpy;

    beforeEach(async () => {
        jest.resetModules();
        storageMock = getStorageMock();
        await storageMock.clear();
        localStorage.clear();
        document.documentElement.innerHTML = '<html><head></head><body></body></html>';

        scrollBySpy = jest.fn();
        scrollToSpy = jest.fn();
        window.scrollBy = scrollBySpy;
        window.scrollTo = scrollToSpy;
        window.innerHeight = 800;

        requestFullscreenSpy = jest.fn().mockResolvedValue();
        exitFullscreenSpy = jest.fn().mockResolvedValue();
        Element.prototype.requestFullscreen = requestFullscreenSpy;
        document.exitFullscreen = exitFullscreenSpy;
        Object.defineProperty(document, 'fullscreenElement', {
            configurable: true,
            writable: true,
            value: null,
        });

        await storageMock.set({
            chapterList: [{ id: 'chap_nav', title: 'Test Nav' }],
            chap_nav_images: {
                0: 'data:image/png;base64,P0',
                1: 'data:image/png;base64,P1',
            },
        });

        await loadExtensionPage({
            htmlPath: 'extension/reader.html',
            scriptPath: 'extension/reader.js',
            url: 'https://extension.test/reader.html?id=chap_nav',
            fireDOMContentLoaded: true,
        });
        await flushAsyncTasks(6);
    });

    afterEach(() => {
        delete Element.prototype.requestFullscreen;
        delete document.exitFullscreen;
        jest.restoreAllMocks();
    });

    test('ArrowRight e ArrowDown avançam o scroll em 88% do viewport', () => {
        const eventRight = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
        const preventDefaultRight = jest.spyOn(eventRight, 'preventDefault');
        document.dispatchEvent(eventRight);

        expect(preventDefaultRight).toHaveBeenCalled();
        expect(scrollBySpy).toHaveBeenCalledWith({
            top: 800 * 0.88,
            behavior: 'smooth',
        });

        scrollBySpy.mockClear();
        const eventDown = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
        document.dispatchEvent(eventDown);

        expect(scrollBySpy).toHaveBeenCalledWith({
            top: 800 * 0.88,
            behavior: 'smooth',
        });
    });

    test('ArrowLeft e ArrowUp recuam o scroll em 88% do viewport', () => {
        const eventLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true });
        const preventDefaultLeft = jest.spyOn(eventLeft, 'preventDefault');
        document.dispatchEvent(eventLeft);

        expect(preventDefaultLeft).toHaveBeenCalled();
        expect(scrollBySpy).toHaveBeenCalledWith({
            top: -(800 * 0.88),
            behavior: 'smooth',
        });

        scrollBySpy.mockClear();
        const eventUp = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
        document.dispatchEvent(eventUp);

        expect(scrollBySpy).toHaveBeenCalledWith({
            top: -(800 * 0.88),
            behavior: 'smooth',
        });
    });

    test('f ou F alterna tela cheia (requestFullscreen / exitFullscreen)', () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
        expect(requestFullscreenSpy).toHaveBeenCalled();
        expect(exitFullscreenSpy).not.toHaveBeenCalled();

        requestFullscreenSpy.mockClear();
        document.fullscreenElement = document.documentElement;

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F' }));
        expect(exitFullscreenSpy).toHaveBeenCalled();
        expect(requestFullscreenSpy).not.toHaveBeenCalled();
    });

    test('Home rola para o topo e End rola para o final', () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', cancelable: true }));
        expect(scrollToSpy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });

        scrollToSpy.mockClear();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', cancelable: true }));
        expect(scrollToSpy).toHaveBeenCalledWith({ top: document.body.scrollHeight, behavior: 'smooth' });
    });

    test('teclas não mapeadas não provocam scroll', () => {
        const eventA = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
        const preventDefaultA = jest.spyOn(eventA, 'preventDefault');
        document.dispatchEvent(eventA);

        expect(preventDefaultA).not.toHaveBeenCalled();
        expect(scrollBySpy).not.toHaveBeenCalled();
        expect(scrollToSpy).not.toHaveBeenCalled();
    });
});
