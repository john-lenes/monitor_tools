/**
 * flow-analyzer.js — Agrupamento funcional de requisições em fluxos coerentes.
 *
 * ÉPICO E9 — Agrupamento por fluxo funcional.
 *
 * Objetivo: em vez de exibir uma lista plana de chamadas, identificar sequências
 * funcionais significativas (ex: "Abertura de NF", "Salvar e recarregar",
 * "Executar ação com recálculo SP") e agrupá-las como fluxos com nome, duração
 * e contexto da ação do usuário.
 *
 * ALGORITMO:
 *  1. Ordena chamadas por timestamp
 *  2. Agrupa em "janelas" de 3 segundos com mesmo application ativo
 *  3. Detecta padrões de sequência via requestType
 *  4. Nomeia cada fluxo pelo evento de UI disparador ou pelo padrão detectado
 *
 * EXPORTS:
 *  groupByFlow(requests)  — retorna array de fluxos com suas chamadas internas
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
 * Constrói um objeto de fluxo a partir de um grupo de chamadas.
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
  };
}
