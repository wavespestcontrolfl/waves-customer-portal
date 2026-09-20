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
    expect(inner.orWhere).toHaveBeenCalledWith('messages.message_type', 'not like', 'job_%');
  });

  test('missing role is treated as non-admin; the column is passed through verbatim', () => {
    const { q, inner } = fakeQuery();
    hideRecruitingThreadsFromNonAdmin(q, undefined, 'm.message_type');
    expect(inner.orWhere).toHaveBeenCalledWith('m.message_type', 'not like', 'job_%');
  });
});

describe('isRecruitingPhone', () => {
  function fakeDatabase(row) {
    const q = {};
    ['where', 'whereRaw', 'whereNot', 'whereNotIn', 'andWhere', 'whereNull', 'orWhere', 'orWhereNull', 'modify'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => row);
    const database = jest.fn(() => q);
    database.q = q;
    return database;
  }

  test('true when any job_* sms_log row involves the phone (either direction)', async () => {
    const database = fakeDatabase({ id: 'x' });
    await expect(isRecruitingPhone('(941) 555-0142', database)).resolves.toBe(true);
    expect(database).toHaveBeenCalledWith('sms_log');
    expect(database.q.where).toHaveBeenCalledWith('message_type', 'like', 'job_%');
    // the first whereRaw is the shared unresolved-reservation filter; the phone predicate follows
    const [sql, bindings] = database.q.whereRaw.mock.calls.find((c) => /to_phone/.test(c[0]));
    expect(sql).toMatch(/to_phone/);
    expect(sql).toMatch(/from_phone/);
    expect(bindings).toEqual([['19415550142', '9415550142'], ['19415550142', '9415550142']]);
  });

  test('false with no such row, and false without a query for an unparseable phone', async () => {
    await expect(isRecruitingPhone('+19415550142', fakeDatabase(null))).resolves.toBe(false);
    const database = fakeDatabase({ id: 'x' });
    await expect(isRecruitingPhone('nope', database)).resolves.toBe(false);
    expect(database).not.toHaveBeenCalled();
  });
});
