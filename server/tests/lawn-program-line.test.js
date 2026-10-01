// Lawn monthly program line (lawn report rebuild P9, GATE_LAWN_EXPECTATIONS).
// Synthetic payloads only.
//
// Pins: every protocols.json grass x 12 months returns a string; every string is
// clean customer copy (no ordinance / county / blackout / law wording, no
// product or brand name, no clock time, no watering / rain / mowing words);
// every claim is backed by the protocols.json visit for that grass and month AND
// by its conditions: a step the protocol skips, gates, makes optional or limits
// to some plans is only ever stated with a qualifier (conditions are derived
// from protocols.json in this file, not hand-listed);
// Jun-Sep returns null when the visit applied nitrogen (analysis_n > 0); gate
// off leaves the payload byte-identical.

const protocols = require('../config/protocols.json');
const {
  buildProgramLine, PROGRAM_LINES, DEFAULT_LINES, NO_NITROGEN_MONTHS, QUALIFIERS,
} = require('../services/service-report/lawn-program-line');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const GRASSES = Object.keys(protocols.lawn);
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

const BANNED_WORDS = /\b(ordinances?|counties|county|blackouts?|laws?|bans?|banned|restrict\w*|prohibit\w*)\b/i;
const WATER_MOW = /\b(water\w*|irrigat\w*|sprinkl\w*|rain\w*|mow\w*|drought|soak\w*)/i;
const CLOCK_TIME = /\b\d{1,2}(:\d{2})?\s?(a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b|\bo['’]clock\b|\b(noon|midnight)\b/i;
const DIGITS = /\d/;
// Brand / product names that appear in protocols.json and the product catalog.
const BRANDS = /(prodiamine|celsius|acelepryn|speedzone|k-?flow|primo|maxx|dismiss|sedgehammer|headway|medallion|torque|armada|velista|atrazine|three-?way|lesco|carbonpro|hydretain|talstar|talak|arena|dylox|topchoice|anuew|t-?storm|bifen|moisture manager|dispatch|green flo|kmag|polyplus|nis\b)/i;

const monthOf = (visit) => MONTH_ABBR.indexOf(String(visit.month).slice(0, 3)) + 1;
const visitFor = (grass, month) => protocols.lawn[grass].visits.find((v) => monthOf(v) === month);
const visitText = (visit) => [visit.primary, visit.secondary, visit.notes].join('\n');

// ── Deriving each claim's conditions from protocols.json itself ──────────────
// A claim names one protocol step (a tag). The test finds every protocols.json
// segment that mentions that step: the visit's primary and secondary lines, its
// notes sentences, and the grass-level notes and site rules that apply to that
// month (a grass-level sentence naming other months, or other visit numbers, is
// left out). A step is conditional unless it appears plainly in the visit and no
// segment about it carries condition wording (if / only / skip / gated /
// optional / soil-test / irrigated / weather / premium and plan-tier words /
// on request ...). Nothing here is a hand list of which months are conditional:
// a protocols.json edit that adds a skip or an only-if flips the derived status
// and fails the line until it is qualified.
const EVIDENCE = {
  pre_emergent: /prodiamine/i,
  feed: /LESCO 24-\d+-\d+|\bN app\b|\bfert\b/i,
  micros: /micros|chelated|iron plus|\bFe\b|High Mn|Mn Combo/i,
  biostimulant: /carbonpro|biostimulant/i,
  potassium: /K-Flow|0-0-\d+|Phyte|KMAG|soil-test branching/i,
  broadleaf: /celsius|speedzone|atrazine|three-way|broadleaf/i,
  insect_prevention: /acelepryn/i,
  fungicide: /fungicide|torque|headway|armada|medallion|velista|t-storm|\bSDS prevent/i,
  growth_regulator: /primo maxx|\bPGR\b/i,
  chinch_check: /chinch (float test|re-check|scout|baseline)|float test/i,
  armyworm_check: /armyworm (soap flush|re-check|peak)|soap flush.*armyworm|fall armyworm check/i,
  mole_cricket_check: /mole cricket.*(scout|soap flush|flush|tunnel)|soap flush|re-flush/i,
  mole_cricket_treat: /dylox/i,
  webworm_check: /webworm (scout|check|peak scout)/i,
  large_patch_watch: /large patch scout|large patch diagnostic|large patch watch/i,
  scouting_visit: /drive-by|disease\/irrigation scout|condition scout/i,
  crabgrass_watch: /crabgrass check|crabgrass breakthrough/i,
  thatch_check: /thatch (measurement|assessment)/i,
  sds_review: /SDS (damage assessment|circles)/i,
  green_up_watch: /green-up monitoring|early green-up/i,
  winter_touchpoint: /wellness|touchpoint/i,
  dormancy_talk: /dormancy|dormant/i,
  seed_heads: /seed head/i,
  late_green_up: /greens up (late|later|slowly)/i,
  thin_turf: /open\/thin/i,
  mole_cricket_primary: /primary insect threat/i,
  webworm_primary: /primary insect/i,
  mole_flight: /flight/i,
  mole_damage_signs: /spongy/i,
  large_patch_prep: /pre-position for oct large patch/i,
};
EVIDENCE.insect_check = new RegExp([EVIDENCE.chinch_check, EVIDENCE.armyworm_check, EVIDENCE.mole_cricket_check, EVIDENCE.webworm_check].map((r) => r.source).join('|'), 'i');
// Checks, scouting and plain facts are not skipped when a treatment they lead
// to is conditional, so they may also be shown by a plain secondary / notes line.
const OBSERVATION_TAGS = new Set(['chinch_check', 'armyworm_check', 'mole_cricket_check', 'webworm_check', 'large_patch_watch',
  'scouting_visit', 'crabgrass_watch', 'thatch_check', 'sds_review', 'green_up_watch', 'dormancy_talk', 'seed_heads',
  'late_green_up', 'thin_turf', 'mole_cricket_primary', 'webworm_primary', 'mole_flight', 'mole_damage_signs',
  'large_patch_prep', 'insect_check']);

// Facts the protocol states about the grass as a whole, true in every month.
const TALK_TAGS = new Set(['seed_heads', 'dormancy_talk']);
const GRASS_WIDE_FACTS = new Set(['mole_cricket_primary']);

const CONDITION_WORDS = /\bif\b|\bonly\b|\boptional\b|\bconditional\b|gated|\bskip|\bdefer|\bhold\b|\bnon-irrigated\b|\birrigated\b|\bsoil[- ]test|\bsoil [KP]\b|\bP index\b|\bP ≥|\bwhen\b|\bunless\b|\bmaxed\b|\bmaximum\b|\bcap\b|on request|requested|\bweather\b/i;
// Plan-tier words limit a step to some plans ("Premium only", "Premium:", "Enh/Prem only",
// "PGR Premium ($...)", "for Premium"). "ALL TIERS", "Basic/Std get ..." and history in
// "(was Premium-only)" do not restrict anything.
const TIER_WORDS = /\b(?:premium|enh\/prem|basic\/std)(?: only\b|:| \(\$)|\bfor premium\b/i;
const EVERY_TIER = /\ball[- ]tiers?\b/i;
const isConditional = (raw) => {
  const text = raw.replace(/\(was [^)]*\)/gi, '');
  return CONDITION_WORDS.test(text) || (!EVERY_TIER.test(text) && TIER_WORDS.test(text));
};
const TIER_ONLY = /^(Enh\/Prem|Premium|Basic\/Std)( only)?\.?$/i;
const MONTH_WORD = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const monthIndex = (word) => MONTH_ABBR.indexOf(word.slice(0, 3)) + 1;

const clauses = (text) => String(text || '').split(/(?<=[.!?;])\s+|\s*[★⚠]\s*/).map((c) => c.trim()).filter(Boolean);
// A line "A — B" is two clauses, but B inherits any condition wording in A
// ("OPTIONAL TALK — SEED HEADS"): `cond` is the text a clause is judged on.
function lineSegments(where, line) {
  const out = [];
  let prefix = '';
  for (const part of String(line).split(/\s+—\s+/)) {
    for (const text of clauses(part)) out.push({ where, text, cond: `${prefix} ${text}`.trim() });
    prefix = `${prefix} ${part}`.trim();
  }
  return out;
}

// Months a grass-level sentence names (ranges like "Mar-Oct" expand) and visit
// numbers it names; none named = it applies to every month.
function scopeOf(sentence) {
  const months = new Set();
  for (const m of sentence.matchAll(new RegExp(`\\b(${MONTH_WORD})\\s*[-–]\\s*(${MONTH_WORD})\\b`, 'g'))) {
    for (let i = monthIndex(m[1]); ; i = (i % 12) + 1) { months.add(i); if (i === monthIndex(m[2])) break; }
  }
  for (const m of sentence.matchAll(new RegExp(`\\b${MONTH_WORD}\\b`, 'g'))) months.add(monthIndex(m[0]));
  const visits = new Set([...sentence.matchAll(/\bV(\d{1,2})\b/g)].map((m) => Number(m[1])));
  return { months, visits };
}

function segmentsFor(grass, visit) {
  const g = protocols.lawn[grass];
  const month = monthOf(visit);
  const segs = [];
  for (const line of visit.primary.split('\n')) segs.push(...lineSegments('P', line));
  for (const line of visit.secondary.split('\n')) segs.push(...lineSegments('S', line));
  const merged = [];
  for (const sentence of clauses(visit.notes)) {
    if (TIER_ONLY.test(sentence) && merged.length) merged[merged.length - 1] += ` ${sentence}`; else merged.push(sentence);
  }
  merged.forEach((text) => segs.push({ where: 'N', text, cond: text }));
  const grassLevel = [...(g.notes || []), ...Object.values(g.site_condition_rules || {})];
  for (const note of grassLevel) {
    for (const text of clauses(note)) {
      const { months, visits } = scopeOf(text);
      const applies = (!months.size && !visits.size) || months.has(month) || visits.has(visit.visit);
      if (applies) segs.push({ where: 'G', text, cond: text });
    }
  }
  return segs;
}

// null = the visit never mentions the step; 'plain' or 'conditional' otherwise.
function derivedDetail(grass, month, tag) {
  const visit = visitFor(grass, month);
  const hits = segmentsFor(grass, visit).filter((seg) => EVIDENCE[tag].test(seg.text));
  if (!hits.some((seg) => seg.where !== 'G' || GRASS_WIDE_FACTS.has(tag))) return { status: null, because: [] };
  const marked = hits.filter((seg) => isConditional(seg.cond));
  // A customer talk the visit lists as OPTIONAL stays optional on its continuation lines.
  if (TALK_TAGS.has(tag) && /\boptional\b/i.test(visitText(visit))) return { status: 'conditional', because: ['visit lists the customer talk as OPTIONAL'] };
  const shownPlainly = hits.some((seg) => !isConditional(seg.cond)
    && (seg.where === 'P' || (OBSERVATION_TAGS.has(tag) && (seg.where !== 'G' || GRASS_WIDE_FACTS.has(tag)))));
  return {
    status: shownPlainly && !marked.length ? 'plain' : 'conditional',
    because: marked.length ? marked.map((seg) => `${seg.where}: ${seg.text}`) : ['no plain primary line'],
  };
}
const derivedStatus = (grass, month, tag) => derivedDetail(grass, month, tag).status;

describe('program line table covers protocols.json', () => {
  test('the four protocol grasses carry 12 months and a line for each', () => {
    expect(GRASSES.sort()).toEqual(['bahia', 'bermuda', 'st_augustine', 'zoysia']);
    for (const grass of GRASSES) {
      expect(Object.keys(PROGRAM_LINES[grass]).map(Number).sort((a, b) => a - b)).toEqual(MONTHS);
      expect(protocols.lawn[grass].visits.map(monthOf).sort((a, b) => a - b)).toEqual(MONTHS);
    }
    expect(Object.keys(DEFAULT_LINES).map(Number).sort((a, b) => a - b)).toEqual(MONTHS);
  });

  test.each(GRASSES)('%s x 12 months returns the table string', (grass) => {
    for (const month of MONTHS) {
      const line = buildProgramLine({ grassType: grass, month });
      expect(typeof line).toBe('string');
      expect(line).toBe(PROGRAM_LINES[grass][month].line);
    }
  });

  test('grass spelling is forgiving; unknown / mixed / null grass takes the generic line', () => {
    expect(buildProgramLine({ grassType: 'St. Augustine'.replace('. ', '_').toLowerCase(), month: 1 })).toBe(PROGRAM_LINES.st_augustine[1].line);
    expect(buildProgramLine({ grassType: 'Bermuda', month: 3 })).toBe(PROGRAM_LINES.bermuda[3].line);
    for (const grassType of [null, undefined, '', 'unknown', 'centipede', 'mixed', 'st_augustine/bermuda']) {
      for (const month of MONTHS) expect(buildProgramLine({ grassType, month })).toBe(DEFAULT_LINES[month].line);
    }
  });

  test('no valid month is a deliberate null', () => {
    for (const month of [null, undefined, 0, 13, 1.5, 'x', NaN]) {
      expect(buildProgramLine({ grassType: 'bermuda', month })).toBeNull();
    }
    expect(buildProgramLine()).toBeNull();
  });
});

describe('every string is clean customer copy', () => {
  const all = [
    ...GRASSES.flatMap((grass) => MONTHS.map((month) => [`${grass} ${month}`, PROGRAM_LINES[grass][month].line])),
    ...MONTHS.map((month) => [`default ${month}`, DEFAULT_LINES[month].line]),
  ];

  test.each(all)('%s', (_label, line) => {
    expect(line).not.toMatch(BANNED_WORDS);
    expect(line).not.toMatch(WATER_MOW);
    expect(line).not.toMatch(CLOCK_TIME);
    expect(line).not.toMatch(DIGITS);
    expect(line).not.toMatch(BRANDS);
    expect(line).not.toMatch(/\bWaves Pest Control & Lawn/i);
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(30);
    expect(line.length).toBeGreaterThan(30);
    expect(line).toMatch(/[.]$/);
    expect(line).not.toMatch(/—|–/);
    expect(findBannedCustomerCopy(line)).toEqual([]);
    expect(validateCustomerCopy(line)).toBe(true);
  });

  test('the banned-copy check itself catches what it should', () => {
    expect(BANNED_WORDS.test('the county fertilizer ordinance')).toBe(true);
    expect(BANNED_WORDS.test('summer blackout')).toBe(true);
    expect(BANNED_WORDS.test('state law')).toBe(true);
    expect(BANNED_WORDS.test('a healthy lawn')).toBe(false);
    expect(BRANDS.test('Celsius WG')).toBe(true);
    expect(CLOCK_TIME.test('after 3 PM')).toBe(true);
  });
});

const QUALIFIER_LIST = QUALIFIERS;
const hasQualifier = (phrase) => QUALIFIER_LIST.some((q) => phrase.toLowerCase().includes(q));
const clausesOf = (entry) => Object.entries(entry.claims);

describe('every claim is backed by protocols.json, conditions included', () => {
  const rows = [];
  for (const grass of GRASSES) for (const month of MONTHS) rows.push([`${grass} ${month}`, grass, month, PROGRAM_LINES[grass][month]]);

  test.each(rows)('%s: present in the visit, conditional steps carry a qualifier in their own phrase', (_label, grass, month, entry) => {
    expect(clausesOf(entry).length).toBeGreaterThan(0);
    for (const [tag, phrase] of clausesOf(entry)) {
      expect(EVIDENCE[tag]).toBeDefined();
      expect(entry.line).toContain(phrase);
      const status = derivedStatus(grass, month, tag);
      expect({ tag, status: status === null ? 'absent from protocol visit' : 'ok' }).toEqual({ tag, status: 'ok' });
      if (status === 'conditional') expect({ tag, phrase, because: derivedDetail(grass, month, tag).because, qualified: hasQualifier(phrase) }).toEqual({ tag, phrase, because: derivedDetail(grass, month, tag).because, qualified: true });
    }
  });

  test.each(MONTHS)('generic line, month %i: every claim holds in all four programs; conditional in any means qualified', (month) => {
    for (const [tag, phrase] of clausesOf(DEFAULT_LINES[month])) {
      expect(DEFAULT_LINES[month].line).toContain(phrase);
      let conditionalSomewhere = false;
      for (const grass of GRASSES) {
        const status = derivedStatus(grass, month, tag);
        expect({ grass, tag, present: status !== null }).toEqual({ grass, tag, present: true });
        if (status === 'conditional') conditionalSomewhere = true;
      }
      if (conditionalSomewhere) expect({ tag, phrase, qualified: hasQualifier(phrase) }).toEqual({ tag, phrase, qualified: true });
    }
  });

  test('no untagged claims: text outside the claim phrases is only connecting words', () => {
    const GLUE = new Set(['a', 'adds', 'and', 'april', 'august', 'continues', 'december', 'february', 'focuses', 'in', 'is',
      'january', 'july', 'june', 'march', 'may', 'month', 'november', 'october', 'on', 'plus', 'program', 'scouting',
      'september', 'the', 'with', 'zoysia']);
    const entries = [...rows.map((row) => row[3]), ...MONTHS.map((m) => DEFAULT_LINES[m])];
    for (const entry of entries) {
      let rest = entry.line;
      for (const phrase of [...new Set(Object.values(entry.claims))].sort((a, b) => b.length - a.length)) rest = rest.split(phrase).join(' ');
      const stray = rest.toLowerCase().replace(/[^a-z’' -]/g, ' ').split(/\s+/).filter(Boolean).filter((w) => !GLUE.has(w));
      expect({ line: entry.line, stray }).toEqual({ line: entry.line, stray: [] });
    }
  });

  test('the derivation really sees the conditions the audit found', () => {
    // Bahia potassium is skipped on non-irrigated properties (Jun, Sep); the soil-test skip rides every K-Flow month.
    for (const month of [4, 5, 6, 9]) expect(derivedStatus('bahia', month, 'potassium')).toBe('conditional');
    for (const grass of ['st_augustine', 'bermuda', 'zoysia']) for (const month of [4, 6, 9]) expect(derivedStatus(grass, month, 'potassium')).toBe('conditional');
    // Premium-only, optional and request-only steps
    expect(derivedStatus('st_augustine', 12, 'winter_touchpoint')).toBe('conditional');
    expect(derivedStatus('st_augustine', 2, 'feed')).toBe('conditional');
    expect(derivedStatus('bahia', 10, 'fungicide')).toBe('conditional');
    // Unconditional program steps stay plain
    expect(derivedStatus('st_augustine', 1, 'pre_emergent')).toBe('plain');
    expect(derivedStatus('zoysia', 10, 'fungicide')).toBe('plain');
    expect(derivedStatus('bermuda', 11, 'fungicide')).toBe('plain');
  });

  test('a protocols.json edit that adds a condition flips the derived status (so the line fails until qualified)', () => {
    const visit = visitFor('bermuda', 10);
    const original = visit.primary;
    try {
      expect(derivedStatus('bermuda', 10, 'fungicide')).toBe('plain');
      visit.primary = `${original}\n★ IF soil test is clean: SKIP Armada`;
      expect(derivedStatus('bermuda', 10, 'fungicide')).toBe('conditional');
      visit.primary = original.replace('★ Armada 50 WDG SDS preventive ($12.41)', '★ Armada 50 WDG SDS preventive Premium only ($12.41)');
      expect(derivedStatus('bermuda', 10, 'fungicide')).toBe('conditional');
    } finally {
      visit.primary = original;
    }
    expect(derivedStatus('bermuda', 10, 'fungicide')).toBe('plain');
  });

  test('qualifiers are neutral wording: no water, tier, count or product word', () => {
    for (const q of QUALIFIER_LIST) {
      expect(q).not.toMatch(WATER_MOW);
      expect(q).not.toMatch(BRANDS);
      expect(q).not.toMatch(DIGITS);
      expect(q).not.toMatch(/\b(basic|standard|enhanced|premium|bronze|silver|gold|platinum|tier|visits?)\b/i);
    }
  });

  test('Jun-Sep lines never describe a nitrogen feeding (the program applies none)', () => {
    for (const month of NO_NITROGEN_MONTHS) {
      for (const grass of GRASSES) expect(Object.keys(PROGRAM_LINES[grass][month].claims)).not.toContain('feed');
      expect(Object.keys(DEFAULT_LINES[month].claims)).not.toContain('feed');
    }
    for (const grass of GRASSES) for (const month of [6, 7, 8, 9]) {
      expect(visitText(visitFor(grass, month))).not.toMatch(/LESCO 24-/);
    }
  });
});

describe('Jun-Sep with nitrogen applied is a deliberate null', () => {
  const nApp = { product: { name: 'Synthetic Fertilizer 24-0-11', analysis_n: 24 } };
  const kApp = { product: { name: 'Synthetic Potassium 0-0-25', analysis_n: 0 } };

  test.each([6, 7, 8, 9])('month %i: analysis_n > 0 -> null, analysis_n 0 or none -> line', (month) => {
    for (const grassType of [...GRASSES, null]) {
      expect(buildProgramLine({ grassType, month, applications: [nApp] })).toBeNull();
      expect(buildProgramLine({ grassType, month, applications: [kApp, nApp] })).toBeNull();
      expect(typeof buildProgramLine({ grassType, month, applications: [kApp] })).toBe('string');
      expect(typeof buildProgramLine({ grassType, month, applications: [] })).toBe('string');
    }
  });

  test('either report shape and a fertilizer-analysis name count as nitrogen', () => {
    expect(buildProgramLine({ grassType: 'bermuda', month: 7, applications: [{ analysis_n: '16' }] })).toBeNull();
    expect(buildProgramLine({ grassType: 'bermuda', month: 7, applications: [{ product: { name: 'Synthetic 24-0-11' } }] })).toBeNull();
    expect(buildProgramLine({ grassType: 'bermuda', month: 7, applications: [{ product: { name: 'Synthetic 0-0-25' } }] })).toEqual(expect.any(String));
  });

  test('the caller-supplied catalog answer wins over the shapes', () => {
    expect(buildProgramLine({ grassType: 'bermuda', month: 7, applications: [kApp], nitrogenApplied: true })).toBeNull();
    expect(buildProgramLine({ grassType: 'bermuda', month: 7, applications: [nApp], nitrogenApplied: false })).toEqual(expect.any(String));
  });

  test('other months do not care about nitrogen', () => {
    for (const month of [1, 2, 3, 4, 5, 10, 11, 12]) {
      expect(typeof buildProgramLine({ grassType: 'st_augustine', month, applications: [nApp] })).toBe('string');
    }
  });
});

// ── gate wiring in buildLawnReportV2 ────────────────────────────────────────
const GATE = 'GATE_LAWN_EXPECTATIONS';
function withGate(value, fn) {
  const previous = process.env[GATE];
  if (value === undefined) delete process.env[GATE]; else process.env[GATE] = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env[GATE]; else process.env[GATE] = previous;
  }
}

function assessment(overrides = {}) {
  return {
    assessmentDate: '2026-10-14',
    scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'shoulder' },
    overwateringSignal: false,
    droughtStress: 'minor',
    turfProfile: { grassType: 'st_augustine' },
    observations: 'Synthetic observation.',
    waterContext: {
      rainfallInches7d: 0.9, irrigationInchesPerWeek: 0.7, effectiveInches7d: 1.6, targetInchesPerWeek: 1.25,
      irrigationAdvice: { status: 'balanced', rainKnown: true, profileMissing: false, recommendedInchesPerWeek: 1.25 },
    },
    trend: [
      { date: '2026-04-15', overallScore: 60, turfDensity: 60, weedSuppression: 70, colorHealth: 65, stressDamage: 40, season: 'shoulder' },
      { date: '2026-10-14', overallScore: 68, turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, season: 'shoulder' },
    ],
    ...overrides,
  };
}

describe('buildLawnReportV2 and GATE_LAWN_EXPECTATIONS', () => {
  const OLD_SHOULDER = /transitional stretch/;

  test('gate off (unset or any non-true) is byte-identical: old note, no new key', () => {
    const baseline = withGate(undefined, () => buildLawnReportV2({ lawnAssessment: assessment() }));
    for (const value of ['', 'false', '0', 'off']) {
      const off = withGate(value, () => buildLawnReportV2({ lawnAssessment: assessment() }));
      expect(JSON.stringify(off)).toBe(JSON.stringify(baseline));
    }
    expect(baseline.snapshot.seasonalNote).toMatch(OLD_SHOULDER);
    expect(baseline.snapshot).not.toHaveProperty('seasonalNoteSource');
    expect(baseline).not.toHaveProperty('seasonalNote');
  });

  test('gate on: snapshot.seasonalNote is the program line from the visit month, marked as program', () => {
    const on = withGate('true', () => buildLawnReportV2({ lawnAssessment: assessment() }));
    expect(on.snapshot.seasonalNote).toBe(PROGRAM_LINES.st_augustine[10].line);
    expect(on.snapshot.seasonalNoteSource).toBe('program');
    expect(on).not.toHaveProperty('seasonalNote');
    // Only the season note differs from the gate-off payload.
    const off = withGate(undefined, () => buildLawnReportV2({ lawnAssessment: assessment() }));
    const strip = (v) => { const c = JSON.parse(JSON.stringify(v)); delete c.snapshot.seasonalNote; delete c.snapshot.seasonalNoteSource; return c; };
    // smsSummary and the rest are derived from other snapshot fields
    expect(strip(on)).toEqual(strip(off));
  });

  test('the month is the noon-UTC visit month, grass from the turf profile', () => {
    const month = (date, grassType) => withGate('true', () => buildLawnReportV2({
      lawnAssessment: assessment({ assessmentDate: date, turfProfile: { grassType } }),
    }).snapshot.seasonalNote);
    expect(month('2026-01-31', 'bermuda')).toBe(PROGRAM_LINES.bermuda[1].line);
    expect(month('2026-02-01', 'zoysia')).toBe(PROGRAM_LINES.zoysia[2].line);
    expect(month('2026-12-01', 'bahia')).toBe(PROGRAM_LINES.bahia[12].line);
    expect(month('2026-03-10', 'weird')).toBe(DEFAULT_LINES[3].line);
  });

  test('null line (Jun-Sep nitrogen, or no assessment date) falls back to the old note, unmarked', () => {
    const june = (extra) => withGate('true', () => buildLawnReportV2({
      lawnAssessment: assessment({ assessmentDate: '2026-06-18', scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, fungusControl: 95, overallScore: 68, season: 'peak' } }),
      ...extra,
    }));
    const withN = june({ nitrogenApplied: true });
    expect(withN.snapshot.seasonalNote).toMatch(/peak heat-and-pest/);
    expect(withN.snapshot).not.toHaveProperty('seasonalNoteSource');
    const noN = june({ nitrogenApplied: false });
    expect(noN.snapshot.seasonalNote).toBe(PROGRAM_LINES.st_augustine[6].line);
    const byName = june({ applications: [{ product: { name: 'Synthetic 24-0-11' } }] });
    expect(byName.snapshot).not.toHaveProperty('seasonalNoteSource');

    const noDate = withGate('true', () => buildLawnReportV2({ lawnAssessment: assessment({ assessmentDate: null }) }));
    expect(noDate.snapshot.seasonalNote).toMatch(OLD_SHOULDER);
    expect(noDate.snapshot).not.toHaveProperty('seasonalNoteSource');
  });

  test('the gate reader is exported on its own line and reads at call time', () => {
    const gates = require('../config/feature-gates');
    expect(withGate('true', () => gates.lawnExpectationsLive())).toBe(true);
    expect(withGate('1', () => gates.lawnExpectationsLive())).toBe(true);
    expect(withGate(undefined, () => gates.lawnExpectationsLive())).toBe(false);
    expect(withGate('false', () => gates.lawnExpectationsLive())).toBe(false);
  });
});

describe('resolveNitrogenApplied (the report-data caller)', () => {
  const { resolveNitrogenApplied } = require('../services/service-report/lawn-program-line');
  const rowsFor = (rows) => async () => rows;
  test('a failed product load counts as nitrogen applied, with no catalog read', async () => {
    const load = jest.fn();
    await expect(resolveNitrogenApplied({ applications: [], productsLoadFailed: true, loadCatalogRows: load })).resolves.toBe(true);
    expect(load).not.toHaveBeenCalled();
  });
  test('a failed catalog read counts as nitrogen applied', async () => {
    const apps = [{ product: { name: 'Celsius WG', catalogId: 'c1' } }];
    await expect(resolveNitrogenApplied({ applications: apps, loadCatalogRows: async () => { throw new Error('db'); } })).resolves.toBe(true);
  });
  test('a catalog analysis_n above zero counts', async () => {
    const apps = [{ product: { name: 'Lawn Feed', catalogId: 'c1' } }];
    await expect(resolveNitrogenApplied({ applications: apps, loadCatalogRows: rowsFor([{ id: 'c1', analysis_n: 16 }]) })).resolves.toBe(true);
  });
  test('an unresolved product named like a fertilizer analysis still counts (no catalogId)', async () => {
    const apps = [{ product: { name: 'Granular 24-0-11' } }];
    await expect(resolveNitrogenApplied({ applications: apps, loadCatalogRows: rowsFor([]) })).resolves.toBe(true);
  });
  test('a catalog-resolved product with no row still falls back to its name', async () => {
    const apps = [{ product: { name: 'Granular 24-0-11', catalogId: 'missing' } }];
    await expect(resolveNitrogenApplied({ applications: apps, loadCatalogRows: rowsFor([]) })).resolves.toBe(true);
  });
  test('no nitrogen evidence anywhere is a confirmed negative', async () => {
    const apps = [{ product: { name: 'Celsius WG', catalogId: 'c1' } }];
    await expect(resolveNitrogenApplied({ applications: apps, loadCatalogRows: rowsFor([{ id: 'c1', analysis_n: 0 }]) })).resolves.toBe(false);
  });
});
