// Regressions for Codex P2s on PR #2373 (rounds 1-2):
// r1 — an engine-inputs-only pest+lawn estimate has no persisted rows and
//   deriveServiceCategory aggregates 2+ inferred services to 'bundle'; the
//   eligibility check must expand the underlying engine-input categories.
// r2a — a generated one-time add-on (e.g. pest_initial_roach) makes the
//   collected set non-empty, so the engine inputs were never consulted and an
//   out-of-scope service could hide behind an in-scope add-on; without
//   persisted recurring rows the engine-input categories must be unioned in.
// r2b — an estimate neither classifier understands (e.g. a WDO inspection)
//   must fail closed under a scoped release instead of riding
//   deriveServiceCategory's pest_control default into glass.
// r3 — a MIXED estimate (in-scope recurring pest + an unclassifiable one-time
//   service row) passed because collectServiceCategories silently drops the
//   unknown row; unclassified real service rows now fail closed, while
//   non-service rows (fees/adjustments/discounts) never block.
// r4 — edge cases of r3's non-service set: a POSITIVE one_time_adjustment is
//   the residual "Other one-time services" charge (real unclassified work →
//   blocks), manual_discount/discount-kind rows never block, engine lawn
//   specialty keys (top_dressing/dethatching/plugging) classify as lawn_care,
//   and commercial pest/lawn engine-input flags (objects — selected semantics)
//   infer their residential categories.
// r5 — legacy setup-fee rows identified only by label ("WaveGuard Setup",
//   no service key) are non-service; and the /data call site feeds the RAW
//   normalized rows unioned with the (possibly choice-aligned) bundle items,
//   because alignOneTimeChoiceBreakdown drops raw out-of-scope rows — the
//   union test here locks the semantics the call site relies on.
// r6 — recurring-capable engine flags (services.rodentBait et al.) persist no
//   one-time rows for the row check to catch, so the scope check uses a
//   dedicated inference covering EVERY selectable engine service flag:
//   in-scope pest/lawn specialty flags map strictly, out-of-scope lanes map
//   loosely (a vestigial truthy object blocks — the safe direction), and
//   deriveServiceCategory's narrow list (page copy) is untouched.
// r7 — four holes in r6's inference: the union was skipped whenever recurring
//   rows existed (rows only vouch for recurring services — a one-time engine
//   flag like services.stinging leaked in beside them, its row classifying
//   pest by name), the V2 flags were misspelled (stingingV/exclusionV), the
//   engine's snake_case termite_bait alias was missing, and legacy admin
//   estimates carrying TOP-LEVEL inputs.svc* form flags (svcWasp et al.) were
//   never scanned. Union now always runs + legacy flag lists added.
const { glassCategoryEligible, deriveServiceCategory } = require('../routes/estimate-public');

const PEST_LAWN_SCOPE = ['pest_control', 'lawn_care'];

