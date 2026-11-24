/**
 * Email-created leads attribute to the 'Email Inquiry' lead_sources row
 * (looked up by source_type 'email' at insert time). The lookup is fail-soft: a missing row or
 * a lookup error must never stop the lead from being created.
 */
jest.mock('googleapis', () => ({ google: {} }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({
  trashMessage: jest.fn(), archiveMessage: jest.fn(), modifyLabels: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { handleLeadInquiry, EMAIL_LEAD_SOURCE_TYPE } = require('../services/email/email-actions');

const CHAIN = ['where', 'orWhere', 'whereRaw', 'orWhereRaw', 'whereNot', 'whereNotIn', 'whereIn',
  'whereNull', 'whereNotNull', 'whereILike', 'andWhereILike', 'orderBy', 'forUpdate'];

// leadSource: row to return, null for no row, or an Error to throw from the lookup.
function setupDb({ leadSource }) {
  const state = { inserts: [], sourceWheres: [] };
  db.mockImplementation((table) => {
    const b = {};
    for (const m of CHAIN) b[m] = jest.fn((...args) => {
      if (table === 'lead_sources') state.sourceWheres.push(args[0]);
      return b;
    });
    b.first = jest.fn(async () => {
      if (table === 'lead_sources') {
        if (leadSource instanceof Error) throw leadSource;
        return leadSource;
      }
      return null;
    });
    b.update = jest.fn(async () => 1);
    b.insert = jest.fn((row) => {
      state.inserts.push({ table, row });
      const rows = (Array.isArray(row) ? row : [row]).map((r, i) => ({ id: `${table}-${state.inserts.length}-${i}`, ...r }));
      const p = Promise.resolve(rows);
      return { returning: jest.fn(async () => rows), then: p.then.bind(p), catch: p.catch.bind(p) };
    });
    return b;
  });
  db.transaction = jest.fn(async (cb) => cb(db));
  return state;
}

const email = {
  id: 'email-1', gmail_id: 'g-1', gmail_thread_id: 'thread-1',
  from_address: 'jane.prospect@example.com', from_name: 'Jane Prospect',
  subject: 'Need a pest control quote', received_at: new Date('2026-07-01T12:00:00Z'),
  classification: null, extracted_data: null,
};
const classification = {
  category: 'lead_inquiry', confidence: 0.95, summary: 'wants a quote',
  extracted: { person_name: 'Jane Prospect', email: 'jane.prospect@example.com', phone: '(941) 555-1234', service_interest: 'pest control' },
};

const leadInserts = (state) => state.inserts.filter((i) => i.table === 'leads');

describe('handleLeadInquiry lead_source_id', () => {
  beforeEach(() => { jest.clearAllMocks(); db.mockReset(); });
  afterEach(() => { db.mockReset(); });

  test('sets lead_source_id from the Email Inquiry row, matched by source_type', async () => {
    const state = setupDb({ leadSource: { id: 'src-email' } });
    await handleLeadInquiry(email, classification);
    expect(state.sourceWheres).toContainEqual({ source_type: EMAIL_LEAD_SOURCE_TYPE });
    expect(EMAIL_LEAD_SOURCE_TYPE).toBe('email');
    const [ins] = leadInserts(state);
    expect(ins.row).toMatchObject({ lead_type: 'email_inquiry', lead_source_id: 'src-email', first_contact_channel: 'email' });
  });

  test('missing row: lead is still created, unattributed', async () => {
    const state = setupDb({ leadSource: null });
    await handleLeadInquiry(email, classification);
    const [ins] = leadInserts(state);
    expect(ins).toBeDefined();
    expect(ins.row).not.toHaveProperty('lead_source_id');
  });

  test('lookup error: lead is still created, unattributed, and the error is logged', async () => {
    const state = setupDb({ leadSource: new Error('relation "lead_sources" does not exist') });
    await handleLeadInquiry(email, classification);
    const [ins] = leadInserts(state);
    expect(ins).toBeDefined();
    expect(ins.row).not.toHaveProperty('lead_source_id');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Email Inquiry lead source lookup failed'));
  });

  test.each([
    ['tagged hub link', 'Waves <contact+gbp-sarasota_home@wavespestcontrol.com>', { kind: 'google_business', label: 'Google Business Profile', detail: 'GBP — Sarasota · email link, home page' }],
    ['untagged spoke address', 'contact@palmettoexterminator.com', { kind: 'website', label: 'Website', detail: 'palmettoexterminator.com' }],
  ])('new lead from a %s stores source evidence and keeps lead_source_id', async (name, to, expected) => {
    const state = setupDb({ leadSource: { id: 'src-email' } });
    await handleLeadInquiry({ ...email, to_address: to }, classification);
    const [ins] = leadInserts(state);
    expect(ins.row.lead_source_id).toBe('src-email');
    expect(JSON.parse(ins.row.extracted_data).source_evidence).toMatchObject(expected);
  });

  test.each([
    ['plain main address', 'contact@wavespestcontrol.com'],
    ['forged tag', 'contact+gbp-nowhere_home@wavespestcontrol.com'],
    ['no to_address', null],
  ])('new lead from a %s keeps the plain Email inquiry (no evidence written)', async (name, to) => {
    const state = setupDb({ leadSource: { id: 'src-email' } });
    await handleLeadInquiry({ ...email, to_address: to }, classification);
    const [ins] = leadInserts(state);
    expect(ins.row).not.toHaveProperty('extracted_data');
  });
});
