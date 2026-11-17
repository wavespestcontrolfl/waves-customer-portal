/**
 * Spoken staff notes and reminders (GATE_CALL_SPOKEN_NOTES, owner 2026-11-16 "ok build all, use haiku").
 *
 * Pins: gate off = nothing runs; no trigger phrase = no model call and the call is marked checked; only STAFF
 * lines are read for the trigger; two racing runs extract once; ET due times convert across both DST dates;
 * no time or a past time rings now; a due reminder rings once and is stamped; a future one waits; bad JSON saves
 * nothing and is not retried; a card number the model writes is masked; the bell's shape; nothing but call_log
 * and call_live_utterances is touched; a due reminder is not held back by older calls' future ones.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/admin-alert-names', () => ({ redactedWords: (t) => t }));

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({ messages: { create: (...args) => mockCreate(...args) } })));

const mockLedger = jest.fn((provider, model, fn) => fn());
jest.mock('../services/llm-dispatch-metrics', () => ({ ledgerCall: (...args) => mockLedger(...args) }));

const mockRaise = jest.fn();
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: (category, spec, opts) => { actual.composeAdminAlert(spec); return mockRaise(category, spec, opts); } };
});

// call_log is a list of rows; call_live_utterances a list of lines. The SQL is read the way the service writes it.
jest.mock('../models/db', () => {
  const state = { calls: [], utterances: [], touched: new Set(), updates: [] };
  const spoken = (row) => row.metadata?.live_transcription?.spoken_notes;
  function callLog() {
    const q = { raws: [], conds: {} };
    q.where = jest.fn((a, b) => { if (typeof a === 'string') q.conds[a] = b; return q; });
    q.whereRaw = jest.fn((sql, bindings) => { q.raws.push({ sql, bindings }); return q; });
    q.orderBy = jest.fn(() => q);
    q.limit = jest.fn((n) => { q.max = n; return q; });
    q.select = jest.fn(async () => {
      const sqls = q.raws.map((r) => r.sql).join(' ');
      let rows = state.calls;
      if (sqls.includes('stopped_at')) {
        const [from] = q.raws.find((r) => r.sql.includes('> ?')).bindings;
        const [to] = q.raws.find((r) => r.sql.includes('<= ?')).bindings;
        rows = rows.filter((r) => {
          const stopped = r.metadata?.live_transcription?.stopped_at;
          return stopped && Date.parse(stopped) > Date.parse(from) && Date.parse(stopped) <= Date.parse(to) && !spoken(r)?.checked_at;
        }).map((r) => ({ id: r.id, twilio_call_sid: r.twilio_call_sid }));
      } else if (sqls.includes('jsonb_path_exists')) {
        const [, nowIso] = q.raws.find((r) => r.sql.includes('jsonb_path_exists')).bindings;
        rows = rows.filter((r) => (spoken(r)?.reminders || []).some((x) => x.raised_at == null && x.due_at <= nowIso))
          .map((r) => JSON.parse(JSON.stringify({ id: r.id, created_at: r.created_at, metadata: r.metadata })));
      }
      return rows.slice(0, q.max);
    });
    q.update = jest.fn(async (patch) => {
      const row = state.calls.find((r) => r.id === q.conds.id);
      if (!row) return 0;
      const { sql, bindings } = patch.metadata;
      state.updates.push(sql);
      if (sql.includes('to_jsonb')) { // stamp one reminder's raised_at
        const idx = Number(q.raws[0].bindings[0]);
        const reminder = spoken(row).reminders[idx];
        if (reminder.raised_at != null) return 0;
        reminder.raised_at = bindings[1];
        return 1;
      }
      if (sql.includes('||')) { // save the result, only for the run that holds the claim
        if (spoken(row)?.checked_at !== q.raws.find((r) => r.sql.includes('= ?')).bindings[0]) return 0;
        Object.assign(spoken(row), JSON.parse(bindings[0]));
        return 1;
      }
      if (spoken(row)?.checked_at || !row.metadata?.live_transcription) return 0; // the claim
      row.metadata.live_transcription.spoken_notes = JSON.parse(bindings[0]);
      return 1;
    });
    return q;
  }
  function utterances() {
    const q = {};
    q.where = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.limit = jest.fn(() => q);
    q.select = jest.fn(async () => state.utterances.map((u) => ({ speaker: u.speaker, text: u.text })));
    return q;
  }
  const db = jest.fn((table) => {
    state.touched.add(table);
    if (table === 'call_log') return callLog();
    if (table === 'call_live_utterances') return utterances();
    throw new Error(`unexpected table ${table}`);
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.__state = state;
  return db;
});

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const MODELS = require('../config/models');
const spokenNotes = require('../services/live-call-spoken-notes');

const SID = 'CA' + 'b'.repeat(32);
const NOW = new Date('2026-11-17T19:00:00.000Z'); // 2:00 PM ET
const STOPPED = '2026-11-17T18:50:00.000Z';

function setCall({ stoppedAt = STOPPED, spoken, lines } = {}) {
  db.__state.calls = [{
    id: 'call-1',
    twilio_call_sid: SID,
    created_at: '2026-11-17T18:40:00.000Z',
    transcription: 'untouched transcript',
    metadata: { live_transcription: { status: 'started', stopped_at: stoppedAt, ...(spoken ? { spoken_notes: spoken } : {}) } },
  }];
  db.__state.utterances = lines || [
    { speaker: 'caller', text: 'I have ants in the kitchen.' },
    { speaker: 'staff', text: 'Okay, let me make a note that the gate code is on the lockbox.' },
    { speaker: 'caller', text: 'Great, thanks.' },
  ];
}

const reply = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
const saved = () => db.__state.calls[0].metadata.live_transcription.spoken_notes;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  isEnabled.mockReturnValue(true);
  db.__state.touched.clear();
  db.__state.updates.length = 0;
  mockCreate.mockResolvedValue(reply({ notes: [{ text: 'The gate code is on the lockbox.' }], reminders: [] }));
  mockRaise.mockResolvedValue({ id: 'n1' });
  setCall();
});

describe('gate', () => {
  it('does nothing at all when the gate is off', async () => {
    isEnabled.mockReturnValue(false);
    expect(await spokenNotes.run(NOW)).toEqual({ skipped: 'gate_off' });
    expect(isEnabled).toHaveBeenCalledWith('callSpokenNotes');
    expect(db).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRaise).not.toHaveBeenCalled();
  });
});

describe('extract', () => {
  it('marks a call with no trigger phrase as checked and never calls the model', async () => {
    setCall({ lines: [{ speaker: 'staff', text: 'We can come Tuesday.' }, { speaker: 'caller', text: 'Works for me.' }] });
    const out = await spokenNotes.run(NOW);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(out).toMatchObject({ checked: 1, asked: 0, saved: 0 });
    expect(saved()).toEqual({ checked_at: NOW.toISOString(), notes: [], reminders: [] });
    await spokenNotes.run(NOW);
    expect(db.__state.updates).toHaveLength(1); // checked once, not again
  });

  it('reads only staff lines for the trigger: a caller saying "remind me" saves no reminder and costs no model call', async () => {
    setCall({ lines: [{ speaker: 'caller', text: 'Can you remind me to call the HOA tomorrow?' }, { speaker: 'staff', text: 'Sure, happy to help.' }] });
    await spokenNotes.run(NOW);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(saved().reminders).toEqual([]);
  });

  it('sends the matching staff line with one line of context each side, plus the ET weekday, date and time', async () => {
    setCall({
      lines: [
        { speaker: 'caller', text: 'Line one far away.' },
        { speaker: 'caller', text: 'Before the note.' },
        { speaker: 'staff', text: 'Please make a note that the dog is friendly.' },
        { speaker: 'caller', text: 'After the note.' },
        { speaker: 'caller', text: 'Line five far away.' },
      ],
    });
    await spokenNotes.run(NOW);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const req = mockCreate.mock.calls[0][0];
    expect(req.model).toBe(MODELS.LIVE_CALL);
    expect(mockLedger).toHaveBeenCalledWith('anthropic', MODELS.LIVE_CALL, expect.any(Function), { laneId: 'live_call_spoken_notes' });
    const body = req.messages[0].content;
    expect(body).toContain('Now: Tuesday 2026-11-17 14:00 Eastern time.');
    expect(body).toContain('Caller: Before the note.\nAgent: Please make a note that the dog is friendly.\nCaller: After the note.');
    expect(body).not.toContain('far away');
  });

  it('saves the notes and reminders on the call with the shape the Calls tab reads, and touches nothing else', async () => {
    mockCreate.mockResolvedValue(reply({
      notes: [{ text: 'Gate code is on the lockbox.' }],
      reminders: [{ text: 'Call Jordan Example back about the quote', due_local: '2026-11-18T09:30' }],
    }));
    await spokenNotes.run(NOW);
    expect(saved()).toEqual({
      checked_at: NOW.toISOString(),
      notes: ['Gate code is on the lockbox.'],
      reminders: [{ text: 'Call Jordan Example back about the quote', due_at: '2026-11-18T14:30:00.000Z', raised_at: null }],
    });
    expect(db.__state.calls[0].transcription).toBe('untouched transcript');
    expect([...db.__state.touched].sort()).toEqual(['call_live_utterances', 'call_log']);
    expect(Object.keys(db.__state.calls[0].metadata)).toEqual(['live_transcription']);
  });

  it('masks a card number the model writes whole in a note or a reminder', async () => {
    mockCreate.mockResolvedValue(reply({
      notes: [{ text: 'Card on file is 4242 4242 4242 4242, gate code 1234.' }],
      reminders: [{ text: 'Charge 4242 4242 4242 4242 after the visit', due_local: null }],
    }));
    await spokenNotes.run(NOW);
    expect(JSON.stringify(saved())).not.toMatch(/4242 4242 4242 4242/);
    expect(saved().notes[0]).toBe('Card on file is [card ending 4242], gate code 1234.');
    expect(mockRaise.mock.calls[0][1].action).not.toMatch(/4242 4242/);
  });

  it('extracts once when two runs race', async () => {
    const [a, b] = await Promise.all([spokenNotes.run(NOW), spokenNotes.run(NOW)]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(a.checked + b.checked).toBe(1);
    expect(saved().notes).toEqual(['The gate code is on the lockbox.']);
  });

  it('skips a call whose live text stopped more than 24 hours ago, or under a minute ago', async () => {
    setCall({ stoppedAt: '2026-11-16T18:00:00.000Z' });
    expect((await spokenNotes.run(NOW)).checked).toBe(0);
    setCall({ stoppedAt: '2026-11-17T18:59:30.000Z' });
    expect((await spokenNotes.run(NOW)).checked).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('saves nothing on bad JSON, a refusal or an API error, and does not try the call again', async () => {
    for (const failure of [() => reply('I cannot do that'), () => ({ stop_reason: 'refusal', content: [] }), () => { throw Object.assign(new Error('x'), { status: 529 }); }]) {
      setCall();
      mockCreate.mockReset();
      mockCreate.mockImplementation(async () => failure());
      await spokenNotes.run(NOW);
      expect(saved()).toEqual({ checked_at: NOW.toISOString(), notes: [], reminders: [] });
      await spokenNotes.run(NOW);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockRaise).not.toHaveBeenCalled();
    }
  });

  it('caps the lists, strips control characters and drops empty or non-string entries', () => {
    const out = spokenNotes._test.validate({
      notes: Array.from({ length: 8 }, (_, i) => ({ text: `Note ${i}\u0007\n with  gaps` })).concat([{ text: '   ' }, { text: 42 }]),
      reminders: Array.from({ length: 5 }, (_, i) => ({ text: `Reminder ${i}`, due_local: i === 0 ? 'tomorrow' : '2026-11-18T09:30' })),
    });
    expect(out.notes).toHaveLength(5);
    expect(out.notes[0]).toBe('Note 0 with gaps');
    expect(out.reminders).toHaveLength(3);
    expect(out.reminders[0].due_local).toBeNull();
    expect(spokenNotes._test.validate('nope')).toBeNull();
    expect(spokenNotes._test.validate({ notes: 'x', reminders: null })).toEqual({ notes: [], reminders: [] });
    expect(spokenNotes._test.validate({ notes: [{ text: 'a'.repeat(900) }] }).notes[0]).toHaveLength(300);
  });
});

describe('due time', () => {
  it('converts Eastern wall-clock times with the offset in force that day, across both DST changes', () => {
    const { dueAt } = spokenNotes._test;
    const early = new Date('2026-02-01T12:00:00.000Z');
    expect(dueAt('2026-03-07T12:00', early)).toBe('2026-03-07T17:00:00.000Z'); // EST
    expect(dueAt('2026-03-08T12:00', early)).toBe('2026-03-08T16:00:00.000Z'); // spring forward: EDT
    const autumn = new Date('2026-10-01T12:00:00.000Z');
    expect(dueAt('2026-10-31T12:00', autumn)).toBe('2026-10-31T16:00:00.000Z'); // EDT
    expect(dueAt('2026-11-01T12:00', autumn)).toBe('2026-11-01T17:00:00.000Z'); // fall back: EST
  });

  it('treats null, unparseable, impossible and past times as due now, and holds a far date to 90 days', () => {
    const { dueAt } = spokenNotes._test;
    for (const bad of [null, undefined, 'tomorrow at 2', '2026-02-31T10:00', '2026-13-01T10:00', '2026-11-17T25:00', '2026-11-17T08:00']) {
      expect(dueAt(bad, NOW)).toBe(NOW.toISOString());
    }
    expect(dueAt('2031-01-01T10:00', NOW)).toBe(new Date(NOW.getTime() + 90 * 24 * 3600 * 1000).toISOString());
  });
});

describe('ring', () => {
  const reminderState = (over = {}) => ({
    checked_at: '2026-11-17T18:55:00.000Z',
    notes: [],
    reminders: [{ text: 'Call Jordan Example back', due_at: '2026-11-17T18:30:00.000Z', raised_at: null, ...over }],
  });

  it('rings a due reminder once, says what to do and which call, and stamps raised_at', async () => {
    setCall({ spoken: reminderState() });
    const first = await spokenNotes.run(NOW);
    await spokenNotes.run(new Date(NOW.getTime() + 120000));
    expect(first.raised).toBe(1);
    expect(mockRaise).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = mockRaise.mock.calls[0];
    expect(category).toBe('live_call_reminder');
    expect(spec).toMatchObject({
      area: 'Comms',
      action: 'Call Jordan Example back',
      why: 'Reminder you set on your 1:40 PM call; open the call to see the notes.',
      severity: 'needs-you',
      link: '/admin/communications#tab=calls&call=call-1',
      subject: { type: 'call', id: 'call-1' },
      who: 'person',
    });
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'spoken-reminder:call-1:0' });
    expect(saved().reminders[0].raised_at).toBe(NOW.toISOString());
  });

  it('does not ring a reminder that is not due yet, then rings it when its time comes', async () => {
    setCall({ spoken: reminderState({ due_at: '2026-11-17T22:00:00.000Z' }) });
    await spokenNotes.run(NOW);
    expect(mockRaise).not.toHaveBeenCalled();
    expect(saved().reminders[0].raised_at).toBeNull();
    await spokenNotes.run(new Date('2026-11-17T22:00:30.000Z'));
    expect(mockRaise).toHaveBeenCalledTimes(1);
  });

  it('a due reminder rings even when 50 older calls hold only future reminders', async () => {
    const row = (id, dueAt) => ({
      id,
      twilio_call_sid: SID,
      created_at: '2026-11-17T18:40:00.000Z',
      metadata: { live_transcription: { stopped_at: STOPPED, spoken_notes: reminderState({ due_at: dueAt }) } },
    });
    db.__state.calls = [
      ...Array.from({ length: 50 }, (_, i) => row(`future-${i}`, '2026-11-20T15:00:00.000Z')),
      row('due-1', '2026-11-17T18:30:00.000Z'),
    ];
    const out = await spokenNotes.run(NOW);
    expect(out.raised).toBe(1);
    expect(mockRaise).toHaveBeenCalledTimes(1);
    expect(mockRaise.mock.calls[0][2].dedupeKey).toBe('spoken-reminder:due-1:0');
  });

  it('rings a reminder with no time (or a past time) on the same run that saves it', async () => {
    mockCreate.mockResolvedValue(reply({ notes: [], reminders: [{ text: 'Send the quote', due_local: null }, { text: 'Check the lockbox', due_local: '2026-11-17T08:00' }] }));
    const out = await spokenNotes.run(NOW);
    expect(out).toMatchObject({ saved: 1, raised: 2 });
    expect(mockRaise.mock.calls.map((c) => c[2].dedupeKey)).toEqual(['spoken-reminder:call-1:0', 'spoken-reminder:call-1:1']);
    expect(saved().reminders.every((r) => r.raised_at)).toBe(true);
  });

  it('leaves a reminder unstamped when the bell fails, so the next run tries again', async () => {
    setCall({ spoken: reminderState() });
    mockRaise.mockRejectedValueOnce(new Error('db down'));
    await spokenNotes.run(NOW);
    expect(saved().reminders[0].raised_at).toBeNull();
    await spokenNotes.run(NOW);
    expect(saved().reminders[0].raised_at).toBe(NOW.toISOString());
    expect(mockRaise).toHaveBeenCalledTimes(2);
  });

  it('keeps a long or odd reminder inside the headline rules', () => {
    const { actionFrom, whyFrom } = spokenNotes._test;
    const action = actionFrom('Call the Example family back about the termite inspection report that they asked for on Tuesday afternoon.');
    expect(`Comms — ${action}`.length).toBeLessThanOrEqual(60);
    expect(actionFrom('Check the call_log slot')).toBe('do the reminder you set on a call');
    expect(whyFrom(null)).toBe('Reminder you set on a call; open the call to see the notes.');
  });
});
