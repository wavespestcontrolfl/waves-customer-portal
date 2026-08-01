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
    // ONE resolver for both display surfaces (SSR hero + /data mirror) so they
    // cannot drift, and it must FAIL CLOSED (codex #3128 r7): the shared
    // predicate answers an unresolved lane with "preserves monthly", which is
    // right for a disclosure note and wrong here — it would print a combined
    // $X/mo total on a per-application plan.
    expect(src).toMatch(/async function estimateRendersMonthlyBilling/);
    expect(src).toContain('const monthlyBilledEstimate = await estimateRendersMonthlyBilling(estimate);');
    expect(src).toContain('monthlyBilled: await estimateRendersMonthlyBilling(estimate),');
    // ...and the pricing bundle too (codex #3128 r10). The flags are not a
    // disclosure note: PriceCard reads their ABSENCE as permission to render
    // "Billed $X/mo", so a fail-OPEN strip re-opened the monthly spread on the
    // React path. EVERY display caller goes through the fail-closed resolver;
    // the raw predicate has exactly one caller, inside it.
    expect(src).toContain('return (await estimateRendersMonthlyBilling(estimate))');
    const rawCallers = src.match(/await estimateCustomerPreservesMonthlyBilling\([^)]*\)/g) || [];
    expect(rawCallers).toEqual(['await estimateCustomerPreservesMonthlyBilling(estimate)']);
    // No knob to set wrongly later.
    expect(src).not.toMatch(/unresolvedVerdict/);
  });

  test('reconciled service cards still win over the monthly hero', () => {
    // Ordering pin in the OTHER direction (codex #3128 r8, correcting r6):
    // when the rows reconcile to the total, the per-application cards are the
    // right surface even for a monthly-billed plan. Owner directive
    // 2026-07-01 renders the commercial turf line that way so the card carries
    // its application cadence AND the mowing-exclusion scope note, and
    // supplementalServiceSummaryHtml is empty at full coverage — so hoisting
    // the monthly gate above the cards silently deletes both from the
    // proposal. The monthly arm exists for the UNCOVERED total only.
    const heroStart = src.indexOf('const recurringHeroPriceHtml');
    const hero = src.slice(heroStart, src.indexOf('Priced per application', heroStart));
    expect(hero.indexOf('serviceCardsCoverRecurringTotal ? `'))
      .toBeLessThan(hero.indexOf('recurringBilledMonthly ? `'));
  });

  test('preference rows quote the per-application amount, not a cadence spread', () => {
    const renderPrefRow = src.slice(src.indexOf('function renderPrefRow'), src.indexOf('function renderPrefRow') + 1400);
    expect(renderPrefRow).toContain('per application');
    expect(renderPrefRow).not.toContain('intervalPriceFromMonthly');
  });

  test('the post-toggle savings label matches the one the page rendered with', () => {
    // The toggle handler writes the response's savingsLabel straight over the
    // server-rendered row, so a cadence spread in the RESPONSE builder undid
    // the per-application copy the moment a customer touched a switch
    // (codex #3128 r8). Both builders must emit the same three strings.
    const prefMeta = src.slice(src.indexOf('const prefMeta = {}'), src.indexOf('const prefMeta = {}') + 1200);
    expect(prefMeta).toContain('per application');
    expect(prefMeta).not.toContain('intervalPriceFromMonthly');
    expect(prefMeta).not.toContain('pricePeriodLabelForFrequencyKey');
  });
});

// The display identity must FAIL CLOSED (codex #3128 r7). The shared
// predicate it wraps answers an unresolved lane with "preserves monthly" —
// correct for a disclosure note, dangerous here, because it would print a
// combined $X/mo total on a plan that bills per application.
describe('monthly-billing display identity fails closed on a lookup failure', () => {
  const loadRouteWithBrokenCustomerLookup = () => {
    let mod;
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => {
        const failing = () => { throw new Error('customers lookup unavailable'); };
        const db = jest.fn(() => ({
          where: failing,
          whereIn: failing,
          first: failing,
          select: failing,
        }));
        db.raw = jest.fn();
        db.fn = { now: jest.fn() };
        db.schema = { hasColumn: jest.fn().mockResolvedValue(true) };
        db.transaction = jest.fn();
        return db;
      });
      mod = require('../routes/estimate-public');
    });
    return mod;
  };

  test('a linked estimate whose customer lookup throws renders per application', async () => {
    const { estimateRendersMonthlyBilling } = loadRouteWithBrokenCustomerLookup();
    await expect(estimateRendersMonthlyBilling({
      id: 'est-lookup-fail',
      customer_id: '00000000-0000-0000-0000-000000000001',
    })).resolves.toBe(false);
  });

  test('an estimate with no customer signal at all renders per application', async () => {
    const { estimateRendersMonthlyBilling } = loadRouteWithBrokenCustomerLookup();
    await expect(estimateRendersMonthlyBilling({ id: 'est-unlinked' })).resolves.toBe(false);
  });
});
