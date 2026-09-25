// Termite bait program agreement — accept-time prep (owner go 2026-07-29).
// Covers the pure layers: termite-fact collection from stored estimate
// shapes, ownership variant selection, fail-closed figure resolution, and a
// full render against the seeded template bodies proving every variable the
// builder emits resolves (and the ruling-critical wording is present).
const {
  isCommercialEstimate,
  PURCHASE_TEMPLATE_KEY,
  RENTAL_TEMPLATE_KEY,
  ANNUAL_TEMPLATE_KEY,
  ANNUAL_SERVICE_NAME,
  isAnnualPlanEstimate,
  annualPlanNetFee,
  PARKED_HANDOFF_OUTCOMES,
  PROGRAM_TEMPLATE_KEYS,
  START_DATE_FALLBACK,
  buildTermiteProgramAgreementValues,
  classifyExistingAgreement,
  collectTermiteFacts,
  estimateMayDiscount,
  systemLabelFor,
} = require('../services/termite-program-agreement');
const { DEFAULT_TEMPLATES } = require('../models/migrations/20260729000001_seed_termite_program_agreements');
const { TEMPLATE_V2 } = require('../models/migrations/20260730000001_termite_program_agreements_v2');
const { TEMPLATE_V3_ANNUAL } = require('../models/migrations/20260924030002_termite_annual_protection_agreement_v3');
const { TEMPLATE_V3_ANNUAL_R2_BODY, ORIGINAL_SIGNATURE_BLOCK } = require('../models/migrations/20260924030003_termite_annual_v3_signature_block');
// The body as it stands after every migration in this branch (030002 seed + 030003 revision).
const V3_BODY = TEMPLATE_V3_ANNUAL_R2_BODY;
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

