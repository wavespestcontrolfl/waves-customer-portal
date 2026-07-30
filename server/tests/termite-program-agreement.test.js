// Termite bait program agreement — accept-time prep (owner go 2026-07-29).
// Covers the pure layers: termite-fact collection from stored estimate
// shapes, ownership variant selection, fail-closed figure resolution, and a
// full render against the seeded template bodies proving every variable the
// builder emits resolves (and the ruling-critical wording is present).
const {
  isCommercialEstimate,
  PURCHASE_TEMPLATE_KEY,
  RENTAL_TEMPLATE_KEY,
  START_DATE_FALLBACK,
  buildTermiteProgramAgreementValues,
  classifyExistingAgreement,
  collectTermiteFacts,
  estimateMayDiscount,
  systemLabelFor,
} = require('../services/termite-program-agreement');
const { DEFAULT_TEMPLATES } = require('../models/migrations/20260729000001_seed_termite_program_agreements');
const { TEMPLATE_V2 } = require('../models/migrations/20260730000001_termite_program_agreements_v2');
const {
  buildCustomerDocumentContext,
  renderDocumentTemplate,
} = require('../services/document-template-library');

const CUSTOMER = {
  id: 'c-1',
  first_name: 'Stan',
  last_name: 'Sample',
  email: 'stan@example.com',
  phone: '9415550000',
  address_line1: '123 Perimeter Way',
  city: 'Bradenton',
  state: 'FL',
  zip: '34202',
};

function ownedEstData() {
  return {
    inputs: { services: { termite: { system: 'trelona', monitoringTier: 'basic' } } },
    result: {
      lineItems: [
        { service: 'termite_bait', monthly: 24, perApp: 72, annual: 288, visitsPerYear: 4, ownership: 'own', installation: { price: 610 } },
        { service: 'termite_bond', monthly: 18, perApp: 54 },
      ],
    },
  };
}

function rentedEstData() {
  return {
    inputs: { services: { termite: { system: 'trelona', monitoringTier: 'basic', ownership: 'rent' } } },
    result: {
      lineItems: [
        { service: 'termite_bait', monthly: 24, perApp: 72, annual: 288, visitsPerYear: 4, ownership: 'rent', installation: { price: 0 } },
        { service: 'termite_station_rental', monthly: 10.33, perApp: 31 },
      ],
    },
  };
}

describe('collectTermiteFacts', () => {
  test('owned program: bait line + install price, ownership own', () => {
    const facts = collectTermiteFacts(ownedEstData());
    expect(facts).toEqual(expect.objectContaining({
      hasProgram: true, ownership: 'own', perApp: 72, installPrice: 610,
    }));
  });

  test('rented program: rental line forces rent and carries its per-app', () => {
    const facts = collectTermiteFacts(rentedEstData());
    expect(facts).toEqual(expect.objectContaining({
      hasProgram: true, ownership: 'rent', perApp: 72, rentalPerApp: 31,
    }));
  });

  test('no termite service anywhere → no program', () => {
    const facts = collectTermiteFacts({
      inputs: { services: { pest: { frequency: 'quarterly' } } },
      result: { lineItems: [{ service: 'pest_control', monthly: 55 }] },
    });
    expect(facts.hasProgram).toBe(false);
  });

  test('canonical v1-mapper shapes resolve: services rows by NAME (perTreatment) + results.tmBait (ti/monMonthly)', () => {
    const facts = collectTermiteFacts({
      results: {
        tmBait: { selectedSystem: 'trelona', system: 'trelona', ai: null, ti: 610, monMonthly: 24, bmo: 24, sta: 15 },
      },
      recurring: {
        services: [
          { name: 'Termite Bait', mo: 24, monthly: 24, perTreatment: 72, visitsPerYear: 3 },
        ],
      },
    });
    expect(facts).toEqual(expect.objectContaining({
      hasProgram: true, ownership: 'own', perApp: 72, installPrice: 610, system: 'trelona',
    }));
  });

  test('tmBait node alone (no services rows) derives per-application from monthly ×3', () => {
    const facts = collectTermiteFacts({
      results: { tmBait: { selectedSystem: 'advance', ai: 639, ti: null, monMonthly: 34, bmo: 34 } },
    });
    expect(facts).toEqual(expect.objectContaining({
      hasProgram: true, perApp: 102, installPrice: 639, system: 'advance',
    }));
  });

  test('client-fallback tmBait with BOTH install prices picks the ACCEPTED system (legacy Advance)', () => {
    const facts = collectTermiteFacts({
      results: { tmBait: { selectedSystem: 'advance', system: 'advance', ai: 639, ti: 610, monMonthly: 34, bmo: 34 } },
    });
    expect(facts.installPrice).toBe(639); // never the populated Trelona 610
    expect(facts.system).toBe('advance');
  });

  test('v1 rental services row by NAME marks rent and carries its perTreatment', () => {
    const facts = collectTermiteFacts({
      results: { tmBait: { selectedSystem: 'trelona', ai: null, ti: 610, monMonthly: 24 } },
      recurring: {
        services: [
          { name: 'Termite Bait', perTreatment: 72 },
          { name: 'Termite Station Rental', perTreatment: 31 },
        ],
      },
    });
    expect(facts).toEqual(expect.objectContaining({ ownership: 'rent', rentalPerApp: 31, perApp: 72 }));
  });

  test('engine-inputs ownership alone marks rent (replay shapes without a priced rental row)', () => {
    const facts = collectTermiteFacts({
      inputs: { services: { termite: { system: 'trelona', ownership: 'rent' } } },
      result: { lineItems: [{ service: 'termite_bait', perApp: 72, installation: { price: 0 } }] },
    });
    expect(facts.ownership).toBe('rent');
  });
});

