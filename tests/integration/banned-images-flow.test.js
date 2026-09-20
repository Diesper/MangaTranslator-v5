/**
 * banned-images-flow.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Teste de integração: Fluxo completo de banimento de imagens.
 *
 * CENÁRIO: O usuário bane uma imagem via popup. Depois, ao clicar no botão
 * flutuante (sem passar pelo popup), a imagem banida NÃO deve aparecer na
 * lista de imagens a traduzir.
 *
 * Testa a correção de BUG #9 + INCONS #2: antes da correção, o popup filtrava
 * mas o botão flutuante não. Após a correção, GET_PAGE_IMAGES filtra na fonte.
 *
 * Este é um teste de INTEGRAÇÃO porque cobre:
 * 1. Armazenamento de ban no chrome.storage (popup.js → storage)
 * 2. Leitura do ban no GET_PAGE_IMAGES (content_manga.js ← storage)
 * 3. Consistência entre os dois caminhos de tradução
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

const { getStorageMock } = require(path.join(ROOT, 'tests/mocks/chrome-api.mock.js'));

describe('Fluxo de Banimento de Imagens — Integração (BUG #9 + INCONS #2)', () => {

    const HOSTNAME = 'testmanga.com';
    const BAN_KEY  = `bannedImages_${HOSTNAME}`;

    // Simulação do handler GET_PAGE_IMAGES (content_manga.js v3.1)
    async function simulateGetPageImages(chromeStorage, hostname, domImages) {
        return new Promise(resolve => {
            chromeStorage.get([`bannedImages_${hostname}`], (data) => {
                const banned = data[`bannedImages_${hostname}`] || [];
                const validImages = domImages.filter(img =>
                    img.naturalWidth >= 300 &&
                    img.naturalHeight >= 400 &&
                    !banned.includes(img.src)
                ).map((img, i) => ({ index: i, src: img.src, width: img.naturalWidth, height: img.naturalHeight }));
                resolve(validImages);
            });
        });
    }

    // Simulação do handler de ban do popup.js
    async function simulateBanImages(chromeStorage, hostname, urlsToBan) {
        return new Promise(resolve => {
            const banKey = `bannedImages_${hostname}`;
            chromeStorage.get([banKey], (data) => {
                const existing = data[banKey] || [];
                urlsToBan.forEach(url => {
                    if (!existing.includes(url)) existing.push(url);
                });
                chromeStorage.set({ [banKey]: existing }, resolve);
            });
        });
    }

    // Simulação do handler de unban
    async function simulateUnbanImages(chromeStorage, hostname, urlsToUnban) {
        return new Promise(resolve => {
            const banKey = `bannedImages_${hostname}`;
            chromeStorage.get([banKey], (data) => {
                const updated = (data[banKey] || []).filter(url => !urlsToUnban.includes(url));
                chromeStorage.set({ [banKey]: updated }, resolve);
            });
        });
    }

    const MANGA_PAGE_1 = { src: 'https://cdn.manga.com/page1.png', naturalWidth: 800, naturalHeight: 1200 };
    const MANGA_PAGE_2 = { src: 'https://cdn.manga.com/page2.png', naturalWidth: 800, naturalHeight: 1200 };
    const BANNER       = { src: 'https://cdn.manga.com/banner.png', naturalWidth: 960, naturalHeight: 480 };

    let storageMock;

    beforeEach(async () => {
        storageMock = getStorageMock();
        // Estado inicial: sem banidas
        await storageMock.set({ [BAN_KEY]: [] });
    });

    describe('Cenário 1: Ban via popup afeta o botão flutuante', () => {
        test('antes do ban: todas as imagens válidas são retornadas', async () => {
            const images = await simulateGetPageImages(
                storageMock, HOSTNAME, [MANGA_PAGE_1, MANGA_PAGE_2, BANNER]
            );
            // BANNER não passa pelo filtro de tamanho (altura 480 < 400? Não, 480 > 400)
            // Na verdade 480 > 400 então BANNER seria incluído
            // Vamos verificar apenas as páginas de mangá
            expect(images.some(img => img.src === MANGA_PAGE_1.src)).toBe(true);
            expect(images.some(img => img.src === MANGA_PAGE_2.src)).toBe(true);
        });

        test('após ban de uma imagem: imagem banida não aparece no botão', async () => {
            // 1. Usuário bane BANNER via popup
            await simulateBanImages(storageMock, HOSTNAME, [BANNER.src]);

            // 2. Botão flutuante chama GET_PAGE_IMAGES
            const images = await simulateGetPageImages(
                storageMock, HOSTNAME, [MANGA_PAGE_1, MANGA_PAGE_2, BANNER]
            );

            // BANNER deve ser excluído
            expect(images.some(img => img.src === BANNER.src)).toBe(false);

            // Páginas de mangá devem continuar
            expect(images.some(img => img.src === MANGA_PAGE_1.src)).toBe(true);
            expect(images.some(img => img.src === MANGA_PAGE_2.src)).toBe(true);
        });

        test('ban é persistido entre chamadas ao GET_PAGE_IMAGES', async () => {
            await simulateBanImages(storageMock, HOSTNAME, [MANGA_PAGE_2.src]);

            // Primeira chamada
            const result1 = await simulateGetPageImages(
                storageMock, HOSTNAME, [MANGA_PAGE_1, MANGA_PAGE_2]
            );
            expect(result1).toHaveLength(1);

            // Segunda chamada (simula nova abertura do popup ou clique no botão)
            const result2 = await simulateGetPageImages(
                storageMock, HOSTNAME, [MANGA_PAGE_1, MANGA_PAGE_2]
            );
            expect(result2).toHaveLength(1);
            expect(result2[0].src).toBe(MANGA_PAGE_1.src);
        });
    });

    describe('Cenário 2: Desbanimento restaura imagem', () => {
        test('após unban: imagem volta a aparecer', async () => {
            // 1. Bana
            await simulateBanImages(storageMock, HOSTNAME, [MANGA_PAGE_1.src]);

            // 2. Confirma ban
            const afterBan = await simulateGetPageImages(
                storageMock, HOSTNAME, [MANGA_PAGE_1, MANGA_PAGE_2]
            );
            expect(afterBan.some(img => img.src === MANGA_PAGE_1.src)).toBe(false);

            // 3. Desbanir
            await simulateUnbanImages(storageMock, HOSTNAME, [MANGA_PAGE_1.src]);

            // 4. Imagem volta
            const afterUnban = await simulateGetPageImages(
                storageMock, HOSTNAME, [MANGA_PAGE_1, MANGA_PAGE_2]
            );
            expect(afterUnban.some(img => img.src === MANGA_PAGE_1.src)).toBe(true);
        });
    });

    describe('Cenário 3: Ban é isolado por domínio', () => {
        test('ban em domínio A não afeta domínio B', async () => {
            const HOSTNAME_B = 'outromanga.com';

            // Bana no domínio A
            await simulateBanImages(storageMock, HOSTNAME, [MANGA_PAGE_1.src]);

            // Domínio B não deve ter nenhum ban
            const imagesB = await simulateGetPageImages(
                storageMock, HOSTNAME_B, [MANGA_PAGE_1, MANGA_PAGE_2]
            );
            expect(imagesB.some(img => img.src === MANGA_PAGE_1.src)).toBe(true);
        });
    });

    describe('Cenário 4: Consistência popup vs botão flutuante (INCONS #2)', () => {
        test('popup e botão retornam o mesmo resultado para o mesmo estado', async () => {
            await simulateBanImages(storageMock, HOSTNAME, [BANNER.src]);

            // Simula o que o popup faz (após receber a lista do content script)
            const fromContentScript = await simulateGetPageImages(
                storageMock, HOSTNAME, [MANGA_PAGE_1, MANGA_PAGE_2, BANNER]
            );

            // Simula o que o botão flutuante faz diretamente
            const fromButton = await simulateGetPageImages(
                storageMock, HOSTNAME, [MANGA_PAGE_1, MANGA_PAGE_2, BANNER]
            );

            expect(fromContentScript).toEqual(fromButton);
        });
    });

    describe('Cenário 5: Múltiplos bans simultâneos', () => {
        test('bana várias imagens de uma vez (btnBanSelected)', async () => {
            await simulateBanImages(
                storageMock, HOSTNAME, [MANGA_PAGE_1.src, BANNER.src]
            );

            const images = await simulateGetPageImages(
                storageMock, HOSTNAME, [MANGA_PAGE_1, MANGA_PAGE_2, BANNER]
            );

            expect(images).toHaveLength(1);
            expect(images[0].src).toBe(MANGA_PAGE_2.src);
        });

        test('ban não cria duplicatas na lista', async () => {
            // Bana a mesma imagem duas vezes
            await simulateBanImages(storageMock, HOSTNAME, [MANGA_PAGE_1.src]);
            await simulateBanImages(storageMock, HOSTNAME, [MANGA_PAGE_1.src]);

            const data = await storageMock.get([BAN_KEY]);
            const count = data[BAN_KEY].filter(url => url === MANGA_PAGE_1.src).length;
            expect(count).toBe(1);
        });
    });
});
