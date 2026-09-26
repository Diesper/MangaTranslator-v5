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
- [x] PASSO 11 — instalar observer antes do submit.
- [x] PASSO 12 — mudar click/trigger para “attempt”, não “success”.
- [x] PASSO 13 — remover mutação forçada de `disabled`.
- [x] PASSO 14 — reduzir tentativas de envio para 2.
- [x] PASSO 15 — trocar espera de resultado por observer.
- [x] PASSO 16 — corrigir Temporary Chat.
- [x] PASSO 17 — extrair attachment/result/deletion.
- [x] PASSO 18 — criar job runner.
- [x] PASSO 19 — reduzir anti-throttling.
- [x] PASSO 20 — remover legado.
- [x] PASSO 21 — atualizar documentação/README.

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
- [x] CI do PR 3 verde — run #333.

### PR 4 — Observer V2
- [x] `gemini/observer.js`.
- [x] Ownership por response container.
- [x] Stop/Error exigem visibilidade real.
- [x] `generationActiveObserved`.
- [x] Cleanup idempotente.
- [x] OBS-01 a OBS-12.
- [x] CI do PR 4 verde — run #396.

### PR 5 — Submit confirmado
- [x] `gemini/editor.js`.
- [x] Observer instalado antes do submit.
- [x] `MANGA_TRANSLATOR_TRIGGER_SEND` significa tentativa.
- [x] `DO_SEND_NOW` não declara `sent:true` sem evidência.
- [x] Mutação forçada de disabled removida.
- [x] Máximo de 2 tentativas.
- [x] Falha curta `GEMINI_SUBMISSION_NOT_CONFIRMED`.
- [x] SEND-01 a SEND-07.
- [x] CI do PR 5 verde — run #398.

### PR 6 — Observer como fonte de resultado
- [x] Polling pesado de 1 s removido do caminho primário.
- [x] `waitForResult()` com timeout terminal.
- [x] Resposta instantânea capturada.
- [x] Imagem antiga não capturada.
- [x] CG-36 atualizado; E2E de resposta rápida permanece para o gate desta etapa.
- [x] CI do PR 6 verde — run #407.

### PR 7 — Temporary Chat verificado
- [x] `gemini/temporary-chat.js`.
- [x] Estado relido após clique controla o retorno; falso sucesso de `activeNow` removido.
- [x] Fallback geométrico exige semântica.
- [x] TEMP-01 a TEMP-05.
- [x] CI do PR 7 verde — run #410.

### PR 8 — Attachment modular
- [x] `gemini/attachment.js`.
- [x] Paste/file input/drag-drop movidos.
- [x] Attachment confirmado por baseline + MutationObserver; dispatch isolado não declara sucesso.
- [x] CI do PR 8 verde — run #440.

### PR 9 — Result extractor modular
- [x] `gemini/result-extractor.js`.
- [x] Cadeia canvas → MAIN fetch → SW fetch → retry → auxiliar preservada por execution mode.
- [x] CI do PR 9 verde — run #455.

### PR 10 — Deletion modular
- [x] `gemini/deletion.js`.
- [x] Menu/confirm/settle/recovery movidos.
- [x] Idempotência preservada por controller único com lock interno.
- [x] CI do PR 10 verde — run #480.

### PR 11 — Job runner e redução do monólito
- [x] `gemini/job-runner.js`.
- [x] `content_gemini.js` reduzido a bootstrap/claim/keepalive/runner/handlers.
- [x] Helper baseado em `new Function` aposentado para módulos novos; testes novos usam módulos diretamente.
- [x] CI do PR 11 verde — run #490.

### PR 12 — Anti-throttling progressivo
- [x] Mousemove aleatório removido.
- [x] Focus interval removido do baseline e limitado à escalada balanced/legacy.
- [x] Modos internos `minimal` / `balanced` / `legacy` implementados.
- [x] E2E adicionados para `background_delete` e `minimized_window`.
- [x] CI do PR 12 verde — run #529.

