/**
 * audio-synthesis-full.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testes completos de síntese de áudio procedural (Zero Dependency Asset).
 *
 * Testa AMBOS os sons implementados no content_manga.js v3.1:
 * 1. playErrorSound()  — dois pulsos sawtooth descendentes (300Hz → 150Hz)
 * 2. playSuccessSound() — arpejo ascendente sine (660Hz → 880Hz → 1100Hz)
 *
 * STATUS: Expande o audio-synthesis.test.js original (que só testava o som de erro)
 * e adiciona testes do som de sucesso (checkIfComplete) e testes de resiliência.
 *
 * MOTIVO: Documentação Seção 8 descreve os dois sons em detalhe. O teste original
 * não cobria o som de sucesso nem os edge cases de polyfill (webkitAudioContext).
 */

const path = require('path');
const fs   = require('fs');
// Portable root finder — works regardless of where this file is placed in the tree.
// Walks up from __dirname until it finds the folder containing extension/manifest.json.
function _findRoot(d) {
    if (fs.existsSync(path.join(d, 'extension', 'manifest.json'))) return d;
    const p = path.dirname(d);
    return p === d ? process.cwd() : _findRoot(p);
}
const ROOT = _findRoot(__dirname);

const { playErrorSound } = require(path.join(ROOT, 'tests/helpers/extracted-functions.js'));

// ── Som de sucesso — espelho de checkIfComplete (content_manga.js) ────────────
function playSuccessSound(audioCtxFactory) {
    try {
        const audioCtx = audioCtxFactory
            ? audioCtxFactory()
            : new (window.AudioContext || window.webkitAudioContext)();

        [[660, 0], [880, 0.18], [1100, 0.36]].forEach(([freq, delay]) => {
            const osc  = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, audioCtx.currentTime + delay);
            gain.gain.setValueAtTime(0, audioCtx.currentTime + delay);
            gain.gain.linearRampToValueAtTime(0.4,   audioCtx.currentTime + delay + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + 0.28);
            osc.start(audioCtx.currentTime + delay);
            osc.stop(audioCtx.currentTime  + delay + 0.3);
        });
    } catch (e) { /* silencioso por design */ }
}

