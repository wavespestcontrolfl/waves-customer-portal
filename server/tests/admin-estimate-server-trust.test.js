/**
 * P1-2 — the SERVER-authoritative recompute must not trust browser-supplied
 * identity fields (priorQualifyingServices, recurring-customer flag) that
 * unlock existing-customer pricing. The audit forged a mosquito quote from
 * Bronze up to Platinum via a fake priorQualifyingServices, and stole the
 * 15% one-time perk via a fake recurringCustomer:true — both under a SERVER
 * provenance stamp. These pin that the forged blob values are overridden by
 * the server-derived deps, WITHOUT breaking the legit in-cart auto-derivation.
 */

jest.mock('../models/db', () => jest.fn());

const { serverRecomputeFromEstimateData, sanitizeClientIdentityFields } = require('../services/admin-estimate-persistence');

describe('sanitizeClientIdentityFields', () => {
  test('strips only the top-level identity/recurring fields, leaving everything else', () => {
    const input = {
      homeSqFt: 2000,
      services: { mosquito: { tier: 'monthly12' }, germanRoachInitial: { isRecurringCustomer: true } },
      priorQualifyingServices: ['pest_control'],
      recurringCustomer: true,
      isRecurringCustomer: true,
    };
    const out = sanitizeClientIdentityFields(input);
    expect(out.priorQualifyingServices).toBeUndefined();
    expect(out.recurringCustomer).toBeUndefined();
    expect(out.isRecurringCustomer).toBeUndefined();
    // Non-identity fields and nested objects are untouched — the nested
    // germanRoachInitial flag is neutralized in the engine (it now reads the
    // canonical derived recurring status), not by this top-level sanitizer.
    expect(out.homeSqFt).toBe(2000);
    expect(out.services.mosquito).toEqual({ tier: 'monthly12' });
    expect(out.services.germanRoachInitial.isRecurringCustomer).toBe(true);
  });

  test('is a safe no-op on null / non-objects / arrays', () => {
    expect(sanitizeClientIdentityFields(null)).toBeNull();
    expect(sanitizeClientIdentityFields(undefined)).toBeUndefined();
    const arr = [1, 2];
    expect(sanitizeClientIdentityFields(arr)).toBe(arr);
  });
});

const QUALIFIERS = ['pest_control', 'lawn_care', 'tree_shrub']; // + this estimate's mosquito = 4 → Platinum

const mosquitoInput = () => ({
  homeSqFt: 2500, stories: 1, lotSqFt: 50000,
  propertyType: 'single_family', zone: 'A',
  features: { shrubs: 'heavy', trees: 'heavy', complexity: 'complex' },
  services: { mosquito: { tier: 'monthly12' } },
  paymentMethod: 'card',
});

async function annual(estimateData, deps) {
  const r = await serverRecomputeFromEstimateData(estimateData, deps);
  expect(r.recomputed).toBe(true);
  return r.serverTotals.annualTotal;
}

