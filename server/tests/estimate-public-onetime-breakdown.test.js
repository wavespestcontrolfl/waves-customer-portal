process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const jwt = require('jsonwebtoken');
const config = require('../config');
const {
  buildAcceptNotificationPayload,
  buildAcceptOfficeFallback,
  buildAcceptSuccessPayload,
  acceptanceServiceLists,
  buildEstimateAskQueryLog,
  buildPricingBundle,
  buildWaveGuardIntelligencePayload,
  isEstimateAcceptActive,
  isEstimateAskAnswerable,
  isStructuralOneTimeOnlyEstimate,
  monthlyForRecurringParts,
  normalizeAcceptPaymentMethodPreference,
  normalizeOneTimeBreakdown,
  renderPage,
  resolveAcceptOneTimeTotal,
  resolveRecurringMonthlyParts,
  resolveEstimateDeclineGuard,
  resolveEstimateQuoteRequirement,
  resolveRecurringFirstVisitAmount,
  resolveRecurringFirstVisitAmountFromFrequency,
  shouldApplyFirstViewSideEffects,
  withSupplementedRecurringServices,
} = require('../routes/estimate-public');
const {
  answerEstimateQuestionFallback,
  buildEstimateAssistantContext,
  cleanAssistantAnswer,
} = require('../services/estimate-assistant');

function savedAdminEstimateData() {
  return {
    result: {
      results: {
        pestTiers: [
          { label: 'Quarterly', mo: 50, ann: 600, pa: 150, apps: 4 },
        ],
      },
      recurring: {
        discount: 0,
        monthlyTotal: 50,
        annualAfterDiscount: 600,
        services: [{ name: 'Pest Control', mo: 50 }],
      },
      oneTime: {
        total: 2084,
        membershipFee: 99,
        tmInstall: 240,
        items: [
          { service: 'pest_initial_roach', name: 'Initial Roach Knockdown', price: 119 },
          { service: 'one_time_pest', name: 'One-Time Pest', price: 171, detail: 'Interior + exterior' },
        ],
      },
      specItems: [
        {
          service: 'rodent_sanitation',
          name: 'Rodent Sanitation',
          price: 1555,
          det: 'Heavy - 420 min | 1200 sf affected',
        },
        {
          service: 'rodent_bundle_discount',
          name: 'Rodent Bundle Discount',
          price: -100,
          det: 'Trap sanitation bundle savings',
        },
      ],
    },
  };
}

