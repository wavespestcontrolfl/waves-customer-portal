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
  const calls = [];
  const probe = {
    select: jest.fn(() => probe),
    from: jest.fn(() => probe),
    whereRaw: jest.fn(() => probe),
    where: jest.fn(() => probe),
  };
  const q = {
    whereNotExists: jest.fn((fn) => { calls.push('whereNotExists'); fn.call(probe); return q; }),
  };
  return { q, probe, calls };
}

describe('isRecruitingMessageType', () => {
  test('matches the three recruiting stages and nothing else', () => {
    for (const t of ['job_application_received', 'job_interview_invite', 'job_interview_confirmation']) {
      expect(isRecruitingMessageType(t)).toBe(true);
    }
    for (const t of ['manual', 'appointment_reminder', 'ai_assistant', null, undefined, 42]) {
      expect(isRecruitingMessageType(t)).toBe(false);
    }
    expect(RECRUITING_MESSAGE_TYPE_PREFIX).toBe('job_');
  });
});

describe('hideRecruitingThreadsFromNonAdmin', () => {
  test('admin: query returned untouched', () => {
    const { q, calls } = fakeQuery();
    expect(hideRecruitingThreadsFromNonAdmin(q, { techRole: 'admin' })).toBe(q);
    expect(calls).toEqual([]);
  });

  test('technician: whole conversation excluded when ANY message in it is recruiting', () => {
    const { q, probe, calls } = fakeQuery();
    expect(hideRecruitingThreadsFromNonAdmin(q, { techRole: 'technician' })).toBe(q);
    expect(calls).toEqual(['whereNotExists']);
    expect(probe.from).toHaveBeenCalledWith('messages as recruiting_probe');
    expect(probe.whereRaw).toHaveBeenCalledWith('recruiting_probe.conversation_id = conversations.id');
    expect(probe.where).toHaveBeenCalledWith('recruiting_probe.message_type', 'like', 'job_%');
  });

  test('missing role (never authenticated as admin) is treated as non-admin', () => {
    const { calls, q } = fakeQuery();
    hideRecruitingThreadsFromNonAdmin(q, {});
    hideRecruitingThreadsFromNonAdmin(q, undefined);
    expect(calls).toEqual(['whereNotExists', 'whereNotExists']);
  });

  test('custom conversation column is a constant, passed through verbatim', () => {
    const { q, probe } = fakeQuery();
    hideRecruitingThreadsFromNonAdmin(q, { techRole: 'technician' }, 'c.id');
    expect(probe.whereRaw).toHaveBeenCalledWith('recruiting_probe.conversation_id = c.id');
  });
});

describe('isRecruitingPhone', () => {
  function fakeDatabase(row) {
    const q = {};
    ['where', 'whereRaw'].forEach((m) => { q[m] = jest.fn(() => q); });
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
    const [sql, bindings] = database.q.whereRaw.mock.calls[0];
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