describe('buildTermiteProgramAgreementValues', () => {
  test('owned estimate → purchase template with install + per-application figures', () => {
    const prepared = buildTermiteProgramAgreementValues({}, ownedEstData());
    expect(prepared.templateKey).toBe(PURCHASE_TEMPLATE_KEY);
    expect(prepared.values.program.install_price).toBe('$610');
    expect(prepared.values.program.per_application).toBe('$72');
  });

  test('rented estimate → rental template with rental + combined figures', () => {
    const prepared = buildTermiteProgramAgreementValues({}, rentedEstData());
    expect(prepared.templateKey).toBe(RENTAL_TEMPLATE_KEY);
    expect(prepared.values.program.rental_per_application).toBe('$31');
    expect(prepared.values.program.combined_per_application).toBe('$103');
  });

  test('fail-closed: owned program without an install price builds nothing', () => {
    const data = ownedEstData();
    delete data.result.lineItems[0].installation;
    expect(buildTermiteProgramAgreementValues({}, data)).toBeNull();
  });

  test('fail-closed: rented program without a rental figure builds nothing', () => {
    const data = rentedEstData();
    data.result.lineItems = data.result.lineItems.filter((l) => l.service !== 'termite_station_rental');
    // inputs still say rent, but there is no rental per-app to print
    expect(buildTermiteProgramAgreementValues({}, data)).toBeNull();
  });

  test('non-termite estimate builds nothing', () => {
    expect(buildTermiteProgramAgreementValues({}, { result: { lineItems: [] } })).toBeNull();
  });
});

describe('systemLabelFor', () => {
  test('names the accepted system, never silently rebranding legacy Advance', () => {
    expect(systemLabelFor('trelona')).toBe('Trelona® ATBS annual bait stations');
    expect(systemLabelFor('advance')).toBe('Advance® termite bait stations');
    expect(systemLabelFor('sentricon')).toBe('in-ground termite bait stations');
    expect(systemLabelFor(null)).toBe('Trelona® ATBS annual bait stations');
  });

  test('legacy advance estimate flows its system into the agreement values', () => {
    const data = ownedEstData();
    data.inputs.services.termite.system = 'advance';
    data.result.lineItems[0].system = 'advance';
    const prepared = buildTermiteProgramAgreementValues({}, data);
    expect(prepared.values.program.system).toBe('Advance® termite bait stations');
  });
});

