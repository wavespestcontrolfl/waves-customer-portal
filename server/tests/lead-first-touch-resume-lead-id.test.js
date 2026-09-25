/**
 * resolveFirstTouchLeadId (services/lead-first-touch-resume.js) — the lead
 * id carried into the new_lead enroll's context.leadId at held first-touch
 * release, so the consultation-booking email block (dark behind
 * GATE_LEAD_INSPECTION_LINK) has something to render from. Prefers the
 * call's own call_log.metadata.lead_id stamp; falls back to the most
 * recent OPEN lead on the call's phone only when that stamp is absent;
 * never throws, never blocks the release.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { resolveFirstTouchLeadId } = require('../services/lead-first-touch-resume');

function chainBuilder({ rows = [], firstError = null } = {}) {
  const b = { wheres: [], whereRaws: [] };
  b.where = jest.fn((arg) => { b.wheres.push(arg); return b; });
  b.whereRaw = jest.fn((sql, bindings) => { b.whereRaws.push([sql, bindings]); return b; });
  b.whereIn = jest.fn(() => b);
  b.whereNull = jest.fn(() => b);
  b.orderBy = jest.fn(() => b);
  b.select = jest.fn(async () => {
    if (firstError) throw firstError;
    return rows;
  });
  return b;
}

describe('resolveFirstTouchLeadId', () => {
  test('metadata.lead_id wins outright — never even builds a leads query', async () => {
    const dbh = jest.fn(() => { throw new Error('dbh must not be called'); });
    const leadId = await resolveFirstTouchLeadId({ metadataLeadId: 'lead-abc', fromPhone: '9415551234', dbh });
    expect(leadId).toBe('lead-abc');
  });

  test('no metadata stamp, a matching open lead by phone → that lead id', async () => {
    const leadsBuilder = chainBuilder({ rows: [{ id: 'lead-by-phone-1', phone: '+19415551234' }] });
    const dbh = jest.fn((table) => {
      expect(table).toBe('leads');
      return leadsBuilder;
    });
    const leadId = await resolveFirstTouchLeadId({ metadataLeadId: null, fromPhone: '(941) 555-1234', dbh });
    expect(leadId).toBe('lead-by-phone-1');
    expect(leadsBuilder.whereRaw).toHaveBeenCalledWith(expect.stringContaining('regexp_replace'), ['9415551234']);
  });

  test('no metadata stamp, no matching open lead by phone → null', async () => {
    const dbh = jest.fn(() => chainBuilder({ rows: [] }));
    const leadId = await resolveFirstTouchLeadId({ metadataLeadId: null, fromPhone: '9415551234', dbh });
    expect(leadId).toBeNull();
  });

  test('a foreign number sharing the US lead\'s last ten digits is NOT it (full phone identity, Codex #4709 r19 P1)', async () => {
    const leadsBuilder = chainBuilder({ rows: [{ id: 'us-lead', phone: '+19415551234' }] });
    const dbh = jest.fn(() => leadsBuilder);
    const leadId = await resolveFirstTouchLeadId({ metadataLeadId: null, fromPhone: '+449415551234', dbh });
    expect(leadId).toBeNull();
  });

  test('among suffix candidates, only the full-identity match is picked', async () => {
    const leadsBuilder = chainBuilder({ rows: [{ id: 'foreign-lead', phone: '+529415551234' }, { id: 'us-lead', phone: '9415551234' }] });
    const dbh = jest.fn(() => leadsBuilder);
    const leadId = await resolveFirstTouchLeadId({ metadataLeadId: null, fromPhone: '+19415551234', dbh });
    expect(leadId).toBe('us-lead');
  });

  test('no metadata stamp and no phone at all → null without querying', async () => {
    const dbh = jest.fn(() => { throw new Error('dbh must not be called'); });
    const leadId = await resolveFirstTouchLeadId({ metadataLeadId: null, fromPhone: null, dbh });
    expect(leadId).toBeNull();
  });

  test('a malformed phone (not 10 digits) → null without querying', async () => {
    const dbh = jest.fn(() => { throw new Error('dbh must not be called'); });
    const leadId = await resolveFirstTouchLeadId({ metadataLeadId: null, fromPhone: '123', dbh });
    expect(leadId).toBeNull();
  });

  test('a lookup error resolves to null — never throws into the release path', async () => {
    const dbh = jest.fn(() => chainBuilder({ firstError: new Error('db down') }));
    const leadId = await resolveFirstTouchLeadId({ metadataLeadId: null, fromPhone: '9415551234', dbh });
    expect(leadId).toBeNull();
  });
});
