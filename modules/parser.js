/**
 * parser.js — Extração e decodificação de dados das chamadas Sankhya.
 *
 * CONTEXTO DO DOMÍNIO
 * ───────────────────
 * O Sankhya usa um endpoint central chamado `service.sbr` que recebe
 * TODAS as requisições de negócio, diferenciadas por query parameters:
 *
 *   POST /mge/service.sbr?serviceName=CRUDService.save&application=NF
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: data={"requestBody":{"nunota":12345, "codemp":1, ...}}
 *
 * Este módulo tem três responsabilidades:
 *
 *   parseQueryParams(url)
 *     Extrai da query string: serviceName, application, resourceID,
 *     outputType, globalID, mgeSession.
 *     Esses campos identificam QUAL serviço está sendo chamado.
 *
 *   parsePayload(body)
 *     Extrai do corpo da requisição os campos de negócio Sankhya:
 *     nunota, codemp, codparc, codprod, etc.
 *     Suporta JSON puro, form-encoded e form com JSON aninhado no
 *     campo "data" (formato mais comum do Sankhya Web).
 *
 *   parseResponse(body)
 *     Analisa a resposta do servidor buscando indicadores de erro:
 *     stacktraces Java, erros Oracle (ORA-XXXX), status Sankhya ("1").
 */

/**
 * Parâmetros da query string que interessam ao monitor.
 */
const QUERY_PARAMS_OF_INTEREST = new Set([
  'servicename',
  'application',
  'resourceid',
  'outputtype',
  'globalid',
  'mgesession',
]);

/**
 * Extrai os query parameters relevantes de uma URL do Sankhya.
 *
 * @param {string} url
 * @returns {{
 *   serviceName: string|null,
 *   application: string|null,
 *   resourceID: string|null,
 *   outputType: string|null,
 *   globalID: string|null,
 *   mgeSession: string|null,
 *   raw: Record<string,string>
 * }}
 */
export function parseQueryParams(url) {
  const result = {
    serviceName: null,
    application: null,
    resourceID: null,
    outputType: null,
    globalID: null,
    mgeSession: null,
    raw: {},
  };

  if (!url) return result;

  try {
    // Garante que a URL tenha protocolo para o parser
    const safeUrl = url.startsWith('http') ? url : `https://x.com${url}`;
    const urlObj = new URL(safeUrl);

    urlObj.searchParams.forEach((value, key) => {
      result.raw[key] = value;
      switch (key.toLowerCase()) {
        case 'servicename':  result.serviceName  = value; break;
        case 'application':  result.application  = value; break;
        case 'resourceid':   result.resourceID   = value; break;
        case 'outputtype':   result.outputType   = value; break;
        case 'globalid':     result.globalID     = value; break;
        case 'mgesession':   result.mgeSession   = value; break;
      }
    });
  } catch (_) {
    // URL malformada — retorna o resultado vazio
  }

  return result;
}

// ---------------------------------------------------------------------------
// Extração de campos de negócio do payload
// ---------------------------------------------------------------------------

/**
 * Set (O(1)) de campos de negócio do Sankhya para extração recursiva.
 * Usar Set.has() é ~5x mais rápido que Array.includes() para listas > 20 itens.
 */
const BUSINESS_FIELDS_SET = new Set([
  // Identificadores de nota / transação
  'nunota', 'nufin', 'nuseq', 'numnota',
  // Códigos organizacionais
  'codemp', 'codfilial', 'codparc', 'codprod', 'codvend',
  'codusu', 'codusuinc', 'codusualt',
  // Classificações e tipos
  'codtipoper', 'codnat', 'codcencus', 'codloc', 'codest',
  'codtipvenda', 'codvol',
  'tipo', 'origem',
  // Identificador genérico e entidade
  'id', 'entityname',
  // Ações e eventos
  'action', 'event', 'listener', 'method',
  // Serviço e aplicação
  'servicename', 'application', 'resourceid',
  // Paginação e filtragem (indica tamanho e complexidade da query)
  'offset', 'limit', 'orderby', 'criteria', 'where',
  // Datas de auditoria (identificam quando dados foram modificados)
  'dtinc', 'dtalter',
  // Financeiro
  'vlrnota', 'nossonumero',
]);

