const crypto = require('crypto');
const { TextEncoder } = require('util');

const {
    buildFingerprintSource,
    calculateDHash,
    calculatePHash,
    calculateRegionalHashes,
    calculateWHash,
    hashStringSha256,
    hammingDistance,
    matchPerceptualHashes,
    matchPerceptualHashesRelaxed,
    matchRegionalHashes,
    createFingerprintFromDescriptor,
    WHASH_MATCH_THRESHOLD_RELAXED,
    PHASH_MATCH_THRESHOLD_RELAXED,
    WHASH_REJECT_THRESHOLD_RELAXED,
    PHASH_REJECT_THRESHOLD_RELAXED,
} = require('../../../extension/gtc-fingerprint.js');

function sha256Utf8(input) {
    return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function makeRgba(width, height, grayAt) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row += 1) {
        for (let col = 0; col < width; col += 1) {
            const offset = (row * width + col) * 4;
            const gray = grayAt(row, col);
            data[offset] = gray;
            data[offset + 1] = gray;
            data[offset + 2] = gray;
            data[offset + 3] = 255;
        }
    }
    return data;
}

describe('gtc-fingerprint.js', () => {
    describe('buildFingerprintSource()', () => {
        test('FP-01 usa visualHash preenchido no formato visual-v2', () => {
            const source = buildFingerprintSource({
                width: 800,
                height: 1200,
                visualHash: 'abc123',
                pixelSample: 'ff00ff',
                cleanUrl: 'https://site.com/panel.jpg',
                hasVisualPixels: true,
            });

            expect(source).toBe('v2:800:1200:abc123');
        });

        test('FP-02 usa o caminho de pixels quando ha dados visuais validos', () => {
            const source = buildFingerprintSource({
                width: 400,
                height: 600,
                hasVisualPixels: true,
                pixelSample: 'ff00ff',
                cleanUrl: 'https://site.com/panel.jpg',
            });

            expect(source).toBe('400:600:pixels:ff00ff');
        });

        test('FP-03 cai no fallback por URL quando nao ha pixels', () => {
            const source = buildFingerprintSource({
                width: 300,
                height: 400,
                cleanUrl: 'https://site.com/img.jpg',
            });

            expect(source).toBe('300:400:url:https://site.com/img.jpg:nopixels');
        });

        test('FP-04 suporta descritor vazio sem lancar excecao', () => {
            expect(buildFingerprintSource({})).toBe('0:0:url::nopixels');
            expect(buildFingerprintSource()).toBe('0:0:url::nopixels');
        });

        test("FP-05 trata 'nopixels' como sentinela e nao como amostra valida", () => {
            const source = buildFingerprintSource({
                width: 900,
                height: 1400,
                hasVisualPixels: true,
                pixelSample: 'nopixels',
                cleanUrl: 'https://site.com/page.png',
            });

            expect(source).toBe('900:1400:url:https://site.com/page.png:nopixels');
        });

        test('FP-06 visualHash vazio nao usa o caminho visual-v2', () => {
            const source = buildFingerprintSource({
                width: 640,
                height: 960,
                visualHash: '',
                hasVisualPixels: true,
                pixelSample: 'abcd',
                cleanUrl: 'https://site.com/page.png',
            });

            expect(source).toBe('640:960:pixels:abcd');
        });
    });

    describe('hashStringSha256()', () => {
        const deps = {
            cryptoImpl: crypto.webcrypto,
            TextEncoderImpl: TextEncoder,
        };

        test('FP-13 calcula o SHA-256 conhecido de uma string simples', async () => {
            await expect(hashStringSha256('test', deps)).resolves.toBe(sha256Utf8('test'));
        });

        test('FP-14 calcula corretamente o hash da string vazia', async () => {
            await expect(hashStringSha256('', deps)).resolves.toBe(sha256Utf8(''));
        });

        test('FP-15 falha com mensagem clara quando crypto nao esta disponivel', async () => {
            await expect(
                hashStringSha256('test', { cryptoImpl: null, TextEncoderImpl: TextEncoder })
            ).rejects.toThrow('SHA-256 dependencies are unavailable');
        });

        test('FP-16 falha com mensagem clara quando TextEncoder nao esta disponivel', async () => {
            await expect(
                hashStringSha256('test', { cryptoImpl: crypto.webcrypto, TextEncoderImpl: null })
            ).rejects.toThrow('SHA-256 dependencies are unavailable');
        });

        test('FP-17 aceita input null e aplica String(null) sem crash', async () => {
            await expect(hashStringSha256(null, deps)).resolves.toBe(sha256Utf8('null'));
        });

        test('FP-18 preserva UTF-8 para caracteres Unicode', async () => {
            const input = 'áé漢字';
            await expect(hashStringSha256(input, deps)).resolves.toBe(sha256Utf8(input));
        });
    });

    describe('calculateDHash()', () => {
        test('FP-07 imagem uniforme gera dHash zerado', () => {
            const imageData = makeRgba(9, 8, () => 255);

            expect(calculateDHash(imageData)).toBe('0000000000000000');
        });

        test('FP-08 gradiente horizontal descendente gera todos os bits ligados', () => {
            const imageData = makeRgba(9, 8, (_row, col) => 255 - col);

            expect(calculateDHash(imageData)).toBe('ffffffffffffffff');
        });

        test('FP-09 entrada menor que 9x8 RGBA falha com mensagem clara', () => {
            expect(() => calculateDHash(new Uint8ClampedArray(10))).toThrow('calculateDHash');
        });

        test('FP-10/FP-11 retorna 16 hex lowercase e e deterministico para pixels iguais', () => {
            const imageData = makeRgba(9, 8, (row, col) => ((row * 17) + (col * 11)) % 256);

            const first = calculateDHash(imageData);
            const second = calculateDHash(imageData.slice());

            expect(first).toMatch(/^[0-9a-f]{16}$/);
            expect(second).toBe(first);
        });

        test('FP-12 calculateDHash independe de OffscreenCanvas e document', () => {
            const originalOffscreenCanvas = global.OffscreenCanvas;
            const originalDocument = global.document;
            const imageData = makeRgba(9, 8, (row, col) => ((row + col) % 2 === 0 ? 40 : 220));

            try {
                global.OffscreenCanvas = function MockOffscreenCanvas() {};
                global.document = { createElement: jest.fn() };
                const withCanvasGlobals = calculateDHash(imageData);

                delete global.OffscreenCanvas;
                delete global.document;
                const withoutCanvasGlobals = calculateDHash(imageData);

                expect(withCanvasGlobals).toBe(withoutCanvasGlobals);
                expect(withoutCanvasGlobals).toMatch(/^[0-9a-f]{16}$/);
            } finally {
                if (originalOffscreenCanvas === undefined) delete global.OffscreenCanvas;
                else global.OffscreenCanvas = originalOffscreenCanvas;

                if (originalDocument === undefined) delete global.document;
                else global.document = originalDocument;
            }
        });
    });

    describe('hashes perceptuais visual-v3', () => {
        test('wHash e pHash retornam 64 hex e sao deterministicos para a mesma matriz 32x32', () => {
            const imageData = makeRgba(32, 32, (row, col) => ((row * 13) + (col * 7)) % 256);

            const wHash = calculateWHash(imageData);
            const pHash = calculatePHash(imageData);

            expect(wHash).toMatch(/^[0-9a-f]{64}$/);
            expect(pHash).toMatch(/^[0-9a-f]{64}$/);
            expect(calculateWHash(imageData.slice())).toBe(wHash);
            expect(calculatePHash(imageData.slice())).toBe(pHash);
        });

        test('wHash, pHash e hashes regionais rejeitam buffers pequenos', () => {
            expect(() => calculateWHash(new Uint8ClampedArray(32))).toThrow('calculateWHash');
            expect(() => calculatePHash(new Uint8ClampedArray(32))).toThrow('calculatePHash');
            expect(() => calculateRegionalHashes(new Uint8ClampedArray(32))).toThrow('calculateRegionalHashes');
        });

        test('hashes regionais retornam quatro cantos e match regional exige minimo configuravel', () => {
            const imageData = makeRgba(48, 48, (row, col) => ((row * 5) + (col * 9)) % 256);
            const regional = calculateRegionalHashes(imageData);

            expect(regional).toEqual({
                topLeft: expect.stringMatching(/^[0-9a-f]{16}$/),
                topRight: expect.stringMatching(/^[0-9a-f]{16}$/),
                bottomLeft: expect.stringMatching(/^[0-9a-f]{16}$/),
                bottomRight: expect.stringMatching(/^[0-9a-f]{16}$/),
            });

            expect(matchRegionalHashes(regional, { ...regional })).toEqual(expect.objectContaining({
                match: true,
                matchCount: 4,
            }));

            expect(matchRegionalHashes(regional, {
                topLeft: 'ffffffffffffffff',
                topRight: 'ffffffffffffffff',
                bottomLeft: regional.bottomLeft,
                bottomRight: regional.bottomRight,
            }, { threshold: 0, minMatches: 3 })).toEqual(expect.objectContaining({
                match: false,
                matchCount: 2,
            }));
        });
    });

    describe('hammingDistance() e matchPerceptualHashes()', () => {
        test('distancia de Hamming aceita hashes hex de tamanhos variados e rejeita entradas invalidas', () => {
            expect(hammingDistance('0', 'f')).toBe(4);
            expect(hammingDistance('00ff', '0fff')).toBe(4);
            expect(hammingDistance('abc', 'ab')).toBe(-1);
            expect(hammingDistance(null, 'ab')).toBe(-1);
        });

        test('matchPerceptualHashes aplica thresholds combinados e caminhos de fallback', () => {
            const zero = '0'.repeat(64);
            const nearW = '0'.repeat(54) + '3'.repeat(10); // 20 bits distantes
            const nearP = '0'.repeat(56) + '1'.repeat(8);  // 8 bits distantes
            const far = 'f'.repeat(64);

            expect(matchPerceptualHashes(zero, zero, nearW, far)).toEqual(expect.objectContaining({
                match: true,
                reason: 'whash_match',
                wDist: 20,
                pDist: 256,
            }));

            expect(matchPerceptualHashes(far, nearP, zero, zero)).toEqual(expect.objectContaining({
                match: true,
                reason: 'phash_match',
                wDist: 256,
                pDist: 8,
            }));

            expect(matchPerceptualHashes(far, far, zero, zero)).toEqual(expect.objectContaining({
                match: false,
                reason: 'both_reject',
            }));

            expect(matchPerceptualHashes(zero, null, nearW, null)).toEqual(expect.objectContaining({
                match: true,
                reason: 'whash_only_match',
                pDist: -1,
            }));

            expect(matchPerceptualHashes(null, null, null, null)).toEqual(expect.objectContaining({
                match: false,
                reason: 'no_hashes',
                wDist: -1,
                pDist: -1,
            }));
        });

        test('visual-v4: matchPerceptualHashesRelaxed aceita misses strict e limita confidence em 0.75', () => {
            const zero = '0'.repeat(64);
            const relaxedOnlyW = 'f'.repeat(11) + '0'.repeat(53); // 44 bits: strict miss, relaxed hit
            const relaxedOnlyP = 'f'.repeat(10) + '0'.repeat(54); // 40 bits: strict miss, relaxed hit
            const far = 'f'.repeat(64);

            expect(WHASH_MATCH_THRESHOLD_RELAXED).toBe(50);
            expect(PHASH_MATCH_THRESHOLD_RELAXED).toBe(45);
            expect(WHASH_REJECT_THRESHOLD_RELAXED).toBe(90);
            expect(PHASH_REJECT_THRESHOLD_RELAXED).toBe(82);

            expect(matchPerceptualHashes(zero, null, relaxedOnlyW, null)).toEqual(expect.objectContaining({
                match: false,
                reason: 'whash_only_miss',
                wDist: 44,
            }));

            const relaxedW = matchPerceptualHashesRelaxed(zero, null, relaxedOnlyW, null);
            expect(relaxedW).toEqual(expect.objectContaining({
                match: true,
                reason: 'relaxed_whash_only_match',
                wDist: 44,
                pDist: -1,
            }));
            expect(relaxedW.confidence).toBeCloseTo(1 - (44 / 90), 6);
            expect(relaxedW.confidence).toBeLessThanOrEqual(0.75);

            expect(matchPerceptualHashes(null, zero, null, relaxedOnlyP)).toEqual(expect.objectContaining({
                match: false,
                reason: 'phash_only_miss',
                pDist: 40,
            }));

            const relaxedP = matchPerceptualHashesRelaxed(null, zero, null, relaxedOnlyP);
            expect(relaxedP).toEqual(expect.objectContaining({
                match: true,
                reason: 'relaxed_phash_only_match',
                wDist: -1,
                pDist: 40,
            }));
            expect(relaxedP.confidence).toBeCloseTo(1 - (40 / 82), 6);
            expect(relaxedP.confidence).toBeLessThanOrEqual(0.75);

            expect(matchPerceptualHashesRelaxed(zero, zero, zero, zero)).toEqual(expect.objectContaining({
                match: true,
                confidence: 0.75,
                reason: 'relaxed_both_match',
                wDist: 0,
                pDist: 0,
            }));

            expect(matchPerceptualHashesRelaxed(far, far, zero, zero)).toEqual(expect.objectContaining({
                match: false,
                reason: 'relaxed_both_reject',
            }));
        });
    });

    describe('createFingerprintFromDescriptor()', () => {
        const deps = {
            cryptoImpl: crypto.webcrypto,
            TextEncoderImpl: TextEncoder,
        };

        test('FP-19 gera um fingerprint hex de 64 caracteres para descritor valido', async () => {
            const fingerprint = await createFingerprintFromDescriptor({
                width: 800,
                height: 1200,
                cleanUrl: 'https://reader.test/panel-001.png',
                pixelSample: 'abcd1234',
                hasVisualPixels: true,
            }, deps);

            expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
        });

        test('FP-20 e deterministico para o mesmo descritor', async () => {
            const descriptor = {
                width: 800,
                height: 1200,
                cleanUrl: 'https://reader.test/panel-001.png',
                pixelSample: 'feedbeef',
                hasVisualPixels: true,
            };

            const [first, second] = await Promise.all([
                createFingerprintFromDescriptor(descriptor, deps),
                createFingerprintFromDescriptor(descriptor, deps),
            ]);

            expect(first).toBe(second);
        });

        test('FP-21 muda o hash final quando o descritor muda', async () => {
            const baseDescriptor = {
                width: 800,
                height: 1200,
                cleanUrl: 'https://reader.test/panel-001.png',
                pixelSample: 'aaaaaaaa',
                hasVisualPixels: true,
            };

            const changedDescriptor = {
                ...baseDescriptor,
                pixelSample: 'aaaaaaab',
            };

            const [first, second] = await Promise.all([
                createFingerprintFromDescriptor(baseDescriptor, deps),
                createFingerprintFromDescriptor(changedDescriptor, deps),
            ]);

            expect(first).not.toBe(second);
        });

        test('FP-22 imagens sem pixels visuais com URLs diferentes geram fingerprints diferentes', async () => {
            const baseDescriptor = {
                width: 800,
                height: 1200,
                pixelSample: 'nopixels',
                hasVisualPixels: false,
            };

            const [first, second] = await Promise.all([
                createFingerprintFromDescriptor({
                    ...baseDescriptor,
                    cleanUrl: 'https://cdn-a.test/chapter/page_001.png',
                }, deps),
                createFingerprintFromDescriptor({
                    ...baseDescriptor,
                    cleanUrl: 'https://cdn-b.test/chapter/page_001.png',
                }, deps),
            ]);

            expect(first).toMatch(/^[a-f0-9]{64}$/);
            expect(second).toMatch(/^[a-f0-9]{64}$/);
            expect(first).not.toBe(second);
        });
    });
});
