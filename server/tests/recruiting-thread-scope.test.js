/**
 * Recruiting threads are owner-only in every shared inbox reader: the
 * applicant invite text carries a bearer interview link, and the recruiting
 * queue is requireAdmin. A technician's query gets the whole conversation
 * filtered out via a NOT EXISTS probe on message_type 'job_%'; an admin's
 * query is untouched.
 */
const {
  hideRecruitingThreadsFromNonAdmin,
  isRecruitingMessageType,
  isRecruitingPhone,
  RECRUITING_MESSAGE_TYPE_PREFIX,
} = require('../utils/recruiting-thread-scope');

function fakeQuery() {
  const inner = { whereNull: jest.fn(() => inner), orWhere: jest.fn(() => inner) };
  const q = { where: jest.fn((fn) => { fn.call(inner); return q; }) };
  return { q, inner };
}

describe('isRecruitingMessageType', () => {
  test('matches the recruiting stages and the applicant reply type, nothing else', () => {
    for (const t of ['job_application_received', 'job_interview_invite', 'job_interview_confirmation', 'job_applicant_reply']) {
      expect(isRecruitingMessageType(t)).toBe(true);
    }
    for (const t of ['manual', 'appointment_reminder', 'ai_assistant', null, undefined, 42]) {
      expect(isRecruitingMessageType(t)).toBe(false);
    }
    expect(RECRUITING_MESSAGE_TYPE_PREFIX).toBe('job_');
  });
});

describe('hideRecruitingThreadsFromNonAdmin (message-level)', () => {
  test('admin: query returned untouched', () => {
    const { q } = fakeQuery();
    expect(hideRecruitingThreadsFromNonAdmin(q, { techRole: 'admin' })).toBe(q);
    expect(q.where).not.toHaveBeenCalled();
  });

  test('technician: only job_* messages are excluded — the rest of a shared customer thread stays visible', () => {
    const { q, inner } = fakeQuery();
    expect(hideRecruitingThreadsFromNonAdmin(q, { techRole: 'technician' })).toBe(q);
    expect(q.where).toHaveBeenCalledTimes(1);
    expect(inner.whereNull).toHaveBeenCalledWith('messages.message_type');
    expect(inner.orWhere).toHaveBeenCalledWith('messages.message_type', 'not like', 'job\\_%');
  });

  test('missing role is treated as non-admin; the column is passed through verbatim', () => {
    const { q, inner } = fakeQuery();
    hideRecruitingThreadsFromNonAdmin(q, undefined, 'm.message_type');
    expect(inner.orWhere).toHaveBeenCalledWith('m.message_type', 'not like', 'job\\_%');
  });
});

describe('isRecruitingPhone', () => {
  function fakeDatabase({ ledgerRow = null, smsRow = null } = {}) {
    const make = (row) => {
      const q = {};
      ['where', 'whereIn', 'whereRaw', 'whereNot', 'whereNotIn', 'andWhere', 'whereNull', 'orWhere', 'orWhereNull'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.modify = jest.fn((fn) => { fn(q); return q; });
      q.first = jest.fn(async () => row);
      return q;
    };
    const qs = { job_applications: make(ledgerRow), sms_log: make(smsRow) };
    const database = jest.fn((table) => qs[table]);
    database.qs = qs;
    return database;
  }

  test('durable ledger evidence (an application on the phone with an SMS attempt) decides first', async () => {
    const database = fakeDatabase({ ledgerRow: { id: 'app-1' } });
    await expect(isRecruitingPhone('(941) 555-0142', database)).resolves.toBe(true);
    expect(database).toHaveBeenCalledWith('job_applications');
    expect(database).not.toHaveBeenCalledWith('sms_log');
    const [sql, bindings] = database.qs.job_applications.whereRaw.mock.calls[0];
    expect(sql).toMatch(/contact_snapshot->>'phone'/);
    expect(bindings).toEqual([['19415550142', '9415550142']]);
    expect(database.qs.job_applications.whereRaw.mock.calls[1][0]).toMatch(/jsonb_array_elements/);
  });

  test('activeOnly (composer / scheduled sends): only an OPEN application counts and the sms_log fallback is skipped', async () => {
    const database = fakeDatabase({ ledgerRow: null, smsRow: { id: 'x' } });
    await expect(isRecruitingPhone('+19415550142', database, { activeOnly: true })).resolves.toBe(false);
    expect(database.qs.job_applications.whereIn).toHaveBeenCalledWith('status', ['new', 'reviewed', 'interview', 'offer']);
    expect(database).not.toHaveBeenCalledWith('sms_log');
  });

  test('activeOnly: an OPEN application with NO delivery evidence is still recruiting context (Codex r27 P1) — the ledger predicate is not applied', async () => {
    const database = fakeDatabase({ ledgerRow: { id: 'app-email-only' } });
    await expect(isRecruitingPhone('+19415550142', database, { activeOnly: true })).resolves.toBe(true);
    const sqls = database.qs.job_applications.whereRaw.mock.calls.map((c) => c[0]);
    expect(sqls.some((q) => /jsonb_array_elements/.test(q))).toBe(false);
  });

  test('history readers (activeOnly:false) still require ledger evidence; the predicate is plain SQL with no jsonpath ?', async () => {
    const database = fakeDatabase({ ledgerRow: null });
    await expect(isRecruitingPhone('+19415550142', database)).resolves.toBe(false);
    const sqls = database.qs.job_applications.whereRaw.mock.calls.map((c) => c[0]);
    expect(sqls.some((q) => /jsonb_array_elements/.test(q) && !/\?/.test(q))).toBe(true);
    expect(database.qs.job_applications.whereIn).not.toHaveBeenCalled();
  });

  test('falls back to a job_* sms_log row (either direction); false with neither; no query for an unparseable phone', async () => {
    await expect(isRecruitingPhone('+19415550142', fakeDatabase({ smsRow: { id: 'x' } }))).resolves.toBe(true);
    await expect(isRecruitingPhone('+19415550142', fakeDatabase())).resolves.toBe(false);
    const database = fakeDatabase({ ledgerRow: { id: 'x' } });
    await expect(isRecruitingPhone('nope', database)).resolves.toBe(false);
    expect(database).not.toHaveBeenCalled();
  });
});
