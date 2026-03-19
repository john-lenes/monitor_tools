/**
 * report.js — Módulo ES para a página report.html
 *
 * Página de relatório completo, aberta numa nova aba quando o usuário
 * clica "Ver Relatório Completo" no popup (ou via chrome.tabs.create).
 *
 * DIFERENÇA EM RELAÇÃO AO POPUP:
 *  O popup.js exibe uma lista inline com 500px de largura e renderiza
 *  apenas o essencial (nome, tempo, categoria) por questões de espaço.
 *  Este módulo renderiza uma página completa de 1000px com:
 *    - Tabela com todas as colunas (serviceName, application, status, etc.)
 *    - Linhas expansíveis (acordeon) com payload, response e classificação
 *    - Aba de chamadas críticas separada
 *    - Aba de sugestões geradas pelo reporter.js (deduplicas)
 *    - Aba de relatório em texto plano (para exportação .txt)
 *
 * USANDO COMO MÓDULO ES:
 *  Importa apenas as funções necessárias do reporter.js.
 *  NÃO depende de popup.js — carrega dados do background diretamente.
 */

import { generateTextReport, generateSuggestions, getSessionStats, getServiceMap, filterEssential } from './modules/reporter.js';
import { groupByFlow } from './modules/flow-analyzer.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(async function main() {
  const app = document.getElementById('app');

  let session, status;
  try {
    const res = await sendMsg({ action: 'GET_SESSION_DATA' });
    session = res.session;
    status  = res.status;
  } catch (e) {
    app.innerHTML = `<div class="empty-page">
      <h2>Erro ao carregar sessão</h2>
      <p>${escHtml(e.message)}</p>
    </div>`;
    return;
  }

  if (!session || !session.requests || session.requests.length === 0) {
    app.innerHTML = `<div class="empty-page">
      <h2>Nenhuma sessão disponível</h2>
      <p>Inicie uma sessão no popup e execute ações no Sankhya antes de abrir o relatório.</p>
    </div>`;
    return;
  }

  // Garante que o relatório textual está gerado
  if (!session.textReport) {
    session.textReport = generateTextReport(session);
  }

  renderPage(app, session, status);
})();

// ---------------------------------------------------------------------------
// Renderização principal
// ---------------------------------------------------------------------------

