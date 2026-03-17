# ⬡ Sankhya Monitor

> Extensão Chrome (Manifest V3) para diagnóstico técnico de chamadas HTTP do Sankhya ERP.

Captura, classifica e gera relatórios de todas as requisições HTTP executadas pelo Sankhya durante uma ação do usuário — sem proxy, sem configuração de rede e sem impacto no ambiente.

---

## Funcionalidades

- **Captura dual**: intercepta `XMLHttpRequest` e `fetch` diretamente no contexto da página (MAIN world) + captura via DevTools Network HAR (quando o DevTools estiver aberto)
- **Classificação automática**: categoriza cada chamada em `CONFIGURAÇÃO`, `CONSULTA/CARGA`, `PERSISTÊNCIA`, `REGRA DE NEGÓCIO`, `GARGALO` ou `CRÍTICO`
- **Detecção de erros**: identifica `NullPointerException`, `ORA-XXXXX`, `status:"1"` e `stackTrace` retornados como HTTP 200 pelo Sankhya
- **Serviços SP**: identifica e destaca automaticamente chamadas de classes SP (`RelatorioBalanceteSP`, `AvisoSistemaSP`, etc.) com a classe de origem vinculada
- **Relatório completo**: tabela com acordeon, abas de críticas, sugestões backend e relatório em texto plano
- **Exportação**: JSON (dados brutos) e TXT (relatório formatado para compartilhar)
- **Sugestões geradas**: lista deduplica de pontos de investigação no backend (serviceName, application, resourceID, erros)

---

## Instalação

> Requisito: Google Chrome 111 ou superior

1. Faça o download ou clone este repositório:
   ```bash
   git clone https://github.com/john-lenes/monitor_tools.git
   ```
2. Abra o Chrome e acesse `chrome://extensions`
3. Ative o **Modo do desenvolvedor** (toggle no canto superior direito)
4. Clique em **"Carregar sem compactação"**
5. Selecione a pasta `monitor_tools`
6. A extensão **⬡ Sankhya Monitor** aparecerá na lista

Para fixar na barra: clique no ícone de quebra-cabeça → alfinete ao lado de **Sankhya Monitor**.

---

## Uso rápido

```
[1] Abrir Sankhya        [2] Nomear + Iniciar    [3] Executar ação
na aba do Chrome    →    sessão no popup     →   no Sankhya ERP
       │                                               │
       │                                               ▼
[5] Ver Relatório   ←    [4] Finalizar sessão   Chamadas aparecem
/ Exportar               no popup               na lista em tempo real
```

**Regra de ouro:** uma sessão = uma ação. Não misture ações diferentes na mesma sessão.

---

## Estrutura do projeto

```
monitor_tools/
├── manifest.json          # Manifest V3 — permissões e pontos de entrada
├── background.js          # Service worker — estado, pipeline de processamento
├── content-main.js        # Interceptor XHR/fetch no contexto MAIN world
├── content-bridge.js      # Bridge ISOLATED → relay para o service worker
├── devtools.html          # Página do DevTools panel
├── devtools.js            # Captura secundária via HAR (Network)
├── popup.html             # UI do popup (440px)
├── popup.js               # Controlador do popup
├── report.html            # Página de relatório completo (nova aba)
├── report.js              # Módulo ES para report.html
└── modules/
    ├── capture.js         # Normalização e deduplicação de requisições
    ├── parser.js          # Parsing de payload, response e campos de negócio
    ├── classifier.js      # Classificação automática de chamadas
    └── reporter.js        # Estatísticas, sugestões e geração do relatório TXT
```

---

## Arquitetura

