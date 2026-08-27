const {
  normalizeFrequency,
  normalizeProposal,
  computeProposalTotals,
} = require('../services/estimate-proposal');

describe('estimate-proposal', () => {
  describe('normalizeFrequency', () => {
    it('canonicalizes synonyms and falls back to monthly', () => {
      expect(normalizeFrequency('Quarterly')).toBe('quarterly');
      expect(normalizeFrequency('bi-monthly')).toBe('bimonthly');
      expect(normalizeFrequency('yearly')).toBe('annual');
      expect(normalizeFrequency('one-time')).toBe('one_time');
      expect(normalizeFrequency('onetime')).toBe('one_time');
      expect(normalizeFrequency('garbage')).toBe('monthly');
    });
  });

  describe('normalizeProposal', () => {
    it('reads an authored multi-building proposal from estimate_data', () => {
      const estimate = {
        customer_name: 'Siesta Sands HOA',
        address: '100 Beach Rd',
        estimate_data: {
          proposal: {
            enabled: true,
            taxRate: 0.07,
            buildings: [
              { name: 'Tower A', lineItems: [{ description: 'Common-area pest', unitPrice: 350, frequency: 'monthly' }] },
              { name: 'Lake Houses', lineItems: [{ description: 'Perimeter', quantity: 50, unitPrice: 5.5, frequency: 'monthly' }] },
            ],
          },
        },
      };
      const p = normalizeProposal(estimate);
      expect(p.enabled).toBe(true);
      expect(p.synthesized).toBe(false);
      expect(p.buildings).toHaveLength(2);
      expect(p.buildings[0].lineItems[0].amount).toBe(350);
      expect(p.buildings[1].lineItems[0].amount).toBe(275); // 50 * 5.5
      expect(p.taxRate).toBe(0.07);
    });

    it('parses estimate_data when stored as a JSON string', () => {
      const estimate = {
        customer_name: 'X',
        estimate_data: JSON.stringify({
          proposal: { enabled: true, buildings: [{ name: 'B', lineItems: [{ description: 'svc', unitPrice: 100, frequency: 'monthly' }] }] },
        }),
      };
      const p = normalizeProposal(estimate);
      expect(p.buildings[0].lineItems[0].unitPrice).toBe(100);
    });

    it('synthesizes a single-building fallback from stored totals when no proposal authored', () => {
      const estimate = { customer_name: 'Y', address: '5 Elm', monthly_total: 120, onetime_total: 200, estimate_data: {} };
      const p = normalizeProposal(estimate);
      expect(p.enabled).toBe(false);
      expect(p.synthesized).toBe(true);
      expect(p.buildings).toHaveLength(1);
      const descs = p.buildings[0].lineItems.map((l) => l.frequency).sort();
      expect(descs).toEqual(['monthly', 'one_time']);
    });

    it('clamps a nonsense tax rate into [0,1]', () => {
      const estimate = { estimate_data: { proposal: { enabled: true, taxRate: 9, buildings: [{ name: 'B', lineItems: [{ description: 's', unitPrice: 1, frequency: 'monthly' }] }] } } };
      expect(normalizeProposal(estimate).taxRate).toBe(1);
    });

    it('clamps negative unit prices to 0 so totals can never go negative', () => {
      const estimate = {
        estimate_data: {
          proposal: {
            enabled: true,
            buildings: [{
              name: 'Tower A',
              lineItems: [
                { description: 'Hostile negative line', unitPrice: -500, frequency: 'monthly' },
                { description: 'Legit line', unitPrice: 200, frequency: 'monthly' },
              ],
            }],
          },
        },
      };
      const p = normalizeProposal(estimate);
      expect(p.buildings[0].lineItems[0].unitPrice).toBe(0);
      expect(p.buildings[0].lineItems[0].amount).toBe(0);
      const totals = computeProposalTotals(p);
      expect(totals.monthlyEquivalent).toBeGreaterThanOrEqual(0);
      expect(totals.annualRecurring).toBe(200 * 12);
    });
  });

  describe('computeProposalTotals', () => {
    it('annualizes by cadence and applies tax only to taxable lines', () => {
      const estimate = {
        estimate_data: {
          proposal: {
            enabled: true,
            taxRate: 0.07,
            buildings: [
              {
                name: 'Tower A',
                lineItems: [
                  { description: 'Monthly pest', unitPrice: 350, frequency: 'monthly', taxable: false },     // 4200/yr
                  { description: 'Annual termite', unitPrice: 1200, frequency: 'annual', taxable: true },     // 1200/yr taxable
                  { description: 'Palm injection', quantity: 40, unitPrice: 18, frequency: 'one_time', taxable: true }, // 720 one-time taxable
                ],
              },
            ],
          },
        },
      };
      const t = computeProposalTotals(normalizeProposal(estimate));
      expect(t.annualRecurring).toBe(5400);          // 4200 + 1200
      expect(t.monthlyEquivalent).toBe(450);          // 5400 / 12
      expect(t.oneTime).toBe(720);
      // tax = (1200 taxable annual + 720 taxable one-time) * 0.07
      expect(t.totalTax).toBe(134.4);
      expect(t.firstYearTotal).toBe(6254.4);          // 5400 + 720 + 134.4
      expect(t.hasTax).toBe(true);
    });

    it('produces zero tax when no rate is set (residential HOA default)', () => {
      const estimate = {
        estimate_data: { proposal: { enabled: true, buildings: [{ name: 'B', lineItems: [{ description: 'pest', unitPrice: 100, frequency: 'monthly', taxable: true }] }] } },
      };
      const t = computeProposalTotals(normalizeProposal(estimate));
      expect(t.totalTax).toBe(0);
      expect(t.hasTax).toBe(false);
      expect(t.firstYearTotal).toBe(1200);
    });

    it('folds corrective-work amounts into the one-time totals with per-line tax', () => {
      const estimate = {
        estimate_data: {
          proposal: {
            enabled: true,
            taxRate: 0.07,
            buildings: [{ name: 'B', lineItems: [{ description: 'pest', unitPrice: 100, frequency: 'monthly' }] }],
            correctiveWork: [
              { label: 'German roach cleanout — Units 2 & 4', amount: 450, taxable: true },
              { label: 'Exclusion — soffit gaps', amount: 300 },
            ],
          },
        },
      };
      const t = computeProposalTotals(normalizeProposal(estimate));
      expect(t.oneTime).toBe(750);
      expect(t.taxableOneTime).toBe(450);
      expect(t.totalTax).toBe(31.5);              // 450 * 0.07
      expect(t.firstYearTotal).toBe(1981.5);      // 1200 + 750 + 31.5
    });

    it('flags multi-building proposals', () => {
      const estimate = {
        estimate_data: { proposal: { enabled: true, buildings: [
          { name: 'A', lineItems: [{ description: 'x', unitPrice: 1, frequency: 'monthly' }] },
          { name: 'B', lineItems: [{ description: 'y', unitPrice: 1, frequency: 'monthly' }] },
        ] } },
      };
      expect(computeProposalTotals(normalizeProposal(estimate)).isMultiBuilding).toBe(true);
    });
  });
});

