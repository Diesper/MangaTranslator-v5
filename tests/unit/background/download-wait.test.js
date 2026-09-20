/**
 * download-wait.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa waitForDownload() real do extension/background.js.
 * Listener com Cleanup Garantido (BUG #6 Fix).
 */

const path = require('path');
const { loadBackgroundModule } = require('../../helpers/load-background-module.js');
const { getDownloadsMock } = require('../../mocks/chrome-api.mock.js');

describe('waitForDownload() real de background.js (BUG #6)', () => {
    let bg;
    let downloadsMock;

    beforeEach(() => {
        jest.useFakeTimers();
        downloadsMock = getDownloadsMock();
        downloadsMock._onChangedListeners = [];
        const bgPath = path.resolve(__dirname, '../../../extension/background.js');
        bg = loadBackgroundModule(bgPath);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    function dispatchDownloadChange(delta) {
        // Copia a lista para suportar remoção durante iteração
        [...downloadsMock._onChangedListeners].forEach(fn => fn(delta));
    }

    describe('Download bem-sucedido', () => {
        test('BG-32: chama onComplete com o ID quando estado muda para "complete"', () => {
            const onComplete = jest.fn();
            const onError = jest.fn();

            bg.waitForDownload(42, onComplete, onError);

            // Simula evento de conclusão
            dispatchDownloadChange({ id: 42, state: { current: 'complete' } });

            expect(onComplete).toHaveBeenCalledWith(42);
            expect(onError).not.toHaveBeenCalled();
        });

        test('BG-34: ignora eventos de outros downloads (ID diferente)', () => {
            const onComplete = jest.fn();

            bg.waitForDownload(42, onComplete, jest.fn());

            // Evento de download ID 99 (outro download)
            dispatchDownloadChange({ id: 99, state: { current: 'complete' } });

            expect(onComplete).not.toHaveBeenCalled();
        });

        test('remove o listener após completar (sem memory leak)', () => {
            const listenersBefore = downloadsMock._onChangedListeners.length;

            bg.waitForDownload(42, jest.fn(), jest.fn());
            expect(downloadsMock._onChangedListeners.length).toBe(listenersBefore + 1);

            // Simula conclusão
            dispatchDownloadChange({ id: 42, state: { current: 'complete' } });

            expect(downloadsMock._onChangedListeners.length).toBe(listenersBefore);
        });

        test('não chama onComplete duas vezes para o mesmo download', () => {
            const onComplete = jest.fn();

            bg.waitForDownload(42, onComplete, jest.fn());

            dispatchDownloadChange({ id: 42, state: { current: 'complete' } });
            dispatchDownloadChange({ id: 42, state: { current: 'complete' } });

            expect(onComplete).toHaveBeenCalledTimes(1);
        });
    });

    describe('Download interrompido', () => {
        test('BG-33: chama onError quando estado muda para "interrupted"', () => {
            const onComplete = jest.fn();
            const onError = jest.fn();

            bg.waitForDownload(42, onComplete, onError);

            dispatchDownloadChange({ id: 42, state: { current: 'interrupted' } });

            expect(onError).toHaveBeenCalledWith(expect.any(Error));
            expect(onError.mock.calls[0][0].message).toContain('interrupted');
            expect(onComplete).not.toHaveBeenCalled();
        });

        test('remove o listener após interrupção', () => {
            const listenersBefore = downloadsMock._onChangedListeners.length;

            bg.waitForDownload(42, jest.fn(), jest.fn());
            expect(downloadsMock._onChangedListeners.length).toBe(listenersBefore + 1);

            dispatchDownloadChange({ id: 42, state: { current: 'interrupted' } });

            expect(downloadsMock._onChangedListeners.length).toBe(listenersBefore);
        });
    });

    describe('Safety timer de 10 minutos', () => {
        test('BG-35: remove listener após 10 minutos sem resposta', () => {
            const onError = jest.fn();
            const listenersBefore = downloadsMock._onChangedListeners.length;

            bg.waitForDownload(42, jest.fn(), onError);
            expect(downloadsMock._onChangedListeners.length).toBe(listenersBefore + 1);

            // Avança 10 minutos (600.000ms)
            jest.advanceTimersByTime(600_000);

            expect(onError).toHaveBeenCalledWith(expect.any(Error));
            expect(onError.mock.calls[0][0].message).toContain('timeout');
            expect(downloadsMock._onChangedListeners.length).toBe(listenersBefore);
        });

        test('BG-36: safety timer sem onError fornecido não lança exceção após timeout', () => {
            expect(() => {
                bg.waitForDownload(42, jest.fn(), undefined);
                jest.advanceTimersByTime(600_000);
            }).not.toThrow();
        });

        test('safety timer é cancelado quando download completa antes', () => {
            const onError = jest.fn();

            bg.waitForDownload(42, jest.fn(), onError);

            // Completa antes do timeout
            dispatchDownloadChange({ id: 42, state: { current: 'complete' } });

            // Avança além do timeout
            jest.advanceTimersByTime(700_000);

            // onError não deve ter sido chamado pelo timer
            expect(onError).not.toHaveBeenCalled();
        });
    });

    describe('Múltiplos downloads em paralelo', () => {
        test('múltiplos waitForDownload não interferem entre si', () => {
            const complete10 = jest.fn();
            const complete20 = jest.fn();

            bg.waitForDownload(10, complete10, jest.fn());
            bg.waitForDownload(20, complete20, jest.fn());

            // Completa download 10
            dispatchDownloadChange({ id: 10, state: { current: 'complete' } });

            expect(complete10).toHaveBeenCalledWith(10);
            expect(complete20).not.toHaveBeenCalled();

            // Completa download 20
            dispatchDownloadChange({ id: 20, state: { current: 'complete' } });

            expect(complete20).toHaveBeenCalledWith(20);
        });
    });
});
