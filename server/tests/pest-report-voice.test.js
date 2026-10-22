// GATE_PEST_REPORT_VOICE (owner 2026-10-22, "rewrite pest"): under the writer
// rules the recurring pest writer gets one prompt in one voice in place of its
// stacked blocks. Off, and for every other writer, the prompt is byte-identical.
const fs = require('fs');
const path = require('path');
const { selectReportCopyPrompt } = require('../services/service-report/lawn-report-copy-prompt');
const {
  PEST_REPORT_VOICE_PROMPT, PEST_REPORT_VOICE_VERSION, PEST_VOICE_EXAMPLES, pestReportVoicePrompt,
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

  test.each(PEST_VOICE_EXAMPLES.map((example, i) => [i + 1, example]))(
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
