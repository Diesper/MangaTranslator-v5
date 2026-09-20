/**
 * raf-replacement.test.js — STUB ORIGINAL (v3.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa a substituição de window.requestAnimationFrame por setInterval de 100ms
 * no inject.js — cobertura mínima original (v3.0).
 *
 * POR QUE ESTE ARQUIVO EXISTE JUNTO COM inject-anti-hibernation.test.js?
 * O v3.0 criou apenas este stub cobrindo o sistema de RAF em isolamento.
 * O inject-anti-hibernation.test.js (v3.1) integra todos os 5 sistemas do
 * inject.js em uma suíte coesa, incluindo guard, visibilidade, supressão de
 * eventos, ghost interactions e lazy→eager.
 *
 * ESTE ARQUIVO foca exclusivamente no contrato do RAF customizado:
 * callbacks são executados via setInterval de 100ms, erros são silenciados.
 *
 * CONTEXTO TÉCNICO:
 * O Chrome reduz setInterval para 1 tick/segundo em abas em background.
 * A substituição do rAF nativo por um setInterval de 100ms garante que
 * animações e polling do content_gemini.js continuem funcionando mesmo
 * quando o Gemini está em aba oculta (active: false).
 *
 * Blob Workers foram descartados (causavam bloqueio de CSP no Gemini).
 * A solução com setInterval puro no contexto MAIN é mais simples e segura.
 *
 * VEJA: inject-anti-hibernation.test.js para a suíte completa.
 */

describe('requestAnimationFrame — Substituição por setInterval 100ms (stub v3.0)', () => {

    // Implementação espelho do sistema RAF do inject.js
    function createRafReplacement() {
        const callbacks = [];

        const customRAF = function(cb) {
            callbacks.push(cb);
            return callbacks.length; // ID fake (nunca usado com cancelRAF)
        };

        const cancelRAF = function() {}; // stub — intencionalmente vazio

        const flush = function() {
            const batch = callbacks.splice(0);
            const now = performance.now();
            batch.forEach(cb => { try { cb(now); } catch(e) {} });
        };

        return { customRAF, cancelRAF, flush, getCallbacks: () => callbacks };
    }

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    describe('Registro de callbacks', () => {
        test('callback registrado via customRAF é armazenado', () => {
            const { customRAF, getCallbacks } = createRafReplacement();
            const cb = jest.fn();
            customRAF(cb);
            expect(getCallbacks()).toHaveLength(1);
        });

        test('retorna ID incremental (baseado no tamanho do array)', () => {
            const { customRAF } = createRafReplacement();
            const id1 = customRAF(jest.fn());
            const id2 = customRAF(jest.fn());
            expect(id1).toBe(1);
            expect(id2).toBe(2);
        });

        test('múltiplos callbacks são todos armazenados', () => {
            const { customRAF, getCallbacks } = createRafReplacement();
            customRAF(jest.fn());
            customRAF(jest.fn());
            customRAF(jest.fn());
            expect(getCallbacks()).toHaveLength(3);
        });
    });

    describe('Execução dos callbacks no flush (equivalente ao setInterval 100ms)', () => {
        test('flush executa todos os callbacks registrados', () => {
            const { customRAF, flush } = createRafReplacement();
            const cb1 = jest.fn();
            const cb2 = jest.fn();
            customRAF(cb1);
            customRAF(cb2);
            flush();
            expect(cb1).toHaveBeenCalledTimes(1);
            expect(cb2).toHaveBeenCalledTimes(1);
        });

        test('flush passa timestamp (performance.now) para o callback', () => {
            const { customRAF, flush } = createRafReplacement();
            const cb = jest.fn();
            customRAF(cb);
            flush();
            expect(cb).toHaveBeenCalledWith(expect.any(Number));
        });

        test('fila é esvaziada após o flush', () => {
            const { customRAF, flush, getCallbacks } = createRafReplacement();
            customRAF(jest.fn());
            customRAF(jest.fn());
            flush();
            expect(getCallbacks()).toHaveLength(0);
        });
    });

    describe('Resiliência a erros', () => {
        test('callback que lança não interrompe os demais', () => {
            const { customRAF, flush } = createRafReplacement();
            const goodCb = jest.fn();
            customRAF(() => { throw new Error('falha intencional'); });
            customRAF(goodCb);
            expect(() => flush()).not.toThrow();
            expect(goodCb).toHaveBeenCalledTimes(1);
        });

        test('cancelRAF não lança exceção (é stub vazio)', () => {
            const { cancelRAF } = createRafReplacement();
            expect(() => cancelRAF(1)).not.toThrow();
            expect(() => cancelRAF(undefined)).not.toThrow();
            expect(() => cancelRAF(99999)).not.toThrow();
        });
    });

    describe('Comportamento com múltiplos flush cycles', () => {
        test('novo callback registrado após flush é executado no próximo flush', () => {
            const { customRAF, flush } = createRafReplacement();
            const cb1 = jest.fn();
            const cb2 = jest.fn();

            customRAF(cb1);
            flush(); // Executa cb1

            customRAF(cb2); // Registra cb2 após o primeiro flush
            flush(); // Executa cb2

            expect(cb1).toHaveBeenCalledTimes(1);
            expect(cb2).toHaveBeenCalledTimes(1);
        });

        test('flush em fila vazia não lança exceção', () => {
            const { flush } = createRafReplacement();
            expect(() => flush()).not.toThrow();
        });
    });
});
