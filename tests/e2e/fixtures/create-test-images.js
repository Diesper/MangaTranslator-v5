/**
 * create-test-images.js
 * Gera imagens PNG válidas para os testes E2E sem dependências externas.
 *
 * PROBLEMA ORIGINAL: O arquivo original escrevia uma string base64 FALSA
 * num arquivo de texto. O browser nao conseguia carregar: naturalWidth=0.
 * As imagens nao passavam no filtro >= 300x400 do content_manga.js.
 *
 * CORRECAO: Geracao de PNGs binarios reais com Node.js nativo (zlib + Buffer).
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(__dirname, 'manga-images');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function createPng(width, height, [r, g, b]) {
    function crc32(buf) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            c ^= buf[i];
            for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function chunk(type, data) {
        const typeBytes = Buffer.from(type, 'ascii');
        const inner = Buffer.concat([typeBytes, data]);
        const out = Buffer.alloc(4 + inner.length + 4);
        out.writeUInt32BE(data.length, 0);
        inner.copy(out, 4);
        out.writeUInt32BE(crc32(inner), 4 + inner.length);
        return out;
    }

    const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);

    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width,  0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8; ihdrData[9] = 2; // 8-bit RGB

    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter type None
    for (let x = 0; x < width; x++) {
        row[1 + x*3] = r; row[1 + x*3 + 1] = g; row[1 + x*3 + 2] = b;
    }
    const raw = Buffer.concat(Array.from({ length: height }, () => row));
    const compressed = zlib.deflateSync(raw, { level: 1 }); // level 1 = fast

    return Buffer.concat([
        sig,
        chunk('IHDR', ihdrData),
        chunk('IDAT', compressed),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const images = [
    { file: 'page_001.png',          w: 800,  h: 1200, rgb: [180, 50,  50]  },
    { file: 'page_002.png',          w: 800,  h: 1200, rgb: [50,  80,  180] },
    { file: 'avatar.png',            w: 48,   h: 48,   rgb: [100, 200, 100] },
    { file: 'banner.png',            w: 960,  h: 120,  rgb: [220, 180, 50]  },
    { file: 'translated_result.png', w: 800,  h: 1200, rgb: [50,  160, 100] },
];

for (const { file, w, h, rgb } of images) {
    const buf = createPng(w, h, rgb);
    fs.writeFileSync(path.join(outDir, file), buf);
    console.log(`OK ${file}: ${w}x${h}px (${buf.length} bytes)`);
}

console.log('Todas as imagens de teste criadas com sucesso.');
