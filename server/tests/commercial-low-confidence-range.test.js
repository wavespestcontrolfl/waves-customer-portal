process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Commercial low-confidence RANGE + force-manual backstop (owner-locked risk-type
// lane, decision 7). A commercial auto-priced line whose driving area is
// estimated/large carries pricingConfidence 'LOW' → the customer sees a ±20%
// range + "confirmed on site". When that band is too wide (> $300/mo swing) the
// range is useless → the estimate is force-converted to a site-confirmed manual
// quote (quote-required).

const {
  commercialLowConfidenceRange,
  commercialLowConfidenceRequiresSiteQuote,
} = require('../services/estimate-delivery-options');
const { resolveEstimateQuoteRequirement, renderPage, attachPublicPricingContract, buildAcceptSuccessPayload, buildEstimateAcceptanceContract } = require('../routes/estimate-public');
const { generateEstimate } = require('../services/pricing-engine');

const recurring = (services) => ({ result: { recurring: { services } } });
const LOW = (annual) => ({ service: 'commercial_lawn', pricingConfidence: 'LOW', annual, estimatedPricing: true });
const MED = (annual) => ({ service: 'commercial_pest', pricingConfidence: 'MEDIUM', annual, estimatedPricing: true });

describe('commercialLowConfidenceRange', () => {
  test('narrow LOW line → ±20% range, not forced to a site quote', () => {
    // $400/mo → 320–480, swing 160 (< 300); all-LOW so low share == exact total
    expect(commercialLowConfidenceRange(recurring([LOW(4800)]))).toEqual({
      hasLowConfidence: true, rangeLowMonthly: 320, rangeHighMonthly: 480, monthlySwing: 160,
      lowConfidenceMonthly: 400, exactMonthly: 400, forceSiteQuote: false,
    });
  });
  test('wide LOW line → force site quote', () => {
    // $1000/mo → 800–1200, swing 400 (> 300)
    expect(commercialLowConfidenceRange(recurring([LOW(12000)]))).toMatchObject({ forceSiteQuote: true });
    expect(commercialLowConfidenceRequiresSiteQuote(recurring([LOW(12000)]))).toBe(true);
  });
  test('MEDIUM lines are exact; only LOW lines get the band', () => {
    // LOW $400 (320–480) + MEDIUM $500 (exact) → 820–980, swing 160. Only the
    // $400 LOW share carries the band; exact total is the full $900.
    expect(commercialLowConfidenceRange(recurring([LOW(4800), MED(6000)]))).toMatchObject({
      rangeLowMonthly: 820, rangeHighMonthly: 980, monthlySwing: 160,
      lowConfidenceMonthly: 400, exactMonthly: 900,
    });
  });
  test('engineResult.lineItems shape (public-quote mirror) is detected', () => {
    // The public calculator persists non-manual commercial priced lines here, not
    // under result.recurring.services — the backstop/range must still apply.
    const eng = (svc) => ({ engineResult: { lineItems: [svc] } });
    expect(commercialLowConfidenceRange(eng({ service: 'commercial_lawn', pricingConfidence: 'LOW', annual: 4800, monthly: 400 })))
      .toMatchObject({ hasLowConfidence: true, forceSiteQuote: false });
    expect(commercialLowConfidenceRange(eng({ service: 'commercial_lawn', pricingConfidence: 'LOW', annual: 12000, monthly: 1000 })))
      .toMatchObject({ forceSiteQuote: true });
  });

  test('a line present in BOTH shapes is deduped (not double-counted)', () => {
    // recurring row lost pricingConfidence in supplementation; engineResult has it.
    const both = {
      result: { recurring: { services: [{ service: 'commercial_lawn', annual: 12000 }] } },
      engineResult: { lineItems: [{ service: 'commercial_lawn', pricingConfidence: 'LOW', annual: 12000, monthly: 1000 }] },
    };
    // single $1000/mo LOW line → swing 400 (not 800 from double-count)
    expect(commercialLowConfidenceRange(both)).toMatchObject({ monthlySwing: 400, forceSiteQuote: true });
  });

  test('all-MEDIUM / manual / non-commercial → no range', () => {
    expect(commercialLowConfidenceRange(recurring([MED(6000)]))).toEqual({ hasLowConfidence: false });
    expect(commercialLowConfidenceRange(recurring([{ service: 'commercial_pest', pricingConfidence: 'LOW', quoteRequired: true, annual: null }]))).toEqual({ hasLowConfidence: false });
    expect(commercialLowConfidenceRange(recurring([{ service: 'pest_control', pricingConfidence: 'LOW', annual: 600 }]))).toEqual({ hasLowConfidence: false });
    expect(commercialLowConfidenceRange(null)).toEqual({ hasLowConfidence: false });
  });
});

describe('public /calculate quoteRequired wiring (real engine lines)', () => {
  // The public calculator computes quoteRequired from the SAME call this asserts:
  //   commercialLowConfidenceRequiresSiteQuote({ engineResult: { lineItems: estimate.lineItems } })
  // A wide LOW commercial line must force the site-confirmation (quote-required)
  // response instead of returning monthly_total/variance for an unusable band.
  const commercialLawn = (lotSqFt) => generateEstimate({
    homeSqFt: 3000, lotSqFt, stories: 1, propertyType: 'commercial', lotSqFtEstimated: true,
    services: { lawn: { track: 'st_augustine', tier: 'enhanced' } },
  });

  test('large commercial turf → wide LOW band forces a site quote', () => {
    const estimate = commercialLawn(400000);
    const lawn = estimate.lineItems.find((l) => l.service === 'commercial_lawn');
    expect(lawn.pricingConfidence).toBe('LOW');
    expect(commercialLowConfidenceRequiresSiteQuote({ engineResult: { lineItems: estimate.lineItems } })).toBe(true);
  });

  test('small commercial turf → narrow LOW band still prices instantly (no force)', () => {
    const estimate = commercialLawn(12000);
    const lawn = estimate.lineItems.find((l) => l.service === 'commercial_lawn');
    expect(lawn.pricingConfidence).toBe('LOW');
    expect(commercialLowConfidenceRequiresSiteQuote({ engineResult: { lineItems: estimate.lineItems } })).toBe(false);
  });
});

describe('resolveEstimateQuoteRequirement — low-confidence backstop', () => {
  test('narrow low-confidence stays self-serve approvable', () => {
    expect(resolveEstimateQuoteRequirement(null, recurring([LOW(4800)])))
      .toEqual(expect.objectContaining({ quoteRequired: false }));
  });
  test('wide low-confidence → quote-required, reason commercial_low_confidence_site_confirmation', () => {
    expect(resolveEstimateQuoteRequirement(null, recurring([LOW(12000)])))
      .toEqual(expect.objectContaining({ quoteRequired: true, reason: 'commercial_low_confidence_site_confirmation' }));
  });
});

describe('attachPublicPricingContract — narrow low-confidence range marker (React price cards)', () => {
  // A NARROW low-confidence commercial line stays self-serve approvable but its
  // frequencies get lowConfidenceRangePct so PriceCard shows a "$X–$Y/mo" band.
  const estData = (annual) => ({
    result: { recurring: { services: [
      { service: 'commercial_lawn', name: 'Commercial Turf Treatment Program', pricingConfidence: 'LOW', mo: annual / 12, annual, estimatedPricing: true },
    ] } },
  });
  const payload = (annual) => ({ frequencies: [{ key: 'monthly', label: 'Commercial Turf Treatment Program', monthly: annual / 12, annual }] });
  const firstFreq = (contract) => contract.services?.[0]?.frequencies?.[0] || {};

  test('narrow LOW commercial → frequencies carry lowConfidenceRangePct 0.20 + full LOW fraction', () => {
    // $400/mo → swing $160 (< $300) → narrow, approvable, ranged. Single all-LOW
    // line → fraction 1 (whole price is low-confidence).
    const contract = attachPublicPricingContract(payload(4800), {}, estData(4800));
    expect(firstFreq(contract).lowConfidenceRangePct).toBe(0.2);
    expect(firstFreq(contract).lowConfidenceFraction).toBe(1);
    expect(contract.quoteRequired).not.toBe(true);
  });

  test('wide LOW commercial → NO range marker (force-manual handled upstream)', () => {
    // $1000/mo → swing $400 (> $300) → forceSiteQuote, no self-serve range
    const contract = attachPublicPricingContract(payload(12000), {}, estData(12000));
    expect(firstFreq(contract).lowConfidenceRangePct).toBeUndefined();
  });

  test('non-commercial LOW line → no range marker', () => {
    const resiData = { result: { recurring: { services: [{ service: 'lawn_care', pricingConfidence: 'LOW', mo: 50, annual: 600 }] } } };
    const contract = attachPublicPricingContract({ frequencies: [{ key: 'monthly', monthly: 50, annual: 600 }] }, {}, resiData);
    expect(firstFreq(contract).lowConfidenceRangePct).toBeUndefined();
  });

  test('multi-service commercial → each recurring card + combined carry their own LOW share', () => {
    // commercial_lawn LOW $400/mo + commercial_tree_shrub MEDIUM $250/mo. Commercial
    // services have no per-service selectable ladder → one bundle card covering both.
    // The bundle bands only the LOW share: fraction = 400 / (400 + 250) ≈ 0.615.
    const mixed = { result: { recurring: { services: [
      { service: 'commercial_lawn', name: 'Commercial Turf Treatment Program', pricingConfidence: 'LOW', mo: 400, annual: 4800 },
      { service: 'commercial_tree_shrub', name: 'Commercial Tree & Shrub', pricingConfidence: 'MEDIUM', mo: 250, annual: 3000 },
    ] } } };
    const contract = attachPublicPricingContract({ frequencies: [{ key: 'monthly', monthly: 650, annual: 7800 }] }, {}, mixed);
    const section = contract.services.find((s) => s.isRecurring);
    expect(section.frequencies[0].lowConfidenceRangePct).toBe(0.2);
    expect(section.frequencies[0].lowConfidenceFraction).toBeCloseTo(400 / 650, 5);
    // The combined "Recurring total" card ranges on the same aggregate share —
    // AND ships the raw LOW dollars so the client can recompute the fraction
    // against whichever combined cadence the customer selects (the uncertain
    // dollars are fixed; the exact part moves with the selection).
    expect(contract.combinedRecurring.lowConfidenceRangePct).toBe(0.2);
    expect(contract.combinedRecurring.lowConfidenceFraction).toBeCloseTo(400 / 650, 5);
    expect(contract.combinedRecurring.lowConfidenceMonthly).toBe(400);
  });

  test('exact non-commercial add-on stays OUT of the band (denominator = displayed total)', () => {
    // commercial_lawn LOW $400 + foam_recurring exact $100 → displayed $500. Only
    // the $400 LOW carries the band: fraction 0.8 (not 1.0), so foam isn't ranged.
    const withAddOn = { result: { recurring: { services: [
      { service: 'commercial_lawn', name: 'Commercial Turf Treatment Program', pricingConfidence: 'LOW', mo: 400, annual: 4800 },
      { service: 'foam_recurring', name: 'Termite Foam', pricingConfidence: 'HIGH', mo: 100, annual: 1200 },
    ] } } };
    const contract = attachPublicPricingContract({ frequencies: [{ key: 'monthly', monthly: 500, annual: 6000 }] }, {}, withAddOn);
    const section = contract.services.find((s) => s.isRecurring);
    expect(section.frequencies[0].lowConfidenceFraction).toBeCloseTo(0.8, 5);
    expect(contract.combinedRecurring.lowConfidenceFraction).toBeCloseTo(0.8, 5);
  });

  test('fraction is per-frequency (low ÷ that cadence monthly) → same dollar band at every cadence', () => {
    // Single commercial_lawn LOW $400. Two cadences with different displayed
    // monthly totals get DIFFERENT fractions but the same ±$80 dollar band, so a
    // selectable bundle never over/under-states the band when the cadence flips.
    const est = { result: { recurring: { services: [
      { service: 'commercial_lawn', name: 'Commercial Turf Treatment Program', pricingConfidence: 'LOW', mo: 400, annual: 4800 },
    ] } } };
    const contract = attachPublicPricingContract(
      { frequencies: [{ key: 'monthly', monthly: 400 }, { key: 'plus_addon', monthly: 500 }] },
      {},
      est,
    );
    const freqs = contract.services.find((s) => s.isRecurring).frequencies;
    const byKey = Object.fromEntries(freqs.map((f) => [f.key, f]));
    expect(byKey.monthly.lowConfidenceFraction).toBeCloseTo(1, 5);       // 400/400
    expect(byKey.plus_addon.lowConfidenceFraction).toBeCloseTo(0.8, 5);  // 400/500
    // band = monthly × fraction × pct → $80 at BOTH cadences (only the LOW $400).
    expect(byKey.monthly.monthly * byKey.monthly.lowConfidenceFraction * 0.2).toBeCloseTo(80, 5);
    expect(byKey.plus_addon.monthly * byKey.plus_addon.lowConfidenceFraction * 0.2).toBeCloseTo(80, 5);
  });

  test('MEDIUM-only commercial multi-service → no range marker anywhere', () => {
    const med = { result: { recurring: { services: [
      { service: 'commercial_lawn', pricingConfidence: 'MEDIUM', mo: 400, annual: 4800 },
      { service: 'commercial_tree_shrub', pricingConfidence: 'MEDIUM', mo: 250, annual: 3000 },
    ] } } };
    const contract = attachPublicPricingContract({ frequencies: [{ key: 'monthly', monthly: 650, annual: 7800 }] }, {}, med);
    const section = contract.services.find((s) => s.isRecurring);
    expect(section.frequencies[0].lowConfidenceRangePct).toBeUndefined();
    expect(contract.combinedRecurring.lowConfidenceRangePct).toBeUndefined();
  });
});

describe('buildEstimateAcceptanceContract — held estimates accept without a slot', () => {
  // The slots endpoints return an empty commercial-manual list for these, so a
  // slot-pick acceptance mode would leave the customer with a visible range but
  // no way to approve it.
  test('site-confirmation hold + no linked appointment → no-slot accept mode', () => {
    expect(buildEstimateAcceptanceContract({ quoteRequirement: { quoteRequired: false }, siteConfirmationHold: true }))
      .toMatchObject({ mode: 'commercial_site_confirmation' });
  });
  test('an existing linked appointment still wins over the hold (its flow already accepts)', () => {
    const appt = { id: 'ss1', scheduled_date: '2026-07-10', status: 'pending' };
    expect(buildEstimateAcceptanceContract({ quoteRequirement: {}, existingAppointment: appt, siteConfirmationHold: true }).mode)
      .toBe('existing_appointment');
  });
  test('quote-required still wins over the hold (not self-serve at all)', () => {
    expect(buildEstimateAcceptanceContract({ quoteRequirement: { quoteRequired: true, reason: 'x' }, siteConfirmationHold: true }).mode)
      .toBe('quote_required');
  });
  test('no hold → standard slot pick (unchanged)', () => {
    expect(buildEstimateAcceptanceContract({ quoteRequirement: {} }).mode).toBe('standard_slot_pick');
  });
});

describe('buildAcceptSuccessPayload — low-confidence site-confirmation hold', () => {
  test('siteConfirmationHold → site_confirmation outcome, no invoice/pay step', () => {
    const out = buildAcceptSuccessPayload({ siteConfirmationHold: true });
    expect(out.nextStep).toBe('site_confirmation');
    expect(out.invoiceMode).toBe(false);
    expect(out.invoiceId).toBeNull();
  });

  test('site-confirmation hold wins even if an invoice somehow leaks through', () => {
    // Defense-in-depth: the hold suppresses the mint, but the outcome must never
    // fall back to a pay step for a held estimate.
    const out = buildAcceptSuccessPayload({ siteConfirmationHold: true, invoiceMode: true, invoiceId: 'inv_1', invoicePayUrl: '/pay/x' });
    expect(out.nextStep).toBe('site_confirmation');
  });

  test('without the hold, a normal invoice-mode accept still routes to pay_invoice', () => {
    expect(buildAcceptSuccessPayload({ invoiceMode: true, invoiceId: 'inv_1', invoicePayUrl: '/pay/x' }).nextStep).toBe('pay_invoice');
  });
});

describe('renderPage — low-confidence commercial estimate', () => {
  const html = (annual) => {
    const est = { id: 'e1', status: 'sent', customerName: 'Pelican HOA', address: '1 Commerce Way', monthlyTotal: annual / 12, annualTotal: annual, onetimeTotal: 0, quoteRequired: false };
    const data = {
      commercialEstimatedPricing: true,
      result: { recurring: { discount: 0, annualBeforeDiscount: annual, annualAfterDiscount: annual, services: [{ name: 'Commercial Turf Treatment Program', service: 'commercial_lawn', mo: annual / 12, annual, estimatedPricing: true, pricingConfidence: 'LOW', discountable: false, excludeFromPctDiscount: true }] }, oneTime: { items: [], membershipFee: 0 } },
      engineResult: { lineItems: [{ service: 'commercial_lawn', name: 'Commercial Turf Treatment Program', annual, pricingConfidence: 'LOW', estimatedPricing: true }] },
    };
    return renderPage('tok', est, data);
  };

  test('narrow low-confidence stays self-serve approvable (range DISPLAY is a fast-follow)', () => {
    // The narrow-range price DISPLAY needs the React estimate view (fast-follow);
    // this PR delivers the force-manual backstop. A narrow low-confidence estimate
    // stays approvable (not forced to a quote).
    const out = html(4800);
    expect(out).toContain('id="commercial-accept-card"');
  });

  test('wide low-confidence forces the site-confirmation state (no approval card)', () => {
    const out = html(12000);
    expect(out).not.toContain('id="commercial-accept-card"');
    expect(out).toMatch(/quick site confirmation/i);
    expect(out).toMatch(/Your account manager will finalize this/i);
  });
});
