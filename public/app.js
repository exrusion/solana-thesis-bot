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

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toISOString().slice(11, 19) + 'Z';
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

async function refreshStatus() {
  try {
    const status = await fetchJson('/status');
    lastTickAt = status.lastTickAt;
    scanIntervalMs = status.scanIntervalMs || scanIntervalMs;

    const walletLink = el('walletLink');
    walletLink.textContent = shortAddr(status.wallet);
    walletLink.href = `https://solscan.io/account/${status.wallet}`;

    el('solBalance').textContent =
      status.solBalance !== undefined ? `${status.solBalance.toFixed(3)} SOL` : '—';

    const pnl = status.todaysRealizedPnlSol || 0;
    const pnlEl = el('todaysPnl');
    pnlEl.textContent = fmtSol(pnl);
    pnlEl.style.color = pnl > 0 ? 'var(--hold)' : pnl < 0 ? 'var(--fail)' : 'var(--fg)';

    el('openPositions').textContent = `${status.openPositions} / ${status.maxConcurrentPositions}`;

    const tripped = pnl <= -(status.maxDailyLossSol ?? Infinity);
    const killEl = el('killSwitch');
    killEl.textContent = tripped ? 'TRIPPED' : 'ARMED';
    killEl.style.color = tripped ? 'var(--fail)' : 'var(--hold)';

    el('ruleMaxPos').textContent = `${status.maxPositionSizeSol} SOL`;
    el('ruleStopLoss').textContent = `${status.stopLossPercent}%`;
    el('ruleDailyLoss').textContent = `${status.maxDailyLossSol} SOL`;

    const activity = status.scanActivity || {};
    el('scanTracked').textContent = activity.pendingMintsCount ?? '—';
    el('scanClosest').textContent = activity.closestPendingSymbol
      ? `$${Math.round(activity.closestPendingMarketCapUsd).toLocaleString()} (${activity.closestPendingSymbol})`
      : '—';
    el('scanCreates').textContent = activity.createsSeen ?? '—';
    el('scanTrades').textContent = activity.tradesSeen ?? '—';

    const minMc = status.minMarketCapUsd;
    const empty = el('journalEmpty');
    if (empty) {
      empty.innerHTML =
        activity.pendingMintsCount > 0
          ? `Tracking ${activity.pendingMintsCount} token${activity.pendingMintsCount === 1 ? '' : 's'} — none have crossed the $${minMc?.toLocaleString() ?? '10,000'} market cap floor yet. Closest: ${activity.closestPendingSymbol ? `$${Math.round(activity.closestPendingMarketCapUsd).toLocaleString()}` : 'warming up'}.`
          : 'No entries yet. The bot is watching.';
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
      li.innerHTML = `<span>$${escapeHtml(p.symbol)}</span><span>${p.entrySolAmount} SOL</span>`;
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
  }

  const statsRow = entry.stats
    ? `<div class="entry-stats">
        <span>liq ${fmtUsd(entry.stats.liquidityUsd)}</span>
        <span>1h vol ${fmtUsd(entry.stats.volume1h)}</span>
        <span>1h &#916; ${entry.stats.priceChange1h?.toFixed(1)}%</span>
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

async function refreshAll() {
  await Promise.all([refreshStatus(), refreshPositions(), refreshJournal(), refreshLogs()]);
}

buildPulseBars();
refreshAll();
setInterval(refreshAll, REFRESH_MS);
setInterval(tickCountdown, 1000);