function renderPage(container, session, status) {
  const stats                       = getSessionStats(session.requests);
  const suggestions                 = generateSuggestions(session.requests);
  const { spServices, otherServices } = getServiceMap(session.requests);
  // filterEssential: SP todas, críticos/gargalos todos, demais 1 por serviceName (a mais lenta)
  const relevant      = filterEssential(session.requests);
  const totalRelev    = session.requests.filter((r) => r.classification?.category !== 'IRRELEVANTE').length;
  const relevLabel    = totalRelev > relevant.length
    ? `${relevant.length} de ${totalRelev}`
    : String(relevant.length);

  const criticals = session.requests.filter((r) => r.classification?.isCritical);
  const totalServices = spServices.length + otherServices.length;
  // E9: fluxos funcionais
  const flows = groupByFlow(session.requests);

  container.innerHTML = `
    <!-- Header -->
    <div class="page-header">
      <div>
        <h1>⬡ Sankhya Monitor — Relatório</h1>
        <div class="subtitle">
          Sessão: <strong>${escHtml(session.name || 'Sem nome')}</strong>
          ${session.startedAt ? ` · Início: ${new Date(session.startedAt).toLocaleString('pt-BR')}` : ''}
          ${session.finishedAt ? ` · Fim: ${new Date(session.finishedAt).toLocaleString('pt-BR')}` : ''}
          · <span style="color:var(--${status === 'monitoring' ? 'success' : 'muted'})">${statusLabel(status)}</span>
        </div>
      </div>
      <div class="export-btns">
        <button class="btn btn-ghost" id="btn-export-json">⬇ JSON</button>
        <button class="btn btn-ghost" id="btn-export-txt">⬇ TXT</button>
        <button class="btn btn-danger" id="btn-clear">↺ Nova Sessão</button>
      </div>
    </div>

    <!-- Stats -->
    <div class="stats-grid">
      <div class="stat-card sc-total">
        <span class="val">${stats.total}</span>
        <span class="lbl">Total Capturadas</span>
      </div>
      <div class="stat-card sc-relevant">
        <span class="val">${stats.relevant}</span>
        <span class="lbl">Relevantes</span>
      </div>
      <div class="stat-card sc-critical">
        <span class="val">${stats.critical}</span>
        <span class="lbl">Críticas</span>
      </div>
      <div class="stat-card sc-bottleneck">
        <span class="val">${stats.bottlenecks}</span>
        <span class="lbl">Gargalos (&gt;2s)</span>
      </div>
      <div class="stat-card sc-maxtime">
        <span class="val">${fmtDuration(stats.maxDuration)}</span>
        <span class="lbl">T. Máximo</span>
      </div>
      <div class="stat-card sc-avgtime">
        <span class="val">${fmtDuration(stats.avgDuration)}</span>
        <span class="lbl">T. Médio</span>
      </div>
      <div class="stat-card" style="border-color:#f59e0b">
        <span class="val" style="color:#f59e0b">${stats.spCount || 0}</span>
        <span class="lbl">Serviços SP</span>
      </div>
    </div>

    <!-- Category chips -->
    ${renderCategoryChips(stats.byCategory)}

    <!-- Tabs -->
    <div class="tabs">
      <button class="tab-btn active" data-tab="calls">Chamadas (${relevLabel})</button>
      <button class="tab-btn" data-tab="criticals">Críticas (${criticals.length})</button>
      <button class="tab-btn sp-tab" data-tab="services">★ Serviços SP (${spServices.length}/${totalServices})</button>
      <button class="tab-btn" data-tab="flows">Fluxo (${flows.length})</button>
      <button class="tab-btn" data-tab="suggestions">Sugestões (${suggestions.length})</button>
      <button class="tab-btn" data-tab="textreport">Relatório Texto</button>
    </div>

    <!-- Tab: Chamadas -->
    <div class="tab-panel active" id="tab-calls">
      <div class="section">
        ${renderCallTable(relevant)}
      </div>
    </div>

    <!-- Tab: Críticas -->
    <div class="tab-panel" id="tab-criticals">
      <div class="section">
        ${criticals.length > 0
          ? renderCallTable(criticals)
          : '<p style="color:var(--muted);padding:20px 0">Nenhuma chamada crítica nesta sessão.</p>'
        }
      </div>
    </div>

    <!-- Tab: Serviços SP -->
    <div class="tab-panel" id="tab-services">
      <div class="section">
        ${renderServiceMap(spServices, otherServices)}
      </div>
    </div>

    <!-- Tab: Fluxo (E9) -->
    <div class="tab-panel" id="tab-flows">
      <div class="section">
        ${renderFlowTimeline(flows)}
      </div>
    </div>

    <!-- Tab: Sugestões -->
    <div class="tab-panel" id="tab-suggestions">      <div class="section">
        ${suggestions.length > 0
          ? `<ul class="suggestion-list">${suggestions.map((s) => `<li>${escHtml(s)}</li>`).join('')}</ul>`
          : '<p style="color:var(--muted);padding:20px 0">Nenhuma sugestão gerada.</p>'
        }
      </div>
    </div>

    <!-- Tab: Relatório Texto -->
    <div class="tab-panel" id="tab-textreport">
      <div class="section">
        <pre id="text-report">${escHtml(session.textReport)}</pre>
      </div>
    </div>
  `;

  // Wires up tabs
  container.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.tab-btn, .tab-panel').forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      container.querySelector(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // Wire up expandable rows
  wireExpandableRows(container, session.requests);

  // Wire up export buttons
  container.querySelector('#btn-export-json').addEventListener('click', () => exportJson(session));
  container.querySelector('#btn-export-txt').addEventListener('click', () => exportTxt(session));
  container.querySelector('#btn-clear').addEventListener('click', async () => {
    if (!confirm('Limpar a sessão? Os dados serão perdidos.')) return;
    await sendMsg({ action: 'CLEAR_SESSION' });
    window.close();
  });
}

// ---------------------------------------------------------------------------
// Renderização da tabela de chamadas
// ---------------------------------------------------------------------------

