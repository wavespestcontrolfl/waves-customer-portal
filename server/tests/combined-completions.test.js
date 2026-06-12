/**
 * Combined service completions (combined-service-completions.md): companion
 * typed sections riding a primary completion. Pure-function coverage for
 * serializeProfile's fail-safe companion_types parsing and the
 * companion-completions validator (the PROFILE authorizes types, never the
 * client payload; every per-type rule reuses the typed machinery).
 */
const {
  serializeProfile,
  DEFAULT_SERVICE_REPORT_PROFILE,
} = require('../services/service-completion-profiles');
const {
  validateCompanionSubmission,
} = require('../services/service-report/companion-completions');

// Realistic registry values (project-types.js options, verbatim).
const TERMITE_STATION_VALUES = {
  total_stations: '14',
  stations_checked: '14',
  termite_activity: 'None observed',
  bait_consumption: 'None — bait intact',
  station_actions: 'Re-secured',
  conducive_conditions: 'Mulch against foundation',
};

const RODENT_STATION_VALUES = {
  stations_checked: '8',
  bait_consumption: 'Moderate',
  bait_replaced: 'Yes',
  evidence_observed: 'Droppings, Rub marks',
};

const FLEA_CLEARED_VALUES = {
  evidence_level: 'None observed',
  treatment_completed: 'Exterior flea treatment',
  customer_prep: 'Vacuum daily for 2 weeks',
};

function profileWith(companions, extra = {}) {
  return { findingsType: null, companions, ...extra };
}

