// Generate-from-estimate derivations (structured-proposal slice 1A-ii).
// Drafts derive only from what the estimator actually priced/captured —
// a row without a provable cadence generates no program, and empty
// sections come back null so the builder never fills a card with nothing.

const {
  deriveProposalDraft,
  programFamilyForService,
} = require('../services/estimate-proposal-generate');

const COMMERCIAL_ESTIMATE = {
  category: 'COMMERCIAL',
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
            service: 'commercial_mosquito', billedPerApplication: true,
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
  test('maps the pricing-engine vocabulary onto program families', async () => {
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
  test('recognizes persisted cadence aliases via the canonical resolver (appsPerYear etc.)', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: {
          recurring: {
            services: [
              { service: 'commercial_tree_shrub', billedPerApplication: true, name: 'Tree & Shrub', appsPerYear: 6, annualAfterDiscount: 540 },
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
  test('derives programs from priced engine rows only, with family stacks', async () => {
    const draft = await deriveProposalDraft(COMMERCIAL_ESTIMATE);
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
    expect(pest.inclusions[0]).toBe('4 scheduled applications per year');
    expect(pest.inclusions).toContain('Interior treatment included on request — no extra charge, no surprise fees');
    expect(pest.exclusions.join(' ')).toMatch(/Termite/);
    // Non-pest families stay factual — documentation line only, no
    // pest-plan claims.
    expect(mosquito.service).toBe('mosquito');
    expect(mosquito.inclusions).toEqual([
      '9 scheduled applications per year',
      'Every visit documented — time on site, areas treated, and products applied',
    ]);
    expect(mosquito.inclusions.join(' ')).not.toMatch(/no long-term contract|tenant/i);
  });

  test('derives property scope from estimator inputs + prospect profile', async () => {
    const draft = await deriveProposalDraft(COMMERCIAL_ESTIMATE);
    // Deterministic estimator inputs ONLY — the LLM prospect profile is
    // internal and never promotes into customer-facing scope (codex r2f).
    expect(draft.propertyScope.items).toEqual([
      { label: 'Building', value: '2,000 sq ft · 2 stories' },
      { label: 'Lot', value: '5,850 sq ft' },
    ]);
  });

  test('unions responsibilities across program families without duplicates', async () => {
    const draft = await deriveProposalDraft(COMMERCIAL_ESTIMATE);
    expect(draft.customerResponsibilities).toContain('Report pest activity between visits through the Waves app or office line');
    expect(draft.customerResponsibilities).toContain('Empty or report standing water (plant saucers, gutters, containers) between visits');
    expect(new Set(draft.customerResponsibilities).size).toBe(draft.customerResponsibilities.length);
  });

  test('derives the per-application price from the AUTHORITATIVE discounted annual (pre-push P0)', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
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

  test('an unrepresentable accepted annual fails the WHOLE programs section with a warning — never a partial list (pre-push P0)', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
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

  test('preserves engine taxability, fails on cadence-less priced rows, >10 programs, and total mismatches (pre-push P0s)', async () => {
    // Engine taxability carries through.
    const taxable = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'commercial_pest', billedPerApplication: true, name: 'Pest', taxable: true, visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(taxable.programs[0].taxable).toBe(true);

    // Priced row with no cadence fails the whole section.
    const cadenceless = await deriveProposalDraft({ category: 'COMMERCIAL',
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
    const many = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        // Distinct service keys — the canonical collector dedupes by key.
        result: { recurring: { services: Array.from({ length: 11 }, (_, i) => ({
          service: `custom_service_${i}`, name: `Svc ${i}`, visitsPerYear: 4, annualAfterDiscount: 400 + i * 4,
        })) } },
      },
    });
    expect(many.programs).toBeNull();
    expect(many.warnings[0]).toMatch(/limited to 10 programs/);

    // Stored annual_total contradicting the row sum (plan-level credit)
    // refuses rather than generating numbers acceptance won't charge.
    const mismatched = await deriveProposalDraft({ category: 'COMMERCIAL',
      annual_total: 400,
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(mismatched.programs).toBeNull();
    expect(mismatched.warnings[0]).toMatch(/annual total/);
  });

  test('derives one-time work into corrective drafts, all-or-nothing with programs (pre-push P0)', async () => {
    const withOneTime = await deriveProposalDraft({ category: 'COMMERCIAL',
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
    const mismatch = await deriveProposalDraft({ category: 'COMMERCIAL',
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

  test('a stored one-time total with no representable rows, or >24 items, fails the draft (pre-push P0)', async () => {
    const orphanTotal = await deriveProposalDraft({ category: 'COMMERCIAL',
      onetime_total: 275,
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(orphanTotal.programs).toBeNull();
    expect(orphanTotal.correctiveWork).toBeNull();
    expect(orphanTotal.warnings[0]).toMatch(/no representable one-time items/);

    const tooMany = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: {
          oneTime: { items: Array.from({ length: 25 }, (_, i) => ({ name: `Item ${i}`, price: 10 })) },
        },
      },
    });
    expect(tooMany.correctiveWork).toBeNull();
    expect(tooMany.warnings[0]).toMatch(/limited to 24/);
  });

  test('a fractional cadence (biennial 0.5/yr) fails the draft rather than rounding to a different program (pre-push P0)', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
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

  test('corrective work prices from the operator-accepted net (manualFinalOneTime beats gross price)', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: {
          oneTime: { items: [{ name: 'Cleanout', price: 300, manualFinalOneTime: 250 }] },
        },
      },
    });
    expect(draft.correctiveWork).toEqual([{ label: 'Cleanout', amount: 250, taxable: true, includes: [] }]);
  });

  test('explicit zeros are authoritative: zeroed totals reject generated prices, comped rows fail the draft (codex r2c)', async () => {
    // Quote-required estimate deliberately zeroed → generated positive
    // programs must NOT install.
    const zeroed = await deriveProposalDraft({ category: 'COMMERCIAL',
      annual_total: 0,
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(zeroed.programs).toBeNull();
    expect(zeroed.warnings[0]).toMatch(/annual total/);

    // Comped recurring service (explicit accepted zero) fails the draft.
    const compedRecurring = await deriveProposalDraft({ category: 'COMMERCIAL',
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
    const compedOneTime = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ name: 'Comped Cleanout', price: 300, manualFinalOneTime: 0 }] } },
      },
    });
    expect(compedOneTime.correctiveWork).toBeNull();
    expect(compedOneTime.warnings[0]).toMatch(/comped/i);
  });

  test('taxability defaults: explicit flag wins, lawn exempt, null totals stay null (codex r2e)', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
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

  test('a positive annual total with no representable recurring rows fails the draft (codex r2h)', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
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

  test('monthly-only recurring rows price via the canonical resolver (monthly × 12 — codex r2i)', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: {
          recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 12, mo: 39 }] },
        },
      },
    });
    expect(draft.programs).toHaveLength(1);
    expect(draft.programs[0]).toMatchObject({ frequencyPerYear: 12, pricePerApplication: 39, annual: 468 });
  });

  test('null annual_total falls back to monthly_total as the recurring authority (codex r2j)', async () => {
    const match = await deriveProposalDraft({ category: 'COMMERCIAL',
      annual_total: null,
      monthly_total: 39,
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 12, mo: 39 }] } },
      },
    });
    expect(match.programs).toHaveLength(1);
    expect(match.warnings).toEqual([]);

    const mismatch = await deriveProposalDraft({ category: 'COMMERCIAL',
      annual_total: null,
      monthly_total: 45,
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 12, mo: 39 }] } },
      },
    });
    expect(mismatch.programs).toBeNull();
    expect(mismatch.warnings[0]).toMatch(/monthly total/);
  });

  test('r3 hardening: nested containers, termite ambiguity, raw one-time prices, suggested tax rate', async () => {
    // result.results.recurring.services (mapped shape) collects via the
    // canonical recurringServicesFromEstimateData.
    const nested = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { results: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } } },
      },
    });
    expect(nested.programs).toHaveLength(1);
    // Taxable generated items carry the canonical FL commercial default.
    expect(nested.suggestedTaxRate).toBe(0.07);

    // Flat-monthly termite (mo + per-visit fields) is ambiguous without an
    // explicit billedPerApplication flag — fail, never promise per-app.
    const termite = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'commercial_termite_bait', name: 'Termite Bait', mo: 35, perTreatment: 105, visitsPerYear: 4, annualAfterDiscount: 420 }] } },
      },
    });
    expect(termite.programs).toBeNull();
    expect(termite.warnings[0]).toMatch(/termite billing cadence/i);

    // Raw engine one-time rows ({ service, price }) with no recurring
    // evidence derive as corrective work.
    const rawOneTime = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        engineResult: { lineItems: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 500 }] },
      },
    });
    expect(rawOneTime.correctiveWork).toEqual([{ label: 'Bed Bug Treatment', amount: 500, taxable: true, includes: [] }]);
  });

  test('legit repeated one-time charges are preserved; mirrored container copies collapse (codex r3c)', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: {
          // Two IDENTICAL unit treatments in ONE container = two real
          // charges; the same specialty row mirrored into specItems is a
          // copy, not a third charge.
          oneTime: {
            items: [
              { service: 'pest_initial_roach', name: 'Unit cleanout', price: 275 },
              { service: 'pest_initial_roach', name: 'Unit cleanout', price: 275 },
            ],
            specItems: [{ service: 'pest_initial_roach', name: 'Unit cleanout', price: 275 }],
          },
        },
      },
    });
    expect(draft.correctiveWork).toHaveLength(2);
    expect(draft.correctiveWork.every((w) => w.amount === 275)).toBe(true);
  });

  test('r3d: WDO inspections exempt, root one-time beside result, ancillary result does not hide engineResult rows', async () => {
    // wdo_inspection = canonical non-taxable (FL §212.08(6)).
    const wdo = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'wdo_inspection', name: 'WDO Inspection', price: 250 }] } },
      },
    });
    expect(wdo.correctiveWork[0].taxable).toBe(false);

    // Root one_time.items beside a truthy result still collects.
    const rootOneTime = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
        one_time: { items: [{ name: 'Cleanout', price: 275 }] },
      },
    });
    expect(rootOneTime.correctiveWork).toHaveLength(1);

    // A truthy ancillary `result` must not hide engineResult.lineItems.
    const hidden = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { summary: 'ancillary' },
        engineResult: { lineItems: [{ service: 'commercial_mosquito', billedPerApplication: true, name: 'Mosquito', visitsPerYear: 9, annualAfterDiscount: 585 }] },
      },
    });
    expect(hidden.programs).toHaveLength(1);
    expect(hidden.programs[0].service).toBe('mosquito');
  });

  test('r5: rodent monthly ambiguity, installation extraction, review-gated exclusion, palm supplements', async () => {
    // Rodent bait with monthly evidence = ambiguous billing, fail.
    const rodent = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'commercial_rodent_bait', name: 'Rodent Bait', mo: 45, perTreatment: 135, visitsPerYear: 4, annualAfterDiscount: 540 }] } },
      },
    });
    expect(rodent.programs).toBeNull();
    expect(rodent.warnings[0]).toMatch(/rodent billing cadence/i);

    // Installation charge on a RECURRING termite-bait row extracts as
    // corrective work (the recurring side fails ambiguity separately).
    const install = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        engineResult: { lineItems: [{ service: 'commercial_termite_bait', name: 'Termite Bait', visitsPerYear: 4, annual: 420, billedPerApplication: true, installation: { price: 800 } }] },
      },
    });
    expect(install.correctiveWork).toEqual([
      { label: 'Termite Bait installation', amount: 800, taxable: true, includes: [] },
    ]);

    // Review-gated rows FAIL the draft with a warning — provisional
    // prices never generate and never silently vanish.
    const gated = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        engineResult: { lineItems: [{ service: 'commercial_pest', name: 'Pest', visitsPerYear: 4, annual: 468, requiresManualReview: true }] },
      },
    });
    expect(gated.programs).toBeNull();
    expect(gated.warnings[0]).toMatch(/requires manual review/i);

    // Mapped palm-injection supplement is SEEN — cadence unproven → the
    // all-or-nothing warning fires instead of silent omission.
    const palm = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: {
          recurring: {
            services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }],
            palmInjectionAnn: 300,
          },
        },
      },
    });
    expect(palm.programs).toBeNull();
    expect(palm.warnings[0]).toMatch(/Palm Injection/);
  });

  test('r6: raw one-time clones collapse across containers; rodent-bait supplement never omitted', async () => {
    const sharedRow = { service: 'bed_bug', name: 'Bed Bug Treatment', price: 500 };
    const clones = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { lineItems: [{ ...sharedRow }] },
        engineResult: { lineItems: [{ ...sharedRow }] },
      },
    });
    expect(clones.correctiveWork).toHaveLength(1);

    const rodent = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }], rodentBaitMo: 45 } },
      },
    });
    expect(rodent.programs).toBeNull();
    expect(rodent.warnings[0]).toMatch(/rodent/i);
  });

  test('r7: LOW pricing confidence fails the draft; mapped installations never double', async () => {
    const low = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'commercial_lawn', name: 'Lawn', visitsPerYear: 9, annualAfterDiscount: 540, pricingConfidence: 'LOW' }] } },
      },
    });
    expect(low.programs).toBeNull();
    expect(low.warnings[0]).toMatch(/low-confidence/i);

    // Mapper emitted the installation into oneTime.items AND the raw
    // engineResult row still carries installation.price — one charge.
    const install = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'termite_bait', name: 'Termite Bait Installation', price: 800 }] } },
        engineResult: { lineItems: [{ service: 'commercial_termite_bait', name: 'Termite Bait', visitsPerYear: 4, annual: 420, billedPerApplication: true, installation: { price: 800 } }] },
      },
    });
    expect(install.correctiveWork).toHaveLength(1);
    expect(install.correctiveWork[0].amount).toBe(800);
  });

  test('r8: EVERY engine review marker gates — priced customQuoteFlag/requiresMeasurement rows fail the draft', async () => {
    // Oversize-lawn custom quotes carry a price but customQuoteFlag says
    // "field verification required" — the full lineRequiresReview
    // predicate must gate, not the two-flag subset (codex 1A-ii r8).
    const custom = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        engineResult: { lineItems: [{ service: 'commercial_lawn', name: 'Lawn', visitsPerYear: 9, annual: 540, customQuoteFlag: true }] },
      },
    });
    expect(custom.programs).toBeNull();
    expect(custom.warnings[0]).toMatch(/requires manual review/i);

    const measure = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 500, requiresMeasurement: true }] } },
      },
    });
    expect(measure.correctiveWork).toBeNull();
    expect(measure.warnings[0]).toMatch(/requires manual review/i);

    const reasons = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468, manualReviewReasons: ['density unknown'] }] } },
      },
    });
    expect(reasons.programs).toBeNull();
    expect(reasons.warnings[0]).toMatch(/requires manual review/i);
  });

  test('r10: heuristic turf provenance gates generation — plausibleMaxTurfCap at MEDIUM confidence fails the draft', async () => {
    const capped = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'commercial_lawn', name: 'Lawn', visitsPerYear: 9, annualAfterDiscount: 1260, turfBasis: 'plausibleMaxTurfCap', turfConfidence: 'MEDIUM' }] } },
      },
    });
    expect(capped.programs).toBeNull();
    expect(capped.warnings[0]).toMatch(/requires manual review/i);

    const lowTurf = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'commercial_lawn', name: 'Lawn', visitsPerYear: 9, annualAfterDiscount: 1260, turfBasis: 'measuredTurfSf', turfConfidence: 'LOW' }] } },
      },
    });
    expect(lowTurf.programs).toBeNull();

    // A measured basis at MEDIUM+ confidence generates normally.
    const measured = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'commercial_lawn', billedPerApplication: true, name: 'Lawn', visitsPerYear: 9, annualAfterDiscount: 1260, turfBasis: 'measuredTurfSf', turfConfidence: 'HIGH' }] } },
      },
    });
    expect(measured.programs).toHaveLength(1);
    expect(measured.warnings).toEqual([]);
  });

  test('r9: noncommercial estimates generate nothing — no commercial promises from residential pricing', async () => {
    const residential = await deriveProposalDraft({
      category: 'RESIDENTIAL',
      estimate_data: COMMERCIAL_ESTIMATE.estimate_data,
    });
    expect(residential.programs).toBeNull();
    expect(residential.propertyScope).toBeNull();
    expect(residential.customerResponsibilities).toBeNull();
    expect(residential.warnings[0]).toMatch(/not a commercial estimate/i);
    // No category at all (legacy rows default RESIDENTIAL) fails too.
    const uncategorized = await deriveProposalDraft({ estimate_data: COMMERCIAL_ESTIMATE.estimate_data });
    expect(uncategorized.programs).toBeNull();
    expect(uncategorized.warnings[0]).toMatch(/not a commercial estimate/i);
  });

  test('r9: installation mirrors match by content identity, never a first-token label', async () => {
    // A distinct same-priced corrective item whose label merely shares the
    // "commercial" token must NOT absorb the real installation charge —
    // both rows emit and reconciliation arbitrates (fail-closed, never a
    // silent underbill).
    const distinct = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'commercial_deep_clean', name: 'Commercial deep clean', price: 800 }] } },
        engineResult: { lineItems: [{ service: 'commercial_termite_bait', name: 'Termite Bait', visitsPerYear: 4, annual: 420, billedPerApplication: true, installation: { price: 800 } }] },
      },
    });
    expect(distinct.correctiveWork).toHaveLength(2);
    expect(distinct.correctiveWork.map((w) => w.amount)).toEqual([800, 800]);

    // A same-family same-priced item WITHOUT install semantics (a termite
    // treatment beside the bait installation) is not a mirror either.
    const treatment = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'termite_treatment', name: 'Termite treatment', price: 800 }] } },
        engineResult: { lineItems: [{ service: 'commercial_termite_bait', name: 'Termite Bait', visitsPerYear: 4, annual: 420, billedPerApplication: true, installation: { price: 800 } }] },
      },
    });
    expect(treatment.correctiveWork).toHaveLength(2);

    // The mapper's canonical key dedupes exactly.
    const exact = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'termite_bait_installation', name: 'Termite bait installation', price: 800 }] } },
        engineResult: { lineItems: [{ service: 'termite_bait', name: 'Termite Bait', visitsPerYear: 4, annual: 420, billedPerApplication: true, installation: { price: 800 } }] },
      },
    });
    expect(exact.correctiveWork).toHaveLength(1);

    // Count-aware: TWO installation charges (distinct services) against ONE
    // mapped item keep the second charge.
    const twoInstalls = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'termite_bait_installation', name: 'Termite bait installation', price: 800 }] } },
        engineResult: {
          lineItems: [
            { service: 'termite_bait', name: 'Termite Bait', visitsPerYear: 4, annual: 420, billedPerApplication: true, installation: { price: 800 } },
            { service: 'commercial_termite_bait', name: 'Termite Bait — Annex', visitsPerYear: 4, annual: 480, billedPerApplication: true, installation: { price: 800 } },
          ],
        },
      },
    });
    // The mapped item emits once and absorbs ONE install (exact
    // `_installation` key); the second, distinct-service install charge
    // survives — 2 × $800, never 1 or 3.
    expect(twoInstalls.correctiveWork.filter((w) => w.amount === 800)).toHaveLength(2);
  });

  test('r10: same-key monetary rows in one container fail the draft — the collector would collapse them', async () => {
    // Building A and Building B priced separately under the same service
    // key: the canonical collector dedupes by key, so generation would
    // merge them into one hybrid program and (with null stored totals)
    // reconciliation could never catch the lost charge.
    const twoBuildings = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        engineResult: {
          lineItems: [
            { service: 'commercial_pest', name: 'Pest — Bldg A', visitsPerYear: 12, annual: 2400 },
            { service: 'commercial_pest', name: 'Pest — Bldg B', visitsPerYear: 12, annual: 3600 },
          ],
        },
      },
    });
    expect(twoBuildings.programs).toBeNull();
    expect(twoBuildings.warnings[0]).toMatch(/multiple separately priced rows/i);

    // Identical same-key rows in one container are still two charges.
    const identicalPair = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [
          { service: 'commercial_pest', name: 'Pest — Bldg A', visitsPerYear: 12, annualAfterDiscount: 2400 },
          { service: 'commercial_pest', name: 'Pest — Bldg B', visitsPerYear: 12, annualAfterDiscount: 2400 },
        ] } },
      },
    });
    expect(identicalPair.programs).toBeNull();

    // Cross-container same-key rows keep the established mirror/precedence
    // semantics — a mapped discounted row beside its raw engine twin still
    // generates one program.
    const mirrored = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'commercial_pest', billedPerApplication: true, name: 'Pest', visitsPerYear: 12, annualAfterDiscount: 2280 }] } },
        engineResult: { lineItems: [{ service: 'commercial_pest', billedPerApplication: true, name: 'Pest', visitsPerYear: 12, annual: 2400 }] },
      },
    });
    expect(mirrored.programs).toHaveLength(1);
    expect(mirrored.programs[0].annual).toBe(2280);
    expect(mirrored.warnings).toEqual([]);
  });

  test('returns null sections for an estimate with nothing to derive', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL', estimate_data: {} });
    expect(draft).toEqual({ propertyScope: null, programs: null, correctiveWork: null, customerResponsibilities: null, responsibilitiesByFamily: null, suggestedTaxRate: null, warnings: [] });
  });

  test('r12: review markers on the RAW twin gate the mapped canonical row; responsibilities map by family', async () => {
    // The canonical collector excludes gated raw rows and the canonical-key
    // filter discards the raw twin — the marker must still gate the mapped
    // row that kept the price.
    const shadowGated = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
        engineResult: { lineItems: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annual: 468, quoteRequired: true }] },
      },
    });
    expect(shadowGated.programs).toBeNull();
    expect(shadowGated.warnings[0]).toMatch(/requires manual review/i);

    // The generated draft names each family's responsibility lines so the
    // builder can prune them when a program is deleted.
    const draft = await deriveProposalDraft(COMMERCIAL_ESTIMATE);
    expect(Object.keys(draft.responsibilitiesByFamily).sort()).toEqual(['mosquito', 'pest']);
    expect(draft.responsibilitiesByFamily.mosquito).toContain('Empty or report standing water (plant saucers, gutters, containers) between visits');
  });

  test('r13: agent-persisted buildingSqFt alias feeds the Building scope row', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        engineInputs: { buildingSqFt: '12000', stories: 1, lotSqFt: '30000' },
        engineResult: { lineItems: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 12, annual: 2400 }] },
      },
    });
    expect(draft.propertyScope.items[0]).toEqual({ label: 'Building', value: '12,000 sq ft' });
  });

  test('r15b: supplement scalars in ANY supported container fail the draft with direction — never silent omission', async () => {
    // Root recurring beside a result: the selected engineResult has no
    // scalar, but the root container carries a priced rodent supplement.
    const rootScalar = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        recurring: { rodentBaitMo: 15 },
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(rootScalar.programs).toBeNull();
    expect(rootScalar.warnings.join(' ')).toMatch(/rodent/i);

    // results-stats alias (rodBaitMo) — the same field estimate-public's
    // supplements reader consumes.
    const statAlias = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        results: { rodBaitMo: 15 },
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(statAlias.programs).toBeNull();
    expect(statAlias.warnings.join(' ')).toMatch(/rodent/i);
  });

  test('r15: a non-green estimatorEngine lane fails the whole draft — estimate-level review evidence gates generation', async () => {
    // Yellow-lane reasons (fallback sqft, comps drift, existing-customer)
    // are estimate-level — no line marker carries them, and a sent
    // estimate's public token is live, so generation must refuse.
    const yellow = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        estimatorEngine: { lane: 'yellow', laneReasons: ['home/building sqft from fallback source (zip_median)'] },
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(yellow.programs).toBeNull();
    expect(yellow.correctiveWork).toBeNull();
    expect(yellow.propertyScope).toBeNull();
    expect(yellow.warnings[0]).toMatch(/yellow review lane/i);
    expect(yellow.warnings[0]).toMatch(/fallback source/i);

    // A green lane generates normally.
    const green = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        estimatorEngine: { lane: 'green', laneReasons: [] },
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
      },
    });
    expect(green.programs).toHaveLength(1);
    expect(green.warnings).toEqual([]);
  });

  test('r18: one-time packages with a generic visits count derive as corrective work, never vanish as pseudo-recurring', async () => {
    // German-roach cleanout returns { price, total, visits } — the package
    // visit count is NOT an annual cadence; the charge must derive.
    const roach = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        engineResult: { lineItems: [{ service: 'german_roach', label: 'German Roach Cleanout — 3 Visit Program', price: 450, total: 450, visits: 3 }] },
      },
    });
    expect(roach.correctiveWork).toHaveLength(1);
    expect(roach.correctiveWork[0].amount).toBe(450);

    // Explicit one-time cadence wins even beside recurring-looking fields.
    const flea = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        engineResult: { lineItems: [{ service: 'flea', serviceKey: 'flea', billingCadence: 'one_time', visits: 3, total: 385 }] },
      },
    });
    expect(flea.correctiveWork).toHaveLength(1);
    expect(flea.correctiveWork[0].amount).toBe(385);
    expect(flea.programs).toBeNull();
  });

  test('r18: engineResult one-time containers beside a mapped result still derive', async () => {
    // result exists → the selected engine result is `result`; the separate
    // engineResult.oneTime container must still contribute its charge.
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 4, annualAfterDiscount: 468 }] } },
        engineResult: { oneTime: { items: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 500 }] } },
      },
    });
    expect(draft.correctiveWork).toHaveLength(1);
    expect(draft.correctiveWork[0].amount).toBe(500);
  });

  test('r17b: mapped/raw mirrors merge authoritative metadata — accepted net outranks, explicit tax propagates, disagreement fails', async () => {
    // Raw twin carries the operator-accepted net: ONE charge at $250,
    // never $550 across both rows.
    const acceptedNet = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 300 }] } },
        engineResult: { lineItems: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 300, manualFinalOneTime: 250 }] },
      },
    });
    expect(acceptedNet.correctiveWork).toHaveLength(1);
    expect(acceptedNet.correctiveWork[0].amount).toBe(250);

    // Explicit taxable:false on the raw twin beats the mapped row's family
    // default.
    const twinTax = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 300 }] } },
        engineResult: { lineItems: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 300, taxable: false }] },
      },
    });
    expect(twinTax.correctiveWork).toHaveLength(1);
    expect(twinTax.correctiveWork[0].taxable).toBe(false);

    // Mirrors that disagree with NO accepted net are ambiguous — fail the
    // draft (nullable onetime_total gives reconciliation no backstop).
    const disagree = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { items: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 300 }] } },
        engineResult: { lineItems: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 275 }] },
      },
    });
    expect(disagree.correctiveWork).toBeNull();
    expect(disagree.warnings[0]).toMatch(/disagreeing amounts/i);
  });

  test('r17: same-container rows that CANONICALIZE together fail the draft — literal-name counting hid the collision', async () => {
    // "Pest — Tower A"/"Pest — Tower B" are distinct charges whose names
    // both normalize to pest_control; the collector merges them into one
    // hybrid program, so the multiplicity detector must count by the
    // collector's own canonical identity.
    const towers = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { recurring: { services: [
          { name: 'Pest — Tower A', visitsPerYear: 4, annualAfterDiscount: 468 },
          { name: 'Pest — Tower B', visitsPerYear: 4, annualAfterDiscount: 520 },
        ] } },
      },
    });
    expect(towers.programs).toBeNull();
    expect(towers.warnings[0]).toMatch(/multiple separately priced rows/i);
  });

  test('r17: engineInputs is authoritative over stale legacy inputs for scope facts', async () => {
    // Pricing replay treats engineInputs as authoritative (rawEngineInputs)
    // — a stale legacy inputs.homeSqFt must not put the wrong building
    // size in a contractual scope row.
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        inputs: { homeSqFt: 5000 },
        engineInputs: { buildingSqFt: '12000' },
        engineResult: { lineItems: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 12, annual: 2400 }] },
      },
    });
    expect(draft.propertyScope.items[0]).toEqual({ label: 'Building', value: '12,000 sq ft' });
  });

  test('r16: an empty legacy inputs {} beside engineInputs must not hide the scope facts (union, not short-circuit)', async () => {
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        inputs: {},
        engineInputs: { buildingSqFt: '12000', stories: 3, lotSqFt: '30000' },
        engineResult: { lineItems: [{ service: 'pest_control', name: 'Pest', visitsPerYear: 12, annual: 2400 }] },
      },
    });
    expect(draft.propertyScope.items).toEqual([
      { label: 'Building', value: '12,000 sq ft · 3 stories' },
      { label: 'Lot', value: '30,000 sq ft' },
    ]);
  });

  test('r14: mapped specialty `det` scope survives into corrective-work includes', async () => {
    // Mapped rows persist customer-facing scope under the `det` alias —
    // public extraction resolves detail || det, and generation must match
    // or Generate → Save keeps the price but drops the material scope.
    const draft = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { oneTime: { specItems: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 500, det: '2 rooms · 3 visits' }] } },
      },
    });
    expect(draft.correctiveWork).toHaveLength(1);
    expect(draft.correctiveWork[0].includes).toEqual(['2 rooms · 3 visits']);
  });

  test('r14: a review marker on EITHER raw one-time clone gates the deduped row', async () => {
    // The cross-container mirror collapse keeps the FIRST clone — when only
    // the engineResult twin carries requiresMeasurement, the kept ungated
    // clone must still fail the draft, never publish the provisional price.
    const gatedTwin = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: { lineItems: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 500 }] },
        engineResult: { lineItems: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 500, requiresMeasurement: true }] },
      },
    });
    expect(gatedTwin.correctiveWork).toBeNull();
    expect(gatedTwin.warnings[0]).toMatch(/requires manual review/i);

    // Same rule when the canonical extractor's own mirror-collapse dropped
    // the marker-carrying twin (oneTime.specItems kept, root specItems
    // clone gated) — the uncollapsed clone set still gates the identity.
    const mappedTwin = await deriveProposalDraft({ category: 'COMMERCIAL',
      estimate_data: {
        result: {
          oneTime: { specItems: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 500 }] },
          specItems: [{ service: 'bed_bug', name: 'Bed Bug Treatment', price: 500, quoteRequired: true }],
        },
      },
    });
    expect(mappedTwin.correctiveWork).toBeNull();
    expect(mappedTwin.warnings[0]).toMatch(/requires manual review/i);
  });
});
