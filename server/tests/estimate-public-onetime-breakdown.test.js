process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const jwt = require('jsonwebtoken');
const config = require('../config');
const {
  buildAcceptNotificationPayload,
  buildAcceptOfficeFallback,
  buildAcceptSuccessPayload,
  acceptedOneTimeChoiceListForEstimate,
  acceptanceServiceLists,
  attachPublicPricingContract,
  bookingServiceFor,
  buildEstimateAskPrompts,
  serviceCategoryForOneTimeChoice,
  applySelectedLawnTierToEstimateData,
  applySelectedTreeShrubTierToEstimateData,
  assertExistingAppointmentUpdateApplied,
  buildEstimateAskQueryLog,
  buildEstimateAcceptanceContract,
  buildEstimateInvoiceModeDraft,
  buildOneTimeInvoiceServiceLabel,
  buildPricingBundle,
  buildStandardPayPerApplicationInvoiceCopy,
  buildWaveGuardIntelligencePayload,
  defaultServiceModeForEstimate,
  deriveServiceCategory,
  estimateInvoicePayUrlParams,
  isEstimateAcceptActive,
  isEstimateAskAnswerable,
  isAnnualPrepayEligibleServiceMix,
  isStructuralOneTimeOnlyEstimate,
  lawnFrequenciesFromResultStats,
  isReservationHeldAppointment,
  monthlyForRecurringParts,
  normalizeAcceptPaymentMethodPreference,
  normalizeOneTimeBreakdown,
  manualDiscountForRecurringBase,
  applyManualOneTimeDiscountToChoiceRows,
  oneTimeChoiceAmountForEstimate,
  pestMonthlyBaseForFrequency,
  preferenceMonthlyOffForPestVisits,
  renderPage,
  resolveAcceptOneTimeTotal,
  resolveRecurringInvoiceFirstVisitAmount,
  resolveAnnualPrepayInvoiceAmount,
  resolveRecurringMonthlyParts,
  resolveEstimateDeclineGuard,
  resolveEstimateQuoteRequirement,
  resolveRecurringFirstVisitAmount,
  resolveRecurringFirstVisitAmountFromFrequency,
  shouldApplyFirstViewSideEffects,
  shouldPersistPestOnlyRecurringChoice,
  validateRecurringSlotPaymentPreference,
  sameDayVisitTotalForPricingFrequency,
  withSupplementedRecurringServices,
} = require('../routes/estimate-public');
const {
  answerEstimateQuestion,
  answerEstimateQuestionFallback,
  buildEstimateAssistantContext,
  cleanAssistantAnswer,
} = require('../services/estimate-assistant');
const estimateSlotAvailability = require('../services/estimate-slot-availability');

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

  test('public pricing bundle ignores stale send snapshots after totals change', async () => {
    const bundle = await buildPricingBundle({
      id: 'estimate-stale-snapshot',
      monthly_total: 70,
      annual_total: 840,
      estimate_data: {
        sendSnapshot: {
          pricingBundle: {
            frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }],
            source: 'send_snapshot_fixture',
          },
        },
        result: {
          results: {
            pestTiers: [
              { label: 'Quarterly', mo: 70, ann: 840, pa: 210, apps: 4 },
            ],
          },
          recurring: {
            discount: 0,
            monthlyTotal: 70,
            annualAfterDiscount: 840,
            services: [{ name: 'Pest Control', mo: 70 }],
          },
        },
      },
    });

    expect(bundle.snapshotHit).not.toBe(true);
    expect(bundle.frequencies[0]).toMatchObject({ key: 'quarterly', monthly: 70, annual: 840 });
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

  test('applies the manual one-time discount slice to engineResult-backed breakdowns', () => {
    // Raw engineResult estimates have no oneTime.total — the breakdown sums gross
    // line items, so the pooled one-time discount must surface as its own row or
    // the customer would be shown (and charged) the undiscounted total.
    const breakdown = normalizeOneTimeBreakdown({
      engineResult: {
        lineItems: [
          { service: 'exclusion', label: 'Rodent Exclusion', priceAfterDiscount: 720 },
        ],
        summary: {
          manualDiscount: {
            label: 'WaveGuard Member Discount',
            type: 'PERCENT',
            value: 15,
            amount: 108,
            recurringAmount: 0,
            oneTimeAmount: 108,
          },
        },
      },
    });

    expect(breakdown.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: 'exclusion', amount: 720 }),
      expect.objectContaining({
        service: 'manual_discount',
        amount: -108,
        kind: 'discount',
        label: 'WaveGuard Member Discount',
      }),
    ]));
    expect(breakdown.total).toBe(612);
  });

  test('manual one-time discount nets once for mapped estimates (oneTime.total already net)', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: {
          total: 612, // mapper already subtracted the 108 one-time slice
          items: [{ service: 'exclusion', name: 'Rodent Exclusion', price: 720 }],
        },
        manualDiscount: {
          label: 'WaveGuard Member Discount',
          oneTimeAmount: 108,
        },
      },
    });

    // The explicit discount row replaces the generic "Other one-time services"
    // adjustment, and the total stays net — no double subtraction.
    expect(breakdown.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: 'exclusion', amount: 720 }),
      expect.objectContaining({ service: 'manual_discount', amount: -108, kind: 'discount' }),
    ]));
    expect(breakdown.items.find((r) => r.service === 'one_time_adjustment')).toBeUndefined();
    expect(breakdown.total).toBe(612);
  });

  test('manualDiscountForRecurringBase refreshes recurringAmount to the recomputed per-cadence amount', () => {
    // The saved discount carries a recurringAmount/oneTimeAmount from the
    // originally generated cadence. A different cadence has a different recurring
    // base, so the recurring slice must be recomputed — the recurring price card
    // (which prefers recurringAmount) must reconcile with the recomputed amount,
    // not show the stale spread value.
    const saved = { type: 'PERCENT', value: 15, amount: 162, recurringAmount: 70.2, oneTimeAmount: 91.8 };
    const recomputed = manualDiscountForRecurringBase(saved, 600);

    expect(recomputed.amount).toBe(90); // 15% of the 600 recurring base
    expect(recomputed.recurringAmount).toBe(90); // tracks amount, not the stale 70.2
    expect(recomputed.oneTimeAmount).toBe(0);
    expect(recomputed.monthlyAmount).toBe(7.5); // 90 / 12
  });

  test('fixed discount recurring slice + one-time slice sum to the fixed value across cadences', () => {
    // $100 fixed split into a 39.39 recurring / 60.61 one-time slice. The
    // recurring card must show only the recurring slice (never the full $100),
    // and recurring + one-time must keep totaling $100 on every cadence.
    const saved = { type: 'FIXED', value: 100, amount: 100, recurringAmount: 39.39, oneTimeAmount: 60.61 };

    const base = manualDiscountForRecurringBase(saved, 468);
    expect(base.recurringAmount).toBeCloseTo(39.39, 2);
    expect(base.oneTimeAmount).toBe(0);
    expect(base.recurringAmount + saved.oneTimeAmount).toBeCloseTo(100, 2);

    // A different cadence (larger recurring base) keeps the same recurring slice,
    // because the one-time slice is cadence-invariant — still sums to $100.
    const larger = manualDiscountForRecurringBase(saved, 900);
    expect(larger.recurringAmount).toBeCloseTo(39.39, 2);
    expect(larger.recurringAmount + saved.oneTimeAmount).toBeCloseTo(100, 2);

    // A cadence whose recurring base can't absorb the recurring slice caps to the
    // base (never over-discounts).
    const tiny = manualDiscountForRecurringBase(saved, 20);
    expect(tiny.recurringAmount).toBe(20);
    expect(tiny.capped).toBe(true);
  });

  test('applyManualOneTimeDiscountToChoiceRows nets the one-time slice into preserved choice rows', () => {
    const rows = [{ service: 'pest_initial_roach', name: 'Initial Roach Knockdown', label: 'Initial Roach Knockdown', price: 239 }];

    const percent = applyManualOneTimeDiscountToChoiceRows(rows, { type: 'PERCENT', value: 15 });
    expect(percent[0].price).toBeCloseTo(203.15, 2); // 239 - 15%
    expect(percent[0].grossPrice).toBe(239);
    expect(percent[0].manualDiscountApplied).toBeCloseTo(35.85, 2);

    // FIXED uses the engine-computed one-time slice, capped to the carried subtotal.
    const fixed = applyManualOneTimeDiscountToChoiceRows(rows, { type: 'FIXED', value: 500, oneTimeAmount: 40 });
    expect(fixed[0].price).toBe(199);
    const overCap = applyManualOneTimeDiscountToChoiceRows(rows, { type: 'FIXED', value: 500, oneTimeAmount: 999 });
    expect(overCap[0].price).toBe(0); // never below zero
  });

  test('keeps free service-specific inspection rows visible in one-time breakdown', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: {
          total: 0,
          specItems: [{
            service: 'wdo_inspection',
            name: 'WDO Inspection',
            price: 0,
            serviceSpecificDiscountApplied: true,
          }],
        },
      },
    });

    expect(breakdown.items).toEqual([
      expect.objectContaining({
        service: 'wdo_inspection',
        label: 'WDO Inspection',
        amount: 0,
        kind: 'included',
      }),
    ]);
    expect(breakdown.total).toBe(0);
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

  test('phase 0 pricing contract emits a single pest service alongside legacy frequencies', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-phase-0-contract-test',
      estimate_data: savedAdminEstimateData(),
      monthly_total: 50,
      annual_total: 600,
      onetime_total: 2084,
      waveguard_tier: 'Bronze',
    });

    expect(payload.frequencies).toHaveLength(3);
    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'pest_control',
      label: 'Pest Control',
      isPest: true,
      isRecurring: true,
      defaultFrequencyKey: 'quarterly',
    }));
    expect(payload.services[0].frequencies[0]).toEqual(expect.objectContaining({
      key: 'quarterly',
      monthly: payload.frequencies[0].monthly,
    }));
    expect(payload.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: payload.frequencies[0].monthly,
      waveGuardTierLabel: 'Bronze',
      qualifyingCount: 1,
    }));
    expect(payload.renderFlags).toEqual(expect.objectContaining({
      showWaveGuardSetupFee: true,
      showPestRecurringAddOns: true,
      showOneTimePestAddOns: false,
    }));
    expect(payload.askChips).toEqual([
      'How do you handle ants?',
      'Can you treat inside?',
      'When am I charged?',
      'What happens after approval?',
    ]);
  });

  test('multi-service recurring bundles emit stacked service sections while preserving combined total', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-phase-0-pest-bundle-contract-test',
      estimate_data: {
        sendSnapshot: {
          pricingBundle: {
            source: 'complete_service_rows_snapshot',
            waveGuardTier: 'Bronze',
            firstVisitFees: [
              { service: 'waveguard_setup', label: 'WaveGuard Membership Setup', amount: 99 },
            ],
            frequencies: [
              {
                key: 'quarterly',
                label: 'Quarterly',
                monthly: 90,
                annual: 1080,
                perServiceTreatments: [
                  {
                    service: 'pest_control',
                    label: 'Pest Control (Quarterly)',
                    displayPrice: 150,
                    perTreatment: 150,
                    visitsPerYear: 4,
                  },
                  {
                    service: 'lawn_care',
                    label: 'Lawn Care',
                    displayPrice: 120,
                    perTreatment: 120,
                    visitsPerYear: 4,
                  },
                ],
                included: [
                  { service: 'pest_control', label: 'Pest Control', detail: 'Quarterly service' },
                  { service: 'lawn_care', label: 'Lawn Care', detail: 'Recurring turf applications' },
                ],
              },
            ],
          },
        },
        result: {
          recurring: {
            monthlyTotal: 90,
            annualAfterDiscount: 1080,
            services: [
              { name: 'Pest Control', mo: 50 },
              { name: 'Lawn Care', mo: 40 },
            ],
          },
          oneTime: {
            total: 99,
            membershipFee: 99,
            items: [],
          },
        },
      },
      monthly_total: 90,
      annual_total: 1080,
      onetime_total: 99,
      waveguard_tier: 'Bronze',
    });

    expect(payload.frequencies[0]).toEqual(expect.objectContaining({
      key: 'quarterly',
      monthly: 90,
    }));
    expect(payload.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: 90,
      annualSubtotal: 1080,
    }));
    expect(payload.services.map((section) => section.key)).toEqual(['pest_control', 'lawn_care']);
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'pest_control',
      label: 'Pest Control',
      isPest: true,
      isRecurring: true,
      setupFee: expect.objectContaining({ service: 'waveguard_setup', amount: 99 }),
    }));
    expect(payload.services[0].frequencies[0]).toEqual(expect.objectContaining({
      key: 'quarterly',
      monthly: 50,
      perVisit: 150,
    }));
    expect(payload.services[1]).toEqual(expect.objectContaining({
      key: 'lawn_care',
      label: 'Lawn Care',
      isPest: false,
      isRecurring: true,
      setupFee: null,
    }));
    expect(payload.services[1].frequencies).toHaveLength(1);
    expect(payload.services[1].frequencies[0]).toEqual(expect.objectContaining({
      key: 'recurring',
      monthly: 40,
      perTreatment: 120,
      perVisit: null,
      addOns: [],
    }));
    expect(payload.renderFlags).toEqual(expect.objectContaining({
      showWaveGuardSetupFee: true,
      showPestRecurringAddOns: true,
      showOneTimePestAddOns: false,
    }));
    expect(payload.askChips).toEqual(expect.arrayContaining([
      'How do you handle ants?',
      'How does your lawn assessment tech work?',
    ]));
  });

  test('multi-service pest bundles preserve non-pest cadence rows when split', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-mixed-pest-non-pest-cadence-test',
      monthly_total: 90,
      estimate_data: {
        sendSnapshot: {
          pricingBundle: {
            source: 'complete_mixed_service_rows_snapshot',
            waveGuardTier: 'Bronze',
            frequencies: [
              {
                key: 'quarterly',
                label: 'Quarterly',
                monthly: 90,
                perServiceTreatments: [
                  {
                    service: 'pest_control',
                    label: 'Pest Control (Quarterly)',
                    displayPrice: 150,
                    perTreatment: 150,
                    visitsPerYear: 4,
                  },
                  {
                    service: 'lawn_care',
                    label: 'Lawn Care (Quarterly)',
                    displayPrice: 120,
                    perTreatment: 120,
                    visitsPerYear: 4,
                  },
                ],
              },
              {
                key: 'monthly',
                label: 'Monthly',
                monthly: 110,
                perServiceTreatments: [
                  {
                    service: 'pest_control',
                    label: 'Pest Control (Monthly)',
                    displayPrice: 60,
                    perTreatment: 60,
                    visitsPerYear: 12,
                  },
                  {
                    service: 'lawn_care',
                    label: 'Lawn Care (Monthly)',
                    displayPrice: 50,
                    perTreatment: 50,
                    visitsPerYear: 12,
                  },
                ],
              },
            ],
          },
        },
        result: {
          recurring: {
            monthlyTotal: 90,
            annualAfterDiscount: 1080,
            services: [
              { name: 'Pest Control', mo: 50 },
              { name: 'Lawn Care', mo: 40 },
            ],
          },
          oneTime: { total: 0, items: [] },
          specItems: [],
        },
      },
    });

    expect(payload.frequencies.map((frequency) => frequency.key)).toEqual(['quarterly', 'monthly']);
    expect(payload.frequencies[0]).toEqual(expect.objectContaining({
      key: 'quarterly',
      monthly: 90,
      annual: 1080,
    }));
    expect(payload.frequencies[1]).toEqual(expect.objectContaining({
      key: 'monthly',
      monthly: 110,
      annual: 1320,
    }));
    expect(payload.services.map((section) => section.key)).toEqual(['pest_control', 'lawn_care']);
    expect(payload.services[0].frequencies.map((frequency) => frequency.key)).toEqual(['quarterly', 'monthly']);
    expect(payload.services[1].frequencies.map((frequency) => frequency.key)).toEqual(['quarterly', 'monthly']);
    expect(payload.services[1].frequencies[0]).toEqual(expect.objectContaining({
      key: 'quarterly',
      monthly: 40,
      perTreatment: 120,
      perVisit: null,
    }));
    expect(payload.services[1].frequencies[1]).toEqual(expect.objectContaining({
      key: 'monthly',
      monthly: 50,
      perTreatment: 50,
      perVisit: null,
    }));
    expect(payload.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: 90,
      annualSubtotal: 1080,
    }));
  });

  test('multi-service non-pest bundles preserve selectable cadence rows when split', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-non-pest-multi-cadence-test',
      monthly_total: 50,
      annual_total: 600,
      estimate_data: {
        sendSnapshot: {
          pricingBundle: {
            source: 'complete_non_pest_service_rows_snapshot',
            frequencies: [
              {
                key: 'quarterly',
                label: 'Quarterly',
                monthly: 50,
                annual: 600,
                perServiceTreatments: [
                  {
                    service: 'lawn_care',
                    label: 'Lawn Care',
                    displayPrice: 90,
                    perTreatment: 90,
                    visitsPerYear: 4,
                  },
                  {
                    service: 'mosquito',
                    label: 'Mosquito',
                    displayPrice: 60,
                    perTreatment: 60,
                    visitsPerYear: 4,
                  },
                ],
              },
              {
                key: 'monthly',
                label: 'Monthly',
                monthly: 60,
                annual: 720,
                perServiceTreatments: [
                  {
                    service: 'lawn_care',
                    label: 'Lawn Care',
                    displayPrice: 35,
                    perTreatment: 35,
                    visitsPerYear: 12,
                  },
                  {
                    service: 'mosquito',
                    label: 'Mosquito',
                    displayPrice: 25,
                    perTreatment: 25,
                    visitsPerYear: 12,
                  },
                ],
              },
            ],
          },
        },
        result: {
          recurring: {
            monthlyTotal: 50,
            annualAfterDiscount: 600,
            services: [
              { name: 'Lawn Care', mo: 30 },
              { name: 'Mosquito', mo: 20 },
            ],
          },
          oneTime: { total: 0, items: [] },
          specItems: [],
        },
      },
    });

    expect(payload.frequencies.map((frequency) => frequency.key)).toEqual(['quarterly', 'monthly']);
    expect(payload.services.map((section) => section.key)).toEqual(['lawn_care', 'mosquito']);
    expect(payload.services[0].frequencies.map((frequency) => frequency.key)).toEqual(['quarterly', 'monthly']);
    expect(payload.services[1].frequencies.map((frequency) => frequency.key)).toEqual(['quarterly', 'monthly']);
    expect(payload.services[0].frequencies[0]).toEqual(expect.objectContaining({
      key: 'quarterly',
      monthly: 30,
      perTreatment: 90,
      perVisit: null,
    }));
    expect(payload.services[0].frequencies[1]).toEqual(expect.objectContaining({
      key: 'monthly',
      monthly: 35,
      perTreatment: 35,
      perVisit: null,
    }));
    expect(payload.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: 50,
      annualSubtotal: 600,
    }));
  });

  test('multi-service snapshots keep legacy bundle when service rows do not cover selectable ladder', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-multi-service-snapshot-ladder-test',
      monthly_total: 90,
      annual_total: 1080,
      estimate_data: {
        sendSnapshot: {
          pricingBundle: {
            source: 'old_snapshot',
            waveGuardTier: 'Bronze',
            frequencies: [
              { key: 'quarterly', label: 'Quarterly', monthly: 90, annual: 1080 },
              { key: 'bi_monthly', label: 'Bi-monthly', monthly: 110, annual: 1320 },
              { key: 'monthly', label: 'Monthly', monthly: 130, annual: 1560 },
            ],
          },
        },
        result: {
          results: {
            pestTiers: [
              { label: 'Quarterly', mo: 50, ann: 600, pa: 150, apps: 4 },
            ],
          },
          recurring: {
            discount: 0,
            services: [
              { name: 'Pest Control', mo: 50 },
              { name: 'Lawn Care', mo: 40 },
            ],
          },
          oneTime: { total: 0, items: [] },
          specItems: [],
        },
      },
    });

    expect(payload.frequencies.map((frequency) => frequency.key)).toEqual(['quarterly', 'bi_monthly', 'monthly']);
    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'bundle',
      isRecurring: true,
      isPest: true,
    }));
    expect(payload.services[0].frequencies.map((frequency) => frequency.key)).toEqual(['quarterly', 'bi_monthly', 'monthly']);
    expect(payload.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: 90,
      annualSubtotal: 1080,
    }));
  });

  test('multi-service snapshots keep legacy bundle when service rows do not match adjusted total', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-multi-service-adjusted-total-test',
      monthly_total: 83.33,
      annual_total: 999.96,
      estimate_data: {
        preferences: { interior_spray: false },
        sendSnapshot: {
          pricingBundle: {
            source: 'adjusted_total_snapshot',
            waveGuardTier: 'Bronze',
            frequencies: [
              {
                key: 'quarterly',
                label: 'Quarterly',
                monthly: 83.33,
                annual: 999.96,
                perServiceTreatments: [
                  {
                    service: 'pest_control',
                    label: 'Pest Control (Quarterly)',
                    displayPrice: 150,
                    perTreatment: 150,
                    visitsPerYear: 4,
                  },
                  {
                    service: 'lawn_care',
                    label: 'Lawn Care',
                    displayPrice: 120,
                    perTreatment: 120,
                    visitsPerYear: 4,
                  },
                ],
              },
            ],
          },
        },
        result: {
          recurring: {
            services: [
              { name: 'Pest Control', mo: 50 },
              { name: 'Lawn Care', mo: 40 },
            ],
          },
          oneTime: { total: 0, items: [] },
          specItems: [],
        },
      },
    });

    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'bundle',
      isRecurring: true,
      isPest: true,
    }));
    expect(payload.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: 83.33,
      annualSubtotal: 999.96,
    }));
  });

  test('phase 0 no-engine recurring fallback keeps stored frequency pricing in services', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-phase-0-stored-recurring-fallback-test',
      estimate_data: {},
      monthly_total: 80,
      annual_total: 960,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
    });

    expect(payload.frequencies).toHaveLength(1);
    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'pest_control',
      isRecurring: true,
      isPest: true,
    }));
    expect(payload.services[0].frequencies[0]).toEqual(expect.objectContaining({
      key: 'quarterly',
      monthly: 80,
      annual: 960,
      quoteRequired: false,
    }));
    expect(payload.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: 80,
      annualSubtotal: 960,
    }));
  });

  test('phase 0 generic rodent recurring estimates do not use pest copy or gates', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-phase-0-rodent-recurring-test',
      estimate_data: {
        result: {
          recurring: {
            monthlyTotal: 49,
            annualAfterDiscount: 588,
            services: [{ name: 'Rodent Remediation', mo: 49 }],
          },
        },
      },
      monthly_total: 49,
      annual_total: 588,
      waveguard_tier: 'Bronze',
    });

    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'rodent',
      label: 'Rodent Remediation',
      isRecurring: true,
      isPest: false,
    }));
    expect(payload.renderFlags).toEqual(expect.objectContaining({
      showWaveGuardTierUi: false,
      showWaveGuardPerks: false,
      showWaveGuardSetupFee: false,
      showPestRecurringAddOns: false,
    }));
    expect(payload.askChips).toContain('Trapping vs exclusion?');
    expect(payload.askChips).not.toContain('What products do you use?');
  });

  test('tree and shrub recurring estimates expose bi-monthly and every-six-weeks tiers', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-tree-shrub-tier-contract-test',
      estimate_data: {
        result: {
          results: {
            ts: [
              { name: 'Standard', v: 6, mo: 72, ann: 864, pa: 144, recommended: false },
              { name: 'Enhanced', v: 9, mo: 96, ann: 1152, pa: 128, recommended: true },
              { name: 'Premium', v: 12, mo: 120, ann: 1440, pa: 120, recommended: false },
            ],
            tsMeta: { eb: 2400, et: 7 },
          },
          recurring: {
            discount: 0,
            monthlyTotal: 96,
            annualAfterDiscount: 1152,
            waveGuardTier: 'Bronze',
            services: [{ service: 'tree_shrub', name: 'Tree & Shrub', mo: 96 }],
          },
          oneTime: { total: 0, items: [], specItems: [] },
          specItems: [],
        },
      },
      monthly_total: 96,
      annual_total: 1152,
      waveguard_tier: 'Bronze',
    });

    expect(payload.frequencies.map((frequency) => frequency.key)).toEqual(['standard', 'enhanced']);
    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'tree_shrub',
      label: 'Tree & Shrub',
      isPest: false,
      defaultFrequencyKey: 'enhanced',
      setupFee: null,
    }));
    expect(payload.services[0].frequencies).toEqual([
      expect.objectContaining({
        key: 'standard',
        label: 'Bi-monthly',
        monthly: 72,
        annual: 864,
        perTreatment: 144,
        visitsPerYear: 6,
        billingFrequencyKey: 'monthly',
        addOns: [],
      }),
      expect.objectContaining({
        key: 'enhanced',
        label: 'Every 6 weeks',
        monthly: 96,
        annual: 1152,
        perTreatment: 128,
        visitsPerYear: 9,
        billingFrequencyKey: 'monthly',
        addOns: [],
        recommended: true,
      }),
    ]);
    expect(payload.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: 96,
      annualSubtotal: 1152,
      qualifyingCount: 1,
    }));
    expect(payload.renderFlags).toEqual(expect.objectContaining({
      showWaveGuardSetupFee: false,
      showPestRecurringAddOns: false,
    }));
    expect(payload.askChips).toEqual([
      'Which trees get treated?',
      'What gets applied?',
      'When do visits start?',
      'Can I prepay annually?',
    ]);
  });

  test('tree and shrub default tier follows source selection before recommendation', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-tree-shrub-selected-standard-test',
      estimate_data: {
        result: {
          results: {
            ts: [
              { name: 'Standard', v: 6, mo: 72, ann: 864, pa: 144, selected: true },
              { name: 'Enhanced', v: 9, mo: 96, ann: 1152, pa: 128, recommended: true },
            ],
          },
          recurring: {
            discount: 0,
            monthlyTotal: 72,
            annualAfterDiscount: 864,
            waveGuardTier: 'Bronze',
            services: [{ service: 'tree_shrub', name: 'Tree & Shrub', mo: 72 }],
          },
          oneTime: { total: 0, items: [], specItems: [] },
          specItems: [],
        },
      },
      monthly_total: 72,
      annual_total: 864,
      waveguard_tier: 'Bronze',
    });

    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'tree_shrub',
      defaultFrequencyKey: 'standard',
    }));
    expect(payload.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: 72,
      annualSubtotal: 864,
    }));
  });

  test('tree and shrub tier rows preserve manual recurring discounts', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-tree-shrub-manual-discount-test',
      estimate_data: {
        result: {
          manualDiscount: {
            source: 'catalog_preset',
            catalogName: 'Military Discount',
            type: 'FIXED',
            value: 120,
            amount: 120,
            label: 'Military Discount',
          },
          totals: {
            manualDiscount: {
              source: 'catalog_preset',
              catalogName: 'Military Discount',
              type: 'FIXED',
              value: 120,
              amount: 120,
              label: 'Military Discount',
            },
          },
          results: {
            ts: [
              { name: 'Standard', v: 6, mo: 72, ann: 864, pa: 144, recommended: false },
              { name: 'Enhanced', v: 9, mo: 96, ann: 1152, pa: 128, recommended: true },
            ],
          },
          recurring: {
            discount: 0,
            monthlyTotal: 86,
            annualAfterDiscount: 1032,
            waveGuardTier: 'Bronze',
            services: [{ service: 'tree_shrub', name: 'Tree & Shrub', mo: 96 }],
          },
          oneTime: { total: 0, items: [], specItems: [] },
          specItems: [],
        },
      },
      monthly_total: 86,
      annual_total: 1032,
      waveguard_tier: 'Bronze',
    });

    expect(payload.frequencies).toEqual([
      expect.objectContaining({
        key: 'standard',
        monthlyBase: 72,
        monthly: 62,
        annual: 744,
        perTreatment: 124,
      }),
      expect.objectContaining({
        key: 'enhanced',
        monthlyBase: 96,
        monthly: 86,
        annual: 1032,
        perTreatment: 114.67,
        manualDiscount: expect.objectContaining({
          label: 'Military Discount',
          amount: 120,
          monthlyAmount: 10,
        }),
      }),
    ]);
    expect(payload.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: 86,
      annualSubtotal: 1032,
    }));
  });

  test('accepted tree and shrub tier rewrites downstream service profile while billing stays monthly', async () => {
    const estimateData = {
      result: {
        results: {
          ts: [
            { name: 'Standard', v: 6, mo: 72, ann: 864, pa: 144 },
            { name: 'Enhanced', v: 9, mo: 96, ann: 1152, pa: 128, selected: true },
          ],
        },
        recurring: {
          discount: 0,
          monthlyTotal: 96,
          annualAfterDiscount: 1152,
          waveGuardTier: 'Bronze',
          services: [{ service: 'tree_shrub', name: 'Tree & Shrub', mo: 96 }],
        },
        oneTime: { total: 0, items: [], specItems: [] },
        specItems: [],
      },
    };
    const payload = await buildPricingBundle({
      id: 'estimate-public-tree-shrub-accepted-standard-test',
      estimate_data: estimateData,
      monthly_total: 96,
      annual_total: 1152,
      waveguard_tier: 'Bronze',
    });
    const standard = payload.frequencies.find((frequency) => frequency.key === 'standard');

    const nextData = applySelectedTreeShrubTierToEstimateData(estimateData, standard);
    const service = nextData.result.recurring.services[0];
    const profile = estimateSlotAvailability.resolveEstimateSlotProfile({
      service_interest: 'Tree & Shrub',
      estimate_data: nextData,
    }, { selectedFrequency: 'standard' });

    expect(standard).toEqual(expect.objectContaining({
      key: 'standard',
      label: 'Bi-monthly',
      billingFrequencyKey: 'monthly',
    }));
    expect(service).toEqual(expect.objectContaining({
      service: 'tree_shrub',
      serviceKey: 'tree_shrub_program',
      service_key: 'tree_shrub_program',
      name: 'Bi-Monthly Tree & Shrub Care Service',
      mo: 72,
      monthly: 72,
      annual: 864,
      annualAfterDiscount: 864,
      perTreatment: 144,
      visitsPerYear: 6,
      frequency: 'bi_monthly',
      tierKey: 'standard',
      tierLabel: 'Bi-monthly',
      billingFrequencyKey: 'monthly',
    }));
    expect(nextData.result.recurring).toEqual(expect.objectContaining({
      monthlyTotal: 72,
      annualAfterDiscount: 864,
    }));
    expect(nextData.result.results.ts).toEqual([
      expect.objectContaining({ name: 'Standard', selected: true, isSelected: true }),
      expect.objectContaining({ name: 'Enhanced', selected: false, isSelected: false }),
    ]);
    expect(profile.serviceLabel).toContain('6x Bi-Monthly Tree & Shrub Care Service');
    expect(estimateData.result.recurring.services[0].mo).toBe(96);
  });

  test('phase 0 mosquito recurring contract uses mosquito copy without pest gates', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-phase-0-mosquito-recurring-test',
      estimate_data: {
        result: {
          results: {
            mq: [
              { n: 'Seasonal Mosquito Program (9 visits)', v: 9, pv: 110, recommended: true },
              { n: 'Monthly Mosquito Program (12 visits)', v: 12, pv: 95 },
            ],
            mqMeta: { pr: 1.2, ri: 0, treatableSqFt: 8250 },
          },
          recurring: {
            monthlyTotal: 82.5,
            annualAfterDiscount: 990,
            services: [
              { service: 'mosquito', name: 'Mosquito (Seasonal Mosquito Program)', mo: 82.5, perTreatment: 110, visitsPerYear: 9 },
            ],
          },
          oneTime: {
            total: 275,
            items: [{
              service: 'one_time_mosquito',
              name: 'One-Time Mosquito Treatment',
              price: 275,
              detail: 'Rain re-spray guarantee',
            }],
            specItems: [],
          },
          specItems: [],
        },
      },
      monthly_total: 82.5,
      annual_total: 990,
      onetime_total: 275,
      waveguard_tier: 'Bronze',
      show_one_time_option: true,
    });

    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'mosquito',
      label: 'Mosquito',
      isPest: false,
      isRecurring: true,
      copy: expect.objectContaining({
        headline: 'Hey {first}, choose your mosquito control option.',
      }),
    }));
    expect(payload.services[0].frequencies.map((frequency) => frequency.key)).toEqual(['seasonal9', 'monthly12']);
    expect(payload.services[0].frequencies[0]).toEqual(expect.objectContaining({
      label: 'Seasonal',
      monthly: 82.5,
      perTreatment: 110,
      visitsPerYear: 9,
      serviceCategory: 'mosquito',
    }));
    expect(payload.services[0].frequencies[1]).toEqual(expect.objectContaining({
      label: 'Monthly',
      monthly: 95,
      perTreatment: 95,
      visitsPerYear: 12,
      serviceCategory: 'mosquito',
    }));
    expect(payload.anchorOneTimePrice).toBe(275);
    expect(payload.oneTimeBreakdown.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: 'one_time_mosquito',
        label: 'One-Time Mosquito Treatment',
        amount: 275,
      }),
    ]));
    expect(payload.renderFlags).toEqual(expect.objectContaining({
      // Mosquito is a WaveGuard-membership service (setup fee + tier), but it is
      // not pest, so the pest-specific add-on gates stay off.
      showWaveGuardSetupFee: true,
      showPestRecurringAddOns: false,
      showOneTimePestAddOns: false,
    }));
    expect(payload.askChips).toContain('How long does each visit last?');
    expect(payload.askChips).toContain('What about my pool area?');
    expect(payload.askChips).not.toContain('What products do you use?');
  });

  test('German Roach Cleanout contract surfaces roach specialty chips, not generic ant chips', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-german-roach-askchips-test',
      estimate_data: {
        result: {
          oneTime: {
            total: 450,
            items: [{ service: 'german_roach', name: 'German Roach Cleanout — 3 Visit Program', price: 450, visits: 3 }],
          },
          recurring: { services: [] },
        },
      },
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 450,
      waveguard_tier: 'Bronze',
    });

    // German roach classifies as generic pest_control; the roach prompts lead
    // and the generic pest service chips are dropped (billing chips kept), so
    // the React path matches the server-rendered page.
    expect(payload.askChips.slice(0, 3)).toEqual([
      'How do you get rid of German roaches?',
      'How long until the roaches are gone?',
      'Are pets and kids safe?',
    ]);
    expect(payload.askChips).not.toContain('How do you handle ants?');
    expect(payload.askChips).not.toContain('Can you treat inside?');
    expect(payload.askChips.length).toBeLessThanOrEqual(6);
  });

  test('phase 0 render flags do not expose WaveGuard setup or pest add-ons for one-time-only quotes', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-phase-0-onetime-guard-test',
      estimate_data: {
        result: {
          oneTime: {
            total: 725,
            items: [{ service: 'termite_trenching', name: 'Termite Trenching', price: 725 }],
          },
          recurring: { services: [] },
        },
      },
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 725,
      waveguard_tier: 'Bronze',
    });

    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'termite_trenching',
      isRecurring: false,
      isPest: false,
    }));
    expect(payload.combinedRecurring).toBeNull();
    expect(payload.renderFlags).toEqual(expect.objectContaining({
      showWaveGuardSetupFee: false,
      showWaveGuardTierUi: false,
      showWaveGuardPerks: false,
      showPestRecurringAddOns: false,
      showOneTimePestAddOns: false,
    }));
  });

  test('pre-slab one-time quotes use pre-slab category and copy instead of trenching', async () => {
    expect(deriveServiceCategory({}, [], [{
      service: 'pre_slab_termiticide',
      name: 'Pre-Slab Termiticide Treatment',
      price: 225,
    }])).toBe('pre_slab_termiticide');
    expect(deriveServiceCategory({}, [{ name: 'Pre-Slab Termite Treatment' }], []))
      .toBe('pre_slab_termiticide');
    expect(deriveServiceCategory({ inputs: { services: { preSlabTermiticide: true } } }, [], []))
      .toBe('pre_slab_termiticide');

    const payload = await buildPricingBundle({
      id: 'estimate-public-phase-0-preslab-category-test',
      estimate_data: {
        result: {
          oneTime: {
            total: 225,
            items: [{
              service: 'pre_slab_termiticide',
              name: 'Pre-Slab Termiticide Treatment',
              price: 225,
              warrantyStatus: 'No extended warranty selected.',
            }],
          },
          recurring: { services: [] },
        },
      },
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 225,
      waveguard_tier: 'Bronze',
    });

    expect(payload.services).toHaveLength(1);
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'pre_slab_termiticide',
      label: 'Pre-Slab Termiticide Treatment',
      isRecurring: false,
      isPest: false,
      copy: expect.objectContaining({
        headline: "Hey {first}, here's your pre-slab termite treatment quote.",
      }),
    }));
    expect(payload.askChips).toContain('Do I get documentation?');
    expect(payload.askChips).not.toContain('How long does the barrier last?');
  });

  test('deriveServiceCategory returns pest, trenching, and bundle categories from normalized services', () => {
    expect(deriveServiceCategory({}, [{ name: 'Pest Control' }], [])).toBe('pest_control');
    expect(deriveServiceCategory({}, [{ name: 'Rodent Remediation' }], [])).toBe('rodent');
    expect(deriveServiceCategory({}, [], [{ service: 'trenching', name: 'Trenching', price: 500 }]))
      .toBe('termite_trenching');
    expect(deriveServiceCategory({ inputs: { svcOnetimeMosquito: true } }, [], []))
      .toBe('mosquito');
    expect(deriveServiceCategory({}, [{ service: 'lawn_care', name: 'Lawn Care' }], [{ service: 'one_time_pest', name: 'One-Time Pest', price: 200 }]))
      .toBe('bundle');
  });

  test('quote-required frequencies preserve null pricing and roll up to pricing quote state', async () => {
    const pricing = await buildPricingBundle({
      id: 'estimate-public-phase-0-quote-frequency-contract-test',
      estimate_data: {
        sendSnapshot: {
          pricingBundle: {
            source: 'snapshot_fixture',
            waveGuardTier: 'Bronze',
            frequencies: [{
              key: 'manual',
              label: 'Manual quote',
              kind: 'quote_required',
              monthly: null,
              annual: null,
            }],
          },
        },
        result: {
          recurring: {
            services: [{ name: 'Pest Control' }],
          },
        },
      },
      waveguard_tier: 'Bronze',
    });

    expect(pricing.services[0].frequencies[0]).toEqual(expect.objectContaining({
      key: 'manual',
      monthly: null,
      annual: null,
      quoteRequired: true,
    }));
    expect(pricing.quoteRequired).toBe(true);
    expect(resolveEstimateQuoteRequirement(pricing)).toEqual(expect.objectContaining({
      quoteRequired: true,
    }));
  });

  test('quote-required pricing rolls into the acceptance contract', async () => {
    const pricing = await buildPricingBundle({
      id: 'estimate-public-phase-0-quote-contract-test',
      estimate_data: {
        result: {
          specItems: [{
            service: 'commercial_pest',
            name: 'Commercial Pest Control',
            price: null,
            quoteRequired: true,
            reason: 'Commercial pest requires manual quote.',
          }],
        },
      },
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
    });
    const quoteRequirement = resolveEstimateQuoteRequirement(pricing);

    expect(pricing.quoteRequired).toBe(true);
    expect(buildEstimateAcceptanceContract({ quoteRequirement })).toEqual({
      mode: 'quote_required',
      ctaLabel: 'Call Waves',
      reason: 'Commercial pest requires manual quote.',
    });
  });

  test('linked existing appointments replace slot-pick acceptance contract', () => {
    expect(buildEstimateAcceptanceContract({
      quoteRequirement: { quoteRequired: false },
      existingAppointment: {
        id: 'svc-123',
        scheduled_date: '2026-06-03',
        window_start: '09:00:00',
        window_end: '11:00:00',
        window_display: 'Wednesday, June 3 · 9:00 AM-11:00 AM',
        service_type: 'Initial Pest Control',
        status: 'confirmed',
      },
    })).toEqual({
      mode: 'existing_appointment',
      ctaLabel: 'Confirm invoice option',
      reason: null,
      appointment: {
        id: 'svc-123',
        scheduledDate: '2026-06-03',
        windowStart: '09:00',
        windowEnd: '11:00',
        windowDisplay: 'Wednesday, June 3 · 9:00 AM-11:00 AM',
        serviceType: 'Initial Pest Control',
        status: 'confirmed',
      },
    });
  });

  test('server-rendered existing appointments route pay choices through existing appointment flow', () => {
    const html = renderPage('existing-appt-token', {
      id: 'estimate-existing-appt',
      status: 'sent',
      customerName: 'Pat Customer',
      address: '123 Main St',
      monthlyTotal: 95,
      annualTotal: 1140,
      onetimeTotal: 0,
      tier: 'Silver',
      existingAppointment: {
        id: 'svc-123',
        scheduledDate: '2026-06-03',
        windowStart: '09:00',
        windowEnd: '11:00',
        windowDisplay: 'Wednesday, June 3 - 9:00 AM-11:00 AM',
        serviceType: 'Initial Pest Control',
        status: 'confirmed',
      },
    }, {
      result: {
        recurring: { services: [{ name: 'Pest Control', mo: 95 }] },
        oneTime: { items: [] },
        results: { pestTiers: [{ label: 'Quarterly', mo: 95, pa: 285, apps: 4 }] },
      },
    });

    expect(html).toContain('const EXISTING_APPOINTMENT_ID = "svc-123";');
    expect(html).toContain('if (EXISTING_APPOINTMENT_ID) pickExistingAppointmentPref(b.dataset.payPref);');
    expect(html).toContain('else pickPaymentPref(b.dataset.payPref);');
  });

  test('server-rendered accept shows optional invoice payment for invoice-mode accepts', () => {
    const html = renderPage('invoice-mode-token', {
      id: 'estimate-invoice-mode',
      status: 'sent',
      customerName: 'Pat Customer',
      address: '123 Main St',
      monthlyTotal: 95,
      annualTotal: 1140,
      onetimeTotal: 0,
      tier: 'Silver',
      bill_by_invoice: true,
    }, {
      result: {
        recurring: { services: [{ name: 'Pest Control', mo: 95 }] },
        oneTime: { items: [] },
        results: { pestTiers: [{ label: 'Quarterly', mo: 95, pa: 285, apps: 4 }] },
      },
    });

    expect(html).toContain("if (data.nextStep === 'pay_invoice' && data.invoicePayUrl) {");
    expect(html).toContain('showInvoiceOptionalSuccess(data);');
    expect(html).toContain('Payment is optional right now.');
    expect(html).toContain('I will pay later');
  });

  test('public pricing bundle preserves saved manual recurring discounts', async () => {
    const estimateData = savedAdminEstimateData();
    estimateData.result.manualDiscount = {
      source: 'catalog_preset',
      presetKey: 'military',
      catalogName: 'Military Discount',
      catalogCategory: 'manual_recurring_estimate_discount',
      type: 'PERCENT',
      value: 10,
      amount: 60,
      label: 'Military Discount',
    };
    estimateData.result.totals = { manualDiscount: estimateData.result.manualDiscount };

    const payload = await buildPricingBundle({
      id: 'estimate-public-manual-discount-test',
      estimate_data: estimateData,
      monthly_total: 45,
      annual_total: 540,
      onetime_total: 2084,
      waveguard_tier: 'Bronze',
    });

    expect(payload.frequencies[0]).toEqual(expect.objectContaining({
      monthly: 45,
      annual: 540,
      manualDiscount: expect.objectContaining({
        label: 'Military Discount',
        amount: 60,
        monthlyAmount: 5,
      }),
    }));
    expect(payload.combinedRecurring?.manualDiscount).toEqual(expect.objectContaining({
      label: 'Military Discount',
      amount: 60,
      monthlyAmount: 5,
    }));
  });

  test('server-rendered customer estimate shows manual recurring discount row', () => {
    const html = renderPage('manual-discount-token', {
      status: 'sent',
      customerName: 'Pat Customer',
      address: '123 Main St',
      monthlyTotal: 45,
      annualTotal: 540,
      onetimeTotal: 0,
      tier: 'Bronze',
    }, {
      result: {
        manualDiscount: {
          source: 'catalog_preset',
          presetKey: 'military',
          catalogName: 'Military Discount',
          catalogCategory: 'manual_recurring_estimate_discount',
          type: 'PERCENT',
          value: 10,
          amount: 60,
          label: 'Military Discount',
        },
        recurring: {
          discount: 0,
          monthlyTotal: 45,
          annualAfterDiscount: 540,
          services: [{ name: 'Pest Control', mo: 50 }],
        },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: { pest: { apps: 4 } },
      },
    });

    expect(html).toContain('manual-discount-row');
    expect(html).toContain('Military Discount');
    expect(html).toContain('-$15 / quarter');
  });

  test('public pricing bundle exposes annual prepay for lawn-only estimates', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-lawn-only-prepay-test',
      estimate_data: {
        result: {
          recurring: {
            discount: 0,
            waveGuardTier: 'Bronze',
            monthlyTotal: 87,
            annualAfterDiscount: 1044,
            services: [{
              service: 'lawn_care',
              name: 'Lawn Care',
              mo: 87,
              perTreatment: 116,
              visitsPerYear: 9,
            }],
          },
          oneTime: {
            total: 99,
            membershipFee: 99,
            items: [{ service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 }],
          },
        },
      },
      monthly_total: 87,
      annual_total: 1044,
      onetime_total: 99,
      waveguard_tier: 'Bronze',
    });

    expect(payload.annualPrepayEligible).toBe(true);
    // Lawn-only carries no WaveGuard setup fee — prepay earns a 5% discount, not a
    // setup waiver — so no waveguard_setup fee is exposed.
    expect(payload.setupFee).toBeNull();
    expect(payload.firstVisitFees).not.toContainEqual(expect.objectContaining({
      service: 'waveguard_setup',
    }));
  });

  test('lawn-only public frequencies include and preserve 4-application basic tier', () => {
    const estData = {
      result: {
        results: {
          lawn: [
            { tier: 'basic', label: '4x applications/yr', v: 4, mo: 80, ann: 960, pa: 240, recommended: true },
            { tier: 'standard', label: '6x applications/yr', v: 6, mo: 90, ann: 1080, pa: 180 },
            { tier: 'enhanced', label: '9x applications/yr', v: 9, mo: 105, ann: 1260, pa: 140 },
            { tier: 'premium', label: '12x applications/yr', v: 12, mo: 120, ann: 1440, pa: 120 },
          ],
        },
        recurring: {
          services: [
            { service: 'lawn_care', name: 'Lawn Care', mo: 80, perTreatment: 240, visitsPerYear: 4 },
          ],
        },
      },
    };

    const frequencies = lawnFrequenciesFromResultStats(estData);
    expect(frequencies.map((frequency) => frequency.key)).toEqual(['basic', 'standard', 'enhanced', 'premium']);
    expect(frequencies[0]).toMatchObject({
      key: 'basic',
      label: 'Quarterly',
      serviceCategory: 'lawn_care',
      serviceTierKey: 'basic',
      monthly: 80,
      annual: 960,
      perTreatment: 240,
      visitsPerYear: 4,
      perServiceTreatments: [
        expect.objectContaining({ service: 'lawn_care', perTreatment: 240, visitsPerYear: 4 }),
      ],
    });

    const nextData = applySelectedLawnTierToEstimateData(estData, frequencies[0]);
    expect(nextData.result.recurring.services[0]).toMatchObject({
      service: 'lawn_care',
      serviceKey: 'lawn_care_quarterly',
      frequency: 'quarterly',
      tier: 'basic',
      visitsPerYear: 4,
      perTreatment: 240,
    });
    expect(nextData.result.results.lawn.map((row) => ({ tier: row.tier, selected: row.selected }))).toEqual([
      { tier: 'basic', selected: true },
      { tier: 'standard', selected: false },
      { tier: 'enhanced', selected: false },
      { tier: 'premium', selected: false },
    ]);
  });

  test('public pricing bundle: termite bait stations carry no setup fee but stay prepay-eligible', async () => {
    const payload = await buildPricingBundle({
      id: 'estimate-public-termite-bait-prepay-test',
      estimate_data: {
        result: {
          recurring: {
            waveGuardTier: 'Bronze',
            monthlyTotal: 45,
            annualAfterDiscount: 540,
            services: [{
              service: 'termite_bait',
              name: 'Termite Bait Stations',
              mo: 45,
              perTreatment: 135,
              visitsPerYear: 4,
            }],
          },
          oneTime: {
            total: 655,
            membershipFee: 99,
            items: [
              { service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 },
              { service: 'termite_bait_installation', name: 'Advance Installation', price: 556, detail: '20 stations · 196 linear ft perimeter' },
            ],
          },
          specItems: [],
          results: {
            tmBait: { perim: 196, sta: 20 },
          },
        },
      },
      monthly_total: 45,
      annual_total: 540,
      onetime_total: 655,
      waveguard_tier: 'Bronze',
    });

    // Termite carries no WaveGuard setup fee under the unified model, but it is
    // still annual-prepay eligible (5% discount). A stale cached $99 membership
    // fee is netted out via a one_time_adjustment so it is never charged; the
    // bait-station install stays a separate one-time charge.
    expect(payload.annualPrepayEligible).toBe(true);
    expect(payload.setupFee).toBeNull();
    expect(payload.firstVisitFees).not.toContainEqual(expect.objectContaining({
      service: 'waveguard_setup',
    }));
    expect(payload.services[0]).toEqual(expect.objectContaining({
      key: 'termite_bait',
      setupFee: null,
    }));
    expect(payload.renderFlags.showWaveGuardSetupFee).toBe(false);
    expect(payload.oneTimeBreakdown.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: 'termite_bait_installation', amount: 556 }),
      expect.objectContaining({ service: 'one_time_adjustment', amount: -99 }),
    ]));
    expect(payload.oneTimeBreakdown.total).toBe(556);
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

  test('treats zero-dollar placeholder recurring rows as one-time-only', () => {
    const oneTimeWithPlaceholderRecurring = {
      result: {
        recurring: {
          serviceCount: 1,
          monthlyTotal: 0,
          annualAfterDiscount: 0,
          services: [{ service: 'pest_control', name: 'Pest Control', mo: 0 }],
        },
        oneTime: {
          total: 249,
          items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 249 }],
        },
      },
    };

    const estimate = {
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 249,
      show_one_time_option: false,
    };

    expect(isStructuralOneTimeOnlyEstimate(oneTimeWithPlaceholderRecurring, estimate)).toBe(true);
    expect(defaultServiceModeForEstimate(oneTimeWithPlaceholderRecurring, estimate)).toBe('one_time');
  });

  test('keeps quote-required zero-dollar recurring rows in recurring mode', () => {
    const quoteRequiredRecurring = {
      result: {
        recurring: {
          serviceCount: 1,
          monthlyTotal: 0,
          annualAfterDiscount: 0,
          services: [{ service: 'pest_control', name: 'Pest Control', mo: 0, quoteRequired: true }],
        },
        oneTime: {
          total: 249,
          items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 249 }],
        },
      },
    };

    const estimate = {
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 249,
      show_one_time_option: false,
    };

    expect(isStructuralOneTimeOnlyEstimate(quoteRequiredRecurring, estimate)).toBe(false);
    expect(defaultServiceModeForEstimate(quoteRequiredRecurring, estimate)).toBe('recurring');
  });

  test('keeps row-priced recurring estimates in recurring mode even when totals are stale', () => {
    const recurringWithRowAmount = {
      result: {
        recurring: {
          serviceCount: 1,
          monthlyTotal: 0,
          annualAfterDiscount: 0,
          services: [{ service: 'pest_control', name: 'Pest Control', mo: 89 }],
        },
        oneTime: {
          total: 249,
          items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 249 }],
        },
      },
    };

    expect(isStructuralOneTimeOnlyEstimate(recurringWithRowAmount, {
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 249,
    })).toBe(false);
  });

  test('detects top-level specialty-only estimates as one-time-only', () => {
    const specialtyOnly = {
      result: {
        specItems: [{ service: 'rodent_sanitation', name: 'Rodent Sanitation', price: 650 }],
      },
    };

    expect(isStructuralOneTimeOnlyEstimate(specialtyOnly, { monthly_total: 0, annual_total: 0 })).toBe(true);
    expect(defaultServiceModeForEstimate(specialtyOnly, { monthly_total: 0, annual_total: 0 })).toBe('one_time');
  });

  test('engine-invocation pricing anchors stored rodent trapping totals when rerun has no recurring service', async () => {
    const bundle = await buildPricingBundle({
      id: 'estimate-public-rodent-trapping-anchor-test',
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 555,
      waveguard_tier: 'Bronze',
      estimate_data: {
        engineInputs: {
          propertyType: 'single_family',
          homeSqFt: 3267,
          lotSqFt: 27442,
          stories: 1,
          services: {},
        },
        result: {
          recurring: {
            services: [],
            monthlyTotal: 0,
            annualAfterDiscount: 0,
          },
          oneTime: {
            total: 555,
            specItems: [{
              service: 'rodent_trapping',
              name: 'Rodent Trapping',
              price: 555,
              detail: 'Unlimited trap checks/callbacks for 14 days | moderate pressure',
            }],
          },
        },
      },
    });

    expect(bundle.source).toBe('engine_invocation');
    expect(bundle.anchorOneTimePrice).toBe(555);
    expect(bundle.defaultServiceMode).toBe('one_time');
    expect(bundle.oneTimeBreakdown.items).toContainEqual(expect.objectContaining({
      service: 'rodent_trapping',
      label: 'Rodent Trapping',
      amount: 555,
    }));
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

  test('unresolved St. Augustine dethatching approval blocks public acceptance', async () => {
    const estimateData = {
      result: {
        oneTime: {
          total: 150,
          items: [{
            service: 'dethatching',
            name: 'Dethatching',
            price: 150,
            requiresManagerApproval: true,
            managerApprovalReason: 'st_augustine_dethatching',
            managerApprovalSatisfied: false,
          }],
        },
      },
    };

    const payload = await buildPricingBundle({
      id: 'estimate-public-st-aug-dethatching-approval-test',
      estimate_data: estimateData,
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 150,
      waveguard_tier: 'Bronze',
    });
    const quoteRequirement = resolveEstimateQuoteRequirement(payload, estimateData);

    expect(payload.quoteRequired).toBe(true);
    expect(quoteRequirement).toEqual(expect.objectContaining({
      quoteRequired: true,
      reason: 'st_augustine_dethatching',
    }));
    expect(buildEstimateAcceptanceContract({ quoteRequirement })).toEqual({
      mode: 'quote_required',
      ctaLabel: 'Call Waves',
      reason: 'st_augustine_dethatching',
    });
  });

  test('requiresCustomQuote one-time rows preserve customer-facing quote reasons', () => {
    const breakdown = normalizeOneTimeBreakdown({
      result: {
        oneTime: {
          total: 0,
          specItems: [{
            service: 'flea_package',
            name: 'Flea Treatment Package',
            price: null,
            requiresCustomQuote: true,
            customQuoteReason: 'Exterior yard area exceeds automatic quote threshold.',
            manualReviewReasons: ['large_lot'],
          }],
        },
      },
    });

    expect(breakdown.quoteRequired).toBe(true);
    expect(breakdown.items).toContainEqual(expect.objectContaining({
      service: 'flea_package',
      kind: 'quote_required',
      amount: null,
      quoteRequired: true,
      requiresCustomQuote: true,
      reason: 'Exterior yard area exceeds automatic quote threshold.',
      customQuoteReason: 'Exterior yard area exceeds automatic quote threshold.',
      manualReviewReasons: ['large_lot'],
    }));
    expect(resolveEstimateQuoteRequirement({ oneTimeBreakdown: breakdown })).toEqual(expect.objectContaining({
      quoteRequired: true,
      reason: 'Exterior yard area exceeds automatic quote threshold.',
    }));
  });

  test('quote-required result spec rows lock public commercial manual drafts', async () => {
    const estimateData = {
      result: {
        specItems: [{
          service: 'commercial_pest',
          name: 'Commercial Pest Control',
          price: null,
          quoteRequired: true,
          reason: 'Commercial pest requires manual quote or commercial pilot pricing.',
        }],
      },
    };

    const payload = await buildPricingBundle({
      id: 'estimate-public-commercial-manual-test',
      estimate_data: estimateData,
      monthly_total: 0,
      annual_total: 0,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
    });

    expect(payload.quoteRequired).toBe(true);
    expect(resolveEstimateQuoteRequirement(payload)).toEqual(expect.objectContaining({
      quoteRequired: true,
      reason: 'Commercial pest requires manual quote or commercial pilot pricing.',
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

  test('server-rendered quote-required page explains why pricing is blocked', () => {
    const html = renderPage('quote-reason-token', {
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
        oneTime: {
          total: 0,
          specItems: [{
            service: 'flea_package',
            name: 'Flea Treatment Package',
            price: null,
            requiresCustomQuote: true,
            customQuoteReason: 'Exterior yard area exceeds automatic quote threshold.',
          }],
        },
      },
    });

    expect(html).toContain('Quote Required');
    expect(html).toContain('Exterior yard area exceeds automatic quote threshold.');
  });

  test('server-rendered termite trenching quote-required page avoids zero-price acceptance copy', () => {
    const html = renderPage('termite-trenching-quote-token', {
      status: 'quote_required',
      quoteRequired: true,
      customerName: 'Terry Customer',
      address: '321 Barrier Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 725,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: {
          items: [{
            service: 'trenching',
            name: 'Termite Trenching',
            price: 725,
            quoteRequired: true,
          }, {
            service: 'inspection_fee',
            name: 'Inspection Fee',
            price: 50,
          }],
          specItems: [],
        },
        specItems: [],
      },
    });

    expect(html).toContain('termite trenching quote');
    expect(html).toContain('Quote Required');
    expect(html).toContain('Inspection required before final pricing.');
    expect(html).toContain('Inspection required to finish this quote');
    expect(html).not.toContain('$0.00');
    expect(html).not.toContain('$0</span>');
    expect(html).not.toContain('$725');
    expect(html).not.toContain('$50');
    expect(html).not.toContain('$775');
    expect(html).not.toContain('class="cta pick-time-cta"');
    expect(html).not.toContain('id="booking-card"');
    expect(html).not.toContain('Find a date & time that works for you');
  });

  test('server-rendered one-time termite estimates include termite ask prompt', () => {
    const html = renderPage('termite-onetime-token', {
      status: 'sent',
      customerName: 'Terry Customer',
      address: '321 Barrier Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 725,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: {
          items: [{ service: 'trenching', name: 'Termite Trenching', price: 725 }],
          specItems: [],
        },
        specItems: [],
      },
    });

    // Trenching is a liquid barrier, not a bait system — the chip matches the method.
    expect(html).toContain('data-estimate-ask-prompt="How long does the barrier last?"');
    expect(html).not.toContain('data-estimate-ask-prompt="How does the bait work?"');
  });

  test('server-rendered pre-slab estimate uses pre-slab ask prompt and never duplicates its copy', () => {
    const html = renderPage('preslab-onetime-token', {
      status: 'sent',
      customerName: 'Terry Customer',
      address: '321 Barrier Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 225,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: {
          total: 225,
          items: [{
            service: 'pre_slab_termiticide',
            name: 'Pre-Slab Termiticide Treatment',
            price: 225,
            warrantyStatus: 'No extended warranty selected.',
          }],
          specItems: [],
        },
        specItems: [],
      },
    });

    // Pre-slab is a soil treatment, not a bait system — the chip matches the method.
    expect(html).toContain('data-estimate-ask-prompt="How does pre-slab treatment work?"');
    expect(html).not.toContain('data-estimate-ask-prompt="How does the bait work?"');

    // The service note and the warranty assurance each render exactly once —
    // they used to print as one combined sentence in both the one-time note and
    // the mini-guarantee, which showed the customer the same text twice.
    const noteOccurrences = (html.match(/Includes pre-slab soil treatment for the measured slab area\./g) || []).length;
    const warrantyOccurrences = (html.match(/Warranty terms depend on the selected warranty option\./g) || []).length;
    expect(noteOccurrences).toBe(1);
    expect(warrantyOccurrences).toBe(1);
    expect(html).toContain('No extended warranty selected.');
  });

  test('server-rendered Bora-Care estimate uses Bora-Care copy + AI card + chips, not pest defaults', () => {
    // Bora-Care comes in as service `bora_care`; classify it instead of letting
    // it fall through to the pest_control default.
    expect(deriveServiceCategory({}, [], [{ service: 'bora_care', name: 'Bora-Care', price: 1051 }]))
      .toBe('bora_care');

    const html = renderPage('boracare-onetime-token', {
      status: 'sent',
      customerName: 'Hannah Customer',
      address: '12 Builder Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 1051,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: {
          total: 1051,
          items: [{ service: 'bora_care', name: 'Bora-Care', price: 1051 }],
          specItems: [],
        },
        specItems: [],
      },
    });

    // Hero + Waves AI card are Bora-Care-specific, not the generic/pest fallback.
    // (The hero apostrophe is HTML-escaped, so match without it.)
    expect(html).toContain('your Bora-Care wood treatment quote.');
    expect(html).toContain('Waves AI reviewed your wood-treatment areas before pricing this estimate');
    expect(html).toContain('the Bora-Care application rate to price this treatment.');
    expect(html).not.toContain('choose your pest control option');
    expect(html).not.toContain('to show the details behind your WaveGuard plan.');

    // Description note + treatment-detail label replace the bare "One-time service".
    expect(html).toContain('Bora-Care is a borate wood treatment applied to the measured attic and surface areas.');
    expect(html).toContain('Bora-Care wood treatment');

    // Ask Waves surfaces a Bora-Care service chip + a Bora-Care-worded safety chip
    // (so clicking it routes to the borate answer); never the bait/pest chips it
    // used to fall back to, and not the generic safety chip on a Bora-Care-only quote.
    expect(html).toContain('data-estimate-ask-prompt="What does Bora-Care treat?"');
    expect(html).toContain('data-estimate-ask-prompt="Is Bora-Care safe for pets &amp; kids?"');
    expect(html).not.toContain('data-estimate-ask-prompt="Are pets and kids safe?"');
    expect(html).not.toContain('data-estimate-ask-prompt="How does the bait work?"');
    expect(html).not.toContain('data-estimate-ask-prompt="How do you handle ants?"');

    // No guarantee/coverage line for Bora-Care — the wrong pest callback is gone
    // and no mini-guarantee renders.
    expect(html).not.toContain('30-day callback period if pests return');
    expect(html).not.toContain('class="mini-guarantee"');
  });

  test('Bora-Care wins over the termite-install heuristic and shows no bait chip', () => {
    // Canonical service key `bora_care` must classify ahead of the generic
    // termite-install heuristic even with install/termite wording in the label.
    const item = { service: 'bora_care', name: 'Termite Bora-Care Install', price: 900 };
    expect(deriveServiceCategory({}, [], [item])).toBe('bora_care');

    const html = renderPage('boracare-termite-label-token', {
      status: 'sent',
      customerName: 'Hannah Customer',
      address: '12 Builder Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 900,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: { total: 900, items: [item], specItems: [] },
        specItems: [],
      },
    });

    expect(html).toContain('data-estimate-ask-prompt="What does Bora-Care treat?"');
    expect(html).not.toContain('data-estimate-ask-prompt="How does the bait work?"');
  });

  test('mixed Bora-Care + pre-slab one-time quote keeps the pre-slab warranty line', () => {
    // Suppressing the mini-guarantee for Bora-Care must not hide another billable
    // row's warranty — only a Bora-Care-only mix omits the line.
    const html = renderPage('boracare-preslab-mix-token', {
      status: 'sent',
      customerName: 'Hannah Customer',
      address: '12 Builder Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 1300,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: {
          total: 1300,
          items: [
            { service: 'bora_care', name: 'Bora-Care', price: 1051 },
            { service: 'pre_slab_termiticide', name: 'Pre-Slab Termiticide Treatment', price: 249, warrantyStatus: 'No extended warranty selected.' },
          ],
          specItems: [],
        },
        specItems: [],
      },
    });

    expect(html).toContain('class="mini-guarantee"');
    expect(html).toContain('Warranty terms depend on the selected warranty option.');
  });

  test('Bora-Care-only quote with a member-discount row still renders Bora-Care copy and no pest callback', () => {
    // The real estimate carries a "WaveGuard Member Discount" one-time row; that
    // adjustment line must not knock the quote out of the Bora-Care-only path.
    const html = renderPage('boracare-discount-token', {
      status: 'sent',
      customerName: 'Hannah Customer',
      address: '12 Builder Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 893.35,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: {
          total: 893.35,
          items: [
            { service: 'bora_care', name: 'Bora-Care', price: 1051 },
            { service: 'one_time_adjustment', name: 'WaveGuard Member Discount', price: -157.65 },
          ],
          specItems: [],
        },
        specItems: [],
      },
    });

    expect(html).toContain('your Bora-Care wood treatment quote.');
    expect(html).toContain('Waves AI reviewed your wood-treatment areas before pricing this estimate');
    expect(html).not.toContain('30-day callback period if pests return');
    expect(html).not.toContain('class="mini-guarantee"');
  });

  test('Bora-Care invoice label resolves to the category name, not the raw service key', () => {
    // Engine-backed rows can arrive with only `service: 'bora_care'` and no name;
    // the customer-facing label must not surface "bora_care".
    const label = buildOneTimeInvoiceServiceLabel({
      estimate: {},
      estData: { result: { recurring: { services: [] }, oneTime: { total: 1051, items: [{ service: 'bora_care', price: 1051 }] } } },
      oneTimeList: [{ service: 'bora_care', price: 1051 }],
    });
    expect(label).toBe('Bora-Care Wood Treatment');
  });

  const boraCareAssistantContext = {
    company: { phone: '941-555-0100' },
    oneTime: { items: [{ service: 'bora_care', name: 'Bora-Care' }] },
  };

  test('Ask Waves Bora-Care chip routes to a Bora-Care answer in the assistant fallback', () => {
    const answer = answerEstimateQuestionFallback('What does Bora-Care treat?', boraCareAssistantContext);
    expect(answer).toMatch(/Bora-Care/);
    expect(answer).toMatch(/wood-boring beetles|wood-decay fungi|termites/);
    expect(answer).not.toMatch(/^I can answer questions/);
  });

  test('engine/nested Bora-Care estimate still surfaces the Bora-Care chip from normalized rows', () => {
    // The Bora-Care row only lives under result.results.oneTime (engine/nested
    // shape); result.oneTime.items is empty, so the raw one-time list the SSR Ask
    // Waves card used to read would miss it. The chips must come from the
    // normalized rows so "What does Bora-Care treat?" still renders.
    const html = renderPage('boracare-engine-token', {
      status: 'sent',
      customerName: 'Hannah Customer',
      address: '12 Builder Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 1051,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        // Engine/nested shape: the billable rows live only under results.oneTime —
        // there is no top-level result.oneTime, so the raw oneTimeItems list is
        // empty. Name-less engine row carries only the canonical service key.
        results: {
          oneTime: { total: 1051, items: [{ service: 'bora_care', price: 1051 }] },
        },
      },
    });

    expect(html).toContain('your Bora-Care wood treatment quote.');
    expect(html).toContain('data-estimate-ask-prompt="What does Bora-Care treat?"');
    expect(html).not.toContain('data-estimate-ask-prompt="How does the bait work?"');
    // Hero treatment name comes from the normalized rows too, so the nested shape
    // shows the Bora-Care name instead of falling back to "WaveGuard Bronze" or the
    // raw "bora_care" service key.
    expect(html).toContain('class="choice-treatment-name">Bora-Care Wood Treatment');
    expect(html).not.toContain('class="choice-treatment-name">WaveGuard Bronze');
    expect(html).not.toContain('>bora_care<');
  });

  test('top-level name-less Bora-Care row still resolves the friendly hero treatment name', () => {
    // result.oneTime.items is present but the Bora-Care row carries only the raw
    // service key (no name). The hero name must fall back to the normalized rows,
    // not "WaveGuard {tier}", since the raw names list is empty.
    const html = renderPage('boracare-nameless-token', {
      status: 'sent',
      customerName: 'Hannah Customer',
      address: '12 Builder Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 1051,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: { total: 1051, items: [{ service: 'bora_care', price: 1051 }], specItems: [] },
        specItems: [],
      },
    });

    expect(html).toContain('class="choice-treatment-name">Bora-Care Wood Treatment');
    expect(html).not.toContain('class="choice-treatment-name">WaveGuard Bronze');
    expect(html).not.toContain('>bora_care<');
  });

  test('Ask Waves Bora-Care safety/product question routes to the Bora-Care answer, not generic safety copy', () => {
    // "safe" and "product" both match the generic safety/product branch; on a
    // Bora-Care estimate the Bora-Care branch must be checked first.
    const safeAnswer = answerEstimateQuestionFallback('Is Bora-Care safe?', boraCareAssistantContext);
    expect(safeAnswer).toMatch(/borate treatment applied to bare wood/);
    expect(safeAnswer).not.toMatch(/for every application/);

    const productAnswer = answerEstimateQuestionFallback('What product is used for Bora-Care?', boraCareAssistantContext);
    expect(productAnswer).toMatch(/borate treatment applied to bare wood/);
  });

  test('Bora-Care fallback is scoped to Bora-Care estimates — a wood question on a non-Bora estimate stays generic', () => {
    // The deterministic Bora-Care answer must not fire on an estimate that has no
    // Bora-Care row, or it would imply borate wood treatment is part of the quote.
    const pestContext = {
      company: { phone: '941-555-0100' },
      services: [{ service: 'pest_control', name: 'Pest Control' }],
    };
    const answer = answerEstimateQuestionFallback('Does this cover wood-destroying beetles?', pestContext);
    expect(answer).not.toMatch(/borate treatment applied to bare wood/);
  });

  test('context builder exposes a separately billed Bora-Care one-time row in recurring mode', () => {
    // A recurring estimate that also carries a Bora-Care one-time add-on renders
    // the Bora-Care chip; the assistant context must include the Bora-Care row so
    // the chip's question routes to the Bora-Care answer (not generic copy).
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Hannah Customer',
        waveguard_tier: 'Silver',
        monthly_total: 100,
        annual_total: 1200,
        onetime_total: 1051,
        show_one_time_option: false,
      },
      estData: {
        result: {
          recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 100 }] },
        },
      },
      pricingBundle: {
        anchorOneTimePrice: 1051,
        oneTimeBreakdown: {
          total: 1051,
          items: [{ service: 'bora_care', label: 'Bora-Care', amount: 1051 }],
        },
        frequencies: [{ key: 'monthly', label: 'Monthly', monthly: 100, annual: 1200 }],
      },
      serviceMode: 'recurring',
    });

    expect(context.serviceMode).toBe('recurring');
    expect(context.oneTime?.items).toContainEqual(expect.objectContaining({ service: 'bora_care' }));

    const answer = answerEstimateQuestionFallback('Is Bora-Care safe?', context);
    expect(answer).toMatch(/borate treatment applied to bare wood/);
    expect(answer).not.toMatch(/for every application/);
  });

  test('Bora-Care coverage question routes to the Bora-Care answer, not the generic include list', () => {
    // "cover" matches the include/coverage branch; the Bora-Care branch sits above
    // it so a Bora-Care coverage question gets the borate-specific answer.
    const answer = answerEstimateQuestionFallback('Does Bora-Care cover wood-boring beetles?', boraCareAssistantContext);
    expect(answer).toMatch(/borate treatment applied to bare wood/);
    expect(answer).not.toMatch(/^This .* estimate includes:/);
  });

  test('Bora-Care safety chip text routes to the Bora-Care answer', () => {
    const answer = answerEstimateQuestionFallback('Is Bora-Care safe for pets & kids?', boraCareAssistantContext);
    expect(answer).toMatch(/borate treatment applied to bare wood/);
    expect(answer).not.toMatch(/for every application/);
  });

  test('mixed recurring estimate with a Bora-Care add-on still surfaces the Bora-Care chip', () => {
    // Pest + Lawn + a separately billed Bora-Care one-time row: the Bora-Care chip
    // is prioritized so it survives the two-prompt slice instead of being dropped.
    const html = renderPage('boracare-mixed-chip-token', {
      status: 'sent',
      customerName: 'Hannah Customer',
      address: '12 Builder Way',
      monthlyTotal: 200,
      annualTotal: 2400,
      onetimeTotal: 1051,
      tier: 'Silver',
    }, {
      result: {
        recurring: {
          services: [
            { service: 'pest_control', name: 'Pest Control', mo: 100 },
            { service: 'lawn_care', name: 'Lawn Care', mo: 100 },
          ],
        },
        oneTime: { total: 1051, items: [{ service: 'bora_care', name: 'Bora-Care', price: 1051 }], specItems: [] },
        specItems: [],
      },
    });

    expect(html).toContain('data-estimate-ask-prompt="What does Bora-Care treat?"');
  });

  test('mixed one-time quote with a name-less Bora-Care row names both services in the hero', () => {
    // Name-less Bora-Care row + a named Pre-Slab row: the per-row name builder must
    // represent Bora-Care instead of dropping it because the other row had a name.
    const html = renderPage('boracare-mixed-name-token', {
      status: 'sent',
      customerName: 'Hannah Customer',
      address: '12 Builder Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 1300,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: {
          total: 1300,
          items: [
            { service: 'bora_care', price: 1051 },
            { service: 'pre_slab_termiticide', name: 'Pre-Slab Termiticide Treatment', price: 249 },
          ],
          specItems: [],
        },
        specItems: [],
      },
    });

    expect(html).toMatch(/Bora-Care Wood Treatment[^<]*\+[^<]*Pre-Slab Termiticide Treatment|Pre-Slab Termiticide Treatment[^<]*\+[^<]*Bora-Care Wood Treatment/);
    expect(html).not.toContain('>bora_care<');
    // The service-details table uses the same friendly name, not "One-time service".
    expect(html).toContain('<td>Bora-Care Wood Treatment');
    expect(html).not.toContain('<td>One-time service');
  });

  test('bookingServiceFor routes a Bora-Care label to the Bora-Care booking service, not pest control', () => {
    expect(bookingServiceFor('Bora-Care Wood Treatment')).toEqual({ id: 'bora_care', label: 'Bora-Care Wood Treatment' });
    // Bora-Care is checked before termite, so a "Termite Bora-Care" label still routes to Bora-Care.
    expect(bookingServiceFor('Termite Bora-Care Treatment')).toEqual({ id: 'bora_care', label: 'Bora-Care Wood Treatment' });
    expect(bookingServiceFor('One-Time Pest Control').id).toBe('pest_control');
  });

  test('buildEstimateAskPrompts uses the Bora-Care safety chip only for a Bora-Care-only quote', () => {
    const boraOnly = buildEstimateAskPrompts([], [{ service: 'bora_care', name: 'Bora-Care', price: 1051 }]);
    expect(boraOnly).toContain('Is Bora-Care safe for pets & kids?');
    expect(boraOnly).not.toContain('Are pets and kids safe?');

    // A positive non-Bora billable row (one_time_adjustment) makes it not
    // Bora-Care-only, so the generic safety chip is used instead.
    const mixed = buildEstimateAskPrompts([], [
      { service: 'bora_care', name: 'Bora-Care', price: 1051 },
      { service: 'one_time_adjustment', name: 'Additional treatment area', price: 200 },
    ]);
    expect(mixed).toContain('Are pets and kids safe?');
    expect(mixed).not.toContain('Is Bora-Care safe for pets & kids?');

    // A negative discount row does NOT block Bora-Care-only.
    const withDiscount = buildEstimateAskPrompts([], [
      { service: 'bora_care', name: 'Bora-Care', price: 1051 },
      { service: 'one_time_adjustment', name: 'WaveGuard Member Discount', price: -157.65 },
    ]);
    expect(withDiscount).toContain('Is Bora-Care safe for pets & kids?');
  });

  test('React pricing contract surfaces the Bora-Care chip and friendly label for a recurring estimate with a Bora-Care add-on', () => {
    const contract = attachPublicPricingContract(
      { frequencies: [], oneTimeBreakdown: { total: 1051, items: [{ service: 'bora_care', label: 'bora_care', amount: 1051 }] } },
      {},
      {
        result: {
          recurring: {
            services: [
              { service: 'pest_control', name: 'Pest Control', mo: 100 },
              { service: 'lawn_care', name: 'Lawn Care', mo: 100 },
            ],
          },
        },
      },
    );

    // #3: the Bora-Care chip is present even though the recurring sections are Pest + Lawn.
    expect(contract.askChips).toContain('What does Bora-Care treat?');
    // #5: the raw service-key label is normalized for the client payload.
    expect(contract.oneTimeBreakdown.items[0].label).toBe('Bora-Care Wood Treatment');
  });

  test('on a mixed estimate, a lawn-fungus / shrub-beetle question is not answered with Bora-Care copy', () => {
    const mixedContext = {
      company: { phone: '941-555-0100' },
      serviceMode: 'recurring',
      services: [{ service: 'lawn_care', label: 'Lawn Care', summary: 'Lawn Care - quarterly' }],
      oneTime: { items: [{ service: 'bora_care', label: 'Bora-Care' }] },
    };
    // Bare "fungus"/"beetle" without a wood/borate qualifier stays on the relevant
    // service branch even though the estimate includes Bora-Care.
    expect(answerEstimateQuestionFallback('Do you handle lawn fungus?', mixedContext))
      .not.toMatch(/borate treatment applied to bare wood/);
    // A qualified Bora-Care question still routes to the borate answer.
    expect(answerEstimateQuestionFallback('Does Bora-Care cover wood-boring beetles?', mixedContext))
      .toMatch(/borate treatment applied to bare wood/);
  });

  test('included-services answer lists a separately billed Bora-Care add-on', () => {
    const context = {
      serviceMode: 'recurring',
      waveGuardTier: 'WaveGuard Silver',
      services: [{ service: 'pest_control', label: 'Pest Control', summary: 'Pest Control - quarterly' }],
      oneTime: { items: [{ service: 'bora_care', label: 'Bora-Care Wood Treatment', summary: 'Bora-Care Wood Treatment - one-time' }] },
    };
    const answer = answerEstimateQuestionFallback('What is included in this estimate?', context);
    expect(answer).toMatch(/Pest Control/);
    expect(answer).toMatch(/Bora-Care/);
  });

  test('one-word "Boracare" and borate-labeled questions both route to the Bora-Care answer', () => {
    // Unhyphenated "Boracare" must qualify as a Bora-Care intent.
    expect(answerEstimateQuestionFallback('Is Boracare safe?', boraCareAssistantContext))
      .toMatch(/borate treatment applied to bare wood/);

    // A row identified only by "borate" (no bora_care key, no "bora care" text) is
    // recognized as Bora-Care in the context.
    const borateContext = {
      company: { phone: '941-555-0100' },
      serviceMode: 'one_time',
      services: [{ service: 'wood_treatment', label: 'Borate Wood Treatment', summary: 'Borate Wood Treatment - one-time' }],
      oneTime: { items: [{ service: 'wood_treatment', label: 'Borate Wood Treatment' }] },
    };
    expect(answerEstimateQuestionFallback('Is this borate treatment safe?', borateContext))
      .toMatch(/borate treatment applied to bare wood/);
  });

  test('a recurring pest estimate with a Bora-Care add-on still builds the One-Time Pest Control choice', () => {
    // Bora-Care must not flip the one-time-choice classification to "bundle" and
    // suppress the pest choice (which made the accept flow bill only the add-on).
    const estimate = { show_one_time_option: true };
    const estData = {
      result: {
        recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, perTreatment: 120 }] },
        oneTime: { total: 1051, items: [{ service: 'bora_care', name: 'Bora-Care', price: 1051 }] },
      },
    };

    expect(serviceCategoryForOneTimeChoice(estData)).toBe('pest_control');

    const list = acceptedOneTimeChoiceListForEstimate(estimate, estData, null, 199);
    expect(list).not.toBeNull();
    expect(list[0]).toEqual(expect.objectContaining({ service: 'one_time_pest', label: 'One-Time Pest Control' }));
    // The selected one-time pest visit is the lead item, and the Bora-Care add-on
    // rides alongside it (billed in the one-time path, not just the recurring one).
    const bora = list.find((row) => row.service === 'bora_care');
    expect(bora).toEqual(expect.objectContaining({ label: 'Bora-Care', price: 1051 }));
    // Amount = pest visit + the preserved Bora-Care add-on, and matches the list.
    const listTotal = Math.round(list.reduce((sum, row) => sum + Number(row.price || 0), 0) * 100) / 100;
    expect(listTotal).toBeGreaterThanOrEqual(1051);
    expect(oneTimeChoiceAmountForEstimate(estimate, estData)).toBe(listTotal);
  });

  test('a fixed manual one-time discount is applied once across the pest add-ons, not per category', () => {
    // A roach-cleanout specialty + a Bora-Care add-on with a $100 one-time manual
    // discount slice: the slice must be distributed once across BOTH rows, never
    // applied separately to each (which would double the discount).
    const estimate = { show_one_time_option: true };
    const estData = {
      result: {
        recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, perTreatment: 120 }] },
        oneTime: {
          total: 1551,
          items: [
            { service: 'german_roach', name: 'German Roach Cleanout', price: 500, detail: '3 visit program' },
            { service: 'bora_care', name: 'Bora-Care', price: 1051 },
          ],
        },
        manualDiscount: { type: 'FIXED', amount: 100, oneTimeAmount: 100 },
      },
    };

    const list = acceptedOneTimeChoiceListForEstimate(estimate, estData, null, 199);
    const addOns = list.filter((row) => row.service === 'german_roach' || row.service === 'bora_care');
    const totalDiscount = addOns.reduce((sum, row) => sum + Number(row.manualDiscountApplied || 0), 0);
    expect(Math.round(totalDiscount * 100) / 100).toBe(100);
    // Net add-on total = 500 + 1051 - 100 (slice applied exactly once).
    const addOnNet = addOns.reduce((sum, row) => sum + Number(row.price || 0), 0);
    expect(Math.round(addOnNet * 100) / 100).toBe(1451);
  });

  test('an already-aligned choice breakdown is NOT re-discounted on accept', () => {
    // finalizePricingBundle aligns the bundle into a net choice breakdown (discount
    // baked into the add-on, synthetic One-Time Pest Control row present). The accept
    // path re-runs this helper over that bundle; the manual slice must not be
    // subtracted a second time.
    const estimate = { show_one_time_option: true };
    const estData = {
      result: {
        recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, perTreatment: 120 }] },
        oneTime: { total: 1051, items: [{ service: 'bora_care', name: 'Bora-Care', price: 1051 }] },
        manualDiscount: { type: 'FIXED', amount: 100, oneTimeAmount: 100 },
      },
    };
    // The finalized bundle: Bora-Care already net of the $100 slice ($951), the
    // synthetic pest-choice row present, and the explicit aligned marker.
    const alignedBundle = {
      oneTimeBreakdown: {
        total: 264 + 951,
        choiceAligned: true,
        items: [
          { service: 'one_time_pest', label: 'One-Time Pest Control', amount: 264 },
          { service: 'bora_care', label: 'Bora-Care', amount: 951 },
        ],
      },
    };
    const list = acceptedOneTimeChoiceListForEstimate(estimate, estData, alignedBundle, 264);
    const bora = list.find((r) => r.service === 'bora_care');
    // Stays at the already-net $951 — not re-discounted to $851.
    expect(bora.price).toBe(951);
  });

  test('a RAW breakdown that happens to carry a one_time_pest row is still discounted', () => {
    // A raw/admin-saved estimate can contain a one_time_pest item without being the
    // aligned (net) choice breakdown. The manual one-time slice must still apply to
    // the gross add-on — detection must rely on the aligned marker, not the row.
    const estimate = { show_one_time_option: true };
    const estData = {
      result: {
        recurring: { services: [{ service: 'pest_control', name: 'Pest Control', mo: 50, perTreatment: 120 }] },
        oneTime: {
          total: 1215,
          items: [
            { service: 'one_time_pest', name: 'One-Time Pest Control', price: 264 },
            { service: 'bora_care', name: 'Bora-Care', price: 1051 },
          ],
        },
        manualDiscount: { type: 'FIXED', amount: 100, oneTimeAmount: 100 },
      },
    };
    const list = acceptedOneTimeChoiceListForEstimate(estimate, estData, null, 264);
    const bora = list.find((r) => r.service === 'bora_care');
    // Gross $1,051 minus the $100 slice = $951 (applied exactly once).
    expect(bora.price).toBe(951);
  });

  test('invoice-mode one-time accept itemizes a Bora-Care add-on instead of hiding it in a pest line', () => {
    const draft = buildEstimateInvoiceModeDraft({
      estimate: { id: 1, show_one_time_option: true },
      estData: {},
      treatAsOneTime: true,
      effectiveOneTimeTotal: 264 + 951,
      oneTimeList: [
        { service: 'one_time_pest', label: 'One-Time Pest Control', price: 264 },
        { service: 'bora_care', label: 'Bora-Care Wood Treatment', price: 951 },
      ],
    });
    expect(draft.lineItems).toHaveLength(2);
    expect(draft.lineItems.map((li) => li.description)).toEqual(['One-Time Pest Control', 'Bora-Care Wood Treatment']);
    expect(draft.lineItems.find((li) => li.description === 'Bora-Care Wood Treatment').unit_price).toBe(951);
    expect(draft.title).toContain('Bora-Care Wood Treatment');

    // A single-service one-time accept keeps the single collapsed line.
    const single = buildEstimateInvoiceModeDraft({
      estimate: { id: 2, show_one_time_option: true },
      estData: {},
      treatAsOneTime: true,
      effectiveOneTimeTotal: 264,
      oneTimeList: [{ service: 'one_time_pest', label: 'One-Time Pest Control', price: 264 }],
    });
    expect(single.lineItems).toHaveLength(1);
  });

  test('Bora-Care plus a positive billable adjustment is NOT treated as Bora-Care-only', () => {
    // A positive one_time_adjustment (or any unrecognized positive charge) is a
    // real billable line — unlike the negative member discount it must NOT switch
    // the page to Bora-Care-only copy or suppress the mini-guarantee.
    const html = renderPage('boracare-billable-adjust-token', {
      status: 'sent',
      customerName: 'Hannah Customer',
      address: '12 Builder Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 1251,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: {
          total: 1251,
          items: [
            { service: 'bora_care', name: 'Bora-Care', price: 1051 },
            { service: 'one_time_adjustment', name: 'Additional treatment area', price: 200 },
          ],
          specItems: [],
        },
        specItems: [],
      },
    });

    expect(html).not.toContain('your Bora-Care wood treatment quote.');
    expect(html).toContain('class="mini-guarantee"');
    // The one-time hero detail/note are gated on Bora-Care-only too, so a mixed
    // billable estimate doesn't show the Bora-Care wood-treatment detail line.
    expect(html).not.toContain('class="choice-treatment-detail">Bora-Care wood treatment');
    // A one-time-only estimate never renders the recurring WaveGuard member perks
    // card, so the generic member perks don't appear regardless.
    expect(html).not.toContain('class="perks-list"');
  });

  test('Bora-Care labeled with termite-treatment wording keeps Bora-Care copy, not termite-trenching copy', () => {
    // "Termite Bora-Care Treatment" matches the raw termite-trenching heuristic;
    // excluding Bora-Care from that predicate keeps the page on Bora-Care copy.
    const item = { service: 'bora_care', name: 'Termite Bora-Care Treatment', price: 1051 };
    expect(deriveServiceCategory({}, [], [item])).toBe('bora_care');

    const html = renderPage('boracare-termite-treatment-token', {
      status: 'sent',
      customerName: 'Hannah Customer',
      address: '12 Builder Way',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 1051,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: { total: 1051, items: [item], specItems: [] },
        specItems: [],
      },
    });

    expect(html).toContain('your Bora-Care wood treatment quote.');
    expect(html).not.toContain('your termite trenching quote.');
    expect(html).toContain('data-estimate-ask-prompt="What does Bora-Care treat?"');
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
    expect(html).toContain('Pay per application');
    expect(html).toContain('Annual prepay');
    expect(html).toContain('We send the invoice automatically and make secure payment available.');
    expect(html).toContain('After confirmation, your annual prepay invoice totals');
    expect(html).toContain('id="payment-setup-summary"');
    expect(html).toContain('id="change-payment-setup-btn"');
    expect(html).toContain('function updatePaymentSetupSummary(pref)');
    expect(html).toContain("bookingTitle.textContent = 'Review your invoice setup'");
    expect(html).toContain("history.pushState(null, '', '#invoice-setup')");
    expect(html).toContain("if (setupCard) setupCard.style.display = 'none';");
    expect(html).toContain("changePaymentSetupBtn.addEventListener('click', returnToPaymentSetupChoices)");
    expect(html).toContain('<section class="card booking-card" id="booking-card" style="display:none">');
    expect(html).toContain('const REQUIRE_PAYMENT_SETUP_BEFORE_SLOTS = true;');
    expect(html).toContain('function bookingRequiresPaymentSetup()');
    expect(html).toContain('isReserving: false');
    expect(html).toContain('reserveAttemptId: 0');
    expect(html).toContain('function buildSlotContext()');
    expect(html).toContain("slotParams.set('serviceMode', slotContext.serviceMode)");
    expect(html).toContain("slotParams.set('windowDays', '14')");
    expect(html).toContain("slotParams.set('selectedFrequency', slotContext.selectedFrequency)");
    expect(html).toContain('const slots = allSlots.slice(0, 6);');
    expect(html).toContain('const moreSlots = allSlots.slice(6, 9);');
    expect(html).toContain('These are the soonest open service windows we can offer. Nearby route days are marked when a tech is already close by.');
    expect(html).toContain('body: JSON.stringify(reservePayload)');
    expect(html).toContain('bookingState.isReserving = true;');
    expect(html).toContain("if (document.getElementById('booking-card') && !bookingRequiresPaymentSetup())");
    expect(html).toContain("toast('Choose a payment option first.')");
    expect(html).toContain('const target = ev.target instanceof Element ? ev.target : ev.target?.parentElement;');
  });

  test('server-rendered recurring estimates surface cancel/refund/guarantee terms', () => {
    const html = renderPage('terms-token', {
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

    expect(html).toContain('class="card plan-terms-card"');
    expect(html).toContain('Cancel, refunds &amp; our guarantee');
    expect(html).toContain('Cancel anytime &mdash; no contract');
    expect(html).toContain('setup is refundable');
    expect(html).toContain('Annual prepay is prorated');
    expect(html).toContain('backed by a 90-day money-back guarantee');
  });

  test('quote-required estimates do not render the plan terms card', () => {
    const html = renderPage('terms-quote-token', {
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
        results: {},
      },
    });

    // The CSS class is always present in the <style> block; assert the card
    // element and its body copy are gated out, not the stylesheet rule.
    expect(html).not.toContain('class="card plan-terms-card"');
    expect(html).not.toContain('Cancel anytime &mdash; no contract');
  });

  test('one-time pest choice excludes WaveGuard setup from the choice price and add-on table', async () => {
    const estimateData = {
      result: {
        results: {
          pestTiers: [{ label: 'Quarterly', mo: 32.33, ann: 387.96, pa: 97, apps: 4 }],
        },
        recurring: {
          discount: 0,
          monthlyTotal: 32.33,
          annualAfterDiscount: 387.96,
          services: [{ name: 'Pest Control', mo: 32.33 }],
        },
        oneTime: {
          total: 298,
          membershipFee: 99,
          items: [{ service: 'one_time_pest', name: 'One-Time Pest', price: 199 }],
        },
        specItems: [],
      },
    };
    const pricing = await buildPricingBundle({
      id: 'estimate-public-choice-pest-test',
      show_one_time_option: true,
      estimate_data: estimateData,
      monthly_total: 32.33,
      annual_total: 387.96,
      onetime_total: 298,
      waveguard_tier: 'Bronze',
    });

    expect(pricing.anchorOneTimePrice).toBe(213);
    expect(resolveAcceptOneTimeTotal({
      show_one_time_option: true,
      estimate_data: estimateData,
      onetime_total: 298,
    }, pricing)).toBe(213);

    const html = renderPage('choice-token', {
      status: 'sent',
      customerName: 'Rita Roldan',
      address: '17630 Canopy Pl',
      monthlyTotal: 32.33,
      annualTotal: 387.96,
      onetimeTotal: 298,
      tier: 'Bronze',
      showOneTimeOption: true,
      oneTimeChoicePrice: pricing.anchorOneTimePrice,
    }, estimateData);

    expect(html).toContain('<span class="num" id="onetime-display">$213</span>');
    expect(html).toContain('<div class="choice-treatment" data-mode-only="recurring">');
    expect(html).toContain('<div class="choice-treatment" data-mode-only="one_time" hidden>');
    expect(html).not.toContain('One-time items (billed separately)');
    expect(html).not.toContain('These are scheduled after your recurring service starts.');
  });

  test('one-time pest choice is derived from recurring pest pricing when saved one-time rows only contain setup', async () => {
    const estimateData = {
      result: {
        results: {
          pestTiers: [{ label: 'Quarterly', mo: 30.67, ann: 368.04, pa: 92, apps: 4 }],
        },
        recurring: {
          discount: 0,
          monthlyTotal: 30.67,
          annualAfterDiscount: 368.04,
          services: [{ name: 'Quarterly Pest Control', mo: 30.67 }],
        },
        oneTime: {
          total: 99,
          membershipFee: 99,
          items: [{ service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 }],
        },
        specItems: [],
      },
    };
    const pricing = await buildPricingBundle({
      id: 'estimate-public-choice-pest-setup-only-test',
      show_one_time_option: true,
      estimate_data: estimateData,
      monthly_total: 30.67,
      annual_total: 368.04,
      onetime_total: 99,
      waveguard_tier: 'Bronze',
    });

    expect(pricing.anchorOneTimePrice).toBe(202);
    expect(oneTimeChoiceAmountForEstimate({
      show_one_time_option: true,
      estimate_data: estimateData,
    }, estimateData, pricing)).toBe(202);
    expect(pricing.oneTimeBreakdown).toMatchObject({
      total: 202,
      items: [expect.objectContaining({
        service: 'one_time_pest',
        label: 'One-Time Pest Control',
        amount: 202,
      })],
    });
    expect(pricing.oneTimeBreakdown.items.some((item) => item.service === 'waveguard_setup')).toBe(false);
    expect(resolveAcceptOneTimeTotal({
      show_one_time_option: true,
      estimate_data: estimateData,
      onetime_total: 99,
    }, pricing)).toBe(202);
    expect(acceptedOneTimeChoiceListForEstimate({
      show_one_time_option: true,
      estimate_data: estimateData,
      onetime_total: 99,
    }, estimateData, pricing, pricing.anchorOneTimePrice)).toEqual([{
      service: 'one_time_pest',
      name: 'One-Time Pest Control',
      label: 'One-Time Pest Control',
      price: 202,
    }]);

    const html = renderPage('choice-setup-token', {
      status: 'sent',
      customerName: 'Dana Medlin',
      address: '13524 Camelot Ct',
      monthlyTotal: 30.67,
      annualTotal: 368.04,
      onetimeTotal: 99,
      tier: 'Bronze',
      showOneTimeOption: true,
      oneTimeChoicePrice: pricing.anchorOneTimePrice,
    }, estimateData);

    expect(html).toContain('Hey Dana, choose your pest control option.');
    expect(html).toContain('<span class="num" id="onetime-display">$202</span>');
    expect(html).toContain('One-Time Pest Control');
    expect(html).not.toContain('One-time items (billed separately)');
  });

  test('one-time pest choice preserves billable pest specialty one-time rows', async () => {
    const estimateData = {
      result: {
        results: {
          pestTiers: [{ label: 'Quarterly', mo: 30.67, ann: 368.04, pa: 92, apps: 4 }],
        },
        recurring: {
          discount: 0,
          monthlyTotal: 30.67,
          annualAfterDiscount: 368.04,
          services: [{ name: 'Quarterly Pest Control', mo: 30.67 }],
        },
        oneTime: {
          total: 218,
          membershipFee: 99,
          items: [{
            service: 'pest_initial_roach',
            name: 'Initial Roach Knockdown',
            price: 119,
            detail: 'Heavy roach activity',
          }],
        },
        specItems: [],
      },
    };
    const estimate = {
      id: 'estimate-public-choice-pest-specialty-test',
      show_one_time_option: true,
      estimate_data: estimateData,
      monthly_total: 30.67,
      annual_total: 368.04,
      onetime_total: 218,
      waveguard_tier: 'Bronze',
    };
    const pricing = await buildPricingBundle(estimate);

    expect(pricing.anchorOneTimePrice).toBe(321);
    expect(oneTimeChoiceAmountForEstimate(estimate, estimateData, pricing)).toBe(321);
    expect(pricing.oneTimeBreakdown).toMatchObject({
      total: 321,
      items: [
        expect.objectContaining({
          service: 'one_time_pest',
          label: 'One-Time Pest Control',
          amount: 202,
        }),
        expect.objectContaining({
          service: 'pest_initial_roach',
          label: 'Initial Roach Knockdown',
          amount: 119,
          detail: 'Heavy roach activity',
        }),
      ],
    });
    expect(pricing.oneTimeBreakdown.items.some((item) => item.service === 'waveguard_setup')).toBe(false);
    expect(resolveAcceptOneTimeTotal(estimate, pricing)).toBe(321);
    expect(acceptedOneTimeChoiceListForEstimate(
      estimate,
      estimateData,
      pricing,
      pricing.anchorOneTimePrice,
    )).toEqual([{
      service: 'one_time_pest',
      name: 'One-Time Pest Control',
      label: 'One-Time Pest Control',
      price: 202,
    }, {
      service: 'pest_initial_roach',
      name: 'Initial Roach Knockdown',
      label: 'Initial Roach Knockdown',
      price: 119,
      detail: 'Heavy roach activity',
    }]);

    const html = renderPage('choice-specialty-token', {
      status: 'sent',
      customerName: 'Dana Medlin',
      address: '13524 Camelot Ct',
      monthlyTotal: 30.67,
      annualTotal: 368.04,
      onetimeTotal: 218,
      tier: 'Bronze',
      showOneTimeOption: true,
      oneTimeChoicePrice: pricing.anchorOneTimePrice,
    }, estimateData);

    expect(html).toContain('<span class="num" id="onetime-display">$321</span>');
    expect(html).not.toContain('<td>WaveGuard setup');
  });

  test('one-time pest choice preserves broader pest specialty service keys', async () => {
    const estimateData = {
      result: {
        results: {
          pestTiers: [{ label: 'Quarterly', mo: 30.67, ann: 368.04, pa: 92, apps: 4 }],
        },
        recurring: {
          discount: 0,
          monthlyTotal: 30.67,
          annualAfterDiscount: 368.04,
          services: [{ name: 'Quarterly Pest Control', mo: 30.67 }],
        },
        oneTime: {
          total: 1198,
          membershipFee: 99,
          items: [
            { service: 'one_time_pest', name: 'One-Time Pest', price: 250 },
            { service: 'pest_initial_cleanout', name: 'Initial Pest Cleanout', price: 199 },
            { service: 'flea_package', name: 'Flea Package', price: 125 },
          ],
        },
        specItems: [
          { service: 'stinging_insect', name: 'Stinging Insect', price: 175 },
          { service: 'german_roach', name: 'German Roach Cleanout', price: 350, detail: 'Two visits' },
        ],
      },
    };
    const estimate = {
      id: 'estimate-public-choice-pest-specialty-keys-test',
      show_one_time_option: true,
      estimate_data: estimateData,
      monthly_total: 30.67,
      annual_total: 368.04,
      onetime_total: 1198,
      waveguard_tier: 'Bronze',
    };
    const pricing = await buildPricingBundle(estimate);

    expect(pricing.anchorOneTimePrice).toBe(852);
    expect(pricing.oneTimeBreakdown.items).toEqual([
      expect.objectContaining({ service: 'one_time_pest', amount: 202 }),
      expect.objectContaining({ service: 'flea_package', amount: 125 }),
      expect.objectContaining({ service: 'stinging_insect', amount: 175 }),
      expect.objectContaining({ service: 'german_roach', amount: 350, detail: 'Two visits' }),
    ]);
    expect(pricing.oneTimeBreakdown.items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ service: 'waveguard_setup' }),
      expect.objectContaining({ service: 'pest_initial_cleanout' }),
    ]));
    expect(acceptedOneTimeChoiceListForEstimate(
      estimate,
      estimateData,
      pricing,
      pricing.anchorOneTimePrice,
    )).toEqual([
      expect.objectContaining({ service: 'one_time_pest', price: 202 }),
      expect.objectContaining({ service: 'flea_package', price: 125 }),
      expect.objectContaining({ service: 'stinging_insect', price: 175 }),
      expect.objectContaining({ service: 'german_roach', price: 350, detail: 'Two visits' }),
    ]);
    expect(resolveAcceptOneTimeTotal(estimate, pricing)).toBe(852);
  });

  test('one-time pest choice alignment preserves quote-required blockers', async () => {
    const estimateData = {
      result: {
        results: {
          pestTiers: [{ label: 'Quarterly', mo: 32.33, ann: 387.96, pa: 97, apps: 4 }],
        },
        recurring: {
          discount: 0,
          monthlyTotal: 32.33,
          annualAfterDiscount: 387.96,
          services: [{ name: 'Pest Control', mo: 32.33 }],
        },
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

    const pricing = await buildPricingBundle({
      id: 'estimate-public-choice-pest-quote-required-test',
      show_one_time_option: true,
      estimate_data: estimateData,
      monthly_total: 32.33,
      annual_total: 387.96,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
    });

    expect(pricing.anchorOneTimePrice).toBe(213);
    expect(pricing.quoteRequired).toBe(true);
    expect(pricing.quoteRequiredReason).toBe('SEVERE_INFESTATION');
    expect(pricing.oneTimeBreakdown.quoteRequired).toBe(true);
    expect(pricing.oneTimeBreakdown.items).toContainEqual(expect.objectContaining({
      service: 'bed_bug',
      quoteRequired: true,
    }));
  });

  test('setup-only one-time choice creates a pest-control invoice draft', () => {
    const estimateData = {
      result: {
        results: {
          pestTiers: [{ label: 'Quarterly', mo: 30.67, ann: 368.04, pa: 92, apps: 4 }],
        },
        recurring: {
          discount: 0,
          monthlyTotal: 30.67,
          annualAfterDiscount: 368.04,
          services: [{ name: 'Pest Control', mo: 30.67 }],
        },
        oneTime: {
          total: 99,
          membershipFee: 99,
          items: [{ service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 }],
        },
        specItems: [],
      },
    };
    const lists = acceptanceServiceLists(estimateData);
    const draft = buildEstimateInvoiceModeDraft({
      estimate: {
        id: 'estimate-setup-only',
        show_one_time_option: true,
        estimate_data: estimateData,
        onetime_total: 99,
      },
      estData: estimateData,
      pricingBundle: { oneTimeBreakdown: normalizeOneTimeBreakdown(estimateData) },
      oneTimeList: lists.oneTimeList,
      recurringSvcList: lists.recurringSvcList,
      treatAsOneTime: true,
      effectiveOneTimeTotal: 202,
    });

    expect(draft).toMatchObject({
      invoiceKind: 'one_time',
      serviceLabel: 'One-Time Pest Control',
      amount: 202,
      title: 'One-Time Pest Control — one-time service',
      lineItems: [{ description: 'One-Time Pest Control', quantity: 1, unit_price: 202 }],
    });
    expect(draft.title).not.toContain('WaveGuard setup');
  });

  test('one-time invoice draft rejects non-billable invoice-mode accepts', () => {
    expect(() => buildEstimateInvoiceModeDraft({
      estimate: {
        id: 'estimate-zero-one-time',
        show_one_time_option: true,
      },
      estData: { result: { oneTime: { items: [] } } },
      oneTimeList: [],
      treatAsOneTime: true,
      effectiveOneTimeTotal: 0,
    })).toThrow('billable one-time amount');
  });

  test('server-rendered slot selection ignores clicks while a reservation is in flight', () => {
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
    const selectSlot = html.match(/function selectSlot\(btn\) \{[\s\S]*?\n  \}/)?.[0] || '';

    expect(selectSlot).toContain('if (bookingState.isReserving)');
    expect(selectSlot.indexOf('if (bookingState.isReserving)')).toBeLessThan(
      selectSlot.indexOf('bookingState.selectedSlotId = btn.dataset.slotId'),
    );
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
        pool: 'YES',
        poolCage: 'YES',
        poolCageSize: 'MEDIUM',
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
      { label: 'Pool/Lanai', value: 'Yes (Medium cage)' },
      { label: 'Treatable lawn', value: '5,200 sq ft' },
      { label: 'Complexity', value: 'Moderate' },
    ]));
    expect(payload.metrics.some((metric) => metric.label === 'Grass type')).toBe(false);
    expect(payload.signals).toEqual([]);
  });

  test('Waves AI payload includes grass type for lawn-only estimates when present', () => {
    const payload = buildWaveGuardIntelligencePayload({}, {
      inputs: {
        homeSqFt: 1900,
        lotSqFt: 7200,
        lawnSqFt: 4200,
        services: { lawn: { track: 'st_augustine' } },
      },
      result: {
        recurring: { services: [{ name: 'Lawn Care' }] },
      },
    });

    expect(payload.title).toContain('Waves AI reviewed your lawn');
    expect(payload.metrics).toEqual(expect.arrayContaining([
      { label: 'Treatable lawn', value: '4,200 sq ft' },
      { label: 'Grass type', value: 'St. Augustine' },
    ]));
  });

  test('Waves AI payload uses later object turf fields when the first field is a placeholder', () => {
    const payload = buildWaveGuardIntelligencePayload({}, {
      inputs: {
        lawnSqFt: 4200,
      },
      result: {
        property: {
          turfProfile: { grassType: { track: 'N/A', grassType: 'bermuda' } },
        },
        recurring: { services: [{ name: 'Lawn Care' }] },
      },
    });

    expect(payload.metrics).toEqual(expect.arrayContaining([
      { label: 'Grass type', value: 'Bermuda' },
    ]));
  });

  test('Waves AI payload does not invent a lawn grass type metric', () => {
    const payload = buildWaveGuardIntelligencePayload({}, {
      inputs: {
        lawnSqFt: 4200,
        services: { lawn: { track: 'N/A' } },
      },
      result: {
        recurring: { services: [{ name: 'Lawn Care' }] },
      },
    });

    expect(payload.metrics).toEqual(expect.arrayContaining([
      { label: 'Treatable lawn', value: '4,200 sq ft' },
    ]));
    expect(payload.metrics.some((metric) => metric.label === 'Grass type')).toBe(false);
  });

  test('Waves AI payload includes tree and shrub metrics for tree/shrub-only estimates', () => {
    const payload = buildWaveGuardIntelligencePayload({}, {
      inputs: {
        homeSqFt: 2100,
        lotSqFt: 8400,
        bedArea: 1800,
        bedAreaSource: 'explicit',
        services: {
          treeShrub: {
            treeCount: 6,
            shrubDensity: 'heavy',
          },
        },
        features: {
          shrubs: 'heavy',
          trees: 'moderate',
        },
        landscapeComplexity: 'COMPLEX',
        pool: 'NO',
        poolCage: 'NO',
      },
      result: {
        recurring: { services: [{ name: 'Tree & Shrub' }] },
      },
    });

    expect(payload.title).toContain('Waves AI reviewed your beds and trees');
    expect(payload.body).toContain('tree & shrub plan');
    expect(payload.metrics).toEqual(expect.arrayContaining([
      { label: 'Home', value: '2,100 sq ft' },
      { label: 'Lot', value: '8,400 sq ft' },
      { label: 'Pool/Lanai', value: 'No' },
      { label: 'Ornamental beds', value: '1,800 sq ft' },
      { label: 'Trees/Shrubs', value: '6 trees, Heavy shrubs' },
      { label: 'Complexity', value: 'Complex' },
    ]));
    expect(payload.metrics.some((metric) => metric.label === 'Treatable lawn')).toBe(false);
    expect(payload.metrics.some((metric) => metric.label === 'Grass type')).toBe(false);
  });

  test('Waves AI payload skips placeholder tree and shrub metrics', () => {
    const payload = buildWaveGuardIntelligencePayload({}, {
      inputs: {
        bedArea: 2000,
        bedAreaSource: 'fallback',
        services: {
          treeShrub: {
            treeDensity: 0,
            shrubDensity: '0',
          },
        },
        features: {
          trees: 'N/A',
          shrubs: 'unknown',
        },
      },
      result: {
        recurring: { services: [{ name: 'Tree & Shrub' }] },
      },
    });

    expect(payload.metrics.some((metric) => metric.label === 'Ornamental beds')).toBe(false);
    expect(payload.metrics.some((metric) => metric.label === 'Trees/Shrubs')).toBe(false);
  });

  test('Waves AI payload preserves complexity for termite and lawn bundles', () => {
    const payload = buildWaveGuardIntelligencePayload({}, {
      inputs: {
        homeSqFt: 2400,
        lotSqFt: 9000,
        lawnSqFt: 5200,
        services: { lawn: { track: 'st_augustine' } },
        landscapeComplexity: 'MODERATE',
        pool: 'YES',
        poolCage: 'YES',
        poolCageSize: 'MEDIUM',
        termitePerimeterFt: 180,
      },
      result: {
        recurring: {
          services: [
            { name: 'Lawn Care' },
            { name: 'Termite Bait Stations' },
          ],
        },
      },
    });

    expect(payload.metrics).toHaveLength(6);
    expect(payload.metrics).toEqual(expect.arrayContaining([
      { label: 'Termite perimeter', value: '180 linear ft' },
      { label: 'Complexity', value: 'Moderate' },
    ]));
    expect(payload.metrics.some((metric) => metric.label === 'Grass type')).toBe(false);
  });

  test('Waves AI payload uses termite-specific copy and perimeter for termite-bait-only estimates', () => {
    const payload = buildWaveGuardIntelligencePayload({}, {
      inputs: {
        homeSqFt: 2200,
        lotSqFt: 7800,
        termitePerimeterFt: 185,
        services: { termiteBait: true },
        pool: 'NO',
        poolCage: 'NO',
      },
      result: {
        recurring: {
          services: [{ name: 'Termite Bait Stations' }],
        },
      },
    });

    expect(payload.title).toBe('Waves AI reviewed your termite perimeter before pricing this estimate');
    expect(payload.body).toContain('termite perimeter details');
    expect(payload.metrics).toEqual(expect.arrayContaining([
      { label: 'Termite perimeter', value: '185 linear ft' },
    ]));
    expect(payload.metrics.some((metric) => metric.label === 'Treatable lawn')).toBe(false);
    expect(payload.metrics.some((metric) => metric.label === 'Grass type')).toBe(false);
  });

  test('Waves AI payload uses mosquito-specific copy and metrics for mosquito-only estimates', () => {
    const payload = buildWaveGuardIntelligencePayload({}, {
      inputs: {
        homeSqFt: 2100,
        lotSqFt: 9400,
        services: { mosquito: { tier: 'monthly12' } },
        pool: 'YES',
        poolCage: 'YES',
        poolCageSize: 'LARGE',
        landscapeComplexity: 'MODERATE',
      },
      result: {
        recurring: {
          services: [{ name: 'Mosquito (Monthly Mosquito Program)' }],
        },
        results: {
          mq: [
            { n: 'Seasonal Mosquito Program (9 visits)', v: 9, recommended: false },
            { n: 'Monthly Mosquito Program (12 visits)', v: 12, recommended: true },
          ],
          mqMeta: {
            pr: 1.35,
            ri: 1,
            treatableSqFt: 7800,
          },
        },
      },
    });

    expect(payload.title).toBe('Waves AI reviewed your mosquito treatment zones before pricing this estimate');
    expect(payload.body).toContain('mosquito control plan');
    expect(payload.metrics).toEqual(expect.arrayContaining([
      { label: 'Home', value: '2,100 sq ft' },
      { label: 'Lot', value: '9,400 sq ft' },
      { label: 'Mosquito treatment area', value: '7,800 sq ft' },
      { label: 'Mosquito program', value: 'Monthly (12 visits/year)' },
      { label: 'Mosquito pressure', value: '1.35x' },
      { label: 'Pool/Lanai', value: 'Yes (Large cage)' },
    ]));
    expect(payload.metrics.some((metric) => metric.label === 'Treatable lawn')).toBe(false);
    expect(payload.metrics.some((metric) => metric.label === 'Grass type')).toBe(false);
    expect(payload.metrics.some((metric) => metric.label === 'Termite perimeter')).toBe(false);
  });

  test('Waves AI payload keeps bundle copy when recurring mosquito includes non-mosquito one-time rows', () => {
    const payload = buildWaveGuardIntelligencePayload({}, {
      inputs: {
        homeSqFt: 2100,
        lotSqFt: 9400,
        services: { mosquito: { tier: 'monthly12' } },
        pool: 'YES',
        poolCage: 'YES',
        poolCageSize: 'LARGE',
      },
      result: {
        recurring: {
          services: [{ name: 'Mosquito (Monthly Mosquito Program)' }],
        },
        oneTime: {
          total: 225,
          items: [{
            service: 'one_time_pest',
            name: 'One-Time Pest Treatment',
            price: 225,
          }],
          specItems: [],
        },
        results: {
          mq: [
            { n: 'Monthly Mosquito Program (12 visits)', v: 12, recommended: true },
          ],
          mqMeta: {
            pr: 1.35,
            ri: 0,
            treatableSqFt: 7800,
          },
        },
      },
    });

    expect(payload.title).toBe('Waves AI reviewed your property before pricing this estimate');
    expect(payload.body).toContain('WaveGuard plan');
    expect(payload.metrics).toEqual(expect.arrayContaining([
      { label: 'Home', value: '2,100 sq ft' },
      { label: 'Lot', value: '9,400 sq ft' },
      { label: 'Pool/Lanai', value: 'Yes (Large cage)' },
    ]));
    expect(payload.metrics.some((metric) => metric.label === 'Mosquito treatment area')).toBe(false);
    expect(payload.metrics.some((metric) => metric.label === 'Mosquito program')).toBe(false);
    expect(payload.metrics.some((metric) => metric.label === 'Mosquito pressure')).toBe(false);
  });

  test('Waves AI payload shows Pool/Lanai when explicitly absent', () => {
    const payload = buildWaveGuardIntelligencePayload({}, {
      inputs: {
        homeSqFt: 1800,
        lotSqFt: 7000,
        pool: 'NO',
        poolCage: 'NO',
      },
      result: {
        recurring: { services: [{ name: 'Pest Control' }] },
      },
    });

    expect(payload.metrics).toEqual(expect.arrayContaining([
      { label: 'Pool/Lanai', value: 'No' },
    ]));
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
    expect(html).toContain('Ask Waves');
    expect(html).toContain('aria-label="Ask Waves about this estimate"');
    expect(html).toContain('/api/public/estimates/');
    expect(html).toContain('/ask');
    expect(html).toContain('ESTIMATE_ASK_TOKEN');
    expect(html).toContain('X-Estimate-Ask-Token');
    expect(html).toContain('<span class="intelligence-badge">Waves AI</span>');
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
    expect(acceptedHtml).not.toContain('Ask Waves');
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

  test('estimate assistant uses admin and repo support context for product questions', async () => {
    const fakeSupportDb = (table) => ({
      where(arg) {
        if (typeof arg === 'function') arg.call(this);
        return this;
      },
      whereNull() { return this; },
      orWhere() { return this; },
      orWhereNull() { return this; },
      orWhereRaw() { return this; },
      select() { return this; },
      limit(count) {
        const rows = {
          services: [{
            service_key: 'pest_control',
            name: 'General Pest Control',
            category: 'pest_control',
            description: 'Exterior perimeter and interior support when needed.',
            default_products: ['Demand CS', 'Alpine WSG'],
          }],
          products_catalog: [{
            name: 'Alpine WSG',
            category: 'insecticide',
            active_ingredient: 'Dinotefuran',
            active: true,
            label_verified: true,
          }],
        }[table] || [];
        return Promise.resolve(rows.slice(0, count));
      },
    });

    const result = await answerEstimateQuestion({
      question: 'How do you handle ants?',
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Silver',
        monthly_total: 116.7,
      },
      pricingBundle: {
        waveGuardTier: 'Silver',
        frequencies: [{
          key: 'quarterly',
          label: 'Quarterly',
          monthly: 116.7,
          included: [{ label: 'Pest Control' }],
        }],
      },
      database: fakeSupportDb,
    });

    expect(result.answer).toContain('active ingredients/classes');
    expect(result.answer).toContain('Dinotefuran');
    expect(result.answer).not.toContain('Demand CS');
    expect(result.answer).not.toContain('Alpine WSG');
    expect(result.answer).not.toContain('I do not see specific product details listed on your estimate');
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

  test('estimate assistant treats tree and shrub tiers as monthly billing with service cadence', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Bronze',
      },
      estData: {
        customerSelection: {
          serviceTierKey: 'enhanced',
          serviceTierLabel: 'Every 6 weeks',
        },
        result: {
          recurring: {
            services: [{ service: 'tree_shrub', name: 'Tree & Shrub', mo: 96 }],
          },
        },
      },
      pricingBundle: {
        waveGuardTier: 'Bronze',
        frequencies: [
          {
            key: 'standard',
            label: 'Bi-monthly',
            serviceCategory: 'tree_shrub',
            monthly: 72,
            annual: 864,
            billingFrequencyKey: 'monthly',
            included: [{ label: 'Bi-monthly tree & shrub program', detail: '6 visits per year' }],
          },
          {
            key: 'enhanced',
            label: 'Every 6 weeks',
            serviceCategory: 'tree_shrub',
            monthly: 96,
            annual: 1152,
            billingFrequencyKey: 'monthly',
            included: [{ label: 'Every 6 weeks tree & shrub program', detail: '9 visits per year' }],
          },
        ],
      },
    });
    const answer = answerEstimateQuestionFallback('How does billing work?', context);

    expect(context.billing.amountText).toBe('$96 / month');
    expect(context.billing.serviceCadence).toBe('Every 6 weeks');
    expect(context.services[0].summary).toContain('Every 6 weeks');
    expect(context.services[0].summary).toContain('9 visits per year');
    expect(answer).toContain('$96 / month');
    expect(answer).toContain('Service visits are Every 6 weeks.');
    expect(answer).not.toContain('/ bi-monthly visit');
  });

  test('estimate assistant invoice mode uses selected tier billing cadence', () => {
    const context = buildEstimateAssistantContext({
      estimate: {
        customer_name: 'Stan Customer',
        waveguard_tier: 'Bronze',
        bill_by_invoice: true,
      },
      estData: {
        customerSelection: {
          serviceTierKey: 'enhanced',
        },
        result: {
          recurring: {
            services: [{ service: 'tree_shrub', name: 'Tree & Shrub', mo: 96 }],
          },
        },
      },
      pricingBundle: {
        waveGuardTier: 'Bronze',
        frequencies: [
          {
            key: 'standard',
            label: 'Bi-monthly',
            serviceCategory: 'tree_shrub',
            monthly: 72,
            annual: 864,
            billingFrequencyKey: 'monthly',
          },
          {
            key: 'enhanced',
            label: 'Every 6 weeks',
            serviceCategory: 'tree_shrub',
            monthly: 96,
            annual: 1152,
            billingFrequencyKey: 'monthly',
          },
        ],
      },
    });
    const answer = answerEstimateQuestionFallback('How does billing work?', context);

    expect(context.billing.amountText).toBe('$96 / month');
    expect(context.billing.invoiceDueText).toBe('$96');
    expect(answer).toContain('invoice due immediately for $96');
    expect(answer).not.toContain('$288');
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

  test('recurring first-visit amount does not return partial bundle totals', () => {
    const amount = resolveRecurringFirstVisitAmount([
      { name: 'Pest Control', mo: 128 },
      { name: 'Lawn Care' },
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

    expect(amount).toBeNull();
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

  test('selected-frequency first-visit totals require priced rows for every accepted service', () => {
    const services = [
      { service: 'pest_control', name: 'Pest Control' },
      { service: 'lawn_care', name: 'Lawn Care' },
    ];
    const partialFrequency = {
      key: 'monthly',
      perServiceTreatments: [
        { service: 'pest_control', displayPrice: 74.4, perTreatment: 95, visitsPerYear: 12 },
        { service: 'lawn_care', label: 'Lawn Care' },
      ],
    };
    const completeFrequency = {
      key: 'monthly',
      perServiceTreatments: [
        { service: 'pest_control', displayPrice: 74.4, perTreatment: 95, visitsPerYear: 12 },
        { service: 'lawn_care', displayPrice: 104.4, perTreatment: 116 },
      ],
    };

    expect(resolveRecurringFirstVisitAmountFromFrequency(partialFrequency, { services })).toBeNull();
    expect(resolveRecurringFirstVisitAmountFromFrequency(completeFrequency, { services })).toBe(178.8);
  });

  test('recurring invoice-mode invoices prefer the accepted first-visit amount', () => {
    expect(resolveRecurringInvoiceFirstVisitAmount({
      recurringFirstVisitAmount: 219.6,
      effectiveBillingCadence: { amount: 350.1 },
      monthlyTotal: 116.7,
    })).toBe(219.6);
    expect(resolveRecurringInvoiceFirstVisitAmount({
      effectiveBillingCadence: { amount: 350.1 },
      monthlyTotal: 116.7,
    })).toBe(350.1);
    expect(resolveRecurringInvoiceFirstVisitAmount({
      monthlyTotal: 116.7,
    })).toBe(350.1);
  });

  test('selected-frequency preference discounts respect the pest monthly floor', () => {
    const prefs = { interior_spray: false, exterior_sweep: false };

    expect(preferenceMonthlyOffForPestVisits(prefs, 12, 70)).toBe(7.7);
    expect(preferenceMonthlyOffForPestVisits(prefs, 12, 150)).toBe(20);
  });

  test('selected-frequency preference caps use raw pest base before tier discount', () => {
    const frequency = {
      perServiceTreatments: [
        { service: 'pest_control', displayPrice: 74.4, perTreatment: 95, visitsPerYear: 12 },
      ],
    };
    const baseMonthly = pestMonthlyBaseForFrequency(frequency);

    expect(baseMonthly).toBe(95);
    expect(preferenceMonthlyOffForPestVisits({ interior_spray: false, exterior_sweep: false }, 12, baseMonthly)).toBe(20);
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
    expect(html).toContain('<div class="payment-summary-row"><span>First service visit</span><strong data-first-visit-total data-first-visit-amount="219.6">$219.60</strong></div>');
    expect(html).toContain('<div class="payment-summary-row payment-summary-total"><span>Invoice total</span><strong data-standard-invoice-total data-standard-setup-due="99">$318.60</strong></div>');
    expect(html).toContain('setup plus the first application totaling <span data-standard-invoice-copy-total data-standard-setup-due="99">$318.60</span>');
    expect(html).not.toContain('data-first-visit-copy-total');
    expect(html).toContain("document.querySelectorAll('[data-standard-invoice-total]')");
    expect(html).toContain("document.querySelectorAll('[data-standard-invoice-copy-total]')");
    expect(html).not.toContain('data-first-visit-grand-total');
    expect(html).toContain('let firstVisitTotal = 0;');
    expect(html).toContain('.payment-summary-row strong{font-size:14px;line-height:1.2;font-weight:800;color:#1B2C5B;text-align:right;white-space:nowrap}');
    expect(html).not.toContain('.payment-summary-row.total strong');
    expect(html).not.toContain('How billing works');
    expect(html).not.toContain('For comparison, this plan averages');
    expect(html).not.toContain('data-billing-service-price');
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

  test('server-rendered payment setup card avoids partial first-visit totals', () => {
    const html = renderPage('partial-bundle-token', {
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
            { name: 'Lawn Care' },
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

    expect(html).toContain('<div class="payment-summary-row"><span>First service visit</span><strong>After completion</strong></div>');
    expect(html).not.toContain('data-first-visit-total>$115.20</strong>');
  });

  test('server-rendered lawn pay-per-application invoice is the first application with no setup fee', () => {
    const html = renderPage('monthly-tier-token', {
      status: 'sent',
      customerName: 'Jane Customer',
      address: '6539 Field Sparrow Gln',
      monthlyTotal: 55,
      annualTotal: 660,
      onetimeTotal: 0,
      tier: 'Bronze',
      pricingFrequencies: [{
        key: 'standard',
        label: 'Bi-monthly',
        monthly: 55,
        annual: 660,
        perTreatment: 73.33,
        visitsPerYear: 9,
        billingFrequencyKey: 'monthly',
        selected: true,
      }],
    }, {
      result: {
        recurring: {
          services: [
            { name: 'Lawn Care', mo: 55, perTreatment: 73.33, visitsPerYear: 9 },
          ],
        },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: {
          lawn: [{ selected: true, v: 9 }],
        },
      },
    });

    // Lawn carries no WaveGuard setup fee — the pay-per-application card shows the
    // first application (billed after completion) with no setup line and no
    // confusing "Invoice total" sum.
    expect(html).toContain('<div class="payment-summary-row"><span>First service visit</span><strong data-first-visit-total data-first-visit-amount="73.33">$73.33</strong></div>');
    expect(html).not.toContain('WaveGuard Membership Setup');
    expect(html).not.toContain('<span>Invoice total</span>');
    expect(html).not.toContain('Invoice includes WaveGuard setup');
    expect(html).not.toContain('we open the $99 setup invoice');
    // Prepay is still offered, now with a 5% discount: $660 → $627.
    expect(html).toContain('data-prepay-invoice-total data-prepay-discount-rate="0.05">$627');
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
        services: { lawn: { track: 'st_augustine' } },
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
    expect(html).toContain('Grass type');
    expect(html).toContain('St. Augustine');
    expect(html).toContain('Choose how you want to pay');
    expect(html).not.toContain('Choose how to start your lawn care plan');
    expect(html).toContain('Pick your first lawn care visit');
    expect(html).toContain('What your lawn care plan includes');
    expect(html).toContain('Ready to start lawn care?');
    expect(html).toContain('Let&#39;s get your lawn on the schedule.');
    expect(html).toContain('Confirm invoice');
    expect(html).toContain('next step creates your invoice and makes secure payment available');
    expect(html).not.toContain('Confirm and set up billing');
    expect(html).not.toContain('pay-after-visit billing');
    expect(html).toContain('/day to stop lawn pests before they turn green grass brown.');
    expect(html).not.toContain('/day for lawn care.');
    expect(html).not.toContain('Seasonal turf treatments matched to the lawn program');
    expect(html).not.toContain('Weed, fungus, chinch, and turf-stress observations');
    expect(html).not.toContain('Treatment timing adjusted for Southwest Florida conditions');
    expect(html).not.toContain('Lawn notes carried forward for future visits');
    // Lawn carries no WaveGuard setup fee — no setup line, nothing to waive.
    expect(html).not.toContain('WaveGuard Membership Setup');
    expect(html).not.toContain('<strong><s>$99</s> $0</strong>');
    expect(html).toContain('Pay the 12-month plan in full');
    // Prepay incentive is a 5% discount off the recurring annual, not a setup waiver.
    expect(html).toContain('Choose the 12-month plan up front and save 5%; we send the annual invoice automatically after confirmation.');
    expect(html).toContain('Prepay discount (5%)');
    expect(html).toContain('Save 5%');
    expect(html).not.toContain('Net setup fee: $0');
    expect(html).not.toContain('Annual Pay-in-Full Waiver');
    expect(html).not.toContain('<strong>-$99</strong>');
    expect(html).not.toContain('The $99 setup fee is waived on the prepay invoice.');
    // Annual plan total $660 → prepay invoice $627 (5% off the recurring annual).
    expect(html).toContain('data-prepay-discount-rate="0.05">$627</strong>');
    expect(html).toContain('data-prepay-copy-total data-prepay-discount-rate="0.05">$627</span>');
    expect(html).toContain("document.querySelectorAll('[data-prepay-copy-total]')");
    expect(html).toContain('const ANNUAL_PREPAY_INVOICE_TOTAL = 627;');
    expect(html).toContain('function currentAnnualPrepayInvoiceText()');
    expect(html).toContain("annual prepay invoice for ' + currentAnnualPrepayInvoiceText() + ' will be available for optional payment after confirmation.");
    expect(html).not.toContain('The WaveGuard Membership is included with the 12-month plan invoice.');
    expect(html).not.toContain('How billing works');
    expect(html).not.toContain('For comparison, your lawn care plan averages');
    expect(html).toContain('.q-bar{display:none}');
    expect(html).not.toContain('Wave Goodbye to Pests!');
    // The pest mini-guarantee ("Try us risk-free…") must not leak into lawn copy;
    // the 90-day money-back guarantee now appears via the dedicated plan-terms
    // section (owner-confirmed it applies to lawn too).
    expect(html).not.toContain('Try us risk-free');
    expect(html).toContain('class="card plan-terms-card"');
    expect(html).toContain('backed by a 90-day money-back guarantee');
    expect(html).not.toContain('Free annual termite inspection');
    expect(html).not.toContain('What WaveGuard members get');
  });

  test('server-rendered tree/shrub-only estimate uses tree/shrub-specific desktop copy', () => {
    const html = renderPage('tree-shrub-only-token', {
      status: 'sent',
      customerName: 'Jane Customer',
      address: '6539 Field Sparrow Gln',
      monthlyTotal: 72,
      annualTotal: 864,
      onetimeTotal: 0,
      tier: 'Bronze',
      satelliteUrl: 'https://maps.example/tree-shrub.png',
    }, {
      inputs: {
        homeSqFt: 2070,
        lotSqFt: 7326,
        bedArea: 1700,
        bedAreaSource: 'explicit',
        services: {
          treeShrub: {
            treeCount: 5,
            shrubDensity: 'moderate',
          },
        },
        landscapeComplexity: 'MODERATE',
      },
      result: {
        recurring: {
          services: [
            { name: 'Tree & Shrub', mo: 72, perTreatment: 96, visitsPerYear: 9 },
          ],
        },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: {
          ts: [
            { name: 'Standard', selected: false, recommended: false, v: 6 },
            { name: 'Enhanced', selected: true, recommended: true, v: 9 },
          ],
          tsMeta: { eb: 1700, et: 5 },
        },
      },
    });

    expect(html).toContain('tree &amp; shrub');
    expect(html).toContain('Waves AI reviewed your beds and trees before pricing this estimate');
    expect(html).toContain('Ornamental beds');
    expect(html).toContain('1,700 sq ft');
    expect(html).toContain('Trees/Shrubs');
    expect(html).toContain('5 trees, Moderate shrubs');
    expect(html).toContain('Pick your first tree &amp; shrub visit');
    expect(html).toContain('Tree &amp; Shrub (9x)');
    expect(html).toContain('What your tree &amp; shrub plan includes');
    expect(html).toContain('Ready to start tree &amp; shrub?');
    expect(html).not.toContain('Ready to start pest control?');
    expect(html).not.toContain('Skip parts you don&#39;t need');
  });

  test('server-rendered mosquito-only estimate uses mosquito-specific desktop copy', () => {
    const html = renderPage('mosquito-only-token', {
      status: 'sent',
      customerName: 'Maya Customer',
      address: '801 Lanai Loop',
      monthlyTotal: 82.5,
      annualTotal: 990,
      onetimeTotal: 0,
      tier: 'Bronze',
      satelliteUrl: 'https://maps.example/mosquito.png',
    }, {
      inputs: {
        homeSqFt: 2050,
        lotSqFt: 9800,
        services: { mosquito: { tier: 'seasonal9' } },
        pool: 'YES',
        poolCage: 'YES',
        poolCageSize: 'MEDIUM',
        landscapeComplexity: 'MODERATE',
      },
      result: {
        recurring: {
          services: [
            { name: 'Mosquito (Seasonal Mosquito Program)', mo: 82.5, perTreatment: 110, visitsPerYear: 9 },
          ],
        },
        oneTime: { items: [], specItems: [] },
        specItems: [],
        results: {
          mq: [
            { n: 'Seasonal Mosquito Program (9 visits)', v: 9, pv: 110, recommended: true },
            { n: 'Monthly Mosquito Program (12 visits)', v: 12, pv: 95 },
          ],
          mqMeta: {
            pr: 1.2,
            ri: 0,
            treatableSqFt: 8250,
          },
        },
      },
    });

    expect(html).toContain('mosquito control estimate');
    expect(html).toContain('Waves AI reviewed your mosquito treatment zones before pricing this estimate');
    expect(html).toContain('Mosquito treatment area');
    expect(html).toContain('8,250 sq ft');
    expect(html).toContain('Mosquito program');
    expect(html).toContain('Seasonal (9 visits/year)');
    expect(html).toContain('Mosquito pressure');
    expect(html).toContain('1.2x');
    expect(html).toContain('Pick your first mosquito control visit');
    expect(html).toContain('What your mosquito control plan includes');
    expect(html).toContain('Ready to start mosquito control?');
    expect(html).toContain('How long does it last?');
    expect(html).not.toContain('Ready to start pest control?');
    expect(html).not.toContain('Go Waves! Wave Goodbye to Pests!');
    expect(html).not.toContain('Free annual termite inspection');
    expect(html).not.toContain('What WaveGuard members get');
  });

  test('server-rendered one-time mosquito estimate uses mosquito-specific copy', () => {
    const html = renderPage('mosquito-onetime-token', {
      status: 'sent',
      customerName: 'Maya Customer',
      address: '801 Lanai Loop',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 275,
      tier: 'Bronze',
      satelliteUrl: 'https://maps.example/mosquito-onetime.png',
    }, {
      inputs: {
        homeSqFt: 2050,
        lotSqFt: 9800,
        mosquitoTreatmentAreaSqFt: 8250,
        svcOnetimeMosquito: true,
        pool: 'YES',
        poolCage: 'YES',
        poolCageSize: 'MEDIUM',
      },
      result: {
        recurring: { services: [] },
        oneTime: {
          total: 275,
          items: [{
            service: 'one_time_mosquito',
            name: 'One-Time Mosquito Treatment',
            price: 275,
            detail: 'Rain re-spray guarantee',
          }],
          specItems: [],
        },
        specItems: [],
        results: {
          mqMeta: {
            pr: 1.2,
            treatableSqFt: 8250,
          },
        },
      },
    });

    expect(html).toContain('mosquito control estimate');
    expect(html).toContain('Waves AI reviewed your mosquito treatment zones before pricing this estimate');
    expect(html).toContain('Mosquito treatment area');
    expect(html).toContain('8,250 sq ft');
    expect(html).toContain('Mosquito pressure');
    expect(html).toContain('1.2x');
    expect(html).toContain('Pick your first mosquito control visit');
    expect(html).toContain('One-Time Mosquito Treatment');
    expect(html).toContain('data-estimate-ask-prompt="How long does it last?"');
    expect(html).toContain('data-estimate-ask-prompt="Are pets and kids safe?"');
    expect(html).not.toContain('custom quote');
    expect(html).not.toContain('Find a date &amp; time that works for you');
    expect(html).not.toContain('What WaveGuard members get');
    expect(html).not.toContain('data-estimate-ask-prompt="What products do you use?"');
  });

  test('server-rendered one-time mosquito estimate keeps mosquito copy with reconciliation adjustment row', () => {
    const estimateData = {
      inputs: {
        homeSqFt: 2050,
        lotSqFt: 9800,
        mosquitoTreatmentAreaSqFt: 8250,
        svcOnetimeMosquito: true,
        pool: 'YES',
        poolCage: 'YES',
        poolCageSize: 'MEDIUM',
      },
      result: {
        recurring: { services: [] },
        oneTime: {
          total: 325,
          items: [{
            service: 'one_time_mosquito',
            name: 'One-Time Mosquito Treatment',
            price: 275,
            detail: 'Rain re-spray guarantee',
          }],
          specItems: [],
        },
        specItems: [],
        results: {
          mqMeta: {
            pr: 1.2,
            treatableSqFt: 8250,
          },
        },
      },
    };
    expect(normalizeOneTimeBreakdown(estimateData).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: 'one_time_adjustment',
        amount: 50,
      }),
    ]));

    const html = renderPage('mosquito-onetime-adjustment-token', {
      status: 'sent',
      customerName: 'Maya Customer',
      address: '801 Lanai Loop',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 325,
      tier: 'Bronze',
      satelliteUrl: 'https://maps.example/mosquito-onetime.png',
    }, estimateData);

    expect(html).toContain('mosquito control estimate');
    expect(html).toContain('Waves AI reviewed your mosquito treatment zones before pricing this estimate');
    expect(html).toContain('Mosquito treatment area');
    expect(html).toContain('8,250 sq ft');
    expect(html).toContain('Pick your first mosquito control visit');
    expect(html).not.toContain('Find a date &amp; time that works for you');
    expect(html).not.toContain('Go Waves! Wave Goodbye to Pests!');
  });

  test('server-rendered setup-only one-time row does not trigger mosquito copy', () => {
    const html = renderPage('setup-only-token', {
      status: 'sent',
      customerName: 'Sam Customer',
      address: '10 Setup Row',
      monthlyTotal: 0,
      annualTotal: 0,
      onetimeTotal: 99,
      tier: 'Bronze',
    }, {
      result: {
        recurring: { services: [] },
        oneTime: {
          total: 99,
          items: [{ service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 }],
          specItems: [],
        },
        specItems: [],
      },
    });

    expect(html).not.toContain('mosquito control estimate');
    expect(html).not.toContain('Pick your first mosquito control visit');
    expect(html).not.toContain('Waves AI reviewed your mosquito treatment zones before pricing this estimate');
  });

  test('server-rendered termite-bait-only estimate uses termite-specific desktop copy', () => {
    const html = renderPage('termite-bait-only-token', {
      status: 'sent',
      customerName: 'Terry Customer',
      address: '321 Barrier Way',
      monthlyTotal: 45,
      annualTotal: 540,
      onetimeTotal: 420,
      tier: 'Bronze',
      satelliteUrl: 'https://maps.example/termite.png',
    }, {
      inputs: {
        homeSqFt: 2200,
        lotSqFt: 7800,
        termitePerimeterFt: 185,
        services: { termiteBait: true },
      },
      result: {
        recurring: {
          services: [
            { name: 'Termite Bait Stations', mo: 45, perTreatment: 135, visitsPerYear: 4 },
          ],
        },
        oneTime: {
          total: 519,
          membershipFee: 99,
          items: [
            { service: 'waveguard_setup', name: 'WaveGuard setup', price: 99 },
            { service: 'termite_bait_installation', name: 'Termite bait installation', price: 420 },
          ],
          specItems: [],
        },
        specItems: [],
        results: {
          tmBait: { perim: 185, sta: 24 },
        },
      },
    });

    expect(html).toContain('termite protection estimate');
    expect(html).toContain('Waves AI reviewed your termite perimeter before pricing this estimate');
    expect(html).toContain('Termite perimeter');
    expect(html).toContain('185 linear ft');
    expect(html).toContain('Pick your first termite protection visit');
    expect(html).toContain('Choose how you want to pay');
    // Termite carries no WaveGuard setup fee; prepay earns a 5% discount instead.
    // The bait-station install stays a separate one-time charge, never discounted.
    expect(html).not.toContain('WaveGuard Membership Setup');
    expect(html).not.toContain('<s>$99</s> $0');
    expect(html).toContain('Save 5%');
    expect(html).toContain('Prepay discount (5%)');
    expect(html).toContain('One-time items (billed separately)');
    expect(html).toContain('Termite bait installation');
    expect(html).toContain('One-time total</strong></td><td style="text-align:right"><strong>$420</strong>');
    expect(html).toContain('What your termite protection plan includes');
    expect(html).toContain('Ready to start termite protection?');
    expect(html).toContain('How does the bait work?');
    expect(html).not.toContain('Ready to start pest control?');
    expect(html).not.toContain('Go Waves! Wave Goodbye to Pests!');
    expect(html).not.toContain('Skip parts you don&#39;t need');
    expect(html).not.toContain('Free annual termite inspection');
    expect(html).not.toContain('What WaveGuard members get');
    expect(html).not.toContain('Your WaveGuard membership goes beyond routine visits');
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
    expect(html).toContain('data-estimate-ask-prompt="Are pets and kids safe?"');
    expect(html).toContain('data-estimate-ask-prompt="When am I charged?"');
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
    expect(pricing.combinedRecurring).toEqual(expect.objectContaining({
      monthlySubtotal: 149,
      annualSubtotal: 1788,
      qualifyingCount: 1,
    }));
    expect(pricing.services).toHaveLength(1);
    expect(pricing.services[0]).toEqual(expect.objectContaining({
      key: 'bundle',
      isPest: true,
      isRecurring: true,
    }));
    expect(pricing.services[0].frequencies.map((frequency) => frequency.key)).toEqual(['quarterly', 'bi_monthly', 'monthly']);
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

  test('Lawn V2 recurring rows count for tier and receive public percent discounts', () => {
    const parts = resolveRecurringMonthlyParts({
      monthly_total: 110.3,
      waveguard_tier: 'Silver',
    }, {
      result: {
        recurring: {
          services: [
            { service: 'pest_control', name: 'Pest Control', mo: 50 },
            {
              service: 'lawn_care',
              name: 'Lawn Care',
              mo: 69,
              discountable: false,
              discountEligible: false,
              waveGuardDiscountEligible: false,
              waveGuardTierEligible: true,
              countsTowardWaveGuardTier: true,
              discount: {
                discountable: false,
                policy: 'LAWN_V2_NET_55_FLOOR_PRICE',
              },
            },
          ],
        },
      },
    });

    expect(parts).toEqual(expect.objectContaining({
      baseMonthly: 119,
      discountableBaseMonthly: 119,
      nonDiscountableMonthly: 0,
      source: 'summed',
    }));
    expect(monthlyForRecurringParts(parts, 'Silver')).toBe(107.1);
  });

  test('public recurring services upgrade stale Lawn V2 discount exclusions from engine line items', () => {
    const supplemented = withSupplementedRecurringServices({
      result: {
        lineItems: [
          {
            service: 'lawn_care',
            label: 'Lawn Care',
            annual: 828,
            annualAfterDiscount: 745.2,
            monthly: 69,
            monthlyAfterDiscount: 62.1,
            perApp: 92,
            visitsPerYear: 9,
            discount: {
              discountable: false,
              policy: 'LAWN_V2_NET_55_FLOOR_PRICE',
            },
          },
          {
            service: 'pest_control',
            label: 'Pest Control',
            annual: 600,
            monthly: 50,
          },
        ],
        recurring: {
          services: [
            { service: 'lawn_care', name: 'Lawn Care', mo: 69 },
            { service: 'pest_control', name: 'Pest Control', mo: 50 },
          ],
        },
      },
    });

    const lawn = supplemented.result.recurring.services.find((svc) => svc.service === 'lawn_care');
    expect(lawn).toMatchObject({
      mo: 69,
      monthly: 69,
      annual: 828,
      discountable: true,
      discountEligible: true,
      waveGuardDiscountEligible: true,
      waveGuardTierEligible: true,
      countsTowardWaveGuardTier: true,
    });
    expect(lawn.discount).toMatchObject({
      discountable: true,
    });
    expect(lawn.discount.policy).toBeUndefined();
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

  test('acceptance one-time choice recurring filter only applies to pest choices', () => {
    expect(shouldPersistPestOnlyRecurringChoice({
      show_one_time_option: true,
    }, {
      result: {
        recurring: {
          services: [{ service: 'mosquito', name: 'Mosquito', mo: 82.5 }],
        },
        oneTime: {
          total: 275,
          items: [{ service: 'one_time_mosquito', name: 'One-Time Mosquito Treatment', price: 275 }],
        },
      },
    })).toBe(false);

    expect(shouldPersistPestOnlyRecurringChoice({
      show_one_time_option: true,
    }, {
      result: {
        recurring: {
          services: [
            { service: 'pest_control', name: 'Pest Control', mo: 45 },
            { service: 'lawn_care', name: 'Lawn Care', mo: 75 },
          ],
        },
        oneTime: {
          total: 250,
          items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 250 }],
        },
      },
    })).toBe(true);
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
      invoicePayUrl: '/pay/token-123',
      treatAsOneTime: true,
    })).toEqual(expect.objectContaining({
      success: true,
      nextStep: 'pay_invoice',
      serviceMode: 'one_time',
      invoiceMode: true,
      invoiceLinkDelivered: false,
      invoiceId: 'inv-123',
      invoiceAmount: 249,
      invoicePayUrl: '/pay/token-123?source=estimate&billingTerm=standard',
    }));
  });

  test('accept success payload marks annual prepay as invoice payment without onboarding', () => {
    expect(buildAcceptSuccessPayload({
      invoiceMode: true,
      invoiceId: 'inv-annual',
      invoicePayUrl: '/pay/annual-token',
      billingTerm: 'prepay_annual',
      prepayInvoiceAmount: 660,
      treatAsOneTime: false,
    })).toEqual(expect.objectContaining({
      success: true,
      nextStep: 'pay_invoice',
      serviceMode: 'recurring',
      invoicePayUrl: '/pay/annual-token?source=estimate&saveCard=1&billingTerm=prepay_annual',
      billingTerm: 'prepay_annual',
      prepayInvoiceAmount: 660,
    }));
  });

  test('accept success payload does not report annual prepay for one-time accepts', () => {
    expect(buildAcceptSuccessPayload({
      billingTerm: 'prepay_annual',
      treatAsOneTime: true,
      reservationCommitted: false,
    })).toEqual(expect.objectContaining({
      nextStep: 'book_one_time',
      serviceMode: 'one_time',
    }));
  });

  test('annual prepay amount falls back to monthly times twelve', () => {
    expect(resolveAnnualPrepayInvoiceAmount(null, 55)).toBe(660);
    expect(resolveAnnualPrepayInvoiceAmount(720, 55)).toBe(720);
    expect(resolveAnnualPrepayInvoiceAmount(null, null)).toBe(0);
  });

  test('accept payment preference canonicalizes card-on-file aliases', () => {
    expect(normalizeAcceptPaymentMethodPreference('card_on_file')).toBe('pay_at_visit');
    expect(normalizeAcceptPaymentMethodPreference('deposit_now')).toBe('pay_at_visit');
    expect(normalizeAcceptPaymentMethodPreference('pay_at_visit')).toBe('pay_at_visit');
    expect(normalizeAcceptPaymentMethodPreference('prepay_annual')).toBe('prepay_annual');
    expect(normalizeAcceptPaymentMethodPreference('deposit_later')).toBeNull();
  });

  test('recurring appointment accepts require an invoice payment preference', () => {
    expect(validateRecurringSlotPaymentPreference({
      slotId: 'slot-123',
      treatAsOneTime: false,
      paymentMethodPreference: null,
    })).toMatch(/Choose pay per application/);
    expect(validateRecurringSlotPaymentPreference({
      slotId: 'slot-123',
      treatAsOneTime: false,
      paymentMethodPreference: 'pay_at_visit',
    })).toBeNull();
    expect(validateRecurringSlotPaymentPreference({
      slotId: 'slot-123',
      treatAsOneTime: false,
      paymentMethodPreference: 'card_on_file',
    })).toMatch(/Choose pay per application/);
    expect(validateRecurringSlotPaymentPreference({
      slotId: 'slot-123',
      treatAsOneTime: false,
      paymentMethodPreference: 'prepay_annual',
    })).toBeNull();
    expect(validateRecurringSlotPaymentPreference({
      slotId: 'slot-123',
      treatAsOneTime: true,
      paymentMethodPreference: null,
    })).toBeNull();
    expect(validateRecurringSlotPaymentPreference({
      slotId: 'slot-123',
      treatAsOneTime: false,
      billByInvoice: true,
      paymentMethodPreference: 'pay_at_visit',
    })).toBeNull();
    expect(validateRecurringSlotPaymentPreference({
      existingAppointmentId: 'appointment-123',
      treatAsOneTime: false,
      paymentMethodPreference: 'pay_at_visit',
    })).toBeNull();
    expect(validateRecurringSlotPaymentPreference({
      existingAppointmentId: 'appointment-123',
      treatAsOneTime: false,
      paymentMethodPreference: 'card_on_file',
    })).toMatch(/Choose pay per application/);
  });

  test('pay-per-application invoice copy matches setup and first application charges', () => {
    expect(buildStandardPayPerApplicationInvoiceCopy({
      setupAmount: 99,
      firstApplicationAmount: 128,
    })).toEqual(expect.objectContaining({
      hasSetup: true,
      hasFirstApplication: true,
      totalAmount: 227,
      payPrefCardSub: 'Invoice includes WaveGuard setup + first application ($227).',
    }));

    expect(buildStandardPayPerApplicationInvoiceCopy({
      setupAmount: 99,
      firstApplicationAmount: 0,
    })).toEqual(expect.objectContaining({
      hasSetup: true,
      hasFirstApplication: false,
      totalAmount: 99,
      payPrefCardSub: 'Invoice includes WaveGuard setup ($99).',
    }));

    expect(buildStandardPayPerApplicationInvoiceCopy({
      setupAmount: 0,
      firstApplicationAmount: 88.5,
    })).toEqual(expect.objectContaining({
      hasSetup: false,
      hasFirstApplication: true,
      totalAmount: 88.5,
      payPrefCardSub: 'Invoice includes the first application ($88.50).',
    }));
  });

  test('existing appointment accepts reject stale active-row updates', () => {
    expect(assertExistingAppointmentUpdateApplied(1)).toBe(1);

    try {
      assertExistingAppointmentUpdateApplied(0);
      throw new Error('expected stale appointment update to throw');
    } catch (err) {
      expect(err.message).toBe('existing appointment is no longer available — re-pick a slot');
      expect(err.status).toBe(409);
    }
  });

  test('existing appointment accepts distinguish reservation-held rows', () => {
    expect(isReservationHeldAppointment({ reservation_expires_at: '2026-06-06T12:15:00.000Z' })).toBe(true);
    expect(isReservationHeldAppointment({ reservation_expires_at: null })).toBe(false);
    expect(isReservationHeldAppointment({})).toBe(false);
  });

  test('acceptance visit pricing uses displayed per-application totals before cadence fallback', () => {
    expect(sameDayVisitTotalForPricingFrequency({
      sameDayTreatmentTotal: 244,
      perServiceTreatments: [
        { label: 'Pest Control', perTreatment: 128, displayPrice: 115.2 },
        { label: 'Lawn Care', perTreatment: 116, displayPrice: 104.4 },
      ],
    })).toBe(219.6);

    expect(sameDayVisitTotalForPricingFrequency({
      sameDayTreatmentTotal: 73.33,
      perServiceTreatments: [],
    })).toBe(73.33);

    expect(sameDayVisitTotalForPricingFrequency({
      sameDayTreatmentTotal: 244,
      perServiceTreatments: [
        { service: 'pest_control', label: 'Pest Control', visitsPerYear: 4, displayPrice: 115.2 },
        { service: 'lawn_care', label: 'Lawn Care', visitsPerYear: 9 },
      ],
    })).toBe(244);

    expect(sameDayVisitTotalForPricingFrequency({
      perServiceTreatments: [
        { service: 'pest_control', label: 'Pest Control', visitsPerYear: 4, displayPrice: 115.2 },
        { service: 'lawn_care', label: 'Lawn Care', visitsPerYear: 9 },
      ],
    })).toBeNull();
  });

  test('acceptance same-day pricing requires priced rows for every accepted service when service list is known', () => {
    const services = [
      { service: 'pest_control', name: 'Pest Control' },
      { service: 'lawn_care', name: 'Lawn Care' },
    ];

    expect(sameDayVisitTotalForPricingFrequency({
      sameDayTreatmentTotal: 244,
      perServiceTreatments: [
        { service: 'pest_control', label: 'Pest Control', visitsPerYear: 4, displayPrice: 115.2 },
        { service: 'lawn_care', label: 'Lawn Care', visitsPerYear: 9 },
      ],
    }, { services })).toBeNull();

    expect(sameDayVisitTotalForPricingFrequency({
      sameDayTreatmentTotal: 244,
      perServiceTreatments: [
        { service: 'pest_control', label: 'Pest Control', visitsPerYear: 4, displayPrice: 115.2 },
        { service: 'lawn_care', label: 'Lawn Care', visitsPerYear: 9, displayPrice: 104.4 },
      ],
    }, { services })).toBe(219.6);
  });

  test('acceptance visit pricing applies pest preference discounts to same-day totals', () => {
    expect(sameDayVisitTotalForPricingFrequency({
      sameDayTreatmentTotal: 244,
      perServiceTreatments: [
        {
          service: 'pest_control',
          label: 'Pest Control',
          visitsPerYear: 4,
          perTreatment: 128,
          displayPrice: 115.2,
        },
        {
          service: 'lawn_care',
          label: 'Lawn Care',
          visitsPerYear: 9,
          perTreatment: 116,
          displayPrice: 104.4,
        },
      ],
    }, {
      preferences: { interior_spray: false, exterior_sweep: true },
    })).toBe(209.61);
  });

  test('annual prepay eligibility covers every recurring service mix', () => {
    // Under the unified model every recurring mix can prepay (pest/mosquito waive
    // the setup, all others take the 5% discount).
    expect(isAnnualPrepayEligibleServiceMix([
      { name: 'Pest Control' },
    ], [])).toBe(true);
    expect(isAnnualPrepayEligibleServiceMix([
      { service: 'lawn_care', name: 'Lawn Care' },
    ], [])).toBe(true);
    expect(isAnnualPrepayEligibleServiceMix([
      { service: 'mosquito', name: 'Mosquito' },
    ], [])).toBe(true);
    expect(isAnnualPrepayEligibleServiceMix([
      { service: 'tree_shrub', name: 'Tree & Shrub' },
      { service: 'palm_injection', name: 'Palm Injection' },
    ], [])).toBe(true);
    // One-time-only estimates (no recurring rows) remain ineligible.
    expect(isAnnualPrepayEligibleServiceMix([], [
      { service: 'one_time_pest', name: 'One-Time Pest' },
    ])).toBe(false);
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
      invoicePayUrl: '/pay/inv-123',
    })).toEqual(expect.objectContaining({
      nextStep: 'pay_invoice',
      invoiceMode: true,
      invoiceLinkDelivered: true,
      invoiceId: 'inv-123',
      invoicePayUrl: '/pay/inv-123?source=estimate&saveCard=1&billingTerm=standard',
    }));
  });

  test('estimate invoice delivery params default save-card only for recurring accepts', () => {
    expect(estimateInvoicePayUrlParams({
      billingTerm: 'standard',
      saveCard: true,
    })).toEqual({
      source: 'estimate',
      saveCard: '1',
      billingTerm: 'standard',
    });

    expect(estimateInvoicePayUrlParams({
      billingTerm: 'standard',
      saveCard: false,
    })).toEqual({
      source: 'estimate',
      billingTerm: 'standard',
    });
  });

  test('accept success payload distinguishes one-time booking from recurring', () => {
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
      treatAsOneTime: false,
    })).toEqual(expect.objectContaining({
      nextStep: 'confirmed',
      serviceMode: 'recurring',
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
      invoiceMode: true,
      invoiceLinkDelivered: true,
      invoicePayUrl: '/pay/gold-token',
    })).toBe('Estimate accepted by Jane Doe at 123 Main St - Gold WaveGuard $89/mo. Invoice pay link sent.');

    expect(buildAcceptOfficeFallback({
      customerName: 'Jane Doe',
      address: '123 Main St',
      waveguardTier: 'Bronze',
      billingTerm: 'prepay_annual',
      annualPrepayAmount: 660,
      invoiceMode: true,
      invoicePayUrl: '/pay/annual-token',
    })).toBe('Estimate accepted by Jane Doe at 123 Main St - Bronze WaveGuard annual prepay $660. Invoice created; optional pay link available.');

    expect(buildAcceptOfficeFallback({
      customerName: null,
      address: null,
      waveguardTier: 'Bronze',
      monthlyTotal: 89,
      invoiceMode: true,
      invoicePayUrl: '/pay/setup-token',
    })).toBe('Estimate accepted by Unknown customer at address unavailable - Bronze WaveGuard $89/mo. Setup + first application invoice created; optional pay link available.');
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
      invoiceMode: true,
      invoiceLinkDelivered: true,
      invoicePayUrl: '/pay/gold-token',
    })).toEqual(expect.objectContaining({
      adminTitle: 'Estimate accepted: Jane Doe',
      adminBody: 'Gold WaveGuard $89/mo approved. Invoice pay link sent.',
      customerBody: 'Your Gold WaveGuard plan is approved. Use the invoice pay link if you want to pay now and save a card, or pay later.',
      customerLink: '/pay/gold-token',
    }));

    expect(buildAcceptNotificationPayload({
      customerName: 'Jane Doe',
      waveguardTier: 'Bronze',
      billingTerm: 'prepay_annual',
      annualPrepayAmount: 660,
      invoiceMode: true,
      invoicePayUrl: '/pay/annual-token',
    })).toEqual(expect.objectContaining({
      adminTitle: 'Estimate accepted: Jane Doe',
      adminBody: 'Bronze WaveGuard annual prepay $660 approved. Invoice created; optional pay link available.',
      customerBody: 'Your Bronze WaveGuard plan is approved. Use the invoice pay link if you want to pay now and save a card, or pay later.',
      customerLink: '/pay/annual-token',
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
      invoicePayUrl: '/pay/rodent-token',
    })).toEqual(expect.objectContaining({
      adminBody: 'Rodent Service approved. Invoice pay link is being sent.',
      customerBody: 'Your Rodent Service estimate is approved. Use the invoice pay link if you want to pay now, or pay later.',
      customerLink: '/pay/rodent-token',
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

  test('preview user agents suppress first-view customer side effects', () => {
    const req = {
      headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' },
    };

    expect(shouldApplyFirstViewSideEffects(req, '203.0.113.10')).toBe(false);
  });

  test('normal public requests still apply first-view customer side effects', () => {
    const req = { headers: {} };

    expect(shouldApplyFirstViewSideEffects(req, '203.0.113.10')).toBe(true);
  });

  test('unsent estimates suppress view tracking side effects', () => {
    const req = { headers: {} };

    expect(shouldApplyFirstViewSideEffects(req, '203.0.113.10', { sent_at: null })).toBe(false);
    expect(shouldApplyFirstViewSideEffects(req, '203.0.113.10', { sent_at: '2026-05-20T12:00:00.000Z' })).toBe(true);
  });
});
