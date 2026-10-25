// GATE_SPECIALTY_REPORT_VOICE (owner 2026-10-24, "yes build voice"): under the
// writer rules the termite, cockroach, rodent and mosquito writers get one
// prompt in the pest report's voice in place of their stacked blocks. Off, and
// for every other writer, the prompt is byte-identical.
const fs = require('fs');
const path = require('path');
const { selectReportCopyPrompt, specialtyVoiceServes } = require('../services/service-report/lawn-report-copy-prompt');
const {
  SPECIALTY_REPORT_VOICE_PROMPT, SPECIALTY_REPORT_VOICE_VERSION, SPECIALTY_VOICE_EXAMPLES, SPECIALTY_VOICE_MODULES,
  specialtyReportVoicePrompt,
} = require('../services/service-report/specialty-report-voice');
const { REMAINING_SERVICE_MODULES } = require('../services/service-report/remaining-service-copy-prompts');
const {
  OWNER_RULES, groundedTimeframePhrases, noteAbsenceHint, writerRulesRejection,
} = require('../services/service-report/report-writer-rules');
const { SERVICE_EXPECTATIONS, writerExpectations } = require('../services/service-report/report-writer-records');
const { technicianReportCustomerCopy } = require('../services/service-report/technician-report-copy');
const { activityLevelContradictions, deriveActivityScore } = require('../services/service-report/activity-indicators');
const { HUMAN_PROSE_RULES } = require('../services/llm/human-prose-rules');

// The real v4 hard constraints, sliced from the route source, as report-writer-rules.test.js does.
const scheduleSource = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
const v4Start = scheduleSource.indexOf('## HARD CONSTRAINTS');
const v4End = scheduleSource.indexOf('## ANTI-TEMPLATE RULES', v4Start);
const V4_SHARED = `# SERVICE REPORT COPY — SYSTEM PROMPT v4\n${scheduleSource.slice(v4Start, v4End).replace(/\$\{[^}]*\}/g, 'X')}## ANTI-TEMPLATE RULES\nOld examples.`;

const RESERVICE_LINE = 'THIS VISIT IS A RE-SERVICE. Follow A RE-SERVICE above.';
const IN_SCOPE = [
  ['termite_bait', 'termite_bait_station'],
  ['termite_monitoring', 'termite_bait_station'],
  ['termite_liquid', 'termite_treatment'],
  ['foam_drill', 'termite_treatment'],
  ['bora_care', null],
  ['cockroach_control', 'cockroach'],
  ['pest_initial_german_knockdown', 'german_roach_knockdown'],
  ['rodent_bait', 'rodent_bait_station'],
  ['rodent_trapping', 'rodent_trapping'],
  ['rodent_exclusion', 'rodent_exclusion'],
  ['rodent_sanitation_standard', 'rodent_sanitation'],
  ['rodent_trapping_exclusion_sanitation', 'rodent_trapping'],
  ['mosquito_monthly', null],
  ['mosquito_event', 'mosquito_event'],
];

describe('which writer gets the one-voice specialty prompt', () => {
  test.each(IN_SCOPE)('%s, under the writer rules', (serviceKey, findingsType) => {
    const context = { serviceKey, findingsType, serviceModel: 'one_time', writerRules: true, specialtyVoice: true };
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', context)).toBe(SPECIALTY_REPORT_VOICE_PROMPT);
    expect(specialtyVoiceServes(context)).toBe(true);
  });

  test('a callback is named at the end, as the callback modifier was', () => {
    const prompt = selectReportCopyPrompt(V4_SHARED, 'Old label', {
      serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping', isCallback: true, writerRules: true, specialtyVoice: true,
    });
    expect(prompt).toBe(specialtyReportVoicePrompt({ reservice: true }));
    expect(prompt.endsWith(RESERVICE_LINE)).toBe(true);
    expect(prompt).not.toContain('CROSS-SERVICE MODIFIER');
  });

  test.each(IN_SCOPE)('off, %s keeps the stacked writer byte for byte', (serviceKey, findingsType) => {
    const context = { serviceKey, findingsType, serviceModel: 'one_time', writerRules: true };
    const before = selectReportCopyPrompt(V4_SHARED, 'Old label', context);
    expect(before).toContain(OWNER_RULES);
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, specialtyVoice: false })).toBe(before);
    expect(specialtyVoiceServes({ ...context, specialtyVoice: false })).toBe(false);
  });

  test('without the writer rules the flag changes nothing', () => {
    const context = { serviceKey: 'termite_bait', findingsType: 'termite_bait_station' };
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, specialtyVoice: true }))
      .toBe(selectReportCopyPrompt(V4_SHARED, 'Old label', context));
    expect(specialtyVoiceServes({ ...context, specialtyVoice: true })).toBe(false);
  });

  test.each([
    ['flea_tick', 'flea'],
    ['bed_bug_treatment', null],
    ['tick_control', null],
    ['bee_wasp_removal', null],
    ['fire_ant', null],
    ['area_addon_web_sweep', null],
    ['pest_inspection', 'pest_inspection'],
    ['termite_inspection', 'termite_inspection'],
    ['rodent_inspection', 'rodent_inspection'],
    ['dethatching', null],
    ['palm_injection', 'palm_injection'],
    ['pest_general_quarterly', null],
    ['lawn_care_6week', null],
  ])('%s keeps its own writer with the flag on', (serviceKey, findingsType) => {
    const context = { serviceKey, findingsType, writerRules: true };
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, specialtyVoice: true }))
      .toBe(selectReportCopyPrompt(V4_SHARED, 'Old label', context));
    expect(specialtyVoiceServes({ ...context, specialtyVoice: true })).toBe(false);
  });

  test('a findings form that does not match the service gets no writer either way', () => {
    const context = { serviceKey: 'termite_bait', findingsType: 'cockroach', writerRules: true, specialtyVoice: true };
    expect(specialtyVoiceServes(context)).toBe(false);
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', context)).toBeNull();
  });

  test('every module the voice serves is a remaining-service module', () => {
    for (const key of SPECIALTY_VOICE_MODULES) expect(Object.keys(REMAINING_SERVICE_MODULES)).toContain(key);
  });
});

