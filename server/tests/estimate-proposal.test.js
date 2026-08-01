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
    const out = lines({ ...lawnEstimate, accepted_frequency_key: null });
    expect(out[0].unitPrice).toBe(90);
  });

  it('picks the cadence matching the stored totals over a same-key mismatch', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 780, monthly_total: 65 }, {
      frequencies: [
        lawnFrequency,
        { ...lawnFrequency, key: 'enhanced', monthly: 65, annual: 780, perTreatment: 86.67, visitsPerYear: 9 },
      ],
    });
    const out = lines(est);
    expect(out[0].visitsPerYear).toBe(9);
    expect(out[0].unitPrice).toBe(86.67);
  });

  // Codex #3120 P1: a preserved monthly member keeps monthly billing at
  // accept, and buildPricingBundle strips every billedPerApplication flag
  // from their snapshot — but leaves perTreatment/visitsPerYear in place.
  it('leaves a stripped (preserved monthly member) bundle on the monthly line', () => {
    const { billedPerApplication, ...stripped } = lawnFrequency;
    expect(billedPerApplication).toBe(true);
    const est = withBundle(lawnEstimate, { frequencies: [stripped] });
    expect(lines(est)).toBeNull();
    expect(normalizeProposal(est, { synthesizePerApplication: true })
      .buildings[0].lineItems[0].frequency).toBe('monthly');
  });

  it('never converts a pest/termite row on section policy alone (no flag, no conversion)', () => {
    // pest is deliberately outside PER_APPLICATION_SECTION_KEYS: legacy
    // flat-monthly termite rows carry a per-visit price AND a visit count.
    const est = withBundle(lawnEstimate, {
      frequencies: [{ ...lawnFrequency, serviceCategory: 'pest_control', billedPerApplication: undefined }],
    });
    expect(lines(est)).toBeNull();
  });

  // Codex #3120 P1: accepts with independent per-service cadences are priced
  // by serviceCadenceCombos; accepted_frequency_key holds only the top-level key.
  it('resolves an accepted per-service cadence combination', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 940, monthly_total: null }, {
      frequencies: [{ ...lawnFrequency, annual: 540 }],
      serviceCadenceCombos: [
        { key: 'combo-a', annual: 1200, perServiceTreatments: [{ service: 'lawn_care', label: 'Lawn', displayPrice: 100, visitsPerYear: 12 }] },
        {
          key: 'combo-b',
          annual: 940,
          perServiceTreatments: [
            { service: 'lawn_care', label: 'Lawn Care Program', displayPrice: 90, visitsPerYear: 6 },
            { service: 'mosquito', label: 'Mosquito', perTreatment: 100, visitsPerYear: 4 },
          ],
        },
      ],
    });
    const out = lines(est);
    expect(out).toHaveLength(2);
    expect(out[0].description).toBe('Lawn Care Program — 6 applications/yr');
    expect(out[1].unitPrice).toBe(100);
    expect(out.reduce((a, l) => a + annualizedAmount(l), 0)).toBe(940);
  });

  // Codex #3120 P1: treatmentDisplayPrice applies only the tier discount, so
  // a plan-level manual credit leaves the rows summing ABOVE annual_total.
  it('allocates a plan-level credit across the rows instead of falling back', () => {
    const est = withBundle({ ...lawnEstimate, annual_total: 486, monthly_total: null }, {
      frequencies: [{ ...lawnFrequency, annual: 486, manualDiscount: { recurringAmount: 54 } }],
    });
    const out = lines(est);
    expect(out).toHaveLength(1);
    expect(out[0].frequency).toBe('per_application');
    expect(out[0].unitPrice).toBe(81); // (540 - 54) / 6
    expect(annualizedAmount(out[0])).toBe(486);
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
    expect(out).toHaveLength(2);
    expect(out[1].frequency).toBe('monthly');
    expect(out[1].unitPrice).toBe(20);
  });

  it('returns null when the lines do not reconcile to the stored annual total', () => {
    expect(lines({ ...lawnEstimate, annual_total: 600 })).toBeNull();
  });

  it('returns null with no bundle so the legacy monthly fallback still renders a number', () => {
    const bare = { monthly_total: 120, annual_total: 1440, estimate_data: {} };
    expect(perApplicationRecurringLines(bare, bare.estimate_data)).toBeNull();
    expect(normalizeProposal(bare, { synthesizePerApplication: true })
      .buildings[0].lineItems[0].frequency).toBe('monthly');
  });

  it('skips quote-required cadences', () => {
    const est = withBundle(lawnEstimate, { frequencies: [{ ...lawnFrequency, quoteRequired: true }] });
    expect(lines(est)).toBeNull();
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
    const p = normalizeProposal(est, { synthesizePerApplication: true });
    expect(p.buildings[0].lineItems.map((i) => i.frequency)).toEqual(['per_application', 'one_time']);
    expect(computeProposalTotals(p).annualRecurring).toBe(540);
  });

  // Codex #3120 P1: CommercialProposalPage has no per_application cadence and
  // drops visitsPerYear on save, so a promoted line would annualize to $0 and
  // the PUT would overwrite annual_total.
  it('is opt-in — the proposal editor read never sees the internal cadence', () => {
    const editorView = normalizeProposal(lawnEstimate);
    expect(editorView.buildings[0].lineItems[0].frequency).toBe('monthly');
    expect(normalizeProposal(lawnEstimate, { synthesizePerApplication: true })
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
    const p = normalizeProposal(authored, { synthesizePerApplication: true });
    expect(p.enabled).toBe(true);
    expect(p.buildings[0].lineItems[0].frequency).toBe('monthly');
    expect(computeProposalTotals(p).monthlyEquivalent).toBe(350);
  });
});
