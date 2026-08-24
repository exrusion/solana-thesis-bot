const REFRESH_MS = 8000;

const el = (id) => document.getElementById(id);

function shortAddr(addr) {
  if (!addr) return '—';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function fmtSol(n) {
  if (n === undefined || n === null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(3)} SOL`;
}

function fmtUsd(n) {
  if (n === undefined || n === null) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtUsdSigned(n) {
  if (n === undefined || n === null) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(11, 19) + 'Z';
}

function fmtDuration(startIso) {
  if (!startIso) return '—';
  const mins = Math.floor((Date.now() - new Date(startIso).getTime()) / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 0)}m`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

let lastTickAt = null;
let scanIntervalMs = 60000;
let latestJournalEntry = null;
let livePositionMap = {};

async function refreshStatus() {
  try {
    const status = await fetchJson('/status');
    lastTickAt = status.lastTickAt;
    scanIntervalMs = status.scanIntervalMs || scanIntervalMs;

    const walletLink = el('walletLink');
    walletLink.textContent = shortAddr(status.wallet);
    walletLink.href = `https://solscan.io/account/${status.wallet}`;

    el('openPositionsCount').textContent = `${status.openPositions} / ${status.maxConcurrentPositions}`;

    const todaysPnl = status.todaysRealizedPnlSol || 0;
    const tripped = todaysPnl <= -(status.maxDailyLossSol ?? Infinity);
    const killEl = el('killSwitch');
    killEl.textContent = tripped ? 'TRIPPED' : 'ARMED';
    killEl.style.color = tripped ? 'var(--fail)' : 'var(--hold)';

    // Stats bar
    el('statModel').textContent = status.model || '—';
    el('statUptime').textContent = fmtDuration(status.startedAt);
    el('statFloor').textContent = fmtUsd(status.minMarketCapUsd);
    el('statTicks').textContent = status.tickCount ?? '—';
    el('statEquity').textContent = fmtUsd(status.totalEquityUsd);
    el('statSpent').textContent =
      status.totalSpentSol !== undefined ? `${status.totalSpentSol.toFixed(3)} SOL` : '—';

    const realizedEl = el('statRealized');
    const realized = status.allTimeRealizedPnlSol || 0;
    realizedEl.textContent = fmtSol(realized);
    realizedEl.style.color = realized > 0 ? 'var(--hold)' : realized < 0 ? 'var(--fail)' : 'var(--fg)';

    const unrealizedEl = el('statUnrealized');
    const unrealized = status.unrealizedPnlUsd || 0;
    unrealizedEl.textContent = fmtUsdSigned(unrealized);
    unrealizedEl.style.color = unrealized > 0 ? 'var(--hold)' : unrealized < 0 ? 'var(--fail)' : 'var(--fg)';

    // The Curve panel
    livePositionMap = {};
    for (const lp of status.livePositions || []) livePositionMap[lp.mintAddress] = lp;

    const activity = status.scanActivity || {};
    const minMc = status.minMarketCapUsd || 10000;

    el('curveTopSymbol').textContent = activity.closestPendingSymbol || 'watching';
    el('curveStatus').textContent = activity.pendingMintsCount > 0 ? 'tracking' : 'idle';
    el('curveCaption').textContent =
      activity.pendingMintsCount > 0
        ? `${activity.pendingMintsCount} token${activity.pendingMintsCount === 1 ? '' : 's'} being watched right now`
        : 'no candidates tracked yet';

    const pct = Math.min(100, ((activity.closestPendingMarketCapUsd || 0) / minMc) * 100);
    el('curveBarPct').textContent = `${fmtUsd(activity.closestPendingMarketCapUsd)} / ${fmtUsd(minMc)}`;
    const CELLS = 20;
    const filled = Math.round((pct / 100) * CELLS);
    el('curveBarAscii').textContent =
      '[' + '▓'.repeat(filled) + '░'.repeat(CELLS - filled) + '] ' + pct.toFixed(0) + '%';

    const curveList = el('curveList');
    const top = activity.topPending || [];
    curveList.innerHTML = top.length
      ? top.map((t) => `<li><span>${escapeHtml(t.symbol)}</span><span>${fmtUsd(t.marketCapUsd)}</span></li>`).join('')
      : '<li class="empty-note">nothing above the floor yet</li>';

    const lastFiled = el('curveLastFiled');
    if (latestJournalEntry) {
      const snippet =
        latestJournalEntry.type === 'thesis'
          ? latestJournalEntry.thesis?.reasoning?.[0]
          : (latestJournalEntry.reasons || [])[0];
      lastFiled.textContent = `> $${latestJournalEntry.symbol} — ${snippet || '—'}`;
    } else {
      lastFiled.textContent = '> nothing filed yet';
    }

    const nowText = el('nowText');
    if (latestJournalEntry) {
      const snippet =
        latestJournalEntry.type === 'thesis'
          ? latestJournalEntry.thesis?.reasoning?.[0]
          : (latestJournalEntry.reasons || [])[0];
      nowText.textContent = '> ' + (snippet || 'the bot is watching.');
    }
  } catch (err) {
    console.error('status refresh failed', err);
  }
}

async function refreshPositions() {
  try {
    const positions = await fetchJson('/positions');
    const open = positions.filter((p) => p.status === 'open');
    const list = el('positionsList');
    list.innerHTML = '';
    if (!open.length) {
      list.innerHTML = '<li class="empty-note">none open</li>';
      return;
    }
    for (const p of open) {
      const li = document.createElement('li');
      const entryTx = p.entrySignature
        ? `<a class="verify-link" href="https://solscan.io/tx/${p.entrySignature}" target="_blank" rel="noopener">tx&nearr;</a>`
        : '';
      const tokenLink = p.mintAddress
        ? `<a class="verify-link" href="https://pump.fun/coin/${p.mintAddress}" target="_blank" rel="noopener">chart&nearr;</a>`
        : '';

      const live = livePositionMap[p.mintAddress];
      let pnlHtml = `<span>${p.entrySolAmount} SOL</span>`;
      if (live && live.pnlPercent !== undefined) {
        const up = live.pnlPercent >= 0;
        pnlHtml = `<span style="color:${up ? 'var(--hold)' : 'var(--fail)'}">${up ? '+' : ''}${live.pnlPercent.toFixed(1)}%</span>`;
      }

      const sub = live
        ? `<div style="font-size:0.66rem;color:var(--muted);margin-top:3px">${p.entrySolAmount} SOL in &middot; now ${fmtUsd(live.currentValueUsd)} &middot; held ${live.minutesHeld.toFixed(0)}m${live.tookFirstProfit ? ' &middot; half out' : ''}</div>`
        : '';

      li.style.display = 'block';
      li.innerHTML = `<div style="display:flex;justify-content:space-between"><span>$${escapeHtml(p.symbol)}${entryTx}${tokenLink}</span>${pnlHtml}</div>${sub}`;
      list.appendChild(li);
    }
  } catch (err) {
    console.error('positions refresh failed', err);
  }
}

function renderEntry(entry) {
  const li = document.createElement('li');
  li.className = 'entry';

  const idStr = String(entry.id ?? 0).padStart(4, '0');
  let badgeClass = 'badge-skip';
  let badgeText = 'SKIPPED';

  if (entry.type === 'thesis') {
    const held = entry.thesis?.decision === 'hold';
    badgeClass = held ? 'badge-hold' : 'badge-fail';
    badgeText = held ? 'HOLD' : 'FAIL';
  } else if (entry.type === 'exit') {
    badgeClass = 'badge-fail';
    badgeText = 'EXITED';
  }

  const statsRow = entry.stats
    ? `<div class="entry-stats">
        <span>mcap ${fmtUsd(entry.stats.marketCapUsd)}</span>
        <span>liq ${fmtUsd(entry.stats.liquidityUsd)}</span>
        <span>growth ${entry.stats.priceChange1h === null || entry.stats.priceChange1h === undefined ? 'n/a' : entry.stats.priceChange1h.toFixed(1) + '%'}</span>
      </div>`
    : '';

  let body;
  if (entry.type === 'thesis') {
    const bullets = (entry.thesis?.reasoning || [])
      .map((r) => `<li>${escapeHtml(r)}</li>`)
      .join('');
    body = `<ul class="entry-reasoning">${bullets}</ul>`;
    if (entry.thesis?.invalidationCondition) {
      body += `<div class="entry-condition"><b>invalidation:</b> ${escapeHtml(entry.thesis.invalidationCondition)}</div>`;
    }
  } else {
    body = `<div class="entry-condition">${escapeHtml((entry.reasons || []).join('; '))}</div>`;
  }

  const link = entry.url
    ? `<a class="entry-link" href="${entry.url}" target="_blank" rel="noopener">view pair &rarr;</a>`
    : '';

  li.innerHTML = `
    <div class="entry-head">
      <span class="entry-id">No. ${idStr}</span>
      <span class="entry-time">${fmtTime(entry.timestamp)}</span>
      <span class="entry-symbol">$${escapeHtml(entry.symbol || '?')}</span>
      <span class="badge ${badgeClass}">${badgeText}</span>
    </div>
    ${statsRow}
    ${body}
    ${link}
  `;
  return li;
}

async function refreshJournal() {
  try {
    const log = await fetchJson('/thesis-log?limit=50');
    latestJournalEntry = log[0] || null;

    const list = el('journalList');
    const empty = el('journalEmpty');
    list.innerHTML = '';
    if (!log.length) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    for (const entry of log) {
      list.appendChild(renderEntry(entry));
    }
  } catch (err) {
    console.error('journal refresh failed', err);
  }
}

function tickCountdown() {
  const label = el('pulseLabel');
  if (!lastTickAt) {
    label.textContent = 'next scan —';
    return;
  }
  const next = new Date(lastTickAt).getTime() + scanIntervalMs;
  const remaining = Math.max(0, Math.round((next - Date.now()) / 1000));
  label.textContent = `next scan in ${remaining}s`;
}

function buildPulseBars() {
  const container = el('pulseLine');
  container.innerHTML = '';
  for (let i = 0; i < 16; i++) {
    const bar = document.createElement('span');
    bar.style.animationDelay = `${(i * 0.09).toFixed(2)}s`;
    container.appendChild(bar);
  }
}

async function refreshLogs() {
  try {
    const logs = await fetchJson('/logs?limit=150');
    const box = el('logsBox');
    box.innerHTML = logs
      .map((l) => {
        const cls = l.level === 'error' ? 'log-line log-line-error' : 'log-line';
        return `<div class="${cls}"><span class="log-time">${fmtTime(l.timestamp)}</span><span>${escapeHtml(l.line)}</span></div>`;
      })
      .join('');
  } catch (err) {
    console.error('logs refresh failed', err);
  }
}

async function refreshHistory() {
  try {
    const positions = await fetchJson('/positions');
    const closed = positions.filter((p) => p.status === 'closed');
    const body = el('historyBody');

    if (!closed.length) {
      body.innerHTML = '<div class="empty-note">&gt; no closed trades yet ... _</div>';
      return;
    }

    closed.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));

    body.innerHTML = closed
      .map((p) => {
        const pnl = p.realizedPnlSol ?? 0;
        const cls = pnl > 0 ? 'pnl-up' : pnl < 0 ? 'pnl-down' : '';
        const pct =
          p.entryPriceUsd && p.exitPriceUsd
            ? ((p.exitPriceUsd - p.entryPriceUsd) / p.entryPriceUsd) * 100
            : null;

        const links = [];
        if (p.entrySignature) {
          links.push(`<a href="https://solscan.io/tx/${p.entrySignature}" target="_blank" rel="noopener">buy tx &nearr;</a>`);
        }
        if (p.exitSignature) {
          links.push(`<a href="https://solscan.io/tx/${p.exitSignature}" target="_blank" rel="noopener">sell tx &nearr;</a>`);
        }
        if (p.mintAddress) {
          links.push(`<a href="https://pump.fun/coin/${p.mintAddress}" target="_blank" rel="noopener">chart &nearr;</a>`);
        }

        return `
          <div class="trade-row">
            <div class="trade-head">
              <span class="trade-symbol">$${escapeHtml(p.symbol || '?')}</span>
              <span class="entry-time">${fmtTime(p.openedAt)} &rarr; ${fmtTime(p.closedAt)}</span>
              <span class="trade-pnl ${cls}">${fmtSol(pnl)}${pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : ''}</span>
            </div>
            <div class="trade-links">${links.join('')}</div>
          </div>`;
      })
      .join('');
  } catch (err) {
    console.error('history refresh failed', err);
  }
}

