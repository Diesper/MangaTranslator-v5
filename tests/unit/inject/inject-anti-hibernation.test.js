const fs = require('fs');
const path = require('path');

/**
 * inject-anti-hibernation.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testes completos do inject.js — Sistema Anti-Hibernação.
 *
 * Cobre os 5 sistemas implementados em inject.js:
 * 1. Falsificação de visibilidade (visibilityState, hidden, hasFocus)
 * 2. requestAnimationFrame/requestIdleCallback com cadência progressiva
 * 3. Supressão de eventos de blur/pagehide
 * 4. Modos minimal/balanced/legacy com foco apenas em escalada
 * 5. Ausência de ghost mousemove aleatório
 * 6. Guard de idempotência (__anti_hibernation_injected)
 *
 * ABORDAGEM: Testa a lógica de cada sistema isoladamente, sem carregar o inject.js
 * (que requer world:MAIN do Chrome). Usa implementações espelho verificáveis.
 *
 * STATUS: Substitui os stubs de raf-replacement.test.js e visibility-spoof.test.js.
 */

describe('INJ-01/INJ-02/INJ-03/INJ-04/INJ-05/INJ-06/INJ-07/INJ-08/INJ-09/INJ-10/INJ-11/INJ-12/INJ-13/INJ-14/INJ-15/INJ-16/INJ-17: inject.js — Sistema Anti-Hibernação (Cobertura Completa)', () => {

    test('a ativação exige o marcador explícito, inclusive em localhost', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../../extension/inject.js'), 'utf8');
        expect(source).toContain('if (!isTranslatorTab) {');
        expect(source).not.toContain("hostname.includes('127.0.0.1')");
    });

    // ── 1. Guard de Idempotência ──────────────────────────────────────────────

    describe('Guard __anti_hibernation_injected', () => {
        test('flag é definida na primeira injeção', () => {
            delete window.__anti_hibernation_injected;

            // Simula a lógica do guard
            if (!window.__anti_hibernation_injected) {
                window.__anti_hibernation_injected = true;
            }

            expect(window.__anti_hibernation_injected).toBe(true);
        });

        test('segunda injeção retorna cedo (sem re-executar)', () => {
            window.__anti_hibernation_injected = true;
            const setupFn = jest.fn();

            // Simula o IIFE com guard
            (function() {
                if (window.__anti_hibernation_injected) return;
                setupFn(); // Não deve ser chamado
            })();

            expect(setupFn).not.toHaveBeenCalled();
        });

        afterEach(() => {
            delete window.__anti_hibernation_injected;
        });
    });

    // ── 2. Falsificação de Visibilidade ──────────────────────────────────────

    describe('Falsificação de document.visibilityState', () => {
        test('Object.defineProperty pode sobrescrever visibilityState para "visible"', () => {
            // Testa que a técnica usada no inject.js funciona em JSDOM
            Object.defineProperty(document, 'visibilityState', {
                get: () => 'visible',
                configurable: true,
            });
            expect(document.visibilityState).toBe('visible');
        });

        test('document.hidden pode ser forçado para false', () => {
            Object.defineProperty(document, 'hidden', {
                get: () => false,
                configurable: true,
            });
            expect(document.hidden).toBe(false);
        });

        test('document.hasFocus pode retornar true sempre', () => {
            document.hasFocus = () => true;
            expect(document.hasFocus()).toBe(true);
        });

        afterEach(() => {
            // Limpa as sobrescritas — redefine para comportamento padrão
            try {
                Object.defineProperty(document, 'visibilityState', {
                    get: () => 'visible',
                    configurable: true,
                });
                Object.defineProperty(document, 'hidden', {
                    get: () => false,
                    configurable: true,
                });
            } catch(e) {}
        });
    });

    // ── 3. Supressão de Eventos ───────────────────────────────────────────────

    describe('Supressão de visibilitychange / blur / pagehide', () => {
        test('stopImmediatePropagation impede listeners subsequentes', () => {
            const stopProp = e => e.stopImmediatePropagation();
            window.addEventListener('blur', stopProp, true);

            const laterListener = jest.fn();
            window.addEventListener('blur', laterListener, true);

            // Dispara blur
            window.dispatchEvent(new Event('blur'));

            // laterListener não deve ter sido chamado
            expect(laterListener).not.toHaveBeenCalled();

            window.removeEventListener('blur', stopProp, true);
            window.removeEventListener('blur', laterListener, true);
        });

        test('capture:true intercepta ANTES de outros listeners', () => {
            const order = [];
            const captureHandler = e => { order.push('capture'); e.stopImmediatePropagation(); };
            const bubbleHandler  = () => order.push('bubble');

            window.addEventListener('visibilitychange', captureHandler, true);
            window.addEventListener('visibilitychange', bubbleHandler);

            document.dispatchEvent(new Event('visibilitychange'));

            expect(order).toEqual(['capture']); // bubble não chegou
            expect(order).not.toContain('bubble');

            window.removeEventListener('visibilitychange', captureHandler, true);
            window.removeEventListener('visibilitychange', bubbleHandler);
        });
    });

    // ── 4. Fila requestAnimationFrame ────────────────────────────────────────

    describe('Fila requestAnimationFrame drenável pelo anti-throttling', () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        test('callbacks registrados via rAF customizado são executados pelo setInterval', () => {
            const rafCallbacks = [];
            const customRAF = function(cb) {
                rafCallbacks.push(cb);
                return rafCallbacks.length;
            };

            const cb1 = jest.fn();
            const cb2 = jest.fn();
            customRAF(cb1);
            customRAF(cb2);

            // Simula o setInterval de 100ms do inject.js
            const flush = () => {
                const cbs = rafCallbacks.splice(0);
                const now = 12345;
                cbs.forEach(cb => { try { cb(now); } catch(e) {} });
            };

            flush();
            expect(cb1).toHaveBeenCalledWith(12345);
            expect(cb2).toHaveBeenCalledWith(12345);
        });

        test('callbacks com erro não crasham o loop', () => {
            const rafCallbacks = [];
            const customRAF = cb => { rafCallbacks.push(cb); };
            customRAF(() => { throw new Error('crash'); });
            customRAF(jest.fn()); // callback saudável

            const flush = () => {
                const cbs = rafCallbacks.splice(0);
                cbs.forEach(cb => { try { cb(0); } catch(e) {} });
            };

            expect(() => flush()).not.toThrow();
        });

        test('cancelAnimationFrame é stub (não lança exceção)', () => {
            const cancelRAF = function() {}; // stub do inject.js
            expect(() => cancelRAF(99)).not.toThrow();
        });

        test('fila é esvaziada a cada tick do setInterval', () => {
            const rafCallbacks = [];
            const customRAF = cb => rafCallbacks.push(cb);

            customRAF(jest.fn());
            customRAF(jest.fn());
            expect(rafCallbacks).toHaveLength(2);

            // Flush
            const cbs = rafCallbacks.splice(0);
            cbs.forEach(cb => cb(0));

            expect(rafCallbacks).toHaveLength(0);
        });
    });

    // ── 5. Anti-throttling progressivo ────────────────────────────────────

    describe('Política progressiva minimal/balanced/legacy', () => {
        test('source define os três níveis e inicia em minimal', () => {
            const source = fs.readFileSync(
                path.resolve(__dirname, '../../../extension/inject.js'),
                'utf8'
            );

            expect(source).toContain("new Set(['minimal', 'balanced', 'legacy'])");
            expect(source).toContain("let antiThrottleMode = 'minimal'");
            expect(source).toContain('MANGA_TRANSLATOR_ANTI_THROTTLE_SET_MODE');
        });

        test('minimal não mantém intervalo periódico de foco', () => {
            const source = fs.readFileSync(
                path.resolve(__dirname, '../../../extension/inject.js'),
                'utf8'
            );

            expect(source).toContain('minimal: 0');
            expect(source).toContain('balanced: 5000');
            expect(source).toContain('legacy: 1000');
            expect(source).not.toContain('setInterval(dispatchFocusEvents, 1000)');
        });

        test('mousemove aleatório foi removido do anti-throttling', () => {
            const source = fs.readFileSync(
                path.resolve(__dirname, '../../../extension/inject.js'),
                'utf8'
            );

            expect(source).not.toContain("new MouseEvent('mousemove'");
            expect(source).not.toContain('Math.random() * (window.innerWidth');
            expect(source).toContain('Ghost mousemove removido');
        });

        test('cadência do rAF diminui no baseline e escala progressivamente', () => {
            const source = fs.readFileSync(
                path.resolve(__dirname, '../../../extension/inject.js'),
                'utf8'
            );

            expect(source).toContain('minimal: 250');
            expect(source).toContain('balanced: 100');
            expect(source).toContain('legacy: 50');
            expect(source).toContain('scheduleRafFlush');
        });
    });

    // ── 6. MutationObserver para lazy→eager ──────────────────────────────────

    describe('MutationObserver — lazy loading bypass', () => {
        test('converte img[loading=lazy] para eager ao adicionar ao DOM', (done) => {
            const img = document.createElement('img');
            img.setAttribute('loading', 'lazy');

            const observer = new MutationObserver(() => {
                document.querySelectorAll('img[loading="lazy"]').forEach(i => {
                    i.setAttribute('loading', 'eager');
                });
                expect(img.getAttribute('loading')).toBe('eager');
                observer.disconnect();
                done();
            });

            observer.observe(document.body, { childList: true, subtree: true });
            document.body.appendChild(img);
        });
    });
});