describe('P1-2 server-authoritative recompute ignores forged identity inputs', () => {
  test('forged priorQualifyingServices in the client blob does NOT lift the WaveGuard tier', async () => {
    // Server says: no priors (a lead / new customer).
    const deps = { priorQualifyingServices: [], recurringCustomer: false };

    const forged = await annual({ engineInputs: { ...mosquitoInput(), priorQualifyingServices: QUALIFIERS } }, deps);
    const clean = await annual({ engineInputs: mosquitoInput() }, deps);

    // The forged priors are overridden by the empty server list → same price
    // as no priors at all (Bronze), not a discounted Platinum.
    expect(forged).toBe(clean);
  });

  test('server-derived priorQualifyingServices DO lift the tier (mechanism still works when legit)', async () => {
    const baseline = await annual({ engineInputs: mosquitoInput() }, { priorQualifyingServices: [], recurringCustomer: false });
    const withPriors = await annual({ engineInputs: mosquitoInput() }, { priorQualifyingServices: QUALIFIERS, recurringCustomer: false });

    // 1 (mosquito) + 3 server priors = 4 qualifiers → Platinum discount → cheaper.
    expect(withPriors).toBeLessThan(baseline);
  });

  const ONE_TIME = () => ({
    homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family', zone: 'A',
    features: {}, services: { oneTimePest: {} }, paymentMethod: 'card',
  });
  const oneTimePrice = (r) => Number(r.serverResult?.oneTime?.items?.[0]?.price);

  test('forged recurringCustomer:true does NOT steal the one-time perk when the server says non-member', async () => {
    const deps = { priorQualifyingServices: [], recurringCustomer: false };

    const forged = await serverRecomputeFromEstimateData({ engineInputs: { ...ONE_TIME(), recurringCustomer: true } }, deps);
    const clean = await serverRecomputeFromEstimateData({ engineInputs: ONE_TIME() }, deps);

    // The forged flag is stripped: the result is priced as a non-member
    // (isRecurringCustomer false, no one-time discount), identical to no flag.
    expect(forged.serverResult.isRecurringCustomer).toBe(false);
    expect(oneTimePrice(forged)).toBe(oneTimePrice(clean));
  });

  test('a server-verified member (deps.recurringCustomer:true) DOES get the one-time perk', async () => {
    const member = await serverRecomputeFromEstimateData({ engineInputs: ONE_TIME() }, { priorQualifyingServices: [], recurringCustomer: true });
    const nonMember = await serverRecomputeFromEstimateData({ engineInputs: ONE_TIME() }, { priorQualifyingServices: [], recurringCustomer: false });

    expect(member.serverResult.isRecurringCustomer).toBe(true);
    expect(nonMember.serverResult.isRecurringCustomer).toBe(false);
    // The 15% one-time perk applies for the verified member → cheaper one-time.
    expect(oneTimePrice(member)).toBeLessThan(oneTimePrice(nonMember));
  });

  const roachPriceOf = (r) => Number(r.serverResult?.oneTime?.specItems?.[0]?.price ?? r.serverResult?.oneTime?.items?.[0]?.price ?? r.serverTotals?.onetimeTotal);

  test('forged NESTED germanRoachInitial.isRecurringCustomer no longer grants the per-line perk (engine uses derived status)', async () => {
    const roach = (nested) => ({
      homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family', zone: 'A',
      features: {},
      services: { germanRoachInitial: { urgency: 'NONE', afterHours: false, isRecurringCustomer: nested } },
      paymentMethod: 'card',
    });
    const deps = { priorQualifyingServices: [], recurringCustomer: false };

    // Non-member, one-time-only cart: a forged nested flag has no effect —
    // the engine prices the line from its own derived recurring status.
    const forged = await serverRecomputeFromEstimateData({ engineInputs: roach(true) }, deps);
    const clean = await serverRecomputeFromEstimateData({ engineInputs: roach(false) }, deps);
    expect(roachPriceOf(forged)).toBe(roachPriceOf(clean));

    // A server-verified member DOES get the line's recurring discount.
    const member = await serverRecomputeFromEstimateData({ engineInputs: roach(false) }, { priorQualifyingServices: [], recurringCustomer: true });
    expect(roachPriceOf(member)).toBeLessThan(roachPriceOf(clean));
  });

  test('in-cart recurring service keeps the germanRoachInitial discount for a non-member (bundle untouched)', async () => {
    const roachOnly = {
      homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family', zone: 'A',
      features: {}, services: { germanRoachInitial: { urgency: 'NONE', afterHours: false, isRecurringCustomer: false } }, paymentMethod: 'card',
    };
    const roachPlusPest = { ...roachOnly, services: { pest: { frequency: 'quarterly' }, germanRoachInitial: { urgency: 'NONE', afterHours: false, isRecurringCustomer: false } } };
    const deps = { priorQualifyingServices: [], recurringCustomer: false };

    const bundle = await serverRecomputeFromEstimateData({ engineInputs: roachPlusPest }, deps);
    const solo = await serverRecomputeFromEstimateData({ engineInputs: roachOnly }, deps);
    // In-cart recurring pest makes derived recurring true → the initial roach
    // treatment keeps its discount even for a non-member.
    expect(roachPriceOf(bundle)).toBeLessThan(roachPriceOf(solo));
  });

  test('the engine still auto-derives recurring from THIS cart (legit bundle perk untouched)', async () => {
    // A lead (server: non-member, no priors, no forged flag) whose estimate
    // ITSELF buys a recurring pest service + a one-time service. Stripping the
    // client flag must NOT disable the engine's own cart-based auto-derivation.
    const bundle = () => ({
      homeSqFt: 2000, stories: 1, lotSqFt: 10000, propertyType: 'single_family', zone: 'A',
      features: {}, services: { pest: { frequency: 'quarterly' }, oneTimePest: {} }, paymentMethod: 'card',
    });
    const r = await serverRecomputeFromEstimateData({ engineInputs: bundle() }, { priorQualifyingServices: [], recurringCustomer: false });
    expect(r.recomputed).toBe(true);
    // The in-cart recurring pest line makes them a recurring customer via the
    // engine's activeServiceKeys auto-derivation — untouched by the strip.
    expect(r.serverResult.isRecurringCustomer).toBe(true);
  });
});