async function refreshModel() {
  try {
    const m = await fetchJson('/model');
    const body = el('modelBody');

    if (!m.trained) {
      body.innerHTML = `<div class="empty-note">&gt; ${m.sampleCount} of ${m.minSamples} labelled outcomes gathered &mdash; not predicting yet ... _</div>`;
      return;
    }

    const bars = (m.weights || [])
      .slice(0, 6)
      .map((w) => {
        const mag = Math.min(100, Math.abs(w.weight) * 40);
        const up = w.weight >= 0;
        return `<div class="rule-row">
            <span>${escapeHtml(w.name.replace(/_/g, ' '))}</span>
            <span style="display:flex;align-items:center;gap:8px">
              <span style="display:inline-block;width:${mag}px;height:6px;border-radius:3px;background:${up ? 'var(--hold)' : 'var(--fail)'}"></span>
              <span style="color:${up ? 'var(--hold)' : 'var(--fail)'}">${up ? '+' : ''}${w.weight.toFixed(2)}</span>
            </span>
          </div>`;
      })
      .join('');

    body.innerHTML = `
      <div class="rule-row"><span>trained on</span><span>${m.sampleCount} labelled outcomes</span></div>
      <div class="rule-row"><span>training accuracy</span><span>${(m.trainAccuracy * 100).toFixed(1)}%</span></div>
      <div class="rule-row"><span>survival base rate</span><span>${(m.positiveRate * 100).toFixed(0)}%</span></div>
      <div class="rule-row"><span>last retrained</span><span>${fmtTime(m.trainedAt)}</span></div>
      <div class="insights-row-label" style="margin-top:14px">what it weighs most (green = survival, red = death)</div>
      ${bars}
    `;
  } catch (err) {
    console.error('model refresh failed', err);
  }
}

