// Termite bait program agreement — accept-time prep (owner go 2026-07-29).
// Covers the pure layers: termite-fact collection from stored estimate
// shapes, ownership variant selection, fail-closed figure resolution, and a
// full render against the seeded template bodies proving every variable the
// builder emits resolves (and the ruling-critical wording is present).
const {
  PURCHASE_TEMPLATE_KEY,
  RENTAL_TEMPLATE_KEY,
  START_DATE_FALLBACK,
  agreementBlocksNewPrep,
  buildTermiteProgramAgreementValues,
  collectTermiteFacts,
  systemLabelFor,
} = require('../services/termite-program-agreement');
const { DEFAULT_TEMPLATES } = require('../models/migrations/20260729000001_seed_termite_program_agreements');
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
        { service: 'termite_bait', monthly: 24, perApp: 72, ownership: 'own', installation: { price: 610 } },
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
        { service: 'termite_bait', monthly: 24, perApp: 72, ownership: 'rent', installation: { price: 0 } },
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

describe('agreementBlocksNewPrep', () => {
  const estimate = { id: 'est-1', address: '123 Perimeter Way, Bradenton FL' };
  const openRow = (over = {}) => ({
    status: 'sent',
    share_token_expires_at: new Date(Date.now() + 86400000).toISOString(),
    document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-1', address: '123 Perimeter Way, Bradenton FL' } }),
    ...over,
  });

  test('open request for the same property blocks', () => {
    expect(agreementBlocksNewPrep(openRow(), estimate)).toBe(true);
  });

  test("workflow's literal 'expired' status never blocks a fresh prep", () => {
    expect(agreementBlocksNewPrep(openRow({ status: 'expired' }), estimate)).toBe(false);
  });

  test('signed/cancelled/voided rows never block (re-accept gets a fresh document)', () => {
    for (const status of ['signed', 'cancelled', 'voided', 'declined']) {
      expect(agreementBlocksNewPrep(openRow({ status }), estimate)).toBe(false);
    }
  });

  test('a past share-token expiry unblocks even in an open status', () => {
    expect(agreementBlocksNewPrep(openRow({ share_token_expires_at: new Date(Date.now() - 1000).toISOString() }), estimate)).toBe(false);
  });

  test('an open agreement for a DIFFERENT property does not block (multi-property customers)', () => {
    const row = openRow({
      document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-9', address: '400 Other St, Venice FL' } }),
    });
    expect(agreementBlocksNewPrep(row, estimate)).toBe(false);
  });

  test('matching estimate id blocks regardless of address text', () => {
    const row = openRow({
      document_variables_snapshot: JSON.stringify({ estimate: { id: 'est-1', address: 'totally different text' } }),
    });
    expect(agreementBlocksNewPrep(row, estimate)).toBe(true);
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