```
  Página Sankhya (MAIN world)
  ┌──────────────────────────────────────┐
  │  content-main.js                     │
  │  ├── Patcha window.XMLHttpRequest    │
  │  └── Override window.fetch           │
  │       └── window.postMessage ──────────────────────────┐
  └──────────────────────────────────────┘                 │
                                                           ▼
  Extensão (ISOLATED world)                       content-bridge.js
  ┌──────────────────────────────────────┐         ├── Ouve postMessage
  │  background.js (Service Worker)      │◄────────┤── chrome.runtime.sendMessage
  │  ├── handleMessage()                 │         └── Gerencia invalidação de contexto
  │  ├── processAndStore() [10 passos]   │
  │  │   ├── capture.js  (normaliza)     │
  │  │   ├── parser.js   (interpreta)    │
  │  │   └── classifier.js (classifica) │
  │  └── chrome.storage.local           │
  └──────────────────────────────────────┘
           ▲
           │ HAR (secundário, quando DevTools está aberto)
  devtools.js
```

---

## Categorias de classificação

| Categoria | Quando é atribuída |
|---|---|
| `CONFIGURAÇÃO` | serviceName contém `saveConf`, `SystemUtils`, `preference` |
| `CONSULTA/CARGA` | serviceName contém `.load`, `.find`, `.get`, `loadRecords` |
| `PERSISTÊNCIA` | serviceName contém `.save`, `.update`, `.remove`, `CRUDService.save` |
| `REGRA DE NEGÓCIO` | serviceName contém `execute`, `ActionExecutor`, `listener`, `workflow` |
| `GARGALO ⚡` | duração > 2 segundos |
| `CRÍTICO ⚠` | HTTP 5xx **ou** exceção Java/Oracle no body da resposta |
| `SERVIÇO SP` | className antes do `.` termina com `SP` (ex: `RelatorioBalanceteSP.geraBalancete`) |
| `APOIO/BAIXA RELEVÂNCIA` | chamada MGE sem serviceName reconhecido |
| `IRRELEVANTE` | asset estático (`.js`, `.css`, `.png`…) ou polling/heartbeat |

---

## Relatório TXT — exemplo

```
==============================================================
  SANKHYA MONITOR — RELATÓRIO DE SESSÃO
==============================================================

Sessão: Inclusão de NF de Compra
Início: 17/03/2026, 10:30:15

------------------------------------------
RESUMO
------------------------------------------
Total de chamadas capturadas : 47
Chamadas relevantes          : 12
Chamadas críticas            : 1
Gargalos (> 2s)              : 2
Tempo máximo de resposta     : 3.24s
Tempo médio (relevantes)     : 487ms

------------------------------------------
SERVIÇOS SP — CLASSE DE ORIGEM
------------------------------------------

  Serviço SP    : RelatorioBalanceteSP.geraBalancete
  Classe SP     : RelatorioBalanceteSP
  Método        : geraBalancete
  Classe origem : RelatorioBalanceteVerificacao
  Tempo         : 2.05s  |  Status HTTP: 200
  ⚡ GARGALO

------------------------------------------
SUGESTÕES PARA ANÁLISE BACKEND
------------------------------------------
  • Inspecionar classe SP "RelatorioBalanceteSP" — verificar implementação e parâmetros
  • Verificar classe de origem "RelatorioBalanceteVerificacao" vinculada ao SP
  • Investigar gargalo em "RelatorioBalanceteSP.geraBalancete" — verificar queries lentas
  ...
```

---

## Documentação

| Arquivo | Conteúdo |
|---|---|
| [DOCUMENTACAO.md](./DOCUMENTACAO.md) | Referência técnica completa: arquitetura, módulos, fluxo de dados, interfaces TypeScript, APIs Chrome utilizadas |
| [MANUAL.md](./MANUAL.md) | Manual do usuário: instalação, uso passo a passo, cenários de análise, troubleshooting |

---

## Requisitos técnicos

- Chrome 111+ (Manifest V3 + ES Modules em service worker)
- Nenhuma dependência externa — zero `node_modules`
- Nenhuma comunicação com servidores externos — tudo local

---

## Limitações conhecidas

- Não captura WebSockets (apenas XHR e fetch)
- Payload e response truncados em 4096 bytes
- Captura encerra se a extensão for recarregada sem recarregar a aba do Sankhya
- DevTools precisa estar aberto para ativar a captura secundária via HAR

---

## Licença

MIT — use, modifique e distribua livremente.