/**
 * Percorre recursivamente um objeto JSON e coleta todos os campos de
 * negócio Sankhya listados em BUSINESS_FIELDS.
 *
 * Por que busca recursiva?
 *  O Sankhya frequentemente aninha os dados em sub-objetos:
 *  { "requestBody": { "pk": { "nunota": 123 }, "codemp": 1 } }
 *  Uma busca apenas no nível raiz perderia o `nunota`.
 *
 * Por que limitar a profundidade em 6?
 *  Respostas Sankhya podem ter estruturas como:
 *  responseBody > rows > row[0] > fields > field[n] > value > pk
 *  (5 níveis). Limite 6 cobre isso com margem sem risco de
 *  loop infinito em estruturas circulares ou muito profundas.
 *
 * Política de sobrescrição:
 *  Campos encontrados em níveis SUPERIORES têm prioridade sobre níveis
 *  mais profundos. Isso garante que o `serviceName` da raiz não seja
 *  sobrescrito por um `serviceName` aninhado num sub-serviço.
 *
 * @param {any}    obj    objeto a percorrer
 * @param {number} depth  nível atual de profundidade (começa em 0)
 * @returns {Record<string,any>}  mapa campo→valor dos campos encontrados
 */
function extractBusinessFields(obj, depth = 0) {
  if (depth > 6 || obj === null || typeof obj !== 'object') return {};

  // Arrays: percorre até os 20 primeiros elementos para cobrir grids paginados
  if (Array.isArray(obj)) {
    const found = {};
    const limit = Math.min(obj.length, 20);
    for (let i = 0; i < limit; i++) {
      const nested = extractBusinessFields(obj[i], depth + 1);
      for (const [nk, nv] of Object.entries(nested)) {
        if (!(nk in found)) found[nk] = nv;
      }
    }
    return found;
  }

  const found = {};
  for (const [key, value] of Object.entries(obj)) {
    const lk = key.toLowerCase();

    // O(1) hash lookup — mais rápido que Array.includes() para sets > 20 itens
    if (BUSINESS_FIELDS_SET.has(lk)) {
      // Preserva a chave com capitalização original para exibição no relatório
      found[key] = value;
    }

    if (value !== null && typeof value === 'object' && depth < 6) {
      const nested = extractBusinessFields(value, depth + 1);
      // Campos do nível pai têm prioridade — não sobrescreve com achados filhos
      for (const [nk, nv] of Object.entries(nested)) {
        if (!(nk in found)) found[nk] = nv;
      }
    }
  }
  return found;
}

/**
 * Parseia o corpo (body) de uma requisição HTTP do Sankhya.
 *
 * ESTRATÉGIA DE 3 TENTATIVAS (em ordem de prioridade):
 *
 *  [1] JSON puro
 *      Usado por chamadas modernas ou APIs REST internas.
 *      Exemplo: { "requestBody": { "nunota": 123 } }
 *
 *  [2] form-urlencoded com campo "data" contendo JSON codificado
 *      Formato MAIS COMUM do Sankhya Web. O payload é enviado como:
 *      Content-Type: application/x-www-form-urlencoded
 *      Body: data=%7B%22requestBody%22%3A%7B%22nunota%22%3A123%7D%7D
 *      O valor do campo "data" é um JSON URL-encoded.
 *      Este modulo detecta isso e parseia o JSON interno.
 *
 *  [3] form-urlencoded simples (fallback)
 *      Chamadas mais antigas ou internas que enviam campos diretamente
 *      sem encapsular em JSON. Ex: serviceName=CRUDService.save&nunota=123
 *
 * O campo `raw` preserva os primeiros 600 chars do body original para
 * exibição no painel de detalhes do popup e do relatório.
 *
 * @param {string|null} body  corpo bruto da requisição HTTP
 * @returns {{
 *   raw: string,           primeiros 600 chars do body original
 *   parsed: Object|null,   objeto parseado (JSON ou form flat)
 *   businessFields: Record<string,any>  campos de negócio extraídos
 * }}
 */