describe('serializeProfile companion parsing', () => {
  test('valid companion entries pass through with their delivery', () => {
    const profile = serializeProfile({
      service_key: 'pest_termite_combo',
      completion_mode: 'service_report',
      project_type: null,
      active: true,
      companion_types: [
        { type: 'termite_bait_station', delivery: 'auto_send' },
        { type: 'rodent_bait_station', delivery: 'internal_only' },
      ],
    });
    expect(profile.companions).toEqual([
      { type: 'termite_bait_station', delivery: 'auto_send' },
      { type: 'rodent_bait_station', delivery: 'internal_only' },
    ]);
  });

  test('unknown typed findings types are dropped', () => {
    const profile = serializeProfile({
      service_key: 'k',
      completion_mode: 'service_report',
      active: true,
      companion_types: [
        { type: 'not_a_registered_type', delivery: 'auto_send' },
        { type: 'termite_bait_station', delivery: 'auto_send' },
      ],
    });
    expect(profile.companions).toEqual([
      { type: 'termite_bait_station', delivery: 'auto_send' },
    ]);
  });

  test('missing or invalid delivery coerces to internal_only (never accidentally customer-facing)', () => {
    const profile = serializeProfile({
      service_key: 'k',
      completion_mode: 'service_report',
      active: true,
      companion_types: [
        { type: 'termite_bait_station' },
        { type: 'rodent_bait_station', delivery: 'send_everything' },
      ],
    });
    expect(profile.companions).toEqual([
      { type: 'termite_bait_station', delivery: 'internal_only' },
      { type: 'rodent_bait_station', delivery: 'internal_only' },
    ]);
  });

  test('disabled entries are dropped at serialization', () => {
    const profile = serializeProfile({
      service_key: 'k',
      completion_mode: 'service_report',
      active: true,
      companion_types: [{ type: 'termite_bait_station', delivery: 'disabled' }],
    });
    expect(profile.companions).toEqual([]);
  });

  test("entries duplicating the profile's own findingsType are dropped", () => {
    const profile = serializeProfile({
      service_key: 'termite_bait',
      completion_mode: 'service_report',
      project_type: 'termite_bait_station',
      active: true,
      companion_types: [
        { type: 'termite_bait_station', delivery: 'auto_send' },
        { type: 'rodent_bait_station', delivery: 'auto_send' },
      ],
    });
    expect(profile.findingsType).toBe('termite_bait_station');
    expect(profile.companions).toEqual([
      { type: 'rodent_bait_station', delivery: 'auto_send' },
    ]);
  });

  test('non-array / garbage companion_types degrade to []', () => {
    for (const garbage of [42, 'not json {', { type: 'termite_bait_station' }, true]) {
      const profile = serializeProfile({
        service_key: 'k',
        completion_mode: 'service_report',
        active: true,
        companion_types: garbage,
      });
      expect(profile.companions).toEqual([]);
    }
    // Non-object array members are skipped, valid siblings survive.
    const mixed = serializeProfile({
      service_key: 'k',
      completion_mode: 'service_report',
      active: true,
      companion_types: [null, 'x', ['nested'], { delivery: 'auto_send' }, { type: 'rodent_bait_station', delivery: 'auto_send' }],
    });
    expect(mixed.companions).toEqual([
      { type: 'rodent_bait_station', delivery: 'auto_send' },
    ]);
  });

  test('jsonb delivered as a JSON string still parses (and bad JSON degrades to [])', () => {
    const ok = serializeProfile({
      service_key: 'k',
      completion_mode: 'service_report',
      active: true,
      companion_types: JSON.stringify([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
    });
    expect(ok.companions).toEqual([
      { type: 'termite_bait_station', delivery: 'auto_send' },
    ]);
  });

  test('default profile and both early-return branches emit companions: []', () => {
    expect(DEFAULT_SERVICE_REPORT_PROFILE.companions).toEqual([]);
    expect(serializeProfile(null).companions).toEqual([]);
    // WDO fail-closed coercion branch resets every behavior field — no
    // companion sections survive a flagged-bad row.
    const coerced = serializeProfile({
      service_key: 'wdo_inspection',
      completion_mode: 'service_report',
      project_type: 'wdo_inspection',
      active: true,
      companion_types: [{ type: 'termite_bait_station', delivery: 'auto_send' }],
    });
    expect(coerced.completionMode).toBe('special_project');
    expect(coerced.companions).toEqual([]);
  });
});

describe('validateCompanionSubmission — authorization & shape', () => {
  test('submitted type outside the profile is a 409 companion_type_mismatch (profile is authoritative)', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: [{ type: 'rodent_bait_station', values: RODENT_STATION_VALUES }],
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('companion_type_mismatch');
    expect(result.body.companionType).toBe('rodent_bait_station');
  });

  test('a profile with no companions rejects any submitted entry', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([]),
      companionFindings: [{ type: 'termite_bait_station', values: TERMITE_STATION_VALUES }],
    });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('companion_type_mismatch');
  });

  test('missing declared companion is a 422 companion_findings_required naming the type', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([
        { type: 'termite_bait_station', delivery: 'auto_send' },
        { type: 'rodent_bait_station', delivery: 'internal_only' },
      ]),
      companionFindings: [{
        type: 'termite_bait_station',
        values: TERMITE_STATION_VALUES,
        nextStepChips: ['Continue scheduled monitoring'],
      }],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('companion_findings_required');
    expect(result.body.missingTypes).toEqual(['rodent_bait_station']);
  });

  test('null companionFindings with declared companions is the same 422', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: null,
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('companion_findings_required');
    expect(result.body.missingTypes).toEqual(['termite_bait_station']);
  });

  test('duplicate submitted types are a 400', () => {
    const entry = {
      type: 'termite_bait_station',
      values: TERMITE_STATION_VALUES,
      nextStepChips: ['Continue scheduled monitoring'],
    };
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: [entry, { ...entry }],
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('companion_duplicate_type');
  });

  test('non-array companionFindings and typeless entries are 400 shape errors', () => {
    const notArray = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: { type: 'termite_bait_station' },
    });
    expect(notArray.status).toBe(400);
    expect(notArray.body.code).toBe('companion_findings_invalid');
    const typeless = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: [{ values: TERMITE_STATION_VALUES }],
    });
    expect(typeless.status).toBe(400);
    expect(typeless.body.code).toBe('companion_findings_invalid');
  });
});

