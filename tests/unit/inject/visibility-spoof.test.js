/**
 * visibility-spoof.test.js — STUB ORIGINAL (v3.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa a falsificação do estado de visibilidade da aba no inject.js.
 * Cobertura mínima original (v3.0).
 *
 * POR QUE ESTE ARQUIVO EXISTE JUNTO COM inject-anti-hibernation.test.js?
 * O v3.0 isolou apenas o sistema de visibilidade. O v3.1 integrou todos
 * os 5 sistemas em inject-anti-hibernation.test.js, incluindo testes de
 * supressão de eventos (blur/pagehide/visibilitychange) com captura.
 *
 * CONTEXTO TÉCNICO — Por que o inject.js precisa falsificar visibilidade:
 *
 * O Chrome implementa "tab throttling" para abas em background:
 * - JavaScript timers (setTimeout/setInterval) são reduzidos a 1 tick/segundo
 * - requestAnimationFrame é pausado completamente
 * - O evento `visibilitychange` dispara com `document.visibilityState = 'hidden'`
 *
 * O content_gemini.js usa polling de 500ms para detectar quando o Gemini
 * termina de gerar a imagem. Se o tab throttling reduzir esse polling para
 * 1 tick/segundo, o tempo de espera pode triplicar e o job pode expirar
 * pelo watchdog de 4 minutos sem ter completado.
 *
 * A solução: injetar no world:MAIN (contexto da página, não isolado) para
 * ter acesso às propriedades nativas do document e window, então usar
 * Object.defineProperty para tornar visibilityState sempre 'visible'.
 *
 * Por que Object.defineProperty e não uma simples atribuição?
 * `document.visibilityState = 'visible'` não funciona — a propriedade
 * é read-only por padrão. Apenas Object.defineProperty com { get: () => 'visible' }
 * consegue sobrescrever getters de objetos nativos do DOM.
 *
 * VEJA: inject-anti-hibernation.test.js para a suíte completa.
 */

describe('Falsificação de Estado de Visibilidade (stub v3.0)', () => {

    describe('document.visibilityState', () => {
        afterEach(() => {
            // Restaura para 'visible' (padrão em JSDOM) após cada teste
            try {
                Object.defineProperty(document, 'visibilityState', {
                    get: () => 'visible',
                    configurable: true,
                });
            } catch(e) {}
        });

        test('Object.defineProperty sobrescreve visibilityState para "visible"', () => {
            Object.defineProperty(document, 'visibilityState', {
                get: () => 'visible',
                configurable: true,
            });
            expect(document.visibilityState).toBe('visible');
        });

        test('getter é chamado a cada acesso (não é cached)', () => {
            let callCount = 0;
            Object.defineProperty(document, 'visibilityState', {
                get: () => { callCount++; return 'visible'; },
                configurable: true,
            });
            void document.visibilityState;
            void document.visibilityState;
            expect(callCount).toBe(2);
        });
    });

    describe('document.hidden', () => {
        afterEach(() => {
            try {
                Object.defineProperty(document, 'hidden', {
                    get: () => false,
                    configurable: true,
                });
            } catch(e) {}
        });

        test('Object.defineProperty força hidden para false', () => {
            Object.defineProperty(document, 'hidden', {
                get: () => false,
                configurable: true,
            });
            expect(document.hidden).toBe(false);
        });

        test('hidden false e visibilityState "visible" são consistentes', () => {
            Object.defineProperty(document, 'visibilityState', {
                get: () => 'visible',
                configurable: true,
            });
            Object.defineProperty(document, 'hidden', {
                get: () => false,
                configurable: true,
            });
            // Invariante: hidden = (visibilityState !== 'visible')
            expect(document.hidden).toBe(document.visibilityState !== 'visible');
        });
    });

    describe('document.hasFocus()', () => {
        test('substituição direta do método funciona', () => {
            const original = document.hasFocus;
            document.hasFocus = () => true;
            expect(document.hasFocus()).toBe(true);
            document.hasFocus = original;
        });
    });

    describe('Supressão de evento visibilitychange', () => {
        test('stopImmediatePropagation impede listener subsequente de receber o evento', () => {
            const suppressHandler = e => e.stopImmediatePropagation();
            const lateHandler = jest.fn();

            // Capture:true garante execução antes dos demais listeners
            window.addEventListener('visibilitychange', suppressHandler, true);
            window.addEventListener('visibilitychange', lateHandler, true);

            document.dispatchEvent(new Event('visibilitychange'));

            expect(lateHandler).not.toHaveBeenCalled();

            window.removeEventListener('visibilitychange', suppressHandler, true);
            window.removeEventListener('visibilitychange', lateHandler, true);
        });

        test('listener de blur é suprimido da mesma forma', () => {
            const suppressHandler = e => e.stopImmediatePropagation();
            const lateHandler = jest.fn();

            window.addEventListener('blur', suppressHandler, true);
            window.addEventListener('blur', lateHandler, true);

            window.dispatchEvent(new Event('blur'));

            expect(lateHandler).not.toHaveBeenCalled();

            window.removeEventListener('blur', suppressHandler, true);
            window.removeEventListener('blur', lateHandler, true);
        });
    });
});