### PR 13 — Limpeza do legado
- [x] Observer legado removido; Observer V2 é a única fonte de resultado/submit.
- [x] Loop legado de 50 tentativas de send removido.
- [x] Polling de resultado legado removido; espera pertence ao Observer V2.
- [x] Fallback posicional inseguro do Temporary Chat removido.
- [x] Flags transitórias de migração/teste removidas (`__mangaTranslatorJobSent`, `__MT_SKIP_GEMINI_AUTO_PROCESS__`).
- [x] Helper textual/`new Function` removido; testes importam o módulo real via CommonJS.
- [x] Docs/README atualizados para arquitetura modular e anti-throttling progressivo.
- [x] Versionamento centralizado em `package.json` com `version:sync` / `version:check`.
- [x] Manifest e metadados de teste derivados da fonte única; versão executável elevada para 6.5/6.5.0.
- [x] UI remove versão hardcoded e lê `chrome.runtime.getManifest().version`.
- [x] Documento canônico passa a `docs/Documentação.md` e publicação passa a usar nomes dinâmicos.
- [x] CI final verde — run #549 (13/13 E2E; todos os jobs verdes).

## Critérios globais de aceite do plano

- [x] Não existe falso sucesso de submit.
- [x] `MANGA_TRANSLATOR_TRIGGER_SEND` significa tentativa, não confirmação.
- [x] `DO_SEND_NOW` significa tentativa, não confirmação.
- [x] `activeNow=false` não retorna ativação bem-sucedida.
- [x] Stop escondido não é considerado geração.
- [x] Send disabled não é habilitado por mutação forçada.
- [x] Observer é instalado antes do envio.
- [x] Nova resposta é identificada por ownership.
- [x] Resultado antigo não é confundido com resultado atual.
- [x] Cleanup é idempotente.
- [x] Aba manual Gemini permanece inerte no contrato unitário KEEP/TAB.
- [x] Keepalive só abre após claim.
- [x] `storage.get(null)` não participa do routing de job.
- [x] `onReplaced` preserva ownership.
- [x] Replacement chain funciona.
- [x] Restart durante rekey funciona.
- [x] Reconciler não descarta aba substituída.
- [x] Watchdog continua funcionando.
- [x] DOM ACK continua funcionando.
- [x] Finalização continua idempotente.
- [x] GTC e IndexedDB não sofreram regressão no CI do PR 12.
- [x] Reader não sofreu regressão no CI do PR 12.
- [x] Todos os testes existentes atualizados passam no PR 12 — run #529.
- [x] Novos testes TAB/SEND/OBS/TEMP/KEEP passam.
- [x] E2E de tradução completa passa — PR 12 run #529.
- [x] E2E de resposta rápida passa — run #549.
- [x] E2E de submit ignorado falha cedo — run #549.
- [x] E2E de aba manual não toca no Gemini / não abre keepalive — run #549.

## Invariantes que serão preservados

- [x] `jobId` lógico permanece independente de `tabId`.
- [x] Nenhuma aba manual do Gemini executa automação sem claim válido.
- [x] Nenhum submit é considerado sucesso apenas por click/Enter/CustomEvent.
- [x] Finalização continua idempotente.
- [x] DOM ACK continua sendo a barreira para liberar slot após entrega.
- [x] Cadeia de extração atual foi preservada após estabilização de ownership/observer.
- [x] Logs sanitizam prompt, signed URL, imagem/base64, cookie e token.

## Notas de execução

- PR 13: baseline funcional mais recente validado no run #551; 94/94 suítes Jest, 693/693 testes Jest e 13/13 E2E Playwright passaram, além de sintaxe, manifest e coverage.

- PR 12: CI completo verde no run #529.
- Critérios E2E finais adicionados no PR 13: tradução completa, resposta instantânea, submit ignorado com falha curta e aba Gemini manual inerte/sem keepalive.

- Runs históricos reconciliados no tracker: PR 3 #333, PR 4 #396, PR 5 #398, PR 6 #407, PR 7 #410, PR 10 #480 e PR 11 #490.
- Invariantes finais foram reconferidos no código modular: ownership lógico por jobId, claim obrigatório, submit observável, finalização idempotente, ACK de DOM, cadeia de extração e sanitização de logs.

- PR 13 remove o legado transitório: fallback posicional do Temporary Chat, adapter legado, flag de submit já confirmado e loader textual baseado em `new Function`.
- `content_gemini.js` passa a exportar sua API somente em CommonJS de teste e não autoexecuta nesse ambiente; no navegador mantém o bootstrap normal. Após remover wrappers transitórios, o arquivo ficou com ~451 linhas.
- README e `docs/Documentação.md` descrevem os módulos `gemini/*`, Observer V2, Job Runner, deletion/recovery, extração, anti-throttling progressivo e versionamento centralizado.
- `package.json` é a fonte única de versão; Manifest/testes são sincronizados e o workflow de release não depende mais de nomes `v6.0`/`v6.5` hardcoded.

