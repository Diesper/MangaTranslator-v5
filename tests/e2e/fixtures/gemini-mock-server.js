/**
 * gemini-mock-server.js
 * Servidor HTTP local para os testes E2E do Playwright.
 *
 * ARQUITETURA DE IMAGENS — POR QUE GERACAO EM MEMORIA:
 *
 * Historico de falhas:
 * 1. v1 (original): Escrevia string base64 falsa no arquivo .png.
 *    Chrome detectava arquivo corrompido → naturalWidth = 0 → 0 imagens detectadas.
 *
 * 2. v2 (Gemini SVG): Tentou SVGs com MIME image/svg+xml.
 *    Chrome reporta naturalWidth = 0 para SVGs carregados via <img> em modo headless
 *    quando o SVG nao tem dimensoes absolutas intrinsecas em pixels — o que e o caso
 *    de qualquer SVG que usa apenas viewBox sem width/height fixos em px.
 *    Resultado identico: naturalWidth = 0 → teste falhou.
 *
 * 3. v3 (este arquivo): PNGs binarios reais gerados EM MEMORIA ao iniciar o servidor.
 *    O formato PNG tem um campo IHDR que encapsula largura/altura em 4 bytes big-endian.
 *    O Chrome le o IHDR antes de decodificar os pixels e reporta naturalWidth/naturalHeight
 *    a partir desses valores IMEDIATAMENTE apos receber o header HTTP — mesmo antes
 *    de decodificar todos os IDAT. Resultado: naturalWidth = 800 garantido.
 *
 * AUSENCIA DE DEPENDENCIA EXTERNA:
 * Nao usa require('./create-test-images.js') — isso criava um ponto fragil:
 * se o usuario tinha uma versao antiga de create-test-images.js, ela sobrescrevia
 * os PNGs validos com strings falsas toda vez que o servidor iniciava.
 * Agora os buffers PNG vivem em memoria (Map) e nunca tocam o disco.
 */

const http = require('http');
const path = require('path');
const zlib = require('zlib');
const fs   = require('fs');

const PORT     = 3999;
const FIXTURES = __dirname;

function buildGeminiMockHtml() {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Gemini Mock</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #101418;
      color: #f5f7fa;
    }

    main {
      max-width: 920px;
      margin: 0 auto;
      min-height: 100vh;
      padding: 32px 24px 48px;
    }

    .shell {
      background: #1c232b;
      border: 1px solid #2d3742;
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }

    .toolbar h1 {
      font-size: 16px;
      margin: 0;
      font-weight: 700;
    }

    .attachment-container {
      min-height: 64px;
      margin-bottom: 14px;
      padding: 12px;
      border: 1px dashed #4d6377;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .preview-image {
      max-width: 130px;
      max-height: 180px;
      border-radius: 8px;
      display: none;
    }

    .prompt-box {
      min-height: 120px;
      padding: 14px;
      border-radius: 14px;
      background: #0f1419;
      border: 1px solid #344150;
      outline: none;
      white-space: pre-wrap;
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 14px;
    }

    button {
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      background: #3aa675;
      color: white;
      font-weight: 700;
      cursor: pointer;
    }

    #result-zone {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 1px solid #2d3742;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    #result-zone img {
      max-width: 100%;
      border-radius: 12px;
      display: block;
    }
  </style>
