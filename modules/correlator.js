/**
 * correlator.js — Correlação de requisições HTTP com padrões frontend e hipóteses de backend.
 *
 * ÉPICOS COBERTOS:
 *  E2 — Identifica qual arquivo JS / padrão frontend Sankhya originou cada chamada.
 *  E5 — Gera hipóteses de qual classe/bean backend provavelmente processou a chamada.
 *
 * FLUXO:
 *  correlate(request)
 *    → tenta matchFrames(callStack)            [confiança × 1.0]
 *    → tenta matchFrames(initiator.frames)     [confiança × 0.85]
 *    → tenta matchByServiceName(serviceName)   [confiança × 0.6]
 *
 *  buildHypothesis(request)
 *    → cruza serviceName + requestType + entityName com BACKEND_HYPOTHESIS_RULES
 *    → retorna hipótese textual + beans a inspecionar + confiança
 *
 *  lookupEvidence(correlation, sourceIndex)
 *    → busca snippets no índice de fontes construído pelo source-indexer.js (E6)
 *    → eleva confiança quando o arquivo do topFrame está no índice
 *
 *  computeRelevanceScore(req)
 *    → pontuação para ordenar chamadas na seção de hipóteses do relatório
 */

// ---------------------------------------------------------------------------
// Padrões de código frontend Sankhya reconhecidos
// ---------------------------------------------------------------------------

/**
 * FRONTEND_PATTERNS — padrões que indicam a origem de uma chamada HTTP no código JS do Sankhya.
 * Cada padrão é testado contra o nome da função (`fn`) e o arquivo (`file`) de cada frame.
 *
 * confidence: probabilidade de que este padrão seja de fato a origem
 *  1.0 — certeza (padrão muito específico)
 *  0.9 — muito provável
 *  0.7 — provável
 *  0.55 — possível
 */
const FRONTEND_PATTERNS = [
  // Chamadas de serviço via ServiceProxy (padrão central do Sankhya web)
  { pattern: /ServiceProxy\.callService/i,  name: 'ServiceProxy.callService',  confidence: 0.95, category: 'service-call' },
  { pattern: /callService\b/i,              name: 'callService',               confidence: 0.85, category: 'service-call' },

  // Operações CRUD via cliente web
  { pattern: /CRUDService\b/i,              name: 'CRUDService',               confidence: 0.85, category: 'crud' },
  { pattern: /loadRecords\b/i,              name: 'CRUDService.loadRecords',   confidence: 0.90, category: 'query' },

  // Executor de ações Sankhya
  { pattern: /ActionExecutor\.execute/i,    name: 'ActionExecutor.execute',    confidence: 0.90, category: 'action' },
  { pattern: /ActionExecutor\b/i,           name: 'ActionExecutor',            confidence: 0.75, category: 'action' },
  { pattern: /executeAction\b/i,            name: 'executeAction',             confidence: 0.80, category: 'action' },

  // Abertura e carregamento de formulários Sankhya
  { pattern: /openForm\b/i,                 name: 'openForm',                  confidence: 0.85, category: 'navigation' },
  { pattern: /loadForm\b/i,                 name: 'loadForm',                  confidence: 0.85, category: 'navigation' },
  { pattern: /saveForm\b/i,                 name: 'saveForm',                  confidence: 0.85, category: 'persist' },

  // Listeners e eventos do framework Sankhya
  { pattern: /notifyListeners\b/i,          name: 'notifyListeners',           confidence: 0.80, category: 'event' },
  { pattern: /dispatchEvent\b/i,            name: 'dispatchEvent',             confidence: 0.70, category: 'event' },
  { pattern: /triggerEvent\b/i,             name: 'triggerEvent',              confidence: 0.75, category: 'event' },
  { pattern: /\blistener\b/i,               name: 'listener',                  confidence: 0.55, category: 'event' },
];

// ---------------------------------------------------------------------------
// Regras de hipótese de backend
// ---------------------------------------------------------------------------

/**
 * BACKEND_HYPOTHESIS_RULES — regras para inferir qual bean/classe Java processou a chamada.
 * Ordenadas da mais específica à mais genérica.
 *
 * servicePattern: RegExp testada contra o serviceName
 * requestType: string (do enum REQUEST_TYPE) — null = qualquer tipo
 * entityHint: campo de businessFields a exibir como chave primária
 * hypothesisTemplate: string com ${entityName} / ${pk} / ${application} substituídos
 * beansToInspect: lista de beans/classes típicos a verificar
 * confidence: 0.0–1.0
 */
