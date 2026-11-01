// Lawn protocol v13 customer copy, behind GATE_LAWN_V13 (PR 3 of 3).
// Synthetic inputs: no database.
//
// Pins: gate off no visit gets a program line (the report keeps the season note)
// and the service outline stamp is the old output; the v13 monthly program line
// is clean customer copy whose every claim the v13 visit backs; the line reaches
// a visit only when its plan resolved the staged v13 version (a visit with no
// recorded version or an older one gets no line and keeps the season note: the
// retired per-grass sentences were removed); service outlines are stamped
// lawn-v13.

const protocolsJson = require('../config/protocols.json');
const v13 = require('../config/lawn-protocol-v13.json');
const { LAWN_V13_VERSION } = require('../services/lawn-program');
const outlineService = require('../services/lawn-service-outline');
const { resolveRecordedProtocolVersion, resolveVisitRound } = require('../services/service-report/report-data');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const lineModule = require('../services/service-report/lawn-program-line');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const { LAWN_ROUND_TABLE, ROUND_STEPS, roundStart, roundEnd } = require('../services/lawn-rounds');

const { buildProgramLine, PROGRAM_LINES_V13, ROUND_PROGRAM_LINES_V13, QUALIFIERS } = lineModule;
const GRASSES = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
// The v13 recipe has no bahia track (owner 2026-10-06); the old protocols.json still does.
const V13_GRASSES = ['st_augustine', 'bermuda', 'zoysia'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const ROUNDS = Array.from({ length: 9 }, (_, i) => i + 1);

function withGate(value, fn) {
  const saved = process.env.GATE_LAWN_V13;
  try {
    if (value === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
  }
}

const visitFor = (month) => v13.st_augustine.visits.find((v) => v.month === MONTH_ABBR[month - 1]);

describe('gate off: no program line', () => {
  test('every grass and month, with or without a recorded v13 version, gets none', () => {
    withGate(undefined, () => {
      for (const grass of GRASSES) {
        for (const month of MONTHS) {
          expect(buildProgramLine({ programVisit: true, grassType: grass, month })).toBeNull();
          // A recorded v13 version changes nothing with the gate off.
          expect(buildProgramLine({ programVisit: true, grassType: grass, month, protocolVersion: LAWN_V13_VERSION })).toBeNull();
        }
      }
    });
  });

  test('protocols.json itself is unchanged by v13 (the old table still keys on the four grasses)', () => {
    expect(Object.keys(protocolsJson.lawn)).toEqual(GRASSES);
  });
});

// ── Customer program line ────────────────────────────────────────────────────
describe('v13 monthly program line', () => {
  const EVIDENCE = {
    pre_emergent: /stonewall|dimension|pre-emergent/i,
    micros: /nutra-tech/i,
    feed: /24-0-11|10-0-22|44-0-0|dimension 0\.21/i,
    fungicide: /artavia|velista|gravex/i,
    broadleaf: /celsius|dismiss/i,
    insect_spot: /arena|talak|acelepryn|dylox/i,
    insect_treatment: /tetrino/i,
    dry_spots: /dispatch/i,
    scouting_visit: /scout visit/i,
    potassium: /k-acetate|0-0-20|potassium|k2o/i,
  };
  const CONDITION_WORDS = /\bno\b|\bonly\b|\bhold\b|\bif\b|\bskip/i;
  const clausesOf = (text) => String(text).split(/[\n,;:]|\.\s|\s—\s/).map((c) => c.trim()).filter(Boolean);
  const hasQualifier = (phrase) => QUALIFIERS.some((q) => phrase.toLowerCase().includes(q));

  const BANNED_WORDS = /\b(ordinances?|counties|county|blackouts?|laws?|bans?|banned|restrict\w*|prohibit\w*)\b/i;
  const WATER_MOW = /\b(water\w*|irrigat\w*|sprinkl\w*|rain\w*|mow\w*|drought|soak\w*)/i;
  const ORDINAL = /\b(first|second|third|final|last|continu\w*|again|re-?check\w*|complet\w*|another|next|follow-?up|start\w*|begin\w*|round)\b/i;
  const BRANDS = /(prodiamine|celsius|acelepryn|tetrino|dimension|stonewall|nutra|artavia|velista|gravex|arena|talak|dylox|dismiss|certainty|dispatch|lesco|bifen|nis\b)/i;

  test('a line for every month; gate on every grass (and an unknown one) with a v13 visit gets it; gate off gives none', () => {
    expect(Object.keys(PROGRAM_LINES_V13).map(Number)).toEqual(MONTHS);
    withGate('true', () => {
      for (const grassType of [...GRASSES, null, 'unknown', 'mixed']) {
        for (const month of MONTHS) expect(buildProgramLine({ programVisit: true, grassType, month, protocolVersion: LAWN_V13_VERSION })).toBe(PROGRAM_LINES_V13[month].line);
      }
      // The Jun-Sep rule is unchanged: a visit that applied nitrogen gets no line.
      expect(buildProgramLine({ programVisit: true, grassType: 'bermuda', month: 7, nitrogenApplied: true, protocolVersion: LAWN_V13_VERSION })).toBeNull();
    });
    withGate(undefined, () => expect(buildProgramLine({ programVisit: true, grassType: 'bermuda', month: 3, protocolVersion: LAWN_V13_VERSION })).toBeNull());
  });

  test.each(MONTHS)('month %i: clean customer copy', (month) => {
    const { line } = PROGRAM_LINES_V13[month];
    expect(line).not.toMatch(BANNED_WORDS);
    expect(line).not.toMatch(WATER_MOW);
    expect(line).not.toMatch(ORDINAL);
    expect(line).not.toMatch(BRANDS);
    expect(line).not.toMatch(/\d|—|–/);
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(line).toMatch(/\.$/);
    expect(findBannedCustomerCopy(line)).toEqual([]);
    expect(validateCustomerCopy(line)).toBe(true);
  });

  // The proof both tables share: each claim's phrase is in the line, some recipe clause backs its tag, and a step that is not
  // plainly a primary line (or that any clause words as if / only / skip / no) carries a qualifier inside its own phrase.
  function expectClaimsProven({ line, claims, primary, everything }) {
    for (const [tag, phrase] of Object.entries(claims)) {
      expect(line).toContain(phrase);
      expect(EVIDENCE[tag]).toBeDefined();
      const hits = everything.filter((c) => EVIDENCE[tag].test(c));
      expect({ tag, backed: hits.length > 0 }).toEqual({ tag, backed: true });
      const plain = primary.some((c) => EVIDENCE[tag].test(c)) && !hits.some((c) => CONDITION_WORDS.test(c));
      if (!plain) expect({ tag, phrase, qualified: hasQualifier(phrase) }).toEqual({ tag, phrase, qualified: true });
    }
  }

  test.each(MONTHS)('month %i: every claim is in the line and backed by the v13 visit; conditional steps are qualified', (month) => {
    const { line, claims } = PROGRAM_LINES_V13[month];
    const visit = visitFor(month);
    const primary = clausesOf(visit.primary);
    const everything = [...primary, ...clausesOf(visit.secondary), ...clausesOf(visit.notes)];
    expectClaimsProven({ line, claims, primary, everything });
  });

  // ── 9-visit rounds: the line follows the visit's ROUND (owner 2026-10-31 scope) ──
  // Real months a round window covers (a non-leap program year: Feb 29 only lengthens round 2).
  const windowMonths = (round) => {
    const months = new Set();
    for (let day = roundStart(2027, round); day <= roundEnd(2027, round); day = nextDay(day)) months.add(Number(day.slice(5, 7)));
    return [...months];
  };
  const nextDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  // The round's step lines: ROUND_STEPS month plus its variant (cadence9 = April's 9-visit bag, rounds = February's round 3 rate).
  const stepOf = (round) => {
    const { month, variant } = ROUND_STEPS[round];
    const visit = visitFor(month);
    const swap = variant === 'cadence9' ? visit.cadenceVariants['9'] : variant === 'rounds' ? visit.roundVariants.lawn_rounds_9 : null;
    return { primary: clausesOf(swap?.primary ?? visit.primary), notes: clausesOf(swap?.notes ?? visit.notes) };
  };

  test('a line for every round, in the same order as the round table; windows and steps are the ones the claims are proven against', () => {
    expect(Object.keys(ROUND_PROGRAM_LINES_V13).map(Number)).toEqual(ROUNDS);
    expect(LAWN_ROUND_TABLE.map((r) => r.round)).toEqual(ROUNDS);
    expect(windowMonths(1)).toEqual([12, 1, 2]);
    expect(windowMonths(3)).toEqual([3, 4]);
    expect(windowMonths(9)).toEqual([11, 12]);
  });

  test.each(ROUNDS)('round %i: clean customer copy (every rule the month lines keep)', (round) => {
    const { line } = ROUND_PROGRAM_LINES_V13[round];
    expect(line).not.toMatch(BANNED_WORDS);
    expect(line).not.toMatch(WATER_MOW);
    expect(line).not.toMatch(ORDINAL);
    expect(line).not.toMatch(BRANDS);
    expect(line).not.toMatch(/\d|—|–/);
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(line).toMatch(/\.$/);
    expect(findBannedCustomerCopy(line)).toEqual([]);
    expect(validateCustomerCopy(line)).toBe(true);
  });

  test.each(ROUNDS)('round %i: every claim is in the line and backed by the round\'s step or the spot rows of its real months; conditional steps are qualified', (round) => {
    const { line, claims } = ROUND_PROGRAM_LINES_V13[round];
    const step = stepOf(round);
    const spots = windowMonths(round).flatMap((month) => clausesOf(visitFor(month).secondary));
    expectClaimsProven({ line, claims, primary: step.primary, everything: [...step.primary, ...step.notes, ...spots] });
  });

  test('potassium is claimed by exactly the two summer feedings, and every claim tag has recipe evidence', () => {
    const tags = new Set(Object.values(ROUND_PROGRAM_LINES_V13).flatMap((entry) => Object.keys(entry.claims)));
    for (const tag of tags) expect(EVIDENCE[tag]).toBeDefined();
    expect(ROUNDS.filter((r) => 'potassium' in ROUND_PROGRAM_LINES_V13[r].claims)).toEqual([6, 7]);
  });

  test('gate on: a round picks the round line whatever the calendar month; no round keeps the month line; every gate still applies', () => {
    withGate('true', () => {
      const visit = { programVisit: true, protocolVersion: LAWN_V13_VERSION };
      for (const round of ROUNDS) {
        for (const month of MONTHS) {
          expect(buildProgramLine({ ...visit, month, round })).toBe(ROUND_PROGRAM_LINES_V13[round].line);
        }
        expect(buildProgramLine({ ...visit, month: 10, round: null })).toBe(PROGRAM_LINES_V13[10].line);
      }
      // A round that is not 1-9 falls back to the month line (never an undefined line).
      for (const round of [0, 10, 2.5, '2', 'toString', undefined]) expect(buildProgramLine({ ...visit, month: 3, round })).toBe(PROGRAM_LINES_V13[3].line);
      // The month is still required, and the Jun-Sep nitrogen rule still reads it (round 4 spans Jun 1-2, round 5 starts Jun 3).
      expect(buildProgramLine({ ...visit, month: null, round: 3 })).toBeNull();
      expect(buildProgramLine({ ...visit, month: 6, round: 4, nitrogenApplied: true })).toBeNull();
      expect(buildProgramLine({ ...visit, month: 6, round: 4, nitrogenApplied: false })).toBe(ROUND_PROGRAM_LINES_V13[4].line);
      expect(buildProgramLine({ ...visit, month: 3, round: 3, nitrogenApplied: true })).toBe(ROUND_PROGRAM_LINES_V13[3].line);
      // Not a plan visit, or not the v13 version: no round line either.
      expect(buildProgramLine({ ...visit, month: 3, round: 3, programVisit: false })).toBeNull();
      expect(buildProgramLine({ ...visit, month: 3, round: 3, protocolVersion: '2026.06' })).toBeNull();
    });
    withGate(undefined, () => expect(buildProgramLine({ programVisit: true, month: 3, round: 3, protocolVersion: LAWN_V13_VERSION })).toBeNull());
  });
});

describe('v13 program line follows the protocol version the visit\'s plan resolved', () => {
  const OLD_VERSION = '2026.06';
  test('gate on: only a visit that resolved v13 gets v13 copy; no recorded version or an older one gets none', () => {
    withGate('true', () => {
      const input = { programVisit: true, grassType: 'bermuda', month: 10 };
      expect(buildProgramLine({ ...input, protocolVersion: LAWN_V13_VERSION })).toBe(PROGRAM_LINES_V13[10].line);
      // Historical or unattributed (no ledger row, no scheduled pin): never rewritten with v13.
      expect(buildProgramLine(input)).toBeNull();
      expect(buildProgramLine({ ...input, protocolVersion: null })).toBeNull();
      expect(buildProgramLine({ ...input, protocolVersion: OLD_VERSION })).toBeNull();
    });
  });

  test('gate off: no line whatever the recorded version', () => {
    withGate(undefined, () => {
      for (const protocolVersion of [null, OLD_VERSION, LAWN_V13_VERSION]) {
        expect(buildProgramLine({ programVisit: true, grassType: 'bermuda', month: 10, protocolVersion })).toBeNull();
      }
    });
  });

  test('buildLawnReportV2 passes the recorded version through to the season note', () => {
    const assessment = {
      assessmentDate: '2026-10-14',
      scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'shoulder' },
      overwateringSignal: false, droughtStress: 'minor', turfProfile: { grassType: 'bermuda' }, observations: 'Synthetic observation.',
      waterContext: { rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 1.25, irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 } },
      trend: [{ date: '2026-10-14', overallScore: 68, turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, season: 'shoulder' }],
    };
    const saved = process.env.GATE_LAWN_EXPECTATIONS;
    process.env.GATE_LAWN_EXPECTATIONS = 'true';
    try {
      const snapshot = (protocolVersion) => withGate('true', () => buildLawnReportV2({ lawnAssessment: assessment, programVisit: true, ...(protocolVersion ? { protocolVersion } : {}) }).snapshot);
      expect(snapshot(LAWN_V13_VERSION).seasonalNote).toBe(PROGRAM_LINES_V13[10].line);
      expect(snapshot(LAWN_V13_VERSION).seasonalNoteSource).toBe('program');
      // No recorded version or an older one: the old season note, unmarked.
      for (const protocolVersion of [null, '2026.06']) {
        expect(snapshot(protocolVersion).seasonalNote).toMatch(/transitional stretch/);
        expect(snapshot(protocolVersion)).not.toHaveProperty('seasonalNoteSource');
      }
    } finally {
      if (saved === undefined) delete process.env.GATE_LAWN_EXPECTATIONS; else process.env.GATE_LAWN_EXPECTATIONS = saved;
    }
  });
});

