/**
 * classifier.js — Classificação automática de chamadas HTTP do Sankhya.
 *
 * CADEIA DE CLASSIFICAÇÃO (executada nesta ordem):
 * ──────────────────────────────────────────────────────────────
 *  1. DESCARTE  → asset estático ou polling?  → IRRELEVANTE (sai aqui)
 *  2. HTTP 5xx  → erro do servidor?           → CÍTICO (pode ser elevado)
 *  3. RESPONSE  → exceção no body?           → CÍTICO
 *  4. DURAÇÃO  → > 2 segundos?              → GARGALO (se não for crítico)
 *  5. SERVICO   → serviceName reconhecido?   → categoria específica
 *  6. FALLBACK  → não reconhecido mas é MGE → APOIO/BAIXA RELEVÂNCIA
 *
 * EXPORTS:
 *  CATEGORIES         — enum de categorias usado em toda a extensão
 *  classifyRequest    — classifica uma requisição normalizada
 *  isStaticAsset      — filtro de URL para assets descartáveis
 *  isPolling          — filtro de URL para polling/heartbeat
 *  isRelevant         — decide se entra no relatório
 *  isPriority         — decide se merece destaque no relatório
 */

// ---------------------------------------------------------------------------
// Constantes de categoria
// ---------------------------------------------------------------------------

/**
 * Categorias de classificação das chamadas Sankhya.
 *
 * Cada categoria representa a INTENÇÃO da chamada no domínio de negócio:
 *  CONFIGURAÇÃO    — salva ou lê preferências/configurações do sistema
 *  CONSULTA/CARGA   — busca/carrega registros para exibição em grids
 *  PERSISTÊNCIA     — grava, altera ou remove entidades (CRUDService)
 *  REGRA DE NEGÓCIO — executa lógica de negócios, action, listener, evento
 *  GARGALO          — qualquer chamada que levou mais de 2 segundos
 *  CRÍTICO          — chamada com HTTP 5xx ou exceção/erro no response
 *  APOIO/BAIXA REL. — chamada relevante mas sem serviço reconhecido
 *  IRRELEVANTE      — asset estático ou polling — ignorado no relatório
 *
 * Uma chamada PODE ter múltiplas categorias sobrepostas (ex: PERSISTÊNCIA
 * que também é GARGALO). A categoria armazenada é a MAIS IMPORTANTE,
 * mas `isBottleneck` e `isCritical` são flags adicionais independentes.
 */
export const CATEGORIES = Object.freeze({
  CONFIG:      'CONFIGURAÇÃO',
  QUERY:       'CONSULTA/CARGA',
  PERSIST:     'PERSISTÊNCIA',
  BUSINESS:    'REGRA DE NEGÓCIO',
  BOTTLENECK:  'GARGALO',
  CRITICAL:    'CRÍTICO',
  SUPPORT:     'APOIO/BAIXA RELEVÂNCIA',
  IRRELEVANT:  'IRRELEVANTE',
});

// ---------------------------------------------------------------------------
// Filtros de descarte
// ---------------------------------------------------------------------------

/**
 * Extensões e padrões de URL que identificam assets estáticos.
 * Qualquer chamada que bata nesses padrões é marcada como IRRELEVANTE.
 */
const STATIC_PATTERNS = [
  /\.(?:png|jpe?g|gif|svg|ico|webp|bmp|tiff?)(?:\?|$)/i,
  /\.(?:css|less|scss|sass)(?:\?|$)/i,
  /\.(?:js|mjs|jsx|ts|tsx)(?:\?|$)/i,
  /\.(?:woff2?|eot|ttf|otf)(?:\?|$)/i,
  /\.(?:mp[34]|wav|avi|mov|mkv|webm)(?:\?|$)/i,
  /\.(?:pdf|zip|gz|tar)(?:\?|$)/i,
  /\.map(?:\?|$)/i,
  /\/(?:static|assets|resources|fonts|images|img|icons|vendor)(?:\/|$)/i,
  /(?:google-analytics|googletagmanager|gtag|analytics\.js|clarity\.ms)/i,
  /\/favicon(?:\.ico)?(?:\?|$)/i,
];

