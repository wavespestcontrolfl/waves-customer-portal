/**
 * "Per month" copy sweep ("per month" audit 2026-08-01): recurring service is
 * billed per application (or prepaid for the year), never a flat monthly —
 * these pin the two estimate-public surfaces that still described charges
 * monthly, plus the accept-notification price scrub.
 */

const { shapePreferenceAddOns } = require('../routes/estimate-public');

describe('estimate add-on toggles (shapePreferenceAddOns)', () => {
  test('quotes savings per application, not spread across months', () => {
    const addOns = shapePreferenceAddOns({}, { apps: 4 });
    expect(addOns.length).toBeGreaterThan(0);
    for (const addOn of addOns) {
      // The $10-per-visit add-on used to render "Save $3.33/mo if removed"
      // (perVisit × visits ÷ 12) — a monthly spread of a per-application price.
      expect(addOn.detail).toMatch(/Save \$\d+(\.\d\d)? per application if removed\./);
      expect(addOn.detail).not.toMatch(/\/mo\b|per month/i);
    }
  });

  test('the per-application figure is the add-on price itself, cadence-independent', () => {
    const quarterly = shapePreferenceAddOns({}, { apps: 4 });
    const monthly = shapePreferenceAddOns({}, { apps: 12 });
    expect(quarterly[0].detail).toBe(monthly[0].detail);
    expect(quarterly[0].detail).toContain('Save $10 per application');
  });
});

describe('accept-notification customer copy has no plan price', () => {
  // The payer-billed branch interpolated "$X/mo" into the CUSTOMER
  // notification while every sibling branch says just "Your {tier} WaveGuard
  // plan is approved". Source-level pin: no customerBody template in the
  // accept-notification region may interpolate monthlyText.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');

  test('no customerBody interpolates the monthly figure', () => {
    const customerBodies = src.match(/customerBody: `[^`]*`/g) || [];
    expect(customerBodies.length).toBeGreaterThan(5);
    for (const body of customerBodies) {
      expect(body).not.toMatch(/monthlyText|\/mo\b/);
    }
  });

  test('admin copy may keep the monthly shorthand (internal)', () => {
    // Regression guard in the other direction: the admin label still carries
    // the figure so office notifications stay information-dense.
    expect(src).toMatch(/adminPlanLabel[\s\S]{0,200}monthlyText/);
  });
});

describe('legacy SSR renderer mirrors the per-application rules (codex #3128 r2)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/estimate-public.js'), 'utf8');

  test('the uncovered-total hero names the billing unit — combined totals only behind the monthly-billed gate', () => {
    expect(src).toContain('Priced per application');
    // The combined cadence total may render ONLY inside the monthly-billed
    // arm. Two identities qualify and nothing else: commercial (their
    // contract IS "Approve & pay monthly"; codex #3128 r3) and a preserved
    // monthly member (accept keeps membership dues; codex #3128 r6). Every
    // interpolation of the combined total must sit after that gate and before
    // the residential "Priced per application" arm.
    const heroStart = src.indexOf('const recurringHeroPriceHtml');
    const hero = src.slice(heroStart, src.indexOf('Priced per application', heroStart));
    const gate = hero.indexOf('recurringBilledMonthly ? `');
    expect(gate).toBeGreaterThan(-1);
    const beforeGate = hero.slice(0, gate);
    expect(beforeGate).not.toMatch(/id="monthly-display"/);
  });

  test('the monthly-billed identity is exactly commercial OR a preserved monthly member', () => {
    expect(src).toContain('const recurringBilledMonthly = commercialRecurringEstimate || monthlyBilledEstimate;');
    // The residential half is resolved LIVE from the customer lane by the
    // route (never a stored field), through the SAME predicate that strips
    // billedPerApplication flags — a divergent source is how the SSR hero and
    // the pricing bundle disagreed in the first place.
    expect(src).toContain('opts.monthlyBilledEstimate === true');
    expect(src).toMatch(/monthlyBilledEstimate = !\(await perApplicationBillingColumnsExist\(\)\)\s*\|\| await estimateCustomerPreservesMonthlyBilling\(estimate\)/);
  });

  test('the per-application service cards never render for a monthly-billed plan', () => {
    // The cards say "$X / application" on every row, so the monthly gate has
    // to come FIRST in the hero chain — a commercial or preserved-monthly
    // plan whose rows happen to reconcile to the total would otherwise be
    // quoted in a unit it is not billed in (codex #3128 r6).
    const heroStart = src.indexOf('const recurringHeroPriceHtml');
    const hero = src.slice(heroStart, src.indexOf('Priced per application', heroStart));
    expect(hero.indexOf('recurringBilledMonthly ? `'))
      .toBeLessThan(hero.indexOf('serviceCardsCoverRecurringTotal ? `'));
  });

  test('preference rows quote the per-application amount, not a cadence spread', () => {
    const renderPrefRow = src.slice(src.indexOf('function renderPrefRow'), src.indexOf('function renderPrefRow') + 1400);
    expect(renderPrefRow).toContain('per application');
    expect(renderPrefRow).not.toContain('intervalPriceFromMonthly');
  });
});
