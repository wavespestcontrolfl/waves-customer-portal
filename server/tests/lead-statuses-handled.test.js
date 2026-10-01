/**
 * 'handled' (owner ruling 2026-10-01): a /book "Can't find a time?" request that
 * closed itself because the customer booked online. Closed, neither won nor lost.
 * Pins the status's place in the shared lead definitions: not open, out of every
 * prospect denominator (so conversion / win / lost rates never count it), and
 * settable by staff through the same status validation as every other status.
 */
const mockRows = [];
// A recording query builder: .modify(fn) applies fn to a stand-in that honours whereNotIn,
// so the scope the real code applies decides which rows the test sees.
function mockBuilder() {
  let rows = mockRows;
  const b = {
    where: () => b, whereNull: () => b, leftJoin: () => b, select: () => b, groupBy: () => b, orderByRaw: () => b,
    modify: (fn) => {
      const scope = { whereNotIn: (col, list) => { rows = rows.filter((r) => !list.includes(r.status)); return scope; }, whereRaw: () => scope };
      fn(scope);
      return b;
    },
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    first: () => Promise.resolve({ total: 0 }),
    sum: () => b,
    catch: () => Promise.resolve({ total: 0 }),
  };
  return b;
}
jest.mock('../models/db', () => Object.assign(jest.fn(() => mockBuilder()), { raw: (s) => s }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const {
  OPEN_LEAD_STATUSES,
  NON_ENGAGED_LEAD_STATUSES,
  PROSPECT_SCOPE_SQL,
  isOpenLeadRow,
  scopeToProspects,
} = require('../services/lead-statuses');

describe("lead status 'handled'", () => {
  test('is closed: not an open status, and an open-lead row check refuses it', () => {
    expect(OPEN_LEAD_STATUSES).not.toContain('handled');
    expect(isOpenLeadRow({ status: 'handled', converted_at: null })).toBe(false);
  });

  test('is out of the prospect denominator, so it is neither a conversion nor a lost lead', () => {
    expect(NON_ENGAGED_LEAD_STATUSES).toContain('handled');
    expect(PROSPECT_SCOPE_SQL).toContain("'handled'");
    const calls = [];
    const qb = { whereNotIn: (...a) => { calls.push(a); return qb; }, whereRaw: () => qb };
    scopeToProspects(qb);
    expect(calls[0][0]).toBe('leads.status');
    expect(calls[0][1]).toContain('handled');
  });

  test('the Leads route accepts it as a status and its active count treats it as closed', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-leads.js'), 'utf8');
    expect(src).toMatch(/const LEAD_STATUSES = \[[^\]]*'handled',[^\]]*\];/s);
    expect(src).toMatch(/!\['won', 'lost', 'unresponsive', 'disqualified', 'duplicate', 'handled'\]\.includes\(l\.status\)/);
    // The lost count is `status === 'lost'` only: handled never reads as lost.
    expect(src).toMatch(/leads\.filter\(l => l\.status === 'lost'\)/);
  });

  test('the closed-lead lists that keep a closed lead from being re-attached or re-linked all carry it', () => {
    const files = [
      'routes/lead-webhook.js',
      'routes/public-property-lookup.js',
      'routes/admin-agents.js',
      'services/estimate-clarify-asks.js',
      'services/lead-estimate-link.js',
      'services/call-recording-processor.js',
      'services/outbound-review-confirm.js',
      'services/customer-address-fanout.js',
      'services/customer-contact-fanout.js',
      'services/customer-email-fanout.js',
      'services/customer-dedupe.js',
      'services/email-bounce-recovery.js',
      'services/email/spam-blocker.js',
      'services/email/inbox-hygiene.js',
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect({ f, hasHandled: /'won', 'lost',[^\]\)]*'handled'/.test(src) }).toEqual({ f, hasHandled: true });
    }
  });

  test('an inbound email inquiry never attaches to a handled lead (all three guards), and the Intelligence Bar accepts the status', () => {
    const email = fs.readFileSync(path.join(__dirname, '../services/email/email-actions.js'), 'utf8');
    expect(email.match(/whereNotIn\('status', \['won', 'lost', 'handled'\]\)/g)).toHaveLength(3);
    const ib = fs.readFileSync(path.join(__dirname, '../services/intelligence-bar/leads-tools.js'), 'utf8');
    expect(ib).toMatch(/const LEAD_STATUSES = \[[^\]]*'handled',[^\]]*\];/s);
  });

  test('the Intelligence Bar lead overview keeps handled out of the conversion denominator (a cohort containing a handled request)', async () => {
    mockRows.length = 0;
    mockRows.push({ status: 'won' }, { status: 'new' }, { status: 'lost' }, { status: 'handled' }, { status: 'handled' });
    const { executeLeadsTool } = require('../services/intelligence-bar/leads-tools');
    const out = await executeLeadsTool('get_lead_overview', { days: 30 });
    expect(out).toMatchObject({ total_leads: 3, won: 1, lost: 1, conversion_rate: 33.3 });
  });

  test('the Intelligence Bar source and funnel reads apply the same prospect scope', () => {
    const ib = fs.readFileSync(path.join(__dirname, '../services/intelligence-bar/leads-tools.js'), 'utf8');
    expect((ib.match(/\.modify\(scopeToProspects\)/g) || []).length).toBe(3);
  });

  test('the pipeline opportunity list never shows a handled lead as a new lead needing action', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-pipeline.js'), 'utf8');
    expect(src).toContain("leads.status IS DISTINCT FROM 'handled'");
  });
});