async function refreshInsights() {
  try {
    const data = await fetchJson('/insights');
    const body = el('insightsBody');
    if (!data.total) {
      body.innerHTML = '<div class="empty-note">not enough data collected yet</div>';
      return;
    }

    const decisionChips = Object.entries(data.byDecision)
      .filter(([, count]) => count > 0)
      .map(([decision, count]) => `<span class="insights-chip">${decision}: ${count}</span>`)
      .join('');

    const outcomeChips = Object.entries(data.checkpointStatus)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `<span class="insights-chip">${status}: ${count}</span>`)
      .join('');

    const reasonChips = (data.topReasons || [])
      .map((r) => `<span class="insights-chip">${escapeHtml(r.reason)}: ${r.count}</span>`)
      .join('');

    body.innerHTML = `
      <div>
        <div class="insights-row-label">evaluated so far (${data.total} total)</div>
        <div class="insights-chips">${decisionChips}</div>
      </div>
      <div>
        <div class="insights-row-label">1h follow-up outcomes</div>
        <div class="insights-chips">${outcomeChips || '<span class="empty-note">none due yet</span>'}</div>
      </div>
      <div>
        <div class="insights-row-label">most common rejection reasons</div>
        <div class="insights-chips">${reasonChips || '<span class="empty-note">none yet</span>'}</div>
      </div>
    `;
  } catch (err) {
    console.error('insights refresh failed', err);
  }
}

