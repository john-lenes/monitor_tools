# Backlog Técnico — Sankhya Monitor Extension

> Versão: 1.0 · 18/03/2026  
> Contexto: extensão Chrome MV3 para captura e análise de tráfego HTTP em aplicações Sankhya.  
> Objetivo final: relatório que, em vez de `CRUDService.save / application X`, exiba ação do usuário → tela → arquivo frontend → função/padrão → serviceName → entidade/chave → hipótese de classe backend → score de confiança.

---

## Índice de Épicos

| # | Épico | Fase | Prioridade |
|---|-------|------|------------|
| E1 | Stack de origem e initiator enriquecido | 1 | 🔴 Crítica |
| E2 | Correlação com padrões frontend Sankhya | 1 | 🔴 Crítica |
| E3 | Parser Sankhya ampliado | 1 | 🟠 Alta |
| E4 | Deduplicação por fingerprint | 1 | 🟠 Alta |
| E5 | Relatório com hipótese de backend | 1 | 🟠 Alta |
| E6 | Indexação de Sources via DevTools | 2 | 🟡 Média |
| E7 | Correlação com código-fonte JS | 2 | 🟡 Média |
| E8 | Timeline de ação do usuário | 3 | 🟢 Baixa |
| E9 | Agrupamento funcional e árvore de fluxo | 3 | 🟢 Baixa |

---

## E1 — Stack de origem e initiator enriquecido

**Objetivo:** saber qual arquivo JS e qual função disparou cada requisição HTTP, sem precisar abrir as DevTools manualmente.

**Dependências:** nenhuma — pode começar imediatamente.

---

### H1.1 — Captura de call stack em XHR/fetch

**História:** Como desenvolvedor analisando um relatório, quero ver qual arquivo JS e qual função chamou cada XHR/fetch, para identificar o componente frontend responsável sem grep manual no código.

**Prioridade:** 🔴 Crítica

**Critérios de aceite:**
- Cada requisição capturada tem um campo `callStack` com array de frames `{ file, fn, line, col }`
- Frames de `chrome-extension://`, `node_modules/`, `webpack-internal://` são filtrados
- Quando stack não estiver disponível (ex: fetch nativo sem interceptação), `callStack` é `null`
- Frames são normalizados: URLs longas de bundle preservam o path relativo (ex: `sankhya-web/js/app.36f2a.js:1:48293`)

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T1.1.1 | Capturar `new Error().stack` no momento do `open()` (XHR) | `content-main.js` | Dentro do override de `XMLHttpRequest.prototype.open`, antes do `super.open()`, executar `const stack = new Error().stack \|\| ''` e salvar em `this._mon.callStack = parseStack(stack)` |
| T1.1.2 | Capturar stack no `window.fetch` | `content-main.js` | No início do override de `fetch`, antes do `origFetch()`, capturar `new Error().stack` e incluir no payload emitido |
| T1.1.3 | Criar `parseStack(rawStack)` em `content-main.js` | `content-main.js` | Função pura que recebe a string do stack, extrai frames com regex `/at (.+?) \((.+?):(\d+):(\d+)\)/g`, retorna array de `{ fn, file, line, col }`, limitado a 12 frames, filtrando ruído (`chrome-extension`, `Error`, `parseStack` em si) |
| T1.1.4 | Incluir `callStack` no `emit()` | `content-main.js` | Adicionar campo `callStack` no objeto emitido pelo `emit()`, ao lado de `url`, `method`, etc. |
| T1.1.5 | Passar `callStack` pelo `normalizeRequest` | `modules/capture.js` | Incluir `callStack: raw.callStack ?? null` no objeto retornado por `normalizeRequest()` |

---

### H1.2 — Enriquecimento do initiator DevTools

**História:** Como desenvolvedor, quero que a captura via DevTools também extraia o initiator completo (frames da call stack de rede), para cruzar com o stack capturado pelo content script e aumentar a confiança da atribuição.

**Prioridade:** 🔴 Crítica

