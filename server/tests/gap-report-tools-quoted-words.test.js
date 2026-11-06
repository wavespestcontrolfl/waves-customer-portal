'use strict';

// list_gap_reports marks words the owner did not type (tech bar, texting AI,
// phone agent) so the bar's model treats them as data, never instructions.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const row = (id, source) => ({
  id: String(id), source, kind: 'missing_capability', summary: `ask ${id}`, attempted: null, closest_tool: null,
  seen_in_window: 1, occurrences: '1', first_seen_at: '2026-09-28T12:00:00Z', last_seen_at: '2026-09-28T12:00:00Z', status: 'new', domain: null,
});
jest.mock('../services/agent-gap-reports', () => ({
  listRecentGaps: jest.fn(async () => [row(1, 'texting-ai'), row(2, 'intelligence-bar'), row(3, 'phone-agent'), row(4, 'tech-bar')]),
}));

const { executeGapReportTool } = require('../services/intelligence-bar/gap-report-tools');

test('every row the owner did not type carries quoted_words; the owner\'s own bar rows do not', async () => {
  const result = await executeGapReportTool('list_gap_reports', {});
  const byId = Object.fromEntries(result.groups.flatMap((group) => group.gaps).map((gap) => [gap.gap_id, gap]));
  expect(byId[1].quoted_words).toBe(true);
  expect(byId[3].quoted_words).toBe(true);
  expect(byId[4].quoted_words).toBe(true);
  expect(byId[2]).not.toHaveProperty('quoted_words');
});

// A blocked row (the bar stopped on a refusal or ran out of steps) is not a
// "no tool fits" row: the description and the note must say so, or the model
// reads every row as a missing feature.
test('the tool description and note tell the model what a blocked row is', async () => {
  const { GAP_REPORT_TOOLS } = require('../services/intelligence-bar/gap-report-tools');
  const description = GAP_REPORT_TOOLS.find((tool) => tool.name === 'list_gap_reports').description;
  expect(description).toMatch(/kind missing_capability/);
  expect(description).toMatch(/kind blocked/);
  expect(description).toMatch(/refusal code/);
  expect(description).toMatch(/tool_loop_exhausted/);
  expect(description).toMatch(/rule working as intended or a real block/);
  const result = await executeGapReportTool('list_gap_reports', {});
  expect(result.note).toMatch(/blocked gap names the tool and refusal code/);
});

// GATE_CLAUDE_INPUT_GUARD: an Intelligence Bar row holds the model's own search text or a tool's refusal text (which can name a
// customer), not words the owner typed, so list_gap_reports marks it quoted_words and the admin MCP withholds it.
describe('GATE_CLAUDE_INPUT_GUARD', () => {
  afterEach(() => { delete process.env.GATE_CLAUDE_INPUT_GUARD; });
  const gaps = async () => {
    const result = await executeGapReportTool('list_gap_reports', {});
    return Object.fromEntries(result.groups.flatMap((group) => group.gaps).map((gap) => [gap.gap_id, gap]));
  };

  test('on: bar rows carry quoted_words; system rows still do not', async () => {
    process.env.GATE_CLAUDE_INPUT_GUARD = 'true';
    const byId = await gaps();
    expect(byId[2].quoted_words).toBe(true);
    expect(byId[1].quoted_words).toBe(true);
    expect(byId[4].quoted_words).toBe(true);
  });

  test('on: a bar row built from a refusal that names a record is marked quoted_words', async () => {
    process.env.GATE_CLAUDE_INPUT_GUARD = 'true';
    const { toGap } = require('../services/intelligence-bar/gap-report-tools')._private;
    const gap = toGap({ ...row(9, 'intelligence-bar'), summary: 'propose_admin_edit: Dummy-Name-Marker has no text preferences saved yet.' });
    expect(gap.quoted_words).toBe(true);
  });

  test('off: the bar\'s rows are unmarked as before', async () => {
    expect(await gaps()).toHaveProperty('2');
    expect((await gaps())[2]).not.toHaveProperty('quoted_words');
  });

  test('ib-model system rows are never marked quoted_words', () => {
    process.env.GATE_CLAUDE_INPUT_GUARD = 'true';
    const { toGap } = require('../services/intelligence-bar/gap-report-tools')._private;
    const gap = toGap(row(5, 'ib-model'));
    expect(gap.system_fault).toBe(true);
    expect(gap).not.toHaveProperty('quoted_words');
  });
});