describe('service outline protocol stamp', () => {
  test('gate off stamps lawn-v4; the v13 program stamps lawn-v13', () => {
    expect(withGate(undefined, () => outlineService.protocolVersion())).toBe('lawn-v4');
    expect(withGate('true', () => outlineService.protocolVersion())).toBe('lawn-v13');
    expect(outlineService.PROTOCOL_VERSION).toBeUndefined();
  });
});

describe('the protocol version a completed visit recorded (resolveRecordedProtocolVersion)', () => {
  // A table-keyed fake: first() resolves the table's row; every table read is logged.
  function fakeKnex(rows, reads = []) {
    const knex = (table) => ({
      where: () => ({ first: async () => { reads.push(table); if (rows[table] instanceof Error) throw rows[table]; return rows[table]; } }),
    });
    knex.reads = reads;
    return knex;
  }
  const service = { id: 'rec-1', scheduled_service_id: 'ss-1' };

  test('a completion row names its version; the scheduled pin is never read', async () => {
    const knex = fakeKnex({ lawn_protocol_service_completions: { protocol_version: LAWN_V13_VERSION }, scheduled_services: { lawn_protocol_version: '2026.06' } });
    expect(await resolveRecordedProtocolVersion(knex, service)).toBe(LAWN_V13_VERSION);
    expect(knex.reads).toEqual(['lawn_protocol_service_completions']);
  });

  test('a completion row with no version (attribution none) is authoritative: no version, whatever the visit was pinned to', async () => {
    const knex = fakeKnex({ lawn_protocol_service_completions: { protocol_version: null }, scheduled_services: { lawn_protocol_version: LAWN_V13_VERSION } });
    expect(await resolveRecordedProtocolVersion(knex, service)).toBeNull();
    expect(knex.reads).toEqual(['lawn_protocol_service_completions']);
    // ... and the visit it feeds gets no program line.
    withGate('true', () => expect(buildProgramLine({ programVisit: true, grassType: 'bermuda', month: 10, protocolVersion: null })).toBeNull());
  });

  test('no completion row at all: the scheduled visit\'s pin, else nothing', async () => {
    expect(await resolveRecordedProtocolVersion(fakeKnex({ scheduled_services: { lawn_protocol_version: LAWN_V13_VERSION } }), service)).toBe(LAWN_V13_VERSION);
    expect(await resolveRecordedProtocolVersion(fakeKnex({ scheduled_services: { lawn_protocol_version: null } }), service)).toBeNull();
    expect(await resolveRecordedProtocolVersion(fakeKnex({}), service)).toBeNull();
    const knex = fakeKnex({ scheduled_services: { lawn_protocol_version: LAWN_V13_VERSION } });
    expect(await resolveRecordedProtocolVersion(knex, { id: 'rec-2' })).toBeNull();
    expect(knex.reads).toEqual(['lawn_protocol_service_completions']);
  });

  test('a failed read throws (the report build then drops the program line)', async () => {
    await expect(resolveRecordedProtocolVersion(fakeKnex({ lawn_protocol_service_completions: new Error('connection lost') }), service)).rejects.toThrow('connection lost');
  });
});