const BACKEND_HYPOTHESIS_RULES = [
  // CRUDService — persistência
  {
    servicePattern:    /CRUDService\.save/i,
    requestType:       'SAVE_RECORD',
    hypothesisTemplate: 'Bean de persistência para ${entityName} — verificar beforeSave/afterSave em ${application}',
    beansToInspect:    ['CRUDServiceProvider', 'IBeforeSaveListener', 'IAfterSaveListener'],
    confidence:        0.85,
  },
  {
    servicePattern:    /CRUDService\.remove|CRUDService\.delete/i,
    requestType:       'DELETE_RECORD',
    hypothesisTemplate: 'Bean de remoção para ${entityName} — verificar beforeDelete em ${application}',
    beansToInspect:    ['CRUDServiceProvider', 'IBeforeDeleteListener'],
    confidence:        0.82,
  },
  {
    servicePattern:    /CRUDService\.loadRecords|CRUDService\.loadGrid/i,
    requestType:       'LOAD_GRID',
    hypothesisTemplate: 'Consulta de registros para ${entityName} — verificar DataSetProvider e critérios de filtro em ${application}',
    beansToInspect:    ['DataSetProvider', 'ILoadRecordsFilter'],
    confidence:        0.80,
  },

  // ActionExecutor — regras de negócio
  {
    servicePattern:    /ActionExecutor\.execute/i,
    requestType:       'EXECUTE_ACTION',
    hypothesisTemplate: 'Ação de negócio "${action}" disparada em ${application} — localizar ActionExecutor registrado',
    beansToInspect:    ['ActionExecutor', 'IAction', 'ICustomAction'],
    confidence:        0.85,
  },

  // Service Providers SP — processamento especializado
  {
    servicePattern:    /\bSP\./i,
    requestType:       'CALL_SP',
    hypothesisTemplate: 'Classe SP ${serviceName} — verificar implementação do método e parâmetros de entrada; classe origem: ${application}',
    beansToInspect:    ['${spClass}', 'IServiceProvider'],
    confidence:        0.88,
  },

  // Listeners
  {
    servicePattern:    /listener/i,
    requestType:       'CALL_LISTENER',
    hypothesisTemplate: 'Listener "${listener}" registrado em ${application} — verificar IEntitySaveListener ou IFormListener',
    beansToInspect:    ['IEntitySaveListener', 'IFormListener', 'IEventListener'],
    confidence:        0.78,
  },

  // Abertura de formulário
  {
    servicePattern:    /.*/,
    requestType:       'OPEN_FORM',
    hypothesisTemplate: 'Abertura de formulário ${application} — verificar IFormLoader e metadados de tela',
    beansToInspect:    ['IFormLoader', 'FormMetaDataProvider'],
    confidence:        0.65,
  },

  // Fallback genérico para qualquer chamada com application
  {
    servicePattern:    /.*/,
    requestType:       null,
    hypothesisTemplate: 'Chamada a ${serviceName} via ${application} — verificar implementação do serviço correspondente',
    beansToInspect:    [],
    confidence:        0.40,
  },
];

// ---------------------------------------------------------------------------
// Funções auxiliares
// ---------------------------------------------------------------------------

/**
 * Testa um array de frames contra os FRONTEND_PATTERNS.
 * Retorna o melhor match (maior confiança) ou null.
 *
 * @param {Array<{fn:string, file:string, line:number, col:number}>|null} frames
 * @returns {{ frame: Object, pattern: Object, confidence: number }|null}
 */
function matchFrames(frames) {
  if (!frames || !frames.length) return null;
  let best = null;

  for (const frame of frames) {
    const haystack = `${frame.fn || ''} ${frame.file || ''}`;
    for (const p of FRONTEND_PATTERNS) {
      if (p.pattern.test(haystack)) {
        // Frames com fn explícito (não anônimo) têm +0.05 de bônus
        const frameBonus = (frame.fn && frame.fn !== '(anonymous)') ? 0.05 : 0;
        const conf = Math.min(1.0, p.confidence + frameBonus);
        if (!best || conf > best.confidence) {
          best = { frame, pattern: p, confidence: conf };
        }
      }
    }
  }
  return best;
}

/**
 * Inferência de padrão frontend a partir do serviceName quando não há stack.
 * Confidence multiplicada por 0.6 (chamada indireta, menos precisa).
 *
 * @param {string|null} serviceName
 * @returns {{ pattern: Object, confidence: number }|null}
 */
