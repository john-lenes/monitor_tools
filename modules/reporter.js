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

  return { total: requests.length, relevant: relevant.length, critical: critical.length, bottlenecks: bottlenecks.length, maxDuration, avgDuration, byCategory };
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

    // serviceName
    const sn = queryParams?.serviceName ?? bf.serviceName ?? bf.servicename;
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
// Geração do relatório em texto plano
// ---------------------------------------------------------------------------

const LINE_FULL  = '='.repeat(62);
const LINE_LIGHT = '-'.repeat(42);
const fmt = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

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
      const sn  = req.queryParams?.serviceName ?? bf.serviceName ?? bf.servicename ?? '—';
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

  // Seção de críticos com detalhes do erro
  const criticals = requests.filter((r) => r.classification?.isCritical);
  if (criticals.length) {
    lines.push(LINE_LIGHT);
    lines.push('CHAMADAS CRÍTICAS — DETALHES');
    lines.push(LINE_LIGHT);

    criticals.forEach((req, i) => {
      const sn = req.queryParams?.serviceName ?? '—';
      lines.push('');
      lines.push(`${String(i + 1).padStart(2)}. ${req.method} ${req.url}`);
      lines.push(`    serviceName : ${sn}`);
      lines.push(`    status HTTP : ${req.status || '—'}`);
      if (req.parsedResponse?.errorMessage) {
        lines.push(`    mensagem    : ${req.parsedResponse.errorMessage}`);
      }
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
  lines.push('  Gerado por Sankhya Monitor — github.com/sankhya-monitor');
  lines.push(LINE_FULL);

  return lines.join('\n');
}
