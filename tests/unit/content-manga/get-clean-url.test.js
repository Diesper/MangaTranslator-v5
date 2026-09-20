/**
 * get-clean-url.test.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Testes completos de getCleanUrl() — v3.2.
 *
 * CONTEXTO: Sites de mangá modernos usam CDNs (AWS S3, Cloudflare, GCS) que
 * anexam tokens de sessão nas URLs de imagem. Após F5, esses tokens mudam.
 * getCleanUrl() remove todos os parâmetros de query e hash, retornando apenas
 * origin + pathname — a parte estável da URL.
 *
 * CASOS CRÍTICOS:
 * - Token AWS: ?AWSAccessKeyId=...&Expires=...&Signature=...
 * - Token Cloudflare: ?token=...&expires=...
 * - Token GCS: ?X-Goog-Signature=...
 * - Hash de âncora: #page-3
 * - Data URLs (deve retornar null)
 * - URLs relativas (deve resolver contra window.location.origin)
 */

// Implementação espelho de getCleanUrl (content_manga.js v3.2)
function getCleanUrl(urlStr) {
    if (!urlStr || urlStr.startsWith('data:')) return null;
    try {
        const u = new URL(urlStr, 'https://testmanga.com');
        return u.origin + u.pathname;
    } catch(e) {
        return urlStr.split('?')[0].split('#')[0];
    }
}

describe('CM-01/CM-02/CM-03/CM-04: getCleanUrl() — Normalização de URLs de CDN (v3.2)', () => {

    describe('Casos básicos — sem parâmetros', () => {
        test('URL simples sem parâmetros não é modificada', () => {
            const url = 'https://cdn.site.com/manga/pag1.jpg';
            expect(getCleanUrl(url)).toBe(url);
        });

        test('URL com apenas subpath é preservada integralmente', () => {
            const url = 'https://s1.mangalivre.net/manga/one-piece/chapter-1050/01.jpg';
            expect(getCleanUrl(url)).toBe(url);
        });
    });

    describe('Remoção de query strings (tokens de CDN)', () => {
        test('remove token Cloudflare simples', () => {
            const url = 'https://cdn.site.com/pag1.jpg?token=ABC123&expires=9999999';
            expect(getCleanUrl(url)).toBe('https://cdn.site.com/pag1.jpg');
        });

        test('remove token AWS S3 (AWSAccessKeyId + Expires + Signature)', () => {
            const url = 'https://s3.amazonaws.com/manga/pag1.jpg?AWSAccessKeyId=AKIA&Expires=1714000000&Signature=xyz';
            expect(getCleanUrl(url)).toBe('https://s3.amazonaws.com/manga/pag1.jpg');
        });

        test('remove token Google Cloud Storage (X-Goog-Signature)', () => {
            const url = 'https://storage.googleapis.com/bucket/pag1.jpg?X-Goog-Signature=abcdef&X-Goog-Expires=3600';
            expect(getCleanUrl(url)).toBe('https://storage.googleapis.com/bucket/pag1.jpg');
        });

        test('remove parâmetros de cache-busting (?v=, ?_=, ?timestamp=)', () => {
            expect(getCleanUrl('https://cdn.site.com/img.jpg?v=1714000000')).toBe('https://cdn.site.com/img.jpg');
            expect(getCleanUrl('https://cdn.site.com/img.jpg?_=1714000000')).toBe('https://cdn.site.com/img.jpg');
            expect(getCleanUrl('https://cdn.site.com/img.jpg?timestamp=1714000000')).toBe('https://cdn.site.com/img.jpg');
        });
    });

    describe('Remoção de hash/âncora', () => {
        test('remove hash de âncora da URL', () => {
            const url = 'https://cdn.site.com/pag1.jpg#section-3';
            expect(getCleanUrl(url)).toBe('https://cdn.site.com/pag1.jpg');
        });

        test('remove tanto query quanto hash', () => {
            const url = 'https://cdn.site.com/pag1.jpg?token=abc#page=2';
            expect(getCleanUrl(url)).toBe('https://cdn.site.com/pag1.jpg');
        });
    });

    describe('Mesma imagem = mesma chave após rotação de tokens (caso crítico)', () => {
        test('F5 com novo token retorna a mesma clean URL', () => {
            const visit1 = 'https://cdn.site.com/manga/pag1.jpg?token=ABC123&expires=1714000000';
            const visit2 = 'https://cdn.site.com/manga/pag1.jpg?token=XYZ789&expires=1714003600';
            expect(getCleanUrl(visit1)).toBe(getCleanUrl(visit2));
        });

        test('diferentes imagens com tokens diferentes produzem chaves diferentes', () => {
            const img1 = 'https://cdn.site.com/manga/pag1.jpg?token=ABC';
            const img2 = 'https://cdn.site.com/manga/pag2.jpg?token=ABC';
            expect(getCleanUrl(img1)).not.toBe(getCleanUrl(img2));
        });
    });

    describe('Data URLs — devem retornar null', () => {
        test('data:image/png retorna null (não é URL de rede)', () => {
            expect(getCleanUrl('data:image/png;base64,iVBOR==')).toBeNull();
        });

        test('data:image/jpeg retorna null', () => {
            expect(getCleanUrl('data:image/jpeg;base64,/9j/')).toBeNull();
        });
    });

    describe('Entradas inválidas', () => {
        test('string vazia retorna null', () => {
            expect(getCleanUrl('')).toBeNull();
        });

        test('null retorna null', () => {
            expect(getCleanUrl(null)).toBeNull();
        });

        test('undefined retorna null', () => {
            expect(getCleanUrl(undefined)).toBeNull();
        });

        test('URL malformada não lança exceção (fallback com split)', () => {
            expect(() => getCleanUrl('not-a-url?param=value')).not.toThrow();
        });

        test('URL sem scheme é resolvida contra a base (comportamento correto do new URL)', () => {
            // CORREÇÃO: new URL('not-a-url?param=value', 'https://testmanga.com')
            // NAO lança TypeError — trata como URL relativa e resolve contra a base.
            // Resultado: 'https://testmanga.com/not-a-url' (query removida corretamente).
            // O fallback via split('?') nunca é acionado porque new URL() tem sucesso.
            // O comportamento CORRETO é retornar a URL resolvida sem query string.
            const result = getCleanUrl('not-a-url?param=value');
            expect(result).toBe('https://testmanga.com/not-a-url');
        });
    });

    describe('URLs relativas', () => {
        test('URL relativa é resolvida contra a origem', () => {
            const result = getCleanUrl('/manga/chapter/pag1.jpg');
            expect(result).toContain('/manga/chapter/pag1.jpg');
        });

        test('URL relativa com query tem query removida', () => {
            const result = getCleanUrl('/pag1.jpg?token=abc');
            expect(result).not.toContain('?');
            expect(result).not.toContain('token');
        });
    });

    describe('Preservação de estrutura de path', () => {
        test('path complexo com múltiplas pastas é preservado', () => {
            const url = 'https://cdn.example.com/media/manga/series/one-piece/vol-01/chapter-1050/page-001.jpg';
            expect(getCleanUrl(url)).toBe(url); // Sem query = sem mudança
        });

        test('extensão do arquivo é preservada (.jpg, .png, .webp)', () => {
            ['jpg', 'png', 'webp', 'gif'].forEach(ext => {
                const url = `https://cdn.site.com/img.${ext}?token=abc`;
                expect(getCleanUrl(url)).toBe(`https://cdn.site.com/img.${ext}`);
            });
        });
    });
});
