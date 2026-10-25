// GATE_PEST_REPORT_VOICE (owner 2026-10-22, "rewrite pest"): under the writer
// rules the recurring pest writer gets one prompt in one voice in place of its
// stacked blocks. Off, and for every other writer, the prompt is byte-identical.
const fs = require('fs');
const path = require('path');
const { selectReportCopyPrompt } = require('../services/service-report/lawn-report-copy-prompt');
const {
  PEST_REPORT_VOICE_PROMPT, PEST_REPORT_VOICE_VERSION, PEST_VOICE_EXAMPLES, pestReportVoicePrompt,
  PEST_REPORT_VOICE_V2_PROMPT, PEST_REPORT_VOICE_V2_VERSION, PEST_VOICE_V2_EXAMPLES,
} = require('../services/service-report/pest-report-voice');
const {
  OWNER_RULES, groundedTimeframePhrases, noteAbsenceHint, writerRulesRejection,
} = require('../services/service-report/report-writer-rules');
const { technicianReportCustomerCopy } = require('../services/service-report/technician-report-copy');
const { HUMAN_PROSE_RULES } = require('../services/llm/human-prose-rules');

// The real v4 hard constraints, sliced from the route source, as report-writer-rules.test.js does.
const scheduleSource = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
const v4Start = scheduleSource.indexOf('## HARD CONSTRAINTS');
const v4End = scheduleSource.indexOf('## ANTI-TEMPLATE RULES', v4Start);
const V4_SHARED = `# SERVICE REPORT COPY — SYSTEM PROMPT v4\n${scheduleSource.slice(v4Start, v4End).replace(/\$\{[^}]*\}/g, 'X')}## ANTI-TEMPLATE RULES\nOld examples.`;

const RESERVICE_LINE = 'THIS VISIT IS A RE-SERVICE. Follow A RE-SERVICE above.';
const CALLBACK = 'CROSS-SERVICE MODIFIER — CALLBACK / RESERVICE';

describe('which writer gets the one-voice prompt', () => {
  test.each([
    ['pest_general_quarterly', { serviceKey: 'pest_general_quarterly', findingsType: null }],
    ['one_time_pest_control', { serviceKey: 'one_time_pest_control', findingsType: null }],
    ['a legacy pest label', {}],
  ])('%s, under the writer rules', (_name, context) => {
    const prompt = selectReportCopyPrompt(V4_SHARED, 'Quarterly Pest Control Service', { ...context, writerRules: true, pestVoice: true });
    expect(prompt).toBe(PEST_REPORT_VOICE_PROMPT);
    expect(prompt).not.toContain(OWNER_RULES);
    expect(prompt).not.toContain(CALLBACK);
  });

  test('a re-service is named at the end, by profile or by the callback flag', () => {
    for (const context of [
      { serviceKey: 'pest_re_service', findingsType: null },
      { serviceKey: 'pest_general_quarterly', findingsType: null, isCallback: true },
    ]) {
      const prompt = selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, writerRules: true, pestVoice: true });
      expect(prompt).toBe(pestReportVoicePrompt({ reservice: true }));
      expect(prompt.endsWith(RESERVICE_LINE)).toBe(true);
      expect(prompt).not.toContain(CALLBACK);
    }
  });

  test('off, the pest prompt is byte-identical to the stacked writer', () => {
    for (const context of [
      { serviceKey: 'pest_general_quarterly', findingsType: null },
      { serviceKey: 'pest_re_service', findingsType: null },
    ]) {
      const before = selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, writerRules: true });
      expect(selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, writerRules: true, pestVoice: false })).toBe(before);
      expect(before).toContain(OWNER_RULES);
    }
  });

  test('without the writer rules the flag changes nothing', () => {
    const context = { serviceKey: 'pest_general_quarterly', findingsType: null };
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, pestVoice: true }))
      .toBe(selectReportCopyPrompt(V4_SHARED, 'Old label', context));
  });

  test.each([
    ['rodent_trapping', 'rodent_trapping'],
    ['termite_bait', 'termite_bait_station'],
    ['mosquito_monthly', null],
    ['cockroach_control', 'cockroach'],
    ['lawn_care_6week', null],
    ['tree_shrub_program', 'tree_shrub'],
    ['palm_injection', 'palm_injection'],
  ])('%s keeps its own writer with the flag on', (serviceKey, findingsType) => {
    const context = { serviceKey, findingsType, writerRules: true };
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, pestVoice: true }))
      .toBe(selectReportCopyPrompt(V4_SHARED, 'Old label', context));
  });
});