describe('structured proposal sections (slice 1A-i)', () => {
  const authored = (extra) => ({
    estimate_data: {
      proposal: {
        enabled: true,
        buildings: [{ name: 'B', lineItems: [{ description: 'pest', unitPrice: 100, frequency: 'monthly' }] }],
        ...extra,
      },
    },
  });

  it('normalizes every structured section and RETURNS it (PUT persists the normalizer output — an unreturned field is silently dropped on save)', () => {
    const p = normalizeProposal(authored({
      propertyScope: { items: [{ label: 'Units', value: '4 residential units' }, { label: '', value: 'dropped' }] },
      correctiveWork: [{ label: 'Cleanout', amount: 450.005, taxable: true, includes: ['Kitchens', '', 'Follow-up at 2 weeks'] }],
      customerResponsibilities: ['Provide unit access with 24-hour tenant notice', '  '],
      commercialTerms: { validDays: 30, paymentTerms: 'Net-30', initialTermMonths: 0, renewal: null, priceAdjustment: '', cancellation: '30-day written notice', accessRequirements: null },
    }));
    // paymentTerms canonicalizes to the payer vocabulary ('Net-30' → net30).
    expect(p.propertyScope).toEqual({ items: [{ label: 'Units', value: '4 residential units' }] });
    expect(p.correctiveWork).toEqual([{
      label: 'Cleanout', amount: 450.01, taxable: true, includes: ['Kitchens', 'Follow-up at 2 weeks'],
    }]);
    expect(p.customerResponsibilities).toEqual(['Provide unit access with 24-hour tenant notice']);
    // validDays in the input is IGNORED — no validity field exists until the
    // adjustable-expiry lane wires enforcement + rendering together.
    expect(p.commercialTerms).toEqual({
      paymentTerms: 'net30',
      initialTermMonths: 0,
      renewal: null,
      priceAdjustment: null,
      cancellation: '30-day written notice',
      accessRequirements: null,
    });
    // No accountManager (or validity) field — storage-only fields are
    // omitted until their authoring + rendering slices land.
    expect(p.accountManager).toBeUndefined();
  });

  it('normalizes every absent section to null so legacy proposals render exactly as before', () => {
    const p = normalizeProposal(authored({}));
    expect(p.propertyScope).toBeNull();
    expect(p.correctiveWork).toBeNull();
    expect(p.customerResponsibilities).toBeNull();
    expect(p.generatedResponsibilities).toBeNull();
    expect(p.commercialTerms).toBeNull();
    expect(p.accountManager).toBeUndefined();
  });

  it('round-trips generatedResponsibilities provenance (r15): builder-consumed metadata, bounded, null when absent/hostile', () => {
    const p = normalizeProposal(authored({
      generatedResponsibilities: {
        pest: ['Report pest activity between visits through the Waves app or office line', '  '],
        lawn: [],
        '': ['orphan'],
      },
    }));
    // Empty families and blank lines drop; the map itself survives the
    // PUT round-trip so a reopened proposal prunes exactly what its
    // generation installed — never static-catalog membership.
    expect(p.generatedResponsibilities).toEqual({
      pest: ['Report pest activity between visits through the Waves app or office line'],
    });
    const hostile = normalizeProposal(authored({ generatedResponsibilities: ['not-an-object'] }));
    expect(hostile.generatedResponsibilities).toBeNull();
  });

  it('keeps a BLANK initial term unset — Number(null)/Number("") must never coerce to the month-to-month claim', () => {
    const p = normalizeProposal(authored({
      commercialTerms: { validDays: 30, initialTermMonths: null, paymentTerms: 'Net-30' },
    }));
    expect(p.commercialTerms.initialTermMonths).toBeNull();
    const empty = normalizeProposal(authored({
      commercialTerms: { validDays: 30, initialTermMonths: '', paymentTerms: 'Net-30' },
    }));
    expect(empty.commercialTerms.initialTermMonths).toBeNull();
    // Explicit 0 IS month-to-month — the operator selected it.
    const zero = normalizeProposal(authored({
      commercialTerms: { validDays: 30, initialTermMonths: 0 },
    }));
    expect(zero.commercialTerms.initialTermMonths).toBe(0);
  });

  it('clamps hostile structured input: negative amounts to 0, out-of-range term numbers to null, empty sections to null', () => {
    const p = normalizeProposal(authored({
      correctiveWork: [{ label: 'Hostile', amount: -500 }, { amount: 100 }],
      propertyScope: { items: [{ label: 'x' }] },
      customerResponsibilities: [],
      commercialTerms: { validDays: 4000, initialTermMonths: -3, paymentTerms: '   ' },
    }));
    expect(p.correctiveWork).toEqual([{ label: 'Hostile', amount: 0, taxable: false, includes: [] }]);
    expect(p.propertyScope).toBeNull();          // label without value drops the row
    expect(p.customerResponsibilities).toBeNull();
    expect(p.commercialTerms).toBeNull();        // every field invalid → whole block null
  });

  it('normalizes service programs: derived annual, family enum, caps, unpriced rows dropped (slice 1A-ii)', () => {
    const p = normalizeProposal(authored({
      buildings: [],
      programs: [
        {
          service: 'pest', label: 'Quarterly pest program', frequencyPerYear: 4, pricePerApplication: 120.005,
          taxable: true, annual: 999999, // caller-supplied annual is IGNORED — derived from factors
          inclusions: ['4 visits', ''], exclusions: ['Termite — separate'],
          buildings: [{ name: 'Tower A' }, { name: '' }],
        },
        { service: 'not_a_family', label: 'Mystery', frequencyPerYear: 2, pricePerApplication: 50 },
        { service: 'lawn', label: 'Unpriced row', frequencyPerYear: 0, pricePerApplication: 100 },
      ],
    }));
    expect(p.programs).toHaveLength(2); // unpriced row dropped
    expect(p.programs[0]).toMatchObject({
      service: 'pest',
      label: 'Quarterly pest program',
      frequencyPerYear: 4,
      pricePerApplication: 120.01,
      annual: 480.04,               // 120.01 × 4, never the caller's number
      taxable: true,
      inclusions: ['4 visits'],
      buildings: [{ name: 'Tower A', note: null }],
    });
    expect(p.programs[1].service).toBe('other'); // unknown family demotes
    // Per-program provenance round-trips (r17): absent → [], present →
    // cleaned — the builder prunes ONLY these lines on a family switch.
    expect(p.programs[0].generatedInclusions).toEqual([]);
    const withProv = normalizeProposal(authored({
      buildings: [],
      programs: [{
        service: 'pest', label: 'P', frequencyPerYear: 4, pricePerApplication: 100,
        generatedInclusions: ['4 scheduled applications per year', '  '],
        generatedExclusions: ['Termite treatment or monitoring — separate program, quoted on inspection'],
      }],
    }));
    expect(withProv.programs[0].generatedInclusions).toEqual(['4 scheduled applications per year']);
    expect(withProv.programs[0].generatedExclusions).toHaveLength(1);
    // A programs-only stored proposal is authoritative — it must NOT fall
    // through to the synthesized fallback.
    expect(p.synthesized).toBe(false);
    expect(p.enabled).toBe(true);
  });

  it('folds program annuals into recurring totals with per-program tax', () => {
    const t = computeProposalTotals(normalizeProposal(authored({
      buildings: [],
      taxRate: 0.07,
      programs: [
        { service: 'pest', label: 'Pest', frequencyPerYear: 4, pricePerApplication: 100, taxable: true },   // 400 taxable
        { service: 'lawn', label: 'Lawn', frequencyPerYear: 9, pricePerApplication: 50 },                    // 450 exempt
      ],
    })));
    expect(t.annualRecurring).toBe(850);
    expect(t.taxableAnnualRecurring).toBe(400);
    expect(t.totalTax).toBe(28);
    expect(t.firstYearTotal).toBe(878);
  });

  it('program tax rounds per application × cadence, matching what invoices collect (r15b)', () => {
    // $100.07 × 4 at 7%: annual-bucket rounding would display $28.02, but
    // each application invoice collects round(100.07 × .07) = $7.00 — the
    // agreement must show the $28.00 billing actually charges.
    const t = computeProposalTotals(normalizeProposal(authored({
      buildings: [],
      taxRate: 0.07,
      programs: [
        { service: 'pest', label: 'Pest', frequencyPerYear: 4, pricePerApplication: 100.07, taxable: true },
      ],
    })));
    expect(t.annualRecurring).toBe(400.28);
    expect(t.recurringTax).toBe(28);
    expect(t.totalTax).toBe(28);
  });

  it('never authors structured sections onto a synthesized fallback', () => {
    const p = normalizeProposal({ customer_name: 'Y', monthly_total: 120, estimate_data: {} });
    expect(p.synthesized).toBe(true);
    expect(p.propertyScope).toBeNull();
    expect(p.correctiveWork).toBeNull();
    expect(p.commercialTerms).toBeNull();
  });
});

