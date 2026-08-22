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
  const userPrompt = `Token: $${stats.symbol}
Age: ${stats.ageHours?.toFixed(1) ?? 'unknown'}h
Market cap: $${stats.marketCapUsd?.toFixed(0) ?? 'unknown'}
Liquidity: $${stats.liquidityUsd.toFixed(0)}
1h volume: $${stats.volume1h.toFixed(0)}
6h volume: $${stats.volume6h.toFixed(0)}
24h volume: $${stats.volume24h.toFixed(0)}
1h price change: ${stats.priceChange1h.toFixed(1)}%
6h price change: ${stats.priceChange6h.toFixed(1)}%
24h price change: ${stats.priceChange24h.toFixed(1)}%
Top holder concentration: ${stats.topHolderPercent?.toFixed(1) ?? 'unknown'}%`;

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
