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
  // $540/yr = $90/application × 6, whose PDF previously printed
  // "Recurring service plan / Monthly / $45.00".
  const lawnEstimate = {
    customer_name: 'S. Morgan',
    address: '1 Oak St',
    service_interest: 'Lawn Care',
    monthly_total: 45,
    annual_total: 540,
    onetime_total: 0,
    accepted_frequency_key: 'standard',
    estimate_data: {
      sendSnapshot: {
        pricingBundle: {
          frequencies: [
            { key: 'standard', label: 'Bi-monthly', monthly: 45, annual: 540, perTreatment: 90, visitsPerYear: 6 },
            { key: 'enhanced', label: 'Every 6 weeks', monthly: 65, annual: 780, perTreatment: 86.67, visitsPerYear: 9 },
          ],
        },
      },
    },
  };

  it('quotes the accepted cadence per application, not per month', () => {
    const lines = perApplicationRecurringLines(lawnEstimate, lawnEstimate.estimate_data);
    expect(lines).toHaveLength(1);
    expect(lines[0].frequency).toBe('per_application');
    expect(lines[0].frequencyLabel).toBe('Per application');
    expect(lines[0].unitPrice).toBe(90);
    expect(lines[0].visitsPerYear).toBe(6);
    expect(lines[0].description).toBe('Lawn Care — 6 applications/yr');
    expect(annualizedAmount(lines[0])).toBe(540);
  });

  it('flows into the synthesized proposal and annualizes without a monthly line', () => {
    const p = normalizeProposal(lawnEstimate);
    expect(p.synthesized).toBe(true);
    expect(p.buildings[0].lineItems).toHaveLength(1);
    expect(p.buildings[0].lineItems[0].frequency).toBe('per_application');
    const totals = computeProposalTotals(p);
    expect(totals.annualRecurring).toBe(540);
    expect(totals.firstYearTotal).toBe(540);
  });

  it('matches by stored totals when no accepted key is stamped (unaccepted estimate)', () => {
    const unaccepted = { ...lawnEstimate, accepted_frequency_key: null };
    const lines = perApplicationRecurringLines(unaccepted, unaccepted.estimate_data);
    expect(lines).toHaveLength(1);
    expect(lines[0].unitPrice).toBe(90);
  });

  it('uses per-service treatment rows when the entry is split', () => {
    const est = {
      ...lawnEstimate,
      annual_total: 940,
      estimate_data: {
        sendSnapshot: {
          pricingBundle: {
            frequencies: [{
              key: 'standard',
              annual: 940,
              perServiceTreatments: [
                { label: 'Lawn Care Program', displayPrice: 90, visitsPerYear: 6 },
                { label: 'Perimeter Pest', perTreatment: 100, visitsPerYear: 4 },
              ],
            }],
          },
        },
      },
    };
    const lines = perApplicationRecurringLines(est, est.estimate_data);
    expect(lines).toHaveLength(2);
    expect(lines[0].description).toBe('Lawn Care Program — 6 applications/yr');
    expect(lines[1].unitPrice).toBe(100);
  });

  it('keeps genuine flat-monthly rows (termite bait monitoring) labeled monthly', () => {
    const est = {
      ...lawnEstimate,
      annual_total: 780,
      estimate_data: {
        sendSnapshot: {
          pricingBundle: {
            frequencies: [{
              key: 'standard',
              annual: 780,
              perServiceTreatments: [
                { label: 'Lawn Care Program', displayPrice: 90, visitsPerYear: 6 },
                { label: 'Termite Bait Monitoring', monthly: 20 },
              ],
            }],
          },
        },
      },
    };
    const lines = perApplicationRecurringLines(est, est.estimate_data);
    expect(lines).toHaveLength(2);
    expect(lines[1].frequency).toBe('monthly');
    expect(lines[1].unitPrice).toBe(20);
  });

  it('returns null when the lines do not reconcile to the stored annual total', () => {
    const drifted = { ...lawnEstimate, annual_total: 600 };
    expect(perApplicationRecurringLines(drifted, drifted.estimate_data)).toBeNull();
  });

  it('returns null with no bundle so the legacy monthly fallback still renders a number', () => {
    const bare = { monthly_total: 120, annual_total: 1440, estimate_data: {} };
    expect(perApplicationRecurringLines(bare, bare.estimate_data)).toBeNull();
    const p = normalizeProposal(bare);
    expect(p.buildings[0].lineItems[0].frequency).toBe('monthly');
  });

  it('skips quote-required cadences', () => {
    const est = {
      ...lawnEstimate,
      estimate_data: {
        sendSnapshot: {
          pricingBundle: {
            frequencies: [{ key: 'standard', quoteRequired: true, annual: 540, perTreatment: 90, visitsPerYear: 6 }],
          },
        },
      },
    };
    expect(perApplicationRecurringLines(est, est.estimate_data)).toBeNull();
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
    const p = normalizeProposal(est);
    const freqs = p.buildings[0].lineItems.map((i) => i.frequency);
    expect(freqs).toEqual(['per_application', 'one_time']);
  });
});
