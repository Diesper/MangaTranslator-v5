# 📖 Manga Translator

> Extensão para navegadores Chromium (Manifest V3) para tradução automática, contínua e em alta resolução de mangás e quadrinhos na web utilizando o Google Gemini. A versão do produto tem uma única fonte de verdade em `package.json` e é sincronizada automaticamente com o Manifest e os metadados de teste.

[![Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![CI](https://github.com/Diesper/Manga_Translator/actions/workflows/ci.yml/badge.svg)](https://github.com/Diesper/Manga_Translator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Tests: 100% Passed](https://img.shields.io/badge/Tests-Passing-brightgreen.svg)](tests/)

---

## ✨ Principais Funcionalidades

- **Automação Resiliente com Gemini:** pipeline modular com claim de job, Observer V2 orientado a eventos, submit confirmado por transição observável, attachment verificado e extração com fallbacks controlados — sem necessidade de chaves de API pagas.
- **Cache Perceptual Visual (GTC Fingerprint):** Identificação de imagens por assinatura perceptual dHash/aHash, impedindo retraduções de imagens já processadas mesmo com URLs dinâmicas ou CDN com tokens expiráveis.
- **Armazenamento Transacional (StorageManager + IndexedDB):** Persistência atômica com eliminação automática de assets órfãos e sem o problema de *read-modify-write* em acessos concorrentes.
- **Ciclo de Vida Durável (Manifest V3):** Reconciliação automática de abas e estado persistente resistente ao descarregamento (*unload*) do Service Worker do Chrome.
- **Leitor Embutido (Reader Mode):** Interface dedicada para visualização sequencial ou em página dupla dos mangás traduzidos, com opção de download local em lote.
- **Controle de Concorrência:** Fila assíncrona inteligente com limite de páginas simultâneas configurável para evitar sobrecarga ou bloqueio.
- **Filtro dimensional configurável:** Defina a largura e a altura mínimas das imagens elegíveis, com campos numéricos, controles deslizantes sincronizados, prévia proporcional e restauração rápida do padrão `300 × 400 px`.

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
│   ├── background.js          # Bootstrap do Service Worker + wiring dos módulos
│   ├── background/            # Router, estado, lifecycle, watchdog, reconciliação e actions
│   ├── content_manga.js       # Content script injetado nas páginas de mangá
│   ├── content_gemini.js      # Bootstrap/claim/keepalive/handlers do worker Gemini
│   ├── gemini/                 # DOM, Observer V2, editor, attachment, result, deletion e job-runner
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
├── scripts/                   # Automação de versionamento e manutenção
├── .github/workflows/         # CI e publicação de releases
└── package.json               # Fonte única da versão do produto + scripts
```

---

## 🔢 Versionamento

A versão do produto é definida **uma única vez** no `package.json` raiz. Os demais metadados são derivados dela:

- `extension/manifest.json` recebe a versão Chromium correspondente;
- `tests/package.json` e os metadados raiz de `tests/package-lock.json` recebem a versão SemVer completa;
- a UI de opções lê `chrome.runtime.getManifest().version`, sem número hardcoded;
- o workflow de publicação deriva tag, pasta, ZIP e nome da documentação automaticamente;
- a documentação canônica no repositório usa o caminho estável `docs/Documentação.md`.

Depois de alterar apenas `package.json`, execute:

```bash
npm run version:sync
npm run version:check
```

O CI também executa `version:check` e falha se os metadados divergirem.

---

## 🧪 Executando os Testes

O projeto conta com suíte abrangente de testes unitários, de integração, visuais, smoke e E2E.

Os testes de popup e content script também cobrem o filtro dimensional: valores
personalizados, atualização imediata após alteração no armazenamento,
sincronização entre campos/sliders/prévia e o reset para o padrão.

> A pipeline atual trata Jest, smoke/visual, validação de sintaxe/Manifest V3, cobertura e Playwright E2E como gates reais. Os cenários E2E incluem o fluxo padrão e os modos `minimized_window` e `background_delete`.

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
Fluxos reais de ponta a ponta no Chromium com a extensão carregada (tradução real, botão de parada, cache GTC, persistência no IndexedDB, auto-restauração no reload e leitor offline):
```bash
cd tests
npm run test:e2e
```

### CI e regressões de Service Worker

A pipeline em `.github/workflows/ci.yml` trata Jest e E2E como gates funcionais reais: falhas não são mascaradas por `|| true` ou `continue-on-error`. O job E2E em `main` roda mesmo quando o job anterior falha, para expor simultaneamente regressões do navegador.

Também existe um teste específico de carregamento em modo estrito (`tests/unit/background/background-strict-load.test.js`) para detectar exceções fatais durante o boot do Service Worker antes do registro dos listeners.

---

## 📚 Documentação Técnica

A arquitetura vigente, contratos IPC/storage, lifecycle MV3, cache perceptual, Gemini RPA, Reader, compatibilidade, versionamento e critérios de manutenção estão consolidados na documentação canônica de caminho estável:

- [`docs/Documentação.md`](docs/Documentação.md)

---

## 🛡️ Licença

Distribuído sob a licença **MIT**. Consulte o arquivo [`LICENSE`](LICENSE) para mais detalhes.
