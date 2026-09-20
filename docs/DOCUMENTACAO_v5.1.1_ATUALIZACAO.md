# MangaTranslator v5.1.1 — Atualização da Documentação Técnica

> Este documento atualiza a `DOCUMENTACAO_v5_1.md`. Onde houver conflito, **vale
> o que está aqui**. As seções abaixo substituem as partes correspondentes do
> documento principal (capítulos 5, 7, 10, 11, 12, 13, 14, 15, 18 e 19).

Rodada que fecha os itens P0/P1 do plano de refatoração que ainda estavam
pendentes ou parcialmente implementados.

> **Estado consolidado em 20/09/2026:** esta documentação foi revisada após a
> estabilização completa do Service Worker, dos testes Jest, dos E2E e da
> pipeline de CI. O baseline funcional validado imediatamente antes desta
> atualização documental é o commit `ec3a9a49d8d7`, com **81/81 suítes Jest,
> 574/574 testes Jest e 8/8 testes E2E Playwright aprovados**. Trechos históricos
> que descreviam falhas toleradas foram preservados apenas quando úteis para
> rastreabilidade e marcados como superados.

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
5. [Injeção dos scripts do Gemini: Resolução Arquitetural (Estático vs Dinâmico)](#5-injeção-dos-scripts-do-gemini-resolução-arquitetural-estático-vs-dinâmico)
6. [Conversa temporária: detecção nativa e compatibilidade](#6-conversa-temporária-detecção-nativa-e-compatibilidade)
7. [Cache perceptual: consultas correlacionadas](#7-cache-perceptual)
8. [Memória: leitor, popup e opções](#8-memória)
9. [Referência atualizada de mensagens IPC](#9-referência-ipc)
10. [Referência atualizada de armazenamento](#10-referência-de-armazenamento)
11. [Estratégia de testes, baseline atual e CI](#11-estratégia-de-testes-baseline-atual-e-ci)
12. [Como aplicar e o que observar](#12-como-aplicar)
13. [O que ficou de fora](#13-o-que-ficou-de-fora)
14. [Histórico de estabilização da pipeline de CI e testes E2E](#14-histórico-de-estabilização-da-pipeline-de-ci-e-testes-e2e)
15. [Rodada de limpeza P2/P3: innerHTML, aliases e fallbacks mortos](#15-rodada-de-limpeza-p2p3)
16. [Verificação da sessão interrompida: lifecycle legado, suite completa e privacidade de logs](#16-verificação-da-sessão-interrompida-lifecycle-legado-suite-completa-e-privacidade-de-logs)
17. [Auditoria Geral do Plano Original vs GitHub: Status e Refinamentos Concluídos](#17-auditoria-geral-do-plano-original-vs-github-status-e-refinamentos-concluídos)
18. [Estabilização final pós-refatoração: runtime, testes e CI](#18-estabilização-final-pós-refatoração-runtime-testes-e-ci)

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
passaram a usar o índice durável. O fallback de varredura completa por
`chrome.storage.local.get(null)` no `STOP_BATCH` foi posteriormente removido
após a auditoria comprovar que todo registro `gemini_job_*` é acompanhado por
`indexAddJob()` e que a reconciliação MV3 já trata `jobIndex` como fonte de
verdade durável.

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
  daquele `jobId` (registro `gemini_job_<sender.tab.id>`). O contrato atual é
  **estrito**: ausência de `jobId` ou de `sender.tab.id` resulta em
  `owns:false`; não existe bypass legado para mensagens sem identidade.
- **Aba de extração:** `GEMINI_RESULT_URL` agora guarda `jobId`/`batchId` em
  `extractionTabs`, `CHECK_IF_EXTRACTION_TAB` devolve esses campos e o content
  script os reenvia em `IMAGE_READY_FROM_NEW_TAB`. Antes, esse caminho perdia a
  identidade do lote e **escapava inteiro** da validação de batch.
- `STOP_BATCH` cancela somente jobs, alarmes e abas de extração do `batchId`
  alvo. Nunca `chrome.alarms.clearAll()`.

---

## 5. Injeção dos scripts do Gemini: Resolução Arquitetural (Estático vs Dinâmico)

> **Resolução de Incerteza (INCERTO — registro dinâmico de content scripts / BG-F24):**
> Havia uma proposta inicial de registrar `inject.js` e `content_gemini.js` dinamicamente via `chrome.scripting.registerContentScripts()`. A decisão técnica consolidada e deliberada de produção é: **os scripts permanecem declarados estaticamente no `manifest.json`**. As funções em `background.js` são stubs no-ops intencionais.

### Por que o registro dinâmico foi descartado (Rollback Intencional)

1. **Condição de Corrida Crítica no `document_start` (`MAIN` world):**
   No Chromium Manifest V3, chamadas a `chrome.scripting.registerContentScripts()` são assíncronas no processo do browser. Ao abrir uma nova aba para traduzir uma página (`chrome.tabs.create`), ocorria uma corrida de inicialização: o renderer da aba começava a carregar a página do Gemini antes que as regras dinâmicas de injeção fossem sincronizadas. Como consequência, o `inject.js` frequentemente perdia o gatilho `document_start` no mundo `MAIN`, falhando em conectar interceptadores essenciais de UI antes do boot dos scripts internos do Google Gemini.

2. **Garantia Nativa do Navegador:**
   Com a declaração estática no `manifest.json` (`matches: ["https://gemini.google.com/*", "http://127.0.0.1/*"]`), o próprio motor Chromium garante determinismo absoluto: `inject.js` é injetado imediatamente no `document_start` do `MAIN` world, e `content_gemini.js` roda no `document_idle`.

3. **Inércia Garantida em Abas Não Relacionadas:**
   A preocupação original de "não interferir no Gemini fora de uma tradução" foi resolvida no nível do próprio content script:
   - `content_gemini.js` possui a guarda `window.__mt_gemini_started` e contacta o background via mensagem `CLAIM_JOB`.
   - Se o usuário abre o Gemini para uso manual pessoal, o background não possui job registrado para aquela aba (`claim` retorna nulo). O `content_gemini.js` encerra sua execução de imediato, sem abrir porta `keep-alive`, sem registrar `MutationObserver` e sem tocar no DOM.

### Estado atual do bootstrap em `background.js`

A decisão arquitetural continua a mesma: a injeção no Gemini é **estática pelo
`manifest.json`**. O que mudou depois da primeira rodada foi apenas a limpeza do
bootstrap.

Os antigos stubs `scriptingAvailable`, `registerGeminiScripts`,
`unregisterGeminiScripts` e `releaseGeminiScriptsIfIdle` foram removidos após
a auditoria comprovar que não havia mais chamadores funcionais que dependessem
deles. Portanto, o estado atual é mais simples:

- `manifest.json` continua sendo a única fonte de registro dos content scripts
  do Gemini;
- `background.js` não tenta registrar ou remover scripts dinamicamente;
- `content_gemini.js` continua inerte em abas sem job válido, por meio de
  `CLAIM_JOB`/ownership;
- não existe mais camada de compatibilidade baseada em stubs de
  `chrome.scripting`.

> **Diretriz de manutenção:** não reintroduzir registro dinâmico nem stubs de
> scripting sem uma necessidade funcional nova e um teste E2E que cubra a
> injeção no `document_start`.


---

## 6. Conversa temporária: detecção nativa e compatibilidade

A automação de conversa temporária evoluiu desde a primeira versão desta
documentação. A descrição anterior de comportamento estritamente
*fail-closed* não representa mais o código atual.

O fluxo atual usa duas camadas para localizar o controle:

1. `findTempChatButton()` — busca semântica por texto, `aria-label`,
   `title` e atributos conhecidos;
2. `findButtonByPosition()` — fallback de compatibilidade para mudanças da UI
   do Gemini quando o seletor semântico não encontra o controle.

A correção mais recente foi reforçar `isAlreadyActive()` para reconhecer a UI
nativa atual do Gemini sem clicar novamente quando a conversa temporária já está
ativa. São reconhecidos:

- controles de fechar com `aria-label` contendo `fechar/close` e termos de
  conversa `temporária/momentânea`;
- a tela em português com **"só dando uma passadinha"** combinada ao aviso de que
  a conversa não aparece nas conversas recentes;
- banners em português informando que conversas temporárias/momentâneas não
  aparecem no histórico;
- a tela equivalente em inglês, **"just passing through"** + aviso de
  `temporary chats`.

`ensureTemporaryChatActive(12)` tenta localizar/confirmar o modo por até
12 segundos e retorna `{ success:false, notFound:true }` quando não consegue.
O modo de execução e o restante do fluxo decidem como tratar esse resultado.

> **Nota de manutenção:** como existe fallback posicional, alterações futuras na
> UI do Gemini devem ser cobertas por testes de detecção/ativação antes de ampliar
> heurísticas geométricas. O objetivo é privilegiar sinais semânticos e evitar
> cliques em controles não relacionados.


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

## 11. Estratégia de testes, baseline atual e CI

> **Estado atual:** o antigo baseline de falhas toleradas foi eliminado. A suíte
> Jest foi alinhada aos contratos v5.1 e passou a ser novamente **bloqueante** na
> pipeline. O CI não usa mais `npm run test:ci || true` nem
> `continue-on-error` no job de unit/integration.

### Pirâmide de Testes e Fontes da Verdade

| Nível | Suíte / Comando | Estado validado | Papel e Cobertura |
|---|---|:---:|---|
| **Jest unitário + integração** | `npm run test:ci` | **81/81 suítes, 574/574 testes ✅** | Contratos de background, lifecycle, roteamento, Gemini RPA, manga, reader, cache, storage e integrações. |
| **E2E (Ponta a Ponta)** | `npm run test:e2e` (Playwright) | **8/8 ✅, sem flaky no baseline final** | Chromium real, Service Worker MV3 real, IPC, persistência IndexedDB, cache, auto-restore, bulk translation e leitor offline. |
| **Testes de Fumaça** | `npm run test:smoke` | **100% ✅** | Concorrência, persistência atômica, lifecycle e roteamento `SM_*`. |
| **Testes Visuais** | `npm run test:visual-v3` | **100% ✅** | Fingerprints perceptuais e consultas correlacionadas. |
| **Sintaxe JS** | job `JS Syntax Check` | **100% ✅** | Usa `find extension -name "*.js"` e inclui arquivos aninhados de `background/`, evitando que módulos novos escapem da validação. |
| **Manifesto** | job `Manifest Validation` | **100% ✅** | Validação do `manifest.json` MV3. |
| **Cobertura** | `npm run test:coverage` | **job aprovado no baseline final** | Relatório de cobertura e artefato HTML. Continua deliberadamente não bloqueante (`continue-on-error` / `|| true`) para não transformar indisponibilidade do upload/relatório em falha funcional. |

### Regras atuais da pipeline

1. **Jest bloqueia regressão.** O job `unit-and-integration` roda em Node 20 e
   Node 22 e falha se `npm run test:ci` falhar.
2. **E2E não é mascarado.** Em `main`, o job Playwright usa
   `if: always() && github.ref == 'refs/heads/main'`, portanto ainda roda quando
   o job anterior falha e sua própria falha aparece como falha real.
3. **Execuções obsoletas são canceladas.** O grupo de `concurrency` usa branch +
   workflow e `cancel-in-progress: true`, evitando várias pipelines completas
   concorrendo após commits sequenciais.
4. **Sintaxe é recursiva.** Módulos extraídos para `extension/background/**`
   são verificados, não apenas os `*.js` da raiz de `extension/`.
5. **Cobertura é observabilidade, não gate funcional.** O gate funcional é
   formado por sintaxe, manifesto, smoke/visual, Jest e E2E.

### Regressão específica de carregamento do Service Worker

Foi adicionado
`tests/unit/background/background-strict-load.test.js`. O teste executa
`background.js` em um processo Node limpo, com mocks mínimos de Chrome, para
capturar erros que poderiam ser escondidos por globais vazadas entre suítes.

Esse teste nasceu após a regressão em que uma atribuição a `_refreshMaxCon`
sem declaração derrubava o Service Worker inteiro em modo `'use strict'`.


---

## 12. Como aplicar e o que observar

1. Copiar os arquivos de `extension/` sobre `MangaTranslator_v5.1\extension\`.
2. Copiar `tests/package.json` e a pasta `tests/smoke/`.
3. Em `tests/`, garantir dependências instaladas (`npm install`).
4. Em `chrome://extensions`, clicar em **Atualizar** na extensão.
5. Rodar `node tests/smoke/run-smoke.js` e `npm run test:e2e`.

### O que observar na execução

- Ao abrir um capítulo já traduzido, o log emite `SM_MIGRATED — Capítulo migrado para o novo armazenamento: N página(s)`. As chaves antigas de imagens são expurgadas do `chrome.storage.local`.
- Durante um lote, abas abertas pelo MangaTranslator processam jobs e fecham ao concluir; abas do Gemini abertas pelo usuário permanecem inertes.
- No leitor offline, páginas fora do viewport inicial carregam sob demanda conforme a rolagem.

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

---

## 14. Histórico de estabilização da pipeline de CI e testes E2E

Para garantir que a esteira de integração contínua (GitHub Actions) ficasse 100% verde com execução confiável e rápida, as seguintes correções de infraestrutura e alinhamento de testes foram implementadas:

### 1. Suporte a Lazy Loading no Leitor Offline (`reader-offline.spec.js`)
- **Problema:** O leitor (`reader.js`) implementa `IntersectionObserver` com margem de pré-carregamento (`PRELOAD_MARGIN = '200%'`). Páginas distantes do topo (como a 15ª página, `idx-200`) iniciam com `src=""`. O teste antigo tentava ler o `src` de todas as imagens instantaneamente via `evaluateAll`, gerando falha por string vazia.
- **Correção:** O teste agora valida a 1ª página no topo (`idx-0`), o título, o contador (`1 / 15`), corrige a asserção dos rótulos para o formato real do DOM (`"Página 1"` e `"Página 15"`) e executa `.last().scrollIntoViewIfNeeded()`, testando que o `IntersectionObserver` carrega a página `idx-200` sob demanda ao ser visualizada.

### 2. Alinhamento de Persistência no Teste E2E (`cache-and-storage.spec.js`)
- **Problema:** O teste verificava as chaves legadas `${chapter.id}_images` e `${chapter.id}_restoreMap` no `chrome.storage.local`.
- **Correção:** As asserções e o helper `waitForRestoreMap` foram atualizados para consultar o `StorageManager` real no Service Worker via `self.MangaTranslatorStorageManager.getPageDataUrl()` e `getRestoreIndex()`, comprovando a integridade das gravações no IndexedDB e a auto-restauração no reload (F5).

### 3. Isolamento Atômico do IndexedDB no `resetExtensionState`
- **Problema:** O reset executava `indexedDB.open('manga_translator_data')` sem controle de versão, criando um banco vazio sem stores antes da inicialização da extensão e provocando `NotFoundError: One of the specified object stores was not found`.
- **Correção:** O reset agora invoca `self.MangaTranslatorStorageManager.openStorageDb()`, garantindo que as stores (`chapters`, `chapterPages`, `restoreEntries`, `assets`) e seus índices existam antes da limpeza.

### 4. Servidor Mock do Gemini e Performance E2E (`gemini-mock-server.js`)
- **Problema:** A ausência do botão de conversa temporária no mock fazia a extensão aguardar 12 segundos em timeout por imagem (`ensureTemporaryChatActive`).
- **Correção:** Adicionado `<button data-test-id="temp-chat-button" aria-label="Desativar conversa temporária">` no HTML mock. O tempo total da suíte E2E caiu de **mais de 7 minutos** para **2 minutos e 17 segundos**.

### 5. Estabilização do Ambiente de CI Linux (`ci.yml` & `package.json`)
- **Virtual Display (Xvfb):** Adicionado `xvfb-run --auto-servernum` para permitir que o Chromium headless renderize a extensão sem erros gráficos no Ubuntu Linux.
- **Porta 3999:** Adicionado `reuseExistingServer: true` no `playwright.config.js` para prevenir conflitos de porta.
- **Escape de Aspas no Jest:** Corrigido `--testPathPattern=\"(unit|integration)\"` no `package.json` para eliminar erro de sintaxe (`Syntax error: "(" unexpected`) no shell Linux.


### 6. Regressão de inicialização do Service Worker em modo estrito

Após a remoção dos corpos legados de lifecycle, a fachada `_refreshMaxCon`
permaneceu como atribuição a identificador não declarado:

```javascript
_refreshMaxCon = (...args) => { ... };
```

Como `background.js` inicia com `'use strict'`, isso gerava
`ReferenceError: _refreshMaxCon is not defined` durante o boot e impedia o
registro dos listeners do Service Worker. A correção foi declarar a fachada:

```javascript
const _refreshMaxCon = (...args) => {
    initializeJobsModules();
    return jobsLifecycle.refreshMaxConcurrency(...args);
};
```

Commit: `96e899f`.

### 7. CI deixou de mascarar falhas reais

A pipeline antiga podia ficar verde mesmo com Jest/E2E quebrados. Foram
aplicadas três mudanças:

- `acf8ebf`: remove `npm run test:ci || true` e
  `continue-on-error` do job de testes; amplia syntax-check para todos os JS
  aninhados;
- `1eeb28b`: E2E passa a rodar em `main` mesmo se o job anterior falhar e
  deixa de tolerar falha;
- `285f77e`: cancela execuções superseded da mesma branch.

### 8. Alinhamento da suíte Jest aos contratos v5.1

As falhas que antes eram tratadas como "baseline legado" foram corrigidas sem
rebaixar os contratos de produção. Entre os alinhamentos:

- ownership estrito com `jobId` nos fixtures;
- `START_BATCH` retornando `{ok,batchId}`;
- `STOP_BATCH` baseado em `jobIndex/currentBatchId`;
- `GEMINI_RESULT_URL` e abas de extração carregando `jobId/batchId`;
- `FETCH_IMAGE_AS_BASE64` validando remetente, status HTTP, MIME e opções de
  fetch;
- `restoreState()` testado como patch, preservando campos residentes ausentes
  do snapshot;
- cache perceptual testado pelo contrato único
  `GTC_QUERY_PERCEPTUAL_V2`;
- mocks RPA passaram a modelar **consumo real do editor** após envio, em vez de
  considerar apenas o clique no botão como sucesso.

### 9. Leitor: contador estável com virtualização/lazy-load

O contador do leitor passou a manter razões de visibilidade entre callbacks do
`IntersectionObserver` e ganhou uma segunda fonte de atualização baseada na
página visível mais próxima do centro do viewport durante `scroll`/`resize`.

Commits de runtime: `b5f0e80`, `e4ffada`, `74ad410`.

O E2E também foi sincronizado com a materialização real da página virtualizada:
o teste aguarda a imagem terminar o lazy-load, espera dois
`requestAnimationFrame` e recentraliza a página antes de exigir
`10 / 15`. Isso removeu a flutuação `9 / 15` → `10 / 15` que aparecia em
algumas execuções.

Commit de teste: `ec3a9a4`.

### 10. Imports obrigatórios agora falham de forma explícita

Os dois blocos de `importScripts` do caminho real do Service Worker não
silenciam mais falhas de módulos obrigatórios. Em erro de carregamento, o
background registra uma mensagem explícita e relança a exceção.

Commit: `ff8e437`.

Isso evita o estado mais perigoso para manutenção: extensão parcialmente
inicializada, sem módulos essenciais, mas sem erro de boot visível.

### 11. Baseline final desta rodada

A execução de referência imediatamente anterior à atualização da documentação
foi o workflow **35544649714**, no commit `ec3a9a49d8d7`:

| Verificação | Resultado |
|---|---|
| Jest unitário/integrado | **81/81 suítes; 574/574 testes ✅** |
| Playwright E2E | **8/8 ✅; sem flaky** |
| JS Syntax Check | **✅** |
| Manifest Validation | **✅** |
| Smoke / Visual | **✅** |
| Code Coverage | **✅** |

---

## 15. Rodada de limpeza P2/P3

> Fecha os itens de prioridade P2 e P3 do plano de auditoria/refatoração
> (innerHTML remanescente, aliases legados e fallbacks de varredura de
> storage). Cada mudança foi commitada e enviada individualmente por
> arquivo, com validação de sintaxe (`node -c`) e, quando aplicável,
> execução da suíte real de testes antes do push.

**Arquivos alterados:** `content_manga.js`, `content_gemini.js`, `background.js`,
`background/jobs-lifecycle.js`.
**Arquivos novos:** nenhum.
**Comportamento funcional:** inalterado em todos os itens — nenhuma mudança
desta rodada altera o formato de mensagens, payloads ou fluxo observável pelo
usuário.

### 15.1 `setBtnHTML` migrado de `innerHTML` para DOM API

**Onde:** `content_manga.js`, função `setBtnHTML(btn, text, showStop)`.

**Problema.** Era o único bloco de `innerHTML` do content script que recebia
dado variável: o parâmetro `text` inclui, entre outras origens, `request.text`
propagado por uma mensagem `PROGRESS` vinda do background/Gemini. O código já
escapava a string manualmente (`escapeInlineHTML`) antes de concatenar em um
template `innerHTML`, o que era seguro, mas dependia de o desenvolvedor lembrar
de escapar em toda chamada futura.

**Correção.** `setBtnHTML` agora monta o rótulo via `document.createElement` +
`textContent` (escaping automático e nativo do DOM), e usa `innerHTML` apenas
para inserir o `STOP_SIGN_SVG` — um SVG 100% estático e fixo no código-fonte,
sem qualquer interpolação de dado externo. `escapeInlineHTML` foi removida por
ficar sem uso.

Os demais `innerHTML` do arquivo (`errorLine`, `seHandle`, aviso de debug mode,
toast de conclusão) permanecem como estavam: são templates com apenas texto
literal fixo nos dois branches possíveis, sem interpolação de dado externo —
não se enquadram no critério de "dado variável" do plano.

### 15.2 Alias legado `APPLY_RESULT` removido

**Onde:** `content_manga.js`, listener `chrome.runtime.onMessage`.

O handler aceitava tanto `request.action === 'UPDATE_IMAGE'` quanto
`'APPLY_RESULT'`. Busca em todo o repositório confirmou que **nenhum** produtor
emite mais `APPLY_RESULT` — o único emissor de entrega de resultado
(`background/jobs-dom-ack.js`) já envia exclusivamente `UPDATE_IMAGE`. A
condição do plano para remoção (todos os produtores usando `UPDATE_IMAGE` e
`jobId`) já estava satisfeita: `assertJobOwnership` (`jobs-lifecycle.js`) exige
`jobId` obrigatoriamente e retorna `owns:false` sem ele, sem bypass legado.

`OPEN_CHAPTER_FOLDER` e `DOWNLOAD_CHAPTER_AND_SHOW`, que mapeiam para a mesma
ação canônica `download-chapter` no roteador, **não** foram tocados: são dois
produtores distintos e ativos em `popup.js`, com semânticas diferentes (abrir
pasta já baixada vs. baixar e mostrar) — não um alias morto.

### 15.3 Stub de scripting e sinal de anti-hibernação sem uso

**Onde:** `background.js`, `background/jobs-lifecycle.js`, `content_gemini.js`.

- `releaseGeminiScriptsIfIdle` era um stub *no-op* (`function() {}`) herdado da
  época em que os scripts do Gemini eram registrados dinamicamente via
  `chrome.scripting` — hoje são estáticos no `manifest.json` (ver capítulo 5).
  Removido junto com sua fiação: 2 chamadas em `background.js` e o parâmetro
  injetado + 1 chamada em `background/jobs-lifecycle.js`.
- `content_gemini.js` disparava `window.dispatchEvent(new
  CustomEvent('MANGA_TRANSLATOR_ACTIVATE_ANTI_HIBERNATION'))` para sinalizar
  `inject.js`. Confirmado que **não existe** nenhum
  `addEventListener('MANGA_TRANSLATOR_ACTIVATE_ANTI_HIBERNATION', ...)` em
  lugar nenhum do código: `inject.js` já ativa a anti-hibernação
  automaticamente na própria injeção (guardada por checagem de URL/
  `sessionStorage`, ver capítulo 5), sem depender de evento externo. O
  `dispatchEvent` era enviado para o vazio.

Nenhum teste referenciava os símbolos removidos.

### 15.4 Fallback `storage.local.get(null)` eliminado no `STOP_BATCH`

**Onde:** `background.js`, função `stopBatch`.

**Análise de confiabilidade do índice.** Há um único ponto em todo o código
que cria um registro `gemini_job_*` (`jobs-lifecycle.js`, dentro do fluxo de
abertura de aba do Gemini): ele grava o registro no storage e, na linha
seguinte — sem `await` entre as duas instruções —, chama `indexAddJob(...)`
incondicionalmente. Não existe nenhum outro caminho de código que escreva um
registro de job sem também indexá-lo. Além disso, `reconcileJobs`
(`background/jobs-reconciliation.js`) já reconstrói toda a contabilidade após
o Service Worker ser descartado e recriado usando **exclusivamente**
`state.jobIndex`, sem nenhuma varredura de storage — ou seja, o sistema já
trata o índice persistido como fonte de verdade única em todos os outros
pontos.

**Correção.** O fallback que fazia `chrome.storage.local.get(null)` (varredura
completa do storage) quando `indexJobsOfBatch` retornava vazio foi removido;
`stopBatch` agora confia apenas no índice persistido.

**Validação.** Suíte real (`npx jest`, `tests/`) executada antes do push:

| Suíte | Resultado |
|---|---|
| `unit/background/batch-lifecycle-real.test.js` | 6/6 ✅ (inclui cenário de `STOP_BATCH` de lote antigo preservando jobs do lote atual) |
| `unit/background/batch-actions.test.js` | 2/2 ✅ |
| `unit/background/plan-missing-handlers-real.test.js` | 4 falhas pré-existentes (confirmadas via `git stash` — já falhavam antes desta mudança; teste legado desatualizado em relação ao formato de resposta atual do roteador, sem relação com o fallback removido) |

**Não alterado.** O fallback `storage.local.get(null)` em `content_gemini.js`
(resgate de job órfão do lado do content script, usado quando o `tabId` visto
pela aba do Gemini diverge da chave criada pelo background) foi mantido —
tem propósito diferente do índice do background e não se enquadra na condição
do plano.

### 15.5 Helpers perceptuais e globais `window` mortos: nada encontrado

Busca exaustiva não encontrou código morto correspondente a este item na
versão atual do código:

- Os 20 membros da API pública de `gtc-fingerprint.js` foram checados um a
  um; os 7 que pareciam suspeitos à primeira vista (`buildFingerprintSource`,
  `hashStringSha256`, `hammingDistance` e os 4 thresholds
  `*_MATCH_THRESHOLD*`) são usados **internamente** pelo próprio módulo para
  compor `createFingerprintFromDescriptor` e os matchers de hash — expostos
  na API pública também, mas não mortos.
- `gtc-indexeddb.js`: nenhuma função com apenas uma ocorrência (definição sem
  chamada).
- Globais `window.__*` em `content_manga.js`, `content_gemini.js` e
  `inject.js`: os 7 nomes únicos identificados aparecem todos com padrão de
  escrita **e** leitura — nenhum "write-only" órfão.

Nenhuma alteração foi feita para este item; presume-se que rodadas de
refatoração anteriores já eliminaram o que existia.

---

## 16. Verificação da sessão interrompida: lifecycle legado, suite completa e privacidade de logs

> A sessão anterior (rodando localmente, fora deste ambiente) processava em
> paralelo três itens do plano de auditoria — P1 "remover corpos legados de
> lifecycle", P1 "executar e corrigir a suite completa" e P2 "privacidade de
> logs em content_gemini.js" — e foi interrompida por limite de uso antes de
> confirmar o resultado. Esta seção documenta a verificação desses três itens.

### 16.1 P1 — Remoção de corpos legados de lifecycle: já estava correta no GitHub

O commit `6e97259 refactor: remove legacy background lifecycle bodies`
(307 linhas removidas de `background.js`) já estava no repositório antes
desta verificação. Confirmado:

- `node -c` válido em `background.js` e em todos os módulos de `background/`.
- Nenhum corpo antigo de `processNextJob`, `finalizeJob`, `updateJobState`,
  `assertJobOwnership`, `buildGeminiJobUrl` ou `deleteGeminiConversation`
  remanescente — só as fachadas compatíveis, todas delegando para
  `jobs-lifecycle.js`.
- A lógica de deleção de conversa (mensagem `DELETE_CONVERSATION`, controle
  de `deleting_urls`) **não foi perdida**: continua completa dentro de
  `finalizeJob` em `jobs-lifecycle.js`, só deixou de existir como função
  nomeada separada (`deleteGeminiConversation`).
- Comparação de suíte (ver 16.2) confirma **zero regressão** introduzida por
  este commit.

### 16.2 P1 — Suite completa: histórico do baseline antigo e fechamento

Na verificação original, `npx jest --testPathPattern=unit` ainda mostrava
10 suítes / 32 testes falhando tanto antes quanto depois da remoção do lifecycle.
A comparação foi útil naquele momento para provar que o commit `6e97259` não
havia criado aquelas falhas.

Esse estado é **histórico e foi superado**. A rodada posterior alinhou os testes
aos contratos v5.1 e corrigiu regressões reais descobertas durante a migração.

Estado atual validado:

| Métrica | Baseline antigo desta seção | Baseline atual |
|---|---:|---:|
| Suítes Jest falhando | 10 | **0** |
| Testes Jest falhando | 32 (unit isolado) / 45 (suite CI antiga) | **0** |
| Suítes Jest aprovadas | 68 no recorte unit antigo | **81/81** |
| Testes Jest aprovados | 458 no recorte antigo | **574/574** |
| E2E | ainda em estabilização | **8/8, sem flaky** |

A correção completa e os commits correspondentes estão documentados nas
seções 14 e 18.

### 16.3 P2 — Privacidade de logs em `content_gemini.js`: implementado agora

Este item **não havia sido iniciado** quando a sessão anterior foi
interrompida (só a suite completa e o lifecycle tinham progresso real). Foi
implementado nesta verificação — ver seção 15 do changelog geral: commit
`596e6a1`, com `debugConsole()` gateando as 24 chamadas `console.log/warn/
error` por `debugMode` e sanitizando os 3 argumentos que carregavam dado mais
sensível (jobId completo, objeto `Error` inteiro, referência DOM bruta de
thumbnail).

---

## 17. Auditoria Geral do Plano Original vs GitHub: Status e Refinamentos Concluídos

Esta seção consolida a auditoria completa de todos os itens do plano arquitetural original em relação ao que foi implementado e enviado ao repositório GitHub (`origin/main`).

### 17.1 Tabela de Rastreabilidade e Cobertura do Plano

| Fase / Item do Plano | Descrição da Ação | Status no GitHub | Arquivos / Commits Relacionados |
|---|---|---|---|
| **Fase 1.1** | Extração de `log.js` (`log` + `_flushLog`) | ✅ Concluído | `background/log.js` (`926023d`) |
| **Fase 1.2** | Extração de `state.js` (estado centralizado + sincronização durável) | ✅ Concluído | `background/state.js`, `cb5e023`, `577af6a` |
| **Fase 1.3** | Implementação de `router.js` (despacho centralizado de mensagens) | ✅ Concluído | `background/router.js`, `6f89d86` |
| **Fase 1.4** | Criação de `shared-ui.js` e eliminação de duplicações na UI | ✅ Concluído | `shared-ui.js`, `popup.html`, `options.html`, `reader.html` (`926023d`) |
| **Fase 2.1 a 2.5** | Ações de baixo risco (`log-entry`, `get-tab-id`, `set-debug-mode`, `relay-progress`, `check-extraction-tab`) | ✅ Concluído | `background/actions/*.js` (20 ações modulares) |
| **Fase 3.1 a 3.4** | Ações de médio risco (`fetch-image-base64`, `calculate-visual-fingerprint`, `force-send-activation`, `download-*`) | ✅ Concluído | `background/actions/*.js` |
| **Fase 4.1** | `deliver-result` + handshake com ACK de DOM | ✅ Concluído | `background/jobs-dom-ack.js`, `deliver-result.js` (`a2754b2`) |
| **Fase 4.2** | Orquestração de lotes (`start-batch`, `stop-batch`) | ✅ Concluído | `background/actions/start-batch.js`, `stop-batch.js` (`2da1c14`) |
| **Fase 4.3** | Ciclo de vida e watchdog de jobs (`jobs-lifecycle.js`, `jobs-watchdog.js`, `jobs-reconciliation.js`) | ✅ Concluído | `background/jobs-*.js`, `140b7fe`, `63a2627`, `359fd48` |
| **Fase 5.1** | Remoção de corpos e funções mortas do `background.js` | ✅ Concluído | `6e97259`, `27f64f9`, `0f8b70a`, `2da1c14` |
| **Fase 5.2 / 5.3** | Ponto de entrada do Service Worker | ✅ Resolvido arquiteturalmente | `background.js` atua como bootstrap consolidado para manter total compatibilidade com suites Jest e mocks de testes existentes |
| **Fase 5.4** | Remoção de `deleteSavedTranslationForEntry` duplicada | ✅ Concluído | `shared-ui.js` (`926023d`) |
| **SEC-01 / SEC-02** | Revisão de `<all_urls>` | ⏸ Preservado | Mantido por compatibilidade funcional com leitor universal de mangás |
| **SEC-03** | Fallback `storage.get(null)` no content_gemini | ℹ️ Preservado justificado | Mantido especificamente para resgate de divergência de `tabId` (seção 15.4) |
| **SEC-04** | Eliminação de `storage.get(null)` no `STOP_BATCH` | ✅ Concluído | `background.js` (`2da1c14`) |
| **SEC-05** | Extração de constante nomeada para prompt padrão | ✅ Concluído | `background.js` (`d5da409`) |
| **SEC-06** | Sanitização DOM / eliminação de `innerHTML` com interpolação | ✅ Concluído | `content_manga.js` (`5df27db`) |
| **SEC-07** | Validação de protocolo e MIME em `FETCH_IMAGE_AS_BASE64` | ✅ Concluído | `background/actions/fetch-image-base64.js` |
| **SEC-08** | Validação estrita de `jobId` no `assertJobOwnership` | ✅ Concluído | `background/jobs-lifecycle.js` (`9cc29c7`) |

### 17.2 Refinamentos Implementados Nesta Sessão

1. **Reutilização de Prompt Padrão na Interface (`6932f72`, `82c0b80`, `33f57b7`):**
   - Constante `DEFAULT_HD_PROMPT` adicionada a `shared-ui.js` e exposta globalmente.
   - `popup.js` e `options.js` passaram a reutilizar `DEFAULT_HD_PROMPT`, eliminando mais de 50 linhas de string idêntica duplicada.

2. **Resolução Definitiva de SEC-05 (`d5da409`):**
   - Extraída a constante `DEFAULT_TRANSLATION_PROMPT` no topo de `background.js`.
   - O listener `chrome.runtime.onInstalled` agora referencia a constante diretamente.

3. **Desacoplamento de Gravação no Cache Global GTC (`81bc42d`):**
   - No `content_manga.js`, a invocação de `saveGlobalTranslationCacheEntry` foi movida para ser executada imediatamente após a substituição da imagem no DOM.
   - Antes, ela residia dentro da Promise de persistência do capítulo (`persistTranslatedPage`). Uma falha transitória de cota de armazenamento ou concorrência no IndexedDB impedia que a imagem fosse salva no GTC, desperdiçando a tradução. Com o desacoplamento, a imagem é cacheada perceptualmente de forma resiliente.

---

## 18. Estabilização final pós-refatoração: runtime, testes e CI

> Esta seção registra a rodada executada depois da auditoria da seção 17. O
> objetivo foi transformar o estado "arquitetura modularizada, mas com baseline
> legado tolerado" em "extensão carregando no navegador + pipeline estrita
> totalmente verde".

### 18.1 Falha fatal que impedia a extensão de iniciar

**Sintoma no Edge/Chromium:**

```text
Uncaught ReferenceError: _refreshMaxCon is not defined
```

**Causa raiz.** O commit que removeu os corpos legados de lifecycle deixou a
fachada `_refreshMaxCon` como atribuição sem declaração. Em
`background.js`, que roda sob `'use strict'`, a exceção ocorre durante a
avaliação do arquivo, antes de o worker terminar de registrar IPC/listeners.

**Correção:** `const _refreshMaxCon = (...args) => ...`
(`96e899f`).

A partir dessa correção, os oito cenários E2E que antes falhavam em cascata
voltaram a executar no Chromium real.

### 18.2 Bootstrap obrigatório com fail-fast

O caminho real de navegador (`typeof importScripts === 'function'`) agora
trata falha de módulo obrigatório como erro fatal explícito:

```javascript
} catch (e) {
    console.error('[MangaTranslator background] Falha ao carregar módulos obrigatórios do background.', e);
    throw e;
}
```

O mesmo vale para `gtc-fingerprint.js`, `gtc-indexeddb.js` e
`storage-manager.js`.

**Importante:** os `catch` do fallback Node/`require` usados por harnesses de
teste continuam independentes; o fail-fast foi aplicado ao boot real do
Service Worker.

Commit: `ff8e437`.

### 18.3 Contratos de background consolidados

Os testes antigos foram atualizados para refletir, sem enfraquecer, os contratos
atuais:

- `assertJobOwnership()` exige `jobId` e ownership da aba;
- `START_BATCH` expõe `batchId`;
- jobs de fila e storage carregam `jobId/batchId`;
- abas de extração preservam identidade ponta a ponta;
- `STOP_BATCH` usa somente índice durável;
- `restoreState()` possui semântica de patch;
- `FETCH_IMAGE_AS_BASE64` exige remetente válido, resposta HTTP válida e MIME
  de imagem.

Principais commits: `df0b2a3`, `f63fdfd`, `56fc141`,
`d7657b1`.

### 18.4 Gemini RPA: correções reais e testes mais fiéis

Além do alinhamento de fixtures, três comportamentos reais foram fortalecidos.

**Detecção de conversa temporária ativa (`bdc0cf4`).** A UI nativa atual do
Gemini é reconhecida por indicadores textuais/ARIA específicos, evitando
reativação desnecessária.

**Editor explicitamente desabilitado (`0ecb521`).** Se o editor atual ou seu
elemento editável expõe `disabled`, `aria-disabled="true"` ou
`contenteditable="false"`, o job aborta na etapa de editor em vez de tentar
injeção silenciosa e esperar o watchdog.

**Erros ARIA durante geração (`fa3c72a`).** O polling passou a observar
`.message-error`, `.error-text` e `[role="alert"]`; texto de erro real
encerra a espera e é reportado como `GEMINI_ERROR`.

Os mocks RPA também foram corrigidos para representar o contrato real de envio:
o clique sozinho não confirma envio. O editor precisa ser consumido/esvaziado
ou a UI precisa demonstrar que a geração começou. Isso remove falsos positivos
de teste.

### 18.5 Reader: contador, observers e layout virtualizado

O leitor cria observers distintos para contador, lazy-load e unload. Os testes
antigos capturavam apenas o último callback criado, o que fazia o teste do
contador acionar acidentalmente o observer de unload. Os fixtures agora
identificam o observer correto.

No runtime:

- `pageVisibilityRatios` mantém estado entre batches do
  `IntersectionObserver`;
- entradas que omitem `isIntersecting` em mocks continuam compatíveis;
- `updateCounterFromViewportCenter()` seleciona a página visível cujo centro
  está mais próximo do centro da janela;
- atualização por scroll/resize é limitada por `requestAnimationFrame`.

No E2E, a asserção da página 10 passou a aguardar o lazy-load terminar antes de
recentralizar o wrapper, evitando que a mudança de altura de placeholder
(400 px) para imagem real (~600 px no fixture) desloque a página 10 e produza
`9 / 15` intermitente.

### 18.6 CI: de "verde permissivo" para gate real

A pipeline agora distingue claramente testes funcionais obrigatórios de
telemetria de cobertura:

- Jest não possui `|| true`;
- unit/integration não possui `continue-on-error`;
- E2E em `main` roda mesmo quando dependências falham, para expor também o
  estado do navegador;
- E2E não possui `continue-on-error`;
- syntax-check percorre recursivamente `extension/**/*.js`;
- workflows superseded na mesma branch são cancelados;
- cobertura/Codecov continua não bloqueante por escolha de infraestrutura.

### 18.7 Rastreabilidade completa da rodada posterior à seção 17

#### Runtime / infraestrutura

| Commit | Mudança |
|---|---|
| `96e899f` | declara `_refreshMaxCon` e restaura o boot do worker em strict mode |
| `acf8ebf` | remove mascaramento do Jest e valida JS aninhado |
| `b8d4d20` | adiciona regressão de carregamento estrito do background |
| `1eeb28b` | torna E2E visível/bloqueante em `main` |
| `bdc0cf4` | reconhece UI nativa de conversa temporária já ativa |
| `0ecb521` | aborta job com editor explicitamente desabilitado |
| `fa3c72a` | reconhece erros `role="alert"` durante geração |
| `b5f0e80` | preserva visibilidade do reader entre callbacks |
| `e4ffada` | compatibilidade com entries sem `isIntersecting` |
| `285f77e` | cancela pipelines superseded |
| `74ad410` | deriva página ativa pelo centro do viewport |
| `ff8e437` | fail-fast em módulos obrigatórios do worker |

#### Testes / contratos

| Commit | Mudança |
|---|---|
| `dd473d3`, `82a2ead` | selecionam corretamente o observer do contador do reader |
| `df0b2a3` | fixture de resultado direto passa a usar ownership atual |
| `f63fdfd`, `56fc141` | handlers legados alinhados ao contrato v5.1 |
| `d7657b1` | `restoreState` validado com semântica de patch |
| `4353cf6` | fixtures perceptuais migradas para `GTC_QUERY_PERCEPTUAL_V2` |
| `af49a99`, `c817053`, `3f5ec28`, `5bdce0f` | mocks RPA modelam consumo real do prompt |
| `ae91401`, `67e3a75`, `2af3823`, `61140b6` | jobs de teste recebem `jobId/batchId` |
| `270c42b`, `1bfbf9d`, `3c4e4a6`, `b734968` | resultados simulados só aparecem após confirmação de envio/polling |
| `58aa8c1` | ausência de thumbnail alinhada ao comportamento warn-and-continue |
| `8abb04e`, `00be096`, `8e52d6f`, `df44d30` | fallbacks, privacidade, UI errors e timeout RPA alinhados |
| `449da10` | CG-23 fica restrito ao contrato de injeção de prompt |
| `a1f91a6` | regressão de visibilidade entre batches do observer |
| `ec3a9a4` | E2E aguarda layout virtualizado antes do contador |

### 18.8 Critério de manutenção daqui para frente

O baseline antigo de "falhas conhecidas toleradas" **não deve ser recriado**.
Uma mudança futura só deve ser considerada estável quando:

1. o Service Worker carrega sem exceção em strict mode;
2. sintaxe e manifesto passam;
3. smoke/visual passam;
4. Jest continua 100% verde;
5. E2E em Chromium continua 100% verde **sem flaky**;
6. mudanças de contrato atualizam simultaneamente runtime, teste e esta
   documentação.

Baseline funcional desta seção: `ec3a9a49d8d7c46bcd8a945d144c1ec388588679`.