function renderCallTable(requests) {
  if (!requests.length) return '<p style="color:var(--muted);padding:16px 0">Nenhuma chamada para exibir.</p>';

  const rows = requests.map((req, i) => {
    const sn  = req.queryParams?.serviceName
             || req.parsedPayload?.businessFields?.serviceName
             || req.parsedPayload?.businessFields?.servicename
             || '—';
    const app = req.queryParams?.application
             || req.parsedPayload?.businessFields?.application
             || '—';
    const cat  = req.classification?.category || '—';
    const crit = req.classification?.isCritical;
    const bot  = req.classification?.isBottleneck;
    const dur  = fmtDuration(req.duration || 0);
    const tCls = timeClass(req.duration || 0);
    const mCls = 'method-' + ((['POST','GET','PUT','DELETE'].includes(req.method)) ? req.method : 'OTHER');

    let catCls = '';
    if (crit) catCls = 'critical';
    else if (bot) catCls = 'bottleneck';
    else if (cat === 'REGRA DE NEGÓCIO') catCls = 'business';
    else if (cat === 'PERSISTÊNCIA') catCls = 'persist';

    let pathname = req.url;
    try { pathname = new URL(req.url).pathname; } catch (_) { /* usa url completa */ }

    // E2/E5: coluna "Frontend / Hipótese" com badge de confiança
    const corr = req.correlation;
    const hyp  = req.hypothesis;
    let frontendCell = '<span style="color:var(--muted)">—</span>';
    if (corr?.frontendOwner?.file) {
      const fname = corr.frontendOwner.file.split('/').pop();
      const conf  = corr.confidence ?? 0;
      const pct   = Math.round(conf * 100);
      const badgeColor = conf >= 0.8 ? 'var(--success)' : conf >= 0.5 ? '#f59e0b' : 'var(--muted)';
      frontendCell = `<span style="color:${badgeColor};font-size:11px;font-weight:600">[${pct}%]</span> ${escHtml(fname)}`;
      if (hyp?.hypothesis) {
        const hconf = Math.round((hyp.confidence ?? 0) * 100);
        const hColor = (hyp.confidence ?? 0) >= 0.8 ? 'var(--success)' : (hyp.confidence ?? 0) >= 0.5 ? '#f59e0b' : 'var(--muted)';
        frontendCell += `<br><span style="font-size:10px;color:${hColor}">[${hconf}%] ${escHtml((hyp.hypothesis || '').substring(0, 50))}…</span>`;
      }
    } else if (corr?.patternHint) {
      const conf = corr.confidence ?? 0;
      const pct  = Math.round(conf * 100);
      frontendCell = `<span style="color:var(--muted);font-size:11px">[${pct}%] ${escHtml(corr.patternHint)}</span>`;
    } else if (hyp?.hypothesis) {
      const hconf = Math.round((hyp.confidence ?? 0) * 100);
      const hColor = (hyp.confidence ?? 0) >= 0.4 ? '#f59e0b' : 'var(--muted)';
      frontendCell = `<span style="font-size:10px;color:${hColor}">[${hconf}%] ${escHtml((hyp.hypothesis || '').substring(0, 60))}</span>`;
    }

    return `
      <tr class="expandable${crit ? ' critical' : ''}" data-idx="${i}" data-id="${escHtml(req.id)}">
        <td><span class="method-badge ${mCls}">${escHtml(req.method)}</span></td>
        <td>${escHtml(pathname)}</td>
        <td>${escHtml(sn)}</td>
        <td>${escHtml(app)}</td>
        <td><span class="time-badge time-${tCls}">${escHtml(dur)}</span></td>
        <td>${escHtml(String(req.status || '—'))}</td>
        <td><span class="cat-badge ${catCls}">${escHtml(cat)}${crit ? ' ⚠' : bot ? ' ⚡' : ''}</span></td>
        <td style="font-size:11px;max-width:180px">${frontendCell}</td>
      </tr>
      <tr class="detail-row" id="detail-row-${i}">
        <td colspan="8"></td>
      </tr>`;
  }).join('');

  return `
    <table class="call-table">
      <thead>
        <tr>
          <th>Método</th>
          <th>Path</th>
          <th>serviceName</th>
          <th>application</th>
          <th>Tempo</th>
          <th>Status</th>
          <th>Classificação</th>
          <th>Frontend / Hipótese</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Habilita o padrão acórdeon nas linhas da tabela de chamadas.
 *
 * Cada `tr.expandable` (linha principal) tem um `tr.detail-row` imediatamente
 * abaixo com `colspan="7"` que começa oculto. Ao clicar na linha principal,
 * o detail-row é populado com buildDetailContent() e exibido.
 *
 * COMPORTAMENTO ACÓRDEON:
 *  Apenas UM detail-row fica visível por vez. Clicar numa linha já aberta
 *  a fecha. Clicar numa nova linha fecha a anterior e abre a nova.
 *  Isso evita que a tabela fique longa demais com vários detalhes abertos.
 */
function wireExpandableRows(container, allRequests) {
  container.querySelectorAll('tr.expandable').forEach((tr) => {
    tr.addEventListener('click', () => {
      const idx = tr.getAttribute('data-idx');
      const id  = tr.getAttribute('data-id');
      const detailRow = container.querySelector(`#detail-row-${idx}`);
      if (!detailRow) return;

      const isOpen = detailRow.classList.contains('visible');

      // Fecha todos os outros
      container.querySelectorAll('.detail-row.visible').forEach((r) => r.classList.remove('visible'));

      if (!isOpen) {
        const req = allRequests.find((r) => r.id === id);
        if (req) {
          detailRow.querySelector('td').innerHTML = buildDetailContent(req);
          detailRow.classList.add('visible');
        }
      }
    });
  });
}