</head>
<body>
  <nav id="mock-side-nav" aria-label="Conversas" style="padding:8px 16px;background:#0b1015;border-bottom:1px solid #27323d;">
    <div id="mock-chat-list">
      <div class="mock-chat-row" data-chat-id="mock-chat">
        <a href="/app/mock-chat">Conversa do Manga Translator</a>
        <button type="button" data-test-id="chat-options" aria-haspopup="menu">Opções</button>
      </div>
      <div class="mock-chat-row" data-chat-id="other-chat">
        <a href="/app/other-chat">Outra conversa</a>
        <button type="button" aria-haspopup="menu">Opções</button>
      </div>
    </div>
  </nav>
  <main>
    <div class="shell">
      <div class="toolbar">
        <h1>Gemini Mock para Playwright</h1>
        <span id="mock-status">Aguardando entrada</span>
        <button data-test-id="temp-chat-button" aria-label="Desativar conversa temporária" style="display:none">Desativar conversa temporária</button>
        <div data-test-id="temp-chat-indicator" class="temp-chat-indicator" style="display:none">conversa temporária</div>
      </div>

      <div class="attachment-container">
        <img class="preview-image" alt="preview" />
        <span id="attachment-label">Nenhuma imagem anexada</span>
      </div>

      <div class="prompt-box" contenteditable="true" aria-label="Prompt" role="textbox"></div>

      <div class="actions">
        <button id="send-button" type="button" aria-label="Send message" title="Send message">Send</button>
      </div>

      <div id="result-zone"></div>
    </div>
  </main>

  <script>
    (() => {
      const editor = document.querySelector('[contenteditable="true"]');
      const preview = document.querySelector('.preview-image');
      const label = document.getElementById('attachment-label');
      const status = document.getElementById('mock-status');
      const resultZone = document.getElementById('result-zone');
      const sendButton = document.getElementById('send-button');
      const currentUrl = new URL(window.location.href);
      const jobIndex = currentUrl.searchParams.get('jobIndex') || '0';
      const fastResult = currentUrl.searchParams.get('fastResult') === '1';
      const ignoreSubmit = currentUrl.searchParams.get('ignoreSubmit') === '1';
      const chatOptionsButton = document.querySelector('[data-chat-id="mock-chat"] [data-test-id="chat-options"]');

      let attachmentSeen = false;
      let running = false;

      function showPreviewFromEvent(event) {
        if (attachmentSeen) return;

        attachmentSeen = true;
        label.textContent = 'Imagem anexada pelo content script';
        preview.style.display = 'block';

        const firstFile =
          event.clipboardData &&
          event.clipboardData.files &&
          event.clipboardData.files.length > 0
            ? event.clipboardData.files[0]
            : null;

        if (firstFile) {
          preview.src = URL.createObjectURL(firstFile);
        } else {
          preview.src =
            'data:image/svg+xml;utf8,' +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="220"><rect width="100%" height="100%" fill="#486581"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="white" font-family="Arial" font-size="18">preview</text></svg>'
            );
        }
      }

      function appendResultImage() {
        const response = document.createElement('model-response');
        response.setAttribute('data-message-author', 'model');

        const img = document.createElement('img');
        img.alt = 'Imagem traduzida do mock';
        img.src =
          '/gemini-result-image?jobIndex=' +
          encodeURIComponent(jobIndex) +
          '&t=' +
          Date.now();

        response.appendChild(img);
        resultZone.appendChild(response);
        status.textContent = 'Imagem traduzida pronta';
      }

      async function runTranslation() {
        if (ignoreSubmit) {
          status.textContent = 'Submit ignorado pelo mock';
          return;
        }
        if (running) return;

        running = true;
        status.textContent = 'Processando mock...';
        sendButton.disabled = true;
        if (editor) {
          editor.textContent = '';
          editor.innerText = '';
        }

        if (fastResult) {
          // A resposta aparece no mesmo task lógico do submit. O Observer V2
          // precisa ter sido instalado antes do click para capturá-la.
          appendResultImage();
          setTimeout(() => {
            sendButton.disabled = false;
          }, 0);
          return;
        }

        const stopBtn = document.createElement('button');
        stopBtn.setAttribute('data-test-id', 'stop-generating-button');
        stopBtn.setAttribute('aria-label', 'Stop generating');
        stopBtn.textContent = 'Stop';
        sendButton.parentNode.appendChild(stopBtn);

        await new Promise(resolve => setTimeout(resolve, 1200));

        stopBtn.remove();
        sendButton.disabled = false;
        appendResultImage();
      }

      if (chatOptionsButton) {
        chatOptionsButton.addEventListener('click', () => {
          document.getElementById('mock-delete-menu')?.remove();
          const menu = document.createElement('div');
          menu.id = 'mock-delete-menu';
          menu.setAttribute('role', 'menu');

          const deleteItem = document.createElement('div');
          deleteItem.setAttribute('role', 'menuitem');
          deleteItem.textContent = 'Excluir';
          deleteItem.tabIndex = 0;
          deleteItem.addEventListener('click', () => {
            menu.remove();
            document.getElementById('mock-delete-dialog')?.remove();

            const dialog = document.createElement('div');
            dialog.id = 'mock-delete-dialog';
            dialog.setAttribute('role', 'dialog');

            const confirm = document.createElement('button');
            confirm.type = 'button';
            confirm.textContent = 'Excluir';
            confirm.addEventListener('click', () => {
              dialog.dataset.confirmed = 'true';
              status.textContent = 'Conversa excluída pelo mock';
            });

            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.textContent = 'Cancelar';

            dialog.append(confirm, cancel);
            document.body.appendChild(dialog);
          });

          menu.appendChild(deleteItem);
          document.body.appendChild(menu);
        });
      }

      editor.addEventListener('paste', event => {
        showPreviewFromEvent(event);
      });

      editor.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          runTranslation();
        }
      });

      sendButton.addEventListener('click', () => {
        runTranslation();
      });
    })();
  </script>