describe('isCommercialProposalData', () => {
  const { isCommercialProposalData } = require('../services/estimate-proposal');

  test('authored proposals and machine scaffolds both route to the proposal editor', () => {
    expect(isCommercialProposalData({ proposal: { enabled: true } })).toBe(true);
    // enabled:false scaffold — the normal edit flow would accept it and
    // then lose the operator's edits when revise rejects COMMERCIAL rows.
    expect(isCommercialProposalData({ proposal: { enabled: false, scaffold: true } })).toBe(true);
    expect(isCommercialProposalData({ proposal: { enabled: false } })).toBe(false);
    expect(isCommercialProposalData({})).toBe(false);
    expect(isCommercialProposalData(null)).toBe(false);
    expect(isCommercialProposalData(JSON.stringify({ proposal: { scaffold: true } }))).toBe(true);
  });
});

describe('per-application synthesis (owner rule 2026-07-31: residential bills per application or annual prepay, never a flat monthly)', () => {
  const { perApplicationRecurringLines, annualizedAmount } = require('../services/estimate-proposal');

  // Shaped like the 2026-07-31 customer report: bi-monthly lawn plan,
  // $540/yr = $90/application x 6, whose PDF previously printed
  // "Recurring service plan / Monthly / $45.00".
  const lawnFrequency = {
    key: 'standard',
    label: 'Bi-monthly',
    serviceCategory: 'lawn_care',
    monthly: 45,
    annual: 540,
    perTreatment: 90,
    visitsPerYear: 6,
    billedPerApplication: true,
  };
  const lawnEstimate = {
    customer_name: 'S. Morgan',
    address: '1 Oak St',
    service_interest: 'Lawn Care',
    monthly_total: 45,
    annual_total: 540,
    onetime_total: 0,
    accepted_frequency_key: 'standard',
    estimate_data: { sendSnapshot: { pricingBundle: { frequencies: [lawnFrequency] } } },
  };
  const withBundle = (estimate, bundle) => ({
    ...estimate,
    estimate_data: { sendSnapshot: { pricingBundle: bundle } },
  });
  const lines = (estimate) => perApplicationRecurringLines(estimate, estimate.estimate_data);

  it('quotes the accepted cadence per application, not per month', () => {
    const out = lines(lawnEstimate);
    expect(out).toHaveLength(1);
    expect(out[0].frequency).toBe('per_application');
    expect(out[0].frequencyLabel).toBe('Per application');
    expect(out[0].unitPrice).toBe(90);
    expect(out[0].visitsPerYear).toBe(6);
    expect(out[0].description).toBe('Lawn Care — 6 applications/yr');
    expect(annualizedAmount(out[0])).toBe(540);
  });

  it('matches by stored totals when no accepted key is stamped (unaccepted estimate)', () => {
    expect(lines({ ...lawnEstimate, accepted_frequency_key: null })[0].unitPrice).toBe(90);
  });

  it('picks the cadence matching the stored totals over a same-key mismatch', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 780, monthly_total: 65 }, {
      frequencies: [
        lawnFrequency,
        { ...lawnFrequency, key: 'enhanced', monthly: 65, annual: 780, perTreatment: 86.67, visitsPerYear: 9 },
      ],
    });
    expect(lines(est)[0].visitsPerYear).toBe(9);
  });

  // Codex #3120 r2: every real serviceCadenceCombos entry carries a MANDATORY
  // pest row (buildServiceCadenceCombos requires a pest axis), and combo rows
  // never carry billedPerApplication because the backfill walks only
  // frequencies. A flag-only rule rejected every production combo.
  it('resolves an accepted per-service cadence combination including its mandatory pest row', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 1288, monthly_total: null }, {
      frequencies: [{ ...lawnFrequency, annual: 540 }],
      serviceCadenceCombos: [
        {
          key: 'pest_quarterly|lawn_standard',
          selection: { pest_control: 'pest_quarterly', lawn_care: 'standard' },
          annual: 1600,
          perServiceTreatments: [
            { service: 'pest_control', label: 'Pest Control', displayPrice: 100, visitsPerYear: 4 },
            { service: 'lawn_care', label: 'Lawn Care Program', displayPrice: 200, visitsPerYear: 6 },
          ],
        },
        {
          key: 'pest_quarterly|lawn_enhanced',
          selection: { pest_control: 'pest_quarterly', lawn_care: 'enhanced' },
          annual: 1288,
          perServiceTreatments: [
            // No billedPerApplication anywhere — the production shape.
            { service: 'pest_control', label: 'Pest Control', displayPrice: 112, visitsPerYear: 4 },
            { service: 'lawn_care', label: 'Lawn Care Program', displayPrice: 140, visitsPerYear: 6 },
          ],
        },
      ],
    });
    const out = lines(est);
    expect(out).toHaveLength(2);
    expect(out.map((l) => l.frequency)).toEqual(['per_application', 'per_application']);
    expect(out[0].description).toBe('Pest Control — 4 applications/yr');
    expect(out[1].unitPrice).toBe(140);
    expect(out.reduce((a, l) => a + annualizedAmount(l), 0)).toBe(1288);
  });

  // Codex #3120 r2: buildServiceCadenceCombos omits manualDiscount from combo
  // entries, while withManualDiscount stores it on the BUNDLE.
  it('reads the bundle-level credit when a combo carries none', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 1188, monthly_total: null }, {
      manualDiscount: { recurringAmount: 100 },
      serviceCadenceCombos: [{
        key: 'pest_quarterly|lawn_standard',
        annual: 1188,
        perServiceTreatments: [
          { service: 'pest_control', label: 'Pest Control', displayPrice: 112, visitsPerYear: 4 },
          { service: 'lawn_care', label: 'Lawn Care Program', displayPrice: 140, visitsPerYear: 6 },
        ],
      }],
    });
    const out = lines(est);
    expect(out).toHaveLength(2);
    // The bundle credit explains the gap so the combo is accepted; the rows
    // keep the prices the invoice charges (codex r4).
    expect(out.map((l) => l.unitPrice)).toEqual([112, 140]);
  });

  // Codex #3120 r4: the accepted first-application amount comes from the
  // UNSCALED treatment rows and multi-service plans stay pre-credit, so the
  // credit explains the gap (identifying the cadence) but must NOT be
  // allocated into the printed per-application price.
  it('accepts a credit-explained gap but still quotes the price actually charged', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 486, monthly_total: null }, {
      frequencies: [{ ...lawnFrequency, annual: 486, manualDiscount: { recurringAmount: 54 } }],
    });
    const out = lines(est);
    expect(out).toHaveLength(1);
    expect(out[0].frequency).toBe('per_application');
    expect(out[0].unitPrice).toBe(90); // the charged rate, not (540-54)/6
  });

  it('rejects a gap the declared credit does not explain', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 400, monthly_total: null }, {
      frequencies: [{ ...lawnFrequency, annual: 400, manualDiscount: { recurringAmount: 54 } }],
    });
    expect(lines(est)).toBeNull();
  });

  it('keeps genuine flat-monthly rows (termite bait monitoring) labeled monthly', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 780, monthly_total: null }, {
      frequencies: [{
        ...lawnFrequency,
        annual: 780,
        perServiceTreatments: [
          { service: 'lawn_care', label: 'Lawn Care Program', displayPrice: 90, visitsPerYear: 6 },
          { service: 'termite_bait', label: 'Termite Bait Monitoring', monthly: 20 },
        ],
      }],
    });
    const out = lines(est);
    expect(out[1].frequency).toBe('monthly');
    expect(out[1].unitPrice).toBe(20);
  });

  // The #2965 carve-out: a legacy termite row carries a derived per-visit
  // price AND a visit count yet bills the flat monthly, so only the explicit
  // flag may convert it.
  it('will not convert an unflagged termite row that merely looks per-application', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 1020, monthly_total: null }, {
      frequencies: [{
        ...lawnFrequency,
        annual: 1020,
        perServiceTreatments: [
          { service: 'lawn_care', label: 'Lawn Care Program', displayPrice: 90, visitsPerYear: 6 },
          { service: 'termite_bait', label: 'Termite Bait Monitoring', displayPrice: 120, visitsPerYear: 4 },
        ],
      }],
    });
    expect(lines(est)).toBeNull();
  });

  it('converts a termite row that IS explicitly flagged', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 1020, monthly_total: null }, {
      frequencies: [{
        ...lawnFrequency,
        annual: 1020,
        perServiceTreatments: [
          { service: 'lawn_care', label: 'Lawn Care Program', displayPrice: 90, visitsPerYear: 6 },
          { service: 'termite_bait', label: 'Termite', displayPrice: 120, visitsPerYear: 4, billedPerApplication: true },
        ],
      }],
    });
    expect(lines(est).map((l) => l.frequency)).toEqual(['per_application', 'per_application']);
  });

  it('returns null when the lines do not reconcile to the stored annual total', () => {
    expect(lines({ ...lawnEstimate, annual_total: 600 })).toBeNull();
  });

  it('returns null with no bundle (the legacy document still renders a number)', () => {
    const bare = { monthly_total: 120, annual_total: 1440, estimate_data: {} };
    expect(perApplicationRecurringLines(bare, bare.estimate_data)).toBeNull();
    expect(normalizeProposal(bare).buildings[0].lineItems[0].frequency).toBe('monthly');
  });

  it('skips quote-required cadences', () => {
    expect(lines(withBundle(lawnEstimate, { frequencies: [{ ...lawnFrequency, quoteRequired: true }] }))).toBeNull();
  });

  it('still carries one-time engine lines alongside per-application recurring lines', () => {
    const est = {
      ...lawnEstimate,
      onetime_total: 150,
      estimate_data: {
        ...lawnEstimate.estimate_data,
        lineItems: [{ name: 'Initial cleanup', oneTimePrice: 150 }],
      },
    };
    const p = normalizeProposal(est, { recurringMode: 'per_application' });
    expect(p.buildings[0].lineItems.map((i) => i.frequency)).toEqual(['per_application', 'one_time']);
    expect(computeProposalTotals(p).annualRecurring).toBe(540);
  });

  // Codex #3120 r1: CommercialProposalPage has no per_application cadence and
  // drops visitsPerYear on save, so a promoted line would annualize to $0 and
  // the PUT would overwrite annual_total.
  it('is opt-in — the proposal editor read never sees the internal cadence', () => {
    expect(normalizeProposal(lawnEstimate).buildings[0].lineItems[0].frequency).toBe('monthly');
    expect(normalizeProposal(lawnEstimate, { recurringMode: 'per_application' })
      .buildings[0].lineItems[0].frequency).toBe('per_application');
  });

  it('leaves an authored commercial proposal untouched under the opt-in', () => {
    const authored = {
      customer_name: 'Siesta Sands HOA',
      estimate_data: {
        proposal: {
          enabled: true,
          buildings: [{ name: 'Tower A', lineItems: [{ description: 'Common-area pest', unitPrice: 350, frequency: 'monthly' }] }],
        },
      },
    };
    const p = normalizeProposal(authored, { recurringMode: 'per_application' });
    expect(p.enabled).toBe(true);
    expect(p.buildings[0].lineItems[0].frequency).toBe('monthly');
    expect(computeProposalTotals(p).monthlyEquivalent).toBe(350);
  });
});

