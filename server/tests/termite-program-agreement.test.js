// Termite bait program agreement — accept-time prep (owner go 2026-07-29).
// Covers the pure layers: termite-fact collection from stored estimate
// shapes, ownership variant selection, fail-closed figure resolution, and a
// full render against the seeded template bodies proving every variable the
// builder emits resolves (and the ruling-critical wording is present).
const {
  PURCHASE_TEMPLATE_KEY,
  RENTAL_TEMPLATE_KEY,
  buildTermiteProgramAgreementValues,
  collectTermiteFacts,
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