- PR 12 substitui o anti-throttling permanente por níveis progressivos: `minimal` (padrão), `balanced` (background/minimized) e `legacy` apenas na segunda tentativa de submit.
- O loop de `mousemove` aleatório foi removido. O foco periódico deixou de existir em `minimal`; balanced usa 5 s e legacy usa 1 s somente durante escalada.
- rAF/idle também passam a usar cadência progressiva (250/100/50 ms), mantendo o bypass sem acordar a página a cada 50 ms no baseline.
- E2E foram ampliados para `minimized_window` e `background_delete`; o mock local ganhou rota `/app/mock-chat` com menu e confirmação de exclusão.

- PR 11 extrai o pipeline de execução para `gemini/job-runner.js`: recovery, aquisição da imagem, Temporary Chat, attachment, prompt, Observer V2, submit, resultado, extração, entrega e cleanup.
- `content_gemini.js` caiu de ~1.126 para ~515 linhas e ficou restrito a infraestrutura, claim, wiring, handlers e wrappers transitórios de compatibilidade.
- RUN-01 a RUN-05 testam o runner diretamente, sem `new Function`. O helper textual continua apenas para consumidores legados e será removido no PR 13.

- PR 10 extrai a exclusão para `gemini/deletion.js` com um controller único por content script.
- O lock `deletionInProgress`, seleção da conversa pelo chatId, menu Excluir, confirmação, settle, scroll lock e logs de deleção ficam no módulo.
- Recovery também foi movido: persistência de `gemini_delete_recovery_<tabId>`, reload, retomada após reinjeção, limpeza do marker e entrega preservam o fluxo anterior.
- DEL-01 a DEL-09 cobrem escape, settle, debug, fluxo completo, concorrência, save/read/clear, recovery e reload.

- PR 9: CI completo verde no run #455 (HEAD anterior ao commit documental de status).

- PR 9 extrai a cadeia de resultado para `gemini/result-extractor.js` sem unificar prematuramente os execution modes.
- Em `background_delete`, a ordem continua canvas → bridge MAIN → SW com sessão; nos demais modos, o SW fetch legado continua direto.
- O retry continua repetindo a cadeia completa. O auxiliary fallback agora também pertence ao módulo via callback injetado e só roda depois que todas as tentativas diretas falham.
- EXT-01 a EXT-09 fixam em teste a ordem das rotas, blob/data URL, retry e fallback auxiliar.

- PR 8: CI completo verde no run #440 (HEAD anterior ao commit documental de status).

- PR 8 extrai paste, file input, drag/drop e confirmação de thumbnail para `gemini/attachment.js`.
- A confirmação captura um baseline antes da tentativa e só aceita evidência nova ou alterada; `attempted:true` nunca significa `confirmed:true`.
- A primeira tentativa preserva paste + file input + drag/drop. Retries preservam paste + file input, em cadência equivalente ao fluxo anterior, dentro da janela terminal de 15 s.
- O conteúdo herdado de PR 7 foi ressincronizado com os HEADs verdes após o primeiro CI do PR 8 detectar drift na pilha.

- PR 7 substitui o antigo retorno `click -> success:true` por estados explícitos `already_active`, `activated_verified`, `unavailable` e `verification_failed`.
- Após um clique, o controle é apenas observado; o código não alterna o toggle repetidamente.

- PR 6 remove o polling pesado do caminho primário: imagem, erro e timeout passam por `activeGeminiObserver.waitForResult()`.
- Seleção manual resolve a mesma Promise via `acceptResult()`; a cadeia de extração permanece intacta.

- PR 5 instala o Observer V2 antes de qualquer submit, preserva `__mangaTranslatorJobSent` apenas após confirmação real e elimina mutações forçadas de `disabled`/`aria-disabled`.
- `MANGA_TRANSLATOR_TRIGGER_SEND` e `DO_SEND_NOW` representam tentativa; o pipeline só segue após `waitForSubmission()`.

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
