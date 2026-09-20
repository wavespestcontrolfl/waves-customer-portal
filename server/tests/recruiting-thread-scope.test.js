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