describe('program start date', () => {
  test('uses the booked first-visit label when supplied', () => {
    const prepared = buildTermiteProgramAgreementValues({}, ownedEstData(), { startDateLabel: 'August 4, 2026' });
    expect(prepared.values.agreement.start_date).toBe('August 4, 2026');
  });

  test('falls back to confirmed-at-installation when nothing is booked', () => {
    const prepared = buildTermiteProgramAgreementValues({}, ownedEstData());
    expect(prepared.values.agreement.start_date).toBe(START_DATE_FALLBACK);
  });
});

describe('discounted accepts never print gross figures (pre-push P0)', () => {
  test('gross mapper figures + a discounting WaveGuard tier fail closed', () => {
    const data = {
      results: { tmBait: { selectedSystem: 'trelona', ai: null, ti: 610, monMonthly: 34 } },
      recurring: { services: [{ name: 'Termite Bait', perTreatment: 102 }] },
    };
    expect(buildTermiteProgramAgreementValues({ waveguard_tier: 'Gold' }, data)).toBeNull();
    // Bronze/no tier: gross == net, safe to print.
    expect(buildTermiteProgramAgreementValues({ waveguard_tier: 'Bronze' }, data)).not.toBeNull();
    expect(buildTermiteProgramAgreementValues({}, data)).not.toBeNull();
  });

  test('engine final-annual figures are NET and print even under a tier (discounted value)', () => {
    const data = {
      inputs: { services: { termite: { system: 'trelona' } } },
      result: {
        lineItems: [{
          service: 'termite_bait', perApp: 102, annual: 408, annualAfterDiscount: 346.8, visitsPerYear: 4,
          installation: { price: 639 },
        }],
      },
    };
    const prepared = buildTermiteProgramAgreementValues({ waveguard_tier: 'Gold' }, data);
    expect(prepared).not.toBeNull();
    expect(prepared.values.program.per_application).toBe('$86.70'); // 346.80 / 4 — the Gold price, not the gross $102
  });

  test('manual discount on the estimate also fails gross figures closed', () => {
    const data = {
      manualDiscount: { amount: 50 },
      recurring: { services: [{ name: 'Termite Bait', perTreatment: 72 }] },
      results: { tmBait: { ti: 610, monMonthly: 24 } },
    };
    expect(estimateMayDiscount({}, data)).toBe(true);
    expect(buildTermiteProgramAgreementValues({}, data)).toBeNull();
  });
});

describe('classifyExistingAgreement', () => {
  const estimate = { id: 'est-1', address: '123 Perimeter Way, Bradenton FL' };
  const openRow = (over = {}) => ({
    status: 'sent',
    share_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
    document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-1', address: '123 Perimeter Way, Bradenton FL' } }),
    ...over,
  });

  test('open request for the SAME estimate blocks', () => {
    expect(classifyExistingAgreement(openRow(), estimate)).toBe('blocks');
  });

  test('open request for the same property from a DIFFERENT estimate supersedes (stale prices must not survive)', () => {
    const row = openRow({
      document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-0', address: '123 Perimeter Way, Bradenton FL' } }),
    });
    expect(classifyExistingAgreement(row, estimate)).toBe('supersede');
  });

  test("workflow's literal 'expired' status is ignored (fresh prep allowed)", () => {
    expect(classifyExistingAgreement(openRow({ status: 'expired' }), estimate)).toBe('ignore');
  });

  test('signed/cancelled/voided/declined rows are ignored (re-accept gets a fresh document)', () => {
    for (const status of ['signed', 'cancelled', 'voided', 'declined']) {
      expect(classifyExistingAgreement(openRow({ status }), estimate)).toBe('ignore');
    }
  });

  test('a past share-token expiry is ignored even in an open status', () => {
    expect(classifyExistingAgreement(openRow({ share_token_expires_at: new Date(Date.now() - 1000).toISOString() }), estimate)).toBe('ignore');
  });

  test('address form variants classify as the SAME property (St vs Street)', () => {
    const row = openRow({
      document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-0', address: '123 Perimeter Way, Bradenton FL' } }),
    });
    const variant = { id: 'est-1', address: '123 Perimeter WAY Bradenton, FL' };
    expect(classifyExistingAgreement(row, variant)).toBe('supersede');
    const stRow = openRow({
      document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-0', address: '400 Main Street, Venice FL' } }),
    });
    expect(classifyExistingAgreement(stRow, { id: 'est-1', address: '400 Main St, Venice FL' })).toBe('supersede');
  });

  test('an open agreement for a DIFFERENT property is ignored (multi-property customers)', () => {
    const row = openRow({
      document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-9', address: '400 Other St, Venice FL' } }),
    });
    expect(classifyExistingAgreement(row, estimate)).toBe('ignore');
  });

  test('an open row on a STALE template version supersedes even for the same estimate', () => {
    const active = new Set(['v2-id']);
    const row = openRow({ document_template_version_id: 'v1-id' });
    expect(classifyExistingAgreement(row, estimate, new Date(), { activeVersionIds: active })).toBe('supersede');
    const current = openRow({ document_template_version_id: 'v2-id' });
    expect(classifyExistingAgreement(current, estimate, new Date(), { activeVersionIds: active })).toBe('blocks');
  });

  test("a stale-version row for a DIFFERENT property is ignored — reconciled independently, never cancelled by another property's accept", () => {
    const active = new Set(['v2-id']);
    const otherProperty = openRow({
      document_template_version_id: 'v1-id',
      document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-9', address: '400 Other St, Venice FL' } }),
    });
    expect(classifyExistingAgreement(otherProperty, estimate, new Date(), { activeVersionIds: active })).toBe('ignore');
  });

  test('matching estimate id blocks regardless of address text', () => {
    const row = openRow({
      document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-1', address: 'totally different text' } }),
    });
    expect(classifyExistingAgreement(row, estimate)).toBe('blocks');
  });
});