describe('the one-voice prompt', () => {
  test('carries its version, the owner prose rules and every word the report refuses', () => {
    expect(PEST_REPORT_VOICE_PROMPT).toContain(`# ${PEST_REPORT_VOICE_VERSION}`);
    expect(PEST_REPORT_VOICE_PROMPT).toContain(HUMAN_PROSE_RULES);
    for (const word of ['infestation', 'infested', 'eliminated', 'eradicated', 'exterminated', 'resolved', 'solved', 'gone', 'cleared', 'pest-free', 'guaranteed', '"safe"', 'non-toxic', 'chemical', 'per visit', 'EPA']) {
      expect(PEST_REPORT_VOICE_PROMPT).toContain(word);
    }
  });

  // Codex #6466 r4: the v4 hard constraint 2 overpromise list carries over whole; no
  // output screen refuses these words, so the prompt is the only guard.
  test('bans every overpromise the v4 hard constraints banned', () => {
    for (const word of ['elimination', 'eradication', 'impenetrable', 'guaranteed', '100%', 'total protection', 'pest-free', 'foolproof']) {
      expect(PEST_REPORT_VOICE_PROMPT).toContain(word);
    }
  });

  // Codex #6466 r4: a product's tag is a target, not a sighting (the stacked adapter's rule).
  test('a pest a treatment was tagged for is not a finding unless we saw it', () => {
    expect(PEST_REPORT_VOICE_PROMPT).toContain('is what the work aimed at, not a sighting: it goes here only when the note, Observations or a "Findings observed" line says we saw it');
  });

  // Codex #6466 r5: the stacked prompt's PRODUCT FACTS, re-service, zero-rating and empty-section
  // rules carry over; no output screen can check any of them.
  test('a treatment\'s reason today comes from its own tag or the note, never from "mainly used for"', () => {
    expect(PEST_REPORT_VOICE_PROMPT).toContain('Say what it was for today only from its own "tagged today for" in PRODUCT FACTS or from the note.');
    expect(PEST_REPORT_VOICE_PROMPT).toContain('"Mainly used for" is what the treatment is generally used for, never why we used it today, and a treatment "not tagged today" gets no reason unless the note gives one.');
  });

  test('a re-service never blames the customer, waves off the activity or clears the earlier visit', () => {
    for (const phrase of ['Never blame the customer', 'never wave off the activity they reported as normal after treatment', 'never insist the earlier visit could not have played a part', 'never invent a change to sound responsive', 'keep what is still unresolved']) {
      expect(PEST_REPORT_VOICE_PROMPT).toContain(phrase);
    }
  });

  test('a zero rating with no place we checked is left out', () => {
    expect(PEST_REPORT_VOICE_PROMPT).toContain('A zero activity rating is an absence: say it only for a place we checked, named in the same clause (rule 4), and when the inputs name no place we checked, leave it out.');
  });

  test('the empty WHAT\'S NEXT sentence is used only with no next step, open promise or reach-out date', () => {
    expect(PEST_REPORT_VOICE_PROMPT).toContain('Only when the inputs hold no next step from the note or Recommendations, no promise still open in PROMISES, no REACH-OUT DATE, nothing we saw today, nothing the customer told us and no EXPECTATIONS lines');
  });

  // The owner's v4 rewrite (2026-10-09) dropped the stock pressure line; the new prompt must not bring it back.
  test('no stock phrases about pressure or long-term control', () => {
    expect(PEST_REPORT_VOICE_PROMPT).toContain('use no stock phrases about pressure or long-term control');
    expect(PEST_REPORT_VOICE_PROMPT).not.toMatch(/keeps? pressure down|manage pressure|support long-term control/);
  });

  // 2026-10-22 replay: "If ants are still trailing by the kitchen window … on Thursday,
  // October 22, text or call us." was refused on every try ("window" reads as an arrival
  // window). The REACH-OUT DATE sentence names the pest and the date and nothing else.
  test('the REACH-OUT DATE sentence names the pest and the date and nothing else', () => {
    expect(PEST_REPORT_VOICE_PROMPT).toContain('With a REACH-OUT DATE, that sentence names the pest and the date and nothing else, no place and no "come back" ("If you still see ants on <the REACH-OUT DATE>, text or call us.")');
  });

  // Codex #6466 r3: the stacked writer's v4 hard constraint 1 (minus "sweep", 2026-10-09)
  // carries over, so a HOW IT WORKS line's "crawling invaders" never reaches the report.
  test('bans the military language the v4 hard constraints banned', () => {
    for (const word of ['mission', 'tactical', 'deployment', 'fortification', 'fortress', 'sentries', 'invaders', 'infiltration', 'neutralize', 'annihilation', 'defensive perimeter', 'chemical barrier', 'vectors', 'recon', 'staging', 'advancement', 'threat', 'lockdown', 'intercept']) {
      expect(PEST_REPORT_VOICE_PROMPT).toContain(word);
    }
  });

  // Codex #6466 r3: the request body's Service Type is not checked by the server, so the
  // no-EXPECTATIONS sentence comes from the SERVICE TYPE record the server builds.
  test('the no-EXPECTATIONS sentence comes from the server SERVICE TYPE record, never the Service Type input', () => {
    expect(PEST_REPORT_VOICE_PROMPT).toContain('one sentence from the SERVICE TYPE record');
    expect(PEST_REPORT_VOICE_PROMPT).toContain('never the Service Type input');
    expect(PEST_REPORT_VOICE_PROMPT).not.toContain('<the Service Type input');
  });

  // noteAbsenceHint tells the writer to follow "OWNER RULES rule 4" under the note.
  test('rule 4 is still the absence rule the note hint names', () => {
    expect(noteAbsenceHint('Customer says no issues inside')).toContain('OWNER RULES rule 4');
    expect(PEST_REPORT_VOICE_PROMPT).toMatch(/\nOWNER RULES \(the report is refused if it breaks one\)\n(?:.*\n){3}4\. An absence only for a named place/);
  });

  // The four-section parser reads only while GATE_REPORT_WRITER_RULES is on, as in production.
  const savedRules = process.env.GATE_REPORT_WRITER_RULES;
  beforeEach(() => { process.env.GATE_REPORT_WRITER_RULES = 'true'; });
  afterEach(() => {
    if (savedRules === undefined) delete process.env.GATE_REPORT_WRITER_RULES;
    else process.env.GATE_REPORT_WRITER_RULES = savedRules;
  });

  // v1's examples, then v2's quiet-visit example (its other two are v1's).
  test.each([...PEST_VOICE_EXAMPLES, PEST_VOICE_V2_EXAMPLES[0]].map((example, i) => [i + 1, example]))(
    'example %i passes the writer screen and the report parser with its own EXPECTATIONS',
    (_n, example) => {
      expect(writerRulesRejection(example.report, { allowedPhrases: groundedTimeframePhrases(example.expectations) })).toBeNull();
      const parsed = technicianReportCustomerCopy(example.report);
      expect(parsed?.body).toBeTruthy();
      expect(parsed.sections).toBeTruthy();
      expect(example.report).not.toMatch(/\brecorded\b|\bnoted\b|\btechnician\b|\bas promised\b/i);
    },
  );
});