**Critérios de aceite:**
- O campo `initiator` armazenado inclui `{ type, url, lineNumber, stack: [{ file, fn, line }] }` quando disponível no HAR
- A função `extractInitiator()` normaliza `entry._initiator` do HAR para o mesmo formato do `parseStack()` de H1.1
- Quando `entry._initiator.type === 'script'` e há `stack.callFrames`, todos os frames são extraídos (não apenas o topo)

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T1.2.1 | Criar `extractInitiator(initiator)` | `devtools.js` | Recebe `entry._initiator` do HAR. Se `type === 'script'`, percorre `initiator.stack.callFrames[]` extraindo `{ fn: functionName, file: url, line: lineNumber, col: columnNumber }`. Retorna objeto `{ type, topFrame: frames[0], frames }` |
| T1.2.2 | Substituir extração simples de `initiator` | `devtools.js` | No block atual `const initiator = entry._initiator ? { type, url } : null`, substituir pela chamada a `extractInitiator(entry._initiator)` |
| T1.2.3 | Atualizar `normalizeRequest` para aceitar novo formato | `modules/capture.js` | `initiator` já é passado — apenas garantir que `mergeWithDevtools` preserve `frames[]` e não sobrescreva com o initiator mais simples do content |

---

## E2 — Correlação com padrões frontend Sankhya

**Objetivo:** identificar o "dono" frontend de cada requisição — arquivo JS + função + padrão de chamada — e atribuir um score de confiança.

**Dependências:** E1 (H1.1 e H1.2 devem estar concluídas para que haja stack/initiator para correlacionar).

---

### H2.1 — Criar módulo `correlator.js`

**História:** Como desenvolvedor, quero que a extensão identifique automaticamente qual padrão frontend Sankhya (`ServiceProxy.callService`, `CRUDService.loadRecords`, `ActionExecutor.execute`, etc.) originou a requisição, para saber onde procurar no código sem grep manual.

**Prioridade:** 🔴 Crítica

**Critérios de aceite:**
- `correlate(request)` retorna `{ frontendOwner: { file, fn, pattern, confidence }, hypothesis: string }`
- `confidence` varia de 0.0 a 1.0: ≥ 0.8 = alto, 0.5–0.79 = médio, < 0.5 = baixo
- Padrões reconhecidos cobrem ao menos: `ServiceProxy.callService`, `CRUDService.*`, `ActionExecutor.execute`, `listener`, `openForm`, `loadForm`, `saveForm`, `executeAction`, `notifyListeners`
- Se nenhum padrão for reconhecido, retorna `{ frontendOwner: null, hypothesis: null }`

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T2.1.1 | Criar arquivo `modules/correlator.js` | `modules/correlator.js` | Módulo ES novo, exporta apenas `correlate(request)` |
| T2.1.2 | Definir `FRONTEND_PATTERNS` | `modules/correlator.js` | Array de objetos `{ pattern: RegExp, name: string, confidence: number, category: string }`. Ex: `{ pattern: /ServiceProxy\.callService/i, name: 'ServiceProxy.callService', confidence: 0.95, category: 'service-call' }`. Cobrir: `ServiceProxy`, `CRUDService`, `ActionExecutor`, `openForm`, `loadForm`, `saveForm`, `executeAction`, `notifyListeners`, `listener`, `dispatchEvent`, `triggerEvent` |
| T2.1.3 | Implementar `matchFrames(frames, patterns)` | `modules/correlator.js` | Percorre o array de frames do callStack/initiator, para cada frame testa todos os `FRONTEND_PATTERNS` no `fn` e no `file`. Retorna `{ frame, pattern, confidence }` do primeiro match, ou `null`. Prioriza frames com `fn` explícito sobre frames anônimos |
| T2.1.4 | Implementar `matchByServiceName(serviceName)` | `modules/correlator.js` | Fallback quando não há stack: inferir padrão provável pelo serviceName. Ex: `CRUDService.save` → hipótese `saveForm / CRUDService`, confidence 0.6; `ActionExecutor.execute` → hipótese `executeAction`, confidence 0.55 |
| T2.1.5 | Implementar `correlate(request)` | `modules/correlator.js` | Tenta, em ordem: (1) matchFrames no `callStack`, confiança × 1.0; (2) matchFrames no `initiator.frames`, confiança × 0.85; (3) matchByServiceName, confiança × 0.6. Retorna o melhor resultado |
| T2.1.6 | Integrar `correlate()` no pipeline do `background.js` | `background.js` | Após o passo 9 (classifyRequest), adicionar passo 9.6: `normalized.correlation = correlate(normalized)`. Importar `correlate` de `../modules/correlator.js` |