async function refreshLearning() {
  try {
    const d = await fetchJson('/learning');
    const body = el('learningBody');

    const nextIn =
      d.nextCheckpointInSeconds === null || d.nextCheckpointInSeconds === undefined
        ? null
        : d.nextCheckpointInSeconds > 60
          ? `${Math.round(d.nextCheckpointInSeconds / 60)}m`
          : `${d.nextCheckpointInSeconds}s`;

    const progress = `<div class="rule-row" style="margin-bottom:12px">
        <span>${d.totalRecords} evaluated &middot; ${d.resolvedRecords} with outcomes &middot; ${d.awaitingCheckpoint || 0} awaiting</span>
        <span>${nextIn ? `next result in ${nextIn}` : 'checking…'}</span>
      </div>`;

    if (!d.resolvedRecords) {
      body.innerHTML =
        progress +
        `<div class="empty-note">&gt; first outcomes land 5 minutes after each evaluation ... _</div>`;
      return;
    }

    const calib = (d.filterCalibration || [])
      .map(
        (c) =>
          `<div class="rule-row"><span>${escapeHtml(c.reason)} <span style="color:var(--muted)">(n=${c.total})</span></span><span>${c.diedPercent.toFixed(0)}% died &middot; ${c.survivedPercent.toFixed(0)}% survived</span></div>`
      )
      .join('');

    const thesis = Object.entries(d.thesisCalibration || {})
      .map(([decision, o]) => {
        const survived = (((o.alive || 0) + (o.graduated || 0)) / o.total) * 100;
        return `<div class="rule-row"><span>AI said &ldquo;${decision}&rdquo; <span style="color:var(--muted)">(n=${o.total})</span></span><span>${survived.toFixed(0)}% still alive at 1h</span></div>`;
      })
      .join('');

    const flags = (d.topRugcheckFlags || [])
      .map((f) => `<span class="insights-chip">${escapeHtml(f.flag)}: ${f.count}</span>`)
      .join('');

    body.innerHTML = progress + `
      <div>
        <div class="insights-row-label">is each filter earning its place? (${d.resolvedRecords} resolved${d.resolvedRecords < 20 ? ' — low confidence, small sample' : ''})</div>
        ${calib || '<div class="empty-note">not enough samples per reason yet</div>'}
      </div>
      <div>
        <div class="insights-row-label">how the AI's own verdicts held up</div>
        ${thesis || '<div class="empty-note">no AI verdicts resolved yet</div>'}
      </div>
      <div>
        <div class="insights-row-label">rugcheck ML signals fired most</div>
        <div class="insights-chips">${flags || '<span class="empty-note">none yet</span>'}</div>
      </div>
    `;
  } catch (err) {
    console.error('learning refresh failed', err);
  }
}

