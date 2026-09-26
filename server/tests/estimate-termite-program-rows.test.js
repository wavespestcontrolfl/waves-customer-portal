const { selectedTermiteAnnualPlanRows } = require('../services/estimate-termite-program-rows');

// Codex P1 (slice 3a restructure, round 2): selectedTermiteAnnualPlanRows'
// mapped-envelope branch used to return early with JUST the tmBait envelope,
// never the one-time station-setup row from result.oneTime.items — dropping
// the disclosed setup fee for every REAL production estimate (the mapped
// `result.results.tmBait` shape v1-legacy-mapper.js actually emits). Only a
// hand-mocked two-row helper result exercised the setup line before. These
// fixtures mirror v1-legacy-mapper.js's real output shape exactly (tmBait
// envelope + a termite_bait_installation/kind:'setup' oneTime item).
describe('selectedTermiteAnnualPlanRows — real mapper output shape', () => {
  function mapperShapedEstimateData({ plan = 'annual_protection', setupPrice = 199 } = {}) {
    return {
      result: {
        results: {
          tmBait: {
            selectedSystem: 'trelona',
            system: 'trelona',
            plan,
            planLabel: 'Annual Protection',
            setupFee: setupPrice,
            annualFee: 250,
          },
        },
        oneTime: {
          items: [
            {
              service: 'termite_bait_installation',
              name: 'Station Setup',
              price: setupPrice,
              detail: '6 stations · $33.17 per station · Waves-owned',
              kind: 'setup',
              tierDiscountable: false,
            },
          ],
        },
      },
    };
  }

  test('annual_protection plan: returns the tmBait envelope AND the mapped one-time setup row', () => {
    const rows = selectedTermiteAnnualPlanRows(mapperShapedEstimateData());
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ plan: 'annual_protection' });
    const setupRow = rows.find((r) => r.kind === 'setup');
    expect(setupRow).toMatchObject({
      service: 'termite_bait_installation',
      name: 'Station Setup',
      price: 199,
      kind: 'setup',
    });
  });

  test('quarterly plan (not annual_protection): the mapped envelope short-circuits to empty, even with a one-time install row present', () => {
    const rows = selectedTermiteAnnualPlanRows(mapperShapedEstimateData({ plan: 'quarterly' }));
    expect(rows).toEqual([]);
  });

  test('no one-time items at all: annual_protection plan still returns just the envelope, no crash', () => {
    const estimateData = mapperShapedEstimateData();
    estimateData.result.oneTime.items = [];
    const rows = selectedTermiteAnnualPlanRows(estimateData);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ plan: 'annual_protection' });
  });

  test('legacy raw-lineItems shape (no mapped envelope) still includes the setup row as before', () => {
    const estimateData = {
      lineItems: [{ service: 'termite_bait', plan: 'annual_protection', annual: 250 }],
      oneTime: {
        items: [{ service: 'termite_bait_installation', name: 'Station Setup', price: 199, kind: 'setup' }],
      },
    };
    const rows = selectedTermiteAnnualPlanRows(estimateData);
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.kind === 'setup')).toMatchObject({ price: 199 });
  });
});
