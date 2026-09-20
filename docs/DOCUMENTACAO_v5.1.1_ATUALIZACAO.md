# MangaTranslator v5.1.1 — Atualização da Documentação Técnica

> Este documento atualiza a `DOCUMENTACAO_v5_1.md`. Onde houver conflito, **vale
> o que está aqui**. As seções abaixo substituem as partes correspondentes do
> documento principal (capítulos 5, 7, 10, 11, 12, 13, 14, 15, 18 e 19).

Rodada que fecha os itens P0/P1 do plano de refatoração que ainda estavam
pendentes ou parcialmente implementados.

**Arquivos alterados:** `manifest.json`, `background.js`, `content_manga.js`,
`content_gemini.js`, `storage-manager.js`, `gtc-indexeddb.js`, `popup.js`,
`options.js`, `reader.js`, `tests/package.json`.
**Arquivos novos:** `tests/smoke/` (6 testes + runner).

---

## Índice

1. [Nova arquitetura de persistência](#1-nova-arquitetura-de-persistência)
2. [Handshake de aplicação (fim do delay de 1,5 s)](#2-handshake-de-aplicação)
3. [Ciclo de vida MV3: estado durável e reconciliação](#3-ciclo-de-vida-mv3)
4. [Identidade de lote, validação de remetente e cancelamento](#4-identidade-de-lote)
5. [Injeção sob demanda dos scripts do Gemini](#5-injeção-sob-demanda)
6. [Conversa temporária fail-closed](#6-conversa-temporária-fail-closed)
7. [Cache perceptual: consultas correlacionadas](#7-cache-perceptual)
8. [Memória: leitor, popup e opções](#8-memória)
9. [Referência atualizada de mensagens IPC](#9-referência-ipc)
10. [Referência atualizada de armazenamento](#10-referência-de-armazenamento)
11. [Testes de fumaça](#11-testes-de-fumaça)
12. [Como aplicar e o que observar](#12-como-aplicar)
13. [O que ficou de fora](#13-o-que-ficou-de-fora)

---

## 1. Nova arquitetura de persistência

**Substitui:** capítulo 15 (chrome.storage.local) e a seção de `_persistCacheHit`
do capítulo 10.

### O problema

Cada `UPDATE_IMAGE` executava, no content script:

1. `get` do mapa completo do capítulo;
2. alteração de uma entrada em memória;
3. `set` do mapa inteiro de volta.

Com concorrência maior que 1 — exatamente o que o projeto quer permitir — dois
resultados liam a mesma versão antiga e o último `set` apagava a página do outro.
Atingia simultaneamente `_images`, `_restoreMap`, `_restoreMeta` e `_paths`.

Medido com o código real (`smoke-03`), 10 gravações simultâneas:

| Implementação | Páginas sobreviventes |
|---|---|
| Padrão antigo (mapa inteiro, sem fila) | **1 de 10** |
| Arquitetura nova | **10 de 10** |

### A correção

O **background passou a ser o dono único da persistência**. O content script
entrega o resultado e recebe confirmação; não grava mais nada de página.

```
content_manga.js                 background.js (Service Worker)
      │                                  │
      │  SM_SAVE_PAGE                    │
      │  { chapterId, pageIndex,         │
      │    dataUrl, cleanUrl, meta } ──► │  storage-manager.js
      │                                  │    └─ IndexedDB manga_translator_data
      │                                  │       (1 transação: asset + página + restore)
      │  ◄── { ok, assetId } ────────────│
```

### Por que o `storage-manager.js` NÃO podia ser content script

Este é o motivo de ele estar desconectado desde que foi criado. Content scripts
compartilham a **origem da página**, não a da extensão. Injetado numa página de
mangá, o banco `manga_translator_data` seria criado **por site** e ficaria
invisível para popup, leitor e background — um bug de perda de dados pior que o
original. O módulo agora é carregado por `importScripts('storage-manager.js')`
dentro do Service Worker, onde a origem é `chrome-extension://<id>`.

### Schema do banco `manga_translator_data` (v1)

| Object store | keyPath | Índices | Conteúdo |
|---|---|---|---|
| `chapters` | `chapterId` | — | Metadado mínimo (`updatedAt`) |
| `chapterPages` | `[chapterId, pageIndex]` | `by_chapter` | `assetId`, `originalUrl`, `cleanUrl`, `width`, `height` |
| `restoreEntries` | `[chapterId, cleanUrl]` | `by_chapter`, `by_cleanUrl` | `assetId`, `sourceUrl`, `host`, `index`, dimensões |
| `assets` | `assetId` | — | **Blob** binário, `mimeType`, `size` |

Três consequências diretas:

- **Gravar a página 7 nunca toca a página 3.** Cada página é um registro próprio;
  o padrão ler-mapa-inteiro deixou de existir.
- **Uma cópia binária por resultado.** Antes o mesmo Base64 vivia em `_images`,
  `_restoreMap` e no GTC. Agora `chapterPages` e `restoreEntries` guardam
  referências `assetId` para o mesmo Blob. Regravar uma página remove o asset
  substituído na mesma transação — sem órfãos.
- **Deleção completa.** `deleteChapter` remove páginas, restores e assets juntos.
  O bug em que um capítulo apagado continuava sendo auto-restaurado (porque
  `_restoreMap`/`_restoreMeta` ficavam para trás) acabou.

### `chapterList` continua em `chrome.storage.local`

É metadado pequeno, lido por vários contextos. Movê-lo não traria ganho e
aumentaria a superfície de mudança.

### Migração

`SM_MIGRATE_CHAPTER` é **idempotente e por capítulo** — nada de `get(null)` no
acervo inteiro. Lê só `${chapterId}_images`, `_restoreMap` e `_restoreMeta`,
grava no banco novo e **só então** remove as chaves antigas (é isso que devolve a
cota de `chrome.storage.local`). A flag `_sm_migrated_${chapterId}` impede
repetição.

Ela é disparada naturalmente quando o usuário abre a página do capítulo
(content script) ou o leitor. Popup e opções **não forçam migração em massa**:
eles leem o armazenamento novo e completam com o legado dos capítulos ainda não
visitados, para que nada suma da lista antes da hora.

### Escritor serializado (o que sobrou no content script)

Restaram em `chrome.storage.local` apenas chaves pequenas — `_paths`, `_dlId` —
que ainda usam ler→alterar→gravar. Elas passam por `enqueueChapterWrite()`, uma
fila encadeada por `chapterId` que transforma o ciclo numa seção crítica.

---

## 2. Handshake de aplicação

**Substitui:** a descrição de `finalizeJob` no capítulo 5 e o PASSO 9 do fluxo.

`setTimeout(() => finalizeJob(...), 1500)` foi removido. O ciclo agora é:

```
Gemini entrega o resultado
  → background valida jobId/batchId e marca state = result_received
  → envia UPDATE_IMAGE { expectAck: true } para a aba do mangá
  → content script aplica no DOM e persiste (SM_SAVE_PAGE)
  → content script responde { ok: true, persisted: true }
  → background marca dom_applied, finaliza e libera o slot no instante do ACK
```

Implementado em `deliverResultToManga()` (`background.js`).

- **Nenhum job é contado como concluído antes da persistência confirmar.**
- Com `N` páginas e concorrência `C`, elimina cerca de `1,5 × N / C` segundos de
  ociosidade do caminho crítico.
- Se a imagem não está mais no DOM (usuário navegou, lazy-load trocou o nó), o
  resultado **não se perde**: é persistido mesmo assim e o ACK informa
  `domApplied: false`.
- `chrome.runtime.lastError` com `"message channel closed"` significa content
  script de versão anterior que não devolve ACK → contado como sucesso
  (compatibilidade durante a atualização).
- Guarda de 30 s contra um receptor que aceita e nunca responde. A garantia
  **durável** continua sendo o alarme `watchdog_<jobId>`, que sobrevive à morte
  do Service Worker.

---

## 3. Ciclo de vida MV3

**Substitui:** a seção "Estado Global e Persistência" do capítulo 5.

### Índice durável de jobs

`mt_state.jobIndex` passou a guardar
`{ geminiTabId, jobId, batchId, mangaTabId, index }` para cada job aberto.

### Reconciliação

Antes, ao acordar, o worker fazia `activeJobsCount = 0`. Com abas do Gemini ainda
processando, o lote podia ser declarado concluído cedo demais.

`reconcileJobs()` agora confere cada entrada do índice com `chrome.tabs.get`:

| Situação | Ação |
|---|---|
| Aba viva | Job segue ativo e conta no `activeJobsCount` |
| Aba morta | `gemini_job_*`, `wd_data_*` e alarme removidos; slot liberado |

`ensureInitialized()` roda a reconciliação em **toda** reidratação, não apenas em
`onStartup`. E `processNextJob()` nunca emite `BATCH_COMPLETE` enquanto houver job
registrado no índice para o lote corrente.

### Máquina de estados

Persistida no próprio registro `gemini_job_<tabId>`, via `updateJobState()`:

```
opening → running → result_received → dom_applied → (registro removido)
        ↘ failed / cancelled
```

### Sem varredura do storage

`STOP_BATCH` e o handler do watchdog usavam `chrome.storage.local.get(null)`, que
carregava **todas as imagens Base64 do acervo** para a memória do worker. Ambos
passaram a usar o índice durável; a varredura completa ficou apenas como fallback
para índice vazio (instalação recém-atualizada).

O watchdog também resolve `jobId` (UUID) → `geminiTabId` pelo índice, corrigindo o
`parseInt` que retornava `NaN` para UUID.

### `generateId()`

`crypto.randomUUID()` era chamado direto; onde a API não existe, a exceção matava
o lote. Substituído por `generateId()`, com fallback determinístico.

### Concorrência respeitada no primeiro lote

`_refreshMaxCon()` era assíncrona e disparada sem `await`: o primeiro lote depois
de o worker acordar rodava com concorrência 1 mesmo com 10 configurado. Agora
retorna Promise e `START_BATCH` aguarda antes de despachar.

---

## 4. Identidade de lote

- `assertJobOwnership()`: um resultado só é aceito se a aba remetente for a dona
  daquele `jobId` (registro `gemini_job_<sender.tab.id>`). Mensagens legadas sem
  `jobId` continuam aceitas para compatibilidade.
- **Aba de extração:** `GEMINI_RESULT_URL` agora guarda `jobId`/`batchId` em
  `extractionTabs`, `CHECK_IF_EXTRACTION_TAB` devolve esses campos e o content
  script os reenvia em `IMAGE_READY_FROM_NEW_TAB`. Antes, esse caminho perdia a
  identidade do lote e **escapava inteiro** da validação de batch.
- `STOP_BATCH` cancela somente jobs, alarmes e abas de extração do `batchId`
  alvo. Nunca `chrome.alarms.clearAll()`.

---

## 5. Injeção sob demanda

**Substitui:** a seção "Por que três entradas de content_scripts?" do capítulo 4.

`inject.js` e `content_gemini.js` **saíram do `manifest.json`**. O manifest ficou
com um único content script:

```json
"content_scripts": [
  { "matches": ["<all_urls>"], "js": ["gtc-fingerprint.js", "content_manga.js"] }
]
```

O background registra a automação dinamicamente logo antes de abrir a primeira
aba de um lote e a remove quando o último job termina:

```javascript
chrome.scripting.registerContentScripts([
  { id: 'mt-gemini-inject',  js: ['inject.js'],        world: 'MAIN', runAt: 'document_start', persistAcrossSessions: false, matches: [...] },
  { id: 'mt-gemini-content', js: ['content_gemini.js'],                runAt: 'document_end',   persistAcrossSessions: false, matches: [...] },
]);
```

Fora de uma tradução, o Gemini fica intocado: zero parse, zero observer, zero
anti-hibernação.

Detalhes que importam:

- O registro acontece **antes** de `chrome.tabs.create`, senão `inject.js` perderia
  o `document_start` da aba.
- `persistAcrossSessions: false`, e `onInstalled`/`onStartup` limpam registros
  remanescentes.
- Se o registro falhar, o job falha com mensagem explícita em vez de esperar
  4 minutos até o watchdog.
- `content_gemini.js` ganhou guarda `window.__mt_gemini_started` contra dupla
  execução.
- A porta `gemini-keep-alive` deixou de ser aberta no carregamento do script: só
  é aberta depois que a aba reivindica um job real (`openKeepAlive()`), e fechada
  no caminho "sem job" e no `finally`.
- `inject.js` saiu de `web_accessible_resources` — como content script
  registrado, ele não precisa ser um recurso acessível pela página.

---

## 6. Conversa temporária fail-closed

`findButtonByPosition()` foi **removida** (função e chamada). Qualquer heurística
geométrica pode clicar no controle errado, e o custo de errar aqui é enviar a
página do mangá para uma conversa **permanente** da conta do usuário.

A única fonte aceita agora é semântica: texto, `aria-label`, `title` ou
`data-test-id` reconhecidos por `findTempChatButton()`. Sem sinal semântico →
nenhum upload acontece.

---

## 7. Cache perceptual

**Substitui:** a seção `getManyByPerceptual` do capítulo 7 e as Fases 4/5-B/5-C do
capítulo 10.

### Três defeitos corrigidos

**1. Produto cruzado entre páginas.** A API recebia duas listas independentes
(`wHashes`, `pHashes`) e combinava todas com todas: o `wHash` da página A podia
casar com o `pHash` da página B. Reproduzido em `smoke-05`.

**2. Um hit cegava o lote.** A varredura aproximada só rodava se **nenhuma** query
tivesse hit exato — um acerto em A impedia a busca aproximada necessária para B.

**3. `index.get()` em índice não-único.** Devolvia um candidato arbitrário quando
havia colisão de hash.

### O contrato novo

```javascript
{
  action: 'GTC_QUERY_PERCEPTUAL_V2',
  mode: 'strict' | 'crop' | 'relaxed',
  queries: [ { queryId, wHash, pHash, width, height }, ... ]
}
// resposta: { ok, entriesByQueryId: { [queryId]: { translatedDataUrl, confidence, reason, wDist, pDist, regionalHashes } } }
```

Cada consulta carrega o **seu** par de hashes e as **suas** dimensões; o resultado
vem indexado por `queryId`, nunca por hash isolado. No `content_manga.js`,
`queryId` é o índice da imagem no DOM.

Além disso:

- `getAll()` no lugar de `index.get()` — todos os candidatos de uma colisão são
  avaliados e o melhor é escolhido após validação completa.
- Fase 2 (varredura com Hamming) roda **só para as queries sem hit**, não para o
  lote inteiro.
- Compatibilidade de proporção obrigatória (`_isAspectCompatible`, tolerância de
  20%), agora com as dimensões reais da consulta — antes era chamada com
  `undefined` e sempre retornava `true`.

### Veto de evidência contraditória

A regra combinada (`(wDist≤40 OU pDist≤35) E NÃO (wDist>80 E pDist>70)`) aceitava
o match quando **um** hash batia, mesmo com o outro além do próprio limite de
rejeição. Como os dois hashes vêm da **mesma imagem**, um deles estar em outro
universo indica colisão, não semelhança.

Nas consultas correlacionadas isso passou a ser vetado
(`_hasContradictoryEvidence`). Para um par legítimo de scanlações da mesma página
(`wDist ≈ 20–40`, `pDist ≈ 20–35`) nada muda — o veto só dispara em contradição.

`matchPerceptualHashes()` em si **não foi alterada**: as 224 asserções da suíte
perceptual continuam valendo.

### Confirmação regional

`confirmWithRegionalHashes()` retornava `true` quando não havia dados para
confirmar. Ausência de evidência não é confirmação: agora retorna `false`.

### O que ficou como código morto

`queryGlobalTranslationCacheByPerceptual`, `...Crop` e `...Relaxed`, junto com as
actions `GTC_QUERY_BY_PERCEPTUAL`, `_CROP` e `_RELAXED`, seguem no código apenas
para não quebrar integrações e testes que ainda as chamem. O pipeline não as usa
mais.

---

## 8. Memória

**Substitui:** capítulo 13 (leitor) e as partes de carregamento do capítulo 11.

### Leitor

- Busca o **índice de páginas** (`SM_PAGE_INDEX`) — metadados, sem Base64 — e
  pede cada página (`SM_GET_PAGE`) quando ela entra na janela de pré-carregamento.
- `UNLOAD_MARGIN` existia mas nunca era usada. Agora um segundo
  `IntersectionObserver` libera o `src` de páginas a mais de 5 viewports,
  congelando a altura em `minHeight` para o scroll não saltar.
- Resultado: o consumo passou a depender da janela visível, não do tamanho do
  capítulo.

### Auto-restore

`_activeRestoreMap` guardava `cleanUrl → Base64`. Agora guarda
`cleanUrl → { assetId, index }`, vindo de `SM_RESTORE_INDEX`. O Base64 de uma
página só entra na memória quando aquela imagem específica aparece no DOM
(`resolveRestoreAsset`, com cache LRU de 12 entradas).

`applyAutoRestore()` virou assíncrona: primeiro descobre quais imagens casam,
depois busca o binário de cada uma. Uma página com 200 imagens não carrega 200
Base64 para restaurar 3.

**Ganho de comportamento:** cache hits agora também criam entrada de restauração
(antes só gravavam a página). Depois de um F5, uma página vinda do cache volta
sozinha.

### Popup e opções

- A lista de capítulos não carrega mais `${chap.id}_images` de todo o acervo só
  para exibir "N pág." — a contagem vem de `SM_CHAPTERS_STATS`.
- "Sites habilitados / Imagens específicas" usa `SM_LIST_RESTORE` (metadados).
- O preview de cada imagem tenta a URL remota original e só busca o binário
  gravado (`SM_GET_ASSET`) se a remota falhar.
- Exportação e "abrir pasta" materializam os Base64 **sob demanda**, capítulo por
  capítulo, e só quando há download de verdade a fazer.
- Apagar capítulo chama `SM_DELETE_CHAPTER` e limpa os resíduos legados.
- "Refazer" chama `SM_DELETE_CLEAN_URL` + `GTC_DELETE_BY_CLEAN_URL` e purga o
  legado.

---

## 9. Referência IPC

### Novas: content script / popup / opções / leitor → background (persistência)

| Ação | Payload | Resposta |
|---|---|---|
| `SM_SAVE_PAGE` | `{chapterId, pageIndex, dataUrl, originalUrl, cleanUrl, meta:{host,width,height,sourceUrl}}` | `{ok, assetId, chapterId, pageIndex}` |
| `SM_GET_PAGE` | `{chapterId, pageIndex}` | `{ok, dataUrl}` |
| `SM_GET_ASSET` | `{assetId}` | `{ok, dataUrl}` |
| `SM_PAGE_INDEX` | `{chapterId}` | `{ok, pages:[{pageIndex, assetId, width, height, updatedAt}]}` |
| `SM_RESTORE_INDEX` | `{chapterId}` | `{ok, entries:{[cleanUrl]:{assetId,index}}}` |
| `SM_LIST_RESTORE` | `{chapterIds?}` | `{ok, entries:[{chapterId, cleanUrl, assetId, sourceUrl, host, index, width, height, updatedAt}]}` |
| `SM_CHAPTERS_STATS` | `{chapterIds:[]}` | `{ok, stats:{[chapterId]:{pageCount, indices}}}` |
| `SM_DELETE_CLEAN_URL` | `{cleanUrl}` | `{ok, deleted}` |
| `SM_DELETE_CHAPTER` | `{chapterId}` | `{ok, deleted, assets}` |
| `SM_MIGRATE_CHAPTER` | `{chapterId}` | `{ok, migrated, skipped}` |
| `SM_STATS` | — | `{ok, stats:{pages, assets, bytes}}` |

### Nova: cache perceptual

| Ação | Payload | Resposta |
|---|---|---|
| `GTC_QUERY_PERCEPTUAL_V2` | `{queries:[{queryId,wHash,pHash,width,height}], mode}` | `{ok, entriesByQueryId}` |

### Alteradas

| Ação | Mudança |
|---|---|
| `UPDATE_IMAGE` | Ganhou `expectAck: true`. O content script **responde** `{ok, persisted, domApplied}` após persistir. O background aguarda esse ACK em vez de esperar 1,5 s. |
| `GEMINI_RESULT_URL` | Passa `jobId` e `batchId`, guardados em `extractionTabs`. |
| `CHECK_IF_EXTRACTION_TAB` | Resposta inclui `jobId` e `batchId`. |
| `IMAGE_READY_FROM_NEW_TAB` | Envia `jobId`/`batchId`; o background completa pelo mapeamento se faltarem. |
| `GEMINI_IMAGE_EXTRACTED` | Validado por `assertJobOwnership` (aba remetente precisa ser dona do job). |
| `START_BATCH` | Responde `{ok, batchId}` e aguarda a leitura de `maxConcurrentJobs`. |
| `BATCH_COMPLETE` | Carrega `batchId`; só é emitido com o índice de jobs vazio. |

### Depreciadas (mantidas por compatibilidade)

`GTC_QUERY_BY_PERCEPTUAL`, `GTC_QUERY_BY_PERCEPTUAL_CROP`,
`GTC_QUERY_BY_PERCEPTUAL_RELAXED`.

---

## 10. Referência de armazenamento

### IndexedDB `manga_translator_data` (v1) — NOVO

Dono: background. Ver o schema na seção 1.

### IndexedDB `manga_translator_gtc` (v4) — inalterado

Cache global de traduções por fingerprint visual.

### `chrome.storage.local`

| Chave | Situação |
|---|---|
| `mt_state` | **Alterada** — ganhou `jobIndex` |
| `gemini_job_<tabId>` | **Alterada** — `state` transita pela máquina de estados |
| `chapterList` | Mantida |
| `${chapterId}_paths`, `${chapterId}_dlId` | Mantidas |
| `${chapterId}_images` | **Legada** — migrada para IndexedDB e removida |
| `${chapterId}_restoreMap` | **Legada** — idem |
| `${chapterId}_restoreMeta` | **Legada** — idem |
| `_sm_migrated_${chapterId}` | **Nova** — flag de migração idempotente |
| `autoRestoreEnabled`, `autoRestoreDisabledSites`, `autoRestoreBlockedImages` | Mantidas |
| `bannedImages_<host>`, `siteMeta_<host>`, `translatorLog`, `btnPos`, `popupSize` | Mantidas |

---

## 11. Testes de fumaça

`tests/smoke/` — sem Jest, sem servidor, sem navegador. Carregam o código **real**
de `extension/` num mock mínimo do Chrome (+ `fake-indexeddb` onde há IndexedDB).

```
node tests/smoke/run-smoke.js
```

| Arquivo | Cobre |
|---|---|
| `smoke-01-batch-lifecycle.js` | Limite de concorrência, ACK sem atraso fixo, índice durável, rejeição de remetente estranho, `STOP_BATCH` isolado |
| `smoke-02-uuid-and-reconcile.js` | Fallback de `crypto.randomUUID`; reconciliação descartando jobs de abas mortas |
| `smoke-03-chapter-persistence.js` | 10 gravações concorrentes pelo caminho real do content script; mapa de restauração por `assetId`; cache hit gerando restore |
| `smoke-04-storage-manager.js` | Transações atômicas, round-trip Blob↔DataURL, assets órfãos, `deleteByCleanUrl`, `deleteChapter`, migração idempotente |
| `smoke-05-perceptual-queries.js` | Produto cruzado rejeitado, hit exato não cega a busca aproximada, proporção, colisão de índice, handler V2 |
| `smoke-06-sm-message-routing.js` | Roteamento `SM_*` pelo listener real + regressão de mensagens não-SM |

Resultado atual: **6 arquivos, todos passando**.

---

## 12. Como aplicar

1. Copiar os arquivos de `extension/` sobre `MangaTranslator_v5.1\extension\`.
2. Copiar `tests/package.json` e a pasta `tests/smoke/`.
3. Em `tests/`, garantir `fake-indexeddb` instalado (`npm install`).
4. Em `chrome://extensions`, clicar em **Atualizar** na extensão.
5. Rodar `node tests/smoke/run-smoke.js`.

### O que observar na primeira execução

- Ao abrir um capítulo já traduzido, aparece no log
  `SM_MIGRATED — Capítulo migrado para o novo armazenamento: N página(s)`.
  É a migração idempotente. As chaves antigas somem e a cota de
  `chrome.storage.local` é devolvida.
- Durante um lote, o log traz `GEMINI_SCRIPTS_ON` no início e
  `GEMINI_SCRIPTS_OFF` no fim — a automação do Gemini existindo só enquanto é
  necessária.
- `GTC_F4_ENTRY` agora informa `imgIdx` em vez de prefixo de hash: cada candidato
  pertence a uma imagem específica.

### Impacto na suíte Jest existente

Os testes atuais não conhecem o protocolo novo. Ajustes esperados:

- `UPDATE_IMAGE` carrega `expectAck: true` e a resposta é aguardada — testes que
  avançam timers fixos precisam simular o ACK (`sendResponse({ ok: true })`) no
  mock da aba do mangá;
- a persistência de página não escreve mais `${chapterId}_images` diretamente;
  o mock precisa responder a `SM_SAVE_PAGE`;
- `mt_state` ganhou `jobIndex`;
- `START_BATCH` responde `{ok, batchId}` e `BATCH_COMPLETE` carrega `batchId`;
- as fases 4/5-B/5-C emitem `GTC_QUERY_PERCEPTUAL_V2`.

Os testes de fumaça cobrem esses caminhos sem depender do Jest.

---

## 13. O que ficou de fora

**LSH / buckets no cache perceptual.** A varredura da fase 2 continua `O(n)` sobre
o banco do GTC. Com as consultas correlacionadas o custo caiu (só as queries sem
hit percorrem o cursor, e cada entrada é comparada contra um par por query em vez
do produto cruzado), mas acervos com milhares de páginas ainda vão querer
indexação por bucket. É otimização, não correção.

**Transporte por Blob entre contextos.** As mensagens ainda carregam Data URL
entre content script e background. O binário já é **armazenado** como Blob; o que
falta é a passagem por referência nas mensagens, que exige um spike de
compatibilidade de serialização entre contextos.

**Política de qualidade de imagem** (limite de megapixels, WebP/JPEG por modo).
O formato original já é preservado em vez de reencodar tudo como PNG; a política
configurável fica para uma rodada própria.