---

### H2.2 — Campo `frontendOwner` no objeto canônico

**História:** Como desenvolvedor lendo o relatório, quero ver em cada chamada o arquivo JS e a função que provavelmente a originou, com o score de confiança exibido, para poder navegar ao código sem adivinhar.

**Prioridade:** 🔴 Crítica

**Critérios de aceite:**
- O objeto de requisição armazenado tem `correlation: { frontendOwner, hypothesis, confidence }`
- O popup exibe `frontendOwner.file` (basename) e `confidence` ao lado do `serviceName` quando `confidence >= 0.5`
- O relatório texto inclui linha "Frontend provável" nas chamadas SP e críticas

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T2.2.1 | Passar `correlation` pelo `normalizeRequest` | `modules/capture.js` | Adicionar `correlation: raw.correlation ?? null` — o campo existe após o passo 9.6 do pipeline |
| T2.2.2 | Exibir `frontendOwner` no popup | `popup.js` | Na renderização de cada item de chamada, se `req.correlation?.frontendOwner`, adicionar badge com `basename(file)` e percentual de confiança |
| T2.2.3 | Incluir `frontendOwner` no detalhe expansível do relatório | `report.js` | Em `buildDetailContent()`, adicionar seção "Correlação Frontend" com: arquivo, função, padrão, hipótese, confiança |
| T2.2.4 | Incluir `frontendOwner` no texto do relatório para SP e críticos | `modules/reporter.js` | Em `generateTextReport()`, nas seções de auditoria SP e críticos, adicionar linha `Frontend provável : ${file} → ${fn} (confiança: ${Math.round(c*100)}%)` |

---

## E3 — Parser Sankhya ampliado

**Objetivo:** extrair todos os metadados de contexto Sankhya presentes no payload e na resposta, não apenas os campos simples.

**Dependências:** nenhuma — independente de E1/E2.

---

### H3.1 — Novos campos de negócio e contexto de tela

**História:** Como desenvolvedor, quero que o parser extraia `entityName`, `rootEntity`, `event`, `action`, `listener`, `pk`, `formID`, `componentID`, `selectedTab`, `rowid`, `metadata`, `serviceModule` para identificar exatamente qual entidade e qual contexto de tela gerou a chamada.

**Prioridade:** 🟠 Alta

**Critérios de aceite:**
- `BUSINESS_FIELDS_SET` inclui todos os 12 novos campos listados
- `extractBusinessFields` os extrai quando presentes em qualquer nível do JSON
- O campo `pk` (que é um objeto/array) é serializado como string JSON para armazenamento
- `metadata` e `serviceModule` são truncados a 256 chars para não inflar o storage

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T3.1.1 | Adicionar novos campos ao `BUSINESS_FIELDS_SET` | `modules/parser.js` | Adicionar ao Set: `'entityname'`, `'rootentity'`, `'event'`, `'action'`, `'listener'`, `'pk'`, `'formid'`, `'componentid'`, `'selectedtab'`, `'rowid'`, `'metadata'`, `'servicemodule'`, `'transactionid'`, `'correlationid'` |
| T3.1.2 | Tratamento especial para `pk` | `modules/parser.js` | Em `extractBusinessFields`, após o lookup, se `lk === 'pk'` e `typeof value === 'object'`, armazenar `JSON.stringify(value).substring(0, 200)` em vez do objeto bruto |
| T3.1.3 | Truncamento de campos de metadados | `modules/parser.js` | Para `lk === 'metadata' \|\| lk === 'servicemodule'`, se o valor for string longa, truncar a 256 chars antes de armazenar |
| T3.1.4 | Extrair `transactionId` para deduplicação | `modules/parser.js` | `parsePayload` deve expor `transactionId` como campo de topo (não apenas dentro de `businessFields`) para uso pelo fingerprint de E4 |

---

### H3.2 — Reconhecimento de tipos de requisição Sankhya

**História:** Como desenvolvedor, quero que o parser identifique automaticamente o "tipo funcional" de cada chamada (loadGrid, saveRecord, executeRule, openForm, etc.) baseado no serviceName + campos do payload, para que o relatório possa agrupar chamadas por tipo sem depender apenas da categoria do classifier.