// GATE_PEST_QUIET_VISIT (owner 2026-10-24): v1's first example modeled "you
// didn't mention anything new when we talked" on a quiet visit; v2 opens it on
// what we saw and where we worked, and never claims a talk.
describe('pest_report_voice_v2', () => {
  const context = { serviceKey: 'pest_general_quarterly', findingsType: null, writerRules: true, pestVoice: true };

  test('the selector serves v2 only on the voice prompt with the quiet-visit flag', () => {
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, pestQuietVisit: true })).toBe(PEST_REPORT_VOICE_V2_PROMPT);
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', context)).toBe(PEST_REPORT_VOICE_PROMPT);
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', { serviceKey: 'pest_re_service', findingsType: null, writerRules: true, pestVoice: true, pestQuietVisit: true }))
      .toBe(pestReportVoicePrompt({ reservice: true, quietVisit: true }));
    const stacked = { ...context, pestVoice: false };
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', { ...stacked, pestQuietVisit: true })).toBe(selectReportCopyPrompt(V4_SHARED, 'Old label', stacked));
  });

  test('v2 keeps every v1 rule and adds the two quiet-visit rules', () => {
    const rules = (prompt) => prompt.slice(0, prompt.indexOf('THREE GOOD REPORTS'));
    const quietFound = 'When the customer told us nothing, start with what we saw today or with where we worked, never with what they did not say. ';
    expect(PEST_REPORT_VOICE_V2_PROMPT).toContain(`# ${PEST_REPORT_VOICE_V2_VERSION}`);
    expect(PEST_REPORT_VOICE_V2_PROMPT).toContain('- Never say we talked with, spoke with or met the customer unless the note says so, and never say what the customer did not mention, report or ask about.');
    expect(PEST_REPORT_VOICE_V2_PROMPT).toContain(quietFound);
    const v2Lines = new Set(rules(PEST_REPORT_VOICE_V2_PROMPT).replace(quietFound, '').split('\n'));
    for (const line of rules(PEST_REPORT_VOICE_PROMPT).split('\n')) {
      if (line !== `# ${PEST_REPORT_VOICE_VERSION}`) expect(v2Lines.has(line)).toBe(true);
    }
  });

  test('no v2 example opens on what the customer did not say or claims a talk', () => {
    for (const example of PEST_VOICE_V2_EXAMPLES) {
      expect(example.report).not.toMatch(/didn['’]t mention|did not mention|didn['’]t report|when we talked|when we spoke|spoke with|talked with/i);
    }
    expect(PEST_REPORT_VOICE_V2_PROMPT).not.toContain("you didn't mention anything new");
  });
});

// Owner 2026-10-25: "german cockroaches" with a small g, and (owner 2026-10-23,
// "giving cleaning instructions is fine") a recorded cleaning step is advice the
// report passes on; aftercare for a treated area or a bait stays out.
describe('owner rulings 2026-10-23 and 2026-10-25', () => {
  test('german takes a small g, in the rule and in every example report', () => {
    expect(PEST_REPORT_VOICE_V2_PROMPT).toContain('- Write "german cockroaches" and "german roaches" with a small g, except as the first word of a sentence.');
    for (const example of PEST_VOICE_V2_EXAMPLES) expect(example.report).not.toMatch(/\bGerman\b/);
  });

  test('a recorded cleaning step is passed on; aftercare for a treated area stays out', () => {
    expect(PEST_REPORT_VOICE_V2_PROMPT).toContain('A cleaning or sanitation step the note or Recommendations give ("wipe the counters dry before bed") is the customer\'s own task: say it in WHAT\'S NEXT.');
    expect(PEST_REPORT_VOICE_V2_PROMPT).not.toContain('never tell the customer to leave, clean, water or avoid anything');
  });
});