// Pre-push r5: a per-application plan whose lines cannot be derived must not
// revert to the monthly copy the rule forbids for this lane.
describe('per-application mode with no derivable lines', () => {
  const bare = {
    customer_name: 'T',
    address: '1 Oak',
    monthly_total: 120,
    annual_total: 1440,
    onetime_total: 150,
    estimate_data: { lineItems: [{ name: 'Initial cleanup', oneTimePrice: 150 }] },
  };

  it('prints no recurring pricing rather than a monthly line', () => {
    const p = normalizeProposal(bare, { recurringMode: 'per_application' });
    const freqs = p.buildings[0].lineItems.map((i) => i.frequency);
    expect(freqs).not.toContain('monthly');
    expect(freqs).toEqual(['one_time']);
    expect(computeProposalTotals(p).annualRecurring).toBe(0);
  });

  it('still renders the legacy monthly line for a legacy-mode document', () => {
    const p = normalizeProposal(bare, { recurringMode: 'legacy' });
    expect(p.buildings[0].lineItems.map((i) => i.frequency)).toContain('monthly');
  });
});

// ── PRICING AUTHORITY (#3120 r4/r6/r7) ──────────────────────────────────────
// The four states the document can be quoted from, each with its own anchor.
describe('pricing authority by estimate state', () => {
  const { perApplicationRecurringLines } = require('../services/estimate-proposal');

  const rebuilt = {
    key: 'standard', label: 'Bi-monthly', serviceCategory: 'lawn_care',
    monthly: 45, annual: 540, perTreatment: 90, visitsPerYear: 6, billedPerApplication: true,
  };
  // A snapshot the route REJECTS on lawn policy. Its totals still equal the
  // frozen columns — the fast path requires that — which is exactly why the
  // stale columns cannot be the reconcile anchor once it is rebuilt.
  const retiredSnapshot = {
    key: 'quarterly', label: 'Quarterly', serviceCategory: 'lawn_care',
    monthly: 20, annual: 240, perTreatment: 60, visitsPerYear: 4, billedPerApplication: true,
  };
  const base = {
    service_interest: 'Lawn Care',
    monthly_total: 20,
    annual_total: 240,
    estimate_data: { sendSnapshot: { pricingBundle: { frequencies: [retiredSnapshot] } } },
  };
  const live = { bundle: { frequencies: [rebuilt] }, defaultCandidate: rebuilt };

  it('OUTSTANDING + rebuilt snapshot: quotes the rebuilt plan, not the retired one', () => {
    const out = perApplicationRecurringLines(base, base.estimate_data, live);
    expect(out).toHaveLength(1);
    expect(out[0].unitPrice).toBe(90);
    expect(out[0].visitsPerYear).toBe(6);
  });


  it('OUTSTANDING: rejects a default candidate that does not add up to its own annual', () => {
    const incoherent = { ...rebuilt, annual: 700 };
    expect(perApplicationRecurringLines(base, base.estimate_data, {
      bundle: { frequencies: [incoherent] }, defaultCandidate: incoherent,
    })).toBeNull();
  });

  it('LOCKED + matching snapshot: quotes the frozen snapshot, never today prices', () => {
    // No livePricing => locked. The snapshot reconciles to the frozen columns.
    const out = perApplicationRecurringLines(base, base.estimate_data);
    expect(out[0].unitPrice).toBe(60);
    expect(out[0].visitsPerYear).toBe(4);
  });

  // #3120 r8: for lawn / tree&shrub / mosquito TIER plans acceptance resolves
  // billingFrequencyKey 'monthly' with visits != 12, so customerSelection's
  // billingAmount is the monthly DISPLAY rate, not a per-application charge.
  // Deriving 12 applications from it would print $45 x 12 for a plan that
  // charges $90 x 6 — and reconciling THAT back to the annual still passes, so
  // the guard cannot catch it. No line beats a wrong one.
  it('FROZEN + stale snapshot: prints no recurring line rather than inventing one', () => {
    const accepted = {
      ...base,
      status: 'accepted',
      monthly_total: 45,
      annual_total: 540,          // accepted from the REBUILT plan...
      estimate_data: {
        sendSnapshot: { pricingBundle: { frequencies: [retiredSnapshot] } },  // ...snapshot still retired
        customerSelection: {
          frequencyKey: 'standard', annualTotal: 540,
          billingAmount: 45, billingIntervalMonths: 1,   // the tier trap
        },
      },
    };
    expect(perApplicationRecurringLines(accepted, accepted.estimate_data)).toBeNull();
  });

  it('OUTSTANDING + rebuilt: skips stale-total matching entirely', () => {
    // A non-default live cadence that coincidentally matches the stale columns
    // must NOT win — acceptance with no selectedFrequency takes the default.
    const coincidental = { ...retiredSnapshot, key: 'other_tier' };
    const out = perApplicationRecurringLines(base, base.estimate_data, {
      bundle: { frequencies: [coincidental, rebuilt] },
      defaultCandidate: rebuilt,
      snapshotHit: false,
    });
    expect(out[0].unitPrice).toBe(90);
  });

  it('OUTSTANDING + snapshot served: stored-total matching still applies', () => {
    const out = perApplicationRecurringLines(base, base.estimate_data, {
      bundle: { frequencies: [retiredSnapshot, rebuilt] },
      defaultCandidate: rebuilt,
      snapshotHit: true,
    });
    expect(out[0].unitPrice).toBe(60);
  });

  it('UNRESOLVED: never falls back to the snapshot the route refused to serve', () => {
    expect(perApplicationRecurringLines(base, base.estimate_data, { unresolved: true })).toBeNull();
  });
});

