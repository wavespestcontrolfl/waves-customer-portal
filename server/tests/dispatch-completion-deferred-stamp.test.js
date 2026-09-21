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

const { finalizeDeferredCompletionSend, stripPayLinkLineFromBody } = require('../services/dispatch-completion-deferred');

describe('stripPayLinkLineFromBody (round 9 #4634 finding 1)', () => {
  const payUrl = 'https://pay.wavespestcontrol.com/i/abc123';

  test('removes the whole line the pay link rides on, keeping the report link and collapsing the blank run it leaves', () => {
    const body = `Hello Jane! Pest Control report: https://portal.example.invalid/r/xyz\n\nInvoice: ${payUrl}\n\nReply STOP to opt out.`;
    const stripped = stripPayLinkLineFromBody(body, payUrl);
    expect(stripped).not.toContain(payUrl);
    expect(stripped).toContain('Pest Control report: https://portal.example.invalid/r/xyz');
    expect(stripped).toContain('Reply STOP to opt out.');
    expect(stripped).not.toMatch(/\n{3,}/);
  });

  test('the longer "Invoice for today\'s visit" phrasing and every historical template variant strip the same way', () => {
    const body = `Hello Jane! Your Pest Control report is ready: https://portal.example.invalid/r/xyz\n\nInvoice for today's visit: ${payUrl}\n\nQuestions or requests? Reply here.`;
    const stripped = stripPayLinkLineFromBody(body, payUrl);
    expect(stripped).not.toContain(payUrl);
    expect(stripped).toContain('report is ready');
    expect(stripped).toContain('Questions or requests? Reply here.');
  });

  test('a body with no pay link at all (already stripped, or never had one) is returned unchanged', () => {
    const body = 'Hello Jane! Pest Control report: https://portal.example.invalid/r/xyz';
    expect(stripPayLinkLineFromBody(body, payUrl)).toBe(body);
  });

  test('is idempotent — stripping an already-stripped body is a no-op', () => {
    const body = `Hello Jane! Pest Control report: https://portal.example.invalid/r/xyz\n\nInvoice: ${payUrl}`;
    const once = stripPayLinkLineFromBody(body, payUrl);
    const twice = stripPayLinkLineFromBody(once, payUrl);
    expect(twice).toBe(once);
  });

  test('defensive: a body that is nothing but the pay-link line is returned as-is rather than emptied', () => {
    const body = `Invoice: ${payUrl}`;
    expect(stripPayLinkLineFromBody(body, payUrl)).toBe(body);
  });

  test('non-string body or missing pay_url passes through unchanged', () => {
    expect(stripPayLinkLineFromBody(null, payUrl)).toBeNull();
    expect(stripPayLinkLineFromBody('hello', null)).toBe('hello');
    expect(stripPayLinkLineFromBody('hello', undefined)).toBe('hello');
  });
});

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
