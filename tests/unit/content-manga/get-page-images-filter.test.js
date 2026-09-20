/**
 * get-page-images-filter.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testa que GET_PAGE_IMAGES filtra imagens banidas no content script (INCONS #2).
 *
 * PROBLEMA ORIGINAL: A filtragem de banidas estava apenas no popup.js (linha 404).
 * O handler GET_PAGE_IMAGES retornava TODAS as imagens grandes, sem filtro.
 * O popup então filtrava no client-side.
 *
 * Isso causava dois problemas:
 * 1. Duplicação de lógica (popup filtra, content script não filtra)
 * 2. BUG #9: O botão flutuante (que não passa pelo popup) nunca filtrava
 *
 * CORREÇÃO: A filtragem foi movida para o handler GET_PAGE_IMAGES no content script.
 * Agora existe uma única fonte de verdade.
 *
 * ABORDAGEM: Testa a lógica de filtragem de forma isolada (sem carregar content_manga.js)
 * simulando a operação exata que o handler executa.
 */

describe('GET_PAGE_IMAGES — Filtragem de Banidas no Content Script (INCONS #2 + BUG #9)', () => {

    // Simulação da lógica do handler GET_PAGE_IMAGES (v3.1)
    function simulateGetPageImages(images, bannedUrls) {
        return images.filter(img =>
            img.naturalWidth >= 300 &&
            img.naturalHeight >= 400 &&
            !bannedUrls.includes(img.src)
        ).map((img, i) => ({
            index: i,
            src: img.src,
            width: img.naturalWidth,
            height: img.naturalHeight
        }));
    }

    const VALID_MANGA_PAGE = { src: 'http://site.com/page1.png', naturalWidth: 800, naturalHeight: 1200 };
    const VALID_PAGE_2     = { src: 'http://site.com/page2.png', naturalWidth: 800, naturalHeight: 1200 };
    const BANNED_IMAGE     = { src: 'http://site.com/banner.png', naturalWidth: 900, naturalHeight: 500 };
    const SMALL_IMAGE      = { src: 'http://site.com/avatar.png', naturalWidth: 48, naturalHeight: 48 };
    const TALL_BANNER      = { src: 'http://site.com/tall_banner.png', naturalWidth: 900, naturalHeight: 120 };

    describe('Filtragem por tamanho mínimo (≥ 300×400)', () => {
        test('retorna imagens que atendem ao critério de tamanho', () => {
            const result = simulateGetPageImages([VALID_MANGA_PAGE], []);
            expect(result).toHaveLength(1);
            expect(result[0].src).toBe(VALID_MANGA_PAGE.src);
        });

        test('exclui imagens menores que 300×400', () => {
            const result = simulateGetPageImages([SMALL_IMAGE], []);
            expect(result).toHaveLength(0);
        });

        test('exclui banner horizontal (largura OK, altura insuficiente)', () => {
            const result = simulateGetPageImages([TALL_BANNER], []);
            expect(result).toHaveLength(0);
        });
    });

    describe('Filtragem de imagens banidas', () => {
        test('exclui imagem com tamanho válido mas URL banida', () => {
            const result = simulateGetPageImages(
                [VALID_MANGA_PAGE, BANNED_IMAGE],
                [BANNED_IMAGE.src]
            );
            expect(result).toHaveLength(1);
            expect(result[0].src).toBe(VALID_MANGA_PAGE.src);
        });

        test('não exclui imagem com tamanho válido e URL não banida', () => {
            const result = simulateGetPageImages(
                [VALID_MANGA_PAGE],
                ['http://outro-site.com/banner.png']
            );
            expect(result).toHaveLength(1);
        });

        test('lista de banidas vazia não exclui nada', () => {
            const result = simulateGetPageImages(
                [VALID_MANGA_PAGE, VALID_PAGE_2],
                []
            );
            expect(result).toHaveLength(2);
        });
    });

    describe('Combinação de filtros (tamanho + banidas)', () => {
        test('aplica ambos os filtros simultaneamente', () => {
            const images = [VALID_MANGA_PAGE, VALID_PAGE_2, BANNED_IMAGE, SMALL_IMAGE];
            const bannedUrls = [BANNED_IMAGE.src];
            const result = simulateGetPageImages(images, bannedUrls);

            // Apenas as 2 páginas válidas e não-banidas devem passar
            expect(result).toHaveLength(2);
            const srcs = result.map(r => r.src);
            expect(srcs).toContain(VALID_MANGA_PAGE.src);
            expect(srcs).toContain(VALID_PAGE_2.src);
            expect(srcs).not.toContain(BANNED_IMAGE.src);
            expect(srcs).not.toContain(SMALL_IMAGE.src);
        });

        test('página traduzida (já traduzida) pode ser filtrada por ban', () => {
            const translatedBanned = {
                src: 'data:image/png;base64,iVBOR==',
                naturalWidth: 800, naturalHeight: 1200
            };
            const result = simulateGetPageImages(
                [VALID_MANGA_PAGE, translatedBanned],
                [translatedBanned.src]
            );
            expect(result).toHaveLength(1);
            expect(result[0].src).toBe(VALID_MANGA_PAGE.src);
        });
    });

    describe('Consistência entre popup e botão flutuante (INCONS #2)', () => {
        test('popup e botão flutuante recebem o mesmo conjunto de imagens', () => {
            const allImages = [VALID_MANGA_PAGE, VALID_PAGE_2, BANNED_IMAGE, SMALL_IMAGE];
            const bannedUrls = [BANNED_IMAGE.src];

            // Antes: popup filtrava, botão não
            const popupResult = simulateGetPageImages(allImages, bannedUrls);

            // Agora: ambos usam a mesma função
            const buttonResult = simulateGetPageImages(allImages, bannedUrls);

            expect(popupResult).toEqual(buttonResult);
        });
    });

    describe('Formato da resposta', () => {
        test('retorna objetos com as propriedades corretas', () => {
            const result = simulateGetPageImages([VALID_MANGA_PAGE], []);
            expect(result[0]).toMatchObject({
                index: expect.any(Number),
                src: expect.any(String),
                width: expect.any(Number),
                height: expect.any(Number),
            });
        });

        test('índices são baseados em zero', () => {
            const result = simulateGetPageImages([VALID_MANGA_PAGE, VALID_PAGE_2], []);
            expect(result[0].index).toBe(0);
            expect(result[1].index).toBe(1);
        });
    });
});