**Prioridade:** 🟠 Alta

**Critérios de aceite:**
- `parsePayload` retorna campo `requestType` com enum de tipos conhecidos
- Tipos mínimos: `LOAD_GRID`, `SAVE_RECORD`, `DELETE_RECORD`, `EXECUTE_ACTION`, `OPEN_FORM`, `LOAD_FORM`, `CALL_LISTENER`, `CALL_SP`, `UNKNOWN`
- `CALL_SP` é atribuído sempre que `serviceName` corresponde a padrão SP

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T3.2.1 | Criar `REQUEST_TYPE` enum | `modules/parser.js` | `export const REQUEST_TYPE = Object.freeze({ LOAD_GRID, SAVE_RECORD, DELETE_RECORD, EXECUTE_ACTION, OPEN_FORM, LOAD_FORM, CALL_LISTENER, CALL_SP, UNKNOWN })` |
| T3.2.2 | Criar `inferRequestType(serviceName, businessFields)` | `modules/parser.js` | Regras em ordem: SP → `CALL_SP`; `CRUDService.loadRecords/loadGrid` → `LOAD_GRID`; `CRUDService.save` → `SAVE_RECORD`; `CRUDService.remove/delete` → `DELETE_RECORD`; `ActionExecutor.execute` → `EXECUTE_ACTION`; campo `listener` presente → `CALL_LISTENER`; campo `formID` presente → `OPEN_FORM`; fallback → `UNKNOWN` |
| T3.2.3 | Incluir `requestType` no retorno de `parsePayload` | `modules/parser.js` | `result.requestType = inferRequestType(serviceName, result.businessFields)` antes do `return result` |
| T3.2.4 | Usar `requestType` no `classifier.js` | `modules/classifier.js` | Em `classifyRequest`, ler `parsedPayload.requestType` para refinar classificação: `LOAD_GRID` → `QUERY`, `SAVE_RECORD` → `PERSIST`, `CALL_SP` → `BUSINESS` (com prioridade sobre o match textual atual) |

---

## E4 — Deduplicação por fingerprint robusto

**Objetivo:** evitar colisões (mesma URL, payload diferente) e falsos merge (URLs diferentes, payload coincidente) presentes na deduplicação atual baseada em URL + método + timestamp ±500ms.

**Dependências:** H3.1 (precisa de `transactionId`) e H1.1 (usa initiator para diferenciar).

---

### H4.1 — Fingerprint de requisição

**História:** Como sistema de captura, quero que cada requisição tenha um fingerprint único baseado em URL normalizada + método + hash do payload + serviceName + transactionId, para que duas chamadas ao mesmo endpoint com payloads diferentes NÃO sejam colapsadas e duas chamadas idênticas (conteúdo e timing) SIM sejam reconhecidas como duplicatas.

**Prioridade:** 🟠 Alta

**Critérios de aceite:**
- Duas requisições com mesma URL + método + mesmo serviceName mas `nunota` diferente NÃO são consideradas duplicatas
- A janela de tempo é apenas critério de tiebreak — não o critério principal
- `transactionId` presente no payload torna o fingerprint determinístico
- Performance: fingerprint calculado em < 1ms por requisição

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T4.1.1 | Criar `computeFingerprint(req)` | `modules/capture.js` | Parâmetros: URL normalizada (sem query string de sessão: `mgeSession`, `outputType`, `_`), método, serviceName (da queryString), hash simples do body (soma de char codes dos primeiros 512 chars mod 65536). Retornar string `"${method}|${normalizedUrl}|${sn}|${bodyHash}"` |
| T4.1.2 | Incluir `fingerprint` no objeto normalizado | `modules/capture.js` | Em `normalizeRequest`, adicionar `fingerprint: computeFingerprint(raw)` — calculado ANTES do parse completo para ser rápido |
| T4.1.3 | Atualizar `findDuplicate` para usar fingerprint | `modules/capture.js` | Novo critério: fingerprint idêntico (prioridade 1) OU (URL + método + Δt < 300ms quando sem fingerprint). Remover critério `Δt 500ms` como primário |
| T4.1.4 | Usar `transactionId` como override | `modules/capture.js` | Se `req.parsedPayload.transactionId` estiver presente, substituir o hash de body por esse ID — torna o fingerprint 100% determinístico independente de timing |

