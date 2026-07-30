/**
 * HUMAN PROSE RULES — owner-authored anti-AI-tell style block (Adam,
 * 2026-07-30) for LONG-FORM customer-facing prose: blog drafts, content
 * refreshes, service-report narratives, and social/GBP post copy.
 *
 * STYLE ONLY, by contract: this block never overrides a lane's safety,
 * compliance, grounding, or banned-copy rules — those always win. It exists
 * because paragraph-scale AI prose has recognizable structural tics
 * (antithesis, rule of three, summary beats) that ban-lists at the SENTENCE
 * scale (the SMS voice) don't need; keep the SMS voice's own two-line
 * version in CUSTOMER_SMS_HOUSE_VOICE, don't inject this there.
 *
 * Deliberately NOT injected (do not "complete" the rollout without an owner
 * call): the newsletter share captions in content-scheduler (that lane is
 * tuned hype-on-purpose — "light FOMO is good" — and just closed a 9-round
 * review cycle) and the meta rewriter (≤160-char metas, contract in flight
 * on PR #3063).
 */

const HUMAN_PROSE_RULES = `HUMAN PROSE RULES (style only — these never override safety, compliance, grounding, or banned-copy rules):
- No antithesis. No corrective negation. No contrasting pairs ("it's not X, it's Y").
- No paragraph pinning. No parataxis. No summary beats. No landing sentences. No setup/payoff constructions — stop when the information stops.
- No rhetorical crutches. No negative parallelisms. No negative anaphoras. No rule of three.
- No parallel sentence structures within a paragraph. Vary sentence length unpredictably.
- No em dashes. No throat-clearing openers ("In today's world…", "When it comes to…").
- No stacked noun phrases. No nominalization — use the verb.
- No filler intensifiers (genuinely, really, truly, actually). No hedging qualifiers.
- No corporate-register verbs (leverage, underscore, reflect, utilize).
- Write for the spoken voice. No performed enthusiasm.`;

module.exports = { HUMAN_PROSE_RULES };
