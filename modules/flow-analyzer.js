/**
 * flow-analyzer.js — Agrupamento funcional de requisições em fluxos coerentes.
 *
 * ÉPICOS COBERTOS:
 *  E9 — Agrupamento por fluxo funcional.
 *  M10 — Árvore de fluxo com relacionamento pai-filho.
 *
 * Objetivo: em vez de exibir uma lista plana de chamadas, identificar sequências
 * funcionais significativas (ex: "Abertura de NF", "Salvar e recarregar",
 * "Executar ação com recálculo SP") e agrupá-las como fluxos com nome, duração
 * e contexto da ação do usuário.
 *
 * M10 — Árvore de fluxo:
 *  - Cada fluxo expõe `tree`: array raiz de nós com filhos.
 *  - Um nó é "raiz" se não há chamada anterior com o mesmo serviceName em menos de 300ms.
 *  - Chamadas cascata (load pós-save, listeners pós-action) viram filhos do pai.
 *  - A saída inclui por fluxo: ação do usuário, tela, frontend provável, chamada
 *    principal, chamadas derivadas, backend hipotético, erro/gargalo principal.
 *
 * EXPORTS:
 *  groupByFlow(requests)  — retorna array de fluxos com árvore de chamadas
 */

// ---------------------------------------------------------------------------
// Padrões de sequência funcionais reconhecidos
// ---------------------------------------------------------------------------

/**
 * FLOW_PATTERNS — sequências de requestType que indicam um fluxo funcional específico.
 *
 * sequence: array de requestType em ordem (a sequência deve aparecer no grupo)
 * name: nome descritivo do fluxo em português
 * partial: se true, a sequência pode ser um sub-conjunto (não precisa ser exata)
 */
const FLOW_PATTERNS = [
  {
    sequence: ['OPEN_FORM', 'LOAD_GRID'],
    name:     'Abertura de tela',
    partial:  true,
  },
  {
    sequence: ['SAVE_RECORD', 'LOAD_GRID'],
    name:     'Salvar e recarregar',
    partial:  true,
  },
  {
    sequence: ['EXECUTE_ACTION', 'CALL_SP', 'LOAD_GRID'],
    name:     'Executar ação com recálculo SP',
    partial:  true,
  },
  {
    sequence: ['EXECUTE_ACTION', 'LOAD_GRID'],
    name:     'Executar ação e recarregar',
    partial:  true,
  },
  {
    sequence: ['CALL_SP', 'LOAD_GRID'],
    name:     'Processamento SP com recarga',
    partial:  true,
  },
  {
    sequence: ['SAVE_RECORD', 'CALL_SP'],
    name:     'Salvar com validação SP',
    partial:  true,
  },
  {
    sequence: ['DELETE_RECORD', 'LOAD_GRID'],
    name:     'Excluir e recarregar',
    partial:  true,
  },
  {
    sequence: ['CALL_LISTENER'],
    name:     'Evento de listener',
    partial:  false,
  },
  {
    sequence: ['CALL_SP'],
    name:     'Chamada SP',
    partial:  false,
  },
  {
    sequence: ['SAVE_RECORD'],
    name:     'Salvar registro',
    partial:  false,
  },
  {
    sequence: ['LOAD_GRID'],
    name:     'Carregar dados',
    partial:  false,
  },
];

// Janela de agrupamento temporal (ms) — chamadas com gap > 3s iniciam novo fluxo
const FLOW_WINDOW_MS = 3000;

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

/**
 * Verifica se a sequência de tipos de request presente num grupo contém
 * a sequência de padrão especificada (na ordem correta, não necessariamente contínua).
 *
 * @param {string[]} groupTypes   array de requestType do grupo
 * @param {string[]} patternSeq   sequência do padrão a detectar
 * @returns {boolean}
 */
function matchesSequence(groupTypes, patternSeq) {
  let patIdx = 0;
  for (const t of groupTypes) {
    if (t === patternSeq[patIdx]) {
      patIdx++;
      if (patIdx >= patternSeq.length) return true;
    }
  }
  return false;
}

/**
 * Detecta qual FLOW_PATTERN melhor descreve o grupo de chamadas.
 *
 * @param {string[]} types  array de requestType das chamadas no grupo
 * @returns {string}  nome do fluxo detectado
 */
