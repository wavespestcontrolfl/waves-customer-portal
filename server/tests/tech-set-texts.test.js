/**
 * Set texts (GATE_TECH_SET_TEXTS): the fixed wording, the one-claim-per-visit
 * key, the today's-open-visit check, and the reply match that the Visit
 * Brief's Last reply card shows — never a reply that could belong to another
 * visit of the same customer.
 */
const {
  SET_TEXT_KINDS, isSetTextKind, setTextOptions, renderSetText, setTextClaimKey, openSetTextVisit, setTextReply,
  _test: { greeting },
} = require('../services/tech-set-texts');
const { countSegments } = require('../services/messaging/segment-counter');
const { etDateString } = require('../utils/datetime-et');

const VISIT = '11111111-1111-4111-8111-111111111111';
const OTHER_VISIT = '33333333-3333-4333-8333-333333333333';
const LINE = '+19413529161';
const OTHER_LINE = '+19415550199';
const PHONE = '+19415550100';
const NOW = new Date('2026-11-02T16:00:00Z');

// A knex-shaped fake: each table answers from `rows[table]`; every call is recorded.
function fakeConn(rows = {}) {
  const calls = [];
  const conn = jest.fn((table) => {
    const q = { table, ops: [] };
    calls.push(q);
    const chain = {};
    for (const op of ['where', 'whereNotNull', 'whereRaw', 'orderBy', 'select']) {
      chain[op] = jest.fn((...args) => { q.ops.push([op, ...args]); return op === 'select' ? Promise.resolve(rows[table] || []) : chain; });
    }
    chain.first = jest.fn(async (...cols) => { q.ops.push(['first', ...cols]); return (rows[table] || [])[0] || undefined; });
    return chain;
  });
  conn.calls = calls;
  return conn;
}
const SIBLING = '44444444-4444-4444-8444-444444444444';
const SID = `SM${'b'.repeat(32)}`;
const send = (over = {}) => ({
  sent_at: new Date('2026-11-02T15:00:00Z'),
  metadata: { set_text_kind: 'gate_locked', scheduled_service_id: VISIT, fromNumber: LINE },
  provider_message_id: SID,
  blocked_code: null,
  ...over,
});

describe('wording', () => {
  test('three kinds, each with a label', () => {
    expect(SET_TEXT_KINDS).toEqual(['gate_locked', 'dog_outside', 'garage_access']);
    expect(setTextOptions().map((o) => o.label)).toEqual(['Back gate locked', 'Dog outside', 'Need garage access']);
    expect(isSetTextKind('gate_locked')).toBe(true);
    expect(isSetTextKind('running_late')).toBe(false);
    expect(isSetTextKind('__proto__')).toBe(false);
    expect(() => renderSetText('running_late', {})).toThrow(/unknown set text/);
  });

  test('greets by the first word of the first name, or "Hi there"', () => {
    expect(greeting({ first_name: 'Maria' })).toBe('Hi Maria');
    expect(greeting({ first_name: '  Maria & Juan ' })).toBe('Hi Maria');
    expect(greeting({ first_name: "O'Neil" })).toBe("Hi O'Neil");
    expect(greeting({ first_name: '' })).toBe('Hi there');
    expect(greeting({ first_name: null })).toBe('Hi there');
    expect(greeting({ first_name: 'ACME123' })).toBe('Hi there');
    expect(greeting(null)).toBe('Hi there');
  });

  test('every set text is one plain text (one GSM-7 segment) with a 12-letter first name', () => {
    for (const kind of SET_TEXT_KINDS) {
      const body = renderSetText(kind, { first_name: 'Christabelle' });
      const meta = countSegments(body);
      expect({ kind, encoding: meta.encoding, segments: meta.segmentCount }).toEqual({ kind, encoding: 'GSM_7', segments: 1 });
    }
  });

  test('the claim key is per visit and kind', () => {
    expect(setTextClaimKey(VISIT, 'dog_outside')).toBe(`tech-set-text:${VISIT}:dog_outside`);
  });
});

describe('openSetTextVisit', () => {
  test('today (ET) and not ended', async () => {
    const conn = fakeConn({ scheduled_services: [{ id: VISIT }] });
    expect(await openSetTextVisit(conn, VISIT, NOW)).toBe(true);
    const ops = conn.calls[0].ops;
    expect(ops).toContainEqual(['where', { id: VISIT }]);
    expect(ops).toContainEqual(['where', 'scheduled_date', etDateString(NOW)]);
    const raw = ops.find((o) => o[0] === 'whereRaw');
    expect(raw[1]).toMatch(/COALESCE\(status, 'pending'\) NOT IN/);
    expect(raw[2]).toEqual(['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled']);
    expect(await openSetTextVisit(fakeConn({ scheduled_services: [] }), VISIT, NOW)).toBe(false);
  });
});