describe('the round a completed visit sits in (resolveVisitRound, the report caller)', () => {
  function fakeKnex(rows, reads = []) {
    const knex = (table) => ({
      where: () => ({ first: async (...cols) => { reads.push({ table, cols }); if (rows[table] instanceof Error) throw rows[table]; return rows[table]; } }),
    });
    knex.reads = reads;
    return knex;
  }
  const service = { id: 'rec-1', scheduled_service_id: 'ss-1' };
  const roundOf = (row) => resolveVisitRound(fakeKnex({ scheduled_services: row }), service);

  test('only a lawn_rounds_9 row has a round: the round holding its own scheduled date, not the calendar month\'s step', async () => {
    expect(await roundOf({ recurring_pattern: 'lawn_rounds_9', scheduled_date: '2026-03-05' })).toBe(2);
    expect(await roundOf({ recurring_pattern: 'lawn_rounds_9', scheduled_date: '2026-03-20' })).toBe(3);
    expect(await roundOf({ recurring_pattern: 'lawn_rounds_9', scheduled_date: new Date('2026-12-28T00:00:00Z') })).toBe(1);
    expect(await roundOf({ recurring_pattern: 'lawn_rounds_9', scheduled_date: '2026-11-09' })).toBe(8);
  });

  test('a 12-visit, legacy 9-visit, one-time or unlinked visit has none; the row read asks for two columns only', async () => {
    for (const pattern of ['monthly', 'every_6_weeks', 'bimonthly', null, undefined]) {
      expect(await roundOf({ recurring_pattern: pattern, scheduled_date: '2026-03-05' })).toBeNull();
    }
    expect(await roundOf(undefined)).toBeNull();
    expect(await roundOf({ recurring_pattern: 'lawn_rounds_9', scheduled_date: 'not a date' })).toBeNull();
    const knex = fakeKnex({});
    expect(await resolveVisitRound(knex, { id: 'rec-2' })).toBeNull();
    expect(knex.reads).toEqual([]);
    const read = fakeKnex({ scheduled_services: { recurring_pattern: 'monthly', scheduled_date: '2026-03-05' } });
    await resolveVisitRound(read, service);
    expect(read.reads).toEqual([{ table: 'scheduled_services', cols: ['recurring_pattern', 'scheduled_date'] }]);
  });

  test('a failed read throws (the report build then drops the program line, as for the recorded version)', async () => {
    await expect(resolveVisitRound(fakeKnex({ scheduled_services: new Error('connection lost') }), service)).rejects.toThrow('connection lost');
  });
});