describe('the one-voice specialty prompt', () => {
  test('carries its version, the owner prose rules and every word the report refuses', () => {
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain(`# ${SPECIALTY_REPORT_VOICE_VERSION}`);
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain(HUMAN_PROSE_RULES);
    for (const word of ['infestation', 'infested', 'eliminated', 'elimination', 'eradicated', 'eradication', 'exterminated', 'resolved', 'solved', 'gone', 'cleared', 'pest-free', 'impenetrable', 'total protection', 'foolproof', 'guaranteed', '100%', '"safe"', 'non-toxic', 'chemical', 'per visit', 'EPA', 'bond']) {
      expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain(word);
    }
  });

  test('bans the military language the v4 hard constraints banned', () => {
    for (const word of ['mission', 'tactical', 'deployment', 'fortification', 'fortress', 'sentries', 'invaders', 'infiltration', 'neutralize', 'annihilation', 'defensive perimeter', 'chemical barrier', 'vectors', 'recon', 'staging', 'advancement', 'threat', 'lockdown', 'intercept']) {
      expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain(word);
    }
  });

  // GATE_PEST_QUIET_VISIT's two rules: a quiet visit opens on what we saw, and no talk is claimed.
  test('a quiet visit opens on what we saw, and no talk is claimed', () => {
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain('- Never say we talked with, spoke with or met the customer unless the note says so, and never say what the customer did not mention, report or ask about.');
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain('When the customer told us nothing, start with what we saw today or with where we worked, never with what they did not say.');
  });

  // The stacked modules' core distinctions, which no output screen can check.
  test('keeps each count, each kind of work and each finding apart', () => {
    for (const phrase of [
      '"Captures at 2 traps" is not "2 rats caught"',
      'stations on the property, stations checked, stations with activity, traps set, traps checked and captures are different numbers',
      'Feeding at a station is feeding, never a destroyed colony or a protected home.',
      'a treated section is not the whole house',
      'an unknown species stays "roaches"',
      'on a setup visit we "set" traps, and no captures yet is not a result',
      'a gap we found is not proof a rodent used it',
      'standing water is a condition, not proof of larvae',
      'never say how many visits it has, which one this is, or that it is the last, unless the inputs say so',
      'keep each service\'s work, findings and counts apart',
      'is what the work aimed at, not a sighting',
    ]) expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain(phrase);
  });

  test('the activity level keeps the inputs\' own word', () => {
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain('The activity level goes in the words the inputs use ("heavy", "moderate", "light"), never a softer or a stronger word.');
  });

  test('a re-service never blames the customer, waves off the activity or clears the earlier visit', () => {
    for (const phrase of ['Never blame the customer', 'never wave off the activity they reported as normal after treatment', 'never insist the earlier visit could not have played a part', 'never invent a change to sound responsive', 'keep what is still unresolved']) {
      expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain(phrase);
    }
  });

  test('the no-EXPECTATIONS sentence comes from the server SERVICE TYPE record, never the Service Type input', () => {
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain('one sentence from the SERVICE TYPE record');
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain('never the Service Type input');
  });

  test('the REACH-OUT DATE sentence names the pest and the date and nothing else', () => {
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain('With a REACH-OUT DATE, that sentence names the pest and the date and nothing else, no place and no "come back"');
  });

  test('never asks the customer to watch or handle what only we tend', () => {
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain('Never ask the customer to watch something only we track, like a station, a trap or a capture count, and never tell them to open, move, touch, empty or handle a station, a trap or bait.');
  });

  // noteAbsenceHint tells the writer to follow "OWNER RULES rule 4" under the note.
  test('rule 4 is still the absence rule the note hint names', () => {
    expect(noteAbsenceHint('Customer says no issues inside')).toContain('OWNER RULES rule 4');
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toMatch(/\nOWNER RULES \(the report is refused if it breaks one\)\n(?:.*\n){3}4\. An absence only for a named place/);
  });

  test('has one example for each service', () => {
    expect(SPECIALTY_VOICE_EXAMPLES).toHaveLength(4);
    expect(SPECIALTY_VOICE_EXAMPLES.map((example) => example.visit.split('.')[0]))
      .toEqual(['Termite bait station check', 'Cockroach treatment', 'Rodent trapping, setup visit', 'Mosquito visit']);
  });

  // Each example's EXPECTATIONS are lines the writer really gets for that work.
  test('every example EXPECTATIONS line is a line the writer gets', () => {
    const roach = writerExpectations({
      line: 'pest',
      findingsType: 'cockroach',
      applications: [
        { name: 'Gentrol IGR', method: 'crack_crevice', applicationArea: 'Kitchen' },
        { name: 'Advion Cockroach Gel Bait', method: 'bait_placement', applicationArea: 'Kitchen' },
      ],
    }).lines;
    const mosquito = writerExpectations({ line: 'mosquito', applications: [{ name: 'Leaf spray', method: 'foliar_spray' }] }).lines;
    const [termiteExample, roachExample, rodentExample, mosquitoExample] = SPECIALTY_VOICE_EXAMPLES;
    expect(termiteExample.expectations).toEqual([...SERVICE_EXPECTATIONS.termite_bait_station]);
    for (const line of roachExample.expectations) expect(roach).toContain(line);
    expect(rodentExample.expectations).toEqual([...SERVICE_EXPECTATIONS.rodent_trapping]);
    expect(mosquitoExample.expectations).toEqual(mosquito);
  });

  // The four-section parser reads only while GATE_REPORT_WRITER_RULES is on, as in production.
  const savedRules = process.env.GATE_REPORT_WRITER_RULES;
  beforeEach(() => { process.env.GATE_REPORT_WRITER_RULES = 'true'; });
  afterEach(() => {
    if (savedRules === undefined) delete process.env.GATE_REPORT_WRITER_RULES;
    else process.env.GATE_REPORT_WRITER_RULES = savedRules;
  });

  test.each(SPECIALTY_VOICE_EXAMPLES.map((example, i) => [i + 1, example]))(
    'example %i passes the writer screen and the report parser with its own EXPECTATIONS',
    (_n, example) => {
      expect(writerRulesRejection(example.report, { allowedPhrases: groundedTimeframePhrases(example.expectations) })).toBeNull();
      const parsed = technicianReportCustomerCopy(example.report);
      expect(parsed?.body).toBeTruthy();
      expect(parsed.sections).toBeTruthy();
      expect(example.report).not.toMatch(/\brecorded\b|\bnoted\b|\btechnician\b|\bas promised\b/i);
    },
  );

  // The typed report drops a paragraph whose activity words disagree with
  // the form (activity-indicators.js); the examples must keep their body.
  test.each([
    [1, 'termite_bait_station', { termite_activity: 'None observed' }],
    [2, 'cockroach', { species: 'German', activity_level: 'Moderate' }],
  ])('example %i agrees with its form\'s activity level', (n, findingsType, values) => {
    const band = deriveActivityScore(findingsType, values).score;
    const { body } = technicianReportCustomerCopy(SPECIALTY_VOICE_EXAMPLES[n - 1].report);
    expect(activityLevelContradictions(body, band)).toEqual([]);
  });
});

// Owner 2026-10-25: "german cockroaches" with a small g, and (owner 2026-10-23,
// "giving cleaning instructions is fine") a recorded cleaning step is advice the
// report passes on; aftercare for a treated area or a bait stays out.
describe('owner rulings 2026-10-23 and 2026-10-25', () => {
  test('german takes a small g, in the rule and in every example report', () => {
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain('- Write "german cockroaches" and "german roaches" with a small g, except as the first word of a sentence.');
    for (const example of SPECIALTY_VOICE_EXAMPLES) expect(example.report).not.toMatch(/\bGerman\b/);
  });

  test('a recorded cleaning step is passed on; aftercare for a treated area stays out', () => {
    expect(SPECIALTY_REPORT_VOICE_PROMPT).toContain('A cleaning or sanitation step the note or Recommendations give ("wipe the counters dry before bed") is the customer\'s own task: say it in WHAT\'S NEXT.');
    expect(SPECIALTY_REPORT_VOICE_PROMPT).not.toContain('never tell the customer to leave, clean, water or avoid anything');
  });
});
