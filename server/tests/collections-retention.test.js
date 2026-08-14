/**
 * collections/outbound-voice/retention.js — pins:
 *  - horizon = COLLECTIONS_RETENTION_DAYS, default 90, floor 1, bad values
 *    fall to the default;
 *  - the sweep is scoped to source='collections_voice' ONLY (the inbound
 *    pipeline's rows are structurally out of reach) and skips already-purged
 *    rows;
 *  - purge clears transcript/recording columns and deletes the Twilio
 *    recording; a 404 counts as already-gone; any other API failure DEFERS
 *    the row (kept un-purged for the next sweep, never forgotten);
 *  - zero aged rows ⇒ complete no-op (no Twilio client at all) — the lane
 *    dark means this sweep provably does nothing.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockRemove = jest.fn();
jest.mock('twilio', () => jest.fn(() => ({ recordings: jest.fn(() => ({ remove: mockRemove })) })));
jest.mock('../config', () => ({ twilio: { accountSid: 'ACtest', authToken: 'tok' } }));

const db = require('../models/db');
const twilio = require('twilio');
const {
  runCollectionsRetentionSweep, retentionDays, DEFAULT_RETENTION_DAYS,
} = require('../services/collections/outbound-voice/retention');

const NOW = new Date('2026-08-12T15:00:00Z');

function selectChain(rows) {
  const q = { _wheres: [] };
  q.where = jest.fn((w) => { q._wheres.push(w); return q; });
  q.whereNot = jest.fn((...a) => { q._wheres.push(a); return q; });
  q.select = jest.fn(() => q);
  q.limit = jest.fn(async () => rows);
  return q;
}

function updateChain() {
  const q = {};
  q.where = jest.fn(() => q);
  q.update = jest.fn(async (patch) => { q._patch = patch; return 1; });
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.COLLECTIONS_RETENTION_DAYS;
});

describe('retentionDays', () => {
  test('default + env override + guard rails', () => {
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    process.env.COLLECTIONS_RETENTION_DAYS = '30';
    expect(retentionDays()).toBe(30);
    process.env.COLLECTIONS_RETENTION_DAYS = 'soon';
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    process.env.COLLECTIONS_RETENTION_DAYS = '0';
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });
});

test('zero aged rows ⇒ no-op, no Twilio client constructed', async () => {
  const sel = selectChain([]);
  db.mockImplementation(() => sel);
  const res = await runCollectionsRetentionSweep({ now: NOW });
  expect(res).toEqual({ considered: 0, purged: 0, failed: 0, retentionDays: DEFAULT_RETENTION_DAYS });
  expect(twilio).not.toHaveBeenCalled();
  // Scope pin: only collections_voice rows are ever in the query.
  expect(sel._wheres[0]).toEqual({ source: 'collections_voice' });
});

test('aged row: recording deleted + content columns purged', async () => {
  const upd = updateChain();
  const queues = [selectChain([{ id: 'cl-old', recording_sid: 'RE1' }]), upd];
  db.mockImplementation(() => queues.shift());
  mockRemove.mockResolvedValue(true);
  const res = await runCollectionsRetentionSweep({ now: NOW });
  expect(res.purged).toBe(1);
  expect(mockRemove).toHaveBeenCalled();
  expect(upd._patch).toMatchObject({
    transcription: null,
    transcription_metadata: null,
    call_summary: null,
    recording_url: null,
    recording_sid: null,
    transcription_status: 'purged',
  });
});

test('Twilio 404 = already gone; the purge still completes', async () => {
  const upd = updateChain();
  const queues = [selectChain([{ id: 'cl-old', recording_sid: 'RE1' }]), upd];
  db.mockImplementation(() => queues.shift());
  mockRemove.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
  const res = await runCollectionsRetentionSweep({ now: NOW });
  expect(res.purged).toBe(1);
});

test('other Twilio failure DEFERS the row (no column purge, retried next sweep)', async () => {
  const upd = updateChain();
  const queues = [selectChain([{ id: 'cl-old', recording_sid: 'RE1' }]), upd];
  db.mockImplementation(() => queues.shift());
  mockRemove.mockRejectedValue(new Error('api down'));
  const res = await runCollectionsRetentionSweep({ now: NOW });
  expect(res.purged).toBe(0);
  expect(res.failed).toBe(1);
  expect(upd.update).not.toHaveBeenCalled();
});

test('rows without a recording purge transcript columns without touching Twilio', async () => {
  const upd = updateChain();
  const queues = [selectChain([{ id: 'cl-old', recording_sid: null }]), upd];
  db.mockImplementation(() => queues.shift());
  const res = await runCollectionsRetentionSweep({ now: NOW });
  expect(res.purged).toBe(1);
  expect(twilio).not.toHaveBeenCalled();
});