// Mapped results.tmBait shape v1-legacy-mapper.js emits for the Annual
// Protection plan (plan === 'annual_protection'): the base ai/ti/monMonthly
// fields are ALWAYS present (any termite bait line sets them, program-
// shape-independent — this is what keeps collectTermiteFacts' hasProgram
// gate true for an annual accept too), plus the plan-specific setupFee/
// annualFee this builder reads.
function annualEstData(overrides = {}) {
  return {
    results: {
      tmBait: {
        plan: 'annual_protection',
        selectedSystem: 'trelona',
        system: 'trelona',
        ai: null,
        ti: null,
        monMonthly: 0,
        bmo: 0,
        pmo: 0,
        sta: 12,
        planLabel: 'Annual Protection',
        planTerms: { coverageMonths: 12, visitsPerYear: 1 },
        setupFee: 900,
        setupPerStation: 45,
        annualFee: 480,
        visitsPerYear: 1,
        ...overrides,
      },
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

  test('fail-closed: explicit non-quarterly visit count parks (template promises 4 applications/year)', () => {
    const data = ownedEstData();
    data.result.lineItems[0].visitsPerYear = 3;
    data.result.lineItems[0].annual = 216;
    expect(buildTermiteProgramAgreementValues({}, data)).toBeNull();
  });

  test('fail-closed: explicit zero/nonnumeric visit counts park instead of coercing to quarterly', () => {
    for (const bad of [0, 'abc', '']) {
      const data = ownedEstData();
      data.result.lineItems[0].visitsPerYear = bad;
      expect(buildTermiteProgramAgreementValues({}, data)).toBeNull();
    }
    const ok = ownedEstData();
    ok.result.lineItems[0].visitsPerYear = '4';
    expect(buildTermiteProgramAgreementValues({}, ok)).not.toBeNull();
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

  test('top-level legacy commercial markers park (isCommercial/category/commercialSubtype at data root)', () => {
    expect(isCommercialEstimate({}, { isCommercial: true })).toBe(true);
    expect(isCommercialEstimate({}, { isCommercial: 'YES' })).toBe(true);
    expect(isCommercialEstimate({}, { category: 'COMMERCIAL' })).toBe(true);
    expect(isCommercialEstimate({}, { commercialSubtype: 'office_retail' })).toBe(true);
    expect(isCommercialEstimate({}, { category: 'RESIDENTIAL' })).toBe(false);
  });

  test('canonical commercial property types and engine markers park (Office/Restaurant/School/HOA/Government)', () => {
    for (const pt of ['Office', 'Restaurant', 'School', 'HOA Common Area', 'Government Municipal', 'Warehouse', 'Medical Office', 'Business Park', 'Daycare']) {
      expect(isCommercialEstimate({}, { engineInputs: { propertyType: pt } })).toBe(true);
      expect(isCommercialEstimate({}, { inputs: { propertyType: pt } })).toBe(true);
    }
    expect(isCommercialEstimate({}, { engineInputs: { category: 'COMMERCIAL' } })).toBe(true);
    expect(isCommercialEstimate({}, { engineInputs: { commercialSubtype: 'restaurant_food_service' } })).toBe(true);
    expect(isCommercialEstimate({}, { engineRequest: { profile: { commercialRiskType: 'food' } } })).toBe(true);
    expect(isCommercialEstimate({}, { engineInputs: { propertyType: 'Single Family', category: 'RESIDENTIAL' } })).toBe(false);
    expect(isCommercialEstimate({}, { engineInputs: { propertyType: 'Mobile Home' } })).toBe(false);
  });

  test('every persisted input generation parks (engineInputs / engineRequest.profile / enriched)', () => {
    expect(isCommercialEstimate({}, { engineInputs: { propertyType: 'Duplex' } })).toBe(true);
    expect(isCommercialEstimate({}, { engineInputs: { isCommercial: true } })).toBe(true);
    expect(isCommercialEstimate({}, { engineRequest: { profile: { propertyType: 'Townhome' } } })).toBe(true);
    expect(isCommercialEstimate({}, { engineRequest: { profile: { isCommercial: 'YES' } } })).toBe(true);
    expect(isCommercialEstimate({}, { enriched: { propertyType: 'Condo' } })).toBe(true);
    expect(isCommercialEstimate({}, { engineInputs: { propertyType: 'Single Family' } })).toBe(false);
    expect(isCommercialEstimate({}, { engineRequest: { profile: { propertyType: 'Single Family' } } })).toBe(false);
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

// Annual Protection plan (v3, owner rulings 2026-09-24 — plan doc §A2-A4).
// Template seeded DRAFT by 20260924030002_termite_annual_protection_agreement_v3
// — never active until the owner's own review (A-11). These tests cover the
// pure selection/price/date logic (buildTermiteProgramAgreementValues) and
// render the seeded DRAFT body against it, proving every variable resolves
// and the ruling-critical first-page + renewal wording is present.
describe('Annual Protection plan selection (buildTermiteProgramAgreementValues)', () => {
  test('annual estimate selects the annual template key with setup/annual price and the booked start/computed end date', () => {
    const prepared = buildTermiteProgramAgreementValues({}, annualEstData(), {
      startDateLabel: 'September 24, 2026',
      startDateRaw: '2026-09-24',
    });
    expect(prepared).not.toBeNull();
    expect(prepared.templateKey).toBe(ANNUAL_TEMPLATE_KEY);
    expect(prepared.values.program.setup_price).toBe('$900');
    expect(prepared.values.program.annual_price).toBe('$480');
    expect(prepared.values.agreement.start_date).toBe('September 24, 2026');
    expect(prepared.values.agreement.end_date).toBe('September 24, 2027'); // start + 12 months
  });

  test('no booked visit yet: start and end date both fall back to the confirmed-at-installation text', () => {
    const prepared = buildTermiteProgramAgreementValues({}, annualEstData());
    expect(prepared.values.agreement.start_date).toBe(START_DATE_FALLBACK);
    expect(prepared.values.agreement.end_date).toBe(START_DATE_FALLBACK);
  });

  test('end date is a calendar-exact +12 months, clamped for a Feb 29 start in a non-leap target year', () => {
    const prepared = buildTermiteProgramAgreementValues({}, annualEstData(), { startDateRaw: '2028-02-29' });
    expect(prepared.values.agreement.end_date).toBe('February 28, 2029');
  });

  test('fail-closed: annual plan without a resolvable setup or annual fee builds nothing', () => {
    expect(buildTermiteProgramAgreementValues({}, annualEstData({ setupFee: null }))).toBeNull();
    expect(buildTermiteProgramAgreementValues({}, annualEstData({ setupFee: 0 }))).toBeNull();
    expect(buildTermiteProgramAgreementValues({}, annualEstData({ annualFee: null }))).toBeNull();
    expect(buildTermiteProgramAgreementValues({}, annualEstData({ annualFee: 0 }))).toBeNull();
  });

  test('an annual-plan line always wins the template key — never falls through to purchase/rental', () => {
    const data = annualEstData();
    // Quarterly-shaped sibling data in the same estimate must not pull
    // selection back toward the quarterly templates.
    data.recurring = { services: [{ name: 'Termite Bait', perTreatment: 72, visitsPerYear: 4 }] };
    const prepared = buildTermiteProgramAgreementValues({}, data);
    expect(prepared.templateKey).toBe(ANNUAL_TEMPLATE_KEY);
    expect(prepared.templateKey).not.toBe(PURCHASE_TEMPLATE_KEY);
    expect(prepared.templateKey).not.toBe(RENTAL_TEMPLATE_KEY);
  });

  test('quarterly estimates are unaffected by the annual addition — still resolve to purchase/rental only', () => {
    expect(buildTermiteProgramAgreementValues({}, ownedEstData()).templateKey).toBe(PURCHASE_TEMPLATE_KEY);
    expect(buildTermiteProgramAgreementValues({}, rentedEstData()).templateKey).toBe(RENTAL_TEMPLATE_KEY);
  });

  test('a discounted annual plan states the accepted NET annual fee, not the gross list fee (Codex #4811 r1 P1)', () => {
    const data = annualEstData();
    // v1-legacy-mapper: the recurring row carries the accepted net annual
    // (manualFinalAnnual after a manual discount, annualAfterDiscount after
    // WaveGuard) while tmBait.annualFee stays the pre-discount list figure.
    data.recurring = { services: [{ name: 'Termite Bait', service: 'termite_bait', mo: 40, perTreatment: 480, visitsPerYear: 1, annualAfterDiscount: 432, manualFinalAnnual: 400 }] };
    const prepared = buildTermiteProgramAgreementValues({ waveguard_tier: 'gold' }, data);
    expect(prepared.values.program.annual_price).toBe('$400');
    expect(prepared.values.program.setup_price).toBe('$900');
  });

  test('WaveGuard-only discount uses annualAfterDiscount when no manual discount landed', () => {
    const data = annualEstData();
    data.recurring = { services: [{ name: 'Termite Bait', service: 'termite_bait', visitsPerYear: 1, annualAfterDiscount: 432 }] };
    expect(buildTermiteProgramAgreementValues({ waveguard_tier: 'silver' }, data).values.program.annual_price).toBe('$432');
  });

  test('fail-closed: an estimate that may carry a discount but stores no net annual figure builds nothing', () => {
    expect(buildTermiteProgramAgreementValues({ waveguard_tier: 'gold' }, annualEstData())).toBeNull();
    expect(buildTermiteProgramAgreementValues({ estimate_data: JSON.stringify({ manualDiscount: { amount: 50 } }) }, { ...annualEstData(), manualDiscount: { amount: 50 } })).toBeNull();
    // Bronze / no discount: the gross list fee IS the accepted fee.
    expect(buildTermiteProgramAgreementValues({ waveguard_tier: 'bronze' }, annualEstData()).values.program.annual_price).toBe('$480');
  });

  test('raw engine lineItems (no mapped envelope — published website quote) still resolve setup, annual fee and system (Codex #4811 r1 P2)', () => {
    const raw = {
      result: {
        lineItems: [{
          service: 'termite_bait', plan: 'annual_protection', selectedSystem: 'advance', system: 'advance',
          annual: 520, annualFee: 520, annualAfterDiscount: 520, visitsPerYear: 1,
          setup: { price: 810, perStation: 45, stations: 18 },
          installation: { kind: 'setup', price: 810 },
        }],
        oneTime: { items: [{ service: 'termite_bait_installation', kind: 'setup', price: 810 }] },
      },
    };
    const prepared = buildTermiteProgramAgreementValues({}, raw, { startDateLabel: 'October 1, 2026', startDateRaw: '2026-10-01' });
    expect(prepared).not.toBeNull();
    expect(prepared.templateKey).toBe(ANNUAL_TEMPLATE_KEY);
    expect(prepared.values.program.setup_price).toBe('$810');
    expect(prepared.values.program.annual_price).toBe('$520');
    expect(prepared.values.program.system).toMatch(/advance/i);
    expect(prepared.values.agreement.end_date).toBe('October 1, 2027');
  });

  test('annual plan records name the Waves-owned annual plan, never the purchase program (Codex #4811 r1 P2)', () => {
    const prepared = buildTermiteProgramAgreementValues({}, annualEstData());
    expect(prepared.ownership).toBe('annual_protection');
    expect(prepared.values.service.name).toBe(ANNUAL_SERVICE_NAME);
    expect(prepared.values.service.name).not.toBe('Termite Bait Station Program');
    // Quarterly keeps its established service name.
    expect(buildTermiteProgramAgreementValues({}, ownedEstData()).values.service.name).toBe('Termite Bait Station Program');
  });

  test('isAnnualPlanEstimate exempts the annual plan from the quarterly annual-prepay park, quarterly stays parked (Codex #4811 r2 P1)', () => {
    // Annual-plan accepts are billed prepay_annual by construction; the
    // quarterly park (seeded wording says per-application) must not swallow
    // them before the v3 branch. Quarterly termite estimates are unaffected.
    expect(isAnnualPlanEstimate(annualEstData())).toBe(true);
    expect(isAnnualPlanEstimate(ownedEstData())).toBe(false);
    expect(isAnnualPlanEstimate(rentedEstData())).toBe(false);
    expect(isAnnualPlanEstimate(null)).toBe(false);
  });

  test('a stale quarterly raw row beside the mapped result never supplies the annual net fee (Codex #4811 r3 P1)', () => {
    const data = { result: annualEstData() };
    // Retained raw containers from an earlier QUARTERLY quote: $288/yr over 4
    // visits. Neither may leak into the annual fee.
    data.engineResult = { lineItems: [{ service: 'termite_bait', plan: 'quarterly', annual: 288, annualAfterDiscount: 288, manualFinalAnnual: 288, visitsPerYear: 4 }] };
    data.result.lineItems = [{ service: 'termite_bait', plan: 'quarterly', annual: 288, annualAfterDiscount: 288, visitsPerYear: 4 }];
    expect(annualPlanNetFee(data)).toBeNull();
    expect(buildTermiteProgramAgreementValues({ waveguard_tier: 'bronze' }, data).values.program.annual_price).toBe('$480');
    // With a discount and no authoritative net row: fail closed, never $288 or $72.
    expect(buildTermiteProgramAgreementValues({ waveguard_tier: 'gold' }, data)).toBeNull();
    // The mapper's own recurring row IS authoritative.
    data.result.recurring = { services: [{ name: 'Termite Bait', service: 'termite_bait', visitsPerYear: 1, annualAfterDiscount: 432 }] };
    expect(annualPlanNetFee(data)).toBe(432);
    expect(buildTermiteProgramAgreementValues({ waveguard_tier: 'gold' }, data).values.program.annual_price).toBe('$432');
  });

  test('a quarterly-shaped recurring row (visitsPerYear 4) in the mapped container is ignored for the annual fee', () => {
    const data = annualEstData();
    data.recurring = { services: [{ name: 'Termite Bait', service: 'termite_bait', visitsPerYear: 4, annualAfterDiscount: 288 }] };
    expect(annualPlanNetFee(data)).toBeNull();
  });

  test('every annual-plan park is a completed handoff for reconciliation (Codex #4811 r5 P2)', () => {
    for (const outcome of ['commercial', 'annual_prepay', 'figures_unresolved', 'annual_template_not_active', 'annual_plan_billing_mismatch', 'annual_plan_billing_unverified']) {
      expect(PARKED_HANDOFF_OUTCOMES.has(outcome)).toBe(true);
    }
    expect(PARKED_HANDOFF_OUTCOMES.has('prepay_lookup_failed')).toBe(false);
  });

  test('PROGRAM_TEMPLATE_KEYS includes the annual key for customer-scoped lookups (existing-agreement checks span all three)', () => {
    expect(PROGRAM_TEMPLATE_KEYS).toEqual(expect.arrayContaining([PURCHASE_TEMPLATE_KEY, RENTAL_TEMPLATE_KEY, ANNUAL_TEMPLATE_KEY]));
    expect(PROGRAM_TEMPLATE_KEYS).toHaveLength(3);
  });

  // maybeCreateTermiteProgramAgreement's DB-level fail-closed check — the
  // annual template row is seeded status:'draft' with no active_version_id
  // (20260924030002), and the service explicitly checks
  // document_templates.status = 'active' AND active_version_id IS NOT NULL
  // before ever rendering, returning skipped:'annual_template_not_active'
  // (ringing the manual-prep bell) rather than falling back to the
  // quarterly templates. That DB-gated behavior needs Postgres to exercise
  // end-to-end and is NOT covered by an automated test in this worktree —
  // no QA database is configured here (see the repo's *-postgres.test.js
  // convention: WAVES_LOCAL_DEV=1 + a provisioned waves_qa_<worktree> DB).
  // The "never falls back to quarterly" half of that guarantee IS covered
  // above at the pure-function level, which is what actually decides the
  // template key regardless of what the DB lookup later finds.
});

describe('Annual v3 template body (seeded DRAFT — owner review pending, plan §A2-A4)', () => {
  test('signature block promises only what the e-sign flow captures — no blank operator ink lines (Codex #4811 r4)', () => {
    expect(V3_BODY).not.toContain(ORIGINAL_SIGNATURE_BLOCK);
    expect(V3_BODY).not.toContain('License: ________');
    expect(V3_BODY).toContain('Issued by Waves Pest Control, LLC (FL business license JB351547)');
    expect(V3_BODY).toContain('ELECTRONIC SIGNATURE: By signing, the customer confirms');
  });

  function renderAnnual(prepared) {
    const context = buildCustomerDocumentContext(CUSTOMER, prepared.values);
    return renderDocumentTemplate({
      template: { template_key: TEMPLATE_V3_ANNUAL.template_key, name: TEMPLATE_V3_ANNUAL.name },
      version: { title: TEMPLATE_V3_ANNUAL.title, body: V3_BODY },
      context,
    });
  }

  test('first page states Formosan inclusion, drywood exclusion, and retreatment-only/no-repair coverage', () => {
    expect(V3_BODY).toContain('SUBTERRANEAN TERMITES, including Formosan');
    expect(V3_BODY).toContain('DRYWOOD TERMITES');
    expect(V3_BODY).toContain('RETREATMENT ONLY — NO REPAIR');
  });

  test('states the auto-renew (Section 501.165) and auto-charge renewal consent with the literal 30-day grace (A-13 Option 2)', () => {
    expect(V3_BODY).toContain('AUTOMATIC RENEWAL (Section 501.165, Florida Statutes)');
    expect(V3_BODY).toContain('authorizes Waves to charge the renewal fee');
    expect(V3_BODY).toContain('not paid within 30 days coverage lapses');
  });

  test('carries no leftover editor scaffolding — no unresolved {…} notes, no Option 1 / invoice-and-wait text', () => {
    // Every REAL merge field is {{dotted.path}}; stripping those must leave
    // no stray { or } behind (an editor note like "{v2 clause…}" or
    // "{A-13 — choose ONE:}" would fail this).
    expect(TEMPLATE_V3_ANNUAL.body.replace(/\{\{[^}]*\}\}/g, '')).not.toMatch(/[{}]/);
    expect(V3_BODY).not.toContain('Option 1');
    expect(V3_BODY).not.toContain('Option 2');
    expect(V3_BODY).not.toContain('invoice-and-wait');
    expect(V3_BODY).not.toContain('choose ONE');
  });

  test('declared variables exactly match what the body uses (customer/program/agreement fields only)', () => {
    const used = [...new Set([...TEMPLATE_V3_ANNUAL.body.matchAll(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi)].map((m) => m[1]))].sort();
    expect(used).toEqual([...TEMPLATE_V3_ANNUAL.variables].sort());
    expect(used).toEqual([
      'agreement.end_date',
      'agreement.start_date',
      'customer.address',
      'customer.name',
      'program.annual_price',
      'program.setup_price',
      'program.system',
    ]);
  });

  test('renders against the builder output with zero unresolved variables and the sold figures present', () => {
    const prepared = buildTermiteProgramAgreementValues({}, annualEstData(), {
      startDateLabel: 'September 24, 2026',
      startDateRaw: '2026-09-24',
    });
    const rendered = renderAnnual(prepared);
    expect(rendered.unresolvedVariables).toEqual([]);
    expect(rendered.body).toContain('Stan Sample');
    expect(rendered.body).toContain('$900');
    expect(rendered.body).toContain('$480');
    expect(rendered.body).toContain('September 24, 2026');
    expect(rendered.body).toContain('September 24, 2027');
    expect(rendered.body).toContain('Trelona® ATBS annual bait stations');
  });

  test('is seeded as a DRAFT row (status:\'draft\', no active_version_id) — the migration itself never activates it', () => {
    // Static shape check on the exported constant/migration wiring: the
    // migration's up() inserts status:'draft' and leaves active_version_id
    // NULL (asserted by reading the migration source, since this test file
    // has no DB access) — see 20260924030002's up()/down() and its header
    // comment. This test pins the constant's own shape so a future edit to
    // TEMPLATE_V3_ANNUAL can't silently smuggle in a live status field.
    expect(TEMPLATE_V3_ANNUAL).not.toHaveProperty('status');
    expect(TEMPLATE_V3_ANNUAL.template_key).toBe('service_agreement.termite_annual_protection');
  });
});
