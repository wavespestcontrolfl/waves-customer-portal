// Generate-from-estimate derivations (structured-proposal slice 1A-ii).
// Drafts derive only from what the estimator actually priced/captured —
// a row without a provable cadence generates no program, and empty
// sections come back null so the builder never fills a card with nothing.

const {
  deriveProposalDraft,
  programFamilyForService,
} = require('../services/estimate-proposal-generate');

const COMMERCIAL_ESTIMATE = {
  estimate_data: {
    inputs: { homeSqFt: '2000', stories: '2', lotSqFt: '5850' },
    commercialProspect: {
      propertyProfile: { propertyType: 'small multifamily', units: 4, buildings: 1 },
    },
    result: {
      recurring: {
        services: [
          {
            service: 'pest_control',
            name: 'Pest Control',
            perTreatment: 117,
            visitsPerYear: 4,
            annualAfterDiscount: 468,
          },
          {
            service: 'commercial_mosquito',
            name: 'Mosquito Program',
            perTreatment: 65,
            visitsPerYear: 9,
            annualAfterDiscount: 585,
          },
          // No provable cadence → must NOT generate a program.
          { service: 'lawn_care', name: 'Lawn', perTreatment: 0, visitsPerYear: 0, annualAfterDiscount: 0 },
        ],
      },
    },
  },
};

describe('programFamilyForService', () => {
  test('maps the pricing-engine vocabulary onto program families', () => {
    expect(programFamilyForService('pest_control')).toBe('pest');
    expect(programFamilyForService('commercial_pest')).toBe('pest');
    expect(programFamilyForService('german_roach_initial')).toBe('pest');
    expect(programFamilyForService('commercial_termite_bait')).toBe('termite');
    expect(programFamilyForService('bora_care')).toBe('termite');
    expect(programFamilyForService('commercial_rodent_bait')).toBe('rodent');
    expect(programFamilyForService('exclusion')).toBe('rodent');
    expect(programFamilyForService('commercial_mosquito')).toBe('mosquito');
    expect(programFamilyForService('commercial_tree_shrub')).toBe('tree_shrub');
    expect(programFamilyForService('palm_injection')).toBe('tree_shrub');
    expect(programFamilyForService('lawn_care')).toBe('lawn');
    expect(programFamilyForService('dethatching')).toBe('lawn');
    expect(programFamilyForService('mystery_service')).toBe('other');
    // Foam is recurring spot-foam TERMITE work — the truth-scope classifier
    // treats it as non-pest, and pest inclusions must never attach to it.
    expect(programFamilyForService('foam_recurring')).toBe('termite');
    expect(programFamilyForService('foam_drill')).toBe('termite');
    // Word-boundary matching — "Plant health" must NOT match /ant/ and
    // acquire pest contract terms; unknown work fails closed to 'other'.
    expect(programFamilyForService('plant_health')).toBe('other');
    expect(programFamilyForService('Plant Health Program')).toBe('other');
    expect(programFamilyForService('ant_control')).toBe('pest');
  });
});

describe('cadence aliases', () => {
  test('recognizes persisted cadence aliases via the canonical resolver (appsPerYear etc.)', () => {
    const draft = deriveProposalDraft({
      estimate_data: {
        result: {
          recurring: {
            services: [
              { service: 'commercial_tree_shrub', name: 'Tree & Shrub', appsPerYear: 6, annualAfterDiscount: 540 },
            ],
          },
        },
      },
    });
    expect(draft.programs).toHaveLength(1);
    expect(draft.programs[0]).toMatchObject({ service: 'tree_shrub', frequencyPerYear: 6, pricePerApplication: 90 });
    expect(draft.warnings).toEqual([]);
  });
});

