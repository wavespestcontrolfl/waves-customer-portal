process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Commercial auto-priced estimates render an APPROVAL card, not the booking
// form: no slot picker, no date finder, no deposit/card. The customer approves
// (pay monthly by invoice) or prepays the year at 5% off; the team confirms
// scope on-site, schedules, and invoices manually. (Regression for the PR bot's
// P1 "commercial estimate has no approval path" + owner directives 2026-06-29:
// no booking form, no auto-schedule, real commercial payment workflow, no
// WaveGuard setup fee, prepay discount is 5%.)

const { renderPage } = require('../routes/estimate-public');

function commercialEstimate(overrides = {}) {
  return {
    id: `estimate-${Math.random().toString(36).slice(2)}`,
    status: 'sent',
    customerName: 'Pelican Bay HOA',
    address: '100 Commerce Way, Bradenton, FL 34203',
    monthlyTotal: 390.75,
    annualTotal: 4689,
    onetimeTotal: 0,
    quoteRequired: false,
    ...overrides,
  };
}

function commercialEstimateData(extra = {}) {
  return {
    commercialEstimatedPricing: true,
    result: {
      recurring: {
        discount: 0,
        annualBeforeDiscount: 4689,
        annualAfterDiscount: 4689,
        services: [{
          name: 'Commercial Lawn Treatment',
          service: 'commercial_lawn',
          mo: 390.75,
          annual: 4689,
          estimatedPricing: true,
          disclaimer: 'Estimated from property data — final price confirmed on site.',
          discountable: false,
          excludeFromPctDiscount: true,
        }],
      },
      oneTime: { items: [], membershipFee: 0 },
    },
    engineResult: {
      lineItems: [{
        service: 'commercial_lawn',
        name: 'Commercial Lawn Treatment',
        monthly: 390.75,
        annual: 4689,
        estimatedPricing: true,
        disclaimer: 'Estimated from property data — final price confirmed on site.',
        discountable: false,
        excludeFromPctDiscount: true,
      }],
    },
    ...extra,
  };
}

describe('commercial auto-priced estimate page is approval-only', () => {
  test('renders the commercial approval card, not the booking/slot form', () => {
    const html = renderPage('commercial-token', commercialEstimate(), commercialEstimateData());
    expect(html).toContain('id="commercial-accept-card"');
    expect(html).toContain('Approve your commercial service');
    expect(html).toContain('Approve &amp; pay monthly');
    // No booking form: the slot mount + date finder are absent.
    expect(html).not.toContain('id="booking-card"');
    expect(html).not.toContain('id="slot-area"');
    expect(html).not.toContain('id="date-finder"');
  });

  test('offers a prepay-the-year option (5% off, no setup fee)', () => {
    const html = renderPage('commercial-token-2', commercialEstimate(), commercialEstimateData());
    expect(html).toContain('id="commercial-prepay-btn"');
    expect(html).toMatch(/Prepay the year/i);
  });

  test('still shows the "estimated — confirmed on site" commercial disclaimer', () => {
    const html = renderPage('commercial-token-3', commercialEstimate(), commercialEstimateData());
    expect(html).toMatch(/confirmed on site/i);
  });

  test('does not present WaveGuard membership branding (non-member commercial plan)', () => {
    const html = renderPage('commercial-token-wg', commercialEstimate(), commercialEstimateData());
    // The hero tier label reads "Commercial", never "WaveGuard Bronze".
    expect(html).toContain('<span class="tier-lbl">Commercial</span>');
    expect(html).not.toContain('WaveGuard Bronze');
    // No WaveGuard members perks block, no WaveGuard tier savings pill.
    expect(html).not.toContain('What WaveGuard members get');
    expect(html).not.toMatch(/with WaveGuard \w/);
  });

  test('an accepted commercial estimate shows the accepted state (no approval card)', () => {
    const html = renderPage('commercial-token-4', commercialEstimate({ status: 'accepted' }), commercialEstimateData());
    expect(html).not.toContain('id="commercial-accept-card"');
  });
});
