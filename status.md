# Status da Refatoração Gemini RPA V2

> Rastreador de execução do `plano.md`. Este arquivo deve ser atualizado no mesmo conjunto de PRs que implementa a refatoração.

## Baseline validado

- [x] `Manga_Translator/main` validado em `1a3636ddc496437b79c6dfc923d9cdb3219547ca`.
- [x] `WebAI-to-API/master` validado em `adc12107d7913979ec631ca7fb561de5955fc39b`.
- [x] Plano revisado contra o runtime atual antes de iniciar alterações.
- [x] Estratégia adotada: PRs pequenos e sequenciais; commits por arquivo sempre que possível.
- [ ] Refatoração completa integrada em `main`.

## Ordem prática do plano

- [x] PASSO 1 — adicionar `tabs.onReplaced` ao mock e logs de diagnóstico.
- [x] PASSO 2 — criar `background/tab-identity.js`.
- [x] PASSO 3 — criar `actions/claim-gemini-job.js`.
- [x] PASSO 4 — tornar lifecycle/reconciler canonical-tab-aware.
- [x] PASSO 5 — adicionar testes de replacement/restart.
- [x] PASSO 6 — trocar bootstrap de `content_gemini.js` para `CLAIM_GEMINI_JOB`.
- [x] PASSO 7 — remover fallback de `storage.get(null)`.
- [x] PASSO 8 — remover keep-alive prematuro.
- [x] PASSO 9 — extrair `gemini/selectors.js` e `gemini/dom.js`.
- [x] PASSO 10 — criar `gemini/observer.js`.
- [ ] PASSO 11 — instalar observer antes do submit.
- [ ] PASSO 12 — mudar click/trigger para “attempt”, não “success”.
- [ ] PASSO 13 — remover mutação forçada de `disabled`.
- [ ] PASSO 14 — reduzir tentativas de envio para 2.
- [ ] PASSO 15 — trocar espera de resultado por observer.
- [ ] PASSO 16 — corrigir Temporary Chat.
- [ ] PASSO 17 — extrair attachment/result/deletion.
- [ ] PASSO 18 — criar job runner.
- [ ] PASSO 19 — reduzir anti-throttling.
- [ ] PASSO 20 — remover legado.
- [ ] PASSO 21 — atualizar documentação/README.

## PRs planejados

### PR 0 — Observabilidade e infraestrutura de teste
- [x] Mock expõe `tabs.onReplaced`.
- [x] Mock expõe `_simulateReplacement(oldTabId, newTabId)`.
- [x] Replacement transfere propriedades da aba e handlers registrados.
- [x] Background registra `TAB_REPLACED`.
- [x] Background registra `TAB_ID_OBSERVED` em `GET_TAB_ID`.
- [x] Teste unitário do replacement adicionado.
- [x] CI do PR 0 verde — run #278.

### PR 1 — Identidade canônica de aba + claim seguro
- [x] Alias durável `oldTabId -> newTabId`.
- [x] Cadeia de aliases com limite de hops/ciclo/TTL.
- [x] Journal de migração recuperável após restart.
- [x] Migração de `gemini_job_*`.
- [x] Migração de `wd_data_*`.
- [x] Migração de `jobIndex`.
- [x] Migração de `extractionTabs[*].geminiTabId`.
- [x] Migração de recovery/finalization markers.
- [x] Lifecycle resolve canonical antes de persistir job.
- [x] Reconciler resolve canonical antes de dropar job.
- [x] Watchdog alias-aware.
- [x] `CLAIM_GEMINI_JOB` implementado e restrito à origem Gemini.
- [x] TAB-01 a TAB-12.
- [x] CI do PR 1 verde — run #305.

### PR 2 — Bootstrap por claim
- [x] `content_gemini.js` usa `CLAIM_GEMINI_JOB`.
- [x] Full scan órfão removido.
- [x] `openKeepAlive()` só após claim válido.
- [x] KEEP-01 a KEEP-05.
- [x] CI do PR 2 verde — run #323.

### PR 3 — Fundação modular Gemini
- [x] `gemini/selectors.js`.
- [x] `gemini/dom.js`.
- [x] Manifest com load order explícito.
- [x] Funções puras testáveis por `require()`.
- [ ] CI do PR 3 verde.

### PR 4 — Observer V2
- [x] `gemini/observer.js`.
- [x] Ownership por response container.
- [x] Stop/Error exigem visibilidade real.
- [x] `generationActiveObserved`.
- [x] Cleanup idempotente.
- [x] OBS-01 a OBS-12.
- [ ] CI do PR 4 verde.

### PR 5 — Submit confirmado
- [ ] `gemini/editor.js`.
- [ ] Observer instalado antes do submit.
- [ ] `MANGA_TRANSLATOR_TRIGGER_SEND` significa tentativa.
- [ ] `DO_SEND_NOW` não declara `sent:true` sem evidência.
- [ ] Mutação forçada de disabled removida.
- [ ] Máximo de 2 tentativas.
- [ ] Falha curta `GEMINI_SUBMISSION_NOT_CONFIRMED`.
- [ ] SEND-01 a SEND-07.
- [ ] CI do PR 5 verde.