/**
 * Constrói o HTML do painel de detalhes expandido de uma chamada.
 *
 * ESTRUTURA DO PAINEL (seções condicionais):
 *  [sempre]  Query Parameters — serviceName, application, resourceID, etc.
 *  [se tiver] Campos de Negócio — nunota, codparc, event, listener, etc.
 *  [sempre]  Classificação — categoria, flags isCritical/isBottleneck, motivos
 *  [se erro] Erro Detectado — mensagem de exceção Java ou erro Oracle
 *  [se tiver] Request Body — payload truncado (< 4096 bytes)
 *  [se tiver] Response — resumo do corpo da resposta
 *
 * Todos os valores são escapados com escHtml() antes de inserir no DOM
 * para prevenir XSS caso o Sankhya retorne conteúdo HTML em respostas de erro.
 */
function buildDetailContent(req) {
  const bf  = req.parsedPayload?.businessFields ?? {};
  const qp  = req.queryParams ?? {};

  const params = [
    ['serviceName',  qp.serviceName  || bf.serviceName || bf.servicename || '—'],
    ['application',  qp.application  || bf.application || '—'],
    ['resourceID',   qp.resourceID   || '—'],
    ['globalID',     qp.globalID     || '—'],
    ['mgeSession',   qp.mgeSession   || '—'],
    ['outputType',   qp.outputType   || '—'],
  ];

  // Campos de negócio extras
  const bizKeys = ['nunota','codemp','codparc','codprod','nuseq','entityName',
                   'action','event','listener','method'];
  const bizRows = bizKeys
    .filter((k) => bf[k] != null || bf[k.toLowerCase()] != null)
    .map((k) => [k, String(bf[k] ?? bf[k.toLowerCase()])]);

  // HAR timing breakdown (só disponível quando DevTools estiver aberto durante a captura)
  const timing = req.timing;
  const timingRows = timing ? [
    timing.dnsMs     >= 0 ? ['DNS lookup',        `${timing.dnsMs}ms`]         : null,
    timing.tcpMs     >= 0 ? ['TCP handshake',     `${timing.tcpMs}ms`]         : null,
    timing.sslMs     >= 0 ? ['TLS handshake',     `${timing.sslMs}ms`]         : null,
    timing.sendMs    >= 0 ? ['Envio request',     `${timing.sendMs}ms`]        : null,
    timing.waitMs    >= 0 ? ['TTFB (servidor)',   `${timing.waitMs}ms`]        : null,
    timing.receiveMs >= 0 ? ['Download resp.',   `${timing.receiveMs}ms`]    : null,
    timing.blockedMs >= 0 ? ['Em fila',           `${timing.blockedMs}ms`]    : null,
  ].filter(Boolean) : [];

  const classDetails = [
    ['classificação', req.classification?.category || '—'],
    ['crítico',       req.classification?.isCritical ? '⚠ SIM' : 'não'],
    ['gargalo',       req.classification?.isBottleneck ? '⚡ SIM' : 'não'],
    ['motivos',       (req.classification?.reasons || []).join(' | ') || '—'],
    ['status HTTP',   req.status || '—'],
    ['duração',       fmtDuration(req.duration || 0)],
    req.contentType  ? ['content-type',  req.contentType]  : null,
    req.transferSize >= 0 ? ['transferido', `${req.transferSize} bytes`] : null,
    ['timestamp',     new Date(req.timestamp || 0).toLocaleString('pt-BR')],
    ['fonte captura', req.source || '—'],
    req.resourceType ? ['tipo recurso', req.resourceType] : null,
  ].filter(Boolean);

  const kvList = (rows) => rows.map(([k, v]) =>
    `<li><span class="k">${escHtml(k)}</span><span class="v">${escHtml(String(v))}</span></li>`
  ).join('');

  const errorSection = req.parsedResponse?.hasError
    ? `<div class="detail-block">
        <h4>⚠ Erro Detectado</h4>
        <div class="code-block">${escHtml(req.parsedResponse.errorMessage || 'Erro sem mensagem')}</div>
      </div>`
    : '';

  const payloadSection = req.parsedPayload?.raw
    ? `<div class="detail-block">
        <h4>Request Body</h4>
        <div class="code-block">${escHtml(req.parsedPayload.raw)}</div>
      </div>`
    : '';

  const responseSection = req.parsedResponse?.summary
    ? `<div class="detail-block">
        <h4>Response (resumo)</h4>
        <div class="code-block">${escHtml(req.parsedResponse.summary)}</div>
      </div>`
    : '';

  return `
    <div class="detail-inner">
      <div class="detail-block">
        <h4>Query Parameters</h4>
        <ul class="kv-list">${kvList(params)}</ul>
      </div>
      ${bizRows.length ? `
      <div class="detail-block">
        <h4>Campos de Negócio</h4>
        <ul class="kv-list">${kvList(bizRows)}</ul>
      </div>` : ''}
      <div class="detail-block">
        <h4>Classificação</h4>
        <ul class="kv-list">${kvList(classDetails)}</ul>
      </div>
      ${timingRows.length ? `
      <div class="detail-block">
        <h4>HAR Timing (camada de rede)</h4>
        <ul class="kv-list">${kvList(timingRows)}</ul>
      </div>` : ''}
      ${(() => {
        const corr = req.correlation;
        if (!corr) return '';
        const fo   = corr.frontendOwner;
        const pct  = Math.round((corr.confidence ?? 0) * 100);
        const rows = [
          ['padrão detectado', corr.patternHint || '—'],
          ['categoria',        corr.category    || '—'],
          ['confiança',        `${pct}%`],
          fo ? ['arquivo',     fo.file] : null,
          fo ? ['função',      fo.fn  ] : null,
          fo ? ['linha',       String(fo.line || '—')] : null,
        ].filter(Boolean);
        return `
      <div class="detail-block">
        <h4>🔗 Correlação Frontend</h4>
        <ul class="kv-list">${kvList(rows)}</ul>
      </div>`;
      })()}
      ${(() => {
        const hyp = req.hypothesis;
        if (!hyp?.hypothesis) return '';
        const pct  = Math.round((hyp.confidence ?? 0) * 100);
        const beans = (hyp.beans || []).map((b) => escHtml(b)).join(', ') || '—';
        return `
      <div class="detail-block">
        <h4>💡 Hipótese de Backend</h4>
        <ul class="kv-list">
          <li><span class="k">hipótese</span><span class="v">${escHtml(hyp.hypothesis)}</span></li>
          <li><span class="k">confiança</span><span class="v">${pct}%</span></li>
          <li><span class="k">beans a inspecionar</span><span class="v">${beans}</span></li>
        </ul>
      </div>`;
      })()}
      ${(() => {
        const ev = req.sourceEvidence;
        if (!ev?.length) return '';
        const items = ev.map((e) => `
          <div style="margin-bottom:8px">
            <code style="font-size:10px;opacity:.7">${escHtml(e.file)}:${e.lineNum || ''}</code>
            <pre class="code-block" style="margin:2px 0 0">${escHtml(e.snippet || '')}</pre>
          </div>`).join('');
        return `
      <div class="detail-block">
        <h4>📄 Evidência no Código</h4>
        ${items}
      </div>`;
      })()}
      ${(() => {
        const ui = req.uiContext;
        if (!ui?.length) return '';
        const baseTs = req.timestamp || 0;
        const rows = ui.map((e) => {
          const delta = baseTs ? Math.round((e.ts - baseTs) / 1000) : null;
          const when  = delta !== null ? `${delta > 0 ? '+' : ''}${delta}s` : new Date(e.ts).toLocaleTimeString('pt-BR');
          const label = [e.type, e.tag, e.id ? `#${e.id}` : '', e.text ? `"${e.text.substring(0,30)}"` : ''].filter(Boolean).join(' ');
          return `<li><span class="k">${escHtml(when)}</span><span class="v">${escHtml(label)}</span></li>`;
        }).join('');
        return `
      <div class="detail-block">
        <h4>🖱 Ação do Usuário (antes da chamada)</h4>
        <ul class="kv-list">${rows}</ul>
      </div>`;
      })()}
      ${(() => {
        const sc = req.screenContext;
        if (!sc) return '';
        const crumbs = (sc.breadcrumbs || []).join(' › ') || '—';
        const rows = [
          ['título',      sc.title     || '—'],
          ['hash',        sc.hash      || '—'],
          ['breadcrumb',  crumbs],
          sc.activeTab    ? ['aba ativa',   sc.activeTab]                 : null,
          sc.modalTitle   ? ['modal',       sc.modalTitle]                : null,
          sc.formHints?.formId      ? ['form-id',     sc.formHints.formId]     : null,
          sc.formHints?.resourceId  ? ['resource-id', sc.formHints.resourceId] : null,
          sc.formHints?.application ? ['application', sc.formHints.application]: null,
          sc.selectedContext?.entityName ? ['entidade',  sc.selectedContext.entityName]     : null,
          sc.selectedContext?.pk         ? ['PK',        String(sc.selectedContext.pk)]      : null,
          sc.selectedContext?.rowId      ? ['rowId',     String(sc.selectedContext.rowId)]   : null,
        ].filter(Boolean);
        return `
      <div class="detail-block">
        <h4>🖥 Contexto da Tela</h4>
        <ul class="kv-list">${rows.map(([k,v]) => `<li><span class="k">${escHtml(k)}</span><span class="v">${escHtml(String(v))}</span></li>`).join('')}</ul>
      </div>`;
      })()}
      ${(() => {
        const ac = req.apiCall;
        if (!ac) return '';
        const rows = [
          ['fonte',       'api-patch (antes da serialização HTTP)'],
          ['função',      ac.fn          || '—'],
          ['serviceName', ac.serviceName || '—'],
          ['application', ac.application || '—'],
          ['resourceID',  ac.resourceID  || '—'],
          ['thisContext', ac.thisContext  || '—'],
          ac.deltaMs != null ? ['Δ HTTP (ms)', String(ac.deltaMs)] : null,
          ac.rawArg ? ['rawArg', JSON.stringify(ac.rawArg).substring(0, 200)] : null,
        ].filter(Boolean);
        const stackLines = (ac.callStack?.frames || []).slice(0, 6)
          .map((f) => `${f.fn || '(anon)'} @ ${(f.file || '').split('/').pop()}:${f.line || '?'}`)
          .join('\n');
        return `
      <div class="detail-block">
        <h4>⚡ API Patch (M1/M2) — Captura Direta</h4>
        <ul class="kv-list">${rows.map(([k,v]) => `<li><span class="k">${escHtml(k)}</span><span class="v">${escHtml(String(v))}</span></li>`).join('')}</ul>
        ${stackLines ? `<div class="code-block" style="margin-top:6px;font-size:10px">${escHtml(stackLines)}</div>` : ''}
      </div>`;
      })()}
      ${(() => {
        const zones = req.parsedPayload?.zones;
        if (!zones) return '';
        const nonEmpty = Object.entries(zones).filter(([, v]) => v && Object.keys(v).length > 0);
        if (!nonEmpty.length) return '';
        const parts = nonEmpty.map(([zone, fields]) => {
          const pairs = Object.entries(fields).map(([k, v]) =>
            `<li><span class="k">${escHtml(zone)}.${escHtml(k)}</span><span class="v">${escHtml(String(v))}</span></li>`
          ).join('');
          return pairs;
        }).join('');
        return `
      <div class="detail-block">
        <h4>🗂 Payload Zones (M8)</h4>
        <ul class="kv-list">${parts}</ul>
      </div>`;
      })()}
      ${(() => {
        const corr = req.correlation;
        const ownerFrame      = corr?.ownerFrame;
        const dispatcherFrame = corr?.dispatcherFrame;
        if (!ownerFrame && !dispatcherFrame) return '';
        const src   = corr?.source || '—';
        let rows = [['fonte atribuição', src]];
        if (ownerFrame) {
          rows.push(['ownerFrame fn',   ownerFrame.fn   || '(anon)']);
          rows.push(['ownerFrame file', (ownerFrame.file || '').split('/').pop() + ':' + (ownerFrame.line || '?')]);
        }
        if (dispatcherFrame) {
          rows.push(['dispatcherFrame fn',   dispatcherFrame.fn   || '(anon)']);
          rows.push(['dispatcherFrame file', (dispatcherFrame.file || '').split('/').pop() + ':' + (dispatcherFrame.line || '?')]);
        }
        return `
      <div class="detail-block">
        <h4>🔎 Stack Frames (M9)</h4>
        <ul class="kv-list">${rows.map(([k,v]) => `<li><span class="k">${escHtml(k)}</span><span class="v">${escHtml(String(v))}</span></li>`).join('')}</ul>
      </div>`;
      })()}
      ${errorSection}
      ${payloadSection}
      ${responseSection}
    </div>`;
}

// ---------------------------------------------------------------------------
// Mapa de serviços SP
// ---------------------------------------------------------------------------

/**
 * Renderiza o painel "Serviços SP" da página de relatório.
 *
 * SP services aparecem em destaque no topo (fundo diferenciado, badge ★).
 * Os demais serviços ficam abaixo em tabela compacta.
 *
 * @param {Object[]} spServices    entradas SP do getServiceMap
 * @param {Object[]} otherServices demais entradas do getServiceMap
 * @returns {string}  HTML
 */

// ---------------------------------------------------------------------------
// Fluxos funcionais (E9)
// ---------------------------------------------------------------------------
function renderFlowTimeline(flows) {
  if (!flows || !flows.length) {
    return '<p style="color:var(--muted);padding:20px 0">Nenhum fluxo detectado. Execute ações no Sankhya com a sessão ativa.</p>';
  }

  return flows.map((flow, fi) => {
    const dur = fmtDuration(flow.duration || 0);
    const critBadge = flow.hasCritical   ? '<span class="cat-badge critical">⚠ CRÍTICO</span>' : '';
    const botBadge  = flow.hasBottleneck ? '<span class="cat-badge bottleneck">⚡ GARGALO</span>' : '';
    const spBadge   = flow.hasSP         ? '<span class="cat-badge business">★ SP</span>' : '';

    let triggerText = 'sem evento';
    if (flow.trigger) {
      const t = flow.trigger;
      const txt = t.text ? `"${(t.text).substring(0, 30)}"` : t.type;
      triggerText = `${txt}`;
    }

    // M10: frontendHint, primaryError, primaryBottleneck, tree
    const fh  = flow.frontendHint;
    const pe  = flow.primaryError;
    const pb  = flow.primaryBottleneck;
    const tree = flow.tree || [];

    const frontendHintHtml = fh
      ? `<div style="font-size:11px;color:#15803d;margin:4px 0 0 4px">⚡ ${escHtml(fh.fn || fh.file || '?')} [${Math.round((fh.confidence||0)*100)}% · ${escHtml(fh.source||'')}]</div>`
      : '';
    const primaryErrorHtml = pe
      ? `<div style="font-size:11px;color:var(--danger);margin:2px 0 0 4px">⚠ Erro principal: ${escHtml(extractSN(pe))} — ${escHtml(pe.parsedResponse?.errorMessage?.substring(0,80)||'erro reportado')}</div>`
      : '';
    const primaryBottleneckHtml = pb
      ? `<div style="font-size:11px;color:#f59e0b;margin:2px 0 0 4px">⚡ Gargalo principal: ${escHtml(extractSN(pb))} — ${fmtDuration(pb.duration||0)}</div>`
      : '';

    // Build tree rows (indented by depth)
    const treeRows = tree.length ? tree.map((node) => {
      const indent = '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(node.depth || 0);
      const icon   = node.isRoot ? '▶' : '↳';
      const sn2    = escHtml(extractSN(node.req));
      const rt2    = escHtml(String(node.req?.parsedPayload?.requestType ?? '—'));
      const dur2   = fmtDuration(node.req?.duration || 0);
      const tCls2  = timeClass(node.req?.duration || 0);
      return `<tr>
        <td>${indent}${icon}</td>
        <td>${sn2}</td>
        <td>${rt2}</td>
        <td><span class="time-badge time-${tCls2}">${dur2}</span></td>
      </tr>`;
    }).join('') : null;

    const innerRows = (flow.requests || []).map((req) => {
      const sn  = req.queryParams?.serviceName
               || req.parsedPayload?.businessFields?.serviceName
               || req.parsedPayload?.businessFields?.servicename
               || '—';
      const rt  = req.parsedPayload?.requestType ?? '—';
      const dur2 = fmtDuration(req.duration || 0);
      const tCls = timeClass(req.duration || 0);
      const mCls = 'method-' + ((['POST','GET','PUT','DELETE'].includes(req.method)) ? req.method : 'OTHER');
      return `<tr>
        <td>${new Date(req.timestamp || 0).toLocaleTimeString('pt-BR')}</td>
        <td><span class="method-badge ${mCls}">${escHtml(req.method)}</span></td>
        <td>${escHtml(sn)}</td>
        <td>${escHtml(String(rt))}</td>
        <td><span class="time-badge time-${tCls}">${escHtml(dur2)}</span></td>
      </tr>`;
    }).join('');

    return `<details class="flow-group" ${fi === 0 ? 'open' : ''}>
      <summary class="flow-header">
        <strong>${escHtml(flow.name || 'Fluxo')}</strong>
        <span class="flow-meta">${flow.requests.length} chamadas · ${escHtml(dur)} · trigger: ${escHtml(triggerText)}</span>
        ${critBadge}${botBadge}${spBadge}
        ${flow.application ? `<span style="font-size:11px;color:var(--muted)">app: ${escHtml(flow.application)}</span>` : ''}
      </summary>
      ${frontendHintHtml}${primaryErrorHtml}${primaryBottleneckHtml}
      ${treeRows ? `
      <h5 style="margin:8px 0 4px 4px;font-size:11px;color:var(--muted)">Árvore de chamadas (M10)</h5>
      <table class="call-table" style="margin:0 0 8px 16px;font-size:11px">
        <thead><tr><th></th><th>serviceName</th><th>Tipo</th><th>Tempo</th></tr></thead>
        <tbody>${treeRows}</tbody>
      </table>` : ''}
      <h5 style="margin:4px 0 4px 4px;font-size:11px;color:var(--muted)">Sequência HTTP</h5>
      <table class="call-table" style="margin:8px 0 0 16px">
        <thead><tr><th>Hora</th><th>Método</th><th>serviceName</th><th>Tipo</th><th>Tempo</th></tr></thead>
        <tbody>${innerRows}</tbody>
      </table>
    </details>`;
  }).join('');
}

function renderServiceMap(spServices, otherServices) {
  if (!spServices.length && !otherServices.length) {
    return '<p style="color:var(--muted);padding:20px 0">Nenhum serviço identificado nesta sessão.</p>';
  }

  let html = '';

  // ── Serviços SP em destaque ────────────────────────────────────────────
  if (spServices.length) {
    html += `<h3 style="color:#f59e0b;margin:0 0 12px">★ Serviços SP — Classe de Origem (${spServices.length})</h3>`;
    html += '<div class="sp-cards">';
    for (const e of spServices) {
      const apps  = [...e.applications].join(', ') || '—';
      const cats  = [...e.categories].join(' · ')  || '—';
      const critBadge = e.hasCritical   ? '<span class="cat-badge critical">⚠ CRÍTICO</span>' : '';
      const botBadge  = e.hasBottleneck ? '<span class="cat-badge bottleneck">⚡ GARGALO</span>' : '';
      html += `
        <div class="sp-card">
          <div class="sp-card-header">
            <span class="sp-badge">★ SP</span>
            <strong>${escHtml(e.serviceName)}</strong>
            ${critBadge}${botBadge}
          </div>
          <ul class="kv-list">
            <li><span class="k">Classe SP</span><span class="v">${escHtml(e.spClass)}</span></li>
            <li><span class="k">Método</span><span class="v">${escHtml(e.method)}</span></li>
            <li><span class="k">Classe origem</span><span class="v">${escHtml(apps)}</span></li>
            <li><span class="k">Categoria</span><span class="v">${escHtml(cats)}</span></li>
            <li><span class="k">Chamadas</span><span class="v">${e.callCount}</span></li>
            <li><span class="k">Tempo máx</span><span class="v">${fmtDuration(e.maxDuration)}</span></li>
            <li><span class="k">Tempo total</span><span class="v">${fmtDuration(e.totalDuration)}</span></li>
            ${e.waitMsCount > 0 ? `
            <li><span class="k">TTFB médio (servidor)</span><span class="v">${Math.round(e.waitMsTotal / e.waitMsCount)}ms</span></li>
            <li><span class="k">TTFB máx (servidor)</span><span class="v">${e.maxWaitMs}ms</span></li>` : ''}
          </ul>
        </div>`;
    }
    html += '</div>';
  }

  // ── Demais serviços em tabela ──────────────────────────────────────────
  if (otherServices.length) {
    html += `<h3 style="margin:24px 0 12px;color:var(--muted)">Demais serviços (${otherServices.length})</h3>`;
    html += `
      <table class="call-table">
        <thead>
          <tr>
            <th>serviceName</th>
            <th>Classe origem</th>
            <th>Categoria</th>
            <th>Chamadas</th>
            <th>Tempo máx</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>`;
    for (const e of otherServices) {
      const apps  = [...e.applications].join(', ') || '—';
      const cats  = [...e.categories].join(' · ')  || '—';
      const flags = [e.hasCritical ? '⚠' : '', e.hasBottleneck ? '⚡' : ''].filter(Boolean).join(' ') || '—';
      html += `
          <tr>
            <td>${escHtml(e.serviceName)}</td>
            <td>${escHtml(apps)}</td>
            <td>${escHtml(cats)}</td>
            <td>${e.callCount}</td>
            <td>${fmtDuration(e.maxDuration)}</td>
            <td>${escHtml(flags)}</td>
          </tr>`;
    }
    html += '</tbody></table>';
  }

  return html;
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

function renderCategoryChips(byCategory) {
  if (!byCategory || !Object.keys(byCategory).length) return '';
  const chips = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `<div class="cat-chip"><strong>${count}</strong> ${escHtml(cat)}</div>`)
    .join('');
  return `<div class="cat-grid">${chips}</div>`;
}

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------

function exportJson(session) {
  const json = JSON.stringify(session, null, 2);
  downloadText(json, `sankhya-monitor-${slugify(session.name)}.json`, 'application/json');
}

function exportTxt(session) {
  const txt = session.textReport || generateTextReport(session);
  downloadText(txt, `sankhya-monitor-${slugify(session.name)}.txt`, 'text/plain');
}

function downloadText(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function slugify(str) {
  return (str || 'sessao')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendMsg(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (response?.error) { reject(new Error(response.error)); return; }
      resolve(response);
    });
  });
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms === 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

function timeClass(ms) {
  if (ms >= 2000) return 'slow';
  if (ms >= 500)  return 'medium';
  return 'fast';
}

/** Extrai serviceName de um request (usado em renderFlowTimeline). */
function extractSN(req) {
  if (!req) return '—';
  return req.queryParams?.serviceName
      || req.parsedPayload?.businessFields?.serviceName
      || req.parsedPayload?.businessFields?.servicename
      || '—';
}

function statusLabel(s) {
  return { idle: 'Inativo', monitoring: 'Monitorando', finished: 'Finalizada' }[s] || s;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
