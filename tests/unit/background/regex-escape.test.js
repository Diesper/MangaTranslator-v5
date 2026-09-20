/**
 * regex-escape.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa a regex de escape no fallbackSearch do background.js real (BUG #14 Fix).
 * Garante que caminhos de mangá com '.', '(', ')', '+', '*', '?' sejam
 * escapados corretamente ao realizar chrome.downloads.search({ filenameRegex }).
 */

const path = require('path');
const { loadBackgroundModule } = require('../../helpers/load-background-module.js');
const { getDownloadsMock, getRuntimeMock } = require('../../mocks/chrome-api.mock.js');

function getBackgroundListener(runtimeMock) {
    const listeners = runtimeMock._messageListeners || [];
    return listeners[listeners.length - 1];
}

function dispatchToBackground(runtimeMock, request, sender = { tab: null }) {
    return new Promise((resolve) => {
        const sendResponse = (response) => {
            resolve(response);
        };
        const keepAlive = getBackgroundListener(runtimeMock)(request, sender, sendResponse);
        if (!keepAlive) {
            resolve(undefined);
        }
    });
}

describe('SHOW_EXISTING_FOLDER - Escape de Metacaracteres para Regex no background.js (BUG #14)', () => {
    let downloadsMock;
    let runtimeMock;

    beforeEach(() => {
        downloadsMock = getDownloadsMock();
        downloadsMock._downloads.clear();
        downloadsMock._downloads.set(1, {
            id: 1,
            filename: '/home/user/Downloads/MangaTranslator/One.Piece/p1.png',
            state: 'complete',
            exists: true,
        });
        runtimeMock = getRuntimeMock();
        runtimeMock._messageListeners = [];
        const bgPath = path.resolve(__dirname, '../../../extension/background.js');
        loadBackgroundModule(bgPath);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('escapa ponto "." evitando tratar como qualquer caractere', async () => {
        const searchSpy = jest.spyOn(downloadsMock, 'search');
        await dispatchToBackground(runtimeMock, {
            action: 'SHOW_EXISTING_FOLDER',
            folderPath: 'MangaTranslator/One.Piece',
            safeTitle: 'One.Piece',
        });

        expect(searchSpy).toHaveBeenCalled();
        const query = searchSpy.mock.calls[0][0];
        expect(query.filenameRegex).toBe('MangaTranslator/One\\.Piece');

        const regex = new RegExp(query.filenameRegex);
        expect(regex.test('/home/user/Downloads/MangaTranslator/One.Piece')).toBe(true);
        expect(regex.test('/home/user/Downloads/MangaTranslator/OneXPiece')).toBe(false);
    });

    test('escapa parênteses "(" e ")"', async () => {
        const searchSpy = jest.spyOn(downloadsMock, 'search');
        await dispatchToBackground(runtimeMock, {
            action: 'SHOW_EXISTING_FOLDER',
            folderPath: 'MangaTranslator/One Piece (Fan Sub)',
            safeTitle: 'One Piece (Fan Sub)',
        });

        expect(searchSpy).toHaveBeenCalled();
        const query = searchSpy.mock.calls[0][0];
        expect(query.filenameRegex).toBe('MangaTranslator/One Piece \\(Fan Sub\\)');

        const regex = new RegExp(query.filenameRegex);
        expect(regex.test('MangaTranslator/One Piece (Fan Sub)')).toBe(true);
        expect(regex.test('MangaTranslator/One Piece xFan Subx')).toBe(false);
    });

    test('escapa sinal de mais "+"', async () => {
        const searchSpy = jest.spyOn(downloadsMock, 'search');
        await dispatchToBackground(runtimeMock, {
            action: 'SHOW_EXISTING_FOLDER',
            folderPath: 'MangaTranslator/Dragon+Ball',
            safeTitle: 'Dragon+Ball',
        });

        expect(searchSpy).toHaveBeenCalled();
        const query = searchSpy.mock.calls[0][0];
        expect(query.filenameRegex).toBe('MangaTranslator/Dragon\\+Ball');

        const regex = new RegExp(query.filenameRegex);
        expect(regex.test('MangaTranslator/Dragon+Ball')).toBe(true);
        expect(regex.test('MangaTranslator/DragonBall')).toBe(false);
    });

    test('escapa asterisco "*" e ponto de interrogação "?"', async () => {
        const searchSpy = jest.spyOn(downloadsMock, 'search');
        await dispatchToBackground(runtimeMock, {
            action: 'SHOW_EXISTING_FOLDER',
            folderPath: 'MangaTranslator/Title*Name?',
            safeTitle: 'Title*Name?',
        });

        expect(searchSpy).toHaveBeenCalled();
        const query = searchSpy.mock.calls[0][0];
        expect(query.filenameRegex).toBe('MangaTranslator/Title\\*Name\\?');

        const regex = new RegExp(query.filenameRegex);
        expect(regex.test('MangaTranslator/Title*Name?')).toBe(true);
    });

    test('path complexo do mundo real não lança SyntaxError e faz match exato', async () => {
        const searchSpy = jest.spyOn(downloadsMock, 'search');
        const complexPath = 'MangaTranslator/Test (Arc) v2.0+/page_001.png';
        await dispatchToBackground(runtimeMock, {
            action: 'SHOW_EXISTING_FOLDER',
            folderPath: complexPath,
            safeTitle: 'Test',
        });

        expect(searchSpy).toHaveBeenCalled();
        const query = searchSpy.mock.calls[0][0];
        expect(() => new RegExp(query.filenameRegex)).not.toThrow();

        const regex = new RegExp(query.filenameRegex);
        expect(regex.test(complexPath)).toBe(true);
    });
});
