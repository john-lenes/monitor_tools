# Sankhya Monitor — Documentação Técnica

> Versão 1.0.0 · Manifest V3 · Chrome 111+  
> Última atualização: 17/03/2026

---

## Sumário

1. [Visão Geral](#1-visão-geral)
2. [Arquitetura do Sistema](#2-arquitetura-do-sistema)
3. [Estrutura de Arquivos](#3-estrutura-de-arquivos)
4. [Módulos e Responsabilidades](#4-módulos-e-responsabilidades)
5. [Fluxo de Dados](#5-fluxo-de-dados)
6. [Máquina de Estados da Sessão](#6-máquina-de-estados-da-sessão)
7. [Pipeline de Processamento](#7-pipeline-de-processamento)
8. [Classificação de Chamadas](#8-classificação-de-chamadas)
9. [Domínio Sankhya (Referência Técnica)](#9-domínio-sankhya-referência-técnica)
10. [Modelo de Dados](#10-modelo-de-dados)
11. [APIs Chrome Utilizadas](#11-apis-chrome-utilizadas)
12. [Segurança](#12-segurança)
13. [Limitações Conhecidas](#13-limitações-conhecidas)

---

## 1. Visão Geral

O **Sankhya Monitor** é uma extensão Chrome (Manifest V3) que intercepta, classifica e exibe um relatório técnico de todas as chamadas HTTP executadas pelo frontend do Sankhya ERP durante uma ação do usuário.

**Objetivo principal:** permitir que desenvolvedores backend identifiquem quais serviços Java são chamados, em que ordem, com que payload, e quais retornam erros ou lentidão — sem precisar instrumentar o servidor.

**Casos de uso:**
- Diagnóstico de lentidão em operações do Sankhya (gargalos)
- Identificação de serviços com erro silencioso (HTTP 200 com `status: "1"` no body)
- Mapeamento de dependências de serviços para uma ação específica
- Geração de relatório técnico para suporte ao time backend

---

## 2. Arquitetura do Sistema

```
┌──────────────────────────────────────────────────────────────────────┐
│  ABA DO CHROME (página do Sankhya)                                   │
│                                                                      │
│  ┌─────────────────────────────────────┐                             │
│  │  content-main.js  (world: MAIN)     │  ← mesmo escopo JS da página│
│  │  • Monkey-patch XMLHttpRequest      │                             │
│  │  • Monkey-patch fetch               │                             │
│  │  • Filtra URLs irrelevantes         │                             │
│  │  └──── window.postMessage ──────────┼──────────────────────┐      │
│  └─────────────────────────────────────┘                      │      │
│                                                                │      │
│  ┌─────────────────────────────────────┐                      │      │
│  │  content-bridge.js  (ISOLATED)      │◄─────────────────────┘      │
│  │  • Recebe postMessage               │                             │
│  │  • Mantém flag isMonitoring local   │                             │
│  │  • Lida com contexto invalidado     │                             │
│  │  └──── chrome.runtime.sendMessage ──┼───────────────────────┐     │
│  └─────────────────────────────────────┘                       │     │
└────────────────────────────────────────────────────────────────┼─────┘
                                                                  │
┌─────────────────────────────────────────────────────────────────▼─────┐
│  SERVICE WORKER  (background.js)                                       │
│                                                                        │
│  processAndStore()  ← REQUEST_CAPTURED  (content-bridge)               │
│  processAndStore()  ← DEVTOOLS_REQUEST_CAPTURED  (devtools.js)         │
│                                                                        │
│  Pipeline: isWorthProcessing → normalizeRequest → isDuplicate          │
│           → parseQueryParams → parsePayload → parseResponse            │
│           → classifyRequest → persist (chrome.storage.local)           │
│           → notify popup                                               │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ chrome.storage.local
                         ┌──────────┼──────────┐
                         ▼          ▼          ▼
                    popup.html  report.html  devtools.js
```

### Estratégia de Captura Dupla

| Fonte | Arquivo | Mundo | Quando ativo | Vantagem |
|-------|---------|-------|-------------|----------|
| PRIMARY | `content-main.js` | MAIN | Sempre (toda aba) | Não exige DevTools aberto |
| SECONDARY | `devtools.js` | DevTools page | Só com DevTools aberto | Body da resposta via HAR |

O `background.js` deduplica as duas fontes com uma janela de **500ms**: se duas capturas chegarem com a mesma URL, método e timestamp próximos, apenas a primeira é processada.

---

## 3. Estrutura de Arquivos

```
monitor_tools/
├── manifest.json          # Manifesto MV3 — permissions, scripts, devtools_page
├── background.js          # Service Worker — controle central da sessão
├── content-main.js        # Content Script MAIN — intercepta XHR e fetch
├── content-bridge.js      # Content Script ISOLATED — ponte MAIN → background
├── devtools.html          # DevTools page stub (carrega devtools.js)
├── devtools.js            # Captura secundária via chrome.devtools.network
├── popup.html             # Interface do popup (440px, tema escuro)
├── popup.js               # Controlador do popup
├── report.html            # Página de relatório completo (nova aba)
├── report.js              # Módulo ES do relatório — usa modules/reporter.js
├── modules/
│   ├── capture.js         # normalizeRequest, isDuplicate, isWorthProcessing
│   ├── parser.js          # parseQueryParams, parsePayload, parseResponse
│   ├── classifier.js      # classifyRequest, CATEGORIES
│   └── reporter.js        # getSessionStats, generateSuggestions, generateTextReport
├── DOCUMENTACAO.md        # Este arquivo
└── MANUAL.md              # Manual de uso e análise
```

**Total:** ~3.300 linhas | 14 arquivos | Zero dependências externas

---

## 4. Módulos e Responsabilidades

### `modules/capture.js`

| Função | Descrição |
|--------|-----------|
| `generateRequestId()` | ID único baseado em timestamp + contador com rollover a 100.000 |
| `normalizeRequest(raw, source)` | Cria objeto canônico a partir de dados brutos (agnostico à fonte) |
| `sanitizeHeaders(headers)` | Limita valores a 256 chars — previne overflow de cookies |
| `isDuplicate(req, existing)` | Janela de 500ms entre fontes. Compara URL + método + timestamp |
| `isWorthProcessing(url, method)` | Pré-filtro rápido: aceita /mge/, mutations, rejeita assets e GETs simples |

### `modules/parser.js`

| Função | Descrição |
|--------|-----------|
| `parseQueryParams(url)` | Extrai serviceName, application, resourceID, globalID, mgeSession, outputType |
| `parsePayload(body)` | 3 estratégias: JSON direto → form-encoded com JSON em `data` → form-encoded plano |
| `extractBusinessFields(obj)` | Recursivo até prof. 5 — extrai nunota, codemp, codparc, codprod, etc. |
| `parseResponse(body)` | Detecta erros Java/Oracle/Sankhya — retorna `hasError`, `errorMessage`, `summary` |

**Estratégias de parsePayload:**

```
[Tentativa 1] body é JSON direto
  → JSON.parse(body) → extrai businessFields

[Tentativa 2] body é form-encoded com campo `data` contendo JSON
  → decodeURIComponent(params.get('data')) → JSON.parse → extrai businessFields
  Exemplo: data=%7B%22serviceName%22%3A%22CRUDService.save%22...%7D

[Tentativa 3] body é form-encoded plano
  → URLSearchParams(body) → converte para objeto plano
```

**Padrões de erro detectados em responses:**

| Padrão | Origem |
|--------|--------|
| `NullPointerException` | Bug de Java no servidor Sankhya |
| `ORA-\d{5}` | Código de erro do banco Oracle |
| `"status"\s*:\s*"1"` | Código de erro Sankhya (status 0 = OK, 1 = erro) |
| `stackTrace\|stacktrace` | Modo debug — stack trace exposta no JSON |
| `\"error\"\s*:` | Campo de erro genérico no response body |

### `modules/classifier.js`

Cadeia de classificação (em ordem de prioridade):

1. **IRRELEVANTE** — asset estático ou polling/heartbeat → descartado
2. **CRÍTICO** — HTTP 5xx → erro de servidor WildFly/JBoss
3. **CRÍTICO** — `parsedResponse.hasError` → exceção ou status Sankhya 1
4. **GARGALO** — `duration > 2000ms` → perceptível como lentidão pelo usuário (flag independente)
5. **Categoria funcional** — via `classifyByServiceName()` (veja tabela abaixo)
6. **APOIO** — chamada /mge/ sem serviceName reconhecido

**Mapeamento de serviceName → categoria:**

| Padrão no serviceName | Categoria |
|----------------------|-----------|
| `.save`, `.update`, `.delete`, `.remove`, `CRUD` | PERSISTÊNCIA |
| `.load`, `.list`, `.search`, `.find`, `.get`, `Query` | CONSULTA/CARGA |
| `Action`, `execute`, `BusinessRule`, `Listener`, `Event` | REGRA DE NEGÓCIO |
| `SystemUtils`, `saveConf`, `loadConf`, `Config`, `Preference` | CONFIGURAÇÃO |
| Sem match | APOIO/BAIXA RELEVÂNCIA |

### `modules/reporter.js`

| Função | Descrição |
|--------|-----------|
| `getSessionStats(requests)` | Totais: total, relevant, critical, bottlenecks, maxDuration, avgDuration, byCategory |
| `generateSuggestions(requests)` | Lista deduplicada de sugestões por serviceName, application, resourceID, erros |
| `generateTextReport(session)` | Relatório completo em texto plano para exportação .txt |

---

## 5. Fluxo de Dados

```
Usuário executa ação no Sankhya
        │
        ▼
window.XMLHttpRequest.send() / window.fetch()
  [content-main.js — MAIN world]
        │ captura url, method, body, status, duration, headers
        │
        ▼ window.postMessage({ type: '__SNKY_MON_CAPTURE__', data })
        │
content-bridge.js [ISOLATED]
  • Verifica isMonitoring
  • Verifica event.source === window
  • Verifica contextValid (proteção contra extensão recarregada)
        │
        ▼ chrome.runtime.sendMessage({ action: 'REQUEST_CAPTURED' })
        │
background.js [Service Worker]
  processAndStore():
    isWorthProcessing() → normalizeRequest() → isDuplicate()
    → parseQueryParams() → parsePayload() → parseResponse()
    → classifyRequest()
    → chrome.storage.local.set()
    → chrome.runtime.sendMessage({ action: 'REQUEST_ADDED' }) → popup
        │
        ├── popup.html: renderiza lista em tempo real (polling 1500ms)
        └── report.html: carrega sessão completa ao abrir
```

---

## 6. Máquina de Estados da Sessão

```
        ┌─────────────────────────────────────────────┐
        │                                             │
        ▼                                             │
      [idle] ──── START_SESSION ───► [monitoring] ──── STOP_SESSION ───► [finished]
        ▲                                                                      │
        └──────────────────────── CLEAR_SESSION ◄─────────────────────────────┘
```

| Estado | Storage key value | O que é permitido |
|--------|------------------|-------------------|
| `idle` | `"idle"` | Iniciar nova sessão |
| `monitoring` | `"monitoring"` | Capturar requests, finalizar |
| `finished` | `"finished"` | Ver relatório, exportar, limpar |

**Storage keys:**
- `sankhya_monitor_state` → string do estado atual
- `sankhya_monitor_session` → objeto JSON da sessão com array `requests`

---

## 7. Pipeline de Processamento

Executado em `processAndStore()` no `background.js` para cada request recebido:

```
[1] isWorthProcessing(url, method)
    Aceita:  /mge/, POST, PUT, DELETE
    Rejeita: data:, blob:, .png/.css/.js, GETs simples sem /mge/
    Custo: ~O(1) — sem regex pesada

[2] isStaticAsset(url)
    Regex de extensões: png, jpg, gif, svg, ico, css, js, woff, ttf, map...

[3] isPolling(url)
    Regex de padrões: /keepalive, /heartbeat, /ping, /poll...

[4] normalizeRequest(raw, source)
    Mapeia campos divergentes entre content script e DevTools (statusCode vs status)
    Limita requestBody e responseBody a 4096 bytes
    Limita valores de headers a 256 chars

[5] isDuplicate(normalized, existing)
    Compara url + method em requests dos últimos 500ms
    Retorna true se encontrar correspondência → descarta

[6] parseQueryParams(url)
    new URL(url).searchParams → extrai serviceName, application, resourceID...

[7] parsePayload(requestBody)
    3 estratégias em ordem (veja seção 4)
    Retorna: { raw, businessFields, strategy }

[8] parseResponse(responseBody)
    Testa padrões de erro com regex
    Retorna: { hasError, errorMessage, summary }

[9] classifyRequest(normalized)
    Cadeia de 6 verificações (veja seção 4)
    Retorna: { category, isCritical, isBottleneck, reasons }

[10] persist + notify
    session.requests.push(normalized)
    chrome.storage.local.set(...)
    chrome.runtime.sendMessage({ action: 'REQUEST_ADDED', stats })
```

---

## 8. Classificação de Chamadas

### Categorias (enum `CATEGORIES`)

| Constante | Valor exibido | Cor no popup |
|-----------|--------------|-------------|
| `CONFIG` | CONFIGURAÇÃO | Azul claro |
| `QUERY` | CONSULTA/CARGA | Verde-água |
| `PERSIST` | PERSISTÊNCIA | Roxo claro |
| `BUSINESS` | REGRA DE NEGÓCIO | Roxo forte |
| `BOTTLENECK` | GARGALO | Amarelo |
| `CRITICAL` | CRÍTICO | Vermelho |
| `SUPPORT` | APOIO/BAIXA RELEVÂNCIA | Cinza |
| `IRRELEVANT` | IRRELEVANTE | Nunca exibido |

### Flags adicionais (independentes da categoria)

- **`isCritical`** — `true` se HTTP 5xx OU erro no response body. Uma chamada PERSISTÊNCIA pode também ser CRÍTICA.
- **`isBottleneck`** — `true` se `duration > 2000ms`. Uma chamada CONFIGURAÇÃO pode ser GARGALO.

---

## 9. Domínio Sankhya (Referência Técnica)

### Formato da URL

```
POST /mge/service.sbr?serviceName=CRUDService.save&application=SwCadParc&outputType=json
Content-Type: application/x-www-form-urlencoded

data=%7B%22serviceName%22%3A%22CRUDService.save%22%2C%22requestBody%22%3A%7B...%7D%7D
```

### Campos de negócio extraídos

| Campo | Significado no Sankhya |
|-------|----------------------|
| `nunota` | Número único da nota fiscal / pedido |
| `codemp` | Código da empresa (multi-empresa) |
| `codparc` | Código do parceiro (cliente / fornecedor) |
| `codprod` | Código do produto |
| `nuseq` | Número de sequência de linha |
| `entityName` | Nome da entidade do banco de dados |
| `action` | Nome da ação executada |
| `event` | Nome do evento disparado |
| `listener` | Listener de regra de negócio acionado |
| `serviceName` | Classe.método Java invocado |
| `application` | Bean/classe Java da aplicação |
| `resourceID` | ID de recurso de interface |

### Formatos de response

**Formato 1 — responseBody com status:**
```json
{
  "responseBody": {
    "status": "0",
    "msg": "Registro salvo com sucesso"
  }
}
```

**Formato 2 — status no raiz:**
```json
{
  "status": {
    "value": "1",
    "message": "Estoque insuficiente"
  }
}
```

`status: "0"` = sucesso · `status: "1"` = erro de negócio (HTTP permanece 200)

---

## 10. Modelo de Dados

### Objeto `session` (em `chrome.storage.local`)

```typescript
interface Session {
  name:       string;        // nome dado pelo usuário
  requests:   Request[];     // array de requests capturados
  startedAt:  number | null; // Date.now() no inicio
  finishedAt: number | null; // Date.now() ao finalizar
  textReport: string | null; // gerado por generateTextReport()
}
```

### Objeto `Request` (normalizado)

```typescript
interface Request {
  id:              string;   // timestamp_contador (ex: "1710000000000_42")
  url:             string;
  method:          string;   // "GET" | "POST" | "PUT" | "DELETE"
  status:          number;   // HTTP status code
  duration:        number;   // ms entre send() e loadend
  timestamp:       number;   // Date.now() no momento do envio
  source:          string;   // "content" | "devtools"
  requestBody:     string | null;  // truncado a 4096 bytes
  responseBody:    string | null;  // truncado a 4096 bytes
  requestHeaders:  Record<string, string>; // valores truncados a 256 chars
  responseHeaders: Record<string, string>;

  // Enriquecido pelo pipeline:
  queryParams:     QueryParams;
  parsedPayload:   ParsedPayload;
  parsedResponse:  ParsedResponse;
  classification:  Classification;
}

interface Classification {
  category:     string;   // valor de CATEGORIES
  isCritical:   boolean;
  isBottleneck: boolean;
  reasons:      string[]; // motivos legíveis (ex: "HTTP 500 — erro de servidor")
}
```

---

## 11. APIs Chrome Utilizadas

| API | Onde | Para quê |
|-----|------|---------|
| `chrome.storage.local` | background, content-bridge | Persistir sessão e estado |
| `chrome.storage.onChanged` | content-bridge | Sincronizar flag isMonitoring sem polling |
| `chrome.runtime.sendMessage` | todos os scripts | Comunicação entre contextos |
| `chrome.runtime.onMessage` | background | Receber mensagens |
| `chrome.tabs.create` | popup.js | Abrir report.html em nova aba |
| `chrome.runtime.getURL` | popup.js | URL do report.html |
| `chrome.devtools.network.onRequestFinished` | devtools.js | Captura secundária via HAR |
| `chrome.scripting` | — | Declarado no manifest (necessário para MV3) |

---

## 12. Segurança

| Vetor | Mitigação implementada |
|-------|----------------------|
| XSS na lista de chamadas | `escHtml()` escapa todo conteúdo antes de inserir no DOM |
| Cookie leak via headers | `sanitizeHeaders()` limita valores a 256 chars |
| Body overflow no storage | Truncamento a 4096 bytes em requestBody e responseBody |
| Mensagens de iframes externos | `event.source === window` verificado no content-bridge |
| Extensão recarregada (context invalidated) | Flag `contextValid` + `removeEventListener` ao detectar erro |
| SSRF via URLs externas | Extensão só lê dados — nunca faz requisições pelo usuário |

---

## 13. Limitações Conhecidas

| Limitação | Causa | Contorno |
|-----------|-------|---------|
| Body perdido após reload da extensão | Chrome invalida o contexto do content script | Recarregar a aba do Sankhya |
| Respostas binárias (PDF, XLS) não são lidas | `response.text()` falha em conteúdo binário | Apenas o status HTTP é registrado |
| Service Worker pode ser pausado pelo Chrome | Comportamento normal do MV3 | Próxima mensagem o reinicia automaticamente |
| Body de responses volumosas truncado | Limite de 4096 bytes para proteger o storage | Usar DevTools para inspecionar o body completo |
| Chamadas de iframes internos não capturadas | `all_frames: false` no manifest | A maioria das chamadas do Sankhya não usa iframes isolados |
| DevTools precisa estar aberto para captura secundária | Restrição da API chrome.devtools | Fonte primária (content-main.js) cobre os casos principais |
