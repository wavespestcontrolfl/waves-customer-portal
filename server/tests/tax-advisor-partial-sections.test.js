/**
 * The weekly tax report used to turn a failed section read into an empty
 * section ("no deadlines"). Each failed read is now named in the report's
 * executive summary (admin report text only) so it reads as unknown, not empty.
 * No model call is involved: the Anthropic SDK is absent here, so the data-only
 * fallback report is stored, exactly as when the key is missing.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('@anthropic-ai/sdk', () => null);
jest.mock('../services/twilio', () => ({}));
jest.mock('../models/db', () => {
  const failing = new Set();
  const inserts = [];
  const make = (table) => {
    const settled = () => (failing.has(table) ? Promise.reject(new Error('relation missing')) : Promise.resolve([]));
    const q = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => settled().then(res, rej);
        if (prop === 'catch') return (fn) => settled().catch(fn);
        if (prop === 'insert') {
          return (row) => {
            inserts.push({ table, row });
            return { returning: async () => [{ id: 'report-1' }] };
          };
        }
        return () => q;
      },
    });
    return q;
  };
  const db = jest.fn(make);
  db.raw = jest.fn((sql) => sql);
  db.fn = { now: jest.fn() };
  db.__failing = failing;
  db.__inserts = inserts;
  return db;
});

const db = require('../models/db');
const TaxAdvisor = require('../services/tax-advisor');

const storedSummary = () => db.__inserts.find((i) => i.table === 'tax_advisor_reports').row.executive_summary;

beforeEach(() => {
  jest.clearAllMocks();
  db.__failing.clear();
  db.__inserts.length = 0;
  delete process.env.ANTHROPIC_API_KEY;
});

test('a failed deadline read is named as unread, not left looking like "0 upcoming deadlines"', async () => {
  db.__failing.add('tax_filing_calendar');
  const report = await TaxAdvisor.generateWeeklyReport();
  expect(report.executive_summary).toMatch(/Partial data: filing deadlines could not be read this week\. Treat that section as unknown, not empty\.$/);
  expect(storedSummary()).toBe(report.executive_summary);
});

test('several failed reads are all named once', async () => {
  db.__failing.add('tax_filing_calendar');
  db.__failing.add('tax_exemptions');
  db.__failing.add('equipment_register');
  const report = await TaxAdvisor.generateWeeklyReport();
  expect(report.executive_summary).toMatch(/Partial data: filing deadlines, equipment, tax exemptions could not be read this week\. Treat those sections as unknown, not empty\.$/);
});

test('a clean run adds no note', async () => {
  const report = await TaxAdvisor.generateWeeklyReport();
  expect(report.executive_summary).not.toMatch(/Partial data/);
});

test('direct getter calls keep their old empty values', async () => {
  db.__failing.add('tax_filing_calendar');
  await expect(TaxAdvisor.getUpcomingDeadlines()).resolves.toEqual([]);
});