describe('deriveProposalDraft', () => {
  test('derives programs from priced engine rows only, with family stacks', () => {
    const draft = deriveProposalDraft(COMMERCIAL_ESTIMATE);
    expect(draft.programs).toHaveLength(2); // unpriced lawn row dropped
    const [pest, mosquito] = draft.programs;
    expect(pest).toMatchObject({
      service: 'pest',
      label: 'Pest Control',
      frequencyPerYear: 4,
      pricePerApplication: 117,
      annual: 468,
      // Canonical commercial default: non-lawn commercial work is taxable
      // when the engine row carries no explicit flag.
      taxable: true,
    });
    // Pest carries the owner-stated commercial terms; the cadence line is
    // derived from the priced row.
    expect(pest.inclusions[0]).toBe('4 scheduled service visits per year');
    expect(pest.inclusions).toContain('Interior treatment included on request — no extra charge, no surprise fees');
    expect(pest.exclusions.join(' ')).toMatch(/Termite/);
    // Non-pest families stay factual — documentation line only, no
    // pest-plan claims.
    expect(mosquito.service).toBe('mosquito');
    expect(mosquito.inclusions).toEqual([
      '9 scheduled service visits per year',
      'Every visit documented — time on site, areas treated, and products applied',
    ]);
    expect(mosquito.inclusions.join(' ')).not.toMatch(/no long-term contract|tenant/i);
  });

  test('derives property scope from estimator inputs + prospect profile', () => {
    const draft = deriveProposalDraft(COMMERCIAL_ESTIMATE);
    // Deterministic estimator inputs ONLY — the LLM prospect profile is
    // internal and never promotes into customer-facing scope (codex r2f).
    expect(draft.propertyScope.items).toEqual([
      { label: 'Building', value: '2,000 sq ft · 2 stories' },
      { label: 'Lot', value: '5,850 sq ft' },
    ]);
  });

  test('unions responsibilities across program families without duplicates', () => {
    const draft = deriveProposalDraft(COMMERCIAL_ESTIMATE);
    expect(draft.customerResponsibilities).toContain('Report pest activity between visits through the Waves app or office line');
    expect(draft.customerResponsibilities).toContain('Empty or report standing water (plant saucers, gutters, containers) between visits');
    expect(new Set(draft.customerResponsibilities).size).toBe(draft.customerResponsibilities.length);
  });

  test('derives the per-application price from the AUTHORITATIVE discounted annual (pre-push P0)', () => {
    const draft = deriveProposalDraft({
      estimate_data: {
        result: {
          recurring: {
            services: [
              // List $100 × 4, accepted annual $360 (manual discount): the
              // program must price from the accepted annual, never list.
              { service: 'pest_control', name: 'Pest', perTreatment: 100, visitsPerYear: 4, annualAfterDiscount: 360 },
              // manualFinalAnnual outranks annualAfterDiscount when present.
              { service: 'lawn_care', name: 'Lawn', perTreatment: 60, visitsPerYear: 9, annualAfterDiscount: 540, manualFinalAnnual: 450 },
            ],
          },
        },
      },
    });
    expect(draft.programs).toHaveLength(2);
    expect(draft.programs[0]).toMatchObject({ pricePerApplication: 90, annual: 360, frequencyPerYear: 4 });
    expect(draft.programs[1]).toMatchObject({ service: 'lawn', pricePerApplication: 50, annual: 450 });
    expect(draft.warnings).toEqual([]);
  });

  test('an unrepresentable accepted annual fails the WHOLE programs section with a warning — never a partial list (pre-push P0)', () => {
    const draft = deriveProposalDraft({
      estimate_data: {
        result: {
          recurring: {
            services: [
              { service: 'pest_control', name: 'Pest', perTreatment: 117, visitsPerYear: 4, annualAfterDiscount: 468 },
              // $350 / 3 visits is not equal cent-valued applications.
              { service: 'mosquito', name: 'Mosquito', perTreatment: 117, visitsPerYear: 3, annualAfterDiscount: 350 },
            ],
          },
        },
      },
    });
    expect(draft.programs).toBeNull();
    expect(draft.customerResponsibilities).toBeNull();
    expect(draft.warnings).toHaveLength(1);
    expect(draft.warnings[0]).toMatch(/Mosquito/);
    expect(draft.warnings[0]).toMatch(/manually/);
  });

  test('preserves engine taxability, fails on cadence-less priced rows, >10 programs, and total mismatches (pre-push P0s)', () => {
    // Engine taxability carries through.
    const taxable = deriveProposalDraft({
      estimate_data: {
        result: { recurring: { services: [{ service: 'commercial_pest', name: 'Pest', taxable: true, visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(taxable.programs[0].taxable).toBe(true);

    // Priced row with no cadence fails the whole section.
    const cadenceless = deriveProposalDraft({
      estimate_data: {
        result: { recurring: { services: [
          { service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 },
          { service: 'lawn_care', name: 'Lawn', visitsPerYear: 0, annualAfterDiscount: 540 },
        ] } },
      },
    });
    expect(cadenceless.programs).toBeNull();
    expect(cadenceless.warnings[0]).toMatch(/Lawn \(no visit cadence\)/);

    // More than 10 priced services refuses rather than truncating.
    const many = deriveProposalDraft({
      estimate_data: {
        result: { recurring: { services: Array.from({ length: 11 }, (_, i) => ({
          service: 'pest_control', name: `Svc ${i}`, visitsPerYear: 4, annualAfterDiscount: 400 + i * 4,
        })) } },
      },
    });
    expect(many.programs).toBeNull();
    expect(many.warnings[0]).toMatch(/limited to 10 programs/);

    // Stored annual_total contradicting the row sum (plan-level credit)
    // refuses rather than generating numbers acceptance won't charge.
    const mismatched = deriveProposalDraft({
      annual_total: 400,
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(mismatched.programs).toBeNull();
    expect(mismatched.warnings[0]).toMatch(/annual total/);
  });

  test('derives one-time work into corrective drafts, all-or-nothing with programs (pre-push P0)', () => {
    const withOneTime = deriveProposalDraft({
      onetime_total: 275,
      estimate_data: {
        result: {
          recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] },
          oneTime: { items: [{ service: 'pest_initial_roach', name: 'German Cockroach Treatment', price: 275, detail: 'Includes 1 treatment visit.' }] },
        },
      },
    });
    expect(withOneTime.correctiveWork).toEqual([{
      label: 'German Cockroach Treatment', amount: 275, taxable: true, includes: ['Includes 1 treatment visit.'],
    }]);
    expect(withOneTime.programs).toHaveLength(1);

    // A one-time mismatch with the stored onetime_total fails the WHOLE
    // monetary draft — programs must not install without the one-time side.
    const mismatch = deriveProposalDraft({
      onetime_total: 300,
      estimate_data: {
        result: {
          recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] },
          oneTime: { items: [{ name: 'Cleanout', price: 275 }] },
        },
      },
    });
    expect(mismatch.programs).toBeNull();
    expect(mismatch.correctiveWork).toBeNull();
    expect(mismatch.warnings[0]).toMatch(/one-time total/);
  });

  test('a stored one-time total with no representable rows, or >24 items, fails the draft (pre-push P0)', () => {
    const orphanTotal = deriveProposalDraft({
      onetime_total: 275,
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(orphanTotal.programs).toBeNull();
    expect(orphanTotal.correctiveWork).toBeNull();
    expect(orphanTotal.warnings[0]).toMatch(/no representable one-time items/);

    const tooMany = deriveProposalDraft({
      estimate_data: {
        result: {
          oneTime: { items: Array.from({ length: 25 }, (_, i) => ({ name: `Item ${i}`, price: 10 })) },
        },
      },
    });
    expect(tooMany.correctiveWork).toBeNull();
    expect(tooMany.warnings[0]).toMatch(/limited to 24/);
  });

  test('a fractional cadence (biennial 0.5/yr) fails the draft rather than rounding to a different program (pre-push P0)', () => {
    const draft = deriveProposalDraft({
      estimate_data: {
        result: {
          recurring: {
            services: [
              { service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 },
              { service: 'palm_injection', name: 'Tree-Age Palm Treatment', appsPerYear: 0.5, annualAfterDiscount: 100 },
            ],
          },
        },
      },
    });
    expect(draft.programs).toBeNull();
    expect(draft.warnings[0]).toMatch(/fractional visit cadence/);
  });

  test('corrective work prices from the operator-accepted net (manualFinalOneTime beats gross price)', () => {
    const draft = deriveProposalDraft({
      estimate_data: {
        result: {
          oneTime: { items: [{ name: 'Cleanout', price: 300, manualFinalOneTime: 250 }] },
        },
      },
    });
    expect(draft.correctiveWork).toEqual([{ label: 'Cleanout', amount: 250, taxable: true, includes: [] }]);
  });

  test('explicit zeros are authoritative: zeroed totals reject generated prices, comped rows fail the draft (codex r2c)', () => {
    // Quote-required estimate deliberately zeroed → generated positive
    // programs must NOT install.
    const zeroed = deriveProposalDraft({
      annual_total: 0,
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(zeroed.programs).toBeNull();
    expect(zeroed.warnings[0]).toMatch(/annual total/);

    // Comped recurring service (explicit accepted zero) fails the draft.
    const compedRecurring = deriveProposalDraft({
      estimate_data: {
        result: { recurring: { services: [
          { service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 },
          { service: 'mosquito', name: 'Comped Mosquito', visitsPerYear: 9, annualAfterDiscount: 585, manualFinalAnnual: 0 },
        ] } },
      },
    });
    expect(compedRecurring.programs).toBeNull();
    expect(compedRecurring.warnings[0]).toMatch(/comped/i);

    // Comped one-time item fails the one-time side.
    const compedOneTime = deriveProposalDraft({
      estimate_data: {
        result: { oneTime: { items: [{ name: 'Comped Cleanout', price: 300, manualFinalOneTime: 0 }] } },
      },
    });
    expect(compedOneTime.correctiveWork).toBeNull();
    expect(compedOneTime.warnings[0]).toMatch(/comped/i);
  });

  test('taxability defaults: explicit flag wins, lawn exempt, null totals stay null (codex r2e)', () => {
    const draft = deriveProposalDraft({
      annual_total: null, // nullable DB column must NOT read as explicit $0
      estimate_data: {
        result: {
          recurring: { services: [
            { service: 'lawn_care', name: 'Lawn', visitsPerYear: 9, annualAfterDiscount: 540 },
            { service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468, taxable: false },
          ] },
          // Same specialty row persisted twice (specItems duplication) —
          // identity dedupe keeps one.
          oneTime: { items: [{ service: 'exclusion_v', name: 'Exclusion', price: 900 }], specItems: [{ service: 'exclusion_v', name: 'Exclusion', price: 900 }] },
        },
      },
    });
    expect(draft.programs).toHaveLength(2);
    expect(draft.programs[0].taxable).toBe(false); // lawn exempt by canonical rule
    expect(draft.programs[1].taxable).toBe(false); // explicit engine false wins
    expect(draft.correctiveWork).toHaveLength(1);  // deduped
    expect(draft.warnings).toEqual([]);
  });

  test('a positive annual total with no representable recurring rows fails the draft (codex r2h)', () => {
    const draft = deriveProposalDraft({
      annual_total: 468,
      onetime_total: 275,
      estimate_data: {
        result: {
          recurring: { services: [] },
          oneTime: { items: [{ name: 'Cleanout', price: 275 }] },
        },
      },
    });
    expect(draft.programs).toBeNull();
    expect(draft.correctiveWork).toBeNull(); // all-or-nothing across sides
    expect(draft.warnings[0]).toMatch(/no representable recurring services/);
  });

  test('monthly-only recurring rows price via the canonical resolver (monthly × 12 — codex r2i)', () => {
    const draft = deriveProposalDraft({
      estimate_data: {
        result: {
          recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 12, mo: 39 }] },
        },
      },
    });
    expect(draft.programs).toHaveLength(1);
    expect(draft.programs[0]).toMatchObject({ frequencyPerYear: 12, pricePerApplication: 39, annual: 468 });
  });

  test('null annual_total falls back to monthly_total as the recurring authority (codex r2j)', () => {
    const match = deriveProposalDraft({
      annual_total: null,
      monthly_total: 39,
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 12, mo: 39 }] } },
      },
    });
    expect(match.programs).toHaveLength(1);
    expect(match.warnings).toEqual([]);

    const mismatch = deriveProposalDraft({
      annual_total: null,
      monthly_total: 45,
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 12, mo: 39 }] } },
      },
    });
    expect(mismatch.programs).toBeNull();
    expect(mismatch.warnings[0]).toMatch(/monthly total/);
  });

  test('returns null sections for an estimate with nothing to derive', () => {
    const draft = deriveProposalDraft({ estimate_data: {} });
    expect(draft).toEqual({ propertyScope: null, programs: null, correctiveWork: null, customerResponsibilities: null, warnings: [] });
  });
});
