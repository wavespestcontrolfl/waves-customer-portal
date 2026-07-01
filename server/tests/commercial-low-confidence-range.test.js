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
const { resolveEstimateQuoteRequirement, renderPage } = require('../routes/estimate-public');

const recurring = (services) => ({ result: { recurring: { services } } });
const LOW = (annual) => ({ service: 'commercial_lawn', pricingConfidence: 'LOW', annual, estimatedPricing: true });
const MED = (annual) => ({ service: 'commercial_pest', pricingConfidence: 'MEDIUM', annual, estimatedPricing: true });

describe('commercialLowConfidenceRange', () => {
  test('narrow LOW line → ±20% range, not forced to a site quote', () => {
    // $400/mo → 320–480, swing 160 (< 300)
    expect(commercialLowConfidenceRange(recurring([LOW(4800)]))).toEqual({
      hasLowConfidence: true, rangeLowMonthly: 320, rangeHighMonthly: 480, monthlySwing: 160, forceSiteQuote: false,
    });
  });
  test('wide LOW line → force site quote', () => {
    // $1000/mo → 800–1200, swing 400 (> 300)
    expect(commercialLowConfidenceRange(recurring([LOW(12000)]))).toMatchObject({ forceSiteQuote: true });
    expect(commercialLowConfidenceRequiresSiteQuote(recurring([LOW(12000)]))).toBe(true);
  });
  test('MEDIUM lines are exact; only LOW lines get the band', () => {
    // LOW $400 (320–480) + MEDIUM $500 (exact) → 820–980, swing 160
    expect(commercialLowConfidenceRange(recurring([LOW(4800), MED(6000)]))).toMatchObject({
      rangeLowMonthly: 820, rangeHighMonthly: 980, monthlySwing: 160,
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