---

## E5 — Relatório com hipótese de backend

**Objetivo:** transformar o relatório de "o que foi chamado" em "por que foi chamado, quem chamou e o que provavelmente aconteceu no backend".

**Dependências:** E2 (correlação) e E3 (requestType, novos campos).

---

### H5.1 — Bloco "Chamada principal e backend provável"

**História:** Como desenvolvedor analisando um bug em produção, quero ver um bloco consolidado por chamada mostrando: ação do usuário, arquivo frontend, função, serviceName, entidade/chave, hipótese de classe backend — para poder ir direto ao ponto sem ler 3 páginas de log.

**Prioridade:** 🟠 Alta

**Critérios de aceite:**
- O relatório texto inclui seção "HIPÓTESES DE BACKEND" com até 10 entradas (as de maior relevância)
- Cada entrada mostra: serviceName, requestType, entityName/pk, frontendOwner, hipótese de classe/bean, confiança
- A tab do `report.html` "Chamadas" exibe coluna "Frontend / Hipótese" com badge de confiança colorido
- Hipóteses com confiança < 0.4 mostram badge cinza e texto "baixa confiança"

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T5.1.1 | Criar `BACKEND_HYPOTHESIS_RULES` | `modules/correlator.js` | Array de regras `{ servicePattern, requestType, entityHint, hypothesisTemplate, confidence }`. Ex: `{ servicePattern: /CRUDService\.save/i, requestType: 'SAVE_RECORD', hypothesisTemplate: 'Bean de persistência para ${entityName} — verificar beforeSave/afterSave', confidence: 0.85 }` |
| T5.1.2 | Criar `buildHypothesis(request)` | `modules/correlator.js` | Cruza `serviceName`, `requestType`, `entityName`, `application` com `BACKEND_HYPOTHESIS_RULES`. Retorna `{ hypothesis, beansToInspect: string[], confidence }` |
| T5.1.3 | Integrar `buildHypothesis` no pipeline | `background.js` | No passo 9.6, após `correlate()`, adicionar `normalized.hypothesis = buildHypothesis(normalized)` |
| T5.1.4 | Seção "HIPÓTESES DE BACKEND" no texto | `modules/reporter.js` | Em `generateTextReport`, após sugestões, adicionar seção com top-10 chamadas por score de relevância, cada uma com o bloco consolidado descrito nos critérios de aceite |
| T5.1.5 | Score de relevância técnica | `modules/reporter.js` | Criar `computeRelevanceScore(req)`: pontos por isCritical (+40), isBottleneck (+20), isSP (+15), confidence≥0.8 (+15), tem entityName (+10), tem pk (+10), tem callStack (+5). Usar para ordenar a seção de hipóteses |
| T5.1.6 | Coluna "Frontend / Hipótese" na tabela do relatório | `report.js` | Em `renderCallTable`, adicionar 8ª coluna com badge de confiança e `frontendOwner.file` (basename). CSS: verde ≥0.8, amarelo 0.5–0.79, cinza <0.5 |

---

## E6 — Indexação de Sources via DevTools

**Objetivo:** varrer os scripts carregados na aba monitorada e construir um índice de padrões Sankhya que fundamentem hipóteses com evidência textual do código-fonte.

**Dependências:** E2 (saber quais padrões procurar).

**Nota:** requer `chrome.devtools.inspectedWindow.reload` ou acesso às Sources — viável apenas com painel DevTools aberto.

---

### H6.1 — Varredura de scripts carregados

**História:** Como desenvolvedor, quero que a extensão varra os scripts JS carregados na aba monitorada e indexe ocorrências de padrões Sankhya, para que o relatório mostre evidência textual ("encontrado em app.js linha 1482") ao invés de apenas hipóteses.

**Prioridade:** 🟡 Média

