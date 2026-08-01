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

  it('returns null with no bundle so the legacy monthly fallback still renders a number', () => {
    const bare = { monthly_total: 120, annual_total: 1440, estimate_data: {} };
    expect(perApplicationRecurringLines(bare, bare.estimate_data)).toBeNull();
    expect(normalizeProposal(bare, { recurringMode: 'per_application' })
      .buildings[0].lineItems[0].frequency).toBe('monthly');
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

describe('annual prepay rendering (codex #3120 r2: prepaid visits are covered by one annual payment)', () => {
  const prepayEstimate = {
    customer_name: 'S. Morgan',
    address: '1 Oak St',
    service_interest: 'Lawn Care',
    monthly_total: 45,
    annual_total: 540,
    accepted_frequency_key: 'standard',
    estimate_data: { sendSnapshot: { pricingBundle: { frequencies: [{
      key: 'standard', serviceCategory: 'lawn_care', monthly: 45, annual: 540,
      perTreatment: 90, visitsPerYear: 6, billedPerApplication: true,
    }] } } },
  };

  it('quotes the year, not a per-application charge that never happens', () => {
    const p = normalizeProposal(prepayEstimate, { recurringMode: 'annual_prepay' });
    const [line] = p.buildings[0].lineItems;
    expect(line.frequency).toBe('annual');
    expect(line.frequencyLabel).toBe('Annual');
    expect(line.unitPrice).toBe(540);
    // The visit count still tells the customer what the year buys.
    expect(line.description).toBe('Lawn Care — 6 applications/yr');
    expect(computeProposalTotals(p).annualRecurring).toBe(540);
  });

  it('is the same plan the per-application mode describes, priced differently', () => {
    const perApp = normalizeProposal(prepayEstimate, { recurringMode: 'per_application' }).buildings[0].lineItems[0];
    expect(perApp.frequency).toBe('per_application');
    expect(perApp.unitPrice).toBe(90);
    expect(perApp.description).toBe('Lawn Care — 6 applications/yr');
  });

  it('defaults to the legacy monthly rendering when no mode is given', () => {
    expect(normalizeProposal(prepayEstimate).buildings[0].lineItems[0].frequency).toBe('monthly');
  });

  // Codex #3120 r3: resolveAnnualPrepayInvoiceTotal can discount the base
  // annual (floor-aware), so the CHARGED amount — not annual_total — is what
  // the customer paid and what the document must show.
  it('quotes the charged prepay total, not the undiscounted base annual', () => {
    const p = normalizeProposal(prepayEstimate, {
      recurringMode: 'annual_prepay',
      annualPrepayTotal: 513,
    });
    const [line] = p.buildings[0].lineItems;
    expect(line.unitPrice).toBe(513);
    expect(computeProposalTotals(p).annualRecurring).toBe(513);
  });

  it('scales a multi-service prepay plan onto the charged total', () => {
    const est = {
      ...prepayEstimate,
      annual_total: 1288,
      monthly_total: null,
      estimate_data: { sendSnapshot: { pricingBundle: { serviceCadenceCombos: [{
        key: 'pest_quarterly|lawn_enhanced',
        annual: 1288,
        perServiceTreatments: [
          { service: 'pest_control', label: 'Pest Control', displayPrice: 112, visitsPerYear: 4 },
          { service: 'lawn_care', label: 'Lawn Care Program', displayPrice: 140, visitsPerYear: 6 },
        ],
      }] } } },
    };
    const p = normalizeProposal(est, { recurringMode: 'annual_prepay', annualPrepayTotal: 1223.60 });
    const items = p.buildings[0].lineItems;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.frequency === 'annual')).toBe(true);
    expect(computeProposalTotals(p).annualRecurring).toBeCloseTo(1223.60, 1);
  });

  it('falls back to the derived annual when no charged total is known', () => {
    const p = normalizeProposal(prepayEstimate, { recurringMode: 'annual_prepay' });
    expect(p.buildings[0].lineItems[0].unitPrice).toBe(540);
  });
});
