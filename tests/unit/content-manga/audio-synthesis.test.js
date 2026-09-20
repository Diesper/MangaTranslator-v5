/**
 * audio-synthesis.test.js — STUB ORIGINAL (v3.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * Versão mínima do teste de síntese de áudio.
 *
 * POR QUE ESTE ARQUIVO EXISTE JUNTO COM audio-synthesis-full.test.js?
 * Este stub cobre o caso de regressão básico: "playErrorSound não deve
 * lançar exceção quando AudioContext não está disponível". Foi o primeiro
 * teste escrito (v3.0). O arquivo full (v3.1) expande para 20+ testes,
 * mas este stub é mantido como registro histórico da cobertura mínima
 * que foi o ponto de partida.
 *
 * VEJA: audio-synthesis-full.test.js para a suíte completa.
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

describe('playErrorSound() — Teste Básico (stub v3.0)', () => {
    test('não lança exceção quando AudioContext falha (factory que lança)', () => {
        const failFactory = () => { throw new Error('AudioContext not allowed'); };
        expect(() => playErrorSound(failFactory)).not.toThrow();
    });

    test('não lança exceção sem factory (usa global)', () => {
        // Em ambiente Node/JSDOM sem AudioContext, deve falhar silenciosamente
        expect(() => playErrorSound()).not.toThrow();
    });
});