describe('the service outline bullets with GATE_LAWN_V13 on name treatment categories, never products or rates', () => {
  const recipeNames = (() => {
    const names = new Set();
    for (const visit of v13.st_augustine.visits) {
      for (const line of `${visit.primary}\n${visit.secondary}`.split('\n')) if (line.includes(' — ')) names.add(line.split(' — ')[0]);
    }
    return [...names];
  })();
  const ALLOWED = ['Lawn inspection', 'Pre-emergent weed control with fertilizer', 'Pre-emergent weed control', 'Micronutrients', 'Fertilizer and nutrition', 'Insect control', 'Disease control', 'Weed spot treatment', 'Wetting agent'];

  test('every month of every grass: only category bullets, no product name, number or rate', () => {
    withGate('true', () => {
      for (const grass of V13_GRASSES) {
        for (const visit of v13[grass].visits) {
          const bullets = outlineService.customerProtocolBullets(visit);
          expect({ grass, month: visit.month, any: bullets.length > 0 }).toEqual({ grass, month: visit.month, any: true });
          for (const bullet of bullets) {
            expect(ALLOWED.some((label) => bullet.startsWith(`${label} may be relevant`))).toBe(true);
            for (const name of recipeNames) expect(bullet.toLowerCase()).not.toContain(name.toLowerCase().split(' ')[0] === 'lesco' ? name.toLowerCase() : name.toLowerCase().split(' ')[0]);
            expect(bullet).not.toMatch(/\d|fl oz|per 1,?000|lb\b|—/i);
          }
        }
      }
    });
  });

  test('October and May read as the categories the recipe applies (Dimension 18-0-10 and its spots; Tetrino)', () => {
    withGate('true', () => {
      const oct = outlineService.customerProtocolBullets(v13.bermuda.visits.find((v) => v.month === 'Oct')).map((b) => b.split(' may be')[0]);
      expect(oct).toEqual(expect.arrayContaining(['Pre-emergent weed control with fertilizer', 'Disease control', 'Insect control', 'Weed spot treatment']));
      const may = outlineService.customerProtocolBullets(v13.bermuda.visits.find((v) => v.month === 'May')).map((b) => b.split(' may be')[0]);
      expect(may).toEqual(expect.arrayContaining(['Insect control', 'Weed spot treatment']));
    });
  });

  test('gate off: the legacy bullets from the raw protocol lines, unchanged', () => {
    withGate(undefined, () => {
      const visit = protocolsJson.lawn.bermuda.visits[0];
      const bullets = outlineService.customerProtocolBullets(visit);
      expect(bullets.length).toBeGreaterThan(0);
      expect(bullets.every((b) => b.endsWith(' may be relevant when turf condition, weather, label directions, and local rules allow.'))).toBe(true);
      expect(bullets[0]).toContain(String(visit.primary).split('\n')[0].replace(/\([^)]*\$[^)]*\)/g, '').replace(/\s+/g, ' ').trim());
    });
  });
});