describe('render against the seeded templates', () => {
  const seedByKey = Object.fromEntries(DEFAULT_TEMPLATES.map((t) => [t.template_key, t]));

  function renderFor(prepared) {
    const seed = seedByKey[prepared.templateKey];
    const context = buildCustomerDocumentContext(CUSTOMER, prepared.values);
    return renderDocumentTemplate({
      template: { template_key: seed.template_key, name: seed.name },
      version: { title: seed.title, body: seed.body },
      context,
    });
  }

  test('purchase agreement resolves every variable and states the ruling-critical terms', () => {
    const rendered = renderFor(buildTermiteProgramAgreementValues({}, ownedEstData()));
    expect(rendered.unresolvedVariables).toEqual([]);
    expect(rendered.body).toContain('Stan Sample');
    expect(rendered.body).toContain('$610');
    expect(rendered.body).toContain('$72 per application');
    expect(rendered.body).toContain('the customer’s property once installed');
    // Owner ruling 2026-07-28: warranty is optional, never included.
    expect(rendered.body).toContain('NOT included with installation');
    expect(rendered.body).not.toMatch(/first year of (warranty )?coverage included/i);
  });

  test('rental agreement resolves every variable and states the hardware terms', () => {
    const rendered = renderFor(buildTermiteProgramAgreementValues({}, rentedEstData()));
    expect(rendered.unresolvedVariables).toEqual([]);
    expect(rendered.body).toContain('$31');
    expect(rendered.body).toContain('$103');
    expect(rendered.body).toContain('remain the property of Waves Pest Control');
    expect(rendered.body).toContain('not a payment plan');
    expect(rendered.body).toContain('remove its stations');
    expect(rendered.body).toContain('NOT included with installation');
  });

  test('seeded variable lists exactly match what each template body uses', () => {
    for (const seed of DEFAULT_TEMPLATES) {
      const used = [...new Set([...seed.body.matchAll(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi)].map((m) => m[1]))].sort();
      expect(used).toEqual([...seed.variables].sort());
    }
  });
});