describe('validateCompanionSubmission — per-type validation pass-through', () => {
  test('missing required fields surface as 422 companion_findings_invalid with companionType', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: [{
        type: 'termite_bait_station',
        // stations_checked / termite_activity / bait_consumption all absent.
        values: { total_stations: '14' },
        nextStepChips: ['Continue scheduled monitoring'],
      }],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('companion_findings_invalid');
    expect(result.body.companionType).toBe('termite_bait_station');
    expect(result.body.missing).toEqual(
      expect.arrayContaining(['stations_checked', 'termite_activity', 'bait_consumption']),
    );
  });

  test('cross-field registry errors keep the 400 shape with details', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: [{
        type: 'termite_bait_station',
        // "None observed" beside heavy feeding — registry contradiction.
        values: { ...TERMITE_STATION_VALUES, bait_consumption: 'Heavy feeding' },
        nextStepChips: ['Continue scheduled monitoring'],
      }],
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('companion_findings_invalid');
    expect(result.body.details.length).toBeGreaterThan(0);
  });

  test('off-list chips are a 400 companion_next_step_chips_invalid', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: [{
        type: 'termite_bait_station',
        values: TERMITE_STATION_VALUES,
        nextStepChips: ['Water the lawn weekly'],
      }],
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('companion_next_step_chips_invalid');
    expect(result.body.companionType).toBe('termite_bait_station');
  });

  test('chips that contradict the values are rejected through validateNextStepChips', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'flea', delivery: 'auto_send' }]),
      companionFindings: [{
        type: 'flea',
        values: {
          evidence_level: 'Light',
          activity_areas: 'Interior',
          treatment_completed: 'Interior flea treatment',
          customer_prep: 'Vacuum daily for 2 weeks',
        },
        // "No action needed" beside confirmed flea evidence — value-aware
        // chip rule from the shared validator.
        nextStepChips: ['No action needed'],
      }],
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('companion_next_step_chips_invalid');
    expect(result.body.companionType).toBe('flea');
  });

  test('next-step-required types 422 without a chip', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: [{
        type: 'termite_bait_station',
        values: TERMITE_STATION_VALUES,
        nextStepChips: [],
      }],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('companion_next_step_required');
    expect(result.body.companionType).toBe('termite_bait_station');
  });

  test('banned customer copy in free-text values is rejected', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: [{
        type: 'termite_bait_station',
        values: {
          ...TERMITE_STATION_VALUES,
          termite_activity: 'Active termites present',
          activity_signs: 'Live termites in station',
          bait_consumption: 'Heavy feeding',
          active_station_location: 'Station 7 — colony eliminated',
        },
        nextStepChips: ['Recheck active station sooner'],
      }],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('companion_findings_banned_copy');
    expect(result.body.violations).toContain('eliminated');
  });
});

describe('validateCompanionSubmission — activity scores', () => {
  test('trend type with neither pin nor derivable score is a 422 companion_activity_score_required', () => {
    // rodent_trapping has an indicator but derive: null — tech-set only.
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'rodent_trapping', delivery: 'internal_only' }]),
      companionFindings: [{
        type: 'rodent_trapping',
        values: { species: 'Roof rat' },
        nextStepChips: ['Continue trapping'],
      }],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('companion_activity_score_required');
    expect(result.body.companionType).toBe('rodent_trapping');
  });

  test('out-of-range or non-integer score is a 400', () => {
    for (const bad of [6, -1, 2.5, '3']) {
      const result = validateCompanionSubmission({
        profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
        companionFindings: [{
          type: 'termite_bait_station',
          values: TERMITE_STATION_VALUES,
          nextStepChips: ['Continue scheduled monitoring'],
          activityScore: bad,
        }],
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('companion_activity_score_invalid');
    }
  });

  test('pinned score crossing the cleared boundary is 422 activity_score_inconsistent + companionType', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'flea', delivery: 'auto_send' }]),
      companionFindings: [{
        type: 'flea',
        values: FLEA_CLEARED_VALUES,
        nextStepChips: ['Monitor activity'],
        activityScore: 3,
        activityScoreSource: 'technician',
      }],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('activity_score_inconsistent');
    expect(result.body.companionType).toBe('flea');
  });
});

