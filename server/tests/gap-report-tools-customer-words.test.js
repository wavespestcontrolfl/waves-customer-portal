'use strict';

// list_gap_reports marks a customer's or caller's own words (texting AI,
// phone agent) so the bar's model treats them as data, never instructions.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const row = (id, source) => ({
  id: String(id), source, kind: 'missing_capability', summary: `ask ${id}`, attempted: null, closest_tool: null,
  seen_in_window: 1, occurrences: '1', first_seen_at: '2026-09-28T12:00:00Z', last_seen_at: '2026-09-28T12:00:00Z', status: 'new', domain: null,
});
jest.mock('../services/agent-gap-reports', () => ({
  listRecentGaps: jest.fn(async () => [row(1, 'texting-ai'), row(2, 'intelligence-bar'), row(3, 'phone-agent')]),
}));

const { executeGapReportTool } = require('../services/intelligence-bar/gap-report-tools');

test('texting-ai and phone-agent rows carry customer_words; staff rows do not', async () => {
  const result = await executeGapReportTool('list_gap_reports', {});
  const byId = Object.fromEntries(result.groups.flatMap((group) => group.gaps).map((gap) => [gap.gap_id, gap]));
  expect(byId[1].customer_words).toBe(true);
  expect(byId[3].customer_words).toBe(true);
  expect(byId[2]).not.toHaveProperty('customer_words');
});
