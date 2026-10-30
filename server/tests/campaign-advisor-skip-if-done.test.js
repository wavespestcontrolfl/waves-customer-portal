/**
 * The 8 AM ads-advisor cron skips when today already has a model-written report (owner 2026-10-29: the
 * office Mac's Max-plan runner writes it at 7:30 AM). Only a model report counts: a missing row or the
 * outage fallback (no provider/model) still runs on the API, so a sleeping Mac changes nothing.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

let mockRow = null;
const mockWhere = [];
jest.mock('../models/db', () => jest.fn((table) => {
  const b = {
    where: (args) => { mockWhere.push({ table, args }); return b; },
    first: () => Promise.resolve(mockRow),
  };
  return b;
}));

const advisor = require('../services/ads/campaign-advisor');
const { etDateString } = require('../utils/datetime-et');

const NOW = new Date('2026-10-30T11:30:00Z'); // 7:30 AM ET

beforeEach(() => {
  mockRow = null;
  mockWhere.length = 0;
});

describe('hasModelReportToday', () => {
  test('reads only today\'s ET row', async () => {
    await advisor.hasModelReportToday(NOW);
    expect(mockWhere).toEqual([{ table: 'ad_advisor_reports', args: { date: etDateString(NOW) } }]);
    expect(etDateString(NOW)).toBe('2026-10-30');
  });

  test('no row today: the cron runs', async () => {
    await expect(advisor.hasModelReportToday(NOW)).resolves.toBe(false);
  });

  test('a model-written report (string or parsed JSON) skips the cron', async () => {
    mockRow = { report_data: JSON.stringify({ grade: 'B', provider: 'anthropic', model: 'claude-fable-5-1' }) };
    await expect(advisor.hasModelReportToday(NOW)).resolves.toBe(true);
    mockRow = { report_data: { grade: 'B', model: 'claude-fable-5-1' } };
    await expect(advisor.hasModelReportToday(NOW)).resolves.toBe(true);
  });

  test('the outage fallback does not count: the cron retries on the API', async () => {
    const summaries = [{ last7d: { spend: 12, conversions: 1 } }];
    mockRow = { report_data: JSON.stringify(advisor.generateFallbackAdvice(summaries)) };
    await expect(advisor.hasModelReportToday(NOW)).resolves.toBe(false);
  });

  test('unreadable report_data does not count', async () => {
    mockRow = { report_data: '{not json' };
    await expect(advisor.hasModelReportToday(NOW)).resolves.toBe(false);
  });
});
