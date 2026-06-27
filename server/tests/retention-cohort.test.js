const { buildCohortSeries, pointInTimeRate } = require('../services/retention-cohort');

// helper: a member with a flat rate every month (the fallback / no-snapshot case)
const flat = (churnIdx, rate) => ({ churnIdx, rateAt: () => rate });
// helper: a member whose rate varies by month index
const varying = (churnIdx, ratesByIdx, fallback = 0) => ({
  churnIdx,
  rateAt: (idx) => (ratesByIdx[idx] != null ? ratesByIdx[idx] : fallback),
});

describe('buildCohortSeries', () => {
  test('headcount retention drops as members churn', () => {
    // cohort at idx 100, 4 members; two depart in month 2 (churnIdx 102). A member
    // is live through end of month m while churnIdx > cohortIdx+m.
    const members = [flat(Infinity, 100), flat(Infinity, 100), flat(102, 100), flat(102, 100)];
    const { retention } = buildCohortSeries(members, 100, 3);
    expect(retention[0]).toBe(100); // signup month
    expect(retention[1]).toBe(100); // M1 (k=101): 102 > 101 → still live
    expect(retention[2]).toBe(50); // M2 (k=102): 102 > 102 false → departed
    expect(retention[3]).toBe(50);
  });

  test('flat rates (snapshot fallback) → NRR mirrors headcount, capped ≤100', () => {
    const members = [flat(Infinity, 100), flat(101, 100)]; // one churns at M1
    const { retentionMrr } = buildCohortSeries(members, 100, 2);
    expect(retentionMrr[0]).toBe(100);
    expect(retentionMrr[2]).toBe(50); // surviving 100 / base 200
  });

  test('EXPANSION pushes NRR above 100% (true net revenue retention)', () => {
    // 2 members sign up at $100 each (base 200). One churns at M1; the survivor
    // EXPANDS to $300 by M2. Net revenue retained = 300 / 200 = 150%.
    const survivor = varying(Infinity, { 100: 100, 101: 100, 102: 300 });
    const churned = varying(101, { 100: 100 });
    const { retentionMrr, retention } = buildCohortSeries([survivor, churned], 100, 2);
    expect(retention[2]).toBe(50); // headcount: 1 of 2
    expect(retentionMrr[2]).toBe(150); // NRR: expansion exceeds the lost member
  });

  test('contraction shows NRR below headcount', () => {
    // both survive but one contracts $100 → $40 by M1; base 200, M1 mrr 140 = 70%
    const a = varying(Infinity, { 100: 100, 101: 100 });
    const b = varying(Infinity, { 100: 100, 101: 40 });
    const { retention, retentionMrr } = buildCohortSeries([a, b], 100, 1);
    expect(retention[1]).toBe(100); // nobody churned
    expect(retentionMrr[1]).toBe(70); // but revenue contracted
  });

  test('cohort with no MRR at signup → retentionMrr null, headcount still computed', () => {
    const members = [flat(Infinity, 0), flat(101, 0)];
    const { baseMrr, retention, retentionMrr } = buildCohortSeries(members, 100, 2);
    expect(baseMrr).toBe(0);
    expect(retention[2]).toBe(50);
    expect(retentionMrr[0]).toBeNull();
    expect(retentionMrr[2]).toBeNull();
  });

  test('empty cohort → null series', () => {
    const { baseMrr, retention, retentionMrr } = buildCohortSeries([], 100, 2);
    expect(baseMrr).toBe(0);
    expect(retention).toEqual([null, null, null]);
    expect(retentionMrr).toEqual([null, null, null]);
  });
});

describe('pointInTimeRate', () => {
  const rateByCustomer = new Map([['c1', new Map([['2026-05', 120]])]]);
  const snapshottedMonths = new Set(['2026-05']); // May has snapshot data; c2 has no row

  test('snapshotted month + customer has a row → that month\'s rate', () => {
    expect(pointInTimeRate(rateByCustomer, snapshottedMonths, 'c1', 999, '2026-05')).toBe(120);
  });

  test('snapshotted month + customer MISSING → 0 (was $0/paused that month), NOT current rate', () => {
    // c2 isn't in May's snapshot → they were below the MRR population then; must be 0,
    // not their current 999, else today's price leaks into a historical cell.
    expect(pointInTimeRate(rateByCustomer, snapshottedMonths, 'c2', 999, '2026-05')).toBe(0);
  });

  test('unsnapshotted month → current-rate fallback', () => {
    expect(pointInTimeRate(rateByCustomer, snapshottedMonths, 'c1', 80, '2026-03')).toBe(80);
  });
});