describe('public estimate one-time breakdown', () => {
  test('public pricing bundle prefers the send snapshot when present', async () => {
    const bundle = await buildPricingBundle({
      id: 'estimate-snapshot',
      estimate_data: {
        sendSnapshot: {
          pricingBundle: {
            frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }],
            waveGuardTier: 'Silver',
            anchorOneTimePrice: 250,
            source: 'send_snapshot_fixture',
          },
        },
        result: {
          recurring: {
            services: [{ name: 'Pest Control', mo: 100 }],
          },
        },
      },
    });

    expect(bundle).toMatchObject({
      snapshotHit: true,
      source: 'send_snapshot_fixture',
      frequencies: [{ key: 'quarterly', monthly: 88 }],
    });
  });

  test('normalizes saved one-time and specialty rows including first-visit roach fees', () => {
    const breakdown = normalizeOneTimeBreakdown(savedAdminEstimateData());

    expect(breakdown.items).toEqual([
      expect.objectContaining({
        service: 'pest_initial_roach',
        label: 'Initial Roach Knockdown',
        amount: 119,
        kind: 'charge',
      }),
      expect.objectContaining({
        service: 'one_time_pest',
        label: 'One-Time Pest',
        amount: 171,
        kind: 'charge',
      }),
      expect.objectContaining({
        service: 'waveguard_setup',
        label: 'WaveGuard setup',
        amount: 99,
        kind: 'charge',
      }),
      expect.objectContaining({
        service: 'termite_bait_installation',
        label: 'Termite bait installation',
        amount: 240,
        kind: 'charge',
      }),
      expect.objectContaining({
        service: 'rodent_sanitation',
        label: 'Rodent Sanitation',
        amount: 1555,
        detail: 'Heavy - 420 min | 1200 sf affected',
      }),
      expect.objectContaining({
        service: 'rodent_bundle_discount',
        label: 'Rodent Bundle Discount',
        amount: -100,
        kind: 'discount',
      }),
    ]);
    expect(breakdown.total).toBe(2084);
  });

  test('reconciles explicit one-time totals when stored rows are incomplete', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: {
          total: 400,
          items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 250 }],
        },
      },
    });

    expect(breakdown.items).toContainEqual(expect.objectContaining({
      service: 'one_time_adjustment',
      label: 'Other one-time services',
      amount: 150,
    }));
    expect(breakdown.total).toBe(400);
  });

  test('does not duplicate termite installation already present in one-time rows', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: {
          total: 500,
          tmInstall: 500,
          items: [{ name: 'Trelona Installation', price: 500, detail: '20 stations' }],
        },
      },
    });

    expect(breakdown.items.filter((item) => item.amount === 500)).toHaveLength(1);
    expect(breakdown.items.some((item) => item.service === 'one_time_adjustment')).toBe(false);
    expect(breakdown.total).toBe(500);
  });

  test('infers roach service key for legacy name-only rows', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: {
          total: 119,
          items: [{ name: 'Initial Roach Knockdown', price: 119 }],
        },
      },
    });

    expect(breakdown.items).toContainEqual(expect.objectContaining({
      service: 'pest_initial_roach',
      label: 'Initial Roach Knockdown',
      amount: 119,
    }));
  });

  test('normalizes nested legacy result one-time rows', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        results: {
          oneTime: {
            total: 325,
            items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 200 }],
            specItems: [{ service: 'stinging_insect', name: 'Stinging Insect', price: 125 }],
          },
        },
      },
    });

    expect(breakdown.items).toEqual([
      expect.objectContaining({ service: 'one_time_pest', amount: 200 }),
      expect.objectContaining({ service: 'stinging_insect', amount: 125 }),
    ]);
    expect(breakdown.total).toBe(325);
  });

  test('normalizes engineResult-only one-time line items', () => {
    const breakdown = normalizeOneTimeBreakdown({
      engineResult: {
        lineItems: [
          { service: 'pest_control', label: 'Pest Control', annual: 600 },
          { service: 'one_time_pest', label: 'One-Time Pest', priceAfterDiscount: 149 },
          { service: 'rodent_sanitation', label: 'Rodent Sanitation', totalAfterDiscount: 425 },
          {
            service: 'rodent_bundle_discount',
            label: 'Rodent Bundle Discount',
            price: -75,
            priceAfterDiscount: 0,
          },
        ],
      },
    });

    expect(breakdown.items).toEqual([
      expect.objectContaining({ service: 'one_time_pest', amount: 149 }),
      expect.objectContaining({ service: 'rodent_sanitation', amount: 425 }),
      expect.objectContaining({ service: 'rodent_bundle_discount', amount: -75, kind: 'discount' }),
    ]);
    expect(breakdown.total).toBe(499);
  });

  test('uses nonzero discounted negative line item amounts', () => {
    const breakdown = normalizeOneTimeBreakdown({
      engineResult: {
        lineItems: [
          {
            service: 'rodent_bundle_discount',
            label: 'Rodent Bundle Discount',
            price: -100,
            priceAfterDiscount: -85,
          },
        ],
      },
    });

    expect(breakdown.items).toContainEqual(expect.objectContaining({
      service: 'rodent_bundle_discount',
      amount: -85,
      kind: 'discount',
    }));
    expect(breakdown.total).toBe(-85);
  });

  test('filters specialty rows that are included on a recurring program', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: { total: 125 },
        specItems: [
          { service: 'stinging_insect', name: 'Wasp/Bee', price: 100, onProg: true },
          { service: 'flea_package', name: 'Flea Package', price: 125, onProg: false },
        ],
      },
    });

    expect(breakdown.items).toEqual([
      expect.objectContaining({ service: 'flea_package', amount: 125 }),
    ]);
    expect(breakdown.total).toBe(125);
  });

  test('normalizes engine line-item installation charges', () => {
    const breakdown = normalizeOneTimeBreakdown({
      engineResult: {
        lineItems: [
          {
            service: 'termite_bait',
            name: 'Termite Bait',
            annual: 420,
            installation: { price: 611 },
            stations: 22,
          },
        ],
      },
    });

    expect(breakdown.items).toContainEqual(expect.objectContaining({
      service: 'termite_bait_installation',
      label: 'Termite Bait installation',
      amount: 611,
      detail: '22 stations',
    }));
    expect(breakdown.total).toBe(611);
  });

  test('includes the breakdown in the public pricing bundle for saved admin estimates', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-onetime-breakdown-test',
      estimate_data: savedAdminEstimateData(),
      onetime_total: 2084,
      waveguard_tier: 'Bronze',
    });

    expect(payload.source).toBe('v1_engine_shape');
    expect(payload.anchorOneTimePrice).toBe(2084);
    expect(payload.firstVisitFees).toContainEqual(expect.objectContaining({
      service: 'pest_initial_roach',
      label: 'Initial Roach Knockdown',
      amount: 119,
      waivedWithPrepay: false,
    }));
    expect(payload.firstVisitFees).toContainEqual(expect.objectContaining({
      service: 'waveguard_setup',
      label: 'WaveGuard setup',
      amount: 99,
      waivedWithPrepay: true,
    }));
    expect(payload.oneTimeBreakdown.items).toContainEqual(expect.objectContaining({
      service: 'rodent_sanitation',
      label: 'Rodent Sanitation',
      amount: 1555,
    }));
    expect(payload.oneTimeBreakdown.items).toContainEqual(expect.objectContaining({
      service: 'pest_initial_roach',
      label: 'Initial Roach Knockdown',
      amount: 119,
    }));
  });

  test('classifies fallback-saved native roach initial by service key', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-native-roach-service-key-test',
      estimate_data: {
        result: {
          results: {
            pestTiers: [{ label: 'Quarterly', mo: 39.67, ann: 476, pa: 119, apps: 4 }],
          },
          recurring: {
            discount: 0,
            monthlyTotal: 39.67,
            annualAfterDiscount: 476,
            services: [{ name: 'Pest Control', mo: 39.67 }],
          },
          oneTime: {
            total: 238,
            membershipFee: 99,
            tmInstall: 0,
            items: [{
              service: 'pest_initial_roach',
              name: 'Initial Native Roach Knockdown',
              price: 139,
              noRecurringDiscount: true,
            }],
          },
        },
      },
      onetime_total: 238,
      waveguard_tier: 'Bronze',
    });

    expect(payload.firstVisitFees).toContainEqual(expect.objectContaining({
      service: 'pest_initial_roach',
      label: 'Initial Native Roach Knockdown',
      amount: 139,
      waivedWithPrepay: false,
    }));
    expect(payload.firstVisitFees).toContainEqual(expect.objectContaining({
      service: 'waveguard_setup',
      amount: 99,
      waivedWithPrepay: true,
    }));
  });

  test('builds breakdown from generated engine results when only engine inputs are saved', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-engine-generated-breakdown-test',
      estimate_data: {
        engineInputs: {
          propertyType: 'single_family',
          homeSqFt: 1800,
          lotSqFt: 7000,
          stories: 1,
          serviceZone: 'A',
          nearWater: 'NO',
          features: {},
          services: {
            oneTimePest: { urgency: 'NONE', afterHours: false },
          },
        },
      },
      onetime_total: 0,
      waveguard_tier: 'Bronze',
    });

    expect(payload.source).toBe('engine_invocation');
    expect(payload.anchorOneTimePrice).toBeGreaterThan(0);
    expect(payload.oneTimeBreakdown.items).toContainEqual(expect.objectContaining({
      service: 'one_time_pest',
      amount: payload.anchorOneTimePrice,
    }));
    expect(payload.oneTimeBreakdown.total).toBe(payload.anchorOneTimePrice);
  });

  test('detects nested legacy one-time-only estimates for acceptance flow', () => {
    const oneTimeOnly = {
      result: {
        results: {
          oneTime: {
            total: 200,
            items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 200 }],
          },
        },
      },
    };

    expect(isStructuralOneTimeOnlyEstimate(oneTimeOnly, { monthly_total: 0, annual_total: 0 })).toBe(true);
  });

  test('does not treat recurring estimates with first-visit fees as one-time-only', () => {
    expect(isStructuralOneTimeOnlyEstimate(savedAdminEstimateData(), {
      monthly_total: 50,
      annual_total: 600,
    })).toBe(false);
  });

  test('detects top-level specialty-only estimates as one-time-only', () => {
    const specialtyOnly = {
      result: {
        specItems: [{ service: 'rodent_sanitation', name: 'Rodent Sanitation', price: 650 }],
      },
    };

    expect(isStructuralOneTimeOnlyEstimate(specialtyOnly, { monthly_total: 0, annual_total: 0 })).toBe(true);
  });

  test('acceptance one-time total prefers live pricing over stale stored totals', () => {
    expect(resolveAcceptOneTimeTotal(
      { onetime_total: 0 },
      { anchorOneTimePrice: 249, oneTimeBreakdown: { total: 249 } },
    )).toBe(249);
  });

  test('acceptance one-time total falls back to breakdown and stored amount', () => {
    expect(resolveAcceptOneTimeTotal(
      { onetime_total: 199 },
      { anchorOneTimePrice: null, oneTimeBreakdown: { total: 275 } },
    )).toBe(275);

    expect(resolveAcceptOneTimeTotal(
      { onetime_total: 199 },
      { anchorOneTimePrice: null, oneTimeBreakdown: { total: 0 } },
    )).toBe(199);
  });

  test('quote-required one-time rows block public acceptance', async () => {
    const estimateData = {
      result: {
        oneTime: {
          total: 0,
          specItems: [{
            service: 'bed_bug',
            name: 'Bed Bug Chemical/IPM Program - Quote Required',
            price: null,
            quoteRequired: true,
            reason: 'SEVERE_INFESTATION',
          }],
        },
      },
    };

    const breakdown = normalizeOneTimeBreakdown(estimateData);
    expect(breakdown.total).toBe(0);
    expect(breakdown.quoteRequired).toBe(true);

    const payload = await buildPricingBundle({
      id: 'estimate-public-quote-required-test',
      estimate_data: estimateData,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
    });

    expect(payload.quoteRequired).toBe(true);
    expect(resolveEstimateQuoteRequirement(payload)).toEqual(expect.objectContaining({
      quoteRequired: true,
      reason: 'SEVERE_INFESTATION',
    }));
  });

  test('server-rendered quote-required page suppresses normal lock-in copy', () => {
    const html = renderPage('quote-token', {
      status: 'quote_required',
      quoteRequired: true,
      customerName: 'Pat Customer',
      address: '123 Main St',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 0,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: { items: [], specItems: [] },
        specItems: [],
      },
    });

    expect(html).toContain('Inspection required to finish this quote');
    expect(html).not.toContain('Ready to lock in');
    expect(html).not.toContain('class="cta pick-time-cta"');
    expect(html).not.toContain('id="booking-card"');
  });

  test('server-rendered booking review buttons use explicit click listeners', () => {
    const html = renderPage('booking-token', {
      status: 'sent',
      customerName: 'Pat Customer',
      address: '123 Main St',
      monthlyTotal: 50,
      annualTotal: 600,
      onetimeTotal: 0,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [{ name: 'Pest Control', mo: 50 }] },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: { pest: { apps: 4 } },
      },
    });

    expect(html).toContain('id="confirm-book-btn"');
    expect(html).toContain('id="change-booking-pick-btn"');
    expect(html).not.toContain('id="confirm-book-btn" onclick=');
    expect(html).not.toContain('onclick="cancelReservation()"');
    expect(html).toContain("confirmBookBtn.addEventListener('click', confirmBooking)");
    expect(html).toContain("changeBookingPickBtn.addEventListener('click', cancelReservation)");
  });

  test('server-rendered recurring estimates wait for payment setup before showing slots', () => {
    const html = renderPage('booking-token', {
      status: 'sent',
      customerName: 'Pat Customer',
      address: '123 Main St',
      monthlyTotal: 50,
      annualTotal: 600,
      onetimeTotal: 0,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [{ name: 'Pest Control', mo: 50 }] },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: { pest: { apps: 4 } },
      },
    });

    expect(html).toContain('id="payment-setup-card"');
    expect(html).toContain('Choose pay-after-visit setup');
    expect(html).toContain('Choose annual prepay setup');
    expect(html).toContain('<section class="card booking-card" id="booking-card" style="display:none">');
    expect(html).toContain('const REQUIRE_PAYMENT_SETUP_BEFORE_SLOTS = true;');
    expect(html).toContain('function bookingRequiresPaymentSetup()');
    expect(html).toContain('isReserving: false');
    expect(html).toContain('btn.disabled = bookingState.isReserving || !!bookingState.reservation');
    expect(html).toContain('bookingState.isReserving = true;');
    expect(html).toContain("if (document.getElementById('booking-card') && !bookingRequiresPaymentSetup())");
    expect(html).toContain("toast('Choose a payment setup first.')");
  });

  test('builds Waves AI payload from estimate property signals', () => {
    const payload = buildWaveGuardIntelligencePayload({
      satelliteUrl: 'https://maps.example/satellite.png',
      tier: 'Silver',
    }, {
      inputs: {
        homeSqFt: 2400,
        lotSqFt: 9000,
        lawnSqFt: 5200,
        landscapeComplexity: 'MODERATE',
      },
      result: {
        recurring: {
          services: [
            { name: 'Pest Control' },
            { name: 'Lawn Care' },
          ],
        },
      },
    });

    expect(payload.eyebrow).toBe('Waves AI');
    expect(payload.title).toContain('Waves AI reviewed your property');
    expect(payload.satelliteUrl).toBe('https://maps.example/satellite.png');
    expect(payload.metrics).toEqual(expect.arrayContaining([
      { label: 'Home', value: '2,400 sq ft' },
      { label: 'Lot', value: '9,000 sq ft' },
      { label: 'Treatable lawn', value: '5,200 sq ft' },
      { label: 'Complexity', value: 'Moderate' },
    ]));
    expect(payload.signals).toEqual([]);
  });

  test('Waves AI payload does not add customer-facing bundle copy for Bronze', () => {
    const payload = buildWaveGuardIntelligencePayload({
      tier: 'Bronze',
    }, {
      result: {
        recurring: {
          services: [{ name: 'Pest Control' }],
        },
      },
    });

    expect(payload.signals).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('bundle discount');
  });

  test('server-rendered estimates show the Waves AI feature', () => {
    const html = renderPage('intelligence-token', {
      id: 'estimate-waves-ai-test',
      status: 'sent',
      customerName: 'Pat Customer',
      address: '123 Main St',
      monthlyTotal: 50,
      annualTotal: 600,
      onetimeTotal: 0,
      tier: 'Silver',
      satelliteUrl: 'https://maps.example/satellite.png',
    }, {
      inputs: {
        homeSqFt: 1800,
        lotSqFt: 7000,
        landscapeComplexity: 'SIMPLE',
      },
      result: {
        recurring: { services: [{ name: 'Pest Control', mo: 50 }] },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: { pest: { apps: 4 } },
      },
    });

    expect(html).toContain('Waves AI');
    expect(html).toContain('Waves AI reviewed your property before pricing this estimate');
    expect(html).toContain('id="estimate-ask-form"');
    expect(html).toContain('Ask Waves AI');
    expect(html).toContain('/api/public/estimates/');
    expect(html).toContain('/ask');
    expect(html).toContain('ESTIMATE_ASK_TOKEN');
    expect(html).toContain('X-Estimate-Ask-Token');
    expect(html).not.toContain('class="intelligence-badge"');
    expect(html).toContain('Satellite view of 123 Main St');
    expect(html).toContain('1,800 sq ft');
    expect(html).toContain('<h2 data-mode-only="recurring">Go Waves! Wave Goodbye to Pests!</h2>');
    expect(html).not.toContain('No surprise increases, no hidden fees.');
    expect(html).not.toContain('cadence and visit counts');
    expect(html).not.toContain('Your technician verifies measurements');
    expect(html).not.toContain('class="waves-intelligence"');

    const acceptedHtml = renderPage('accepted-intelligence-token', {
      id: 'accepted-estimate-waves-ai-test',
      status: 'accepted',
      customerName: 'Pat Customer',
      address: '123 Main St',
      monthlyTotal: 50,
      annualTotal: 600,
      onetimeTotal: 0,
      tier: 'Silver',
    }, {
      result: {
        recurring: { services: [{ name: 'Pest Control', mo: 50 }] },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: { pest: { apps: 4 } },
      },
    });
    expect(acceptedHtml).not.toContain('id="estimate-ask-form"');
    expect(acceptedHtml).not.toContain('Ask Waves AI');
  });

  test('estimate assistant fallback answers included service questions from estimate context', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        address: '4407 Lake Fox Pl',
        waveguard_tier: 'Silver',
      },
      estData: {
        result: {
          recurring: {
            services: [
              { name: 'Pest Control', mo: 128 },
              { name: 'Lawn Care', mo: 87, perTreatment: 116, visitsPerYear: 9 },
            ],
          },
        },
      },
      pricingBundle: {
        waveGuardTier: 'Silver',
        frequencies: [{
          key: 'quarterly',
          label: 'Quarterly',
          monthly: 116.7,
          annual: 1400.4,
          included: [
            { label: 'Pest Control' },
            { label: 'Lawn Care' },
          ],
          perServiceTreatments: [
            { service: 'pest_control', label: 'Pest Control', perTreatment: 115.2, visitsPerYear: 4 },
            { service: 'lawn_care', label: 'Lawn Care', perTreatment: 104.4, visitsPerYear: 9 },
          ],
        }],
      },
    });
    const answer = answerEstimateQuestionFallback('What is included?', context);

    expect(answer).toContain('Silver');
    expect(answer).toContain('Pest Control');
    expect(answer).toContain('Lawn Care');
    expect(answer).toContain('$350.10 / quarter');
  });

  test('estimate assistant uses customer-facing discounted per-application prices', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Silver',
        monthly_total: 116.7,
        annual_total: 1400.4,
      },
      pricingBundle: {
        waveGuardTier: 'Silver',
        frequencies: [{
          key: 'quarterly',
          label: 'Quarterly',
          monthly: 116.7,
          annual: 1400.4,
          included: [{ label: 'Pest Control' }, { label: 'Lawn Care' }],
          perServiceTreatments: [
            { service: 'pest_control', label: 'Pest Control', perTreatment: 128, visitsPerYear: 4 },
            { service: 'lawn_care', label: 'Lawn Care', perTreatment: 116, visitsPerYear: 9 },
          ],
        }],
      },
    });

    const included = answerEstimateQuestionFallback('What is included?', context);

    expect(included).toContain('Pest Control - 4 applications/year - $115.20 per application');
    expect(included).toContain('Lawn Care - 9 applications/year - $104.40 per application');
    expect(included).not.toContain('$128 per application');
    expect(included).not.toContain('$116 per application');
  });

  test('estimate assistant discounts treatment rows when another recurring service lacks treatment detail', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Gold',
        monthly_total: 139.97,
        annual_total: 1679.6,
      },
      pricingBundle: {
        source: 'v1_engine_shape',
        waveGuardTier: 'Gold',
        frequencies: [{
          key: 'quarterly',
          label: 'Quarterly',
          monthly: 139.97,
          annual: 1679.6,
          included: [{ label: 'Pest Control' }, { label: 'Lawn Care' }, { label: 'Termite Bait' }],
          perServiceTreatments: [
            { service: 'pest_control', label: 'Pest Control', perTreatment: 128, visitsPerYear: 4 },
            { service: 'lawn_care', label: 'Lawn Care', perTreatment: 116, visitsPerYear: 9 },
            { service: 'termite_bait', label: 'Termite Bait', perTreatment: null, visitsPerYear: null },
          ],
        }],
      },
    });

    const included = answerEstimateQuestionFallback('What is included?', context);

    expect(included).toContain('Pest Control - 4 applications/year - $108.80 per application');
    expect(included).toContain('Lawn Care - 9 applications/year - $98.60 per application');
    expect(included).toContain('Termite Service');
    expect(included).not.toContain('$128 per application');
    expect(included).not.toContain('$116 per application');
  });

  test('estimate assistant strips markdown from AI answers before rendering', () => {
    expect(cleanAssistantAnswer('Your **WaveGuard Silver** plan includes:\n- **Lawn Care** at `$104.40` per app.'))
      .toBe('Your WaveGuard Silver plan includes: Lawn Care at $104.40 per app.');
  });

  test('estimate assistant uses selected cadence and all first-visit fees', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        address: '4407 Lake Fox Pl',
        waveguard_tier: 'Silver',
        monthly_total: 122,
        annual_total: 1464,
      },
      estData: {
        result: {
          recurring: {
            services: [{ name: 'Pest Control', mo: 122 }],
          },
        },
      },
      pricingBundle: {
        waveGuardTier: 'Silver',
        frequencies: [
          { key: 'quarterly', label: 'Quarterly', monthly: 116.7, annual: 1400.4 },
          { key: 'bi_monthly', label: 'Bi-monthly', monthly: 122, annual: 1464 },
          { key: 'monthly', label: 'Monthly', monthly: 130, annual: 1560 },
        ],
        firstVisitFees: [
          { service: 'waveguard_setup', label: 'WaveGuard setup', amount: 99, waivedWithPrepay: true },
          { service: 'pest_initial_roach', label: 'Initial Roach Knockdown', amount: 119 },
        ],
      },
    });
    const answer = answerEstimateQuestionFallback('How does billing work?', context);

    expect(context.billing.amountText).toBe('$244 / bi-monthly visit');
    expect(context.firstVisitFees).toHaveLength(2);
    expect(answer).toContain('$244 / bi-monthly visit');
    expect(answer).toContain('WaveGuard setup is $99');
    expect(answer).toContain('Initial Roach Knockdown is $119');
  });

  test('estimate assistant honors the currently selected pricing state', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Silver',
        monthly_total: 116.7,
        annual_total: 1400.4,
      },
      pricingBundle: {
        waveGuardTier: 'Silver',
        frequencies: [
          { key: 'quarterly', label: 'Quarterly', monthly: 116.7, annual: 1400.4 },
          { key: 'monthly', label: 'Monthly', monthly: 130, annual: 1560 },
        ],
      },
      selectedFrequency: 'monthly',
      serviceMode: 'recurring',
    });

    expect(context.billing.amountText).toBe('$130 / month');
  });

  test('estimate assistant includes one-time service line items', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Bronze',
        onetime_total: 350,
      },
      estData: {
        result: {
          oneTime: {
            items: [{ service: 'termite', name: 'Termite Inspection', price: 350 }],
          },
        },
      },
      pricingBundle: {
        anchorOneTimePrice: 350,
        firstVisitFees: [
          { service: 'waveguard_setup', label: 'WaveGuard setup', amount: 99, waivedWithPrepay: true },
        ],
        oneTimeBreakdown: {
          total: 350,
          items: [{ service: 'termite', label: 'Termite Inspection', amount: 350 }],
        },
        frequencies: [],
      },
      serviceMode: 'one_time',
    });
    const included = answerEstimateQuestionFallback('What is included?', context);
    const billing = answerEstimateQuestionFallback('How does billing work?', context);

    expect(included).toContain('Termite Inspection');
    expect(included).not.toContain('I do not see a detailed service list');
    expect(billing).toContain('The one-time estimate is $350.');
    expect(billing).not.toContain('WaveGuard setup');
    expect(billing).not.toContain('12-month');

    const guarantee = answerEstimateQuestionFallback('Is there a callback guarantee?', context);
    expect(guarantee).toContain('one-time service');
    expect(guarantee).toContain('30-day callback');
    expect(guarantee).not.toContain('90-day');
  });

  test('estimate assistant uses invoice-mode billing copy', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Silver',
        monthly_total: 116.7,
        annual_total: 1400.4,
        bill_by_invoice: true,
      },
      pricingBundle: {
        waveGuardTier: 'Silver',
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 116.7, annual: 1400.4 }],
      },
    });
    const billing = answerEstimateQuestionFallback('How does billing work?', context);

    expect(context.billing.invoiceMode).toBe(true);
    expect(context.billing.billedAfterVisit).toBe(false);
    expect(billing).toContain('invoice due immediately for $350.10');
    expect(billing).toContain('payment link');
    expect(billing).not.toContain('billed after completed service visits');
    expect(billing).not.toContain('12-month');
  });

  test('estimate assistant suppresses normal billing for quote-required estimates', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Silver',
        monthly_total: 116.7,
        annual_total: 1400.4,
      },
      pricingBundle: {
        quoteRequired: true,
        waveGuardTier: 'Silver',
        anchorOneTimePrice: 350,
        oneTimeBreakdown: {
          total: 350,
          quoteRequired: true,
          items: [{ service: 'bed_bug', label: 'Bed Bug Treatment', quoteRequired: true }],
        },
        frequencies: [{
          key: 'quarterly',
          label: 'Quarterly',
          monthly: 116.7,
          annual: 1400.4,
          included: [{ label: 'Pest Control' }],
          perServiceTreatments: [
            { service: 'pest_control', label: 'Pest Control', perTreatment: 115.2, visitsPerYear: 4 },
          ],
        }],
      },
    });
    const billing = answerEstimateQuestionFallback('How does billing work?', context);

    expect(context.billing.quoteRequired).toBe(true);
    expect(context.billing.amount).toBeNull();
    expect(context.billing.amountText).toBeNull();
    expect(context.billing.period).toBeNull();
    expect(context.billing.billedAfterVisit).toBe(false);
    expect(context.services[0].perApplication).toBeNull();
    expect(context.services[0].summary).not.toContain('$115.20');
    expect(context.oneTime).toBeNull();
    expect(billing).toContain('needs an inspection');
    expect(billing).not.toContain('$350.10 / quarter');
    expect(billing).not.toContain('billed after completed service visits');
  });

  test('estimate assistant hides one-time context when the estimate does not offer it', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Silver',
        monthly_total: 100,
        annual_total: 1200,
        onetime_total: 350,
        show_one_time_option: false,
      },
      estData: {
        result: {
          recurring: { services: [{ name: 'Pest Control', mo: 100 }] },
          oneTime: { items: [{ service: 'termite', name: 'Termite Inspection', price: 350 }] },
        },
      },
      pricingBundle: {
        anchorOneTimePrice: 350,
        oneTimeBreakdown: {
          total: 350,
          items: [{ service: 'termite', label: 'Termite Inspection', amount: 350 }],
        },
        frequencies: [{ key: 'monthly', label: 'Monthly', monthly: 100, annual: 1200 }],
      },
      serviceMode: 'one_time',
    });
    const included = answerEstimateQuestionFallback('What is included?', context);
    const billing = answerEstimateQuestionFallback('How does billing work?', context);

    expect(context.serviceMode).toBe('recurring');
    expect(context.oneTime).toBeNull();
    expect(included).toContain('Pest Control');
    expect(included).not.toContain('Termite Inspection');
    expect(billing).not.toContain('one-time estimate');
    expect(billing).not.toContain('$350');
  });

  test('estimate assistant treats placeholder recurring frequencies as one-time-only', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Bronze',
        monthly_total: 0,
        annual_total: 0,
        onetime_total: 650,
        show_one_time_option: false,
      },
      estData: {
        result: {
          specItems: [{ service: 'rodent_sanitation', name: 'Rodent Sanitation', price: 650 }],
        },
      },
      pricingBundle: {
        waveGuardTier: 'Bronze',
        anchorOneTimePrice: 650,
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: null, annual: null, included: [] }],
        oneTimeBreakdown: {
          total: 650,
          items: [{ service: 'rodent_sanitation', label: 'Rodent Sanitation', amount: 650 }],
        },
      },
      serviceMode: 'recurring',
    });
    const billing = answerEstimateQuestionFallback('How does billing work?', context);

    expect(context.serviceMode).toBe('one_time');
    expect(context.billing.amountText).toBe('$650');
    expect(context.billing.period).toBe('one-time');
    expect(billing).toContain('The one-time estimate is $650.');
    expect(billing).not.toContain('billed after completed service visits');
  });

  test('estimate assistant filters discount rows from fallback one-time services', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Bronze',
        onetime_total: 300,
      },
      estData: {
        result: {
          oneTime: {
            items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 400 }],
          },
          specItems: [{ service: 'rodent_bundle_discount', name: 'Rodent Bundle Discount', price: -100, det: 'bundle savings' }],
        },
      },
      pricingBundle: {
        waveGuardTier: 'Bronze',
        anchorOneTimePrice: 300,
        frequencies: [],
      },
      serviceMode: 'one_time',
    });
    const included = answerEstimateQuestionFallback('What is included?', context);

    expect(context.serviceMode).toBe('one_time');
    expect(included).toContain('One-Time Pest');
    expect(included).toContain('The one-time estimate is $300.');
    expect(included).not.toContain('Rodent Bundle Discount');
    expect(included).not.toContain('bundle savings');
  });

  test('estimate assistant does not re-add services filtered out of the pricing bundle', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Silver',
        show_one_time_option: true,
      },
      estData: {
        result: {
          recurring: {
            services: [
              { name: 'Pest Control', mo: 100 },
              { name: 'Lawn Care', mo: 80 },
            ],
          },
        },
      },
      pricingBundle: {
        waveGuardTier: 'Silver',
        anchorOneTimePrice: 200,
        frequencies: [{
          key: 'quarterly',
          label: 'Quarterly',
          monthly: 90,
          annual: 1080,
          included: [{ label: 'Pest Control' }],
          perServiceTreatments: [
            { service: 'pest_control', label: 'Pest Control', perTreatment: 90, visitsPerYear: 4 },
          ],
        }],
      },
    });
    const included = answerEstimateQuestionFallback('What is included?', context);

    expect(included).toContain('Pest Control');
    expect(included).not.toContain('Lawn Care');
  });

  test('estimate assistant routes booking-service fallback questions to scheduling guidance', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Silver',
        monthly_total: 116.7,
        annual_total: 1400.4,
      },
      pricingBundle: {
        waveGuardTier: 'Silver',
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 116.7, annual: 1400.4 }],
      },
    });
    const answer = answerEstimateQuestionFallback('Can I book service?', context);

    expect(answer).toContain('Pick one of the available times');
    expect(answer).not.toContain('This WaveGuard Silver estimate includes');
  });

  test('estimate assistant one-time mode suppresses recurring billing copy', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Bronze',
        show_one_time_option: true,
        onetime_total: 350,
      },
      pricingBundle: {
        anchorOneTimePrice: 350,
        frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 100, annual: 1200 }],
        oneTimeBreakdown: {
          total: 350,
          items: [{ service: 'pest_control', label: 'One-Time Pest Control', amount: 350 }],
        },
      },
      serviceMode: 'one_time',
    });
    const included = answerEstimateQuestionFallback('What is included?', context);

    expect(context.serviceMode).toBe('one_time');
    expect(context.billing.amountText).toBe('$350');
    expect(context.billing.period).toBe('one-time');
    expect(context.billing.monthlyText).toBeNull();
    expect(context.billing.annualText).toBeNull();
    expect(included).toContain('One-Time Pest Control');
    expect(included).toContain('The one-time estimate is $350.');
    expect(included).not.toContain('recurring estimate');
    expect(included).not.toContain('$300 / quarter');
  });

  test('recurring first-visit amount uses per-application service pricing', () => {
    const amount = resolveRecurringFirstVisitAmount([
      { name: 'Pest Control', mo: 128 },
      { name: 'Lawn Care', mo: 87, perTreatment: 116, visitsPerYear: 9 },
    ], {
      tierDiscount: 0.1,
      pestRecurring: { monthlyBase: 128, visitsPerYear: 4 },
      estData: {
        result: {
          results: {
            pest: { apps: 4 },
            pestTiers: [{ label: 'Quarterly', mo: 128, pa: 128, apps: 4 }],
          },
        },
      },
    });

    expect(amount).toBe(219.6);
  });

  test('recurring first-visit amount can come from the selected frequency', () => {
    const frequency = {
      key: 'monthly',
      perServiceTreatments: [
        { service: 'pest_control', displayPrice: 74.4, perTreatment: 95, visitsPerYear: 12 },
        { service: 'lawn_care', displayPrice: 104.4, perTreatment: 116 },
      ],
    };
    const amount = resolveRecurringFirstVisitAmountFromFrequency(frequency);
    const amountWithPrefs = resolveRecurringFirstVisitAmountFromFrequency(frequency, { prefMonthlyOff: 20 });

    expect(amount).toBe(178.8);
    expect(amountWithPrefs).toBe(158.8);
  });

  test('server-rendered bundled estimate showcases per-application prices by service', () => {
    const html = renderPage('bundle-token', {
      status: 'sent',
      customerName: 'Stan Customer',
      address: '4407 Lake Fox Pl',
      monthlyTotal: 116.7,
      annualTotal: 1400.4,
      onetimeTotal: 0,
      tier: 'Silver',
    }, {
      result: {
        recurring: {
          services: [
            { name: 'Pest Control', mo: 128 },
            { name: 'Lawn Care', mo: 87, perTreatment: 116, visitsPerYear: 9 },
          ],
        },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: {
          pest: { apps: 4 },
          pestTiers: [{ label: 'Quarterly', mo: 128, pa: 128, apps: 4 }],
        },
      },
    });

    expect(html).toContain('class="service-price-list"');
    expect(html).toContain('class="service-price-name">Pest Control</div>');
    expect(html).toContain('class="service-price-name">Lawn Care</div>');
    expect(html).toContain('4 applications/year');
    expect(html).not.toContain('Quarterly service &middot; 4 applications/year');
    expect(html).toContain('9 applications/year');
    expect(html).toContain('$128 / application</span>');
    expect(html).toContain('$116 / application</span>');
    expect(html).toContain('$115.20</span>');
    expect(html).toContain('$104.40</span>');
    expect(html).toContain('<div class="payment-summary-row"><span>First service visit</span><strong data-first-visit-total>$219.60</strong></div>');
    expect(html).toContain('let firstVisitTotal = 0;');
    expect(html).toContain('.payment-summary-row strong{font-size:14px;line-height:1.2;font-weight:800;color:#1B2C5B;text-align:right;white-space:nowrap}');
    expect(html).not.toContain('.payment-summary-row.total strong');
    expect(html).toContain('You save <span data-service-card-savings data-service-kind="pest" data-service-visits="4" data-service-base-price="115.2" data-service-anchor-price="128">$12.80</span> / application with WaveGuard Silver');
    expect(html).toContain('You save <span data-service-card-savings data-service-kind="lawn" data-service-visits="9" data-service-base-price="104.4" data-service-anchor-price="116">$11.60</span> / application with WaveGuard Silver');
    expect(html).toContain('That’s just <span data-service-card-day data-service-kind="pest" data-service-visits="4" data-service-base-price="115.2">$1.28</span>/day for pest control.');
    expect(html).toContain('That’s just <span data-service-card-day data-service-kind="lawn" data-service-visits="9" data-service-base-price="104.4">$2.61</span>/day for lawn care.');
    expect(html).not.toContain('Exterior perimeter protection around entry-prone areas');
    expect(html).not.toContain('Interior service support when activity is reported');
    expect(html).not.toContain('Free re-service between recurring visits');
    expect(html).not.toContain('90-day WaveGuard money-back guarantee');
    expect(html).not.toContain('<ul class="service-inclusions">');
    expect(html).not.toContain('id="monthly-display"');
    expect(html).not.toContain('/ treatment</span>');
  });

  test('server-rendered lawn-only estimate uses lawn-specific desktop copy', () => {
    const html = renderPage('lawn-only-token', {
      status: 'sent',
      customerName: 'Jane Customer',
      address: '6539 Field Sparrow Gln',
      monthlyTotal: 55,
      annualTotal: 660,
      onetimeTotal: 0,
      tier: 'Bronze',
      satelliteUrl: 'https://maps.example/lawn.png',
    }, {
      inputs: {
        homeSqFt: 2070,
        lotSqFt: 7326,
        lawnSqFt: 3200,
        landscapeComplexity: 'SIMPLE',
      },
      result: {
        recurring: {
          services: [
            { name: 'Lawn Care', mo: 55, perTreatment: 73.33, visitsPerYear: 9 },
          ],
        },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: {
          lawn: [{ recommended: true, v: 9 }],
        },
      },
    });

    expect(html).toContain('your lawn care estimate');
    expect(html).toContain('Waves AI reviewed your lawn before pricing this estimate');
    expect(html).toContain('Choose how to start your lawn care plan');
    expect(html).toContain('Pick your first lawn care visit');
    expect(html).toContain('What your lawn care plan includes');
    expect(html).toContain('Ready to start lawn care?');
    expect(html).toContain('Let&#39;s get your lawn on the schedule.');
    expect(html).toContain('Confirm and set up billing');
    expect(html).toContain('next step saves your card for pay-after-visit billing');
    expect(html).toContain('/day to stop lawn pests before they turn green grass brown.');
    expect(html).not.toContain('/day for lawn care.');
    expect(html).not.toContain('Seasonal turf treatments matched to the lawn program');
    expect(html).not.toContain('Weed, fungus, chinch, and turf-stress observations');
    expect(html).not.toContain('Treatment timing adjusted for Southwest Florida conditions');
    expect(html).not.toContain('Lawn notes carried forward for future visits');
    expect(html.match(/WaveGuard Membership Setup/g)).toHaveLength(2);
    expect(html).toContain('Pay the 12-month plan in full');
    expect(html).toContain('The WaveGuard Membership is included with the 12-month plan invoice.');
    expect(html).toContain('data-prepay-membership-due="99">$759</strong>');
    expect(html).not.toContain('Annual Pay-in-Full Waiver');
    expect(html).toContain('.q-bar{display:none}');
    expect(html).not.toContain('Wave Goodbye to Pests!');
    expect(html).not.toContain('90-day money-back guarantee');
    expect(html).not.toContain('Free annual termite inspection');
    expect(html).not.toContain('What WaveGuard members get');
  });

  test('server-rendered estimate promotes separate palm and rodent bait recurring services', () => {
    const html = renderPage('separate-recurring-token', {
      status: 'sent',
      customerName: 'Rita Customer',
      address: '123 Palm Row',
      monthlyTotal: 149,
      annualTotal: 1788,
      onetimeTotal: 0,
      tier: 'Silver',
    }, {
      result: {
        recurring: {
          palmInjectionMo: 55,
          palmInjectionAnn: 660,
          rodentBaitMo: 49,
          services: [
            { name: 'Pest Control', mo: 50 },
          ],
        },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: {
          pest: { apps: 4 },
          pestTiers: [{ label: 'Quarterly', mo: 50, ann: 600, pa: 150, apps: 4 }],
          injection: {
            treatmentLabel: 'Nutrition + Insecticide',
            appsPerYear: 2,
            annualAfterCredits: 660,
            monthlyAfterCredits: 55,
            detail: '2 palms x $165 x 2/yr',
          },
          rodBaitSize: 'Medium',
        },
      },
    });

    expect(html).toContain('class="service-price-list"');
    expect(html).toContain('class="service-price-name">Pest Control</div>');
    expect(html).toContain('class="service-price-name">Palm Injection</div>');
    expect(html).toContain('class="service-price-name">Rodent Bait Stations</div>');
    expect(html).toContain('Nutrition + Insecticide &middot; 2 applications/year');
    expect(html).toContain('Quarterly monitoring &middot; 4 applications/year');
    expect(html).toContain('$135</span>');
    expect(html).toContain('$330</span>');
    expect(html).toContain('$147</span>');
    expect(html).toContain('<span class="tier-lbl">Recurring service</span>');
    expect(html).toContain('Add Lawn Care and save more');
    expect(html).toContain('Silver tier pricing (10% off qualifying services)');
    expect(html).not.toContain('Add WaveGuard Mosquito and save more');
    expect(html).not.toContain('Gold tier pricing (15% off qualifying services)');
    expect(html).not.toContain('id="monthly-display"');
    expect(html).not.toContain('You save <span data-service-card-savings data-service-kind="palm_injection"');
    expect(html).not.toContain('You save <span data-service-card-savings data-service-kind="rodent_bait"');
  });

  test('v1 pricing bundle includes separate palm and rodent bait rows without tier discount', async () => {
    const estimate = {
      id: 'pricing-palm-rodent',
      estimate_data: {
        result: {
          results: {
            pestTiers: [{ label: 'Quarterly', mo: 50, ann: 600, pa: 150, apps: 4 }],
            injection: {
              treatmentLabel: 'Nutrition + Insecticide',
              appsPerYear: 2,
              annualAfterCredits: 660,
              monthlyAfterCredits: 55,
            },
            rodBaitSize: 'Medium',
          },
          recurring: {
            discount: 0.10,
            waveGuardTier: 'Silver',
            monthlyTotal: 45,
            annualAfterDiscount: 540,
            grandTotal: 149,
            palmInjectionMo: 55,
            palmInjectionAnn: 660,
            rodentBaitMo: 49,
            services: [{ name: 'Pest Control', mo: 50 }],
          },
          oneTime: { total: 0, items: [], specItems: [] },
          specItems: [],
        },
      },
      monthly_total: 149,
      annual_total: 1788,
      onetime_total: 0,
      waveguard_tier: 'Silver',
    };
    const pricing = await buildPricingBundle(estimate);

    expect(pricing.frequencies[0].monthly).toBe(149);
    expect(pricing.frequencies[0].perServiceTreatments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: 'palm_injection',
        label: 'Palm Injection',
        perTreatment: 330,
        visitsPerYear: 2,
        waveGuardDiscountEligible: false,
      }),
      expect.objectContaining({
        service: 'rodent_bait',
        label: 'Rodent Bait Stations',
        perTreatment: 147,
        visitsPerYear: 4,
        waveGuardDiscountEligible: false,
      }),
    ]));

    const context = buildEstimateAssistantContext({
      estimate,
      estData: estimate.estimate_data,
      pricingBundle: pricing,
    });
    const included = answerEstimateQuestionFallback('What is included?', context);
    expect(included).toContain('Palm Injection - 2 applications/year - $330 per application');
    expect(included).toContain('Rodent Bait Stations - 4 applications/year - $147 per application');
    expect(included).not.toContain('$319.29 per application');
    expect(included).not.toContain('$142.23 per application');
  });

  test('supplemental palm and rodent details enrich sparse legacy recurring rows', async () => {
    const estimateData = {
      result: {
        results: {
          pestTiers: [{ label: 'Quarterly', mo: 50, ann: 600, pa: 150, apps: 4 }],
          injection: {
            treatmentLabel: 'Nutrition + Insecticide',
            appsPerYear: 2,
            annualAfterCredits: 660,
            monthlyAfterCredits: 55,
            detail: '2 palms x $165 x 2/yr',
          },
          rodBaitSize: 'Medium',
          rodBaitVisitsPerYear: 4,
        },
        recurring: {
          discount: 0.10,
          waveGuardTier: 'Silver',
          monthlyTotal: 45,
          annualAfterDiscount: 540,
          grandTotal: 149,
          palmInjectionMo: 55,
          palmInjectionAnn: 660,
          rodentBaitMo: 49,
          services: [
            { name: 'Pest Control', mo: 50 },
            { service: 'palm_treatment', name: 'Legacy Palm Treatment', mo: 60 },
            { service: 'rodent_monitoring', name: 'Legacy Rodent Monitoring', mo: 51 },
          ],
        },
        oneTime: { total: 0, items: [], specItems: [] },
        specItems: [],
      },
    };
    const estimate = {
      id: 'pricing-legacy-sparse-palm-rodent',
      estimate_data: estimateData,
      customerName: 'Test Customer',
      address: '1 Test Way',
      monthly_total: 149,
      annual_total: 1788,
      onetime_total: 0,
      waveguard_tier: 'Silver',
      status: 'sent',
    };

    const supplemented = withSupplementedRecurringServices(estimateData);
    const services = supplemented.result.recurring.services;
    expect(services).toHaveLength(3);
    expect(services).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: 'palm_injection',
        displayName: 'Palm Injection',
        mo: 55,
        monthly: 55,
        perTreatment: 330,
        visitsPerYear: 2,
        cadenceLabel: 'Nutrition + Insecticide',
        waveGuardDiscountEligible: false,
      }),
      expect.objectContaining({
        service: 'rodent_bait',
        displayName: 'Rodent Bait Stations',
        mo: 49,
        monthly: 49,
        perTreatment: 147,
        visitsPerYear: 4,
        cadenceLabel: 'Quarterly monitoring',
        waveGuardDiscountEligible: false,
      }),
    ]));

    const parts = resolveRecurringMonthlyParts(estimate, estimateData);
    expect(parts).toEqual(expect.objectContaining({
      baseMonthly: 154,
      discountableBaseMonthly: 50,
      nonDiscountableMonthly: 104,
      source: 'summed',
    }));

    const html = renderPage('legacy-sparse-token', estimate, estimateData);
    expect(html).toContain('Palm Injection');
    expect(html).toContain('Nutrition + Insecticide &middot; 2 applications/year');
    expect(html).toContain('Rodent Bait Stations');
    expect(html).toContain('Quarterly monitoring &middot; 4 applications/year');

    const pricing = await buildPricingBundle(estimate);
    expect(pricing.frequencies[0].perServiceTreatments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: 'palm_injection',
        label: 'Palm Injection',
        perTreatment: 330,
        visitsPerYear: 2,
        waveGuardDiscountEligible: false,
      }),
      expect.objectContaining({
        service: 'rodent_bait',
        label: 'Rodent Bait Stations',
        perTreatment: 147,
        visitsPerYear: 4,
        waveGuardDiscountEligible: false,
      }),
    ]));
  });

  test('preference recalculation preserves separate palm and rodent bait recurring charges', () => {
    const estData = {
      result: {
        results: {
          injection: {
            appsPerYear: 2,
            annualAfterCredits: 660,
            monthlyAfterCredits: 55,
          },
        },
        recurring: {
          palmInjectionMo: 55,
          palmInjectionAnn: 660,
          rodentBaitMo: 49,
          services: [
            { name: 'Pest Control', mo: 50 },
            { service: 'palm_treatment', name: 'Palm Tree Nutritional Treatment', mo: 55 },
            { service: 'rodent_monitoring', name: 'Rodent Monitoring', mo: 49 },
          ],
        },
      },
    };
    const parts = resolveRecurringMonthlyParts({ monthly_total: 149 }, estData);

    expect(parts).toEqual(expect.objectContaining({
      baseMonthly: 154,
      discountableBaseMonthly: 50,
      nonDiscountableMonthly: 104,
      source: 'summed',
    }));
    expect(monthlyForRecurringParts(parts, 'Silver')).toBe(149);
    expect(monthlyForRecurringParts(parts, 'Silver', 6.67)).toBe(142.33);
  });

  test('interior and eave preferences only reduce pest control recurring pricing', () => {
    const parts = resolveRecurringMonthlyParts({
      monthly_total: 239,
      waveguard_tier: 'Silver',
    }, {
      result: {
        recurring: {
          services: [
            { name: 'Pest Control', mo: 50 },
            { name: 'Lawn Care', mo: 100 },
            { service: 'palm_injection', name: 'Palm Injection', mo: 55 },
            { service: 'rodent_bait', name: 'Rodent Bait Stations', mo: 49 },
          ],
        },
      },
    });

    expect(parts).toEqual(expect.objectContaining({
      baseMonthly: 254,
      discountableBaseMonthly: 150,
      nonDiscountableMonthly: 104,
      source: 'summed',
    }));
    expect(monthlyForRecurringParts(parts, 'Silver')).toBe(239);
    expect(monthlyForRecurringParts(parts, 'Silver', 6.67)).toBe(232.33);
    expect(monthlyForRecurringParts(parts, 'Silver', 13.34)).toBe(225.66);
  });

  test('preference recalculation combines supplemented services with saved base when service rows are missing', () => {
    const engineParts = resolveRecurringMonthlyParts({
      monthly_total: 145,
      waveguard_tier: 'Silver',
    }, {
      result: {
        results: {
          injection: {
            appsPerYear: 2,
            monthlyAfterCredits: 55,
            annualAfterCredits: 660,
          },
        },
        recurring: {
          annualBeforeDiscount: 1200,
          palmInjectionMo: 55,
          palmInjectionAnn: 660,
          services: [],
        },
      },
    });

    expect(engineParts).toEqual(expect.objectContaining({
      baseMonthly: 155,
      discountableBaseMonthly: 100,
      nonDiscountableMonthly: 55,
      source: 'summed',
    }));
    expect(monthlyForRecurringParts(engineParts, 'Silver')).toBe(145);

    const selfHealedParts = resolveRecurringMonthlyParts({
      monthly_total: 149,
      waveguard_tier: 'Silver',
    }, {
      baseMonthly: 154,
      result: {
        results: {
          injection: {
            appsPerYear: 2,
            monthlyAfterCredits: 55,
            annualAfterCredits: 660,
          },
        },
        recurring: {
          palmInjectionMo: 55,
          palmInjectionAnn: 660,
          rodentBaitMo: 49,
          services: [],
        },
      },
    });

    expect(selfHealedParts).toEqual(expect.objectContaining({
      baseMonthly: 154,
      discountableBaseMonthly: 50,
      nonDiscountableMonthly: 104,
      source: 'summed',
    }));
    expect(monthlyForRecurringParts(selfHealedParts, 'Silver')).toBe(149);
  });

  test('preference recalculation uses positive monthly aliases when mo is a placeholder', () => {
    const parts = resolveRecurringMonthlyParts({
      monthly_total: 100,
      waveguard_tier: 'Silver',
    }, {
      result: {
        results: {
          injection: {
            appsPerYear: 2,
            monthlyAfterCredits: 55,
            annualAfterCredits: 660,
          },
        },
        recurring: {
          palmInjectionMo: 55,
          palmInjectionAnn: 660,
          services: [
            { name: 'Pest Control', mo: 0, monthly: 50 },
          ],
        },
      },
    });

    expect(parts).toEqual(expect.objectContaining({
      baseMonthly: 105,
      discountableBaseMonthly: 50,
      nonDiscountableMonthly: 55,
      source: 'summed',
    }));
    expect(monthlyForRecurringParts(parts, 'Silver')).toBe(100);
  });

  test('acceptance helpers carry supplemented palm and rodent services into persisted data', () => {
    const estData = {
      recurring: {
        services: [{ name: 'Pest Control', mo: 50 }],
      },
      result: {
        results: {
          injection: {
            appsPerYear: 2,
            annualAfterCredits: 660,
            monthlyAfterCredits: 55,
          },
          rodBaitSize: 'Medium',
        },
        recurring: {
          palmInjectionMo: 55,
          palmInjectionAnn: 660,
          rodentBaitMo: 49,
          services: [{ name: 'Pest Control', mo: 50 }],
        },
      },
    };

    const supplemented = withSupplementedRecurringServices(estData);
    const expectedServices = expect.arrayContaining([
      expect.objectContaining({ name: 'Pest Control' }),
      expect.objectContaining({ service: 'palm_injection', name: 'Palm Injection' }),
      expect.objectContaining({ service: 'rodent_bait', name: 'Rodent Bait Stations' }),
    ]);

    expect(supplemented.result.recurring.services).toEqual(expectedServices);
    expect(supplemented.recurring.services).toEqual(expectedServices);

    const { recurringSvcList } = acceptanceServiceLists(supplemented);
    expect(recurringSvcList).toEqual(expectedServices);
    expect(recurringSvcList.map((svc) => svc.name)).toEqual([
      'Pest Control',
      'Palm Injection',
      'Rodent Bait Stations',
    ]);
  });

  test('engine pricing bundle uses net palm price after Gold flat credits', async () => {
    const pricing = await buildPricingBundle({
      id: 'engine-palm-credit',
      estimate_data: {
        engineInputs: {
          homeSqFt: 2000,
          stories: 1,
          lotSqFt: 10000,
          propertyType: 'single_family',
          zone: 'A',
          features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
          paymentMethod: 'card',
          services: {
            pest: { frequency: 'quarterly' },
            lawn: { track: 'st_augustine', tier: 'enhanced' },
            mosquito: { tier: 'seasonal9' },
            palm: { palmCount: 3, treatmentType: 'combo', palmSize: 'medium' },
          },
        },
      },
      monthly_total: 187.58,
      annual_total: 2250.9,
      onetime_total: 0,
      waveguard_tier: 'Gold',
    });

    expect(pricing.frequencies[0].perServiceTreatments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: 'palm_injection',
        label: 'Palm Injection',
        perTreatment: 210,
        visitsPerYear: 2,
        waveGuardDiscountEligible: false,
      }),
    ]));
  });

  test('server-rendered estimate keeps aggregate hero when service cards do not cover the full total', () => {
    const html = renderPage('partial-token', {
      status: 'sent',
      customerName: 'Pat Customer',
      address: '123 Main St',
      monthlyTotal: 95,
      annualTotal: 1140,
      onetimeTotal: 0,
      tier: 'Silver',
    }, {
      result: {
        recurring: {
          services: [
            { name: 'Pest Control', mo: 50 },
            { name: 'Special Recurring Service', mo: 45 },
          ],
        },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: {
          pest: { apps: 4 },
          pestTiers: [{ label: 'Quarterly', mo: 50, pa: 150, apps: 4 }],
        },
      },
    });

    expect(html).not.toContain('class="service-price-list"');
    expect(html).toContain('id="monthly-display">$285</span>');
  });

  test('accept success payload marks invoice payment as the next step', () => {
    expect(buildAcceptSuccessPayload({
      invoiceMode: true,
      invoiceId: 'inv-123',
      invoiceAmount: 249,
      treatAsOneTime: true,
    })).toEqual(expect.objectContaining({
      success: true,
      nextStep: 'pay_invoice',
      serviceMode: 'one_time',
      invoiceMode: true,
      invoiceLinkDelivered: false,
      invoiceId: 'inv-123',
      invoiceAmount: 249,
    }));
  });

  test('accept payment preference canonicalizes card-on-file aliases', () => {
    expect(normalizeAcceptPaymentMethodPreference('card_on_file')).toBe('card_on_file');
    expect(normalizeAcceptPaymentMethodPreference('deposit_now')).toBe('card_on_file');
    expect(normalizeAcceptPaymentMethodPreference('pay_at_visit')).toBe('pay_at_visit');
    expect(normalizeAcceptPaymentMethodPreference('prepay_annual')).toBe('prepay_annual');
    expect(normalizeAcceptPaymentMethodPreference('deposit_later')).toBeNull();
  });

  test('accept active guard rejects terminal and past-expiry estimates', () => {
    const now = new Date('2026-05-06T12:00:00Z');

    expect(isEstimateAcceptActive({ status: 'sent', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(true);
    expect(isEstimateAcceptActive({ status: 'viewed', expires_at: null }, now)).toBe(true);
    expect(isEstimateAcceptActive({ status: 'declined', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(false);
    expect(isEstimateAcceptActive({ status: 'expired', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(false);
    expect(isEstimateAcceptActive({ status: 'send_failed', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(false);
    expect(isEstimateAcceptActive({ status: 'sent', archived_at: '2026-05-05T12:00:00Z', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(false);
    expect(isEstimateAcceptActive({ status: 'sent', expires_at: '2026-05-06T11:59:59Z' }, now)).toBe(false);
  });

  test('estimate ask guard rejects terminal or expired estimate links', () => {
    const now = new Date('2026-05-06T12:00:00Z');

    expect(isEstimateAskAnswerable({ status: 'sent', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(true);
    expect(isEstimateAskAnswerable({ status: 'quote_required', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(true);
    expect(isEstimateAskAnswerable({ status: 'accepted', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(false);
    expect(isEstimateAskAnswerable({ status: 'declined', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(false);
    expect(isEstimateAskAnswerable({ status: 'expired', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(false);
    expect(isEstimateAskAnswerable({ status: 'send_failed', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(false);
    expect(isEstimateAskAnswerable({ status: 'sent', archived_at: '2026-05-05T12:00:00Z', expires_at: '2026-05-06T12:01:00Z' }, now)).toBe(false);
    expect(isEstimateAskAnswerable({ status: 'sent', expires_at: '2026-05-06T11:59:59Z' }, now)).toBe(false);
  });

  test('estimate ask query log stores metadata instead of raw customer text', () => {
    const question = 'My phone is (941) 555-1212 and email is pat@example.com';
    const answer = 'Pat Customer at 123 Main St can call (941) 555-1212.';
    const entry = buildEstimateAskQueryLog({
      estimateId: 'estimate-123',
      question,
      result: {
        answer,
        source: 'fallback',
      },
    });

    expect(entry.prompt).toBe(`[public_estimate:estimate-123] question_chars=${question.length}`);
    expect(entry.response).toBe(`[redacted] source=fallback answer_chars=${answer.length}`);
    expect(entry.prompt).not.toContain('941');
    expect(entry.prompt).not.toContain('pat@example.com');
    expect(entry.response).not.toContain('Pat Customer');
    expect(entry.response).not.toContain('123 Main');
    expect(entry.response).not.toContain('941');
  });

  test('decline guard rejects missing, accepted, and expired estimates', () => {
    const now = new Date('2026-05-06T12:00:00Z');

    expect(resolveEstimateDeclineGuard(null, now)).toEqual({
      ok: false,
      status: 404,
      error: 'Estimate not found',
    });
    expect(resolveEstimateDeclineGuard({ status: 'accepted', expires_at: '2026-05-06T12:01:00Z' }, now)).toEqual({
      ok: false,
      status: 409,
      error: 'Estimate is no longer active',
    });
    expect(resolveEstimateDeclineGuard({ status: 'expired', expires_at: '2026-05-06T12:01:00Z' }, now)).toEqual({
      ok: false,
      status: 409,
      error: 'Estimate is no longer active',
    });
    expect(resolveEstimateDeclineGuard({ status: 'sent', expires_at: '2026-05-06T11:59:59Z' }, now)).toEqual({
      ok: false,
      status: 409,
      error: 'Estimate is no longer active',
    });
  });

  test('decline guard allows active estimates and makes declined idempotent', () => {
    const now = new Date('2026-05-06T12:00:00Z');

    expect(resolveEstimateDeclineGuard({ status: 'draft', expires_at: null }, now)).toEqual({ ok: true });
    expect(resolveEstimateDeclineGuard({ status: 'viewed', expires_at: '2026-05-06T12:01:00Z' }, now)).toEqual({ ok: true });
    expect(resolveEstimateDeclineGuard({ status: 'declined', expires_at: '2026-05-06T12:01:00Z' }, now)).toEqual({
      ok: true,
      alreadyDeclined: true,
    });
  });

  test('accept success payload exposes invoice delivery state', () => {
    expect(buildAcceptSuccessPayload({
      invoiceMode: true,
      invoiceLinkDelivered: true,
      invoiceId: 'inv-123',
    })).toEqual(expect.objectContaining({
      nextStep: 'pay_invoice',
      invoiceMode: true,
      invoiceLinkDelivered: true,
      invoiceId: 'inv-123',
    }));
  });

  test('accept success payload distinguishes one-time booking from onboarding', () => {
    expect(buildAcceptSuccessPayload({
      bookingUrl: 'https://portal.wavespestcontrol.com/book?service=pest_control',
      treatAsOneTime: true,
    })).toEqual(expect.objectContaining({
      nextStep: 'book_one_time',
      serviceMode: 'one_time',
      bookingUrl: 'https://portal.wavespestcontrol.com/book?service=pest_control',
    }));

    expect(buildAcceptSuccessPayload({
      treatAsOneTime: true,
    })).toEqual(expect.objectContaining({
      nextStep: 'book_one_time',
      serviceMode: 'one_time',
      bookingUrl: null,
    }));

    expect(buildAcceptSuccessPayload({
      bookingUrl: 'https://portal.wavespestcontrol.com/book?service=pest_control',
      treatAsOneTime: true,
      reservationCommitted: true,
    })).toEqual(expect.objectContaining({
      nextStep: 'confirmed',
      serviceMode: 'one_time',
      reservationCommitted: true,
    }));

    expect(buildAcceptSuccessPayload({
      onboardingToken: 'setup-token',
      treatAsOneTime: false,
    })).toEqual(expect.objectContaining({
      nextStep: 'complete_onboarding',
      serviceMode: 'recurring',
      onboardingToken: 'setup-token',
    }));
  });

  test('accept office fallback reflects one-time appointment and invoice next steps', () => {
    expect(buildAcceptOfficeFallback({
      customerName: 'Jane Doe',
      address: '123 Main St',
      serviceLabel: 'Rodent Service',
      treatAsOneTime: true,
      reservationCommitted: true,
    })).toBe('One-time estimate accepted by Jane Doe at 123 Main St - Rodent Service. Appointment confirmed.');

    expect(buildAcceptOfficeFallback({
      customerName: 'Jane Doe',
      address: '123 Main St',
      serviceLabel: 'Rodent Service',
      treatAsOneTime: true,
    })).toBe('One-time estimate accepted by Jane Doe at 123 Main St - Rodent Service. Booking link sent.');

    expect(buildAcceptOfficeFallback({
      customerName: 'Jane Doe',
      address: '123 Main St',
      waveguardTier: 'Gold',
      monthlyTotal: 89,
      billByInvoice: true,
    })).toBe('Estimate accepted by Jane Doe at 123 Main St - Gold WaveGuard $89/mo. Invoice mode selected.');
  });

  test('accept notification payload avoids WaveGuard onboarding copy for one-time accepts', () => {
    expect(buildAcceptNotificationPayload({
      customerName: 'Jane Doe',
      serviceLabel: 'Rodent Service',
      treatAsOneTime: true,
      reservationCommitted: true,
    })).toEqual(expect.objectContaining({
      adminTitle: 'One-time estimate accepted: Jane Doe',
      adminBody: 'Rodent Service approved and appointment confirmed.',
      customerTitle: 'One-time service approved',
      customerBody: 'Your Rodent Service appointment is confirmed. Check your phone for the confirmation text.',
      customerLink: '/?tab=schedule',
    }));

    expect(buildAcceptNotificationPayload({
      customerName: 'Jane Doe',
      serviceLabel: 'Rodent Service',
      treatAsOneTime: true,
      bookingUrl: 'https://portal.wavespestcontrol.com/book?service=rodent',
    })).toEqual(expect.objectContaining({
      adminBody: 'Rodent Service approved. Booking link sent.',
      customerBody: 'Your Rodent Service estimate is approved. Pick your appointment from the booking link we sent.',
      customerLink: 'https://portal.wavespestcontrol.com/book?service=rodent',
    }));

    expect(buildAcceptNotificationPayload({
      customerName: 'Jane Doe',
      waveguardTier: 'Gold',
      monthlyTotal: 89,
      treatAsOneTime: false,
    })).toEqual(expect.objectContaining({
      adminTitle: 'Estimate accepted: Jane Doe',
      adminBody: 'Gold WaveGuard $89/mo approved. Onboarding link sent.',
      customerBody: 'Your Gold WaveGuard plan is confirmed. Complete onboarding to get started.',
      customerLink: '/?tab=plan',
    }));
  });

  test('accept notification payload only promises invoice links after invoice creation succeeds', () => {
    expect(buildAcceptNotificationPayload({
      customerName: 'Jane Doe',
      serviceLabel: 'Rodent Service',
      treatAsOneTime: true,
      billByInvoice: true,
      invoiceMode: true,
      invoiceLinkDelivered: true,
    })).toEqual(expect.objectContaining({
      adminBody: 'Rodent Service approved. Invoice pay link is being sent.',
      customerBody: 'Your Rodent Service estimate is approved. Use the invoice pay link we sent to complete payment.',
      customerLink: '/?tab=billing',
    }));

    expect(buildAcceptNotificationPayload({
      customerName: 'Jane Doe',
      serviceLabel: 'Rodent Service',
      treatAsOneTime: true,
      billByInvoice: true,
      invoiceMode: false,
    })).toEqual(expect.objectContaining({
      adminBody: 'Rodent Service approved. Invoice was not sent automatically; office follow-up needed.',
      customerBody: 'Your Rodent Service estimate is approved. Our team will follow up with the invoice details.',
      customerLink: '/?tab=billing',
    }));

    expect(buildAcceptNotificationPayload({
      customerName: 'Jane Doe',
      serviceLabel: 'Rodent Service',
      treatAsOneTime: true,
      billByInvoice: true,
      invoiceMode: true,
      invoiceLinkDelivered: false,
    })).toEqual(expect.objectContaining({
      adminBody: 'Rodent Service approved. Invoice was not sent automatically; office follow-up needed.',
      customerBody: 'Your Rodent Service estimate is approved. Our team will follow up with the invoice details.',
    }));
  });

  test('admin marker cookie suppresses first-view customer side effects', () => {
    const token = jwt.sign(
      { kind: 'admin_marker', sub: 'tech-1' },
      config.jwt.secret,
      { expiresIn: '1h' },
    );
    const req = {
      headers: { cookie: `waves_admin=${encodeURIComponent(token)}` },
    };

    expect(shouldApplyFirstViewSideEffects(req, '203.0.113.10')).toBe(false);
  });

  test('normal public requests still apply first-view customer side effects', () => {
    const req = { headers: {} };

    expect(shouldApplyFirstViewSideEffects(req, '203.0.113.10')).toBe(true);
  });
});