/**
 * Padrões de polling/heartbeat que não têm valor de diagnóstico.
 */
const POLLING_PATTERNS = [
  /\/(?:ping|heartbeat|keepalive|health)(?:\?|$)/i,
  /[?&]polling=true/i,
  /status\/(?:check|poll)/i,
  /\/longpoll(?:ing)?/i,
];

/**
 * Verifica se a URL aponta para um asset estático dispensável.
 * @param {string} url
 * @returns {boolean}
 */
export function isStaticAsset(url) {
  if (!url) return false;
  return STATIC_PATTERNS.some((p) => p.test(url));
}

/**
 * Verifica se a URL representa uma chamada de polling irrelevante.
 * @param {string} url
 * @returns {boolean}
 */
export function isPolling(url) {
  if (!url) return false;
  return POLLING_PATTERNS.some((p) => p.test(url));
}

// ---------------------------------------------------------------------------
// Regras de classificação por serviceName
// ---------------------------------------------------------------------------

/**
 * Determina a categoria funcional de uma chamada a partir do serviceName.
 *
 * O serviceName segue o padrão Java: "NomeClasse.nomeMetodo".
 * Exemplos reais do Sankhya:
 *   "CRUDService.save"          → PERSISTÊNCIA
 *   "CRUDService.loadRecords"   → CONSULTA/CARGA
 *   "ActionExecutor.execute"    → REGRA DE NEGÓCIO
 *   "SystemUtilsSP.saveConf"    → CONFIGURAÇÃO
 *
 * ORDEM DAS VERIFICAÇÕES (importante!):
 *  PERSISTÊNCIA deve ser verificada ANTES de CONSULTA.
 *  Motivo: um serviço chamado "CRUDService.save" contém a palavra ".save"
 *  que marcaria PERSISTÊNCIA corretamente, mas se a ordem fosse invertida,
 *  a verificação de CONSULTA poderia não pegar o ".save" pois não inclui
 *  esse padrão — a inversão não causa erros mas a ordem garante que
 *  serviços do tipo "CRUDService.loadRecords" (contém "load" E não contém
 *  ".save") sejam classificados como CONSULTA corretamente.
 *
 * @param {string|null} serviceName  valor do parâmetro serviceName da chamada
 * @returns {string|null}  categoria correspondente, ou null se não reconhecido
 */
function classifyByServiceName(serviceName) {
  if (!serviceName) return null;
  const sn = serviceName.toLowerCase();

  // CONFIGURAÇÃO
  if (
    sn.includes('saveconf') ||
    sn.includes('systemutils') ||
    sn.includes('setconf') ||
    sn.includes('preference')
  ) return CATEGORIES.CONFIG;

  // PERSISTÊNCIA (deve vir antes de CONSULTA para pegar "CRUDService.save")
  if (
    sn.includes('crudservice.save') ||
    sn.includes('.save') ||
    sn.includes('.update') ||
    sn.includes('.delete') ||
    sn.includes('.insert') ||
    sn.includes('.remove') ||
    sn.includes('persist') ||
    sn.includes('commit')
  ) return CATEGORIES.PERSIST;

  // CONSULTA / CARGA
  if (
    sn.includes('loadrecords') ||
    sn.includes('loadgrid') ||
    sn.includes('.load') ||
    sn.includes('.find') ||
    sn.includes('.search') ||
    sn.includes('.query') ||
    sn.includes('.get') ||
    sn.includes('.fetch') ||
    sn.includes('.list') ||
    sn.includes('.read')
  ) return CATEGORIES.QUERY;

  // REGRA DE NEGÓCIO
  if (
    sn.includes('execute') ||
    sn.includes('.action') ||
    sn.includes('callservice') ||
    sn.includes('runevent') ||
    sn.includes('listener') ||
    sn.includes('.event') ||
    sn.includes('.process') ||
    sn.includes('actionexecutor') ||
    sn.includes('workflow')
  ) return CATEGORIES.BUSINESS;

  return null;
}

// ---------------------------------------------------------------------------
// Classificação principal
// ---------------------------------------------------------------------------