export function parsePayload(body) {
  const result = {
    raw: '',
    parsed: null,
    businessFields: {},
  };

  if (!body || typeof body !== 'string') return result;

  // Preserva os primeiros 1200 chars do body para exibição no relatório.
  // 1200 chars cobrem a maioria dos payloads Sankhya (data= + JSON aninhado)
  // sem inflar desnecessariamente o storage.
  result.raw = body.substring(0, 1200);

  // [TENTATIVA 1] JSON puro — APIs REST, chamadas modernas
  try {
    const json = JSON.parse(body);
    result.parsed = json;
    result.businessFields = extractBusinessFields(json);
    return result;
  } catch (_) { /* não é JSON — tenta próximo formato */ }

  // [TENTATIVA 2 e 3] application/x-www-form-urlencoded
  try {
    const params = new URLSearchParams(body);
    const flat = {};
    params.forEach((v, k) => { flat[k] = v; });

    // [TENTATIVA 2] Formato Sankhya Web: campo "data" contém JSON URL-encoded
    // Este é o formato padrão de TODAS as chamadas do cliente web Sankhya.
    if (flat.data) {
      try {
        const inner = JSON.parse(decodeURIComponent(flat.data));
        result.parsed = inner;
        result.businessFields = extractBusinessFields(inner);
        return result;
      } catch (_) { /* campo "data" não é JSON — cai no fallback */ }
    }

    // [TENTATIVA 3] form-urlencoded simples — extrai campos diretamente
    // Captura serviceName que pode vir fora do campo "data" em chamadas antigas
    if (flat.serviceName) {
      result.businessFields.serviceName = flat.serviceName;
    }

    result.parsed = flat;
    Object.assign(result.businessFields, extractBusinessFields(flat));
  } catch (_) { /* body não é form-urlencoded — ignora sem propagar erro */ }

  return result;
}

// ---------------------------------------------------------------------------
// Análise da resposta
// ---------------------------------------------------------------------------

/**
 * Padrões regex para detecção de erros no corpo de resposta Sankhya.
 * Ordenados do mais ESPECÍFICO/CRÍTICO ao mais GENÉRICO para que o
 * primeiro match capture a causa-raiz mais informativa.
 *
 * Origem de cada padrão:
 *  NullPointerException      — exceção Java gerada pelo servidor de aplicação
 *                              Sankhya (JBoss/WildFly). Indica bug no backend.
 *  ORA-\d{4,}                — código de erro Oracle Database (ex: ORA-00001
 *                              unique constraint, ORA-04061 invalid session).
 *  java.lang.*Exception      — qualquer exceção Java checked/unchecked lançada
 *                              pelo servidor e propagada para o cliente.
 *  stacktrace:               — campo "stacktrace" serializado na resposta JSON
 *                              do Sankhya quando o modo debug está habilitado.
 *  Timeout                   — timeout de serviço (banco, serviço externo, EJB).
 *  Exception                 — fallback genérico para qualquer exceção não
 *                              capturada pelos padrões mais específicos acima.
 *  "statusMessage":"...erro" — formato JSON do Sankhya: statusMessage contendo
 *                              palavras como "error", "erro", "falha", "falhou".
 *  "status":"1"              — código de status Sankhya: 0 = sucesso, 1 = erro.
 *                              Presente em respostas estruturadas do service.sbr.
 */