### PR 6 — Observer como fonte de resultado
- [ ] Polling pesado de 1 s removido do caminho primário.
- [ ] `waitForResult()` com timeout terminal.
- [ ] Resposta instantânea capturada.
- [ ] Imagem antiga não capturada.
- [ ] CG-36/E2E atualizados.
- [ ] CI do PR 6 verde.

### PR 7 — Temporary Chat verificado
- [ ] `gemini/temporary-chat.js`.
- [ ] `activeNow` controla o retorno.
- [ ] Fallback geométrico exige semântica.
- [ ] TEMP-01 a TEMP-05.
- [ ] CI do PR 7 verde.

### PR 8 — Attachment modular
- [ ] `gemini/attachment.js`.
- [ ] Paste/file input/drag-drop movidos.
- [ ] Attachment confirmado por evidência observável.
- [ ] CI do PR 8 verde.

### PR 9 — Result extractor modular
- [ ] `gemini/result-extractor.js`.
- [ ] Cadeia canvas → MAIN fetch → SW fetch → auxiliar preservada.
- [ ] CI do PR 9 verde.

### PR 10 — Deletion modular
- [ ] `gemini/deletion.js`.
- [ ] Menu/confirm/settle/recovery movidos.
- [ ] Idempotência preservada.
- [ ] CI do PR 10 verde.

### PR 11 — Job runner e redução do monólito
- [ ] `gemini/job-runner.js`.
- [ ] `content_gemini.js` reduzido a bootstrap/claim/keepalive/runner/handlers.
- [ ] Helper baseado em `new Function` aposentado para módulos novos.
- [ ] CI do PR 11 verde.

### PR 12 — Anti-throttling progressivo
- [ ] Mousemove aleatório removido.
- [ ] Focus interval reduzido para escalada.
- [ ] Modos internos legacy/balanced/minimal se ainda necessários.
- [ ] E2E background/minimized.
- [ ] CI do PR 12 verde.

### PR 13 — Limpeza do legado
- [ ] Observer legado removido.
- [ ] 50-attempt send removido.
- [ ] Polling de resultado legado removido.
- [ ] Fallback positional inseguro removido.
- [ ] Flags temporárias removidas.
- [ ] Helper textual/`new Function` removido quando não houver consumidores.
- [ ] Docs V6/README atualizados.
- [ ] CI final verde.

## Invariantes que serão preservados

- [ ] `jobId` lógico permanece independente de `tabId`.
- [ ] Nenhuma aba manual do Gemini executa automação sem claim válido.
- [ ] Nenhum submit é considerado sucesso apenas por click/Enter/CustomEvent.
- [ ] Finalização continua idempotente.
- [ ] DOM ACK continua sendo a barreira para liberar slot após entrega.
- [ ] Cadeia de extração atual não é simplificada antes da estabilização de ownership/observer.
- [ ] Logs não armazenam prompt, signed URL, imagem, cookie ou token.

## Notas de execução

- PR 3: CI completo verde no run #333 (HEAD `fe75c45a`).
- PR 4 adiciona Observer V2 isolado e ainda não troca o polling do runtime. O observer instala ownership por response novo, baseline de imagens/erros, coalescing de mutations, confirmação de submit e cleanup idempotente.
- Correção adicional: `send_busy` só confirma submit após transição observada de Send habilitado para busy/desabilitado; um controle já disabled no baseline não é evidência de envio.

- PR 2: CI completo verde no run #323 (HEAD `570b029b`).

- PR 3 extraiu seletores e helpers DOM sem alterar intencionalmente o pipeline. `content_gemini.js` delega `getImageSource`, blacklist de imagens, ownership por response, deep traversal, editable lookup e send-button lookup ao novo módulo.

- PR 0: CI completo verde no run #278.
- PR 1: CI completo verde no run #305 (HEAD `97f154e9`).
- PR 2 mantém um fallback transitório **somente por chave específica** (`GET_TAB_ID` + `gemini_job_<tabId>`) quando `CLAIM_GEMINI_JOB` não recebe resposta. O runtime atual usa claim; o fallback existe para compatibilidade de fixtures/background antigo e não faz `storage.get(null)`.
- Keep-alive agora permite no máximo uma reconexão e somente enquanto o job estiver ativo.

- PR 1 adicionou uma proteção extra não explícita no checklist: conflito de rekey entre dois `jobId` diferentes aborta a migração em vez de apagar ownership existente.
- O lifecycle e o watchdog usam write → canonical recheck para fechar a corrida em que `onReplaced` acontece durante a própria persistência.

- Cada checkbox só deve ser marcado quando a mudança correspondente estiver realmente presente no branch.
- Itens de CI só são marcados após os checks do GitHub Actions terminarem com sucesso.
- PRs posteriores serão empilhados sobre o branch anterior enquanto os anteriores ainda estiverem abertos, para preservar dependências sem escrever diretamente em `main`.