describe('one-time rows itemize on the proposal when they account for the stored total (owner 2026-08-27)', () => {
  const rows = [
    { service: 'rodent_trapping', name: 'Rodent Trapping', price: 350 },
    { service: 'rodent_exclusion', name: 'Rodent Exclusion — Wire Mesh Points', price: 300 },
    { service: 'rodent_exclusion', name: 'Rodent Exclusion — Bird Boxes', price: 150 },
    { service: 'rodent_exclusion', name: 'Rodent Exclusion — Linear Mesh', price: 140 },
  ];

  test('itemized rodent rows print instead of one "One-time service" line', () => {
    const p = normalizeProposal({
      customer_name: 'R', address: '1 Attic Ln', monthly_total: 0, onetime_total: 940,
      estimate_data: { result: { oneTime: { total: 940, specItems: rows } } },
    });
    const oneTime = p.buildings[0].lineItems.filter((l) => l.frequency === 'one_time');
    expect(oneTime.map((l) => [l.description, l.amount])).toEqual([
      ['Rodent Trapping', 350],
      ['Rodent Exclusion — Wire Mesh Points', 300],
      ['Rodent Exclusion — Bird Boxes', 150],
      ['Rodent Exclusion — Linear Mesh', 140],
    ]);
    expect(oneTime.some((l) => l.description === 'One-time service')).toBe(false);
  });

  test('rows that do not sum to the stored total (a discount outside them) keep the single total line', () => {
    const p = normalizeProposal({
      customer_name: 'R', address: '1 Attic Ln', monthly_total: 0, onetime_total: 840,
      estimate_data: { result: { oneTime: { total: 840, specItems: rows } } },
    });
    const oneTime = p.buildings[0].lineItems.filter((l) => l.frequency === 'one_time');
    expect(oneTime).toHaveLength(1);
    expect(oneTime[0]).toMatchObject({ description: 'One-time service', amount: 840 });
  });

  test('quote-required and included rows never print as priced lines', () => {
    const p = normalizeProposal({
      customer_name: 'R', address: '1 Attic Ln', monthly_total: 0, onetime_total: 350,
      estimate_data: { result: { oneTime: { total: 350, specItems: [
        rows[0],
        { service: 'rodent_sanitation', name: 'Rodent Sanitation', price: 0, quoteRequired: true },
        { service: 'rodent_inspection', name: 'Rodent Inspection', price: 0, serviceSpecificDiscountApplied: true },
      ] } } },
    });
    const oneTime = p.buildings[0].lineItems.filter((l) => l.frequency === 'one_time');
    expect(oneTime.map((l) => l.description)).toEqual(['Rodent Trapping']);
  });
});

