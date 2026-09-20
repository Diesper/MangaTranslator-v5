/**
 * image-filtering.test.js — STUB ORIGINAL (v3.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * Versão mínima do teste de filtragem de imagens por dimensão.
 *
 * POR QUE ESTE ARQUIVO EXISTE JUNTO COM get-page-images-filter.test.js?
 * O v3.0 só testava o critério dimensional (≥ 300×400px). Não havia teste
 * para filtro de imagens banidas porque o v3.0 NÃO filtrava banidas no
 * content script — isso era feito apenas no popup.js (BUG #9 + INCONS #2).
 *
 * A correção no v3.1 moveu o filtro para o handler GET_PAGE_IMAGES, criando
 * uma única fonte de verdade. O arquivo get-page-images-filter.test.js
 * cobre esse comportamento corrigido.
 *
 * ESTE ARQUIVO documenta o comportamento original (apenas tamanho) e
 * serve como teste de regressão para os limiares dimensionais (300×400px).
 *
 * VEJA: get-page-images-filter.test.js para INCONS #2 + BUG #9 Fix.
 */

describe('Filtro de Imagens — Critério Dimensional (stub v3.0)', () => {

    // Lógica de filtro dimensional — apenas tamanho, sem banidas (v3.0)
    function filterBySize(images) {
        return images.filter(img =>
            img.naturalWidth  >= 300 &&
            img.naturalHeight >= 400
        );
    }

    describe('Limiar de largura (≥ 300px)', () => {
        test('inclui imagem com largura exatamente 300px', () => {
            const result = filterBySize([
                { src: 'a.png', naturalWidth: 300, naturalHeight: 400 }
            ]);
            expect(result).toHaveLength(1);
        });

        test('exclui imagem com largura 299px', () => {
            const result = filterBySize([
                { src: 'a.png', naturalWidth: 299, naturalHeight: 400 }
            ]);
            expect(result).toHaveLength(0);
        });
    });

    describe('Limiar de altura (≥ 400px)', () => {
        test('inclui imagem com altura exatamente 400px', () => {
            const result = filterBySize([
                { src: 'a.png', naturalWidth: 300, naturalHeight: 400 }
            ]);
            expect(result).toHaveLength(1);
        });

        test('exclui imagem com altura 399px', () => {
            const result = filterBySize([
                { src: 'a.png', naturalWidth: 300, naturalHeight: 399 }
            ]);
            expect(result).toHaveLength(0);
        });

        test('exclui banner horizontal (largura OK, altura insuficiente)', () => {
            const result = filterBySize([
                { src: 'banner.png', naturalWidth: 960, naturalHeight: 120 }
            ]);
            expect(result).toHaveLength(0);
        });
    });

    describe('Imagens típicas de mangá (800×1200px)', () => {
        test('página de mangá padrão passa no filtro', () => {
            const result = filterBySize([
                { src: 'page1.png', naturalWidth: 800, naturalHeight: 1200 },
                { src: 'page2.png', naturalWidth: 800, naturalHeight: 1200 },
            ]);
            expect(result).toHaveLength(2);
        });

        test('avatar (48×48) não passa no filtro', () => {
            const result = filterBySize([
                { src: 'avatar.png', naturalWidth: 48, naturalHeight: 48 }
            ]);
            expect(result).toHaveLength(0);
        });
    });

    describe('Lista vazia e casos extremos', () => {
        test('lista vazia retorna lista vazia', () => {
            expect(filterBySize([])).toHaveLength(0);
        });

        test('imagem 0×0 não passa', () => {
            const result = filterBySize([
                { src: 'broken.png', naturalWidth: 0, naturalHeight: 0 }
            ]);
            expect(result).toHaveLength(0);
        });
    });
});