const ERROR_PATTERNS = [
  /NullPointerException/i,                                                  // bug Java no servidor
  /ORA-\d{4,}/,                                                             // erro Oracle Database
  /java\.lang\.\w+Exception/i,                                              // exceção Java genérica
  /java\.\w+\.\w+Exception/i,                                               // exceção Java de outros pacotes
  /stacktrace[\s\S]{0,30}:/i,                                               // campo de stacktrace serializado
  /Timeout/i,                                                               // timeout de serviço/banco
  /Exception/i,                                                             // exceção não categorizada
  /"errorMessage"\s*:\s*"[^"]{3,}"/i,                                        // campo errorMessage direto na resposta
  /"detailedMessage"\s*:\s*"[^"]{3,}"/i,                                     // mensagem detalhada de erro estruturado
  /"statusDescription"\s*:\s*"[^"]*(?:error|erro|falha|falhou|inválido)[^"]*"/i, // status description com palavra de erro
  /"statusMessage"\s*:\s*"[^"]*(?:error|erro|falha|falhou)[^"]*"/i,          // status de erro em JSON
  /"status"\s*:\s*"1"/,                                                     // status Sankhya: 1 = erro
];

/**
 * Extrai informações relevantes de uma resposta do Sankhya,
 * incluindo detecção de erros e código de status interno.
 *
 * @param {string|null} responseBody
 * @returns {{
 *   summary: string,
 *   hasError: boolean,
 *   errorMessage: string|null,
 *   statusMessage: string|null
 * }}
 */
export function parseResponse(responseBody) {
  const result = {
    summary: '',
    hasError: false,
    errorMessage: null,
    statusMessage: null,
  };

  if (!responseBody || typeof responseBody !== 'string') return result;

  result.summary = responseBody.substring(0, 400);

  // Analisa padrões de erro na string bruta
  for (const pattern of ERROR_PATTERNS) {
    const match = responseBody.match(pattern);
    if (match) {
      result.hasError = true;
      const idx = responseBody.indexOf(match[0]);
      result.errorMessage = responseBody
        .substring(Math.max(0, idx - 10), Math.min(responseBody.length, idx + 120))
        .trim();
      break;
    }
  }

  // Tenta parsear JSON para extrair status estruturado do Sankhya.
  // O Sankhya usa DOIS formatos de resposta JSON distintos dependendo
  // da versão e do tipo de chamada:
  try {
    const json = JSON.parse(responseBody);

    // statusMessage na raiz — presente em algumas respostas de erro rápido
    if (json.statusMessage) result.statusMessage = json.statusMessage;

    // FORMATO 1: Resposta padrão do service.sbr
    // { "responseBody": { "status": "0"|"1", "statusMessage": "..." } }
    const rb = json.responseBody;
    if (rb) {
      if (rb.statusMessage) result.statusMessage = rb.statusMessage;
      if (rb.status === '1' || rb.status === 1) {
        result.hasError = true;
        result.errorMessage = rb.statusMessage || rb.errorMessage || result.errorMessage || 'Erro interno no responseBody';
      }
      // Campo errorMessage direto no responseBody (alguns serviços Sankhya)
      if (rb.errorMessage && !result.errorMessage) {
        result.hasError = true;
        result.errorMessage = rb.errorMessage;
      }
    }

    // FORMATO 2: Resposta estruturada de APIs internas Sankhya
    // { "status": { "value": "Error"|"Ok", "message": "descrição" } }
    if (json.status && typeof json.status === 'object') {
      const sv = (json.status.value || '').toLowerCase();
      if (sv === 'error' || sv === '1') {
        result.hasError = true;
        result.errorMessage = json.status.message || result.errorMessage || 'Erro reportado pelo servidor';
      }
    }

    // FORMATO 3: Campos de erro diretos na raiz
    // ex: { "errorMessage": "...", "detailedMessage": "..." }
    if (json.errorMessage && !result.errorMessage) {
      result.hasError = true;
      result.errorMessage = json.errorMessage;
    }
    if (json.detailedMessage && !result.errorMessage) {
      result.hasError = true;
      result.errorMessage = json.detailedMessage;
    }
    if (json.statusDescription && !result.statusMessage) {
      result.statusMessage = json.statusDescription;
      if (/erro|error|falha|failed|inválido/i.test(json.statusDescription)) {
        result.hasError = true;
        if (!result.errorMessage) result.errorMessage = json.statusDescription;
      }
    }
  } catch (_) { /* não é JSON válido — análise por regex já foi feita acima */ }

  return result;
}
