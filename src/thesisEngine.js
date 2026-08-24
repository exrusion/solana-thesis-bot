import axios from 'axios';
import { config } from './config.js';

const SYSTEM_PROMPT = `You are a disciplined Solana meme-coin trading analyst — think a
skeptical trading-desk veteran who's seen a thousand of these tokens and
isn't shy about saying so, not a robot reading off a checklist. You are
given structured on-chain and market stats for one token that has already
passed hard safety filters (mint/freeze authority revoked, holder
concentration checked, liquidity floor met). Your job is NOT to be bullish
by default — most candidates should fail. Only mark "hold" when the stats
show genuine structural strength: real volume, healthy trend, and room to
run without obvious overhead supply.

OPERATING CONTEXT — judge against this, not against some implicit
standard of a "real" token:
- This bot trades pump.fun micro-caps. A $5k-$80k market cap is the
  TARGET ZONE, not a disqualifier. Saying a token is too small for its
  market cap band is circular; that band is the strategy.
- Position size is 0.05 SOL, roughly $10. Judge liquidity against THAT.
  $2,000 of liquidity is ~200x the position — ample. Do not reject for
  thin liquidity unless the position would be a meaningful share of the
  pool, or an exit plainly could not be filled.
- Absolute dollar figures will always look small at this scale. "$770 of
  new money" is substantial inflow relative to a $10 entry. Assess flow
  as a proportion of the token's own size, not against institutional
  scale.
- Exits are automatic: 50% out at +40%, the rest at +100%, hard stop at
  -20%, and a forced exit after 20 minutes. You are judging a short
  momentum trade with a defined stop, not a long-term hold.
- A "hold" here means "worth $10 on these odds", not "worth
  underwriting". Reserve "fail" for genuine red flags: distribution into
  buyers, collapsing price, concentration, wash-trading signatures, or no
  demand at all.

Never argue that a token has few participants based on the SAMPLED buyer
count — that number is a small, throttled sample of a short observation
window, not a census. Reasoning like "only two people bought this" from a
sampled figure is factually wrong and has caused bad rejections. Judge
participation from market cap, liquidity, and real trade volume instead.

Write your reasoning in a human, dryly funny voice — a wry observation, a
sharp one-liner, mild sarcasm about an obvious red flag, whatever fits.
This is not corporate-speak. But every single claim must still be grounded
in the actual numbers you were given — never sacrifice accuracy for a
joke, and never make a joke that isn't backed by a real number in the
stats. The humor is delivery, not a substitute for analysis.

Respond with ONLY a JSON object, no other text, matching this shape:
{
  "decision": "hold" | "fail",
  "reasoning": ["short bullet", "short bullet", "..."],
  "entryCondition": "string describing what would confirm entry, or null if decision is hold and entering now",
  "invalidationCondition": "string describing what would invalidate this thesis"
}`;

export async function generateThesis(stats) {
  // For bonding-curve tokens we have no real trade history — volume1h is
  // just a copy of liquidity. Showing it as "volume" would invite the
  // model to reason about a number that doesn't mean what it says.
  const isBondingCurve = stats.dexId === 'pumpfun';

  const volumeLines = isBondingCurve
    ? `Trade volume: not available (still on bonding curve — no trade history yet)
Real SOL committed to curve: $${stats.liquidityUsd.toFixed(0)}
Growth in committed SOL since our previous reading: ${
        stats.priceChange1h === null || stats.priceChange1h === undefined
          ? 'not yet measurable'
          : stats.priceChange1h.toFixed(1) + '%'
      }`
    : `1h volume: $${stats.volume1h.toFixed(0)}
6h volume: $${stats.volume6h.toFixed(0)}
24h volume: $${stats.volume24h.toFixed(0)}
1h price change: ${stats.priceChange1h.toFixed(1)}%
6h price change: ${stats.priceChange6h.toFixed(1)}%
24h price change: ${stats.priceChange24h.toFixed(1)}%`;

  const userPrompt = `Token: $${stats.symbol}
Stage: ${isBondingCurve ? 'still on pump.fun bonding curve (pre-graduation)' : 'graduated to AMM'}
${stats.observedOnly
    ? `Observed by this bot for: ${stats.ageHours !== null && stats.ageHours !== undefined ? (stats.ageHours * 60).toFixed(0) + ' minutes' : 'unknown'} (this is how long WE have been watching it, NOT the token's age — it may be far older, and a short window here says nothing bad about the token)`
    : `Age: ${stats.ageHours?.toFixed(1) ?? 'unknown'}h`}
Market cap: $${stats.marketCapUsd?.toFixed(0) ?? 'unknown'}
Liquidity: $${stats.liquidityUsd.toFixed(0)}
${volumeLines}
Top holder: ${stats.topHolderPercent !== undefined ? stats.topHolderPercent.toFixed(1) + '% of total supply (pools excluded)' : 'unknown'}
Top 10 holders: ${stats.top10Percent !== undefined ? stats.top10Percent.toFixed(1) + '% of total supply (pools excluded)' : 'unknown'}
Distinct real holders seen: ${stats.realHolderCount ?? 'unknown'}
Unsold supply still in the bonding curve: ${stats.poolPercent !== undefined ? stats.poolPercent.toFixed(1) + '%' : 'unknown'} (this is the curve mechanism holding tokens nobody has bought yet — it is NOT a whale and will never dump; a high number just means the token is early)
Real transactions on this token in the last 15 minutes: ${stats.recentTrades ?? 'unknown'} (measured directly against the token's own bonding curve account — this figure is accurate)
Unique buyers SAMPLED: ${stats.uniqueBuyers ?? 'none yet'} — CRITICAL: this is NOT the token's buyer count. We resolve only ~1 in 8 trade events, and only during the ~10 minutes we have been watching. The true figure is many times larger and unknown. Treat this as a rough floor, never as evidence that "only N people bought this". If real trade volume is present below, that is the far better signal of participation.
Buy/sell volume ratio (from the same sample): ${stats.buySellRatio !== undefined ? (stats.buySellRatio === Infinity ? 'all buys, no sells' : stats.buySellRatio.toFixed(2) + 'x') : 'unknown'}
RugCheck risk score: ${stats.rugcheckScore ?? 'unknown'} (0-100, lower is safer)
Our own trained model's survival estimate: ${
        stats.mlSurvivalProbability === null || stats.mlSurvivalProbability === undefined
          ? 'not available (model still gathering labelled outcomes)'
          : (stats.mlSurvivalProbability * 100).toFixed(0) +
            '% — a logistic regression trained on this bot\'s own past evaluations and what actually happened to them. Weigh it as one input, not a verdict.'
      }`;

  const res = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      model: config.openRouterModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
    },
    {
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  const raw = res.data?.choices?.[0]?.message?.content ?? '';

  try {
    // Model sometimes wraps JSON in a code fence despite instructions — strip it.
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    return {
      decision: 'fail',
      reasoning: [`thesis engine returned unparseable output: ${raw.slice(0, 200)}`],
      entryCondition: null,
      invalidationCondition: null,
    };
  }
}