describe('isCommercialEstimate', () => {
  test('flags commercial inputs, property types, tier, and commercial service keys', () => {
    expect(isCommercialEstimate({}, { inputs: { isCommercial: true } })).toBe(true);
    expect(isCommercialEstimate({}, { inputs: { isCommercial: 'YES' } })).toBe(true);
    expect(isCommercialEstimate({}, { inputs: { isCommercial: 'NO' } })).toBe(false);
    expect(isCommercialEstimate({}, { inputs: { propertyType: 'Multifamily' } })).toBe(true);
    expect(isCommercialEstimate({ waveguard_tier: 'Commercial' }, {})).toBe(true);
    expect(isCommercialEstimate({}, { recurring: { services: [{ service: 'commercial_pest' }] } })).toBe(true);
    expect(isCommercialEstimate({}, ownedEstData())).toBe(false);
  });

  test('persisted multi-unit property types park (Duplex/condo/townhome)', () => {
    for (const pt of ['Duplex', 'Condo', 'Townhome', 'Townhouse', 'Triplex', 'Apartment Building']) {
      expect(isCommercialEstimate({}, { inputs: { propertyType: pt } })).toBe(true);
    }
    expect(isCommercialEstimate({}, { inputs: { propertyType: 'Single Family' } })).toBe(false);
  });

  test('commercial termite key marks the program present so the park runs (not no_termite_program)', () => {
    const facts = collectTermiteFacts({
      result: { lineItems: [{ service: 'commercial_termite_bait', monthly: 120 }] },
    });
    expect(facts.hasProgram).toBe(true);
    expect(isCommercialEstimate({}, { result: { lineItems: [{ service: 'commercial_termite_bait' }] } })).toBe(true);
  });
});

describe('v2 templates (active version — owner-approved 2026-07-29)', () => {
  const v2ByKey = Object.fromEntries(TEMPLATE_V2.map((t) => [t.template_key, t]));

  function renderV2(prepared) {
    const seed = v2ByKey[prepared.templateKey];
    const context = buildCustomerDocumentContext(CUSTOMER, prepared.values);
    return renderDocumentTemplate({
      template: { template_key: seed.template_key, name: seed.title },
      version: { title: seed.title, body: seed.body },
      context,
    });
  }

  test('purchase v2 resolves every variable and carries the 5E-14.105 load-bearing terms', () => {
    const rendered = renderV2(buildTermiteProgramAgreementValues({}, ownedEstData()));
    expect(rendered.unresolvedVariables).toEqual([]);
    expect(rendered.body).toContain('DOES NOT COVER: DRYWOOD TERMITES');
    expect(rendered.body).toContain('IT IS NOT A');
    expect(rendered.body).toContain('WARRANTY OR BOND');
    expect(rendered.body).toContain('Structural repair price under this agreement: NONE');
    expect(rendered.body).toContain('60 days to correct the condition');
    expect(rendered.body).toContain('TRANSFER TO A NEW OWNER');
    expect(rendered.body).toContain('FDACS-13692');
    expect(rendered.body).toContain('FDACS-13671');
    expect(rendered.body).not.toMatch(/first year of (warranty )?coverage included/i);
    expect(rendered.body).not.toContain('[OWNER/ATTORNEY DECISION');
  });

  test('rental v2 resolves every variable and carries the hardware + removal terms', () => {
    const rendered = renderV2(buildTermiteProgramAgreementValues({}, rentedEstData()));
    expect(rendered.unresolvedVariables).toEqual([]);
    expect(rendered.body).toContain('remain the property of Waves Pest Control');
    expect(rendered.body).toContain('NOT A PAYMENT PLAN');
    expect(rendered.body).toContain('hardware replacement cost');
    expect(rendered.body).toContain('Waves will retrieve its stations');
    expect(rendered.body).toContain('TRANSFER TO A NEW OWNER');
    expect(rendered.body).not.toContain('[OWNER/ATTORNEY DECISION');
  });

  test('v2 variable lists exactly match body usage (same merge fields as v1 — builder unchanged)', () => {
    for (const seed of TEMPLATE_V2) {
      const used = [...new Set([...seed.body.matchAll(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi)].map((m) => m[1]))].sort();
      expect(used).toEqual([...seed.variables].sort());
      const v1 = DEFAULT_TEMPLATES.find((t) => t.template_key === seed.template_key);
      expect([...seed.variables].sort()).toEqual([...v1.variables].sort());
    }
  });
});
