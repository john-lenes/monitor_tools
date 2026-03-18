/**
 * reporter.js — Agregação, sugestões e geração de relatório de sessão.
 *
 * Este módulo é puramente FUNCIONAL (sem estado interno) e é usado por:
 *   - background.js: para gerar o relatório textual ao finalizar uma sessão
 *   - report.js (frontend): para calcular estatísticas e sugestões ao exibir
 *   - popup.js: para exibir contadores resumidos no popup
 *
 * EXPORTS:
 *   getSessionStats(requests)
 *     → Totais numéricos e distribuição por categoria.
 *     → "Total" = todas as chamadas capturadas (incl. IRRELEVANTES).
 *     → "Relevantes" = total menos IRRELEVANTES (o que entra no relatório).
 *
 *   generateSuggestions(requests)
 *     → Lista deduplicada de sugestões de investigação backend.
 *     → Baseada nos serviceNames, applications, resourceIDs e erros encontrados.
 *     → Cada sugestão aparece apenas UMA vez (Set interno garante unicidade).
 *
 *   generateTextReport(session)
 *     → Relatório completo em texto plano, pronto para exportação (.txt).
 *     → Incluí resumo, lista por tempo, seção de críticos e sugestões.
 */

import { CATEGORIES } from './classifier.js';

// ---------------------------------------------------------------------------
// Helper interno — extração de serviceName
// ---------------------------------------------------------------------------

/**
 * Extrai o serviceName de uma requisição, verificando queryParams e businessFields.
 * Centralizado aqui para evitar repetição em getServiceMap, generateSuggestions
 * e generateTextReport.
 *
 * @param {Object} req  requisição normalizada
 * @returns {string|null}
 */
function extractServiceName(req) {
  const bf = req.parsedPayload?.businessFields ?? {};
  return req.queryParams?.serviceName ?? bf.serviceName ?? bf.servicename ?? null;
}

// ---------------------------------------------------------------------------
// Estatísticas da sessão
// ---------------------------------------------------------------------------

/**
 * Calcula as estatísticas consolidadas de uma sessão de monitoramento.
 *
 * Distinção entre `total` e `relevant`:
 *  `total`    = TODAS as chamadas registradas, inclusive assets e polling
 *               que foram marcados como IRRELEVANTE pelo classifier.
 *               Representa o volume bruto capturado.
 *  `relevant` = chamadas que aparecem no relatório (excluindo IRRELEVANTE).
 *               É o número que o desenvolvedor deve analisar.
 *
 * O cálculo de `avgDuration` usa apenas as chamadas relevantes para
 * evitar que assets rápidos (< 5ms) distorcessem a média para baixo.
 *
 * @param {Object[]} requests  lista de requisições normalizadas da sessão
 * @returns {{
 *   total:       number,  total bruto de chamadas capturadas
 *   relevant:    number,  chamadas não-IRRELEVANTES
 *   critical:    number,  chamadas com isCritical = true
 *   bottlenecks: number,  chamadas com isBottleneck = true
 *   maxDuration: number,  maior tempo de resposta (ms) entre relevantes
 *   avgDuration: number,  média de tempo (ms) entre relevantes
 *   byCategory:  Record<string,number>  contagem por categoria
 * }}
 */
