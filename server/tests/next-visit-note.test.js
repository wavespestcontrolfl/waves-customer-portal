/**
 * The next-visit adjustment note (owner decision 2026-10-12): the pure rules in services/next-visit-note.js,
 * and the transaction wrapper against a recording fake. The real completion path is covered by
 * complete-scheduled-service-next-visit-note-postgres.test.js.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  storeNextVisitNote, cleanNextVisitNote, nextVisitNoteLine, isLiveNextVisitTarget, appendNextVisitNoteText,
  NEXT_VISIT_NOTE_MAX_CHARS, VISIT_NOTES_MAX_CHARS, DEAD_VISIT_STATUSES,
} = require('../services/next-visit-note');

// The fixtures use fixed dates; the clock is pinned so "future today" does not depend on the run date.
beforeAll(() => { jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'], now: new Date('2026-10-12T16:00:00Z') }); });
afterAll(() => { jest.useRealTimers(); });

describe('the note line', () => {
  test('is "[From M/D visit] note" from the completed visit\'s ET calendar day, no leading zeros', () => {
    expect(nextVisitNoteLine('2026-10-02', 'Gate code changed')).toBe('[From 10/2 visit] Gate code changed');
    // A DATE column read as UTC midnight is that calendar day, not the evening before in ET.
    expect(nextVisitNoteLine(new Date('2026-10-12T00:00:00.000Z'), 'x')).toBe('[From 10/12 visit] x');
  });

  test('is one line, trimmed and capped at the box limit', () => {
    expect(cleanNextVisitNote('  call first \n then   knock  ')).toBe('call first then knock');
    expect(cleanNextVisitNote('a'.repeat(NEXT_VISIT_NOTE_MAX_CHARS + 50))).toHaveLength(NEXT_VISIT_NOTE_MAX_CHARS);
    expect(cleanNextVisitNote(42)).toBe('');
    expect(nextVisitNoteLine('2026-10-12', '   ')).toBeNull();
    expect(nextVisitNoteLine(null, 'x')).toBeNull();
  });
});

describe('which visit may take the note', () => {
  const completed = { id: 'v1', customerId: 'c1', date: '2026-10-12' };
  const target = { id: 'v2', customer_id: 'c1', scheduled_date: '2026-11-12', status: 'confirmed', technician_id: 't1' };
  const ok = (over, actor, today = '2026-10-12') => isLiveNextVisitTarget({ target: { ...target, ...over }, completed, actor, today });

  // A backfill or a late retry: the id the card showed is no longer a future visit today.
  test('a posted visit whose day has come is refused', () => {
    expect(ok({}, undefined, '2026-11-12')).toBe(false);
    expect(ok({}, undefined, '2026-11-13')).toBe(false);
    expect(ok({}, undefined, '2026-11-11')).toBe(true);
  });

  test('the same customer\'s later, live visit', () => {
    expect(ok({})).toBe(true);
    expect(ok({ scheduled_date: new Date('2026-11-12T00:00:00.000Z') })).toBe(true);
  });

  test.each([
    ['another customer\'s visit', { customer_id: 'c2' }],
    ['the completed visit itself', { id: 'v1' }],
    ['a visit on the same day', { scheduled_date: '2026-10-12' }],
    ['an earlier visit', { scheduled_date: '2026-10-01' }],
    ['no customer', { customer_id: null }],
    ['no date', { scheduled_date: null }],
    ...DEAD_VISIT_STATUSES.map((status) => [`a ${status} visit`, { status }]),
  ])('not %s', (_label, over) => {
    expect(ok(over)).toBe(false);
  });

  test('a technician only reaches a visit assigned to them, as the next-visit route scopes it', () => {
    expect(ok({}, { techRole: 'technician', technicianId: 't1' })).toBe(true);
    expect(ok({}, { techRole: 'technician', technicianId: 't9' })).toBe(false);
    expect(ok({}, { techRole: 'technician' })).toBe(false);
    expect(ok({ technician_id: null }, { techRole: 'technician', technicianId: 't1' })).toBe(false);
    expect(ok({ technician_id: 't9' }, { techRole: 'admin' })).toBe(true);
  });
});

describe('the append rule', () => {
  const line = '[From 10/12 visit] Gate code changed';

  test('appends on a new line and keeps every character of the existing note', () => {
    expect(appendNextVisitNoteText('Dog in back yard', line)).toEqual({ outcome: 'append', notes: `Dog in back yard\n${line}` });
    expect(appendNextVisitNoteText('', line)).toEqual({ outcome: 'append', notes: line });
    expect(appendNextVisitNoteText(null, line)).toEqual({ outcome: 'append', notes: line });
    expect(appendNextVisitNoteText('  \n', line)).toEqual({ outcome: 'append', notes: line });
  });

  test('a line already there is left alone (a retry never doubles it)', () => {
    expect(appendNextVisitNoteText(`Dog in back yard\n${line}`, line)).toEqual({ outcome: 'present' });
    expect(appendNextVisitNoteText(`${line}\nMore`, line)).toEqual({ outcome: 'present' });
  });

  test('a different note on the same day is a different line and does append', () => {
    const other = appendNextVisitNoteText(line, '[From 10/12 visit] Skip the side yard');
    expect(other.outcome).toBe('append');
    expect(other.notes.split('\n')).toHaveLength(2);
  });

  test('over the 2000-character cap: nothing is written and the existing note is never cut', () => {
    const exactFit = 'x'.repeat(VISIT_NOTES_MAX_CHARS - line.length - 1);
    expect(appendNextVisitNoteText(exactFit, line).outcome).toBe('append');
    expect(appendNextVisitNoteText(`${exactFit}x`, line)).toEqual({ outcome: 'too_long' });
  });
});

// A recording fake of the knex surface storeNextVisitNote uses, on a "transaction" (isTransaction false: no savepoints).
function fakeTrx(rows) {
  const updates = [];
  const k = (table) => {
    expect(table).toBe('scheduled_services');
    const state = { where: [], locked: false };
    const q = {
      where(c) { if (typeof c === 'object') state.where.push(c); return q; },
      whereNot() { return q; }, whereNotIn() { return q; },
      orderBy() { return q; },
      forUpdate() { state.locked = true; return q; },
      skipLocked() { return q; },
      update(patch) { updates.push({ id: state.where[0]?.id, patch }); return Promise.resolve(1); },
      first() {
        const id = state.where[0]?.id;
        const hit = id ? rows.find((r) => r.id === id) : rows.find((r) => r.fallback);
        return Promise.resolve(hit && { ...hit });
      },
    };
    return q;
  };
  return { k, updates };
}

describe('storeNextVisitNote', () => {
  const completed = { id: 'v1', customerId: 'c1', date: '2026-10-12' };
  const UUID = '11111111-1111-4111-8111-111111111111';
  const row = (over) => ({ id: UUID, customer_id: 'c1', scheduled_date: '2026-11-12', status: 'confirmed', technician_id: null, notes: 'Dog out back', ...over });

  test('no note: nothing is read or written', async () => {
    const { k, updates } = fakeTrx([row()]);
    expect(await storeNextVisitNote(k, { completed, note: '  ', nextVisitId: UUID })).toEqual({ status: 'skipped' });
    expect(updates).toEqual([]);
  });

  test('a valid posted visit takes the line, existing text kept', async () => {
    const { k, updates } = fakeTrx([row()]);
    expect(await storeNextVisitNote(k, { completed, note: 'Gate code changed', nextVisitId: UUID })).toEqual({ status: 'written', targetId: UUID });
    expect(updates).toEqual([{ id: UUID, patch: { notes: 'Dog out back\n[From 10/12 visit] Gate code changed' } }]);
  });

  test('a posted id that is not a uuid, or that fails the checks, falls back to the customer\'s own next visit', async () => {
    const fallback = row({ id: '22222222-2222-4222-8222-222222222222', fallback: true });
    for (const nextVisitId of ['not-a-uuid', null, UUID]) {
      const rows = [fallback, ...(nextVisitId === UUID ? [row({ customer_id: 'other-customer' })] : [])];
      const { k, updates } = fakeTrx(rows);
      const out = await storeNextVisitNote(k, { completed, note: 'Gate code changed', nextVisitId });
      expect(out).toEqual({ status: 'written', targetId: fallback.id });
      expect(updates).toHaveLength(1);
      expect(updates[0].id).toBe(fallback.id);
    }
  });

  test('no future visit: nothing written, no failure', async () => {
    const { k, updates } = fakeTrx([]);
    expect(await storeNextVisitNote(k, { completed, note: 'x', nextVisitId: UUID })).toEqual({ status: 'no_target' });
    expect(updates).toEqual([]);
  });

  test('a row another transaction holds (SKIP LOCKED returns none) is not written and logs a warning', async () => {
    logger.warn.mockClear();
    const posted = row();
    const { k, updates } = fakeTrx([posted]);
    const realK = k;
    // First read (unlocked) sees the row; the locked read finds it taken.
    let reads = 0;
    const wrapped = (t) => {
      const q = realK(t);
      const first = q.first;
      q.first = (...a) => { reads += 1; return reads === 1 ? first(...a) : Promise.resolve(undefined); };
      return q;
    };
    expect(await storeNextVisitNote(wrapped, { completed, note: 'x', nextVisitId: UUID })).toEqual({ status: 'busy' });
    expect(updates).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('locked by another change'));
  });

  test('a note that would pass the cap is not written and logs a warning', async () => {
    logger.warn.mockClear();
    const { k, updates } = fakeTrx([row({ notes: 'x'.repeat(VISIT_NOTES_MAX_CHARS - 5) })]);
    expect((await storeNextVisitNote(k, { completed, note: 'Gate code changed', nextVisitId: UUID })).status).toBe('too_long');
    expect(updates).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('2000 characters'));
  });

  test('a database error is logged and swallowed, never thrown into the completion', async () => {
    logger.warn.mockClear();
    // A database error message can carry the statement and the note's text: only its code is logged.
    const k = () => { throw Object.assign(new Error('insert failed: secret note text'), { code: '23514' }); };
    expect(await storeNextVisitNote(k, { completed, note: 'x', nextVisitId: UUID })).toEqual({ status: 'error' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('23514'));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('secret note text'));
  });
});