function detectFlowName(types) {
  // Testa padrões da mais específica (maior sequência) à mais genérica
  const sorted = [...FLOW_PATTERNS].sort((a, b) => b.sequence.length - a.sequence.length);
  for (const p of sorted) {
    if (matchesSequence(types, p.sequence)) return p.name;
  }
  return 'Chamadas avulsas';
}

/**
 * Infere o nome do fluxo preferindo o texto do evento de UI disparador.
 *
 * @param {Object[]} requests  chamadas do fluxo
 * @param {string}   patternName  nome inferido pelo FLOW_PATTERNS
 * @returns {string}
 */
function inferFlowName(requests, patternName) {
  // Usa o texto do evento mais recente de UI como nome preferencial
  for (const req of requests) {
    const uiCtx = req.uiContext;
    if (!uiCtx?.length) continue;
    const clickEvent = uiCtx.find((e) => e.type === 'click' && e.text);
    if (clickEvent) return `${patternName} — "${clickEvent.text.substring(0, 30)}"`;
  }
  return patternName;
}

// ---------------------------------------------------------------------------
// Export principal
// ---------------------------------------------------------------------------

/**
 * Agrupa as requisições em fluxos funcionais coerentes.
 *
 * @param {Object[]} requests  todas as chamadas normalizadas da sessão
 * @returns {Array<{
 *   name: string,
 *   application: string|null,
 *   trigger: Object|null,
 *   requests: Object[],
 *   duration: number,
 *   hasCritical: boolean,
 *   hasBottleneck: boolean,
 *   hasSP: boolean
 * }>}
 */
export function groupByFlow(requests = []) {
  if (!requests.length) return [];

  // Ordena por timestamp (garante ordem cronológica)
  const sorted = [...requests]
    .filter((r) => r.classification?.category !== 'IRRELEVANTE')
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  if (!sorted.length) return [];

  const flows   = [];
  let   current = [sorted[0]];

  // Agrupa por janela temporal de FLOW_WINDOW_MS e por application
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur  = sorted[i];

    const prevApp = prev.queryParams?.application ?? prev.parsedPayload?.businessFields?.application ?? null;
    const curApp  = cur.queryParams?.application  ?? cur.parsedPayload?.businessFields?.application  ?? null;

    const timeDiff = (cur.timestamp || 0) - (prev.timestamp || 0);
    const sameApp  = !prevApp || !curApp || prevApp === curApp;

    if (timeDiff <= FLOW_WINDOW_MS && sameApp) {
      current.push(cur);
    } else {
      flows.push(buildFlow(current));
      current = [cur];
    }
  }
  if (current.length) flows.push(buildFlow(current));

  return flows;
}

/**
 * M10 — Constrói a árvore de chamadas de um fluxo.
 *
 * Algoritmo de relacionamento pai-filho:
 *  - Chamadas são candidatas a "filho" quando:
 *    a. Ocorrem DEPOIS de outra chamada (Δt positivo)
 *    b. Δt < CASCADE_WINDOW_MS (500ms — janela de cascata)
 *    c. requestType indica que são derivadas (ex: LOAD_GRID após SAVE_RECORD)
 *  - Apenas a primeira chamada não-cascata é raiz.
 *  - Chamadas que não se encaixam como filho viram raízes adicionais.
 *
 * @param {Object[]} reqs  chamadas ordenadas por timestamp
 * @returns {Object[]}  nós raiz com filhos recursivos
 */
const CASCADE_WINDOW_MS = 800; // folga de tempo para considerar cascata
const CASCADE_TYPES = new Set(['LOAD_GRID', 'CALL_LISTENER', 'CALL_SP']); // tipos que surgem naturalmente como cascata

