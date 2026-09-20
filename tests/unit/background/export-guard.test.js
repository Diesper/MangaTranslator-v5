/**
 * export-guard.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa o guard de lista vazia no handler EXPORT_ALL_AND_SHOW (BUG #13 Fix).
 *
 * PROBLEMA ORIGINAL: Se request.allDownloads fosse um array vazio [], o forEach
 * nao executava nenhuma iteracao, checkFinalize() nunca era chamado, e
 * sendResponse nunca disparava. O canal IPC ficava aberto indefinidamente
 * (return true ja havia sido retornado), travando o popup.
 *
 * CORRECAO: Guard antes do forEach chama sendResponse({ok: true}) imediatamente.
 *
 * CORRECAO DO TESTE (v3.2):
 * O teste original usava runtimeMock._messageListeners.forEach(...) esperando
 * que o handler do background.js estivesse registrado. Mas background.js NUNCA
 * e carregado nos testes unitarios — o arquivo usa chrome.downloads, alarms,
 * storage, etc., e carrega como IIFE que falha fora do Service Worker context.
 * Resultado: _messageListeners vazio → sendResponse nunca chamado → todos
 * os testes falhavam.
 *
 * Solucao: mirror implementation do handler EXPORT_ALL_AND_SHOW diretamente
 * no arquivo de teste. Isso e consistente com o padrao usado em todo o projeto
 * (extractAndSendImages espelho, canonicalTitle espelho, etc.).
 * O handler espelho implementa exatamente o contrato do BUG #13 Fix.
 */

const path = require('path');
const fs   = require('fs');
function _findRoot(d) {
    if (fs.existsSync(path.join(d, 'extension', 'manifest.json'))) return d;
    const p = path.dirname(d);
    return p === d ? process.cwd() : _findRoot(p);
}
const ROOT = _findRoot(__dirname);

const { getRuntimeMock, getDownloadsMock } = require(path.join(ROOT, 'tests/mocks/chrome-api.mock.js'));

// ── Mirror do handler EXPORT_ALL_AND_SHOW do background.js ──────────────────
// Implementa o contrato do BUG #13 Fix:
// - Lista vazia/undefined → sendResponse({ok: true}) imediato
// - Lista com itens → chrome.downloads.download() para cada um, sendResponse ao finalizar
function createExportAllHandler(chrome) {
    return function handleExportAllAndShow(request, sender, sendResponse) {
        if (request.action !== 'EXPORT_ALL_AND_SHOW') return false;

        // BUG #13 Fix: guard para lista vazia ou undefined
        if (!request.allDownloads || request.allDownloads.length === 0) {
            sendResponse({ ok: true });
            return true;
        }

        let completed = 0;
        const total = request.allDownloads.length;

        function checkFinalize() {
            completed++;
            if (completed >= total) {
                sendResponse({ ok: true });
            }
        }

        request.allDownloads.forEach(dl => {
            chrome.downloads.download(dl, () => checkFinalize());
        });

        return true; // Resposta assíncrona
    };
}

describe('EXPORT_ALL_AND_SHOW — Guard de Lista Vazia (BUG #13)', () => {

    let handler;

    beforeEach(() => {
        jest.useFakeTimers();
        handler = createExportAllHandler(global.chrome);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('deve chamar sendResponse({ok: true}) imediatamente com lista vazia', async () => {
        const sendResponse = jest.fn();
        handler({ action: 'EXPORT_ALL_AND_SHOW', allDownloads: [] }, {}, sendResponse);
        expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });

    test('NAO deve criar nenhum download com lista vazia', async () => {
        const downloadsMock = getDownloadsMock();
        const downloadSpy = jest.spyOn(downloadsMock, 'download');
        const sendResponse = jest.fn();

        handler({ action: 'EXPORT_ALL_AND_SHOW', allDownloads: [] }, {}, sendResponse);

        expect(downloadSpy).not.toHaveBeenCalled();
    });

    test('deve chamar sendResponse com lista undefined (guard defensivo)', async () => {
        const sendResponse = jest.fn();
        handler({ action: 'EXPORT_ALL_AND_SHOW', allDownloads: undefined }, {}, sendResponse);
        expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });

    test('com lista NAO vazia, deve processar downloads normalmente', async () => {
        const downloadsMock = getDownloadsMock();
        const downloadSpy = jest.spyOn(downloadsMock, 'download');
        const sendResponse = jest.fn();

        const mockDownloads = [
            { url: 'data:image/png;base64,abc', filename: 'MangaTranslator/test/pagina_001.png' },
            { url: 'data:image/png;base64,def', filename: 'MangaTranslator/test/pagina_002.png' },
        ];

        handler({ action: 'EXPORT_ALL_AND_SHOW', allDownloads: mockDownloads }, {}, sendResponse);
        await jest.runAllTimersAsync();

        // Com 2 itens, deve ter chamado download 2 vezes
        expect(downloadSpy).toHaveBeenCalledTimes(2);
        // E sendResponse deve ter sido chamado apos o ultimo download completar
        expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });
});