export function getSessionStats(requests = []) {
  const relevant    = requests.filter((r) => r.classification?.category !== CATEGORIES.IRRELEVANT);
  const critical    = requests.filter((r) => r.classification?.isCritical);
  const bottlenecks = requests.filter((r) => r.classification?.isBottleneck);

  const durations = relevant.map((r) => r.duration || 0);
  const maxDuration = durations.length ? Math.max(...durations) : 0;
  const avgDuration = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  const byCategory = {};
  for (const r of relevant) {
    const cat = r.classification?.category ?? 'SEM_CATEGORIA';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  // Contagem de serviços SP únicos (classe cujo nome termina com SP)
  const spServices = relevant.filter((r) => {
    const sn = extractServiceName(r);
    return sn && /\bSP\./i.test(sn);
  });
  const spCount = new Set(spServices.map((r) => extractServiceName(r))).size;

  return { total: requests.length, relevant: relevant.length, critical: critical.length, bottlenecks: bottlenecks.length, spCount, maxDuration, avgDuration, byCategory };
}

// ---------------------------------------------------------------------------
// Sugestões de investigação backend
// ---------------------------------------------------------------------------

/**
 * Gera uma lista deduplicada de sugestões de investigação backend.
 *
 * ESTRATÉGIA DE DEDUPLICACÇÃO:
 *  Um Set JavaScript (à variável `suggestions`) garante que a
 *  mesma sugestão não apareça duas vezes mesmo que 10 chamadas
 *  usem o mesmo serviceName. Além disso, `seen.serviceNames` controla
 *  quais serviceNames já geraram sugestões de busca, evitando texto
 *  repetido como: "Procurar CRUDService.save" aparecendo 5 vezes.
 *
 * TIPOS DE SUGESTÕES GERADAS:
 *  1. Por serviceName  → "Procurar por X no backend"
 *  2. Por application  → "Verificar classe/bean X"
 *  3. Por resourceID   → "Inspecionar resourceID X"
 *  4. Por categoria REGRA DE NEGÓCIO → listeners, eventos registrados
 *  5. Por categoria PERSISTÊNCIA → triggers, beforeSave/afterSave
 *  6. Por isBottleneck  → queries lentas, índices de banco
 *  7. Por isCritical    → logs de servidor, stack traces
 *  8. Padrões agregados (ao final) → ActionExecutor, CRUDService, SystemUtils
 *
 * @param {Object[]} requests  lista de requisições normalizadas
 * @returns {string[]}  lista de sugestões únicas como strings
 */
export function generateSuggestions(requests = []) {
  const suggestions = new Set();
  const seen = {
    serviceNames: new Set(),
    applications: new Set(),
    resourceIDs:  new Set(),
  };

  for (const req of requests) {
    const { queryParams, parsedPayload, classification, parsedResponse } = req;
    if (!classification || classification.category === CATEGORIES.IRRELEVANT) continue;

    const bf = parsedPayload?.businessFields ?? {};

    // serviceName — usa o helper centralizado
    const sn = extractServiceName(req);
    if (sn && !seen.serviceNames.has(sn)) {
      seen.serviceNames.add(sn);
      suggestions.add(`Procurar por "${sn}" no backend`);
    }

    // application
    const app = queryParams?.application ?? bf.application ?? bf.Application;
    if (app && !seen.applications.has(app)) {
      seen.applications.add(app);
      suggestions.add(`Verificar classe/bean "${app}"`);
    }

    // Sugestões específicas para classes SP
    // Quando o serviceName pertence a uma classe SP, sugere inspecionar
    // a classe e a sua relação com a classe de origem (application).
    if (sn && /\bSP\./i.test(sn)) {
      const spClass = sn.split('.')[0];
      const spKey   = `SP:${spClass}`;
      if (!seen.serviceNames.has(spKey)) {
        seen.serviceNames.add(spKey);
        suggestions.add(`Inspecionar classe SP "${spClass}" — verificar implementação e parâmetros`);
        if (app && app !== 'workspace') {
          suggestions.add(`Verificar classe de origem "${app}" vinculada ao SP "${spClass}"`);
        }
      }
    }

    // resourceID
    const rid = queryParams?.resourceID ?? bf.resourceID;
    if (rid && !seen.resourceIDs.has(rid)) {
      seen.resourceIDs.add(rid);
      suggestions.add(`Inspecionar resourceID "${rid}"`);
    }

    // Sugestões contextuais por categoria
    if (classification.category === CATEGORIES.BUSINESS) {
      const listener = bf.listener ?? bf.Listener;
      const event    = bf.event    ?? bf.Event;
      if (listener) suggestions.add(`Validar listener: "${listener}"`);
      if (event)    suggestions.add(`Verificar evento: "${event}"`);
      if (sn)       suggestions.add('Verificar regras de negócio e eventos registrados no serviço');
    }

    if (classification.category === CATEGORIES.PERSIST) {
      suggestions.add('Validar triggers e regras de persistência (beforeSave/afterSave)');
    }

    if (classification.isBottleneck) {
      const label = sn ?? req.url;
      suggestions.add(`Investigar gargalo em "${label}" — verificar queries lentas e índices`);
      suggestions.add('Verificar índices de banco de dados nas tabelas envolvidas');
    }

    if (classification.isCritical) {
      if (parsedResponse?.errorMessage) {
        suggestions.add(`Analisar erro: "${parsedResponse.errorMessage.substring(0, 100)}"`);
      }
      suggestions.add('Verificar logs do servidor de aplicação para stack traces');
      suggestions.add('Analisar mensagens de erro no console do Sankhya Server');
    }
  }

  // Sugestões adicionais baseadas em padrões agregados
  const snList = [...seen.serviceNames].map((s) => s.toLowerCase());

  if (snList.some((s) => s.includes('actionexecutor') || s.includes('execute'))) {
    suggestions.add('Revisar ActionExecutors registrados e seus impactos em tabelas');
  }
  if (snList.some((s) => s.includes('crudservice'))) {
    suggestions.add('Analisar regras de validação CRUD e callbacks de persistência');
  }
  if (snList.some((s) => s.includes('systemutils'))) {
    suggestions.add('Verificar configurações salvas e impacto nas sessões ativas');
  }

  return [...suggestions];
}

// ---------------------------------------------------------------------------
// Mapa de serviços únicos
// ---------------------------------------------------------------------------

/**
 * Constrói o mapa consolidado de TODOS os serviços únicos executados na sessão.
 * Agrega múltiplas chamadas para o mesmo serviceName numa única entrada.
 *
 * Serviços cuja classe termina com "SP" (padrão Sankhya para Service Providers)
 * são separados em `spServices` e sempre listados em destaque. Os demais ficam
 * em `otherServices`. Ambos os arrays são ordenados por tempo máximo (desc).
 *
 * @param {Object[]} requests  lista de requisições normalizadas
 * @returns {{
 *   spServices:    Object[],  chamadas de classes SP, destacadas
 *   otherServices: Object[],  demais chamadas relevantes com serviceName
 * }}
 */
export function getServiceMap(requests = []) {
  const map = new Map(); // serviceName → entry agregada

  for (const req of requests) {
    if (req.classification?.category === CATEGORIES.IRRELEVANT) continue;

    const sn = extractServiceName(req);
    if (!sn) continue;

    if (!map.has(sn)) {
      const isSP = /\bSP\./i.test(sn);
      map.set(sn, {
        serviceName:   sn,
        isSP,
        spClass:       isSP ? sn.split('.')[0] : null,
        method:        sn.includes('.') ? sn.split('.').slice(1).join('.') : sn,
        applications:  new Set(),
        categories:    new Set(),
        callCount:     0,
        maxDuration:   0,
        totalDuration: 0,
        hasCritical:   false,
        hasBottleneck: false,
        // Acumuladores de TTFB (server processing time) — só populados quando HAR disponível
        waitMsTotal:   0,
        waitMsCount:   0,
        maxWaitMs:     0,
        // Lista de chamadas individuais (para auditoria SP detalhada)
        calls:         [],
      });
    }

    const entry = map.get(sn);
    entry.callCount++;
    entry.totalDuration += req.duration || 0;
    entry.maxDuration = Math.max(entry.maxDuration, req.duration || 0);
    if (req.classification?.isCritical)   entry.hasCritical  = true;
    if (req.classification?.isBottleneck) entry.hasBottleneck = true;

    if (req.timing?.waitMs >= 0) {
      entry.waitMsTotal += req.timing.waitMs;
      entry.waitMsCount++;
      entry.maxWaitMs = Math.max(entry.maxWaitMs, req.timing.waitMs);
    }

    const app = req.queryParams?.application ?? req.parsedPayload?.businessFields?.application;
    if (app) entry.applications.add(app);

    const cat = req.classification?.category;
    if (cat && cat !== CATEGORIES.IRRELEVANT) entry.categories.add(cat);

    // Guarda referência da chamada individual para seção de auditoria SP
    if (entry.isSP) {
      entry.calls.push({
        url:      req.url,
        method:   req.method,
        status:   req.status,
        duration: req.duration,
        timing:   req.timing   ?? null,
        source:   req.source,
        error:    req.parsedResponse?.errorMessage ?? null,
        app:      app ?? null,
        timestamp: req.timestamp,
      });
    }
  }

  const entries = [...map.values()];
  return {
    spServices:    entries.filter((e) =>  e.isSP).sort((a, b) => b.maxDuration - a.maxDuration),
    otherServices: entries.filter((e) => !e.isSP).sort((a, b) => b.maxDuration - a.maxDuration),
  };
}

// ---------------------------------------------------------------------------
// Geração do relatório em texto plano
// ---------------------------------------------------------------------------

const LINE_FULL  = '='.repeat(62);
const LINE_LIGHT = '-'.repeat(42);
const fmt = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

/**
 * Formata o breakdown de timing HAR numa string compacta de uma linha.
 * Fases com valor −1 (não ocorreram ou não disponíveis) são omitidas.
 * Exemplo: "dns:2ms  tcp:12ms  ttfb:238ms  rx:18ms"
 *
 * @param {Object|null} timing  objeto timing normalizado do HAR
 * @returns {string|null}
 */
function formatHARTiming(timing) {
  if (!timing) return null;
  const parts = [];
  if (timing.dnsMs     >= 0) parts.push(`dns:${timing.dnsMs}ms`);
  if (timing.tcpMs     >= 0) parts.push(`tcp:${timing.tcpMs}ms`);
  if (timing.sslMs     >= 0) parts.push(`tls:${timing.sslMs}ms`);
  if (timing.sendMs    >= 0) parts.push(`tx:${timing.sendMs}ms`);
  if (timing.waitMs    >= 0) parts.push(`ttfb:${timing.waitMs}ms`);     // TTFB = server processing
  if (timing.receiveMs >= 0) parts.push(`rx:${timing.receiveMs}ms`);
  if (timing.blockedMs >= 0) parts.push(`queue:${timing.blockedMs}ms`);
  return parts.length ? parts.join('  ') : null;
}

/**
 * Gera o relatório completo em texto plano pronto para exportação.
 *
 * @param {{
 *   name: string,
 *   requests: Object[],
 *   startedAt: number|null,
 *   finishedAt: number|null
 * }} session
 * @returns {string}
 */
export function generateTextReport(session) {
  const { name = 'Sessão sem nome', requests = [], startedAt, finishedAt } = session;
  const stats = getSessionStats(requests);
  const suggestions = generateSuggestions(requests);

  const lines = [];

  lines.push(LINE_FULL);
  lines.push('  SANKHYA MONITOR — RELATÓRIO DE SESSÃO');
  lines.push(LINE_FULL);
  lines.push('');
  lines.push(`Sessão: ${name}`);
  if (startedAt)  lines.push(`Início: ${new Date(startedAt).toLocaleString('pt-BR')}`);
  if (finishedAt) lines.push(`Fim:    ${new Date(finishedAt).toLocaleString('pt-BR')}`);
  lines.push('');

  // Resumo
  lines.push(LINE_LIGHT);
  lines.push('RESUMO');
  lines.push(LINE_LIGHT);
  lines.push(`Total de chamadas capturadas : ${stats.total}`);
  lines.push(`Chamadas relevantes          : ${stats.relevant}`);
  lines.push(`Chamadas críticas            : ${stats.critical}`);
  lines.push(`Gargalos (> 2s)              : ${stats.bottlenecks}`);
  lines.push(`Tempo máximo de resposta     : ${stats.maxDuration > 0 ? fmt(stats.maxDuration) : 'N/A'}`);
  lines.push(`Tempo médio (relevantes)     : ${stats.avgDuration > 0 ? fmt(stats.avgDuration) : 'N/A'}`);
  lines.push('');

  if (Object.keys(stats.byCategory).length) {
    lines.push('Distribuição por categoria:');
    for (const [cat, count] of Object.entries(stats.byCategory)) {
      lines.push(`  ${cat.padEnd(30)} ${count}`);
    }
    lines.push('');
  }

  // Chamadas relevantes ordenadas por tempo
  const relevant = [...requests]
    .filter((r) => r.classification?.category !== CATEGORIES.IRRELEVANT)
    .sort((a, b) => (b.duration || 0) - (a.duration || 0));

  if (relevant.length) {
    lines.push(LINE_LIGHT);
    lines.push('CHAMADAS RELEVANTES (por tempo de resposta)');
    lines.push(LINE_LIGHT);

    relevant.forEach((req, i) => {
      const bf  = req.parsedPayload?.businessFields ?? {};
    const sn  = extractServiceName(req) ?? '—';
      const app = req.queryParams?.application ?? bf.application ?? '';
      const cat = req.classification?.category ?? '—';
      const bot = req.classification?.isBottleneck ? ' + GARGALO' : '';
      const crit = req.classification?.isCritical ? ' ⚠ CRÍTICO' : '';

      let pathname = req.url;
      try { pathname = new URL(req.url).pathname; } catch (_) { /* usa a URL completa */ }

      lines.push('');
      lines.push(`${String(i + 1).padStart(2)}. ${req.method} ${pathname}`);
      lines.push(`    serviceName    : ${sn}`);
      if (app) lines.push(`    application    : ${app}`);
      lines.push(`    tempo          : ${fmt(req.duration || 0)}`);
      lines.push(`    status HTTP    : ${req.status || '—'}`);
      lines.push(`    classificação  : ${cat}${bot}${crit}`);
      if (req.classification?.reasons?.length) {
        lines.push(`    motivos        : ${req.classification.reasons.join(' | ')}`);
      }
    });
    lines.push('');
  }

  // Mapa completo de todos os serviços executados
  // SP services are highlighted first; all others listed after.
  const { spServices, otherServices } = getServiceMap(requests);

  if (spServices.length + otherServices.length > 0) {
    lines.push(LINE_LIGHT);
    lines.push('MAPA DE SERVIÇOS EXECUTADOS');
    lines.push(LINE_LIGHT);
    lines.push('');

    // ── Serviços SP em destaque ──────────────────────────────────────────
    if (spServices.length) {
      lines.push(`  ★ SERVIÇOS SP (${spServices.length}) — vinculados à classe de origem`);
      lines.push('  ' + '-'.repeat(50));
      lines.push('');
      for (const e of spServices) {
        const apps   = [...e.applications].join(', ') || '—';
        const cats   = [...e.categories].join(' | ')  || '—';
        const flags  = [e.hasCritical ? '⚠ CRÍTICO' : '', e.hasBottleneck ? '⚡ GARGALO' : ''].filter(Boolean).join('  ');
        const avgWait = e.waitMsCount > 0 ? Math.round(e.waitMsTotal / e.waitMsCount) : null;
        lines.push(`  [★ SP] ${e.serviceName}`);
        lines.push(`         Classe SP          : ${e.spClass}`);
        lines.push(`         Método             : ${e.method}`);
        lines.push(`         Classe origem (app): ${apps}`);
        lines.push(`         Categoria          : ${cats}`);
        lines.push(`         Chamadas           : ${e.callCount}  |  Tempo máx: ${fmt(e.maxDuration)}  |  Total: ${fmt(e.totalDuration)}`);
        if (avgWait !== null) {
          lines.push(`         TTFB médio (server): ${avgWait}ms  |  TTFB máx: ${e.maxWaitMs}ms`);
        }
        if (flags) lines.push(`         ${flags}`);
        lines.push('');
      }
    }

    // ── Demais serviços ──────────────────────────────────────────────────
    if (otherServices.length) {
      lines.push(`  Demais serviços (${otherServices.length}):`);
      lines.push('  ' + '-'.repeat(50));
      lines.push('');
      for (const e of otherServices) {
        const apps  = [...e.applications].join(', ') || '—';
        const cats  = [...e.categories].join(' | ')  || '—';
        const flags = [e.hasCritical ? '⚠' : '', e.hasBottleneck ? '⚡' : ''].filter(Boolean).join(' ');
        lines.push(`  [ ] ${e.serviceName}`);
        lines.push(`      Classe origem : ${apps}`);
        lines.push(`      Categoria     : ${cats}  |  Chamadas: ${e.callCount}  |  Tempo máx: ${fmt(e.maxDuration)}${flags ? '  ' + flags : ''}`);
        lines.push('');
      }
    }
  }

  // Seção de auditoria SP — rastreamento individual de cada chamada SP com timing HAR
  // Esta seção é o coração do diagnóstico: mostra CADA execução de SP com
  // seu timing detalhado (dns/tcp/tls/ttfb/rx) quando capturado pelo DevTools.
  // O TTFB (Time to First Byte = wait) representa o tempo de processamento no servidor.
  const spCalls = requests.filter((r) => {
    const sn = extractServiceName(r);
    return sn && /\bSP\./i.test(sn) && r.classification?.category !== CATEGORIES.IRRELEVANT;
  }).sort((a, b) => (b.duration || 0) - (a.duration || 0));

  if (spCalls.length) {
    lines.push(LINE_LIGHT);
    lines.push('★ AUDITORIA SP — CHAMADAS INDIVIDUAIS (detalhes HAR)');
    lines.push('  TTFB = Time to First Byte = processamento no servidor');
    lines.push(LINE_LIGHT);

    spCalls.forEach((req, i) => {
      const sn    = extractServiceName(req) ?? '—';
      const spCls = sn.includes('.') ? sn.split('.')[0] : sn;
      const meth  = sn.includes('.') ? sn.split('.').slice(1).join('.') : '—';
      const app   = req.queryParams?.application
                 ?? req.parsedPayload?.businessFields?.application
                 ?? '—';
      const ts    = req.timestamp ? new Date(req.timestamp).toLocaleTimeString('pt-BR') : '—';
      const harTiming = formatHARTiming(req.timing);

      lines.push('');
      lines.push(`  #${String(i + 1).padStart(2)} ${spCls}.${meth}`);
      lines.push(`       Classe SP     : ${spCls}`);
      lines.push(`       Método SP     : ${meth}`);
      lines.push(`       Classe origem : ${app}`);
      lines.push(`       Hora          : ${ts}`);
      lines.push(`       Duração total : ${fmt(req.duration || 0)}  |  HTTP ${req.status || '—'}`);
      lines.push(`       Fonte captura : ${req.source || '—'}`);
      if (harTiming) {
        lines.push(`       HAR timing    : ${harTiming}`);
      } else {
        lines.push(`       HAR timing    : (abrir DevTools para capturar timing detalhado)`);
      }
      if (req.classification?.isCritical) {
        lines.push(`       ⚠ CRÍTICO     : ${req.parsedResponse?.errorMessage?.substring(0, 100) ?? 'erro reportado'}`);
      }
      if (req.classification?.isBottleneck) {
        lines.push(`       ⚡ GARGALO     : tempo acima de 2s — verificar processamento SP no servidor`);
      }
    });
    lines.push('');
  }

  // Seção de críticos com detalhes do erro
  const criticals = requests.filter((r) => r.classification?.isCritical);
  if (criticals.length) {
    lines.push(LINE_LIGHT);
    lines.push('CHAMADAS CRÍTICAS — DETALHES');
    lines.push(LINE_LIGHT);

    criticals.forEach((req, i) => {
      const sn = extractServiceName(req) ?? '—';
      const harTiming = formatHARTiming(req.timing);
      lines.push('');
      lines.push(`${String(i + 1).padStart(2)}. ${req.method} ${req.url}`);
      lines.push(`    serviceName : ${sn}`);
      lines.push(`    status HTTP : ${req.status || '—'}  |  duração: ${fmt(req.duration || 0)}`);
      if (harTiming)                        lines.push(`    HAR timing  : ${harTiming}`);
      if (req.parsedResponse?.errorMessage) lines.push(`    mensagem    : ${req.parsedResponse.errorMessage}`);
      if (req.classification?.reasons?.length) {
        lines.push(`    diagnóstico : ${req.classification.reasons.join(' | ')}`);
      }
    });
    lines.push('');
  }

  // Sugestões
  if (suggestions.length) {
    lines.push(LINE_LIGHT);
    lines.push('SUGESTÕES PARA ANÁLISE BACKEND');
    lines.push(LINE_LIGHT);
    suggestions.forEach((s) => lines.push(`  • ${s}`));
    lines.push('');
  }

  lines.push(LINE_FULL);
  lines.push('  Gerado por Sankhya Monitor — https://github.com/john-lenes/monitor_tools.git');
  lines.push(LINE_FULL);

  return lines.join('\n');
}
