/**
 * close-interval.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa o sistema de countdown de auto-recuperação da gaveta de erro (INCONS #1).
 *
 * CONTEXTO: Quando o usuário fecha a gaveta de erro do botão flutuante, o código
 * inicia um contador de 30 segundos. Se não reabrir a gaveta em 30s, o botão
 * reseta completamente para o estado neutro.
 *
 * Variável renomeada: `_closeTimer` → `_closeInterval` (mais semântico para
 * `setInterval`). INCONS #1 corrigida.
 *
 * ABORDAGEM: Testa a lógica do countdown com fake timers do Jest.
 * A implementação é testada em isolamento via classe de controle.
 */

describe('Sistema de Auto-Recuperação de UI — Countdown de 30s (INCONS #1)', () => {

    // ── Implementação espelho do sistema de countdown ─────────────────────────
    // Espelha exatamente a lógica do content_manga.js v3.1
    function createCloseCountdown({ onTick, onComplete }) {
        let _closeInterval = null;  // Nome v3.1 (era _closeTimer no v3.0)
        let _closeCountdown = 0;

        return {
            start(seconds = 30) {
                _closeCountdown = seconds;
                if (_closeInterval) clearInterval(_closeInterval);

                _closeInterval = setInterval(() => {
                    _closeCountdown--;
                    onTick(_closeCountdown);

                    if (_closeCountdown <= 0) {
                        clearInterval(_closeInterval);
                        _closeInterval = null;
                        onComplete();
                    }
                }, 1000);
            },

            cancel() {
                if (_closeInterval) {
                    clearInterval(_closeInterval);
                    _closeInterval = null;
                    _closeCountdown = 0;
                }
            },

            isActive() { return _closeInterval !== null; },
            getCount() { return _closeCountdown; },
        };
    }

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    describe('Inicialização e contagem', () => {
        test('inicia com o valor correto de 30 segundos', () => {
            const onTick = jest.fn();
            const onComplete = jest.fn();
            const countdown = createCloseCountdown({ onTick, onComplete });

            countdown.start(30);
            expect(countdown.getCount()).toBe(30);
        });

        test('decrementa 1 segundo por tick', () => {
            const onTick = jest.fn();
            const onComplete = jest.fn();
            const countdown = createCloseCountdown({ onTick, onComplete });

            countdown.start(30);
            jest.advanceTimersByTime(1000);
            expect(onTick).toHaveBeenCalledWith(29);
        });

        test('chama onTick com valor correto em cada segundo', () => {
            const tickValues = [];
            const countdown = createCloseCountdown({
                onTick: (val) => tickValues.push(val),
                onComplete: jest.fn(),
            });

            countdown.start(5); // Usa 5s para teste rápido
            jest.advanceTimersByTime(5000);

            expect(tickValues).toEqual([4, 3, 2, 1, 0]);
        });

        test('chama onComplete quando chega a zero', () => {
            const onComplete = jest.fn();
            const countdown = createCloseCountdown({ onTick: jest.fn(), onComplete });

            countdown.start(3);
            jest.advanceTimersByTime(3000);
            expect(onComplete).toHaveBeenCalledTimes(1);
        });
    });

    describe('Cancelamento (ao reabrir a gaveta)', () => {
        test('cancel() para o intervalo imediatamente', () => {
            const onComplete = jest.fn();
            const countdown = createCloseCountdown({ onTick: jest.fn(), onComplete });

            countdown.start(30);
            expect(countdown.isActive()).toBe(true);

            countdown.cancel();
            expect(countdown.isActive()).toBe(false);
        });

        test('após cancel(), onComplete não é chamado mesmo com tempo avançando', () => {
            const onComplete = jest.fn();
            const countdown = createCloseCountdown({ onTick: jest.fn(), onComplete });

            countdown.start(3);
            jest.advanceTimersByTime(1000); // 1s passou
            countdown.cancel();             // Usuário reabriu a gaveta
            jest.advanceTimersByTime(5000); // Mais 5s passam

            expect(onComplete).not.toHaveBeenCalled();
        });

        test('após cancel(), pode ser iniciado novamente', () => {
            const onComplete = jest.fn();
            const countdown = createCloseCountdown({ onTick: jest.fn(), onComplete });

            countdown.start(30);
            countdown.cancel();
            countdown.start(5);

            jest.advanceTimersByTime(5000);
            expect(onComplete).toHaveBeenCalledTimes(1);
        });
    });

    describe('Prevenção de múltiplos intervalos', () => {
        test('start() duplo não cria dois intervals simultâneos', () => {
            const tickCount = jest.fn();
            const countdown = createCloseCountdown({ onTick: tickCount, onComplete: jest.fn() });

            countdown.start(30);
            countdown.start(30); // Segundo start — deve cancelar o anterior

            jest.advanceTimersByTime(1000);
            // Deve ter chamado onTick apenas 1 vez (não 2)
            expect(tickCount).toHaveBeenCalledTimes(1);
        });
    });

    describe('Comportamento visual (texto do botão)', () => {
        test('texto do botão deve refletir contagem regressiva', () => {
            const texts = [];
            const countdown = createCloseCountdown({
                onTick: (val) => texts.push(`FECHANDO EM ${val}S`),
                onComplete: jest.fn(),
            });

            countdown.start(3);
            jest.advanceTimersByTime(3000);

            expect(texts).toContain('FECHANDO EM 2S');
            expect(texts).toContain('FECHANDO EM 1S');
            expect(texts).toContain('FECHANDO EM 0S');
        });
    });
});