describe('glassCategoryEligible service-category scope (GATE_ESTIMATE_GLASS_CATEGORIES)', () => {
  test('empty scope list releases every estimate', () => {
    expect(glassCategoryEligible({}, [], [], [])).toBe(true);
  });

  test('persisted recurring rows: pest+lawn bundle is in scope, pest+mosquito is not', () => {
    const pestLawn = [{ service: 'pest_control' }, { service: 'lawn_care' }];
    const pestMosquito = [{ service: 'pest_control' }, { service: 'mosquito' }];
    expect(glassCategoryEligible({}, pestLawn, [], PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible({}, pestMosquito, [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('engine-inputs-only pest+lawn bundle is in scope even though the derived category is bundle', () => {
    const estData = { engineInputs: { services: { pest: true, lawn: true } } };
    expect(deriveServiceCategory(estData, [], [])).toBe('bundle');
    expect(glassCategoryEligible(estData, [], [], PEST_LAWN_SCOPE)).toBe(true);
  });

  test('engine-inputs-only pest+mosquito stays out of scope (bundle expansion must not widen the release)', () => {
    const estData = { engineInputs: { services: { pest: true, mosquito: true } } };
    expect(glassCategoryEligible(estData, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('engine-inputs-only single lawn service is in scope, single termite is not', () => {
    const lawnOnly = { inputs: { services: { lawn: true } } };
    const termiteOnly = { inputs: { services: { termiteBait: true } } };
    expect(glassCategoryEligible(lawnOnly, [], [], PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible(termiteOnly, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r2a: an out-of-scope engine-input service cannot hide behind an in-scope one-time add-on', () => {
    const estData = { engineInputs: { services: { pest: true, mosquito: true } } };
    const roachAddOn = [{ service: 'pest_initial_roach', name: 'German Roach Clean-Out' }];
    expect(glassCategoryEligible(estData, [], roachAddOn, PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r2a: an in-scope add-on alongside in-scope engine inputs still releases', () => {
    const estData = { engineInputs: { services: { pest: true, lawn: true } } };
    const roachAddOn = [{ service: 'pest_initial_roach', name: 'German Roach Clean-Out' }];
    expect(glassCategoryEligible(estData, [], roachAddOn, PEST_LAWN_SCOPE)).toBe(true);
  });

  test('r7: engine inputs are unioned even when recurring rows exist (rd2 skip reversed)', () => {
    // rd2 treated persisted recurring rows as authoritative and skipped the
    // engine-input union; rd7 showed the leak: recurring rows only vouch for
    // the RECURRING services, so an out-of-scope one-time engine flag rode in
    // beside them. The union now always runs — an out-of-scope engine input
    // beside a recurring row withholds glass (fail closed).
    const estData = { engineInputs: { services: { pest: true, mosquito: true } } };
    expect(glassCategoryEligible(estData, [{ service: 'pest_control' }], [], PEST_LAWN_SCOPE)).toBe(false);
    // Consistent inputs (the normal case) still release.
    const consistent = { engineInputs: { services: { pest: true } } };
    expect(glassCategoryEligible(consistent, [{ service: 'pest_control' }], [], PEST_LAWN_SCOPE)).toBe(true);
  });

  test('r7: recurring pest + one-time stinging engine flag blocks despite the row name classifying pest', () => {
    // The generated Stinging Insect one-time row classifies pest_control by
    // name, so the row check alone would release it; the engine-flag union
    // must catch it even though a recurring row exists.
    const estData = { engineInputs: { services: { pest: true, stinging: true } } };
    const stingingRow = [{ service: 'stinging_insect', name: 'Stinging Insect Treatment', amount: 245 }];
    expect(glassCategoryEligible(estData, [{ service: 'pest_control' }], stingingRow, PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r7: V2 specialty flag names match the engine (stingingV2/exclusionV2, not stingingV/exclusionV)', () => {
    const stingingV2 = { engineInputs: { services: { pest: true, stingingV2: true } } };
    const exclusionV2 = { engineInputs: { services: { pest: true, exclusionV2: true } } };
    expect(glassCategoryEligible(stingingV2, [], [], PEST_LAWN_SCOPE)).toBe(false);
    expect(glassCategoryEligible(exclusionV2, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r7: snake_case termite_bait engine input blocks', () => {
    const estData = { engineInputs: { services: { pest: true, termite_bait: true } } };
    expect(glassCategoryEligible(estData, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r7: legacy TOP-LEVEL inputs.svc* out-of-scope flags block (svcWasp et al.)', () => {
    const lanes = ['svcWasp', 'svcTs', 'svcInjection', 'svcRodentBait', 'svcRodentTrap',
      'svcRodentSanitation', 'svcRodentGuarantee', 'svcTrapOnlyRetainer', 'svcExclusion',
      'svcFoam', 'svcWdo'];
    lanes.forEach((flag) => {
      const estData = { inputs: { svcPest: true, [flag]: true } };
      expect(glassCategoryEligible(estData, [], [], PEST_LAWN_SCOPE)).toBe(false);
    });
    // Standalone legacy wasp quote: the normalized row is a pest-classifying
    // label, but the legacy flag scan still withholds glass.
    const waspOnly = { inputs: { svcWasp: true } };
    const waspRow = [{ name: 'Wasp/Bee Treatment', amount: 195 }];
    expect(glassCategoryEligible(waspOnly, [], waspRow, PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r7: legacy in-scope svc* flags release with strict semantics', () => {
    const legacyPestLawn = { inputs: { svcRoach: true, svcOnetimeLawn: true } };
    const legacyBedbug = { inputs: { svcBedbug: true } };
    const legacyDeselected = { inputs: { svcFlea: false, svcWasp: false } };
    expect(glassCategoryEligible(legacyPestLawn, [], [], PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible(legacyBedbug, [], [], PEST_LAWN_SCOPE)).toBe(true);
    // false flags infer nothing → nothing classifies → fail closed.
    expect(glassCategoryEligible(legacyDeselected, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r3: an unclassified one-time service row on a mixed estimate fails closed', () => {
    const recurringPest = [{ service: 'pest_control' }];
    const wdoItem = [{ service: 'wdo_inspection', name: 'WDO Inspection' }];
    expect(glassCategoryEligible({}, recurringPest, wdoItem, PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r3: an unclassified recurring row fails closed', () => {
    expect(glassCategoryEligible({}, [{ service: 'custom_specialty_program' }], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r3: fee/adjustment/discount rows are not services and never block', () => {
    const recurringPest = [{ service: 'pest_control' }];
    const feeRows = [
      { service: 'waveguard_setup', name: 'WaveGuard Setup', amount: 99, kind: 'charge' },
      { service: 'one_time_adjustment', label: 'Other one-time services', amount: -25, kind: 'discount' },
      { service: 'rodent_bundle_discount', name: 'Bundle Discount', amount: -50 },
    ];
    expect(glassCategoryEligible({}, recurringPest, feeRows, PEST_LAWN_SCOPE)).toBe(true);
  });

  test('r4: a POSITIVE one_time_adjustment is real unclassified work and blocks', () => {
    const recurringPest = [{ service: 'pest_control' }];
    const otherCharge = [{ service: 'one_time_adjustment', label: 'Other one-time services', amount: 150, kind: 'charge' }];
    expect(glassCategoryEligible({}, recurringPest, otherCharge, PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r4: manual_discount rows never block a discounted in-scope quote', () => {
    const recurringPest = [{ service: 'pest_control' }];
    const discount = [{ service: 'manual_discount', label: 'Discount', amount: -50, kind: 'discount' }];
    expect(glassCategoryEligible({}, recurringPest, discount, PEST_LAWN_SCOPE)).toBe(true);
  });

  test('r4: engine lawn specialty rows classify as lawn_care and stay in scope', () => {
    const specialtyRows = [
      { service: 'top_dressing', name: 'Top Dressing', amount: 480 },
      { service: 'dethatching', name: 'Dethatching', amount: 320 },
      { service: 'plugging', name: 'Plugging', amount: 260 },
    ];
    expect(glassCategoryEligible({}, [], specialtyRows, PEST_LAWN_SCOPE)).toBe(true);
    expect(deriveServiceCategory({}, [], [specialtyRows[0]])).toBe('lawn_care');
  });

  test('r4: commercial pest/lawn engine inputs infer their categories (selected semantics)', () => {
    const commercialPest = { engineInputs: { services: { commercialPest: { selected: true, commercialSubtype: 'office' } } } };
    const commercialLawn = { engineInputs: { services: { commercialLawn: { selected: true } } } };
    const deselected = { engineInputs: { services: { commercialPest: { selected: false } } } };
    expect(glassCategoryEligible(commercialPest, [], [], PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible(commercialLawn, [], [], PEST_LAWN_SCOPE)).toBe(true);
    // A deselected commercial object must not read as active — nothing
    // classifies, so the scoped release fails closed.
    expect(glassCategoryEligible(deselected, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r5: legacy label-only WaveGuard setup rows are non-service and never block', () => {
    const recurringPest = [{ service: 'pest_control' }];
    const legacySetup = [{ name: 'WaveGuard Setup', amount: 99 }];
    expect(glassCategoryEligible({}, recurringPest, legacySetup, PEST_LAWN_SCOPE)).toBe(true);
  });

  test('r5: raw rows unioned with choice-aligned items still fail closed on a dropped WDO row', () => {
    // Mirrors the /data call site for show_one_time_option estimates: the
    // aligned bundle keeps only the synthetic choice + pest add-ons, but the
    // raw normalized rows (with the WDO line) ride along in the union.
    const recurringPest = [{ service: 'pest_control' }];
    const alignedOnly = [{ service: 'one_time_pest', label: 'One-Time Pest', amount: 250, kind: 'charge' }];
    const unionWithRaw = [
      ...alignedOnly,
      { service: 'wdo_inspection', name: 'WDO Inspection', amount: 175, kind: 'charge' },
    ];
    expect(glassCategoryEligible({}, recurringPest, alignedOnly, PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible({}, recurringPest, unionWithRaw, PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r6: rodent-bait engine input blocks a pest+rodent-bait estimate (the rd6 leak)', () => {
    const estData = { engineInputs: { services: { pest: true, rodentBait: true } } };
    expect(glassCategoryEligible(estData, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r6: every out-of-scope recurring-capable lane blocks, even as a vestigial truthy object', () => {
    const lanes = [
      { rodentTrapping: true }, { rodentGuarantee: true }, { trapOnlyRetainer: true },
      { exclusion: true }, { sanitation: true }, { stinging: true }, { wdo: true },
      { termiteFoam: true }, { foam: true }, { palmInjection: true },
      { rodentTrapping: { selected: false } }, // loose predicate: object presence blocks
    ];
    lanes.forEach((extra) => {
      const estData = { engineInputs: { services: { pest: true, ...extra } } };
      expect(glassCategoryEligible(estData, [], [], PEST_LAWN_SCOPE)).toBe(false);
    });
  });

  test('r6: in-scope pest/lawn specialty engine flags release (strict selected semantics)', () => {
    const bedBugPest = { engineInputs: { services: { pest: true, bedBug: true } } };
    const fleaOnly = { engineInputs: { services: { flea: true } } };
    const oneTimeLawn = { engineInputs: { services: { oneTimeLawn: true } } };
    const deselectedFlea = { engineInputs: { services: { flea: { selected: false } } } };
    expect(glassCategoryEligible(bedBugPest, [], [], PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible(fleaOnly, [], [], PEST_LAWN_SCOPE)).toBe(true);
    expect(glassCategoryEligible(oneTimeLawn, [], [], PEST_LAWN_SCOPE)).toBe(true);
    // Strict side: a deselected in-scope object infers nothing → fail closed.
    expect(glassCategoryEligible(deselectedFlea, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });

  test('r6: deriveServiceCategory (page copy) is unchanged by the scope-only inference', () => {
    const rodentBaitOnly = { engineInputs: { services: { rodentBait: true } } };
    expect(deriveServiceCategory(rodentBaitOnly, [], [])).toBe('pest_control');
  });

  test('r2b: unclassifiable estimates fail closed under a scoped release', () => {
    // e.g. a one-time WDO inspection: no engine-input mapping and the item
    // classifier returns null — the derived default would be pest_control.
    const wdoItem = [{ service: 'wdo_inspection', name: 'WDO Inspection' }];
    expect(deriveServiceCategory({}, [], wdoItem)).toBe('pest_control');
    expect(glassCategoryEligible({}, [], wdoItem, PEST_LAWN_SCOPE)).toBe(false);
    expect(glassCategoryEligible({}, [], [], PEST_LAWN_SCOPE)).toBe(false);
  });
});