**Critérios de aceite:**
- Ao clicar "Iniciar Sessão", a extensão dispara varredura dos scripts via `chrome.devtools.inspectedWindow.eval`
- O índice é construído em memória: `Map<padrão, [{ file, line, snippet }]>`
- A varredura é assíncrona e não bloqueia a captura de requisições
- Scripts > 5MB são ignorados (bundle minificado de vendor sem valor de diagnóstico)
- O índice fica disponível em `background.js` via Storage ou mensagem

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T6.1.1 | Criar `modules/source-indexer.js` | `modules/source-indexer.js` | Exporta `buildSourceIndex()`: usa `performance.getEntriesByType('resource')` filtrado por `initiatorType === 'script'` para listar scripts carregados; para cada script, usa `fetch()` para obter o conteúdo e varre com regex dos padrões |
| T6.1.2 | Patterns de varredura | `modules/source-indexer.js` | `SOURCE_PATTERNS`: `ServiceProxy\.callService`, `callService\s*\(`, `CRUDService`, `ActionExecutor`, `loadRecords`, `openForm`, `metadata\s*:`, `serviceName\s*:`, `application\s*:`, `resourceID\s*:`. Para cada match: salvar `{ file, lineNum, col, snippet: linha.trim().substring(0,120) }` |
| T6.1.3 | Executar varredura no `devtools.js` | `devtools.js` | Quando página é carregada (`chrome.devtools.network.onNavigated`), disparar `buildSourceIndex()` e enviar índice para background via `chrome.runtime.sendMessage({ action: 'SOURCE_INDEX_READY', index })` |
| T6.1.4 | Armazenar índice no background | `background.js` | Handler `SOURCE_INDEX_READY`: armazena `sourceIndex` em variável de módulo (não no Storage — é grande demais). Disponível para consulta durante o pipeline |

---

## E7 — Correlação com código-fonte JS

**Objetivo:** usar o índice de E6 para elevar a confiança das hipóteses de E2 com evidência textual.

**Dependências:** E6.

---

### H7.1 — Vincular requisição a trecho de código

**História:** Como desenvolvedor, quero que ao ver uma hipótese de "ServiceProxy.callService", o relatório mostre o arquivo e a linha do código que contém esse padrão, para confirmar ou descartar a hipótese sem abrir o código.

**Prioridade:** 🟡 Média

**Critérios de aceite:**
- `correlation.sourceEvidence` é um array de `{ file, line, snippet }` com até 3 ocorrências relevantes
- Oportunidade de cruzamento: o `initiator.topFrame.file` está no índice → match direto (confiança +0.2)
- O trecho exibido no relatório é sanitizado (sem credenciais, sem tokens hardcoded)
- Quando índice não estiver disponível, `sourceEvidence` é `null` e a UI exibe "(DevTools fechado durante captura)"

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T7.1.1 | Criar `lookupEvidence(correlation, sourceIndex)` | `modules/correlator.js` | Busca no sourceIndex por padrão associado ao `frontendOwner.pattern`. Se `initiator.topFrame.file` bate com alguma entrada do índice, eleva confidence em 0.2. Retorna top-3 snippets |
| T7.1.2 | Integrar `lookupEvidence` no pipeline | `background.js` | No passo 9.6, se `sourceIndex` estiver disponível, chamar `lookupEvidence` e mesclar resultado em `normalized.correlation.sourceEvidence` |
| T7.1.3 | Exibir `sourceEvidence` no detalhe da chamada | `report.js` | Em `buildDetailContent`, adicionar seção "Evidência no Código" com accordion mostrando cada snippet `{ file, line, snippet }` formatado como código |

---

## E8 — Timeline de ação do usuário

**Objetivo:** registrar o que o usuário fez (cliques, teclas, mudanças de campo) imediatamente antes de cada requisição para dar contexto funcional ao relatório.

**Dependências:** nenhuma técnica, mas E2 torna os dados mais valiosos.

---

### H8.1 — Captura de eventos do usuário

**História:** Como desenvolvedor, quero ver no relatório "usuário clicou em [Salvar] (button#btn-salvar.btn-primary) às 10:32:15.423, 180ms antes da requisição CRUDService.save", para entender qual ação disparou a chamada.

**Prioridade:** 🟢 Baixa

