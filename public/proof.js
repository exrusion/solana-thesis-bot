const el = (id) => document.getElementById(id);

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + 'z';
}

async function loadProof() {
  try {
    const d = await (await fetch('/proof.json?limit=40')).json();

    el('proofStats').innerHTML = [
      ['sealed on chain', d.totalSealed],
      ['revealed', d.revealed],
      ['bound to a fill', d.boundToFill],
      ['act vs pass', `${d.actDecisions} / ${d.passDecisions}`],
    ]
      .map(
        ([label, value]) =>
          `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${esc(String(value))}</div></div>`
      )
      .join('');

    if (!d.memoKeyConfigured) {
      el('commitList').innerHTML =
        '<div class="insights-card"><div class="empty-note">&gt; no memo key configured &mdash; sealing is off, so nothing here can be proven ... _</div></div>';
      return;
    }

    if (!d.commitments.length) {
      el('commitList').innerHTML =
        '<div class="insights-card"><div class="empty-note">&gt; nothing sealed yet ... _</div></div>';
      return;
    }

    el('commitList').innerHTML = d.commitments
      .map((c) => {
        const badge =
          c.verdict === 'act'
            ? '<span class="badge badge-hold">ACT</span>'
            : '<span class="badge badge-skip">PASS</span>';
        const state = c.revealed
          ? '<span class="badge badge-hold">REVEALED</span>'
          : '<span class="badge badge-skip">SEALED</span>';

        const preimage = c.revealed
          ? `<div style="margin-top:10px">
               <div class="insights-row-label">preimage (sha256 this)</div>
               <div style="font-family:var(--font-utility);font-size:0.68rem;color:var(--fg);white-space:pre-wrap;word-break:break-all;background:var(--ink);padding:10px;border-radius:4px;max-height:150px;overflow:auto">${esc(c.preimage)}</div>
             </div>`
          : `<div class="empty-note" style="margin-top:10px">&gt; plaintext opens ${fmtTime(c.revealAt)} &mdash; the hash is already on chain ... _</div>`;

        const links = [
          `<a href="${c.memoUrl}" target="_blank" rel="noopener">memo on chain &nearr;</a>`,
          c.fillUrl ? `<a href="${c.fillUrl}" target="_blank" rel="noopener">fill &nearr;</a>` : '',
          `<a href="https://pump.fun/coin/${c.mint}" target="_blank" rel="noopener">chart &nearr;</a>`,
        ]
          .filter(Boolean)
          .join('');

        return `<div class="entry" style="margin-bottom:14px">
            <div class="entry-head">
              <span class="entry-symbol">$${esc(c.symbol)}</span>
              ${badge} ${state}
              <span class="entry-time">${fmtTime(c.decidedAt)}</span>
            </div>
            <div class="insights-row-label">sha256 written into the memo</div>
            <div style="font-family:var(--font-utility);font-size:0.72rem;color:var(--pulse);word-break:break-all">${esc(c.hash)}</div>
            <div class="entry-condition" style="margin-top:8px">sealed ${c.sealedAfterMs}ms after deciding${
              c.fillSignature ? ' · a fill was bound to this commitment' : ' · no fill attached'
            }</div>
            ${preimage}
            <div class="trade-links" style="margin-top:10px">${links}</div>
          </div>`;
      })
      .join('');
  } catch (err) {
    el('commitList').innerHTML =
      '<div class="insights-card"><div class="empty-note">&gt; could not load proof data ... _</div></div>';
  }
}

// SHA-256 entirely in the browser — nothing is sent to the server.
el('verifyBtn').addEventListener('click', async () => {
  const text = el('verifyInput').value;
  if (!text.trim()) return;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  el('verifyOut').innerHTML = `<span style="color:var(--muted)">sha256 &rarr;</span> <span style="color:var(--hold)">${hex}</span>`;
});

loadProof();
setInterval(loadProof, 15000);
