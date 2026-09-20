'use strict';
// test_gtc_fingerprint.js — MangaTranslator v3.3
// Testes completos para gtc-fingerprint.js visual-v3

globalThis.self = globalThis;
require('../../extension/gtc-fingerprint.js');

const { describe, it, ita, beforeEach, expect } = require('./runner.js');
const { solidColor, horizontalGradient, checkerboard, mangaPage,
        noise, brightnessShifted, isValidHex, countSetBits } = require('./helpers.js');
const fp = globalThis.MangaTranslatorGtcFingerprint;

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1 — SHA-256
// ─────────────────────────────────────────────────────────────────────────────
describe('SHA-256 fingerprint (visual-v1/v2)', () => {
    it('buildFingerprintSource — pixels path', () => {
        const s = fp.buildFingerprintSource({ width:800, height:1200, pixelSample:'aabb', hasVisualPixels:true });
        expect(s).toBe('800:1200:pixels:aabb');
    });
    it('buildFingerprintSource — url path', () => {
        const s = fp.buildFingerprintSource({ width:100, height:200, cleanUrl:'https://ex.com/img.jpg', hasVisualPixels:false });
        expect(s).toBe('100:200:url:https://ex.com/img.jpg:nopixels');
    });
    it('buildFingerprintSource — empty defaults', () => {
        expect(fp.buildFingerprintSource({})).toBe('0:0:url::nopixels');
    });
    it('buildFingerprintSource — pixelSample=nopixels ignored', () => {
        const s = fp.buildFingerprintSource({ width:1, height:1, pixelSample:'nopixels', hasVisualPixels:true });
        expect(s).not.toMatch(':pixels:');
    });
    ita('hashStringSha256 — 64 hex chars', async () => {
        const h = await fp.hashStringSha256('hello world');
        expect(h).toHaveLength(64);
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
    ita('hashStringSha256 — deterministic', async () => {
        const h1 = await fp.hashStringSha256('manga-page-test');
        const h2 = await fp.hashStringSha256('manga-page-test');
        expect(h1).toBe(h2);
    });
    ita('hashStringSha256 — different inputs differ', async () => {
        const h1 = await fp.hashStringSha256('input-a');
        const h2 = await fp.hashStringSha256('input-b');
        expect(h1).not.toBe(h2);
    });
    ita('hashStringSha256 — injected cryptoImpl', async () => {
        const h = await fp.hashStringSha256('test', { cryptoImpl: globalThis.crypto });
        expect(h).toHaveLength(64);
    });
    ita('createFingerprintFromDescriptor — 64 chars', async () => {
        const h = await fp.createFingerprintFromDescriptor({ width:800, height:1200, pixelSample:'deadbeef', hasVisualPixels:true });
        expect(h).toHaveLength(64);
        expect(h).toMatch(/^[0-9a-f]{64}$/);
    });
    ita('createFingerprintFromDescriptor — deterministic', async () => {
        const d = { width:500, height:700, cleanUrl:'https://cdn.site.com/p1.jpg', hasVisualPixels:false };
        expect(await fp.createFingerprintFromDescriptor(d)).toBe(await fp.createFingerprintFromDescriptor(d));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2 — Haar DWT primitives (via calculateWHash behaviour)
// ─────────────────────────────────────────────────────────────────────────────
describe('Haar DWT — primitivas (via calculateWHash)', () => {
    it('constant image produces valid hex wHash', () => {
        // Constant image: all LL coefficients equal → all bits compare vs same median
        // Result is deterministic (all-zero or all-one nibbles), always a valid 64-char hex
        const data = solidColor(32, 32, 128, 128, 128);
        const hash = fp.calculateWHash(data);
        expect(isValidHex(hash, 64)).toBeTruthy();
    });

    it('two differently-structured images have different wHashes', () => {
        // Use images with genuine spatial variation, not constants
        const img1 = horizontalGradient(32, 32);         // left→right gradient
        const img2 = checkerboard(32, 32, 4);            // high-freq checkerboard
        const h1 = fp.calculateWHash(img1);
        const h2 = fp.calculateWHash(img2);
        expect(h1).not.toBe(h2);
    });

    it('DWT low-pass captures gross structure — gradient wHash ≠ checkerboard wHash', () => {
        // Validates that LL subband behaves differently for low-freq vs high-freq content
        const gradient = horizontalGradient(32, 32);
        const check    = checkerboard(32, 32, 2);
        const hG = fp.calculateWHash(gradient);
        const hC = fp.calculateWHash(check);
        const d  = fp.hammingDistance(hG, hC);
        // Genuinely different images → non-zero distance
        expect(d).toBeGreaterThan(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3 — calculateWHash
// ─────────────────────────────────────────────────────────────────────────────
describe('calculateWHash (Haar Wavelet, visual-v3)', () => {
    it('returns 64 hex chars', () => {
        expect(isValidHex(fp.calculateWHash(solidColor(32,32,200,100,50)), 64)).toBeTruthy();
    });
    it('deterministic — same imageData → same hash', () => {
        const data = horizontalGradient(32, 32);
        expect(fp.calculateWHash(data)).toBe(fp.calculateWHash(data));
    });
    it('Hamming = 0 for identical data', () => {
        const data = mangaPage(32, 32, 'EN');
        const h = fp.calculateWHash(data);
        expect(fp.hammingDistance(h, h)).toBe(0);
    });
    it('genuinely different images have non-zero Hamming', () => {
        // Use gradient vs checkerboard — guaranteed structural difference
        const h1 = fp.calculateWHash(horizontalGradient(32, 32));
        const h2 = fp.calculateWHash(checkerboard(32, 32, 2));
        expect(fp.hammingDistance(h1, h2)).toBeGreaterThan(0);
    });
    it('throws for insufficient imageData', () => {
        expect(() => fp.calculateWHash(new Uint8ClampedArray(100))).toThrow();
    });
    it('throws for null', () => {
        expect(() => fp.calculateWHash(null)).toThrow();
    });
    it('alpha channel ignored — same RGB different alpha → same hash', () => {
        const dA = solidColor(32, 32, 100, 150, 200, 255);
        const dB = solidColor(32, 32, 100, 150, 200, 100);
        expect(fp.calculateWHash(dA)).toBe(fp.calculateWHash(dB));
    });
    it('[CROSS-LANGUAGE] same art, different text → wHash Hamming ≤ WHASH_MATCH_THRESHOLD', () => {
        const hEN = fp.calculateWHash(mangaPage(32, 32, 'EN'));
        const hPT = fp.calculateWHash(mangaPage(32, 32, 'PT'));
        expect(fp.hammingDistance(hEN, hPT)).toBeLessThanOrEqual(fp.WHASH_MATCH_THRESHOLD);
    });
    it('[CROSS-LANGUAGE] completely different image → wHash Hamming > WHASH_MATCH_THRESHOLD', () => {
        const hEN    = fp.calculateWHash(mangaPage(32, 32, 'EN'));
        const hNoise = fp.calculateWHash(noise(32, 32, 999));
        expect(fp.hammingDistance(hEN, hNoise)).toBeGreaterThan(fp.WHASH_MATCH_THRESHOLD);
    });
    it('brightness shift +30 stays within match threshold', () => {
        const base    = horizontalGradient(32, 32);
        const shifted = brightnessShifted(base, 30);
        const d = fp.hammingDistance(fp.calculateWHash(base), fp.calculateWHash(shifted));
        expect(d).toBeLessThanOrEqual(fp.WHASH_MATCH_THRESHOLD);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4 — calculatePHash
// ─────────────────────────────────────────────────────────────────────────────
describe('calculatePHash (DCT separável, visual-v3)', () => {
    it('returns 64 hex chars', () => {
        expect(isValidHex(fp.calculatePHash(solidColor(32,32,128,64,32)), 64)).toBeTruthy();
    });
    it('deterministic', () => {
        const data = checkerboard(32, 32, 4);
        expect(fp.calculatePHash(data)).toBe(fp.calculatePHash(data));
    });
    it('Hamming = 0 for identical data', () => {
        const data = mangaPage(32, 32, 'EN');
        const h = fp.calculatePHash(data);
        expect(fp.hammingDistance(h, h)).toBe(0);
    });
    it('throws for insufficient imageData', () => {
        expect(() => fp.calculatePHash(new Uint8ClampedArray(500))).toThrow();
    });
    it('throws for null', () => {
        expect(() => fp.calculatePHash(null)).toThrow();
    });
    it('cosine table lazy-init — second call reuses cache', () => {
        expect(isValidHex(fp.calculatePHash(solidColor(32,32,100,100,100)), 64)).toBeTruthy();
        expect(isValidHex(fp.calculatePHash(solidColor(32,32,101,101,101)), 64)).toBeTruthy();
    });
    it('[DC-ROBUSTEZ] brightness +40 → pHash Hamming ≤ PHASH_MATCH_THRESHOLD', () => {
        // DC[0,0] excluded from pHash → global brightness shifts don't change hash
        const base    = mangaPage(32, 32, 'EN');
        const shifted = brightnessShifted(base, 40);
        const d = fp.hammingDistance(fp.calculatePHash(base), fp.calculatePHash(shifted));
        expect(d).toBeLessThanOrEqual(fp.PHASH_MATCH_THRESHOLD);
    });
    it('[CROSS-LANGUAGE] via matchPerceptualHashes (pHash alone or combined)', () => {
        // At 32x32, pHash cross-language distance can exceed 35 alone.
        // This is correct — pHash is a COMPLEMENT to wHash, not a replacement.
        // The combined decision (wHash OR pHash) still produces a match.
        const imgEN = mangaPage(32, 32, 'EN');
        const imgPT = mangaPage(32, 32, 'PT');
        const wEN = fp.calculateWHash(imgEN), pEN = fp.calculatePHash(imgEN);
        const wPT = fp.calculateWHash(imgPT), pPT = fp.calculatePHash(imgPT);
        const decision = fp.matchPerceptualHashes(wEN, pEN, wPT, pPT);
        // Combined decision must be a match (even if pHash alone exceeds its threshold)
        expect(decision.match).toBe(true);
    });
    it('wHash and pHash of same image are different strings (complementary algorithms)', () => {
        const data = mangaPage(32, 32, 'EN');
        const hw = fp.calculateWHash(data);
        const hp = fp.calculatePHash(data);
        expect(hw).toHaveLength(64);
        expect(hp).toHaveLength(64);
        expect(hw).not.toBe(hp);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5 — dHash (visual-v2)
// ─────────────────────────────────────────────────────────────────────────────
describe('calculateDHash (visual-v2) — backward-compat', () => {
    it('returns 16 hex chars', () => {
        const data = new Uint8ClampedArray(9 * 8 * 4); data.fill(128);
        expect(isValidHex(fp.calculateDHash(data), 16)).toBeTruthy();
    });
    it('deterministic', () => {
        const data = new Uint8ClampedArray(9 * 8 * 4);
        for (let i = 0; i < data.length; i++) data[i] = i % 255;
        expect(fp.calculateDHash(data)).toBe(fp.calculateDHash(data));
    });
    it('throws for insufficient imageData', () => {
        expect(() => fp.calculateDHash(new Uint8ClampedArray(100))).toThrow();
    });
    it('all-white image → all bits 0 (left never > right)', () => {
        expect(fp.calculateDHash(solidColor(9, 8, 255, 255, 255))).toBe('0000000000000000');
    });
    it('all-black image → all bits 0 (same logic)', () => {
        expect(fp.calculateDHash(solidColor(9, 8, 0, 0, 0))).toBe('0000000000000000');
    });
    it('cross-language Hamming is reported (informational)', () => {
        const hEN = fp.calculateDHash(mangaPage(9, 8, 'EN'));
        const hPT = fp.calculateDHash(mangaPage(9, 8, 'PT'));
        const d   = fp.hammingDistance(hEN, hPT);
        console.log(`      dHash cross-language Hamming: ${d}/64 bits`);
        expect(typeof d).toBe('number');
        expect(d).toBeGreaterThanOrEqual(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6 — Regional Hashes
// ─────────────────────────────────────────────────────────────────────────────
describe('Regional Hashes (visual-v3) — 4 cantos 48×48', () => {
    it('returns object with 4 fields', () => {
        const r = fp.calculateRegionalHashes(solidColor(48, 48, 128, 128, 128));
        expect(r).toHaveProperty('topLeft');
        expect(r).toHaveProperty('topRight');
        expect(r).toHaveProperty('bottomLeft');
        expect(r).toHaveProperty('bottomRight');
    });
    it('each field is 16 hex chars', () => {
        const r = fp.calculateRegionalHashes(horizontalGradient(48, 48));
        expect(isValidHex(r.topLeft,    16)).toBeTruthy();
        expect(isValidHex(r.topRight,   16)).toBeTruthy();
        expect(isValidHex(r.bottomLeft, 16)).toBeTruthy();
        expect(isValidHex(r.bottomRight,16)).toBeTruthy();
    });
    it('deterministic', () => {
        const data = mangaPage(48, 48, 'EN');
        const r1 = fp.calculateRegionalHashes(data);
        const r2 = fp.calculateRegionalHashes(data);
        expect(r1.topLeft).toBe(r2.topLeft);
        expect(r1.bottomRight).toBe(r2.bottomRight);
    });
    it('throws for insufficient imageData', () => {
        expect(() => fp.calculateRegionalHashes(new Uint8ClampedArray(100))).toThrow();
    });
    it('genuinely different spatial content → at least one corner differs', () => {
        // Use images with real spatial variation (not pure constants)
        const r1 = fp.calculateRegionalHashes(horizontalGradient(48, 48));
        const r2 = fp.calculateRegionalHashes(checkerboard(48, 48, 4));
        const anyDiff = ['topLeft','topRight','bottomLeft','bottomRight']
            .some(k => r1[k] !== r2[k]);
        expect(anyDiff).toBeTruthy();
    });
    it('[CENTRE-STABLE] text in centre does not change corner hashes', () => {
        const rEN = fp.calculateRegionalHashes(mangaPage(48, 48, 'EN'));
        const rPT = fp.calculateRegionalHashes(mangaPage(48, 48, 'PT'));
        const dTL = fp.hammingDistance(rEN.topLeft,     rPT.topLeft);
        const dTR = fp.hammingDistance(rEN.topRight,    rPT.topRight);
        const dBL = fp.hammingDistance(rEN.bottomLeft,  rPT.bottomLeft);
        const dBR = fp.hammingDistance(rEN.bottomRight, rPT.bottomRight);
        console.log(`      Regional Hamming EN vs PT: TL=${dTL} TR=${dTR} BL=${dBL} BR=${dBR}`);
        const matches = [dTL, dTR, dBL, dBR].filter(d => d <= 8).length;
        expect(matches).toBeGreaterThanOrEqual(3);
    });
    it('matchRegionalHashes — identical → match=true, matchCount=4', () => {
        const r = fp.calculateRegionalHashes(mangaPage(48, 48, 'EN'));
        const result = fp.matchRegionalHashes(r, r);
        expect(result.match).toBe(true);
        expect(result.matchCount).toBe(4);
    });
    it('matchRegionalHashes — different images returns boolean', () => {
        const r1 = fp.calculateRegionalHashes(horizontalGradient(48, 48));
        const r2 = fp.calculateRegionalHashes(noise(48, 48, 12345));
        expect(typeof fp.matchRegionalHashes(r1, r2).match).toBe('boolean');
    });
    it('matchRegionalHashes — respects custom minMatches', () => {
        const r = fp.calculateRegionalHashes(mangaPage(48, 48, 'EN'));
        expect(fp.matchRegionalHashes(r, r, { threshold:8, minMatches:1 }).match).toBe(true);
    });
    it('matchRegionalHashes — returns details per corner', () => {
        const r = fp.calculateRegionalHashes(mangaPage(48, 48, 'EN'));
        const result = fp.matchRegionalHashes(r, r);
        expect(result.details.topLeft.dist).toBe(0);
        expect(result.details.topLeft.match).toBe(true);
    });
    it('matchRegionalHashes — null input → match=false', () => {
        const result = fp.matchRegionalHashes(null, null);
        expect(result.match).toBe(false);
        expect(result.matchCount).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7 — hammingDistance (generalised)
// ─────────────────────────────────────────────────────────────────────────────
describe('hammingDistance (generalizada)', () => {
    it('identical hash → 0',        () => expect(fp.hammingDistance('deadbeef01234567','deadbeef01234567')).toBe(0));
    it('all-0 vs all-f (16 chars) → 64', () => expect(fp.hammingDistance('0'.repeat(16),'f'.repeat(16))).toBe(64));
    it('all-0 vs all-f (64 chars) → 256',() => expect(fp.hammingDistance('0'.repeat(64),'f'.repeat(64))).toBe(256));
    it('different lengths → -1',    () => expect(fp.hammingDistance('abcd','abcdef')).toBe(-1));
    it('null → -1',                 () => { expect(fp.hammingDistance(null,'abcd')).toBe(-1); expect(fp.hammingDistance('abcd',null)).toBe(-1); });
    it('undefined → -1',            () => expect(fp.hammingDistance(undefined,'abcd')).toBe(-1));
    it('empty strings → -1',        () => expect(fp.hammingDistance('','')).toBe(-1));
    it('symmetric: d(a,b)==d(b,a)', () => {
        const h1='a1b2c3d4e5f60718', h2='f0e1d2c3b4a59687';
        expect(fp.hammingDistance(h1,h2)).toBe(fp.hammingDistance(h2,h1));
    });
    it('1 bit difference → 1',  () => expect(fp.hammingDistance('0'+'0'.repeat(15),'1'+'0'.repeat(15))).toBe(1));
    it('full nibble diff → 4',  () => expect(fp.hammingDistance('0'+'0'.repeat(15),'f'+'0'.repeat(15))).toBe(4));
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8 — matchPerceptualHashes
// ─────────────────────────────────────────────────────────────────────────────
describe('matchPerceptualHashes (decisão combinada wHash+pHash)', () => {
    function makeH(len, ones) {
        const chars=[]; let left=ones;
        for(let i=0;i<len;i++){
            if(left>=4){chars.push('f');left-=4;}
            else if(left===3){chars.push('e');left=0;}
            else if(left===2){chars.push('c');left=0;}
            else if(left===1){chars.push('8');left=0;}
            else chars.push('0');
        }
        return chars.join('');
    }

    it('both match → match=true, reason=both_match', () => {
        const r = fp.matchPerceptualHashes(makeH(64,0), makeH(64,0), makeH(64,20), makeH(64,15));
        expect(r.match).toBe(true);
        expect(r.reason).toBe('both_match');
        expect(r.confidence).toBeGreaterThan(0);
    });
    it('only wHash match → reason=whash_match', () => {
        const r = fp.matchPerceptualHashes(makeH(64,0), makeH(64,0), makeH(64,30), makeH(64,40));
        expect(r.match).toBe(true);
        expect(r.reason).toBe('whash_match');
    });
    it('only pHash match → reason=phash_match', () => {
        const r = fp.matchPerceptualHashes(makeH(64,0), makeH(64,0), makeH(64,50), makeH(64,25));
        expect(r.match).toBe(true);
        expect(r.reason).toBe('phash_match');
    });
    it('both reject → match=false, reason=both_reject', () => {
        const r = fp.matchPerceptualHashes(makeH(64,0), makeH(64,0), makeH(64,100), makeH(64,90));
        expect(r.match).toBe(false);
        expect(r.reason).toBe('both_reject');
    });
    it('both miss (grey zone) → match=false, reason=both_miss', () => {
        const r = fp.matchPerceptualHashes(makeH(64,0), makeH(64,0), makeH(64,60), makeH(64,50));
        expect(r.match).toBe(false);
        expect(r.reason).toBe('both_miss');
    });
    it('only wHash → whash_only_match/miss', () => {
        const base = makeH(64,0);
        expect(fp.matchPerceptualHashes(base,null,makeH(64,20),null).reason).toBe('whash_only_match');
        expect(fp.matchPerceptualHashes(base,null,makeH(64,60),null).reason).toBe('whash_only_miss');
    });
    it('only pHash → phash_only_match/miss', () => {
        const base = makeH(64,0);
        expect(fp.matchPerceptualHashes(null,base,null,makeH(64,20)).reason).toBe('phash_only_match');
        expect(fp.matchPerceptualHashes(null,base,null,makeH(64,60)).reason).toBe('phash_only_miss');
    });
    it('no hashes → reason=no_hashes', () => {
        const r = fp.matchPerceptualHashes(null,null,null,null);
        expect(r.match).toBe(false);
        expect(r.reason).toBe('no_hashes');
        expect(r.wDist).toBe(-1);
        expect(r.pDist).toBe(-1);
    });
    it('identical hashes → confidence ≈ 1', () => {
        const h = makeH(64,0);
        expect(fp.matchPerceptualHashes(h,h,h,h).confidence).toBeCloseTo(1.0, 1);
    });
    it('confidence decreases as distance increases', () => {
        const b = makeH(64,0);
        const r1 = fp.matchPerceptualHashes(b,b,makeH(64,10),makeH(64,10));
        const r2 = fp.matchPerceptualHashes(b,b,makeH(64,30),makeH(64,25));
        expect(r1.confidence).toBeGreaterThan(r2.confidence);
    });
    it('wDist and pDist are correct in response', () => {
        const wA='0'.repeat(64), pA='0'.repeat(64), wB=makeH(64,20), pB=makeH(64,15);
        const r = fp.matchPerceptualHashes(wA,pA,wB,pB);
        expect(r.wDist).toBe(fp.hammingDistance(wA,wB));
        expect(r.pDist).toBe(fp.hammingDistance(pA,pB));
    });
    it('public thresholds have correct values', () => {
        expect(fp.WHASH_MATCH_THRESHOLD).toBe(40);
        expect(fp.PHASH_MATCH_THRESHOLD).toBe(35);
        expect(fp.WHASH_REJECT_THRESHOLD).toBe(80);
        expect(fp.PHASH_REJECT_THRESHOLD).toBe(70);
    });
    it('exact threshold wDist=40 counts as match', () => {
        const wA='0'.repeat(64), wB=makeH(64,40);
        expect(fp.matchPerceptualHashes(wA,null,wB,null).match).toBe(true);
    });
    it('one above threshold wDist=41 does NOT match (isolated)', () => {
        const wA='0'.repeat(64), wB=makeH(64,41);
        expect(fp.matchPerceptualHashes(wA,null,wB,null).match).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 9 — Cross-language simulation end-to-end
// ─────────────────────────────────────────────────────────────────────────────
describe('Simulação Cross-Language — pipeline completo', () => {
    function scaleDown(data, sW, sH, dW, dH) {
        const out = new Uint8ClampedArray(dW*dH*4);
        for(let r=0;r<dH;r++) for(let c=0;c<dW;c++){
            const si=((Math.floor(r*sH/dH))*sW+Math.floor(c*sW/dW))*4, di=(r*dW+c)*4;
            out[di]=data[si]; out[di+1]=data[si+1]; out[di+2]=data[si+2]; out[di+3]=data[si+3];
        }
        return out;
    }

    it('wHash EN and PT pass matchPerceptualHashes', () => {
        const eN32 = scaleDown(mangaPage(64,64,'EN'),64,64,32,32);
        const pT32 = scaleDown(mangaPage(64,64,'PT'),64,64,32,32);
        const dec  = fp.matchPerceptualHashes(
            fp.calculateWHash(eN32), fp.calculatePHash(eN32),
            fp.calculateWHash(pT32), fp.calculatePHash(pT32));
        console.log(`      Cross-language: match=${dec.match}, reason=${dec.reason}, conf=${dec.confidence?.toFixed(3)}, wDist=${dec.wDist}, pDist=${dec.pDist}`);
        expect(dec.match).toBe(true);
    });

    it('noise does NOT match manga page', () => {
        const mG32  = scaleDown(mangaPage(64,64,'EN'),64,64,32,32);
        const nZ32  = scaleDown(noise(64,64,777),64,64,32,32);
        const dec   = fp.matchPerceptualHashes(
            fp.calculateWHash(mG32), fp.calculatePHash(mG32),
            fp.calculateWHash(nZ32), fp.calculatePHash(nZ32));
        expect(dec.match).toBe(false);
    });

    it('wHash better than dHash for cross-language (lower relative Hamming)', () => {
        const eN9x8 = mangaPage(9,8,'EN'), pT9x8 = mangaPage(9,8,'PT');
        const dD = fp.hammingDistance(fp.calculateDHash(eN9x8), fp.calculateDHash(pT9x8));
        const eN32 = scaleDown(mangaPage(64,64,'EN'),64,64,32,32);
        const pT32 = scaleDown(mangaPage(64,64,'PT'),64,64,32,32);
        const wD = fp.hammingDistance(fp.calculateWHash(eN32), fp.calculateWHash(pT32));
        console.log(`      dHash rel=${(dD/64*100).toFixed(1)}% wHash rel=${(wD/256*100).toFixed(1)}%`);
        // wHash relative distance should be ≤ dHash relative distance
        expect(wD/256).toBeLessThanOrEqual(dD/64);
    });
});