function matchByServiceName(serviceName) {
  if (!serviceName) return null;
  const sn = serviceName.toLowerCase();

  if (/\bSP\./i.test(serviceName)) {
    return { pattern: { name: 'ServiceProxy.callService', category: 'service-call' }, confidence: 0.60 };
  }
  if (sn.includes('crudservice.save')) {
    return { pattern: { name: 'saveForm',    category: 'persist'       }, confidence: 0.60 };
  }
  if (sn.includes('crudservice.load') || sn.includes('loadrecords') || sn.includes('loadgrid')) {
    return { pattern: { name: 'loadRecords', category: 'query'         }, confidence: 0.60 };
  }
  if (sn.includes('actionexecutor')) {
    return { pattern: { name: 'executeAction', category: 'action'      }, confidence: 0.55 };
  }
  if (sn.includes('listener')) {
    return { pattern: { name: 'listener',    category: 'event'         }, confidence: 0.50 };
  }
  return null;
}

/**
 * Preenche variáveis de template com dados da requisição.
 * @param {string} template
 * @param {Object} ctx  { serviceName, entityName, pk, application, action, listener, spClass }
 * @returns {string}
 */
function fillTemplate(template, ctx) {
  return template
    .replace(/\$\{serviceName\}/g, ctx.serviceName || '—')
    .replace(/\$\{entityName\}/g,  ctx.entityName  || '—')
    .replace(/\$\{pk\}/g,          ctx.pk          || '—')
    .replace(/\$\{application\}/g, ctx.application || '—')
    .replace(/\$\{action\}/g,      ctx.action      || '—')
    .replace(/\$\{listener\}/g,    ctx.listener    || '—')
    .replace(/\$\{spClass\}/g,     ctx.spClass     || '—');
}

// ---------------------------------------------------------------------------
// Exports principais
// ---------------------------------------------------------------------------

/**
 * E2 — Correlaciona uma requisição com o padrão frontend Sankhya que a originou.
 *
 * Tenta em ordem:
 *  1. callStack capturado pelo content-main.js (fonte 'content') — confiança × 1.0
 *  2. initiator.frames capturado pelo DevTools HAR — confiança × 0.85
 *  3. Inferência por serviceName — confiança × 0.6
 *
 * @param {Object} request  requisição normalizada
 * @returns {{
 *   frontendOwner: { file:string, fn:string, line:number, pattern:string, category:string }|null,
 *   confidence: number
 * }}
 */
export function correlate(request) {
  // Tentativa 1: call stack capturado no interceptor content-main.js
  const stackMatch = matchFrames(request.callStack);
  if (stackMatch && stackMatch.confidence >= 0.5) {
    return {
      frontendOwner: {
        file:     stackMatch.frame.file,
        fn:       stackMatch.frame.fn,
        line:     stackMatch.frame.line,
        pattern:  stackMatch.pattern.name,
        category: stackMatch.pattern.category,
      },
      confidence: Math.min(1.0, stackMatch.confidence),
    };
  }

  // Tentativa 2: initiator.frames do DevTools HAR (confiança reduzida em 15%)
  const initiatorFrames = request.initiator?.frames;
  const initiatorMatch  = matchFrames(initiatorFrames);
  if (initiatorMatch) {
    const conf = Math.min(1.0, initiatorMatch.confidence * 0.85);
    if (conf >= 0.4) {
      return {
        frontendOwner: {
          file:     initiatorMatch.frame.file,
          fn:       initiatorMatch.frame.fn,
          line:     initiatorMatch.frame.line,
          pattern:  initiatorMatch.pattern.name,
          category: initiatorMatch.pattern.category,
        },
        confidence: conf,
      };
    }
  }

  // Tentativa 3: inferência por serviceName (confiança × 0.6)
  const sn     = request.queryParams?.serviceName
               ?? request.parsedPayload?.businessFields?.serviceName
               ?? request.parsedPayload?.businessFields?.servicename;
  const snMatch = matchByServiceName(sn);
  if (snMatch) {
    return {
      frontendOwner: null, // não sabemos o arquivo sem stack
      confidence:    snMatch.confidence,
      patternHint:   snMatch.pattern.name,
    };
  }

  return { frontendOwner: null, confidence: 0 };
}