**Critérios de aceite:**
- A janela de eventos capturados é de 5 segundos antes de cada requisição
- Eventos capturados: `click`, `change`, `submit`, `keydown` (apenas Enter/F2/F5/Escape)
- Para cada evento: `{ type, timestamp, element: { tag, id, name, class, text, dataAttrs } }`
- Eventos em campos `[type=password]` e elementos com `data-sensitive` são ignorados
- O buffer circular de eventos é limitado a 50 entradas para não vazar memória

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T8.1.1 | Buffer circular de eventos | `content-main.js` | `const UI_EVENTS = []` com máx 50 entradas. Listener de `click`, `change`, `submit`, `keydown` no document em fase de captura (3º arg `true`). Cada entrada: `{ type, ts: Date.now(), tag, id, name, cls: className.substring(0,60), text: innerText?.substring(0,40), data: Object.fromEntries([...el.dataset].slice(0,5)) }` |
| T8.1.2 | Segurança: filtrar dados sensíveis | `content-main.js` | Antes de registrar evento, verificar se `el.type === 'password' \|\| el.closest('[data-sensitive]')` — se sim, ignorar. Também omitir `value` do elemento |
| T8.1.3 | Anexar eventos recentes ao `emit()` | `content-main.js` | No `emit()`, incluir `uiContext: UI_EVENTS.slice(-5).filter(e => e.ts > Date.now() - 5000)` — até 5 eventos dos últimos 5 segundos |
| T8.1.4 | Passar `uiContext` pelo `normalizeRequest` | `modules/capture.js` | `uiContext: raw.uiContext ?? null` no objeto normalizado |
| T8.1.5 | Exibir `uiContext` no relatório | `report.js` | Em `buildDetailContent`, seção "Ação do Usuário" listando os eventos: `"[click] button#btn-salvar 'Salvar' — 180ms antes"` |

---

### H8.2 — Snapshot de contexto da tela

**História:** Como desenvolvedor, quero saber qual módulo/tela do Sankhya estava aberto quando a requisição foi disparada (URL, título, breadcrumbs), para reproduzir o cenário sem precisar descrever manualmente.

**Prioridade:** 🟢 Baixa

**Critérios de aceite:**
- Ao iniciar sessão, um snapshot é capturado: `{ url, title, hash, breadcrumbs: string[], activeModule }`
- `breadcrumbs` são extraídos de seletores comuns do Sankhya: `.breadcrumb`, `[class*=breadcrumb]`, `nav ol`
- Snapshot é atualizado quando `window.location.hash` muda (SPA navigation)
- Cada requisição tem `screenContext` referenciando o snapshot vigente ao momento do `emit()`

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T8.2.1 | Capturar snapshot de tela | `content-main.js` | `captureScreenSnapshot()`: retorna `{ url: location.href, title: document.title, hash: location.hash, breadcrumbs: [...document.querySelectorAll('.breadcrumb li, [class*=breadcrumb] li')].map(el => el.innerText.trim()).filter(Boolean).slice(0,6) }` |
| T8.2.2 | Manter snapshot atualizado | `content-main.js` | `window.addEventListener('hashchange', () => { currentSnapshot = captureScreenSnapshot(); })` e captura inicial ao carregar o script |
| T8.2.3 | Incluir `screenContext` no `emit()` | `content-main.js` | Adicionar `screenContext: currentSnapshot` no payload do `emit()` — referência, não cópia (o snapshot é pequeno) |
| T8.2.4 | Exibir `screenContext` no resumo do relatório | `modules/reporter.js` | Em `generateTextReport`, no cabeçalho, adicionar "Tela inicial: ${snapshot.title} (${snapshot.hash})" e breadcrumbs se disponíveis |

---

## E9 — Agrupamento funcional e árvore de fluxo

**Objetivo:** agrupar as requisições em sequências funcionais coerentes (abrir tela → carregar → editar → salvar → recalcular) e exibir como árvore de fluxo com score de confiança.

**Dependências:** E8 (uiContext e screenContext), E2 (requestType), E3 (novos campos).

---

### H9.1 — Agrupamento por fluxo funcional

**História:** Como desenvolvedor, quero ver as chamadas agrupadas por fluxo ("Abertura de NF", "Salvar item", "Recalcular totais") em vez de uma lista plana, para entender a sequência de eventos sem montar o mapa mentalmente.

**Prioridade:** 🟢 Baixa