describe('validateCompanionSubmission — indicator uniqueness', () => {
  test('companion sharing the PRIMARY typed indicator is a 422 companion_indicator_conflict', () => {
    // termite_bait_station shares the termite_activity trend with itself —
    // the primary already owns that indicator on this completion.
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: [{
        type: 'termite_bait_station',
        values: TERMITE_STATION_VALUES,
        nextStepChips: ['Continue scheduled monitoring'],
      }],
      primaryFindingsType: 'termite_bait_station',
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('companion_indicator_conflict');
    expect(result.body.companionType).toBe('termite_bait_station');
  });

  test('two companions sharing an indicator key conflict with each other', () => {
    // Declared twice (the parse layer doesn't dedupe — the validator is the
    // backstop for the composite unique on service_activity_scores).
    const result = validateCompanionSubmission({
      profile: profileWith([
        { type: 'rodent_bait_station', delivery: 'internal_only' },
        { type: 'rodent_bait_station', delivery: 'internal_only' },
      ]),
      companionFindings: [{
        type: 'rodent_bait_station',
        values: RODENT_STATION_VALUES,
        nextStepChips: ['Monitor activity'],
      }],
    });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('companion_indicator_conflict');
    expect(result.body.companionType).toBe('rodent_bait_station');
  });

  test('a recurring primary (no findingsType) never collides', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'termite_bait_station', delivery: 'auto_send' }]),
      companionFindings: [{
        type: 'termite_bait_station',
        values: TERMITE_STATION_VALUES,
        nextStepChips: ['Continue scheduled monitoring'],
      }],
      primaryFindingsType: null,
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateCompanionSubmission — happy path', () => {
  test('returns normalized companions in declared order with resolved scores', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([
        { type: 'termite_bait_station', delivery: 'auto_send' },
        { type: 'rodent_bait_station', delivery: 'internal_only' },
      ]),
      // Submitted out of declared order — output re-orders to the profile.
      companionFindings: [
        {
          type: 'rodent_bait_station',
          values: RODENT_STATION_VALUES,
          nextStepChips: ['Recheck high-consumption station', 'Monitor activity'],
          activityScore: 4,
          activityScoreSource: 'technician',
        },
        {
          type: 'termite_bait_station',
          values: TERMITE_STATION_VALUES,
          nextStepChips: ['Continue scheduled monitoring'],
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.companions.map((c) => c.type)).toEqual([
      'termite_bait_station', 'rodent_bait_station',
    ]);
    const [termite, rodent] = result.companions;
    // No pin + derivable: termite_activity "None observed" derives 0.
    expect(termite.activityScore).toBe(0);
    expect(termite.activityScoreSource).toBe('derived');
    expect(termite.chips).toEqual(['Continue scheduled monitoring']);
    // Pinned away from the derived value (Moderate → 3) stays technician.
    expect(rodent.activityScore).toBe(4);
    expect(rodent.activityScoreSource).toBe('technician');
    expect(rodent.values).toEqual(RODENT_STATION_VALUES);
  });

  test('a pin equal to the derived value with source "derived" stays derived', () => {
    const result = validateCompanionSubmission({
      profile: profileWith([{ type: 'rodent_bait_station', delivery: 'auto_send' }]),
      companionFindings: [{
        type: 'rodent_bait_station',
        values: RODENT_STATION_VALUES,
        nextStepChips: ['Monitor activity'],
        activityScore: 3,
        activityScoreSource: 'derived',
      }],
    });
    expect(result.ok).toBe(true);
    expect(result.companions[0].activityScoreSource).toBe('derived');
  });
});
