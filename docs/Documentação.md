# Manga Translator — Documentação Técnica Consolidada

> **Documento canônico da arquitetura atual do Manga Translator.**
>
> **Fonte única da versão:** `package.json`. O Manifest, os metadados de teste, a UI e os artefatos de release são derivados dessa fonte.
>
> Esta documentação descreve a arquitetura que existe no código atual do projeto.
> Ela substitui, como fonte operacional de verdade, a documentação incremental da
> série v5.x. O arquivo anterior permanece apenas como registro histórico das
> etapas de refatoração.
>
> **Data da consolidação:** 26/09/2026.
>
> **Escopo da auditoria:** manifesto, Service Worker, módulos de background,
> content scripts, cache perceptual, IndexedDB, persistência de capítulos,
> popup, opções, reader, scripts auxiliares, testes e pipeline de CI.

---

## Índice

1. [Objetivo e regras desta documentação](#1-objetivo-e-regras-desta-documentação)
2. [Estado documentado na v6.5](#2-estado-documentado-na-v65)
3. [Topologia do repositório](#3-topologia-do-repositório)
4. [Manifest V3 e modelo de injeção](#4-manifest-v3-e-modelo-de-injeção)
5. [Service Worker e bootstrap modular](#5-service-worker-e-bootstrap-modular)
6. [Estado durável, jobs e recuperação MV3](#6-estado-durável-jobs-e-recuperação-mv3)
7. [Fluxo completo de tradução](#7-fluxo-completo-de-tradução)
8. [Roteamento de mensagens e contratos IPC](#8-roteamento-de-mensagens-e-contratos-ipc)
9. [Persistência de capítulos — StorageManager](#9-persistência-de-capítulos--storagemanager)
10. [Cache Global de Traduções — GTC](#10-cache-global-de-traduções--gtc)
11. [Pipeline do content_manga](#11-pipeline-do-content_manga)
12. [Automação do Gemini](#12-automação-do-gemini)
13. [Anti-throttling e script MAIN](#13-anti-throttling-e-script-main)
14. [Popup, opções, UI compartilhada e Reader](#14-popup-opções-ui-compartilhada-e-reader)
15. [Compatibilidade e legado que ainda existem](#15-compatibilidade-e-legado-que-ainda-existem)
16. [Segurança, origem e limites de confiança](#16-segurança-origem-e-limites-de-confiança)
17. [Logs, debug e observabilidade](#17-logs-debug-e-observabilidade)
18. [Testes e CI](#18-testes-e-ci)
19. [Falhas esperadas e diagnóstico](#19-falhas-esperadas-e-diagnóstico)
20. [Regras de manutenção](#20-regras-de-manutenção)
21. [Mudanças documentais da v6.5](#21-mudanças-documentais-da-v65)
22. [Apêndice A — Inventário dos módulos](#apêndice-a--inventário-dos-módulos)
23. [Apêndice B — Matriz IPC](#apêndice-b--matriz-ipc)
24. [Apêndice C — Armazenamento e chaves](#apêndice-c--armazenamento-e-chaves)
25. [Apêndice D — Invariantes arquiteturais](#apêndice-d--invariantes-arquiteturais)
26. [Apêndice E — Conteúdo antigo removido da fonte principal](#apêndice-e--conteúdo-antigo-removido-da-fonte-principal)

---

# 1. Objetivo e regras desta documentação

Esta documentação mantém um modelo autocontido, em vez do tipo "este arquivo atualiza o\ndocumento anterior".

Isso significa:

- o comportamento atual é descrito diretamente;
- versões anteriores aparecem somente quando existe compatibilidade real;
- incidentes já resolvidos não são apresentados como limitações atuais;
- números de versão internos de banco, cache ou fingerprint não são confundidos
  com a versão do produto;
- comentários históricos que não alteram o contrato atual são tratados como
  histórico, não como arquitetura;
- o código em <code>main</code> prevalece sobre qualquer texto antigo.

## 1.1 O que significa "v6.5"

A v6.5 é a versão desta documentação técnica consolidada. Ela descreve o estado arquitetural presente no PR 13 após a refatoração Gemini RPA V2.

O marco v6.5 também torna o versionamento do produto automático: `package.json` contém a versão SemVer canônica, enquanto `manifest.json` e os metadados de teste são sincronizados por `scripts/sync-version.js`.

Ela não altera automaticamente:

- o schema <code>visual-v4</code> do fingerprint;
- o <code>DB_VERSION = 4</code> do banco GTC;
- o <code>SM_DB_VERSION = 1</code> do StorageManager;
- nomes de testes como <code>visual-v3</code>, que identificam famílias de teste;
- formatos de dados já persistidos que precisam continuar legíveis.

Essas versões internas têm ciclo de vida próprio e só devem ser incrementadas
quando o respectivo schema mudar.

---

# 2. Estado documentado na v6.5

## 2.1 Metadados oficiais

| Item | Valor |
|---|---|
| Produto | MangaTranslator |
| Marco desta consolidação | **6.5** |
| Fonte única da versão executável | <code>package.json</code> |
| Versão executável desta consolidação | **6.5** (Manifest) / **6.5.0** (SemVer) |
| Manifest | **Manifest V3** |
| Navegadores alvo | Chromium: Chrome, Edge, Brave, Opera e derivados compatíveis |
| Service Worker | <code>extension/background.js</code> |
| Persistência principal de páginas | IndexedDB <code>manga_translator_data</code> |
| Cache global visual | IndexedDB <code>manga_translator_gtc</code> |
| Automação de tradução | Interface web do Google Gemini |
| Documento canônico | <code>docs/Documentação.md</code> |

## 2.2 Baseline funcional conhecido

O baseline funcional completo mais recente validado antes desta atualização documental é o **GitHub Actions run #551**:

- **94/94 suítes Jest**;
- **693/693 testes Jest**;
- **13/13 testes E2E Playwright**;
- sintaxe JavaScript aprovada;
- Manifest V3 aprovado;
- smoke tests aprovados;
- testes visuais/perceptuais aprovados;
- pipeline sem mascaramento das falhas funcionais.

O marco v6.5 preserva a lógica funcional do pipeline de tradução e adiciona versionamento centralizado, validação de consistência e publicação independente de números hardcoded.

## 2.3 O que não deve mais ser considerado estado atual

Não são limitações atuais:

- o antigo crash por <code>_refreshMaxCon</code> não declarado;
- o baseline antigo com dezenas de testes falhando;
- a antiga espera fixa de 1,5 segundo antes de finalizar um job;
- o registro dinâmico experimental dos scripts do Gemini;
- o fallback de varredura global do storage no STOP_BATCH;
- o alias morto APPLY_RESULT;
- os stubs antigos de registro/desregistro de content scripts.

Esses itens pertencem ao histórico de estabilização da série v5.x.

---

# 3. Topologia do repositório

~~~text
MangaTranslator/
├── .github/
│   └── workflows/
│       └── ci.yml
├── docs/
│   ├── DOCUMENTACAO_v5.1.1_ATUALIZACAO.md   # histórico
│   └── Documentação.md                       # fonte técnica canônica, nome estável
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── background/
│   │   ├── log.js
│   │   ├── router.js
│   │   ├── state.js
│   │   ├── jobs-dom-ack.js
│   │   ├── jobs-lifecycle.js
│   │   ├── jobs-reconciliation.js
│   │   ├── jobs-watchdog.js
│   │   └── actions/
│   │       ├── calculate-visual-fingerprint.js
│   │       ├── check-extraction-tab.js
│   │       ├── deliver-result-from-tab.js
│   │       ├── deliver-result-url.js
│   │       ├── deliver-result.js
│   │       ├── download-chapter.js
│   │       ├── download-image.js
│   │       ├── export-all.js
│   │       ├── fetch-image-base64.js
│   │       ├── force-send-activation.js
│   │       ├── get-tab-id.js
│   │       ├── log-entry.js
│   │       ├── open-existing-folder.js
│   │       ├── open-manga-root.js
│   │       ├── relay-progress.js
│   │       ├── report-error.js
│   │       ├── request-image-data.js
│   │       ├── set-debug-mode.js
│   │       ├── start-batch.js
│   │       └── stop-batch.js
│   ├── cm-auto-restore.js
│   ├── cm-chapter.js
│   ├── cm-dom-replace.js
│   ├── cm-gtc-client.js
│   ├── content_manga.js
│   ├── content_gemini.js
│   ├── gemini/
│   │   ├── selectors.js
│   │   ├── dom.js
│   │   ├── observer.js
│   │   ├── editor.js
│   │   ├── temporary-chat.js
│   │   ├── attachment.js
│   │   ├── result-extractor.js
│   │   ├── deletion.js
│   │   └── job-runner.js
│   ├── gtc-fingerprint.js
│   ├── gtc-indexeddb.js
│   ├── inject.js
│   ├── storage-manager.js
│   ├── shared-ui.js
│   ├── popup.html
│   ├── popup.js
│   ├── options.html
│   ├── options.js
│   ├── reader.html
│   └── reader.js
├── tests/
│   ├── e2e/
│   ├── integration/
│   ├── smoke/
│   ├── unit/
│   ├── visual-v3/
│   ├── run-all-tests.js
│   ├── package.json
│   └── package-lock.json
├── package.json
├── run.ps1
├── run.bat
├── run-smoke.ps1
└── run-smoke.bat
~~~

## 3.1 Divisão por responsabilidade

A extensão possui cinco blocos arquiteturais principais:

1. **orquestração MV3** — background, estado, lifecycle, watchdog e router;
2. **captura e aplicação na página de mangá** — módulos <code>cm-*</code> +
   <code>content_manga.js</code>;
3. **automação do Gemini** — <code>inject.js</code>,
   <code>content_gemini.js</code> e módulos de <code>gemini/</code>;
4. **persistência e cache** — StorageManager + GTC;
5. **interfaces da extensão** — popup, opções, shared-ui e reader.

A arquitetura atual não é mais um único background monolítico, embora
<code>background.js</code> continue sendo o ponto de entrada obrigatório do
Service Worker.

---

# 4. Manifest V3 e modelo de injeção

## 4.1 Permissões

O manifesto declara atualmente:

- <code>tabs</code>;
- <code>scripting</code>;
- <code>storage</code>;
- <code>unlimitedStorage</code>;
- <code>downloads</code>;
- <code>windows</code>;
- <code>alarms</code>.

Também mantém:

- <code>host_permissions: &lt;all_urls&gt;</code>.

O uso de <code>&lt;all_urls&gt;</code> é deliberado porque o MangaTranslator
precisa operar em leitores de mangá hospedados em domínios arbitrários.

## 4.2 Content scripts para páginas de mangá

Em todas as URLs compatíveis, o manifesto injeta nesta ordem:

1. <code>gtc-fingerprint.js</code>;
2. <code>cm-gtc-client.js</code>;
3. <code>cm-dom-replace.js</code>;
4. <code>cm-chapter.js</code>;
5. <code>cm-auto-restore.js</code>;
6. <code>content_manga.js</code>.

Essa ordem é um contrato.

Os módulos <code>cm-*</code> preparam APIs menores e
<code>content_manga.js</code> atua como orquestrador e fachada compatível com
call sites ainda existentes.

## 4.3 Scripts do Gemini

Para:

- <code>https://gemini.google.com/*</code>;
- <code>http://127.0.0.1/*</code>;

o manifesto injeta:

### inject.js

- mundo: **MAIN**;
- momento: **document_start**.

### Worker Gemini no mundo isolado

Em <strong>document_idle</strong>, a ordem é:

1. <code>gemini/selectors.js</code>;
2. <code>gemini/dom.js</code>;
3. <code>gemini/observer.js</code>;
4. <code>gemini/editor.js</code>;
5. <code>gemini/attachment.js</code>;
6. <code>gemini/temporary-chat.js</code>;
7. <code>gemini/result-extractor.js</code>;
8. <code>gemini/deletion.js</code>;
9. <code>gemini/job-runner.js</code>;
10. <code>content_gemini.js</code>.

<code>content_gemini.js</code> é o bootstrap: claim, keep-alive, wiring e
handlers. A execução detalhada do job pertence a <code>job-runner.js</code>.

## 4.4 Por que a injeção é estática

A arquitetura atual **não** usa
<code>chrome.scripting.registerContentScripts()</code> para o Gemini.

A injeção estática foi mantida porque o script MAIN precisa chegar em
<code>document_start</code> de forma determinística. O Service Worker não pode
depender de um registro assíncrono imediatamente antes de abrir uma aba.

A permissão <code>scripting</code> continua útil em outras superfícies. Por
exemplo, o popup usa <code>chrome.scripting.executeScript()</code> no fluxo de
reload forçado da página.

---

# 5. Service Worker e bootstrap modular

## 5.1 Ponto de entrada

O arquivo <code>background.js</code> continua sendo o Service Worker declarado no
manifesto.

Sua função atual é:

- importar módulos obrigatórios;
- conectar dependências;
- expor fachadas necessárias aos testes e aos handlers;
- registrar listeners Chrome;
- encaminhar mensagens para router, GTC e StorageManager;
- inicializar lifecycle, watchdog, reconciliação e ACK de DOM.

## 5.2 Imports obrigatórios

No ambiente real de Service Worker, são importados primeiro:

- router;
- state;
- jobs-watchdog;
- jobs-reconciliation;
- jobs-dom-ack;
- jobs-lifecycle;
- vinte módulos de action.

Depois são importados:

- <code>gtc-fingerprint.js</code>;
- <code>gtc-indexeddb.js</code>;
- <code>storage-manager.js</code>.

## 5.3 Fail-fast

No caminho real do navegador, falha ao importar módulo obrigatório é fatal.

O background:

1. registra erro explícito;
2. relança a exceção;
3. evita continuar num estado parcialmente inicializado.

Isso é intencional.

Uma extensão aparentemente carregada, mas com lifecycle ou storage ausente, é
mais difícil de diagnosticar do que um boot que falha de forma explícita.

## 5.4 Caminho Node/Jest

Quando <code>importScripts</code> não existe e <code>require</code> está
disponível, o arquivo possui um caminho de carregamento voltado aos harnesses de
teste.

Esse caminho não deve ser confundido com o boot real do Chromium.

---

# 6. Estado durável, jobs e recuperação MV3

## 6.1 Dono do estado

O estado de jobs pertence a:

- <code>background/state.js</code>.

O <code>background.js</code> não deve manter um segundo espelho independente
desses dados.

## 6.2 Campos do snapshot principal

O snapshot retornado por <code>state.get()</code> contém:

| Campo | Papel |
|---|---|
| <code>jobQueue</code> | jobs ainda não abertos |
| <code>isProcessing</code> | existe lote em processamento |
| <code>stopRequested</code> | cancelamento solicitado |
| <code>activeMangaTabId</code> | aba de origem do lote |
| <code>currentBatchId</code> | identidade do lote corrente |
| <code>extractionTabs</code> | abas auxiliares de extração |
| <code>totalJobs</code> | total do lote |
| <code>completedJobs</code> | concluídos com sucesso |
| <code>activeJobsCount</code> | slots ocupados |
| <code>jobIndex</code> | índice durável de jobs abertos |

O snapshot é persistido em:

- <code>chrome.storage.local.mt_state</code>.

## 6.3 Semântica de restore

<code>restoreState()</code> aplica o snapshot como patch.

Isso é importante porque nem todo snapshot antigo contém todos os campos que o
runtime atual conhece.

## 6.4 Serialização das gravações

O storage do Chrome não fornece transação entre chamadas independentes.

Por isso <code>state.js</code> mantém uma cadeia de persistência para preservar a
ordem dos snapshots dentro da mesma vida do worker.

## 6.5 Índice durável de jobs

Cada job aberto possui entrada em <code>jobIndex</code> com:

- geminiTabId;
- jobId;
- batchId;
- mangaTabId;
- index.

Esse índice é a fonte principal para reconstruir a contabilidade após suspensão
do Service Worker.

## 6.6 Registro persistido de cada job

O job completo fica em:

- <code>gemini_job_&lt;tabId&gt;</code>.

O registro atual pode conter:

- jobId;
- batchId;
- mangaTabId;
- index;
- prompt;
- geminiTabId;
- windowId;
- executionMode;
- state;
- attempt;
- createdAt;
- updatedAt.

## 6.7 Estados do job

A progressão lógica é:

~~~text
opening
  ↓
running
  ↓
result_received
  ↓
dom_applied
  ↓
finalização / remoção do registro
~~~

Caminhos de erro ou cancelamento não devem incrementar
<code>completedJobs</code> como sucesso.

## 6.8 Reconciliação após suspensão

O módulo <code>jobs-reconciliation.js</code> percorre o índice durável.

Para cada entrada:

- se há marca de finalização pendente, tenta recuperar a contabilidade;
- se a aba Gemini ainda existe, mantém o job ativo;
- se a aba desapareceu, remove resíduos e libera o slot.

Depois:

- <code>jobIndex</code> recebe apenas os jobs vivos;
- <code>activeJobsCount</code> recebe o número de jobs vivos;
- a origem do mangá pode ser recuperada da primeira entrada sobrevivente.

## 6.9 Watchdog

O timeout operacional de job é:

- **4 minutos**.

O watchdog usa:

- alarme <code>watchdog_&lt;jobId-ou-tabId&gt;</code>;
- chave <code>wd_data_&lt;geminiTabId&gt;</code>.

O suporte a nomes antigos baseados em tabId continua existindo como
compatibilidade.

## 6.10 Finalização idempotente

A finalização usa duas proteções:

### Proteção em memória

- set de tabs finalizadas durante a vida atual do worker.

### Proteção durável

- <code>gemini_finalized_&lt;tabId&gt;</code>;
- TTL de 10 minutos;
- alarme <code>finalization_marker_&lt;tabId&gt;</code>.

A marca é escrita antes da contabilidade final.

Se o worker morrer entre essas etapas, a reconciliação consegue completar a
transição sem contar o mesmo job duas vezes.

---

# 7. Fluxo completo de tradução

## 7.1 Fase 1 — descoberta na página

O content script:

1. identifica imagens elegíveis;
2. elimina imagens decorativas/backdrops;
3. normaliza URLs;
4. calcula ou solicita fingerprints;
5. consulta cache local/global;
6. separa hits de cache e misses.

## 7.2 Fase 2 — cache

Para um hit válido:

1. a imagem traduzida é aplicada;
2. o resultado é persistido por capítulo;
3. a entrada de restauração é atualizada;
4. a página pode ser restaurada depois de reload.

## 7.3 Fase 3 — lote

Para misses:

1. <code>content_manga.js</code> envia START_BATCH;
2. o background cria <code>batchId</code>;
3. lê <code>maxConcurrentJobs</code>;
4. popula a fila;
5. abre jobs até o limite de concorrência.

## 7.4 Fase 4 — abertura do Gemini

Para cada job:

1. um jobId é criado;
2. a URL recebe marcadores do MangaTranslator;
3. uma aba ou janela é aberta;
4. o registro <code>gemini_job_*</code> é persistido;
5. a entrada entra no <code>jobIndex</code>;
6. o watchdog é armado.

## 7.5 Modos de execução do Gemini

A UI persiste <code>geminiExecutionMode</code> e o valor é copiado para o registro
durável de cada job. Isso impede que uma mudança de configuração durante um lote
altere o comportamento de jobs que já foram abertos.

### temp_chat

- modo padrão;
- usa conversa temporária/momentânea;
- ao final, a aba é fechada.

### minimized_window

- abre o job em janela minimizada;
- pode focar temporariamente a janela para ações que exigem interação;
- ao final, tenta limpar a conversa antes de remover a janela.

### background_delete

- abre uma aba normal, não focada, em segundo plano;
- não ativa a conversa temporária;
- entrega a imagem e exclui somente a conversa do job antes de liberar o
  fechamento da aba;
- é apropriado quando a conversa temporária não está disponível, mas o histórico
  normal não deve ser preservado.

Os três modos compartilham fila, ownership, entrega e finalização. A diferença
fica restrita ao ciclo de vida do Gemini; não há um segundo pipeline de jobs.

## 7.6 Fase 5 — claim do job

O content script do Gemini não deve executar automação livremente em qualquer
aba do usuário.

Ele precisa associar a aba atual a um job válido.

Sem job válido, a automação não deve entrar no pipeline RPA completo.

## 7.7 Fase 6 — envio

O Gemini content script:

1. obtém a imagem;
2. localiza o editor;
3. injeta o prompt;
4. anexa/cola/arrasta a imagem conforme o caminho disponível;
5. identifica o botão de envio;
6. dispara o envio;
7. confirma que o editor foi consumido ou que a geração começou.

Clique no botão, sozinho, não é prova suficiente de envio.

## 7.8 Fase 7 — captura do resultado

O resultado pode chegar como:

- imagem diretamente extraível;
- URL de imagem;
- resultado vindo de aba auxiliar;
- seleção manual assistida em caso extremo.

No modo <code>background_delete</code>, a prioridade é extrair o resultado na
própria aba autenticada do Gemini, sem criar uma aba auxiliar. Primeiro o script
tenta converter a imagem já renderizada para Data URL via canvas. Se o canvas
for bloqueado por CORS, <code>inject.js</code> realiza o fetch no mundo MAIN com
<code>credentials: 'include'</code> e devolve o Data URL por CustomEvent. Se a
página não puder ler o asset, o Service Worker tenta a mesma URL com a sessão do
Gemini, limitada a assets <code>googleusercontent.com</code> validados.

A cadeia direta é repetida antes de recorrer à compatibilidade histórica da aba
auxiliar. As falhas por etapa registram host, tentativa e classe da falha no log,
sem registrar URL assinada, imagem ou cookies.

A identidade do job deve permanecer associada ao resultado.

## 7.9 Fase 8 — entrega à página de mangá

O background envia:

- <code>UPDATE_IMAGE</code>;
- <code>expectAck: true</code>.

O content script:

1. aplica o resultado no DOM quando possível;
2. persiste o resultado;
3. devolve ACK.

## 7.10 Fase 9 — ACK e finalização

O background não usa mais espera fixa de 1,5 segundo.

O job é liberado quando o ACK confirma o processamento.

Existe apenas um guarda de:

- **30 segundos** para ACK do DOM.

Esse timeout não substitui o watchdog durável.

---

# 8. Roteamento de mensagens e contratos IPC

## 8.1 Router central

O módulo:

- <code>background/router.js</code>

mantém um registry de actions canônicas em kebab-case.

Mensagens públicas existentes continuam usando nomes em SCREAMING_CASE.

O mapa atual é:

| Mensagem pública | Action interna |
|---|---|
| START_BATCH | start-batch |
| STOP_BATCH | stop-batch |
| GEMINI_IMAGE_EXTRACTED | deliver-result |
| GEMINI_RESULT_URL | deliver-result-url |
| IMAGE_READY_FROM_NEW_TAB | deliver-result-from-tab |
| GEMINI_ERROR | report-error |
| FETCH_IMAGE_AS_BASE64 | fetch-image-base64 |
| CALCULATE_VISUAL_FINGERPRINT | calculate-visual-fingerprint |
| DOWNLOAD_IMAGE | download-image |
| DOWNLOAD_CHAPTER_AND_SHOW | download-chapter |
| OPEN_CHAPTER_FOLDER | download-chapter |
| EXPORT_ALL_AND_SHOW | export-all |
| SHOW_EXISTING_FOLDER | open-existing-folder |
| OPEN_MANGA_ROOT | open-manga-root |
| FORCE_SEND_ACTIVATION | force-send-activation |
| SET_DEBUG_MODE | set-debug-mode |
| LOG_ENTRY | log-entry |
| GET_TAB_ID | get-tab-id |
| GEMINI_PROGRESS | relay-progress |
| REQUEST_IMAGE_DATA | request-image-data |
| CHECK_IF_EXTRACTION_TAB | check-extraction-tab |

## 8.2 Namespaces que não passam pelo registry comum

Existem dois namespaces tratados antes do roteamento modular:

- <code>GTC_*</code>;
- <code>SM_*</code>.

Isso é deliberado.

## 8.3 Identificação da origem

O router classifica o sender como:

- gemini;
- content;
- popup;
- external;
- unknown.

Cada action pode definir <code>allowedSources</code>.

Algumas actions continuam propositalmente permissivas por compatibilidade com
emissores existentes. Isso deve ser tratado como contrato atual, não como código
morto.

## 8.4 Compatibilidade de formato de resposta

O background ainda adapta algumas respostas para consumidores antigos que não
esperavam o envelope <code>{ ok: true }</code>.

As mensagens cobertas por essa adaptação incluem:

- GET_TAB_ID;
- CHECK_IF_EXTRACTION_TAB;
- REQUEST_IMAGE_DATA;
- FETCH_IMAGE_AS_BASE64;
- DOWNLOAD_IMAGE.

Isso é compatibilidade ativa e não deve ser removido apenas por parecer antigo.

---

# 9. Persistência de capítulos — StorageManager

## 9.1 Dono do banco

O banco:

- <code>manga_translator_data</code>

pertence à origem da extensão.

O módulo <code>storage-manager.js</code> não deve ser injetado como content
script.

## 9.2 Por que

Content scripts executam associados à origem da página.

Se o StorageManager abrisse IndexedDB diretamente dentro de um site de mangá,
cada domínio ganharia seu próprio banco e popup/background/reader não
enxergariam os mesmos dados.

## 9.3 Schema

Versão atual:

- <code>SM_DB_VERSION = 1</code>.

Object stores:

| Store | keyPath | Índices |
|---|---|---|
| chapters | chapterId | — |
| chapterPages | [chapterId, pageIndex] | by_chapter |
| restoreEntries | [chapterId, cleanUrl] | by_chapter, by_cleanUrl |
| assets | assetId | — |

## 9.4 Unidade de gravação

Cada página é um registro individual.

Isso elimina a antiga corrida em que duas traduções concorrentes:

1. liam o mesmo objeto completo;
2. alteravam entradas diferentes;
3. gravavam o objeto inteiro;
4. uma gravação apagava a alteração da outra.

## 9.5 Asset único

O binário traduzido é mantido uma vez em <code>assets</code>.

Os demais registros referenciam:

- <code>assetId</code>.

## 9.6 Transação de save

<code>savePageResult()</code> grava atomicamente:

- asset;
- registro da página;
- restore entry.

Se a página já possuía outro asset, o asset anterior é removido na mesma
operação quando deixa de ser necessário.

## 9.7 Escritor serializado por capítulo

Existe uma fila por chapterId.

Ela preserva ordem determinística quando múltiplas operações do mesmo capítulo
disputam troca de assets.

## 9.8 chapterList

<code>chapterList</code> continua em <code>chrome.storage.local</code>.

Ele é pequeno e compartilhado por várias interfaces.

## 9.9 Migração de dados antigos

A migração continua ativa e é intencional.

<code>SM_MIGRATE_CHAPTER</code> lê somente as chaves do capítulo alvo.

Não faz varredura global do acervo.

A flag:

- <code>_sm_migrated_&lt;chapterId&gt;</code>

evita repetir migração já concluída.

## 9.10 API SM atual

O background reconhece:

- SM_SAVE_PAGE;
- SM_GET_ASSET;
- SM_GET_PAGE;
- SM_PAGE_INDEX;
- SM_RESTORE_INDEX;
- SM_LIST_RESTORE;
- SM_CHAPTERS_STATS;
- SM_DELETE_CLEAN_URL;
- SM_DELETE_CHAPTER;
- SM_MIGRATE_CHAPTER;
- SM_STATS.

---

# 10. Cache Global de Traduções — GTC

## 10.1 Banco

Nome:

- <code>manga_translator_gtc</code>.

Store principal:

- <code>translations</code>.

Versão interna:

- <code>DB_VERSION = 4</code>.

Essa versão 4 é do schema do cache, não do MangaTranslator.

## 10.2 Evolução interna

### visual-v1

- identidade baseada no fingerprint base.

### visual-v2

- adiciona dHash;
- índice <code>by_dhash</code>.

### visual-v3

- adiciona wHash;
- pHash;
- hashes regionais;
- índices de wHash e pHash.

### visual-v4

- adiciona hashes de crop;
- índices de crop;
- suporte a matching adicional.

## 10.3 Algoritmos principais

<code>gtc-fingerprint.js</code> implementa:

- SHA/fingerprint determinístico;
- dHash;
- wHash por Haar Wavelet;
- pHash por DCT;
- hashes regionais;
- distância de Hamming;
- match perceptual strict;
- match perceptual relaxed.

## 10.4 Consulta correlacionada

A API preferencial é:

- <code>GTC_QUERY_PERCEPTUAL_V2</code>.

Cada query carrega seu próprio:

- queryId;
- wHash;
- pHash;
- width;
- height.

Isso evita produto cruzado entre hashes pertencentes a imagens diferentes.

## 10.5 Compatibilidade de proporção

A consulta correlacionada usa as dimensões da query para verificar
compatibilidade de aspect ratio quando ambas as dimensões estão disponíveis.

A tolerância atual é de aproximadamente 20%.

## 10.6 Evidência contraditória

Quando wHash e pHash existem, um componente muito além do limiar de rejeição
pode invalidar um match aparentemente bom no outro componente.

A consulta correlacionada veta esse caso.

## 10.7 Colisões de índice

Quando um índice não é único, todos os candidatos relevantes precisam ser
avaliados.

A arquitetura atual não deve assumir que o primeiro registro retornado é o
candidato correto.

## 10.8 API GTC exposta

O handler atual reconhece:

- GTC_QUERY_MANY;
- GTC_QUERY_BY_DHASH;
- GTC_QUERY_BY_PERCEPTUAL;
- GTC_QUERY_BY_PERCEPTUAL_CROP;
- GTC_QUERY_BY_PERCEPTUAL_RELAXED;
- GTC_QUERY_PERCEPTUAL_V2;
- GTC_SAVE;
- GTC_SAVE_MANY;
- GTC_DELETE_BY_CLEAN_URL;
- GTC_CLEAR_ALL;
- GTC_STATS;
- GTC_IDB_ERROR.

As três ações perceptuais antigas permanecem por compatibilidade.

Código novo deve preferir a API correlacionada.

---

# 11. Pipeline do content_manga

## 11.1 Composição

A responsabilidade antes concentrada em <code>content_manga.js</code> já possui
módulos auxiliares:

### cm-gtc-client.js

Responsável pela fronteira de cache/fingerprint.

### cm-dom-replace.js

Responsável por:

- URL limpa;
- descoberta de imagem real;
- filtragem de backdrop;
- substituição no DOM.

### cm-chapter.js

Responsável por:

- identificação do capítulo;
- cache temporário de assets;
- persistência de página;
- escrita serializada por capítulo.

### cm-auto-restore.js

Responsável por:

- configuração;
- índice de restore;
- aplicação automática;
- reação a mudanças no storage.

### content_manga.js

Continua responsável por:

- UI do botão;
- seleção;
- orquestração;
- pipeline de extração;
- cache hits;
- lote;
- mensagens;
- compatibilidade com call sites existentes.

## 11.2 Instância ativa

O content script usa guardas globais para evitar múltiplas instâncias ativas
competindo na mesma página.

A instância atual recebe um identificador e listeners verificam se ainda
pertencem à instância ativa.

## 11.3 Filtro de imagens

O pipeline tenta excluir:

- backdrops desfocados;
- clones decorativos;
- imagens ambientais;
- elementos não elegíveis;
- imagens bloqueadas pelo usuário.

### Limites dimensionais configuráveis

Além dos critérios visuais, uma imagem só entra na varredura quando satisfaz a
largura e a altura mínimas configuradas. Os valores padrão são **300 × 400 px**,
preservando o comportamento das instalações existentes.

Os limites são persistidos em `chrome.storage.local` nas chaves
`imageMinWidth` e `imageMinHeight`. O `content_manga.js` os mantém em memória e
reage a mudanças no storage, portanto uma alteração feita no popup passa a
valer para `GET_PAGE_IMAGES` e para a seleção do botão flutuante sem recarregar
a página.

O popup oferece quatro formas sincronizadas de alterar esse filtro:

- campos numéricos para largura e altura;
- slider vertical de altura ao lado da prévia;
- slider horizontal de largura abaixo da prévia;
- representação proporcional atualizada em tempo real.

O botão **Restaurar padrão (300 × 400)** atualiza todos os controles e grava os
valores padrão novamente. Ao fechar os ajustes, o popup consulta a página outra
vez para atualizar a grade de imagens elegíveis.

## 11.4 URL limpa

URLs de CDN podem conter:

- tokens;
- query params;
- hashes;
- parâmetros transitórios.

O clean URL é usado como identidade estável onde apropriado.

## 11.5 Cache antes do Gemini

O Gemini deve ser chamado somente após os estágios de cache aplicáveis.

A ordem geral privilegia hits baratos/exatos antes de fallbacks perceptuais mais
custosos.

## 11.6 Cache hit e persistência

Um cache hit não é apenas uma substituição visual temporária.

Ele precisa alimentar a persistência do capítulo/restore para sobreviver a
reload.

## 11.7 UPDATE_IMAGE

Quando o background entrega uma tradução:

- a imagem pode ser aplicada no DOM;
- a persistência continua válida mesmo se o nó original já não estiver presente;
- o ACK informa se a aplicação no DOM ocorreu.

---

# 12. Automação do Gemini

## 12.1 Princípio e ownership

Uma aba manual do Gemini não vira worker automaticamente. O content script só
executa automação após obter um job por <code>CLAIM_GEMINI_JOB</code> (ou pela
ponte direcionada de compatibilidade que consulta somente a chave da própria
aba).

<code>jobId</code> é identidade lógica e permanece independente de
<code>tabId</code>. Replacement de aba e finalização usam ownership explícito.

## 12.2 Bootstrap e Job Runner

<code>content_gemini.js</code> contém apenas infraestrutura:

- claim;
- keep-alive sob demanda;
- criação/injeção dos controllers;
- handlers de runtime;
- chamada de <code>jobRunner.run(job)</code>.

<code>gemini/job-runner.js</code> coordena, nessa ordem:

1. recovery pendente de deletion;
2. aquisição da imagem da aba do mangá;
3. preparação/validação do editor;
4. Temporary Chat quando aplicável;
5. attachment;
6. prompt;
7. Observer V2 antes do submit;
8. submit com confirmação observável;
9. espera do resultado;
10. extração;
11. entrega/deletion;
12. cleanup.

## 12.3 Conversa temporária

<code>gemini/temporary-chat.js</code> usa somente identificação semântica
(texto, aria-label, test-id, estado e indicadores conhecidos), em português e
inglês.

O antigo fallback baseado em posição na tela foi removido. Se nenhum controle
semântico confiável existir, o módulo retorna <code>unavailable</code>; ele não
clica em um botão apenas por estar numa coordenada provável.

Um clique também não basta para declarar sucesso. Depois do clique, o módulo
aguarda evidência de que o estado ficou ativo e não alterna o controle
repetidamente.

## 12.4 Attachment

<code>gemini/attachment.js</code> preserva paste, file input e drag/drop, mas
separa <em>tentativa</em> de <em>confirmação</em>.

Antes do dispatch é capturado um baseline. O attachment só é confirmado quando
surge evidência nova/alterada de mídia no DOM; alterações cosméticas de classe,
style ou dimensões de um thumbnail antigo não são suficientes.

## 12.5 Editor e submit

<code>gemini/editor.js</code> manipula o editor e o submit, enquanto
<code>gemini/observer.js</code> é a fonte de verdade para confirmação.

O pipeline não considera click, Enter ou CustomEvent como sucesso de envio.
Cada um é apenas uma tentativa. O submit só é confirmado quando o Observer V2
detecta transição observável da UI, como início da geração ou mudança
equivalente pertencente ao job atual.

A segunda tentativa pode solicitar <code>FORCE_SEND_ACTIVATION</code> e elevar
temporariamente o anti-throttling, mas a confirmação continua pertencendo ao
Observer.

## 12.6 Observer V2 e resultado

O Observer V2 é instalado <strong>antes</strong> do submit, com baseline de
imagens já existentes. Ele acompanha mutações e estado da geração e resolve o
resultado apenas quando encontra evidência posterior pertencente à resposta do
modelo.

Erros visíveis da UI produzem <code>GEMINI_UI_ERROR</code>; ausência de
resultado dentro da janela terminal produz <code>GEMINI_RESULT_TIMEOUT</code>.
Não existe mais polling legado independente competindo com o Observer.

## 12.7 Resolução e extração

Quando o resultado usa CDN do Google e o formato permite, a URL é elevada para
<code>=s0</code> antes da extração.

<code>gemini/result-extractor.js</code> preserva os caminhos por modo:

- Data URL: retorno direto;
- Blob URL: fetch local + FileReader;
- <code>background_delete</code>: canvas → bridge MAIN autenticada → Service
  Worker com sessão Gemini;
- demais modos HTTP: fetch do Service Worker compatível com o fluxo anterior.

A cadeia completa pode ser repetida até quatro vezes. Somente depois de esgotar
as rotas diretas o módulo aciona o fallback auxiliar por callback e registra
<code>GEMINI_EXTRACT_DIAGNOSTIC</code> /
<code>GEMINI_AUXILIARY_FALLBACK</code>.

## 12.8 Deletion e recovery

<code>gemini/deletion.js</code> concentra:

- lock idempotente de exclusão;
- localização da conversa pelo chatId atual;
- menu Excluir e confirmação;
- settle dos elementos;
- scroll lock durante recovery;
- persistência de <code>gemini_delete_recovery_&lt;tabId&gt;</code>;
- retomada após reload;
- limpeza do marker e entrega preservada.

No modo debug, erros podem preservar a conversa para diagnóstico.

## 12.9 Assistência manual

O HUD de assistência manual continua disponível quando a heurística automática
não consegue identificar com segurança a imagem correta. A escolha manual é
encaminhada ao mesmo Observer ativo; não cria um pipeline paralelo.

## 12.10 Privacidade de logs

Logs do Gemini são sanitizados. Prompt, signed URL, Data URL/base64, cookies,
tokens e campos equivalentes não devem ser persistidos no log.

---

# 13. Anti-throttling e script MAIN

## 13.1 Papel de inject.js

<code>inject.js</code> roda no mundo MAIN porque precisa atuar no mesmo contexto
JavaScript da página para a ponte de prompt, submit e fetch autenticado.

A guarda de isolamento exige uma aba marcada pelo MangaTranslator; uma aba
manual comum do Gemini não recebe o mecanismo.

## 13.2 Política progressiva

O anti-throttling não simula mais atividade humana aleatória. O antigo
<code>mousemove</code> periódico foi removido.

Existem três níveis internos:

- <code>minimal</code> — padrão; sem foco periódico, rAF/idle em cadência de
  aproximadamente 250 ms;
- <code>balanced</code> — usado em <code>background_delete</code> e
  <code>minimized_window</code>; foco periódico espaçado e rAF/idle em
  aproximadamente 100 ms;
- <code>legacy</code> — escalada temporária da segunda tentativa de submit;
  foco a cada ~1 s e rAF/idle em ~50 ms.

Depois da confirmação ou cleanup, o runner retorna a <code>minimal</code>.

## 13.3 Visibilidade, rAF e idle

Enquanto a aba é um worker válido, o MAIN world mantém a visão de
<code>visibilityState = visible</code>, <code>hidden = false</code> e
<code>hasFocus() = true</code>, além de impedir que blur/pagehide derrubem o
pipeline da página.

<code>requestAnimationFrame</code> e <code>requestIdleCallback</code> possuem
fallbacks próprios para background, mas a cadência segue o nível atual em vez
de acordar permanentemente a cada 50 ms.

## 13.4 Controle pelo runner

O isolated world envia
<code>MANGA_TRANSLATOR_ANTI_THROTTLE_SET_MODE</code> ao MAIN world.

O nível é derivado do modo de execução e só sobe para <code>legacy</code>
durante a escalada de submit. Não há intervalo global de foco de 1 s no
baseline.

## 13.5 Ponte autenticada de imagem

<code>MANGA_TRANSLATOR_FETCH_IMAGE</code> recebe URL + requestId, realiza fetch
no contexto autenticado do Gemini e responde por
<code>MANGA_TRANSLATOR_FETCH_IMAGE_RESULT</code>. O requestId impede mistura de
respostas concorrentes.

---

# 14. Popup, opções, UI compartilhada e Reader

## 14.1 popup.js

O popup concentra:

- seleção de imagens;
- comandos de tradução;
- stop;
- capítulos traduzidos;
- downloads;
- exportação;
- configurações rápidas;
- logs;
- modo debug;
- modo de execução do Gemini, com <code>temp_chat</code>, <code>minimized_window</code> e <code>background_delete</code>;
- filtro de tamanho mínimo de imagem, sincronizado com o content script;
- redimensionamento;
- imagens bloqueadas.

### Organização dos ajustes

As opções de **Substituição automática** incluem a permissão global e a lista
de **Sites habilitados**, porque ambas governam quando uma tradução salva pode
ser reaplicada. O filtro dimensional fica entre **Traduções em Paralelo** e
**Modo Debug**, para separar os parâmetros de processamento dos diagnósticos.

## 14.2 options.js

A página de opções concentra:

- prompt;
- restauração automática;
- sites;
- imagens específicas;
- modo do Gemini, usando a mesma chave <code>geminiExecutionMode</code> do popup;
- limpeza de entradas salvas.

## 14.3 shared-ui.js

Funções compartilhadas incluem:

- normalização de bloqueios;
- leitura combinada de restore;
- escape de HTML;
- remoção de tradução salva;
- chamadas seguras ao runtime.

## 14.4 Reader

O Reader:

- consulta a lista do capítulo;
- dispara migração idempotente;
- lê índice de páginas;
- carrega Data URL sob demanda;
- usa lazy loading;
- descarrega páginas distantes;
- mantém contador por visibilidade e centro do viewport.

## 14.5 Contador do Reader

O contador atual não depende apenas de um callback isolado de
IntersectionObserver.

Ele preserva razões de visibilidade e também pode recalcular pela página cujo
centro está mais próximo do centro da janela.

A atualização por scroll/resize é limitada por requestAnimationFrame.

---

# 15. Compatibilidade e legado que ainda existem

A documentação v6.5 **não** significa remover toda compatibilidade.

A regra é:

> remover somente aquilo que não possui mais produtor, consumidor ou dado real
> a migrar.

## 15.1 Dados antigos de capítulo

Ainda existem fallbacks para:

- <code>&lt;chapterId&gt;_images</code>;
- <code>&lt;chapterId&gt;_restoreMap</code>;
- <code>&lt;chapterId&gt;_restoreMeta</code>.

Eles existem para instalações que ainda não migraram determinado capítulo.

## 15.2 GTC antigo

Ainda existe fallback para entradas GTC antigas em storage local em alguns
caminhos.

Isso permite recuperar cache criado antes da centralização no IndexedDB.

## 15.3 APIs perceptuais antigas

Continuam aceitas:

- GTC_QUERY_BY_PERCEPTUAL;
- GTC_QUERY_BY_PERCEPTUAL_CROP;
- GTC_QUERY_BY_PERCEPTUAL_RELAXED.

Código novo deve usar GTC_QUERY_PERCEPTUAL_V2.

## 15.4 Respostas IPC antigas

Algumas mensagens ainda recebem resposta sem o envelope <code>ok</code> para
não quebrar consumidores existentes.

## 15.5 ACK de content script antigo

O caminho de entrega ainda reconhece o caso de canal fechado associado a
content script antigo como compatibilidade de atualização.

Esse comportamento não deve ser generalizado para outros erros.

## 15.6 Watchdog antigo

O watchdog aceita sufixo por:

- jobId;
- tabId.

O formato atual prefere jobId.

## 15.7 O que já não existe

Não existe mais como arquitetura ativa:

- APPLY_RESULT;
- registro dinâmico de Gemini via registerContentScripts;
- stubs register/unregister de Gemini;
- releaseGeminiScriptsIfIdle;
- evento de ativação de anti-hibernação sem listener;
- fallback global de storage no STOP_BATCH;
- corpos duplicados de lifecycle no background principal.

---

# 16. Segurança, origem e limites de confiança

## 16.1 Ownership do job

Resultado de Gemini não deve ser aceito apenas porque possui formato válido.

A aba remetente deve possuir o jobId correspondente.

A validação é feita por <code>assertJobOwnership()</code>.

## 16.2 batchId

O batchId impede que resultado de lote anterior seja aplicado como se
pertencesse ao lote atual.

Abas auxiliares de extração também carregam jobId e batchId.

## 16.3 Fetch de imagem

FETCH_IMAGE_AS_BASE64 valida condições como:

- remetente;
- resposta HTTP;
- MIME de imagem;
- protocolo/opções aceitas.

## 16.4 HTML variável

Texto variável deve preferir:

- <code>textContent</code>;
- criação explícita de nós DOM.

Uso de <code>innerHTML</code> com conteúdo externo deve ser evitado.

## 16.5 MAIN world

Tudo que roda em MAIN deve ser tratado como superfície sensível.

A guarda de isolamento de <code>inject.js</code> é parte da fronteira de
segurança e estabilidade.

## 16.6 &lt;all_urls&gt;

A permissão ampla é uma decisão funcional atual.

Qualquer tentativa futura de reduzi-la precisa considerar que a extensão foi
projetada para leitores de mangá arbitrários.

---

# 17. Logs, debug e observabilidade

## 17.1 Buffer

O background mantém <code>translatorLog</code> no storage.

O buffer é limitado a aproximadamente:

- **500 entradas**.

## 17.2 Estrutura

Cada entrada pode conter:

- id;
- timestamp;
- level;
- source;
- action;
- detail;
- extra.

Os eventos de áudio usam <code>source: "audio"</code>, separado dos eventos
normais da página (<code>source: "manga"</code>). O campo <code>extra</code>
inclui <code>originTabId</code>, <code>originTabRole: "manga_reader"</code> e
<code>pageHost</code>, permitindo identificar de qual aba leitora veio cada
notificação mesmo com traduções simultâneas.

## 17.3 Níveis

A UI trabalha com níveis como:

- info;
- warn;
- error;
- success.

## 17.4 Debug do Gemini

Logs detalhados do RPA não devem vazar por padrão.

O debug é controlado pela configuração da extensão.

## 17.5 Cópia e exportação

O popup possui fluxo de visualização, filtragem, limpeza, cópia integral e
exportação de logs. O botão <strong>Copiar tudo</strong> copia todas as entradas
do buffer, inclusive as ocultas pelo filtro visual; se a API Clipboard não estiver
disponível, usa a cópia compatível por textarea. Os avisos de fallback de extração
são exibidos em laranja por usarem nível <code>warn</code>.

Os eventos relevantes de diagnóstico são:

- <code>GEMINI_EXTRACT_STAGE</code>: resultado de canvas, fetch da página ou
  Service Worker; inclui host sanitizado, tentativa e classe de falha;
- <code>GEMINI_EXTRACT_RETRY_ALL</code>: início de nova passagem direta;
- <code>GEMINI_EXTRACT_DIAGNOSTIC</code>: esgotamento das passagens diretas;
- <code>GEMINI_AUXILIARY_FALLBACK</code>: uso excepcional da aba auxiliar;
- <code>AUXILIARY_EXTRACT_RETRY</code> e
  <code>AUXILIARY_EXTRACT_FAILED</code>: repetição ou esgotamento dentro da aba
  auxiliar.

## 17.6 Telemetria de áudio

Os eventos relevantes de diagnóstico são:

- <code>AUDIO_CONTEXT_CREATED</code>: foi criado o único <code>AudioContext</code>
  reutilizado pela aba;
- <code>AUDIO_UNLOCKED</code>, <code>AUDIO_UNLOCK_INCOMPLETE</code> e
  <code>AUDIO_UNLOCK_FAILED</code>: resultado da liberação pelo clique do usuário;
- <code>AUDIO_SUCCESS_SCHEDULED</code>: as três notas de conclusão foram aceitas
  pelo navegador; <code>AUDIO_SUCCESS_FINISHED</code> confirma o encerramento da
  última nota;
- <code>AUDIO_SUCCESS_SKIPPED</code>, <code>AUDIO_SUCCESS_FAILED</code> e
  <code>AUDIO_UNAVAILABLE</code>: motivo explícito para o som não ter sido
  reproduzido ou agendado. Esses eventos trazem <code>contextState</code> e, em
  falhas, <code>errorName</code>/<code>errorMessage</code> sanitizados.

---

# 18. Testes e CI

## 18.1 Estrutura

A suíte atual possui:

- testes unitários;
- testes de integração;
- smoke tests;
- testes visuais/perceptuais;
- E2E Playwright.

## 18.2 Baseline

Baseline funcional conhecido:

| Camada | Resultado de referência |
|---|---:|
| Jest | 81/81 suítes |
| Jest | 574/574 testes |
| E2E | 8/8 |
| Sintaxe JS | aprovado |
| Manifest | aprovado |
| Smoke | aprovado |
| Visual/perceptual | aprovado |

## 18.3 Node

O CI executa a camada unit/integration em:

- Node 20;
- Node 22.

## 18.4 Sintaxe

O job de sintaxe percorre recursivamente:

- <code>extension/**/*.js</code>.

Isso impede que arquivos extraídos para subpastas escapem da validação.

## 18.5 Manifest

O CI valida:

- campos obrigatórios;
- manifest_version igual a 3.

## 18.6 Jest é gate real

Falha de Jest não é mascarada por:

- <code>|| true</code>;
- <code>continue-on-error</code> funcional.

## 18.7 E2E

Em <code>main</code>, E2E roda mesmo se uma dependência anterior falhar, para que
o estado do navegador continue visível na mesma pipeline.

A falha do próprio E2E continua sendo falha real.

## 18.8 Cobertura

Cobertura é observabilidade.

Problemas de publicação/serviço de cobertura não devem transformar sozinhos uma
execução funcionalmente correta em regressão do produto.

## 18.9 Concurrency do CI

Execuções superseded da mesma branch/workflow podem ser canceladas.

Isso evita gastar recursos validando commits que já foram substituídos.

---

# 19. Falhas esperadas e diagnóstico

## 19.1 Service Worker não carrega

Verificar primeiro:

1. console da extensão;
2. import obrigatório que falhou;
3. sintaxe de arquivo em <code>extension/</code>;
4. manifesto;
5. erro em inicialização antes do listener.

O worker atual usa fail-fast para dependências obrigatórias.

## 19.2 Lote para depois de algumas imagens

Investigar:

- jobIndex;
- activeJobsCount;
- gemini_job_*;
- wd_data_*;
- alarms watchdog;
- aba Gemini ainda viva;
- ACK UPDATE_IMAGE;
- batchId/jobId.

Não usar apenas variáveis residentes do worker como evidência.

## 19.3 BATCH_COMPLETE cedo demais

Isso indica possível quebra de um destes invariantes:

- índice durável incompleto;
- contabilidade activeJobsCount incorreta;
- job removido do índice antes da finalização;
- reconciliação não executada.

## 19.4 Resultado chegou mas página não mudou

Separar dois casos:

### persistiu, mas não aplicou no DOM

Pode acontecer se:

- usuário navegou;
- lazy-load recriou o nó;
- imagem original saiu do DOM.

O resultado ainda pode reaparecer por restore.

### não persistiu

Investigar:

- SM_SAVE_PAGE;
- IndexedDB;
- ACK;
- erro de Data URL/Blob;
- chapterId/pageIndex.

## 19.5 Cache devolve página errada

Verificar:

- queryId;
- dimensões;
- wHash/pHash;
- modo strict/crop/relaxed;
- evidência contraditória;
- uso indevido das APIs perceptuais antigas.

Código novo não deve reconstruir produto cruzado de listas independentes.

## 19.6 Gemini não envia

Investigar:

- editor desabilitado;
- botão de envio;
- consumo do editor;
- erro role=alert;
- ativação da conversa temporária;
- anexação da imagem;
- modo debug;
- alterações recentes da UI do Gemini.

## 19.7 Reader mostra contador errado

Verificar:

- observer correto;
- estado em <code>pageVisibilityRatios</code>;
- mudança de altura após lazy-load;
- cálculo pelo centro do viewport;
- requestAnimationFrame pendente.

---

# 20. Regras de manutenção

## 20.1 Regra de versão

<code>package.json</code> é a **única fonte manual da versão do produto**.

Ao preparar uma nova versão:

1. alterar somente <code>package.json#version</code> para um SemVer numérico como <code>6.5.0</code> ou <code>6.5.1</code>;
2. executar <code>npm run version:sync</code>;
3. executar <code>npm run version:check</code>.

<code>scripts/sync-version.js</code> deriva e valida:

- <code>extension/manifest.json#version</code>;
- <code>tests/package.json#version</code>;
- <code>tests/package-lock.json#version</code>;
- <code>tests/package-lock.json#packages[""].version</code>.

Para versões cujo patch é zero, a versão Chromium pode omitir o último zero
(<code>6.5.0 → 6.5</code>). Quando existe patch, ele é preservado
(<code>6.5.1 → 6.5.1</code>).

A UI não contém versão fixa: lê <code>chrome.runtime.getManifest().version</code>.
A documentação canônica usa sempre <code>docs/Documentação.md</code>. O workflow
de release cria nomes versionados apenas nos artefatos publicados.

## 20.2 Não alterar versão de schema sem migração

Não incrementar por estética:

- GTC DB_VERSION;
- visual-v4;
- StorageManager DB version.

Essas mudanças exigem alteração real de schema/algoritmo.

## 20.3 Runtime, teste e documentação juntos

Mudança de contrato IPC precisa alterar:

1. produtor;
2. consumidor;
3. testes;
4. documentação.

## 20.4 Não duplicar lifecycle

Toda lógica nova de job deve viver no módulo apropriado.

Evitar reintroduzir corpos duplicados em <code>background.js</code>.

## 20.5 Não varrer storage global sem justificativa

Operações de lote devem preferir:

- jobIndex;
- chaves específicas;
- índices de IndexedDB.

<code>chrome.storage.local.get(null)</code> em runtime deve ser tratado como
exceção e revisado com cuidado.

## 20.6 Não abrir IndexedDB de páginas em content script

O StorageManager pertence à origem da extensão.

## 20.7 Não declarar sucesso só pelo clique no Gemini

O envio precisa de sinal de consumo/progresso.

## 20.8 Não finalizar job antes da persistência

UPDATE_IMAGE + ACK é parte do contrato de durabilidade.

## 20.9 Compatibilidade só com justificativa

Fallback antigo precisa ter:

- dado real a migrar; ou
- produtor/consumidor ainda existente; ou
- cenário de atualização suportado.

Sem isso, deve ser removido junto com testes e documentação.

---

# 21. Mudanças documentais da v6.5

A criação deste documento corrige problemas estruturais da documentação anterior.

## 21.1 Documento deixa de ser patch

Removido o conceito de:

- "este documento atualiza outro";
- capítulos que dependem de contexto não presente;
- instruções para comparar versões antigas antes de entender o estado atual.

## 21.2 Histórico de incidentes foi reduzido

Falhas já encerradas deixaram de ocupar a arquitetura principal.

Exemplos:

- crash strict mode;
- testes antigos falhando;
- tentativas de registro dinâmico;
- regressões específicas de CI já corrigidas.

## 21.3 Compatibilidade foi separada de obsolescência

A documentação antiga misturava:

- código morto;
- fallback ainda necessário;
- formato legado ainda migrável.

Na v6.5 esses conceitos permanecem separados.

## 21.4 Versão do produto foi separada de schema interno

Expressões como:

- visual-v3;
- visual-v4;
- IndexedDB v4;

não são tratadas como versões antigas do produto.

## 21.5 Estrutura modular atual foi incorporada

A documentação agora trata explicitamente:

- background/actions;
- jobs-lifecycle;
- jobs-watchdog;
- jobs-reconciliation;
- jobs-dom-ack;
- módulos cm-*;
- shared-ui.

## 21.6 Labels antigos do código foram normalizados

Rótulos de versão do produto deixaram de ser espalhados como literais pelo
runtime, testes e UI. Quando a versão precisa ser exibida em runtime, ela é
obtida do Manifest; quando precisa ser usada em automação, é derivada de
<code>package.json</code>.

## 21.7 Consolidação Gemini RPA V2 no marco v6.5

A v6.5 incorpora como estado canônico a refatoração concluída na pilha de PRs Gemini RPA V2:

- identidade canônica de abas e `CLAIM_GEMINI_JOB` obrigatório;
- keep-alive somente após claim válido;
- `selectors.js`, `dom.js`, Observer V2 e editor modular;
- submit tratado como tentativa até existir confirmação observável;
- Temporary Chat com verificação de estado e sem fallback posicional inseguro;
- attachment, extração de resultado e deletion/recovery em módulos dedicados;
- `job-runner.js` como orquestrador do pipeline;
- anti-throttling progressivo `minimal` / `balanced` / `legacy`;
- remoção dos adapters, flags e polling legado já sem produtor/consumidor;
- critérios E2E finais para resposta instantânea, submit ignorado, aba manual inerte, `minimized_window` e `background_delete`.

## 21.8 Versionamento sem caminhos hardcoded

O marco v6.5 elimina dependência operacional do número da versão:

- o documento canônico passa a se chamar `docs/Documentação.md`;
- a publicação passa a usar `.github/workflows/publish.yml`;
- pasta, ZIP, documento publicado, título e tag são calculados a partir da versão;
- o CI bloqueia divergência entre package, Manifest e metadados de teste;
- nomes históricos continuam históricos e não participam da descoberta de arquivos.

---

# Apêndice A — Inventário dos módulos

## A.1 Background

### background.js

Bootstrap, wiring, listeners e fachadas.

### background/log.js

API de logging modular.

### background/state.js

Estado central e persistência do snapshot.

### background/router.js

Registry e roteamento das actions modulares.

### background/jobs-dom-ack.js

Entrega UPDATE_IMAGE e espera ACK.

### background/jobs-lifecycle.js

Abertura, execução e finalização de jobs.

### background/jobs-reconciliation.js

Reconstrói contabilidade após suspensão.

### background/jobs-watchdog.js

Timeout persistente por alarm.

## A.2 Actions

### calculate-visual-fingerprint.js

Calcula fingerprint em contexto do background.

### check-extraction-tab.js

Consulta mapeamento de aba auxiliar.

### deliver-result-from-tab.js

Entrega resultado vindo de aba auxiliar.

### deliver-result-url.js

Registra/encaminha URL de resultado.

### deliver-result.js

Entrega resultado direto do Gemini.

### download-chapter.js

Download de capítulo.

### download-image.js

Download unitário.

### export-all.js

Exportação em lote.

### fetch-image-base64.js

Fetch e conversão segura de imagem.

### force-send-activation.js

Ativação/foco para envio quando necessário.

### get-tab-id.js

Informa tabId ao emissor.

### log-entry.js

Entrada remota no buffer de logs.

### open-existing-folder.js

Fluxo de abertura de pasta previamente materializada.

### open-manga-root.js

Abre raiz de downloads do MangaTranslator.

### relay-progress.js

Encaminha progresso à página.

### report-error.js

Entrega erro integrado à origem.

### request-image-data.js

Solicita dados da imagem à aba de mangá.

### set-debug-mode.js

Atualiza modo debug e notifica contextos.

### start-batch.js

Inicia lote.

### stop-batch.js

Cancela lote alvo.

## A.3 Página de mangá

### cm-gtc-client.js

Cliente de cache/fingerprint.

### cm-dom-replace.js

Descoberta e substituição de imagem.

### cm-chapter.js

Persistência e identidade de capítulo.

### cm-auto-restore.js

Restauração automática.

### content_manga.js

Orquestrador e integração com UI/runtime.

## A.4 Gemini

### inject.js

Script MAIN de anti-throttling progressivo e pontes com a página.

### content_gemini.js

Bootstrap leve: claim, keep-alive, wiring e handlers.

### gemini/

Módulos de seletores/DOM, Observer V2, editor, Temporary Chat, attachment,
extração de resultado, deletion/recovery e Job Runner.

## A.5 Persistência

### storage-manager.js

Banco de páginas, restore e assets.

### gtc-fingerprint.js

Algoritmos de fingerprint.

### gtc-indexeddb.js

Repositório e handler do cache global.

## A.6 UI

### popup.js

Interface principal.

### options.js

Configuração completa.

### shared-ui.js

Funções compartilhadas.

### reader.js

Leitor offline/lazy.

---

# Apêndice B — Matriz IPC

## B.1 Persistência

| Ação | Direção típica | Resultado |
|---|---|---|
| SM_SAVE_PAGE | content → background | salva página e asset |
| SM_GET_ASSET | UI/content → background | retorna Data URL do asset |
| SM_GET_PAGE | reader/UI → background | retorna página |
| SM_PAGE_INDEX | reader/UI → background | índice de páginas |
| SM_RESTORE_INDEX | content → background | índice de restore |
| SM_LIST_RESTORE | UI → background | lista restores |
| SM_CHAPTERS_STATS | popup → background | contagens |
| SM_DELETE_CLEAN_URL | UI → background | remove tradução por URL limpa |
| SM_DELETE_CHAPTER | popup → background | remove capítulo |
| SM_MIGRATE_CHAPTER | content/reader → background | migra legado |
| SM_STATS | diagnóstico → background | estatísticas |

## B.2 GTC

| Ação | Papel |
|---|---|
| GTC_QUERY_MANY | lookup exato em lote |
| GTC_QUERY_BY_DHASH | lookup dHash |
| GTC_QUERY_PERCEPTUAL_V2 | lookup correlacionado atual |
| GTC_QUERY_BY_PERCEPTUAL | compatibilidade |
| GTC_QUERY_BY_PERCEPTUAL_CROP | compatibilidade |
| GTC_QUERY_BY_PERCEPTUAL_RELAXED | compatibilidade |
| GTC_SAVE | salva uma entrada |
| GTC_SAVE_MANY | salva lote |
| GTC_DELETE_BY_CLEAN_URL | invalida URL |
| GTC_CLEAR_ALL | limpa cache |
| GTC_STATS | estatísticas |
| GTC_IDB_ERROR | sinalização de erro |

## B.3 Jobs

| Ação | Papel |
|---|---|
| START_BATCH | cria lote |
| STOP_BATCH | cancela lote |
| GEMINI_IMAGE_EXTRACTED | resultado direto |
| GEMINI_RESULT_URL | resultado por URL |
| IMAGE_READY_FROM_NEW_TAB | resultado de aba auxiliar |
| GEMINI_ERROR | erro do RPA |
| GEMINI_PROGRESS | progresso |
| CHECK_IF_EXTRACTION_TAB | consulta identidade de aba auxiliar |
| REQUEST_IMAGE_DATA | solicita imagem |
| FORCE_SEND_ACTIVATION | permite ativação/foco |
| GET_TAB_ID | resolve tabId |

## B.4 Mensagens para a página de mangá

Incluem:

- PROGRESS;
- UPDATE_IMAGE;
- SHOW_ERROR_INTEGRATED;
- BATCH_COMPLETE.

## B.5 Mensagens para Gemini

Incluem:

- DO_SEND_NOW;
- DELETE_CONVERSATION.

---

# Apêndice C — Armazenamento e chaves

## C.1 chrome.storage.local

### Estado

- mt_state;
- gemini_job_&lt;tabId&gt;;
- gemini_finalized_&lt;tabId&gt;;
- wd_data_&lt;geminiTabId&gt;.

### Configuração

- maxConcurrentJobs;
- geminiBaseUrl;
- geminiExecutionMode;
- debugMode;
- customPrompt;
- defaultPrompt;
- autoDownload.

### Capítulos

- chapterList;
- &lt;chapterId&gt;_paths;
- &lt;chapterId&gt;_dlId.

### Migração

- _sm_migrated_&lt;chapterId&gt;;
- &lt;chapterId&gt;_images;
- &lt;chapterId&gt;_restoreMap;
- &lt;chapterId&gt;_restoreMeta.

Os três últimos são legados migráveis.

### Auto restore / bloqueios

- autoRestoreEnabled;
- autoRestoreDisabledSites;
- autoRestoreBlockedImages;
- bannedImages_&lt;host&gt;;
- siteMeta_&lt;host&gt;.

### UI / logs

- translatorLog;
- btnPos;
- popupSize.

### Gemini cleanup

- deleting_urls.

## C.2 IndexedDB de páginas

Banco:

- manga_translator_data.

Stores:

- chapters;
- chapterPages;
- restoreEntries;
- assets.

## C.3 IndexedDB GTC

Banco:

- manga_translator_gtc.

Store:

- translations.

---

# Apêndice D — Invariantes arquiteturais

1. **Um job aberto precisa estar representado no índice durável.**
2. **Um job não pode consumir dois slots após restart.**
3. **Finalização precisa ser idempotente.**
4. **BATCH_COMPLETE não pode ocorrer com job vivo do lote.**
5. **Resultado precisa pertencer ao job da aba remetente.**
6. **batchId precisa sobreviver aos caminhos auxiliares.**
7. **Persistência da página ocorre antes da liberação definitiva do job.**
8. **StorageManager pertence à origem da extensão.**
9. **Cada página é registro próprio; não voltar ao mapa Base64 inteiro.**
10. **Assets são referenciados por assetId.**
11. **GTC correlacionado nunca cruza hashes de queries diferentes.**
12. **Versão do produto não deve alterar versão de schema sem necessidade.**
13. **Gemini manual não deve ser automatizado sem job válido.**
14. **inject.js precisa continuar isolado às abas controladas.**
15. **Falha de módulo obrigatório deve ser visível no boot.**
16. **Compatibilidade antiga só permanece com consumidor/dado justificável.**
17. **Logs detalhados do Gemini não ficam ativos fora de debug.**
18. **CI funcional não pode mascarar Jest/E2E.**
19. **Mudança de contrato exige teste correspondente.**
20. **README deve apontar somente para a documentação canônica atual.**

---

# Apêndice E — Conteúdo antigo removido da fonte principal

A documentação v5.1.1 continha material valioso para rastreabilidade, mas que não
deve mais aparecer como arquitetura vigente.

Foi retirado do caminho principal:

- instrução de copiar arquivos manualmente sobre uma pasta v5.1;
- descrição de falhas de Jest antigas como estado operacional;
- commits individuais como forma principal de explicar arquitetura;
- etapas P0/P1/P2/P3 já concluídas;
- discussão de stubs já removidos;
- referência a APPLY_RESULT;
- discussão de registro dinâmico como opção ainda em aberto;
- relatos de regressões já corrigidas;
- rótulos v4.0/v5.1 usados como identificação atual de arquivos;
- inconsistência de versão entre tests/package.json e tests/package-lock.json.

O histórico antigo pode continuar consultado no arquivo v5.1.1, mas novas
mudanças devem ser documentadas aqui ou em documento posterior que substitua
explicitamente este arquivo como fonte canônica.

---

## Encerramento

Esta documentação consolida a arquitetura modularizada e estabilizada do PR 13 e o marco v6.5:

- Service Worker MV3 com estado durável;
- lifecycle separado;
- watchdog e reconciliação;
- ACK real de aplicação/persistência;
- StorageManager transacional;
- cache visual perceptual;
- automação Gemini isolada por job;
- reader virtualizado;
- UI compartilhada;
- suíte de testes e CI tratados como gates reais.

A regra de manutenção mais importante permanece simples:

> **o código atual, os testes atuais e a documentação atual precisam descrever o
> mesmo contrato.**

