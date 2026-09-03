// Pure behaviour behind the Owed queue: which open promises count as
// overdue, and what the AI phone assistant's transcript yields as
// commitments. Fixtures fictitious.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  isOverdue,
  selectOverdue,
  implicitDueAt,
  callEndedAt,
  deriveRelayCommitments,
  OVERDUE_IMPLICIT_DAYS,
  OVERDUE_IMPLICIT_ESTIMATE_HOURS,
  PROMPT_KINDS,
} = require('../services/call-commitments');

// 11:00 ET on Friday Sep 5.
const NOW = new Date('2026-09-05T15:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const hoursAgo = (n) => new Date(NOW.getTime() - n * 60 * 60 * 1000).toISOString();

describe('deriveRelayCommitments in Spanish', () => {
  const { COPY } = require('../services/voice-agent/relay-language');
  test('the deterministic Spanish closes and the model\'s Spanish wording yield the same callback / estimate promises as English', () => {
    const t = (line) => `Caller: Hola\nAgent: ${line}\n`;
    expect(deriveRelayCommitments({ transcript: t(COPY.unavailable.es) }).map((i) => i.kind)).toEqual(['callback']);
    expect(deriveRelayCommitments({ transcript: t(COPY.turnCap.es) }).map((i) => i.kind)).toEqual(['callback']);
    expect(deriveRelayCommitments({ transcript: t(COPY.toolRounds.es) }).map((i) => i.kind)).toEqual(['callback']);
    expect(deriveRelayCommitments({ transcript: t('Perfecto, le enviaremos un presupuesto por escrito en unos 15 minutos.') }).map((i) => i.kind)).toEqual(['send_estimate']);
    expect(deriveRelayCommitments({ transcript: t('La cotización se le enviará por correo.') }).map((i) => i.kind)).toEqual(['send_estimate']);
    // A Spanish CALLER line never becomes a Waves promise.
    expect(deriveRelayCommitments({ transcript: 'Caller: ¿Me pueden devolver la llamada?\nAgent: Claro, ¿cuál es su dirección?\n' })).toEqual([]);
    // The English deterministic closes still match.
    expect(deriveRelayCommitments({ transcript: t(COPY.unavailable.en) }).map((i) => i.kind)).toEqual(['callback']);
    expect(deriveRelayCommitments({ transcript: t(COPY.turnCap.en) }).map((i) => i.kind)).toEqual(['callback']);
    expect(deriveRelayCommitments({ transcript: t(COPY.toolRounds.en) }).map((i) => i.kind)).toEqual(['callback']);
  });
});

describe('isOverdue / selectOverdue', () => {
  test('a stated due time in the past is overdue; in the future is not', () => {
    expect(isOverdue({ status: 'open', party: 'waves', kind: 'callback', due_at: daysAgo(1) }, NOW)).toBe(true);
    expect(isOverdue({ status: 'open', party: 'waves', kind: 'callback', due_at: new Date(NOW.getTime() + 3600000).toISOString() }, NOW)).toBe(false);
  });
  test('with no due time the implicit deadline keeps what the replaced lanes enforced: an estimate within 24 hours, a callback by the end of the call\'s ET day, the other prompt kinds within the implicit window', () => {
    expect(isOverdue({ status: 'open', party: 'waves', kind: 'send_estimate', due_at: null, call_started_at: hoursAgo(OVERDUE_IMPLICIT_ESTIMATE_HOURS + 1) }, NOW)).toBe(true);
    expect(isOverdue({ status: 'open', party: 'waves', kind: 'send_estimate', due_at: null, call_started_at: hoursAgo(OVERDUE_IMPLICIT_ESTIMATE_HOURS - 1) }, NOW)).toBe(false);
    // A callback asked for yesterday evening was owed by midnight ET; one from this morning still has the day.
    expect(isOverdue({ status: 'open', party: 'waves', kind: 'callback', due_at: null, call_started_at: '2026-09-04T22:00:00-04:00' }, NOW)).toBe(true);
    expect(isOverdue({ status: 'open', party: 'waves', kind: 'callback', due_at: null, call_started_at: '2026-09-05T09:00:00-04:00' }, NOW)).toBe(false);
    expect(implicitDueAt({ party: 'waves', kind: 'callback', call_started_at: '2026-09-04T22:00:00-04:00' }).toISOString()).toBe(new Date('2026-09-05T00:00:00-04:00').toISOString());
    for (const kind of [...PROMPT_KINDS].filter((k) => k !== 'send_estimate' && k !== 'callback')) {
      expect(isOverdue({ status: 'open', party: 'waves', kind, due_at: null, call_started_at: daysAgo(OVERDUE_IMPLICIT_DAYS + 1) }, NOW)).toBe(true);
      expect(isOverdue({ status: 'open', party: 'waves', kind, due_at: null, call_started_at: daysAgo(OVERDUE_IMPLICIT_DAYS - 1) }, NOW)).toBe(false);
    }
    expect(implicitDueAt({ party: 'waves', kind: 'technician_follow_up', call_started_at: daysAgo(30) })).toBeNull();
    expect(implicitDueAt({ party: 'customer', kind: 'send_photos', call_started_at: daysAgo(30) })).toBeNull();
  });
  test('a human-recorded promise ages from the moment it was recorded, not from a call that may be weeks old', () => {
    const base = { status: 'open', party: 'waves', kind: 'send_estimate', source: 'human', due_at: null, call_started_at: daysAgo(30) };
    expect(isOverdue({ ...base, created_at: hoursAgo(1) }, NOW)).toBe(false);
    expect(isOverdue({ ...base, created_at: hoursAgo(OVERDUE_IMPLICIT_ESTIMATE_HOURS + 1) }, NOW)).toBe(true);
    expect(isOverdue({ ...base, source: 'ai', created_at: hoursAgo(1) }, NOW)).toBe(true);
  });
  test('callEndedAt is the promised-estimate watcher\'s end-of-call boundary: ring + duration for inbound rows, bridge + duration when bridged, created_at otherwise', () => {
    const created = '2026-09-05T14:00:00Z';
    expect(callEndedAt({ direction: 'inbound', created_at: created, duration_seconds: 90 }).toISOString()).toBe('2026-09-05T14:01:30.000Z');
    expect(callEndedAt({ direction: 'inbound', created_at: created, bridged_at: '2026-09-05T14:00:20Z', duration_seconds: 90 }).toISOString()).toBe('2026-09-05T14:01:50.000Z');
    expect(callEndedAt({ direction: 'outbound', created_at: created, duration_seconds: 90 }).toISOString()).toBe('2026-09-05T14:00:00.000Z');
    expect(callEndedAt({ direction: 'inbound', created_at: created, duration_seconds: null }).toISOString()).toBe('2026-09-05T14:00:00.000Z');
    expect(callEndedAt({ direction: 'inbound', created_at: null })).toBeNull();
  });
  test('scheduling kinds without a date, customer promises, dismissed and non-open rows never count', () => {
    expect(isOverdue({ status: 'open', party: 'waves', kind: 'technician_follow_up', due_at: null, call_started_at: daysAgo(30) }, NOW)).toBe(false);
    expect(isOverdue({ status: 'open', party: 'waves', kind: 'schedule_visit', due_at: null, call_started_at: daysAgo(30) }, NOW)).toBe(false);
    expect(isOverdue({ status: 'open', party: 'customer', kind: 'send_photos', due_at: daysAgo(5) }, NOW)).toBe(true);
    expect(isOverdue({ status: 'open', party: 'customer', kind: 'send_photos', due_at: null, call_started_at: daysAgo(30) }, NOW)).toBe(false);
    expect(isOverdue({ status: 'open', party: 'waves', kind: 'callback', due_at: daysAgo(5), human_state: 'dismissed' }, NOW)).toBe(false);
    expect(isOverdue({ status: 'fulfilled', party: 'waves', kind: 'callback', due_at: daysAgo(5) }, NOW)).toBe(false);
  });
  test('selectOverdue keeps order and only the overdue rows', () => {
    const rows = [
      { id: 'a', status: 'open', party: 'waves', kind: 'callback', due_at: daysAgo(2) },
      { id: 'b', status: 'open', party: 'waves', kind: 'send_estimate', due_at: null, call_started_at: daysAgo(1) },
      { id: 'c', status: 'open', party: 'waves', kind: 'send_report', due_at: null, call_started_at: daysAgo(10) },
    ];
    expect(selectOverdue(rows, { now: NOW }).map((r) => r.id)).toEqual(['a', 'c']);
  });
});

describe('deriveRelayCommitments — the AI phone assistant\'s promises', () => {
  const transcript = [
    'Caller: Hi, I have ants in the kitchen.',
    'Agent: I can help with that. Can I get your address?',
    'Caller: 123 Fixture Lane, Bradenton.',
    'Agent: Thank you. The office is open, so someone will call you back shortly to get you scheduled.',
    '[tool] capture_lead',
    'Agent: You are all set. Is there anything else?',
  ].join('\n');

  test('a callback promise in an AGENT line becomes a callback commitment with that line as evidence', () => {
    const items = deriveRelayCommitments({ transcript });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ party: 'waves', kind: 'callback', channel: 'call', origin: 'relay', confidence: 0.75 });
    // The whole agent line is the evidence — verbatim, never trimmed to the match.
    expect(items[0].evidence).toEqual([{ quote: 'Thank you. The office is open, so someone will call you back shortly to get you scheduled.', speaker: 'agent' }]);
  });

  test('an OFFER or a REFUSAL that contains the phrase is not a promise; only the clause that carries the match is judged (codex #3725 r16 P2)', () => {
    expect(deriveRelayCommitments({ transcript: 'Agent: Would you like me to call you back?' })).toEqual([]);
    expect(deriveRelayCommitments({ transcript: 'Agent: Do you want me to send you an estimate?' })).toEqual([]);
    expect(deriveRelayCommitments({ transcript: 'Agent: I can\'t send you an estimate yet.' })).toEqual([]);
    expect(deriveRelayCommitments({ transcript: 'Agent: I will not be able to send you a written estimate today.' })).toEqual([]);
    expect(deriveRelayCommitments({ transcript: 'Agent: ¿Quiere que le devolvamos la llamada?' })).toEqual([]);
    expect(deriveRelayCommitments({ transcript: 'Agent: No puedo enviarle un presupuesto por escrito ahora.' })).toEqual([]);
    // The refusal and the promise live in different clauses: the promise stands, with the full line as evidence.
    const mixed = deriveRelayCommitments({ transcript: 'Agent: I can\'t send you an estimate yet, but someone will call you back this afternoon.' });
    expect(mixed.map((i) => i.kind)).toEqual(['callback']);
    expect(mixed[0].evidence[0].quote).toContain('someone will call you back');
    // An OFFER followed by a real promise in the same line: the offer is skipped, the promise recorded (codex #3725 r17 P2).
    expect(deriveRelayCommitments({ transcript: 'Agent: Would you like me to call you back? Someone will follow up tomorrow.' }).map((i) => i.kind)).toEqual(['callback']);
    // An affirmative promise after a question in the same line still counts.
    expect(deriveRelayCommitments({ transcript: 'Agent: Is this the best number? Someone will call you back shortly.' }).map((i) => i.kind)).toEqual(['callback']);
  });

  test('caller lines never create promises, and tool lines are ignored', () => {
    const items = deriveRelayCommitments({ transcript: 'Caller: will you call me back?\n[tool] call you back\nAgent: Let me check.' });
    expect(items).toEqual([]);
  });

  test('a queued estimate (tool-confirmed) is a send_estimate commitment even without matching wording', () => {
    const items = deriveRelayCommitments({ transcript: 'Agent: I have everything I need.', estimateQueued: true });
    expect(items).toEqual([expect.objectContaining({ kind: 'send_estimate', confidence: 0.9, origin: 'relay_tool', evidence: [] })]);
  });

  test('estimate wording is upgraded to tool-confirmed confidence when the tool queued it, and dropped when the tool refused', () => {
    const t = 'Agent: The written estimate usually goes out in about 15 minutes.';
    expect(deriveRelayCommitments({ transcript: t, estimateQueued: true })[0]).toMatchObject({ kind: 'send_estimate', confidence: 0.95, origin: 'relay' });
    expect(deriveRelayCommitments({ transcript: t, estimateQueued: false })).toEqual([]);
    // The spoken "about 15 minutes" is a stated deadline; the office-closed
    // wordings name no time and keep the implicit window.
    const now = new Date('2026-09-02T14:00:00Z');
    expect(deriveRelayCommitments({ transcript: t, estimateQueued: true, estimateExpectation: 'about_15_minutes', now })[0]).toMatchObject({ due_at: '2026-09-02T14:15:00.000Z', due_basis: 'stated' });
    expect(deriveRelayCommitments({ transcript: t, estimateQueued: true, estimateExpectation: 'when_office_opens', now })[0]).toMatchObject({ due_at: null, due_basis: null });
    expect(deriveRelayCommitments({ transcript: 'Agent: I have everything I need.', estimateQueued: true, estimateExpectation: 'about_15_minutes', now })[0]).toMatchObject({ kind: 'send_estimate', due_at: '2026-09-02T14:15:00.000Z', due_basis: 'stated' });
    // The 15 minutes run from when capture_lead spoke the expectation, not from a close ten minutes later.
    expect(deriveRelayCommitments({ transcript: 'Agent: I have everything I need.', estimateQueued: true, estimateExpectation: 'about_15_minutes', estimatePromisedAt: '2026-09-02T13:50:00.000Z', now })[0]).toMatchObject({ due_at: '2026-09-02T14:05:00.000Z' });
    expect(deriveRelayCommitments({ transcript: t, estimateQueued: null })[0]).toMatchObject({ kind: 'send_estimate', confidence: 0.75 });
  });

  test('empty or missing transcript yields nothing', () => {
    expect(deriveRelayCommitments({ transcript: '' })).toEqual([]);
    expect(deriveRelayCommitments({})).toEqual([]);
  });
});
