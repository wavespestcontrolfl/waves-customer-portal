// @vitest-environment node
// The dedupe must work on what the REAL server builders produce, not on strings written to fit the rule.
// This builds the localized-dry finding with buildLawnInsightCards (its actual customerAction: the
// sprinkler-coverage step plus the aftercare hold task) and the banner with the real watering instruction.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { insightsWithoutRepeats, bannerRepeatsAftercare } from './lawnLayoutRules';

const require = createRequire(import.meta.url);
process.env.GATE_LAWN_REPORT_LEAD = 'true';
const { buildLawnInsightCards } = require('../../../../../server/services/service-report/lawn-report-insights');
const { buildWateringInstruction, composeBannerLines } = require('../../../../../server/services/service-report/lawn-watering-instruction');
const { buildAftercare } = require('../../../../../server/services/service-report/lawn-report-v2');

const COMPLETED = '2026-10-09T14:56:39.602Z';
const product = { name: 'Headway G', product: { name: 'Headway G' } };

function localizedDryCard(rules) {
  const instruction = buildWateringInstruction({ rules, completedAt: COMPLETED, runtime: null });
  const banner = { state: instruction.state, lines: composeBannerLines(instruction), expiresAt: instruction.expiresAt };
  const aftercare = buildAftercare([product], { instruction });
  const cards = buildLawnInsightCards({
    categories: [{ key: 'water_balance', status: 'watch', score: 55, customerExplanation: 'x' }],
    water: { localizedDry: true, localizedDryConfidence: 'ai_supported', status: 'balanced', scheduleOnFile: true },
    aftercare,
  });
  return { card: cards.find((c) => c.category === 'water'), banner, aftercare };
}

describe('the real localized-dry finding with a watering hold', () => {
  const { card, banner, aftercare } = localizedDryCard([{ name: 'Headway G', rule: { mode: 'hold', hold_until: 'dry', source: 'label' } }]);

  it('the builder really joins the sprinkler-coverage step and the hold task in one action', () => {
    expect(card).toBeTruthy();
    expect(card.customerAction).toContain('Check sprinkler coverage in that area rather than watering the whole yard more.');
    expect(card.customerAction).toContain(banner.lines[0]);
  });

  it('the dedupe keeps the sprinkler-coverage step and drops only the hold sentences the banner prints', () => {
    const [out] = insightsWithoutRepeats([card], { banner, aftercare, nowMs: Date.parse(COMPLETED) });
    expect(out.customerAction).toBe('Check sprinkler coverage in that area rather than watering the whole yard more.');
    expect(out.headline).toBe(card.headline);
  });

  it('the water card\'s copy of the instruction is a repeat of the banner (so it may be hidden)', () => {
    expect(bannerRepeatsAftercare(banner, aftercare, Date.parse(COMPLETED))).toBe(true);
  });
});

describe('the real localized-dry finding with a water-in', () => {
  it('keeps the sprinkler-coverage step beside a water-in restatement', () => {
    const { card, banner, aftercare } = localizedDryCard([{ name: 'Headway G', rule: { mode: 'water_in', water_in_inches: 0.5, water_in_hours: 24, source: 'label' } }]);
    const [out] = insightsWithoutRepeats([card], { banner, aftercare, nowMs: Date.parse(COMPLETED) });
    expect(out.customerAction).toContain('Check sprinkler coverage in that area rather than watering the whole yard more.');
    banner.lines.forEach((line) => expect(out.customerAction || '').not.toContain(line));
  });
});