describe('Síntese de Áudio Procedural — Cobertura Completa', () => {

    let mockOsc, mockGain, mockCtx;

    function makeAudioMocks() {
        mockOsc = {
            connect: jest.fn(),
            start: jest.fn(),
            stop: jest.fn(),
            frequency: { setValueAtTime: jest.fn() },
            type: '',
        };
        mockGain = {
            connect: jest.fn(),
            gain: {
                setValueAtTime: jest.fn(),
                linearRampToValueAtTime: jest.fn(),
                exponentialRampToValueAtTime: jest.fn(),
            },
        };
        mockCtx = {
            createOscillator: jest.fn().mockReturnValue(mockOsc),
            createGain: jest.fn().mockReturnValue(mockGain),
            destination: {},
            currentTime: 0,
        };
        return () => mockCtx;
    }

    // ── playErrorSound ────────────────────────────────────────────────────────

    describe('playErrorSound() — Dois pulsos sawtooth descendentes', () => {
        test('cria exatamente 2 osciladores e 2 gains', () => {
            const factory = makeAudioMocks();
            playErrorSound(factory);
            expect(mockCtx.createOscillator).toHaveBeenCalledTimes(2);
            expect(mockCtx.createGain).toHaveBeenCalledTimes(2);
        });

        test('usa onda sawtooth (timbre áspero de alerta)', () => {
            const factory = makeAudioMocks();
            playErrorSound(factory);
            // O último valor de type atribuído deve ser sawtooth
            expect(mockOsc.type).toBe('sawtooth');
        });

        test('frequências descendentes: 300Hz (pulso 1) e 150Hz (pulso 2)', () => {
            const factory = makeAudioMocks();
            playErrorSound(factory);
            const freqCalls = mockOsc.frequency.setValueAtTime.mock.calls;
            const freqs = freqCalls.map(c => c[0]);
            expect(freqs).toContain(300);
            expect(freqs).toContain(150);
        });

        test('300Hz vem antes de 150Hz (padrão descendente)', () => {
            const factory = makeAudioMocks();
            playErrorSound(factory);
            const calls = mockOsc.frequency.setValueAtTime.mock.calls;
            const freq300idx = calls.findIndex(c => c[0] === 300);
            const freq150idx = calls.findIndex(c => c[0] === 150);
            expect(freq300idx).toBeLessThan(freq150idx);
        });

        test('fade-in linear de 40ms (evita click mecânico)', () => {
            const factory = makeAudioMocks();
            playErrorSound(factory);
            expect(mockGain.gain.linearRampToValueAtTime)
                .toHaveBeenCalledWith(0.4, 0.04);
        });

        test('fade-out exponencial de 240ms (decaimento natural)', () => {
            const factory = makeAudioMocks();
            playErrorSound(factory);
            expect(mockGain.gain.exponentialRampToValueAtTime)
                .toHaveBeenCalledWith(0.001, 0.28);
        });

        test('oscilador começa em t=0 e t=0.2 (dois pulsos com 200ms de intervalo)', () => {
            const factory = makeAudioMocks();
            playErrorSound(factory);
            const startCalls = mockOsc.start.mock.calls.map(c => c[0]);
            expect(startCalls).toContain(0);
            expect(startCalls).toContain(0.2);
        });

        test('oscilador para em t=0.3 e t=0.5', () => {
            const factory = makeAudioMocks();
            playErrorSound(factory);
            const stopCalls = mockOsc.stop.mock.calls.map(c => c[0]);
            expect(stopCalls).toContain(0.3);
            expect(stopCalls).toContain(0.5);
        });

        test('silencioso se AudioContext lançar exceção', () => {
            const failFactory = () => { throw new Error('Not allowed'); };
            expect(() => playErrorSound(failFactory)).not.toThrow();
        });
    });

    // ── playSuccessSound ──────────────────────────────────────────────────────

    describe('playSuccessSound() — Arpejo sine ascendente', () => {
        test('cria exatamente 3 osciladores e 3 gains', () => {
            const factory = makeAudioMocks();
            playSuccessSound(factory);
            expect(mockCtx.createOscillator).toHaveBeenCalledTimes(3);
            expect(mockCtx.createGain).toHaveBeenCalledTimes(3);
        });

        test('usa onda sine (timbre suave de notificação)', () => {
            const factory = makeAudioMocks();
            playSuccessSound(factory);
            expect(mockOsc.type).toBe('sine');
        });

        test('frequências ascendentes: 660Hz → 880Hz → 1100Hz (proporção 3:4:5)', () => {
            const factory = makeAudioMocks();
            playSuccessSound(factory);
            const freqCalls = mockOsc.frequency.setValueAtTime.mock.calls;
            const freqs = freqCalls.map(c => c[0]);
            expect(freqs).toContain(660);
            expect(freqs).toContain(880);
            expect(freqs).toContain(1100);
        });

        test('delays de 0ms, 180ms e 360ms (arpejo com sobreposição)', () => {
            const factory = makeAudioMocks();
            playSuccessSound(factory);
            const startCalls = mockOsc.start.mock.calls.map(c => c[0]);
            expect(startCalls).toContain(0);
            expect(startCalls).toContain(0.18);
            expect(startCalls).toContain(0.36);
        });

        test('silencioso se AudioContext lançar exceção', () => {
            const failFactory = () => { throw new Error('Policy violation'); };
            expect(() => playSuccessSound(failFactory)).not.toThrow();
        });
    });

    // ── Polyfill webkitAudioContext ───────────────────────────────────────────

    describe('Compatibilidade com polyfill webkitAudioContext', () => {
        beforeEach(() => {
            delete window.AudioContext;
            window.webkitAudioContext = jest.fn().mockImplementation(() => mockCtx);
            makeAudioMocks();
        });

        afterEach(() => {
            delete window.webkitAudioContext;
        });

        test('playErrorSound usa webkitAudioContext quando AudioContext não existe', () => {
            // Não passa factory — usa o global
            expect(() => playErrorSound()).not.toThrow();
            expect(window.webkitAudioContext).toHaveBeenCalled();
        });
    });

    // ── Conexão do grafo de áudio ─────────────────────────────────────────────

    describe('Grafo de áudio: osc → gain → destination', () => {
        test('oscilador se conecta ao gain', () => {
            const factory = makeAudioMocks();
            playErrorSound(factory);
            expect(mockOsc.connect).toHaveBeenCalledWith(mockGain);
        });

        test('gain se conecta ao destination', () => {
            const factory = makeAudioMocks();
            playErrorSound(factory);
            expect(mockGain.connect).toHaveBeenCalledWith(mockCtx.destination);
        });
    });
});