**Critérios de aceite:**
- Fluxos são inferidos por: continuidade de `application`, proximidade temporal (< 3s entre chamadas), sequências canônicas reconhecidas (ex: `OPEN_FORM → LOAD_GRID → SAVE_RECORD`)
- Cada fluxo tem `{ name, trigger: uiEvent, requests: [], duration: total ms, hasCritical, hasBottleneck }`
- O relatório HTML exibe uma timeline visual com os fluxos como grupos expansíveis
- Chamadas sem fluxo reconhecido são agrupadas em "Chamadas avulsas"

**Tarefas:**

| # | Tarefa | Arquivo | Detalhe |
|---|--------|---------|---------|
| T9.1.1 | Criar `modules/flow-analyzer.js` | `modules/flow-analyzer.js` | Exporta `groupByFlow(requests)`. Algoritmo: ordena por timestamp, agrupa por janelas de 3s com mesmo `application` ativo, detecta padrões de sequência usando `requestType` |
| T9.1.2 | Definir `FLOW_PATTERNS` | `modules/flow-analyzer.js` | Ex: `[OPEN_FORM, LOAD_GRID]` → nome "Abertura de tela"; `[SAVE_RECORD, LOAD_GRID]` → "Salvar e recarregar"; `[EXECUTE_ACTION, CALL_SP, LOAD_GRID]` → "Executar ação com recálculo SP" |
| T9.1.3 | Inferir nome do fluxo | `modules/flow-analyzer.js` | Usar `uiContext.text` do evento disparador (ex: "Salvar") como nome preferencial; fallback para nome do padrão detectado; fallback final: `application + requestType[0]` |
| T9.1.4 | Renderizar timeline de fluxos no relatório | `report.js` | Nova tab "Fluxo" no `report.html`. Para cada fluxo: grupo colapsável com header (nome, duração, contagem) e linhas de chamadas internas ordenadas por timestamp com seu `requestType` e duração |

---

## Dependências entre Épicos

```
E1 (Stack/Initiator)
  └─► E2 (Correlator)
        └─► E5 (Hipóteses de backend)
        └─► E7 (Correlação com fontes)  ◄── E6 (Indexar Sources)

E3 (Parser ampliado)
  └─► E4 (Fingerprint)
  └─► E5 (Hipóteses de backend)

E8 (Timeline usuário)
  └─► E9 (Fluxo funcional)  ◄── E2, E3
```

---

## Ordem de implementação recomendada

```
Sprint 1 (assertividade mínima viável):
  T1.1.x → T1.2.x → T3.1.x → T3.2.x → T4.1.x

Sprint 2 (correlação e hipóteses):
  T2.1.x → T2.2.x → T5.1.x

Sprint 3 (evidência textual):
  T6.1.x → T7.1.x

Sprint 4 (contexto do usuário):
  T8.1.x → T8.2.x

Sprint 5 (mapa completo de fluxo):
  T9.1.x
```

---

## Resultado esperado (relatório pós-implementação)

```
══════════════════════════════════════════════════════════════
  SANKHYA MONITOR — HIPÓTESE DE BACKEND
══════════════════════════════════════════════════════════════

[★ SP] RelatorioNotaFiscalSP.geraRelatorio  ▐ Score: 95/100

  Ação do usuário    : [click] button#btn-imprimir "Imprimir" — 94ms antes
  Tela               : Notas Fiscais · hash=#NF · breadcrumb: NF > Imprimir
  Frontend provável  : sankhya-web/js/nf-print.chunk.js → printReport() (confiança: 88%)
  Evidência no código: nf-print.chunk.js:1482 — ServiceProxy.callService('RelatorioNotaFiscalSP.geraRelatorio')
  serviceName        : RelatorioNotaFiscalSP.geraRelatorio
  Classe SP          : RelatorioNotaFiscalSP
  Classe origem (app): NF
  Entidade / chave   : entityName=NF  pk={"nunota":12345}
  Duração total      : 3.42s  ⚡ GARGALO
  HAR timing         : ttfb:3180ms  rx:240ms  (processamento no servidor: 3.18s)
  Hipótese backend   : Bean RelatorioNotaFiscalSP — verificar geraRelatorio(),
                       queries de busca de itens NF e montagem de layout.
                       Beans relacionados: NFFacade, TGFCABService, TGFITEService
  Confiança hipótese : 88%
```
