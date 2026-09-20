# 📖 MangaTranslator v5.1

> Extensão para navegadores Chromium (Manifest V3) para tradução automática, contínua e em alta resolução de mangás e quadrinhos na web utilizando o Google Gemini.

[![Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![CI](https://github.com/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests: 100% Passed](https://img.shields.io/badge/Tests-Passing-brightgreen.svg)](tests/)

---

## ✨ Principais Funcionalidades

- **Automação Resiliente com Gemini:** Tradução de painéis e balões de diálogo com injeção segura de conteúdo no Gemini (`gemini.google.com`) sem necessidade de chaves de API pagas.
- **Cache Perceptual Visual (GTC Fingerprint):** Identificação de imagens por assinatura perceptual dHash/aHash, impedindo retraduções de imagens já processadas mesmo com URLs dinâmicas ou CDN com tokens expiráveis.
- **Armazenamento Transacional (StorageManager + IndexedDB):** Persistência atômica com eliminação automática de assets órfãos e sem o problema de *read-modify-write* em acessos concorrentes.
- **Ciclo de Vida Durável (Manifest V3):** Reconciliação automática de abas e estado persistente resistente ao descarregamento (*unload*) do Service Worker do Chrome.
- **Leitor Embutido (Reader Mode):** Interface dedicada para visualização sequencial ou em página dupla dos mangás traduzidos, com opção de download local em lote.
- **Controle de Concorrência:** Fila assíncrona inteligente com limite de páginas simultâneas configurável para evitar sobrecarga ou bloqueio.

---

## 🚀 Como Instalar no Navegador

Como a extensão está em formato de código aberto, você pode carregá-la diretamente em qualquer navegador baseado em Chromium (**Google Chrome**, **Microsoft Edge**, **Brave**, **Opera**):

1. Clone ou baixe este repositório no seu computador.
2. Abra a página de extensões no seu navegador:
   - **Google Chrome:** `chrome://extensions`
   - **Microsoft Edge:** `edge://extensions`
   - **Brave:** `brave://extensions`
3. No canto superior direito, ative o interruptor **Modo do desenvolvedor** (*Developer mode*).
4. Clique no botão **Carregar sem compactação** (*Load unpacked*).
5. Selecione a pasta [`extension/`](extension/) deste projeto.
6. Pronto! O ícone do **MangaTranslator** aparecerá na sua barra de extensões.

---

## 📂 Estrutura do Repositório

```text
├── extension/                 # Código-fonte da extensão (Manifest V3)
│   ├── manifest.json          # Manifesto da extensão
│   ├── background.js          # Service worker central (fila, IPC, lifecycle)
│   ├── content_manga.js       # Content script injetado nas páginas de mangá
│   ├── content_gemini.js      # Content script para automação na interface Gemini
│   ├── gtc-fingerprint.js     # Hashing perceptual e extração de assinaturas
│   ├── gtc-indexeddb.js       # Camada de banco de dados visual IndexedDB
│   ├── storage-manager.js     # Gerenciamento atômico de blobs e transações
│   ├── popup.html / popup.js  # Janela de controle da extensão
│   ├── options.html / .js     # Painel de preferências e configurações
│   └── reader.html / reader.js# Modo leitor integrado
├── tests/                     # Suíte de testes automatizados
│   ├── smoke/                 # Testes de fumaça rápidos (ciclo de vida, concorrência)
│   ├── unit/                  # Testes unitários Jest (GTC, background, content)
│   ├── integration/           # Testes de integração de fluxo IPC
│   ├── visual-v3/             # Testes visuais de consistência e fingerprint
│   └── e2e/                   # Testes de ponta a ponta com Playwright
├── docs/                      # Documentação técnica de arquitetura
├── .github/workflows/         # Pipeline de Integração Contínua (CI)
└── package.json               # Configurações de scripts
```

---

## 🧪 Executando os Testes

O projeto conta com suíte abrangente de testes unitários, de integração, visuais e de fumaça:

### Testes de Fumaça (Smoke Tests)
Validação ultrarrápida do ciclo de vida, transações IndexedDB e isolamento de lote:
```powershell
# No Windows:
.\run-smoke.bat
# ou
powershell -ExecutionPolicy Bypass -File .\run-smoke.ps1
```

### Testes Unitários e Integração (Jest)
```bash
npm test
# ou diretamente dentro da pasta tests:
cd tests
npm run test:unit
```

### Testes E2E (Playwright)
```bash
npm run test:e2e
```

---

## 🛡️ Licença

Distribuído sob a licença **MIT**. Consulte o arquivo [`LICENSE`](LICENSE) para mais detalhes.