/**
 * Classifica uma requisição processada pelo monitor.
 *
 * @param {{
 *   url: string,
 *   method: string,
 *   status: number,
 *   duration: number,
 *   queryParams: Object,
 *   parsedPayload: Object,
 *   parsedResponse: Object
 * }} request
 *
 * @returns {{
 *   category: string,
 *   isCritical: boolean,
 *   isBottleneck: boolean,
 *   reasons: string[]
 * }}
 */
export function classifyRequest(request) {
  const { url = '', method = 'GET', status = 0, duration = 0, queryParams, parsedPayload, parsedResponse } = request;

  // ── Descarte imediato ──────────────────────────────────────────────────
  if (isStaticAsset(url)) {
    return { category: CATEGORIES.IRRELEVANT, isCritical: false, isBottleneck: false, reasons: ['Asset estático'] };
  }
  if (isPolling(url)) {
    return { category: CATEGORIES.IRRELEVANT, isCritical: false, isBottleneck: false, reasons: ['Polling/heartbeat irrelevante'] };
  }

  const reasons = [];
  let category = CATEGORIES.SUPPORT;
  let isCritical = false;
  let isBottleneck = false;

  // ── Criticidade por status HTTP ────────────────────────────────────────
  if (status >= 500) {
    isCritical = true;
    reasons.push(`HTTP ${status} — erro de servidor`);
    category = CATEGORIES.CRITICAL;
  } else if (status >= 400) {
    reasons.push(`HTTP ${status} — erro de cliente`);
    // 4xx não é crítico por si só, mas pode ser elevado por outros critérios
  }

  // ── Criticidade por conteúdo da resposta ──────────────────────────────
  if (parsedResponse?.hasError) {
    isCritical = true;
    const msg = parsedResponse.errorMessage || 'erro desconhecido';
    reasons.push(`Erro no response: ${msg.substring(0, 80)}`);
    if (category !== CATEGORIES.CRITICAL) category = CATEGORIES.CRITICAL;
  }

  // ── Gargalo por tempo de resposta ─────────────────────────────────────
  if (duration > 2000) {
    isBottleneck = true;
    reasons.push(`Tempo elevado: ${(duration / 1000).toFixed(2)}s`);
    if (!isCritical) category = CATEGORIES.BOTTLENECK;
  }

  // ── Classificação por serviceName ──────────────────────────────────────
  const serviceName =
    queryParams?.serviceName ||
    parsedPayload?.businessFields?.serviceName ||
    parsedPayload?.businessFields?.servicename;

  const serviceCategory = classifyByServiceName(serviceName);

  if (serviceCategory) {
    // Só sobrescreve a categoria se ainda não for CRITICAL
    if (!isCritical) {
      category = serviceCategory;
    }
    // Se houver gargalo, registra nos reasons
    if (isBottleneck) {
      reasons.push(`${serviceCategory} com tempo elevado`);
    }
  }

  // ── Chamadas /mge/ sem serviceName reconhecido ────────────────────────
  // Ainda assim são relevantes — mantém como APOIO mas não como IRRELEVANTE
  if (!serviceCategory && url.includes('/mge/') && category === CATEGORIES.SUPPORT) {
    reasons.push('Chamada MGE sem serviceName reconhecido');
  }

  return { category, isCritical, isBottleneck, reasons };
}

// ---------------------------------------------------------------------------
// Helpers de filtro para o relatório
// ---------------------------------------------------------------------------

/**
 * Retorna true se a requisição deve aparecer no relatório.
 * Exclui apenas itens explicitamente marcados como IRRELEVANTE.
 *
 * @param {{ classification: { category: string } }} request
 * @returns {boolean}
 */
export function isRelevant(request) {
  return request?.classification?.category !== CATEGORIES.IRRELEVANT;
}

/**
 * Retorna true se a requisição deve ser destacada no relatório
 * (crítica, gargalo, chamada de negócio ou persistência).
 *
 * @param {{ url: string, classification: Object }} request
 * @returns {boolean}
 */
export function isPriority(request) {
  const { url = '', classification } = request;
  if (!classification) return false;
  return (
    classification.isCritical ||
    classification.isBottleneck ||
    classification.category === CATEGORIES.BUSINESS ||
    classification.category === CATEGORIES.PERSIST ||
    url.includes('/mge/service.sbr')
  );
}