async function refreshAll() {
  await refreshJournal(); // populate latestJournalEntry before status renders "now"/"last filed"
  await Promise.all([refreshStatus(), refreshPositions(), refreshLogs(), refreshInsights(), refreshLearning(), refreshHistory(), refreshModel()]);
}

function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panes = document.querySelectorAll('.pane');
  const sidebar = document.querySelector('.curve-col');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      panes.forEach((p) => {
        p.hidden = p.dataset.pane !== target;
      });
      // the curve/wallet column describes live state, so it only belongs
      // on the live tab — everywhere else it just steals width
      if (sidebar) sidebar.classList.toggle('dimmed', target !== 'live');
    });
  });
}

async function initAsk() {
  const select = el('askModel');
  const input = el('askInput');
  const send = el('askSend');
  const thread = el('askThread');

  try {
    const { models, default: def } = await fetchJson('/ask/models');
    select.innerHTML = Object.entries(models)
      .map(([id, label]) => `<option value="${id}"${id === def ? ' selected' : ''}>${escapeHtml(label)}</option>`)
      .join('');
  } catch (err) {
    select.innerHTML = '<option>default model</option>';
  }

  function append(cls, text) {
    const div = document.createElement('div');
    div.className = `ask-msg ${cls}`;
    div.textContent = text;
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
    return div;
  }

  async function ask() {
    const question = input.value.trim();
    if (!question) return;

    append('ask-q', '> ' + question);
    input.value = '';
    send.disabled = true;
    const pending = append('ask-a', 'thinking ...');

    try {
      const res = await fetch('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, model: select.value }),
      });
      const data = await res.json();
      if (data.error) {
        pending.className = 'ask-msg ask-err';
        pending.textContent = data.error;
      } else {
        // render **bold**, and turn bare URLs into links
        const safe = escapeHtml(data.answer)
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--pulse)">$1</a>');
        pending.innerHTML = safe;
      }
    } catch (err) {
      pending.className = 'ask-msg ask-err';
      pending.textContent = 'Request failed — try again.';
    } finally {
      send.disabled = false;
      input.focus();
    }
  }

  send.addEventListener('click', ask);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ask();
  });
}

initAsk();
initTabs();
buildPulseBars();
refreshAll();
setInterval(refreshAll, REFRESH_MS);
setInterval(tickCountdown, 1000);
