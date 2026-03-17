# Sankhya Monitor — Manual de Uso e Análise

> Extensão Chrome para diagnóstico técnico de chamadas HTTP do Sankhya ERP  
> Versão 1.0.0 · Última atualização: 17/03/2026

---

## Sumário

1. [Instalação da Extensão](#1-instalação-da-extensão)
2. [Interface do Popup](#2-interface-do-popup)
3. [Fluxo Básico de Uso](#3-fluxo-básico-de-uso)
4. [Monitorando uma Ação no Sankhya](#4-monitorando-uma-ação-no-sankhya)
5. [Interpretando a Lista de Chamadas](#5-interpretando-a-lista-de-chamadas)
6. [Painel de Detalhes de uma Chamada](#6-painel-de-detalhes-de-uma-chamada)
7. [Relatório Completo](#7-relatório-completo)
8. [Exportação de Dados](#8-exportação-de-dados)
9. [Guia de Análise por Cenário](#9-guia-de-análise-por-cenário)
10. [Categorias e o que cada uma indica](#10-categorias-e-o-que-cada-uma-indica)
11. [Entendendo as Sugestões Geradas](#11-entendendo-as-sugestões-geradas)
12. [Dicas Avançadas](#12-dicas-avançadas)
13. [Solução de Problemas](#13-solução-de-problemas)

---

## 1. Instalação da Extensão

### Pré-requisito
- Google Chrome versão 111 ou superior

### Passos

1. Abra o Chrome e acesse `chrome://extensions`
2. Ative o **Modo do desenvolvedor** (toggle no canto superior direito)
3. Clique em **"Carregar sem compactação"**
4. Selecione a pasta `monitor_tools`
5. A extensão **⬡ Sankhya Monitor** aparecerá na lista

### Fixar no toolbar

Clique no ícone de quebra-cabeça (extensões) na barra do Chrome → clique no ícone de alfinete ao lado de **Sankhya Monitor** para fixá-la na barra de ferramentas.

---

## 2. Interface do Popup

Clique no ícone da extensão para abrir o popup (440px).

```
┌──────────────────────────────────────────┐
│  ⬡ Sankhya Monitor          [?]  [Inativo]│  ← Header
├──────────────────────────────────────────┤
│  [Nome da sessão________________]         │  ← Campo de nome
│  [▶ Iniciar] [■ Finalizar] [↺ Limpar]     │  ← Controles
├──────────────────────────────────────────┤
│  Total  Relevantes  Críticas  T.Máx.      │  ← Cards de estatística
├──────────────────────────────────────────┤
│  Chamadas Capturadas  [Apenas Prioritárias]│
│  ┌──────────────────────────────────────┐ │
│  │ POST  CRUDService.save       1.234ms │ │  ← Lista de chamadas
│  │ POST  ActionExecutor.execute   456ms │ │
│  │  ...                                │ │
│  └──────────────────────────────────────┘ │
├──────────────────────────────────────────┤
│  [📋 Ver Relatório Completo] [⬇JSON] [⬇TXT]│  ← Footer
└──────────────────────────────────────────┘
```

### Botão `?` — Instruções rápidas

Clique no `?` no header para mostrar/ocultar o painel de ajuda rápida com:
- Passo a passo de uso
- Legenda de categorias com cores
- Dicas de exportação

---

## 3. Fluxo Básico de Uso

```
  [1] Abrir Sankhya        [2] Nomear + Iniciar    [3] Executar ação
  na aba do Chrome    →    sessão no popup     →   no Sankhya ERP
         │                                               │
         │                                               ▼
  [5] Ver Relatório   ←    [4] Finalizar sessão   Chamadas aparecem
  / Exportar               no popup               na lista em tempo real
```

**Regra de ouro:** uma sessão = uma ação. Não misture ações diferentes na mesma sessão para que a análise seja precisa.

---

## 4. Monitorando uma Ação no Sankhya

### Passo a passo detalhado

**Passo 1 — Preparação**

Abra a aba do Sankhya ERP com a operação que deseja analisar. Navegue até a tela onde a ação será executada, mas **não a execute ainda**.

**Passo 2 — Nomeie a sessão**

No popup, preencha o campo **"Nome da sessão"** com uma descrição clara:
- ✔ `Inclusão de NF de Compra - Fornecedor XYZ`
- ✔ `Aprovação de Pedido 45230`
- ✔ `Geração de Relatório de Estoque`
- ✘ `teste` — evite nomes genéricos

**Passo 3 — Inicie o monitoramento**

Clique em **▶ Iniciar**. O badge no header muda para **Monitorando** (verde pulsante).

> O popup pode ficar aberto ou fechado durante o monitoramento. A captura ocorre em background.

**Passo 4 — Execute a ação**

Volte para a aba do Sankhya e execute a ação normalmente: clique em salvar, confirmar, calcular, etc. Aguarde a conclusão visual da operação no Sankhya (mensagem de sucesso ou erro exibida).

**Passo 5 — Finalize a sessão**

Abra o popup e clique em **■ Finalizar**. O badge muda para **Sessão Finalizada**.

> Clique com agilidade após a ação concluir. Aguardar muito tempo pode capturar chamadas de polling ou de outras abas.

**Passo 6 — Analise**

Clique em **📋 Ver Relatório Completo** para abrir a análise detalhada em nova aba.

---

## 5. Interpretando a Lista de Chamadas

Cada linha na lista representa uma chamada HTTP capturada:

```
[POST]  CRUDService.save                          2.341ms
        /mge/service.sbr                         PERSISTÊNCIA
```

| Elemento | Descrição |
|----------|-----------|
| Badge de método | `POST` (azul), `GET` (verde), `PUT` (amarelo), `DELETE` (vermelho) |
| Nome principal | `serviceName` da chamada (ou path da URL se não houver) |
| URL abreviada | Path da URL sem query string |
| Tempo | Duração total da chamada em ms ou segundos |
| Categoria | Classificação funcional (veja seção 10) |

### Ordenação

A lista é ordenada por prioridade:
1. Chamadas **CRÍTICAS** aparecem primeiro (borda vermelha)
2. Depois, ordenadas por **tempo decrescente** (mais lentas primeiro)

### Filtro "Apenas Prioritárias"

Mostra somente chamadas com uma ou mais das condições:
- `isCritical`: retornou erro
- `isBottleneck`: levou mais de 2 segundos
- Categoria `REGRA DE NEGÓCIO` ou `PERSISTÊNCIA`
- URL contém `/mge/service.sbr`

### Cards de estatística

| Card | O que mede |
|------|-----------|
| **Total** | Todas as chamadas capturadas, incluindo assets |
| **Relevantes** | Excluindo IRRELEVANTE (assets e polling) |
| **Críticas** | Com erro HTTP 5xx ou exceção no body |
| **T. Máx.** | Maior tempo de resposta entre as relevantes |

---

## 6. Painel de Detalhes de uma Chamada

Clique em qualquer chamada na lista para expandir o painel de detalhes na parte inferior do popup.

### Campos exibidos

| Campo | Descrição |
|-------|-----------|
| `serviceName` | Serviço Java invocado (ex: `CRUDService.save`) |
| `application` | Bean/classe da aplicação (ex: `SwNota`) |
| `resourceID` | ID do recurso de interface |
| `status HTTP` | Código HTTP da resposta |
| `tempo` | Duração em ms ou segundos |
| `classificação` | Categoria + flags GARGALO e CRÍTICO |
| `timestamp` | Horário exato da chamada |
| Campos de negócio | `nunota`, `codemp`, `codparc`, `codprod`, etc. (quando presentes) |
| `payload` | Primeiros 120 chars do body da requisição |
| `response` | Primeiros 120 chars do body da resposta |
| `⚠ erro` | Mensagem de erro extraída (se houver) |

### Sugestões rápidas no painel

Abaixo dos detalhes, a seção **"Sugestões backend"** mostra ações diretas para investigar aquela chamada específica:
- `Procurar "CRUDService.save" no backend`
- `Verificar bean/classe "SwNota"`
- `Investigar queries lentas / índices de banco`

---

## 7. Relatório Completo

Clique em **📋 Ver Relatório Completo** para abrir o relatório em uma nova aba.

### Abas do relatório

#### Aba "Chamadas"

Tabela completa com todas as chamadas relevantes, ordenadas por tempo decrescente.

Colunas: Método · Path · serviceName · application · Tempo · Status HTTP · Classificação

**Clique em qualquer linha** para expandir o acordeon com:
- Query Parameters completos
- Campos de negócio encontrados
- Detalhes da classificação e motivos
- Erro detectado (se crítico)
- Request body e response (resumidos)

#### Aba "Críticas"

Mostra apenas chamadas com `isCritical = true`. Use para focar rapidamente em falhas.

#### Aba "Sugestões"

Lista consolidada e deduplicada de investigações backend para a sessão inteira:

```
→ Procurar por "CRUDService.save" no backend
→ Verificar classe/bean "SwNota"
→ Validar triggers e regras de persistência (beforeSave/afterSave)
→ Investigar gargalo em "CRUDService.loadRecords" — verificar queries lentas e índices
→ Verificar logs do servidor de aplicação para stack traces
→ Analisar mensagens de erro no console do Sankhya Server
```

#### Aba "Relatório Texto"

Relatório completo em texto plano pronto para copiar ou exportar. Formato estruturado com seções:
- Cabeçalho da sessão
- Resumo estatístico
- Chamadas ordenadas por tempo
- Seção de erros críticos
- Sugestões de investigação

---

## 8. Exportação de Dados

### JSON (`⬇ JSON`)

Exporta a sessão completa como arquivo `.json` com todos os dados brutos:
- Todos os requests com campos completos
- Payloads e responses (até 4096 bytes)
- Classificações e motivos
- Estatísticas

**Uso:** enviar para análise automatizada, importar em scripts de backend, arquivar para comparação futura.

**Nome do arquivo:** `sankhya-monitor-sessao.json`

### TXT (`⬇ TXT`)

> Disponível apenas após **finalizar** a sessão (■ Finalizar).

Exporta o relatório em texto plano formatado.

**Uso:** compartilhar com o time de backend por e-mail, ticket Zendesk, Slack — sem necessidade de ferramentas especiais para leitura.

**Nome do arquivo:** `sankhya-monitor-{nome-da-sessao}.txt`

### Exemplo de relatório TXT

```
==============================================================
SANKHYA MONITOR — RELATÓRIO DE SESSÃO
==============================================================
Sessão:    Inclusão de NF de Compra
Início:    17/03/2026 10:30:15
Fim:       17/03/2026 10:30:52
Duração:   00:00:37

RESUMO
------------------------------------------
Total de chamadas:     47
Chamadas relevantes:   12
Chamadas críticas:      1
Gargalos (>2s):         2
Tempo máximo:       3.241s
Tempo médio:          487ms

CHAMADAS POR CATEGORIA
------------------------------------------
PERSISTÊNCIA            3
CONSULTA/CARGA          6
REGRA DE NEGÓCIO        2
CONFIGURAÇÃO            1

CHAMADAS ORDENADAS POR TEMPO
==============================================================
[1] CRUDService.save                              3.241s  PERSISTÊNCIA ⚡
    URL: /mge/service.sbr
    App: SwNota | Status: 200
...
```

---

## 9. Guia de Análise por Cenário

### Cenário A — "A operação está lenta"

**Objetivo:** identificar qual serviço está causando lentidão.

1. Execute a sessão e finalize
2. No relatório, abra a aba **Chamadas** — estão ordenadas da mais lenta para a mais rápida
3. Identifique chamadas com badge de tempo **amarelo** (> 500ms) ou **vermelho** (> 2s)
4. Expanda a linha para ver o `serviceName` e `application`
5. Vá para a aba **Sugestões** e procure:
   - `Investigar gargalo em "..."` — indica o serviço a otimizar
   - `Verificar índices de banco de dados nas tabelas envolvidas`
6. Exporte o TXT e compartilhe com o DBA/backend com o `serviceName` e `entityName` identificados

**Checklist de análise backend:**
- [ ] O serviço faz `SELECT *` sem paginação?
- [ ] Existem índices na chave de busca principal?
- [ ] A query usa `LIKE '%valor%'` (full scan)?
- [ ] O serviço é chamado múltiplas vezes (N+1)?

---

### Cenário B — "A operação retorna erro"

**Objetivo:** identificar a causa raiz do erro.

1. Execute a sessão e finalize
2. No relatório, vá diretamente para a aba **Críticas**
3. Expanda a linha com borda vermelha — procure o campo **"⚠ Erro Detectado"**
4. Note a mensagem de erro:
   - `NullPointerException` → bug em Java no servidor
   - `ORA-XXXXX` → erro no banco Oracle (constraint, sequência esgotada, deadlock)
   - `status: "1"` + mensagem → regra de negócio rejeitou a operação
5. Note o `serviceName` e `application` da chamada crítica
6. Exporte o TXT com a seção de erros críticos completa

**Perguntas-chave para o backend:**
- Qual `serviceName` retornou o erro?
- Qual o `nunota` / `codparc` / `codemp` da operação?
- O erro ocorre para todos os usuários ou apenas este?
- O log do WildFly/JBoss mostra a stack trace completa?

---

### Cenário C — "Quero entender o que o Sankhya faz nessa operação"

**Objetivo:** mapear todos os serviços envolvidos numa ação específica.

1. Execute a sessão com a ação desejada
2. No relatório, veja os cards:
   - **Relevantes** = total de serviços chamados
   - **byCategory** = distribuição funcional
3. Na aba **Chamadas**, identifique a sequência:
   - Quais são `CONSULTA/CARGA`? → pré-carregamentos de dados
   - Quais são `PERSISTÊNCIA`? → o que é gravado no banco
   - Quais são `REGRA DE NEGÓCIO`? → validações e listeners disparados
4. Compare com a documentação do Sankhya para validar se os serviços esperados foram chamados
5. Use a aba **Sugestões** para obter a lista de classes Java envolvidas

---

### Cenário D — "A operação parece estar fazendo chamadas desnecessárias"

**Objetivo:** identificar chamadas redundantes ou excessivas.

1. Ative o filtro **"Apenas Prioritárias"** no popup durante o monitoramento
2. Note se o mesmo `serviceName` aparece múltiplas vezes seguidas
3. No relatório completo, verifique:
   - Chamadas repetidas de `CONSULTA/CARGA` com o mesmo parâmetro podem indicar problema de cache
   - Múltiplas chamadas de `CONFIGURAÇÃO` no início indicam overhead de inicialização
4. Total muito alto (> 50 chamadas para uma ação simples) pode indicar componentes de UI carregando dados desnecessários

---

## 10. Categorias e o que cada uma indica

### CONFIGURAÇÃO

Chamadas de leitura e gravação de configurações e preferências do sistema.

**serviceName típicos:** `SystemUtilsSP.saveConf`, `SystemUtilsSP.loadConf`, `UserPreferenceSP.*`

**O que verificar no backend:**
- A configuração é salva/lida com frequência desnecessária?
- Seria possível fazer cache local no frontend?

---

### CONSULTA/CARGA

Chamadas que carregam listas, grids e registros para exibição.

**serviceName típicos:** `CRUDService.loadRecords`, `CRUDService.load`, `DbExplorerSP.findRecords`

**O que verificar no backend:**
- Quantas linhas estão sendo retornadas?
- Existe paginação?
- Os índices do banco cobrem os campos de filtro?
- O campo `entityName` indica qual tabela/view está sendo consultada

---

### PERSISTÊNCIA

Chamadas que gravam, alteram ou removem registros no banco.

**serviceName típicos:** `CRUDService.save`, `CRUDService.remove`

**O que verificar no backend:**
- Quais triggers são disparados na entidade?
- Existem callbacks `beforeSave` / `afterSave` com lógica pesada?
- Campo `entityName` indica qual tabela é alvo da operação
- Campo `nunota` indica o registro específico modificado

---

### REGRA DE NEGÓCIO

Chamadas que executam lógica de negócio: ações, validações e eventos.

**serviceName típicos:** `ActionExecutor.execute`, `BusinessRulesSP.*`, chamadas de listeners

**O que verificar no backend:**
- Qual `action` ou `event` foi disparado?
- Existem listeners registrados para este evento que podem estar gerando overhead?
- A regra faz chamadas adicionais ao banco de dados?

---

### GARGALO ⚡

Qualquer chamada que levou mais de **2 segundos** para responder.

Flag independente — uma chamada pode ser PERSISTÊNCIA + GARGALO simultaneamente.

**O que verificar no backend:**
- Queries N+1 (loop chamando o banco repetidamente)
- Ausência de índice no campo de busca
- Lock de tabela por outra transação
- Processamento pesado em Java (cálculo de impostos, geração de PDF, etc.)

---

### CRÍTICO ⚠

Chamadas com HTTP 500+ **ou** com exceção Java/Oracle/Sankhya detectada no body da resposta.

> **Atenção:** o Sankhya frequentemente retorna HTTP **200** mesmo para erros de negócio. A extensão detecta esses casos via padrão no body da resposta.

**Tipos de erro detectados:**
- `NullPointerException` — bug no código Java do servidor
- `ORA-XXXXX` — erro do banco Oracle (ex: ORA-00001 = constraint única violada)
- `status: "1"` — erro de regra de negócio Sankhya (ex: validação de estoque)
- `stackTrace` — modo debug expondo stack trace no response
- HTTP 500, 503 — erro do servidor de aplicação

---

### APOIO / BAIXA RELEVÂNCIA

Chamadas para `/mge/` sem `serviceName` reconhecido. São relevantes mas não categorizadas.

**O que verificar:** abre a chamada no painel de detalhes e inspeciona o path e o payload manualmente.

---

### IRRELEVANTE

Nunca exibido na lista. Filtrado automaticamente.

Inclui: `.png`, `.css`, `.js`, `.woff`, `.map`, polling/heartbeat, keep-alive.

---

## 11. Entendendo as Sugestões Geradas

A extensão gera sugestões consolidadas baseadas em **padrões encontrados em toda a sessão**, não em uma chamada isolada.

### Tipos de sugestão

| Sugestão | Gerada quando |
|----------|--------------|
| `Procurar por "X" no backend` | serviceName X é chamado |
| `Verificar classe/bean "X"` | application X é identificada |
| `Inspecionar resourceID "X"` | resourceID X está presente |
| `Validar listener: "X"` | campo listener encontrado no payload |
| `Verificar evento: "X"` | campo event encontrado no payload |
| `Validar triggers e regras de persistência` | categoria PERSISTÊNCIA detectada |
| `Investigar gargalo em "X"` | `isBottleneck = true` em alguma chamada |
| `Verificar índices de banco de dados` | qualquer gargalo detectado |
| `Verificar logs do servidor` | `isCritical = true` em alguma chamada |
| `Analisar erro: "..."` | mensagem de erro extraída do response |
| `Revisar ActionExecutors registrados` | `ActionExecutor` no serviceName |
| `Analisar regras de validação CRUD` | `CRUDService` presente |

### Como usar as sugestões

As sugestões são **pontos de partida** para a investigação, não conclusões. Use-as para:

1. **Focar** a busca no código backend — procure o `serviceName` exato no repositório Java
2. **Priorizar** — comece pelos erros críticos, depois pelos gargalos
3. **Comunicar** — inclua as sugestões no ticket/chamado para o time de backend saber onde procurar

---

## 12. Dicas Avançadas

### Comparar antes e depois

Para medir o impacto de uma otimização:
1. Capture uma sessão **antes** da mudança → exporte como JSON com nome `antes-otimizacao.json`
2. Aplique a otimização no servidor
3. Capture a mesma ação **depois** → exporte como JSON com nome `depois-otimizacao.json`
4. Compare os campos `duration` do mesmo `serviceName` entre os dois arquivos

### Usar DevTools para captura mais precisa

Quando precisar ver o **body completo** da resposta (sem truncamento de 4096 bytes):
1. Abra o DevTools do Chrome (F12) **antes** de iniciar a sessão
2. Vá para a aba **Network**
3. A extensão usará automaticamente a captura via DevTools (fonte secundária)
4. Os dados capturados via DevTools tendem a ser mais completos para respostas grandes

### Boas práticas de nomenclatura de sessão

Inclua no nome:
- A **ação** realizada (ex: "Inclusão", "Aprovação", "Consulta")
- O **contexto** (ex: "NF de Compra", "Pedido de Venda")
- O **ambiente** se relevante (ex: "prod", "hml")

Exemplo: `Aprovação NF 12345 - prod - 17/03/2026`

### Capturar seletivamente

Se a ação que deseja analisar é precedida de muitas navegações:
1. Navegue até a tela desejada sem iniciar o monitoramento
2. **Só então** inicie a sessão
3. Execute **apenas** a ação a ser analisada
4. Finalize imediatamente após a conclusão

Isso reduz o "ruído" de chamadas de navegação e carregamento de tela.

---

## 13. Solução de Problemas

### "Nenhuma chamada capturada" após executar ação

**Causas prováveis:**

| Causa | Solução |
|-------|---------|
| Extensão foi recarregada sem recarregar a aba | Recarregue a aba do Sankhya (F5) e tente novamente |
| A sessão não foi iniciada antes da ação | Inicie a sessão antes de executar a ação |
| A ação usa WebSockets em vez de XHR/fetch | Não suportado — apenas chamadas HTTP são capturadas |
| URL da instância Sankhya não contém `/mge/` | Verifique se a instância está correta |

---

### "Extension context invalidated" nos logs do DevTools

Isso ocorre quando a extensão é recarregada enquanto a aba do Sankhya está aberta. É inofensivo para a aplicação. Para resolver:

1. Acesse `chrome://extensions`
2. Recarregue a extensão Sankhya Monitor (ícone de atualização)
3. **Recarregue a aba do Sankhya** (F5) — isso injeta o novo content script
4. Use normalmente

---

### A lista mostra chamadas que não são do Sankhya

O filtro **"Apenas Prioritárias"** ou **"Chamadas Relevantes"** exclui automaticamente assets e trackers. Se ainda aparecerem chamadas indesejadas:

1. No relatório, chamadas **IRRELEVANTE** são filtradas automaticamente
2. Use o filtro **"Apenas Prioritárias"** no popup para ver apenas o que importa
3. Verifique se não há outros scripts na página gerando XHR (ex: chat de suporte, analytics)

---

### O tempo máximo parece errado (muito alto)

O primeiro load de uma tela pode incluir carregamento inicial de dados que não fazem parte da ação a ser analisada. Para evitar:

1. Carregue a tela completamente **antes** de iniciar a sessão
2. Inicie a sessão apenas quando a tela estiver pronta para receber a ação
3. O tempo máximo refletirá apenas as chamadas da ação monitorada

---

### O relatório TXT não está disponível

O relatório TXT só é gerado ao clicar em **■ Finalizar**. Se o popup foi fechado antes de finalizar:

1. Abra o popup novamente
2. Clique em **■ Finalizar**
3. O botão **⬇ TXT** ficará disponível

---

### Chamadas aparecem duplicadas no relatório

A duplicação usa uma janela de 500ms. Em conexões muito lentas (> 500ms de latência de rede), a mesma chamada capturada por duas fontes (content script + DevTools) pode aparecer duas vezes.

**Solução:** feche o DevTools durante a sessão de monitoramento para usar apenas a fonte primária (content script).

---

*Para dúvidas técnicas sobre a extensão, consulte o arquivo [DOCUMENTACAO.md](./DOCUMENTACAO.md).*
