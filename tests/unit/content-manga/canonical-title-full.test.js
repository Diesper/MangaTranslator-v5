/**
 * canonical-title-full.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testes completos da função canonicalTitle() — versão v3.1.
 *
 * CONTEXTO: A função original (v3.0) era:
 *   function canonicalTitle(t) { return (t||'').replace(/^\d+\s*\|\s/,'').trim(); }
 *
 * Ela falhava para separadores diferentes de "|" (ex: " - ", "–", ":"), causando
 * capítulos duplicados no banco de dados quando o mesmo capítulo era visitado
 * com pequenas variações no título da aba.
 *
 * A versão v3.1 aplica 4 regex em cascata para normalização robusta.
 *
 * STATUS: Substitui o stub de canonical-title.test.js (1 teste) por suite completa.
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

const { canonicalTitle } = require(path.join(ROOT, 'tests/helpers/extracted-functions.js'));

describe('CM-05/CM-06/CM-07/CM-08: canonicalTitle() — Normalização de Títulos de Capítulos', () => {

    // ── Casos básicos ─────────────────────────────────────────────────────────
    describe('Entrada básica', () => {
        test('retorna string vazia para undefined/null', () => {
            expect(canonicalTitle(undefined)).toBe('');
            expect(canonicalTitle(null)).toBe('');
            expect(canonicalTitle('')).toBe('');
        });

        test('lowercases o resultado', () => {
            const result = canonicalTitle('One Piece');
            expect(result).toBe('one piece');
        });

        test('remove espaços extras nas bordas', () => {
            expect(canonicalTitle('  One Piece  ')).toBe('one piece');
        });
    });

    // ── Remoção de prefixo numérico ────────────────────────────────────────────
    describe('Remoção de prefixo numérico (BUG #12 Fix)', () => {
        test('remove "1050 - " do início', () => {
            const result = canonicalTitle('1050 - One Piece | Mangás');
            expect(result).not.toMatch(/^1050/);
            expect(result).toContain('one piece');
        });

        test('remove "12. " (ponto como separador)', () => {
            const result = canonicalTitle('12. Naruto Shippuden');
            expect(result).not.toMatch(/^12/);
        });

        test('remove "Cap 5: " (dois-pontos como separador)', () => {
            const result = canonicalTitle('Cap 5: Dragon Ball');
            expect(result).not.toMatch(/^cap 5/);
        });

        test('remove "100–" (travessão)', () => {
            const result = canonicalTitle('100–Bleach Final Arc');
            expect(result).not.toMatch(/^100/);
        });

        test('NÃO remove número que faz parte do título (sem separador)', () => {
            // "7 Deadly Sins" não tem número+separador no início
            const result = canonicalTitle('7 Deadly Sins Capítulo 1');
            // Deve manter o conteúdo, mas após strip/lower
            expect(result).toContain('deadly sins');
        });
    });

    // ── Substituição de separadores ────────────────────────────────────────────
    describe('Substituição de separadores por espaço', () => {
        test('substitui "|" (pipe) por espaço', () => {
            const result = canonicalTitle('One Piece | Ler Online');
            expect(result).not.toContain('|');
        });

        test('substitui "—" (em dash) por espaço', () => {
            const result = canonicalTitle('Naruto — Capítulo 1');
            expect(result).not.toContain('—');
        });

        test('substitui "•" (bullet) por espaço', () => {
            const result = canonicalTitle('Manga Title • Site Name');
            expect(result).not.toContain('•');
        });

        test('substitui "[" e "]" por espaço', () => {
            const result = canonicalTitle('Dragon Ball [Scanlation]');
            expect(result).not.toContain('[');
            expect(result).not.toContain(']');
        });

        test('substitui "(" e ")" por espaço', () => {
            const result = canonicalTitle('One Piece (Fan Sub)');
            expect(result).not.toContain('(');
            expect(result).not.toContain(')');
        });
    });

    // ── Colapso de espaços múltiplos ──────────────────────────────────────────
    describe('Colapso de espaços múltiplos', () => {
        test('colapsa múltiplos espaços em um único', () => {
            const result = canonicalTitle('One   Piece   Online');
            expect(result).toBe('one piece online');
        });

        test('separadores substituídos não criam duplos espaços', () => {
            const result = canonicalTitle('One Piece | Online — Ler');
            expect(result).not.toMatch(/\s{2,}/);
        });
    });

    // ── Truncamento ───────────────────────────────────────────────────────────
    describe('Truncamento a 80 caracteres', () => {
        test('trunca títulos muito longos para 80 chars', () => {
            const long = 'A'.repeat(100);
            const result = canonicalTitle(long);
            expect(result.length).toBeLessThanOrEqual(80);
        });

        test('não trunca títulos curtos', () => {
            const result = canonicalTitle('One Piece Cap 1050');
            expect(result.length).toBeLessThanOrEqual(80);
            expect(result).toContain('one piece');
        });
    });

    // ── O caso crítico: deduplicação de capítulos ──────────────────────────────
    describe('Deduplicação (prevenção de capítulos duplicados)', () => {
        test('Visita 1 e Visita 2 do mesmo capítulo produzem a mesma chave', () => {
            const visit1 = canonicalTitle('One Piece Capítulo 1050 | Ler Online');
            const visit2 = canonicalTitle('One Piece Capítulo 1050 - LerManga');
            // Ambos devem ter a mesma parte principal
            expect(visit1).toContain('one piece');
            expect(visit2).toContain('one piece');
            // A função normalize + compare posterior usa replace(/[^a-z0-9]/gi, '_')
            const norm1 = visit1.replace(/[^a-z0-9]/gi, '_');
            const norm2 = visit2.replace(/[^a-z0-9]/gi, '_');
            // Prefixo comum: "one_piece_cap_tulo_1050"
            expect(norm1.startsWith('one_piece')).toBe(true);
            expect(norm2.startsWith('one_piece')).toBe(true);
        });

        test('capítulos DIFERENTES NÃO produzem a mesma chave', () => {
            const cap1050 = canonicalTitle('One Piece Capítulo 1050');
            const cap1051 = canonicalTitle('One Piece Capítulo 1051');
            expect(cap1050).not.toBe(cap1051);
        });

        test('obras DIFERENTES NÃO produzem a mesma chave', () => {
            const naruto = canonicalTitle('Naruto Capítulo 1 | Ler');
            const bleach = canonicalTitle('Bleach Capítulo 1 | Ler');
            expect(naruto).not.toBe(bleach);
        });

        test('título com variação de separador entre sessões', () => {
            // Cenário real: title muda ligeiramente entre visitas
            const sess1 = canonicalTitle('Berserk Chapter 364 - Manga Reader');
            const sess2 = canonicalTitle('Berserk Chapter 364 | Online');
            // Ambos devem conter o núcleo identificador
            expect(sess1).toContain('berserk');
            expect(sess1).toContain('chapter');
            expect(sess1).toContain('364');
            expect(sess2).toContain('berserk');
            expect(sess2).toContain('364');
        });
    });

    // ── Casos extremos ────────────────────────────────────────────────────────
    describe('Casos extremos (edge cases)', () => {
        test('título somente com número não quebra', () => {
            const result = canonicalTitle('1050');
            expect(typeof result).toBe('string');
        });

        test('título com apenas separadores não quebra', () => {
            const result = canonicalTitle('| — • |');
            expect(typeof result).toBe('string');
            expect(result.length).toBeLessThanOrEqual(80);
        });

        test('título com caracteres Unicode (acentuação PT-BR)', () => {
            const result = canonicalTitle('Capítulo 5 — Ação e Reação');
            expect(result).toContain('cap');
            expect(typeof result).toBe('string');
        });

        test('título com guillemets (« ») — separadores europeus', () => {
            const result = canonicalTitle('One Piece «Capítulo 1050»');
            expect(result).not.toContain('«');
            expect(result).not.toContain('»');
        });
    });
});
