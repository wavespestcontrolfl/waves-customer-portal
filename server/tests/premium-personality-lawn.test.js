/**
 * AI-summary personality variants — lawn honesty fixes (owner audit 2026-07-30).
 *
 * Pins three behaviors of buildAiSummaryPersonalityContext:
 *  1. Duplicate application methods collapse ("broadcast spray and broadcast
 *     spray" read on a live lawn report when two products shared the method).
 *  2. The finding line always ends with terminal punctuation (the simple
 *     variant concatenated "…crabgrass We completed…").
 *  3. "Lower pressure is better." is pest-pressure framing and never renders
 *     on lawn reports, which have no pressure gauge.
 */

const { buildAiSummaryPersonalityContext } = require('../services/service-report/premium-experience');

const FINDING = {
  id: 'f1',
  title: 'Gray leaf spot fungus, minor broadleaf weeds and crabgrass',
  detail: '',
  recommendation: '',
};

const APPS = [
  { id: 'a1', productName: 'LESCO K-Flow', method: 'broadcast_spray', methodLabel: 'Broadcast spray', targets: [] },
  { id: 'a2', productName: 'Talstar P', method: 'broadcast_spray', methodLabel: 'Broadcast spray', targets: [] },
  { id: 'a3', productName: 'Celsius WG', method: 'spot_treatment', methodLabel: 'Spot treatment', targets: [] },
];

describe('buildAiSummaryPersonalityContext — lawn honesty', () => {
  test('dedupes repeated application methods in the treated line', () => {
    const ctx = buildAiSummaryPersonalityContext({
      findings: [FINDING], applications: APPS, serviceLine: 'lawn', now: new Date('2026-07-30T20:00:00Z'),
    });
    const body = ctx.variants.simple.body;
    expect(body).toContain('broadcast spray and spot treatment');
    expect(body).not.toMatch(/broadcast spray and broadcast spray/);
  });

  test('finding line gets terminal punctuation before the treated line', () => {
    const ctx = buildAiSummaryPersonalityContext({
      findings: [FINDING], applications: APPS, serviceLine: 'lawn', now: new Date('2026-07-30T20:00:00Z'),
    });
    expect(ctx.variants.simple.body).toContain('crabgrass. We completed');
  });

  test('lawn simple variant never shows the pest-pressure bullet', () => {
    const ctx = buildAiSummaryPersonalityContext({
      findings: [FINDING], applications: APPS, serviceLine: 'lawn', now: new Date('2026-07-30T20:00:00Z'),
    });
    const bulletTexts = ctx.variants.simple.bullets.map((b) => b.text);
    expect(bulletTexts).not.toContain('Lower pressure is better.');
  });

  test('pest reports keep the pressure bullet and pest default finding line', () => {
    const ctx = buildAiSummaryPersonalityContext({
      findings: [], applications: [], serviceLine: 'pest', now: new Date('2026-07-30T20:00:00Z'),
    });
    const bulletTexts = ctx.variants.simple.bullets.map((b) => b.text);
    expect(bulletTexts).toContain('Lower pressure is better.');
    expect(ctx.variants.simple.body).toContain('No material pest activity was documented today.');
  });

  test('lawn default finding line is lawn-flavored when no findings exist', () => {
    const ctx = buildAiSummaryPersonalityContext({
      findings: [], applications: [], serviceLine: 'lawn', now: new Date('2026-07-30T20:00:00Z'),
    });
    expect(ctx.variants.simple.body).toContain('Routine lawn care was completed today.');
    expect(ctx.variants.simple.body).not.toMatch(/pest activity/i);
  });
});