describe('one-time itemization reads every persisted result shape (codex #3521 r2 P2)', () => {
  test('agent estimates persist engineResult, not result', () => {
    const p = normalizeProposal({
      customer_name: 'A', address: '2 Attic Ln', monthly_total: 0, onetime_total: 650,
      estimate_data: { engineResult: { oneTime: { total: 650, items: [
        { service: 'rodent_trapping', name: 'Rodent Trapping', price: 350 },
        { service: 'rodent_exclusion', name: 'Rodent Exclusion — Wire Mesh Points', price: 300 },
      ] } } },
    });
    const oneTime = p.buildings[0].lineItems.filter((l) => l.frequency === 'one_time');
    expect(oneTime.map((l) => [l.description, l.amount])).toEqual([
      ['Rodent Trapping', 350],
      ['Rodent Exclusion — Wire Mesh Points', 300],
    ]);
  });

  test('items and specItems both contribute (mixed one-time estimate)', () => {
    const p = normalizeProposal({
      customer_name: 'A', address: '2 Attic Ln', monthly_total: 0, onetime_total: 500,
      estimate_data: { result: { oneTime: {
        total: 500,
        items: [{ service: 'flea_treatment', name: 'Flea Treatment', price: 150 }],
        specItems: [{ service: 'rodent_trapping', name: 'Rodent Trapping', price: 350 }],
      } } },
    });
    const oneTime = p.buildings[0].lineItems.filter((l) => l.frequency === 'one_time');
    expect(oneTime.map((l) => l.description).sort()).toEqual(['Flea Treatment', 'Rodent Trapping']);
  });
});