function buildFlowTree(reqs) {
  if (!reqs.length) return [];

  // Cria nós com campo `children`
  const nodes = reqs.map((req, i) => ({
    id:             req.id || String(i),
    req,
    depth:          0,
    isRoot:         false,
    children:       [],
    parentId:       null,
    requestType:    req.parsedPayload?.requestType  ?? 'UNKNOWN',
  }));

  // Algoritmo de atribuição: para cada nó, procura o pai mais próximo anterior
  const assigned = new Set();
  const roots    = [];

  for (let i = 0; i < nodes.length; i++) {
    const cur   = nodes[i];
    let   parent = null;

    // Procura o nó anterior mais próximo que poderia ser pai (dentro da janela de cascata)
    for (let j = i - 1; j >= 0; j--) {
      const prev   = nodes[j];
      const deltaT = (cur.req.timestamp || 0) - (prev.req.timestamp || 0);
      if (deltaT > CASCADE_WINDOW_MS) break; // muito distante — para de procurar

      // Só é filho se o tipo atual é "derivado" de algum tipo de ação
      if (CASCADE_TYPES.has(cur.requestType)) {
        parent = prev;
        break;
      }
    }

    if (parent) {
      cur.parentId = parent.id;
      cur.depth    = parent.depth + 1;
      parent.children.push(cur);
      assigned.add(cur.id);
    } else {
      cur.isRoot = true;
      roots.push(cur);
    }
  }

  return roots;
}

/**
 * Constrói um objeto de fluxo a partir de um grupo de chamadas.
 * M10: adiciona `tree` (árvore de chamadas), `mainCall` (raiz principal),
 * `derivedCalls` (cascatas), `primaryError`, `primaryBottleneck`, `frontendHint`.
 *
 * @param {Object[]} reqs  chamadas do grupo
 * @returns {Object}
 */
function buildFlow(reqs) {
  const types         = reqs.map((r) => r.parsedPayload?.requestType ?? 'UNKNOWN');
  const patternName   = detectFlowName(types);
  const name          = inferFlowName(reqs, patternName);
  const application   = reqs
    .map((r) => r.queryParams?.application ?? r.parsedPayload?.businessFields?.application)
    .find(Boolean) ?? null;

  // Evento de UI disparador: o mais recente antes da primeira chamada
  const firstReq = reqs[0];
  const trigger  = firstReq?.uiContext?.length
    ? firstReq.uiContext[firstReq.uiContext.length - 1]
    : null;

  const startTs  = reqs[0].timestamp || 0;
  const endTs    = reqs[reqs.length - 1].timestamp || 0;
  const duration = endTs - startTs + (reqs[reqs.length - 1].duration || 0);

  // M10: árvore de chamadas
  const tree = buildFlowTree(reqs);

  // M10: chamada principal (primeira raiz, geralmente o trigger do fluxo)
  const mainCallNode   = tree[0] ?? null;
  const mainCall       = mainCallNode?.req ?? reqs[0];

  // M10: chamadas derivadas (filhas da raiz + outras raízes além da primeira)
  const derivedCalls = reqs.filter((r) => r.id !== mainCall?.id);

  // M10: erro principal (mais grave no fluxo)
  const primaryError = reqs.find((r) => r.parsedResponse?.hasError && r.classification?.isCritical)
    ?? reqs.find((r) => r.parsedResponse?.hasError);

  // M10: gargalo principal (maior duração)
  const primaryBottleneck = reqs
    .filter((r) => r.classification?.isBottleneck)
    .sort((a, b) => (b.duration || 0) - (a.duration || 0))[0] ?? null;

  // M10: dica de frontend (da correlação com maior confiança no fluxo)
  const frontendHint = reqs
    .filter((r) => r.correlation?.confidence >= 0.5)
    .sort((a, b) => (b.correlation.confidence || 0) - (a.correlation.confidence || 0))
    .map((r) => ({
      fn:         r.correlation.frontendOwner?.fn ?? r.correlation.patternHint ?? null,
      file:       r.correlation.frontendOwner?.file ?? null,
      confidence: r.correlation.confidence,
      source:     r.correlation.source ?? null,
    }))[0] ?? null;

  // M10: tela (extraída do screenContext da primeira chamada)
  const screenContext = firstReq?.screenContext ?? null;

  return {
    name,
    application,
    trigger,
    requests:     reqs,
    duration,
    hasCritical:  reqs.some((r) => r.classification?.isCritical),
    hasBottleneck: reqs.some((r) => r.classification?.isBottleneck),
    hasSP:        reqs.some((r) => {
      const sn = r.queryParams?.serviceName ?? r.parsedPayload?.businessFields?.serviceName;
      return sn && /\bSP\./i.test(sn);
    }),
    // M10: saída enriquecida
    tree,
    mainCall,
    derivedCalls,
    primaryError,
    primaryBottleneck,
    frontendHint,
    screenContext,
  };
}