describe('setTextReply', () => {
  const args = { customerId: 'c1', customerPhone: PHONE, lineNumber: LINE, visitIds: [VISIT], now: NOW };

  test('no set text for this visit on this line: nothing to show, and no reply read', async () => {
    const conn = fakeConn({ messaging_audit_log: [send({ metadata: { set_text_kind: 'gate_locked', scheduled_service_id: VISIT, fromNumber: OTHER_LINE } })] });
    expect(await setTextReply(conn, args)).toEqual({ setText: null, reply: null, ambiguous: false });
    expect(conn.calls.map((c) => c.table)).toEqual(['messaging_audit_log']);
  });

  test('reads only accepted set texts from the window', async () => {
    const conn = fakeConn({ messaging_audit_log: [] });
    await setTextReply(conn, args);
    const ops = conn.calls[0].ops;
    expect(ops).toContainEqual(['where', { customer_id: 'c1', entry_point: 'tech_line_text' }]);
    expect(ops).toContainEqual(['whereNotNull', 'sent_at']);
    expect(ops).toContainEqual(['whereNotNull', 'provider_message_id']);
    expect(ops).toContainEqual(['where', 'sent_at', '>=', new Date('2026-11-02T04:00:00Z')]);
    expect(ops).toContainEqual(['whereRaw', "metadata->>'set_text_kind' IS NOT NULL"]);
  });

  test('the newest answer after the set text, from the customer\'s phone to this line', async () => {
    const conn = fakeConn({
      messaging_audit_log: [send()],
      sms_log: [{ message_body: 'Unlocked it, go ahead', created_at: new Date('2026-11-02T15:04:00Z'), metadata: { media: [{}] } }],
    });
    expect(await setTextReply(conn, args)).toEqual({
      setText: { kind: 'gate_locked', label: 'Back gate locked', sentAt: new Date('2026-11-02T15:00:00Z') },
      reply: { body: 'Unlocked it, go ahead', receivedAt: new Date('2026-11-02T15:04:00Z'), mediaCount: 1 },
      ambiguous: false,
    });
    const ops = conn.calls[1].ops;
    expect(ops).toContainEqual(['where', { direction: 'inbound', from_phone: PHONE, to_phone: LINE }]);
    expect(ops).toContainEqual(['where', 'created_at', '>', new Date('2026-11-02T15:00:00Z')]);
    expect(ops).toContainEqual(['orderBy', 'created_at', 'desc']);
  });

  test('a send the gate suppressed (sentinel id) or a blocked attempt is not a set text', async () => {
    for (const row of [send({ provider_message_id: 'gate-blocked' }), send({ blocked_code: 'SUPPRESSED' })]) {
      const conn = fakeConn({ messaging_audit_log: [row], sms_log: [{ message_body: 'ok', created_at: new Date('2026-11-02T15:04:00Z') }] });
      expect(await setTextReply(conn, args)).toEqual({ setText: null, reply: null, ambiguous: false });
    }
  });

  test('a grouped stop: a set text sent for any of its visits is the stop\'s, and does not make it ambiguous', async () => {
    const conn = fakeConn({
      messaging_audit_log: [send({ metadata: { set_text_kind: 'dog_outside', scheduled_service_id: SIBLING, fromNumber: LINE } }), send()],
      sms_log: [{ message_body: 'Dog is in', created_at: new Date('2026-11-02T15:20:00Z') }],
    });
    expect(await setTextReply(conn, { ...args, visitIds: [VISIT, SIBLING] })).toMatchObject({
      setText: { kind: 'dog_outside' }, reply: { body: 'Dog is in' }, ambiguous: false,
    });
  });

  test('a set text with no answer yet', async () => {
    const conn = fakeConn({ messaging_audit_log: [send()], sms_log: [] });
    expect(await setTextReply(conn, args)).toMatchObject({ setText: { kind: 'gate_locked' }, reply: null, ambiguous: false });
  });

  test('a set text for ANOTHER visit of this customer on this line makes any answer ambiguous — shown on neither', async () => {
    const conn = fakeConn({
      messaging_audit_log: [
        send({ sent_at: new Date('2026-11-02T15:30:00Z'), metadata: { set_text_kind: 'dog_outside', scheduled_service_id: OTHER_VISIT, fromNumber: LINE } }),
        send(),
      ],
      sms_log: [{ message_body: 'ok', created_at: new Date('2026-11-02T15:40:00Z') }],
    });
    expect(await setTextReply(conn, args)).toMatchObject({ setText: { kind: 'gate_locked' }, reply: null, ambiguous: true });
    expect(conn.calls.map((c) => c.table)).toEqual(['messaging_audit_log']);
  });

  test('another line\'s set text for another visit does not make this line\'s answer ambiguous', async () => {
    const conn = fakeConn({
      messaging_audit_log: [
        send({ metadata: { set_text_kind: 'dog_outside', scheduled_service_id: OTHER_VISIT, fromNumber: OTHER_LINE } }),
        send(),
      ],
      sms_log: [{ message_body: 'ok', created_at: new Date('2026-11-02T15:40:00Z') }],
    });
    expect(await setTextReply(conn, args)).toMatchObject({ reply: { body: 'ok' }, ambiguous: false });
  });

  test('metadata stored as a JSON string still matches; a long answer is cut to a preview', async () => {
    const conn = fakeConn({
      messaging_audit_log: [send({ metadata: JSON.stringify({ set_text_kind: 'garage_access', scheduled_service_id: VISIT, fromNumber: LINE }) })],
      sms_log: [{ message_body: 'x'.repeat(500), created_at: new Date('2026-11-02T15:10:00Z'), metadata: null }],
    });
    const out = await setTextReply(conn, args);
    expect(out.setText.label).toBe('Need garage access');
    expect(out.reply.body).toHaveLength(320);
    expect(out.reply.mediaCount).toBe(0);
  });
});
