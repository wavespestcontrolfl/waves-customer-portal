'use strict';
/**
 * finalizeDeferredCompletionSend writes completionSmsDeferredDeliveredAt
 * ONCE. A finalize-only retry (a post-delivery state step failed after the
 * provider accepted the text) re-runs the notes merge with a fresh
 * timestamp; overwriting would move the report into a later send cohort in
 * the report-engagement read and make real opens between delivery and the
 * retry look pre-send (codex #3847 P2).
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const updates = [];
const chain = {
  where: jest.fn(() => chain),
  whereNull: jest.fn(() => chain),
  update: jest.fn((payload) => { updates.push(payload); return Promise.resolve(1); }),
  insert: jest.fn(() => Promise.resolve([])),
};
const mockDb = jest.fn(() => chain);
mockDb.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
mockDb.fn = { now: () => 'now()' };
jest.mock('../models/db', () => mockDb);

const { finalizeDeferredCompletionSend } = require('../services/dispatch-completion-deferred');

test('the delivered-at stamp is only added when the record has none; status is always re-asserted', async () => {
  await finalizeDeferredCompletionSend({ service_record_id: 'rec-1' }, { retry: true });
  const notesUpdate = updates.find((u) => u.structured_notes);
  expect(notesUpdate).toBeTruthy();
  const { sql, bindings } = notesUpdate.structured_notes;
  expect(sql).toMatch(/->> 'completionSmsDeferredDeliveredAt' IS NULL THEN \?::jsonb ELSE '\{\}'::jsonb END/);
  expect(JSON.parse(bindings[0])).toEqual({ completionSmsStatus: 'sent' });
  const stamp = JSON.parse(bindings[1]);
  expect(Object.keys(stamp)).toEqual(['completionSmsDeferredDeliveredAt']);
  expect(Number.isNaN(Date.parse(stamp.completionSmsDeferredDeliveredAt))).toBe(false);
});