</body>
</html>`;
}

// ── Gerador de PNG binario valido ─────────────────────────────────────────────
// Implementacao pura em Node.js sem dependencias externas.
// Produz um PNG RGB 8-bit com cor solida, decodificavel pelo Chrome.
function buildPng(width, height, [r, g, b]) {
    // CRC-32 (IEEE 802.3 polynomial, mesmo algoritmo do zlib.crc32)
    function crc32(buf) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            c ^= buf[i];
            for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    // Gera um chunk PNG: length(4) + type(4) + data(N) + crc(4)
    function chunk(type, data) {
        const hdr = Buffer.from(type, 'ascii');
        const inner = Buffer.concat([hdr, data]);
        const out = Buffer.alloc(4 + inner.length + 4);
        out.writeUInt32BE(data.length, 0);
        inner.copy(out, 4);
        out.writeUInt32BE(crc32(inner), 4 + inner.length);
        return out;
    }

    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    // IHDR: width(4) + height(4) + bitDepth(1) + colorType(1) + compression(1) + filter(1) + interlace(1)
    // colorType=2 = RGB truecolor (3 bytes por pixel)
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width,  0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: RGB

    // Scanlines: [filter_byte=0][R G B ... x width] repeated height times
    // Filter byte 0 = None (pixels sem delta encoding)
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter None
    for (let x = 0; x < width; x++) {
        row[1 + x * 3]     = r;
        row[1 + x * 3 + 1] = g;
        row[1 + x * 3 + 2] = b;
    }
    // Concatena todas as linhas e comprime com deflate
    const raw        = Buffer.concat(Array.from({ length: height }, () => row));
    const compressed = zlib.deflateSync(raw, { level: 1 }); // level 1 = rapido

    return Buffer.concat([
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', compressed),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function buildPanelPng(width, height, palette) {
    function crc32(buf) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            c ^= buf[i];
            for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function chunk(type, data) {
        const hdr = Buffer.from(type, 'ascii');
        const inner = Buffer.concat([hdr, data]);
        const out = Buffer.alloc(4 + inner.length + 4);
        out.writeUInt32BE(data.length, 0);
        inner.copy(out, 4);
        out.writeUInt32BE(crc32(inner), 4 + inner.length);
        return out;
    }

    const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;

    const rows = [];
    const topLimit = Math.floor(height * 0.14);
    const bottomLimit = Math.floor(height * 0.84);
    const stripeStart = Math.floor(width * 0.68);
    const stripeEnd = Math.floor(width * 0.8);

    for (let y = 0; y < height; y++) {
        const row = Buffer.alloc(1 + width * 3);
        row[0] = 0;

        for (let x = 0; x < width; x++) {
            let color = palette.main;
            if (y < topLimit) color = palette.top;
            else if (y >= bottomLimit) color = palette.bottom;

            if (x >= stripeStart && x <= stripeEnd && y > topLimit && y < bottomLimit) {
                color = palette.stripe;
            }

            row[1 + x * 3] = color[0];
            row[1 + x * 3 + 1] = color[1];
            row[1 + x * 3 + 2] = color[2];
        }

        rows.push(row);
    }

    const raw = Buffer.concat(rows);
    const compressed = zlib.deflateSync(raw, { level: 1 });

    return Buffer.concat([
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', compressed),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── Gera todos os buffers PNG em memoria ao iniciar ───────────────────────────
// Dimensoes intencionais:
//   page_001 / page_002: 800x1200 → passam no filtro >=300x400 do content_manga.js
//   avatar:              48x48    → NAO passa (muito pequeno)
//   banner:              960x120  → NAO passa (altura insuficiente)
//   translated_result:   800x1200 → usada pelo /gemini-result-image
const PNG_IMAGES = new Map([
    ['page_001.png',          buildPanelPng(800, 1200, {
        top: [70, 12, 12],
        main: [184, 44, 44],
        bottom: [230, 122, 122],
        stripe: [255, 242, 242],
    })],
    ['page_002.png',          buildPanelPng(800, 1200, {
        top: [10, 34, 87],
        main: [41, 98, 255],
        bottom: [118, 185, 255],
        stripe: [255, 232, 108],
    })],
    ['avatar.png',            buildPng(48,   48,   [100, 200, 100])],
    ['banner.png',            buildPng(960,  120,  [220, 180, 50])],
    ['translated_result_0.png', buildPanelPng(800, 1200, {
        top: [16, 85, 62],
        main: [29, 158, 94],
        bottom: [125, 220, 150],
        stripe: [235, 255, 242],
    })],
    ['translated_result_1.png', buildPanelPng(800, 1200, {
        top: [74, 20, 140],
        main: [144, 73, 255],
        bottom: [236, 157, 255],
        stripe: [255, 239, 120],
    })],
    ['translated_result_default.png', buildPanelPng(800, 1200, {
        top: [34, 78, 120],
        main: [72, 165, 214],
        bottom: [180, 232, 255],
        stripe: [255, 255, 255],
    })],
]);

// Escreve no disco tambem (para create-test-images.js e outros consumidores)
const MANGA_IMGS = path.join(FIXTURES, 'manga-images');
if (!fs.existsSync(MANGA_IMGS)) fs.mkdirSync(MANGA_IMGS, { recursive: true });
for (const [file, buf] of PNG_IMAGES) {
    fs.writeFileSync(path.join(MANGA_IMGS, file), buf);
}
console.log('PNG images generated in memory and written to disk.');

// ── Servidor HTTP ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const url = requestUrl.pathname;

    // Health check — usado pelo playwright.config.js para aguardar o servidor
    if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mock: true }));
        return;
    }

    // Gemini mock result image — simula resposta do Gemini apos traducao
    if (url === '/gemini-result-image') {
        const jobIndex = requestUrl.searchParams.get('jobIndex');
        const translatedKey = jobIndex === '0' || jobIndex === '1'
            ? `translated_result_${jobIndex}.png`
            : 'translated_result_default.png';
        const buf = PNG_IMAGES.get(translatedKey) || PNG_IMAGES.get('translated_result_default.png');
        setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            res.end(buf);
        }, 2000);
        return;
    }

    if (
        url === '/gemini' ||
        url === '/gemini/' ||
        url === '/app/mock-chat'
    ) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildGeminiMockHtml());
        return;
    }

    // manga-page.html — pagina HTML com as 4 imagens de teste
    if (url === '/' || url === '/manga-page.html') {
        const htmlPath = path.join(FIXTURES, 'manga-page.html');
        const html = fs.existsSync(htmlPath)
            ? fs.readFileSync(htmlPath)
            : Buffer.from('<html><body>manga-page.html not found</body></html>');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
    }

    // Imagens de manga: /manga-images/page_001.png etc.
    // Servidas da memoria — NUNCA do disco — para garantir validade.
    if (url.startsWith('/manga-images/')) {
        const file = path.basename(url);
        const buf  = PNG_IMAGES.get(file);
        if (buf) {
            res.writeHead(200, {
                'Content-Type':  'image/png',
                'Cache-Control': 'no-store', // evita cache stale no browser
            });
            res.end(buf);
            return;
        }
    }

    res.writeHead(404); res.end('Not found: ' + url);
});

server.listen(PORT, () => {
    console.log('Gemini Mock Server rodando na porta ' + PORT);
});