/**
 * E5 — Gera hipótese de backend para a requisição.
 *
 * Cruza serviceName + requestType + campos de negócio com BACKEND_HYPOTHESIS_RULES
 * para sugerir a classe/bean Java mais provável de ter processado a chamada.
 *
 * @param {Object} request  requisição normalizada (após parsePayload)
 * @returns {{
 *   hypothesis: string|null,
 *   beansToInspect: string[],
 *   confidence: number
 * }}
 */
export function buildHypothesis(request) {
  const sn          = request.queryParams?.serviceName
                    ?? request.parsedPayload?.businessFields?.serviceName
                    ?? request.parsedPayload?.businessFields?.servicename
                    ?? '';
  const requestType = request.parsedPayload?.requestType ?? 'UNKNOWN';
  const bf          = request.parsedPayload?.businessFields ?? {};

  const ctx = {
    serviceName: sn,
    entityName:  bf.entityname ?? bf.entityName ?? bf.application ?? '',
    pk:          bf.pk ?? '',
    application: request.queryParams?.application ?? bf.application ?? '',
    action:      bf.action ?? bf.Action ?? '',
    listener:    bf.listener ?? bf.Listener ?? '',
    spClass:     sn.includes('.') ? sn.split('.')[0] : sn,
  };

  for (const rule of BACKEND_HYPOTHESIS_RULES) {
    if (!rule.servicePattern.test(sn)) continue;
    if (rule.requestType && rule.requestType !== requestType) continue;

    const hypothesis    = fillTemplate(rule.hypothesisTemplate, ctx);
    const beansToInspect = rule.beansToInspect.map((b) => fillTemplate(b, ctx));

    return { hypothesis, beansToInspect, confidence: rule.confidence };
  }

  return { hypothesis: null, beansToInspect: [], confidence: 0 };
}

/**
 * E7 — Eleva confiança da correlação usando o índice de fontes (E6).
 *
 * Se o arquivo do topFrame estiver no índice de sources, adiciona +0.2 de confiança
 * e retorna snippets relevantes do código-fonte.
 *
 * @param {Object} correlation    resultado de correlate()
 * @param {Object|null} sourceIndex  índice construído pelo source-indexer (E6)
 * @returns {{ sourceEvidence: Array<{file,lineNum,snippet}>|null, boostedConfidence: number }}
 */
export function lookupEvidence(correlation, sourceIndex) {
  if (!sourceIndex || !correlation?.frontendOwner) {
    return { sourceEvidence: null, boostedConfidence: correlation?.confidence ?? 0 };
  }

  const topFile = correlation.frontendOwner.file || '';
  const pattern = correlation.frontendOwner.pattern || '';

  // Busca no índice por padrão associado ao frontendOwner
  const entries = sourceIndex[pattern] || [];

  // Verifica se o arquivo do callStack bate diretamente com alguma entrada do índice
  const directMatch = entries.some((e) => e.file === topFile || topFile.includes(e.file));
  const boost       = directMatch ? 0.2 : 0;

  const sourceEvidence = entries.slice(0, 3);

  return {
    sourceEvidence:   sourceEvidence.length ? sourceEvidence : null,
    boostedConfidence: Math.min(1.0, (correlation.confidence ?? 0) + boost),
  };
}

/**
 * E5 — Score de relevância técnica de uma requisição para ordenação no relatório.
 *
 * Componentes do score (soma máxima = 100):
 *  +40  isCritical            — erro que impacta o usuário
 *  +20  isBottleneck          — degradação de performance
 *  +15  isSP                  — lógica de negócio específica Sankhya
 *  +15  confidence ≥ 0.8      — origem frontend identificada com alta certeza
 *  +10  tem entityName/entityname — chamada específica de entidade
 *  +10  tem pk                — operação com chave primária conhecida
 *  +5   tem callStack         — rastreabilidade máxima
 *
 * @param {Object} req  requisição normalizada
 * @returns {number}  score 0–100+
 */
export function computeRelevanceScore(req) {
  let score = 0;
  const bf   = req.parsedPayload?.businessFields ?? {};
  const sn   = req.queryParams?.serviceName ?? bf.serviceName ?? bf.servicename ?? '';

  if (req.classification?.isCritical)   score += 40;
  if (req.classification?.isBottleneck) score += 20;
  if (/\bSP\./i.test(sn))              score += 15;

  const conf = req.correlation?.confidence ?? 0;
  if (conf >= 0.8) score += 15;
  else if (conf >= 0.5) score += 7;

  if (bf.entityname || bf.entityName) score += 10;
  if (bf.pk)                          score += 10;
  if (req.callStack?.length)          score += 5;

  return score;
}
