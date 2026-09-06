// technician-eligibility.js — the one answer to "may this tech take field
// work?" (Field Team Program, Phase 0 item 1). Pure helpers plus the
// save-time assert every visit writer calls.
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const {
  EMPLOYMENT_STATUSES,
  NOT_ASSIGNABLE,
  isEmploymentStatus,
  isAssignable,
  applyAssignable,
  assertAssignableTechnician,
  employmentPatch,
} = require('../services/technician-eligibility');

function connReturning(row, { transaction = false } = {}) {
  const chain = {
    where: jest.fn(() => chain),
    forShare: jest.fn(() => chain),
    first: jest.fn(async () => row),
  };
  const conn = jest.fn(() => chain);
  if (transaction) conn.isTransaction = true;
  return { conn, chain };
}

describe('technician eligibility', () => {
  test('statuses are exactly prospective / active / inactive', () => {
    expect(EMPLOYMENT_STATUSES).toEqual(['prospective', 'active', 'inactive']);
    expect(isEmploymentStatus('active')).toBe(true);
    expect(isEmploymentStatus('terminated')).toBe(false);
    expect(isEmploymentStatus(undefined)).toBe(false);
  });

  test('assignable = active employment AND field-dispatchable; nothing else counts', () => {
    expect(isAssignable({ employment_status: 'active', field_dispatchable: true })).toBe(true);
    // An office admin stays on staff without ever taking field work.
    expect(isAssignable({ employment_status: 'active', field_dispatchable: false })).toBe(false);
    // A placeholder for a hire who has not started.
    expect(isAssignable({ employment_status: 'prospective', field_dispatchable: true })).toBe(false);
    expect(isAssignable({ employment_status: 'inactive', field_dispatchable: true })).toBe(false);
    // The legacy flag alone never grants assignment.
    expect(isAssignable({ active: true })).toBe(false);
    expect(isAssignable(null)).toBe(false);
  });

  test('applyAssignable narrows a technicians query on both columns (aliased or not)', () => {
    const q = { where: jest.fn() };
    q.where.mockReturnValue(q);
    applyAssignable(q);
    expect(q.where).toHaveBeenCalledWith('technicians.employment_status', 'active');
    expect(q.where).toHaveBeenCalledWith('technicians.field_dispatchable', true);
    q.where.mockClear();
    applyAssignable(q, 't');
    expect(q.where).toHaveBeenCalledWith('t.employment_status', 'active');
    expect(q.where).toHaveBeenCalledWith('t.field_dispatchable', true);
  });

  test('employmentPatch writes status and the legacy active flag together', () => {
    expect(employmentPatch('active')).toEqual({ employment_status: 'active', active: true });
    expect(employmentPatch('prospective')).toEqual({ employment_status: 'prospective', active: false });
    expect(employmentPatch('inactive')).toEqual({ employment_status: 'inactive', active: false });
    expect(() => employmentPatch('fired')).toThrow(/Invalid employment status/);
  });

  describe('assertAssignableTechnician', () => {
    test('unassigned (null / undefined / empty) is always legal and reads nothing', async () => {
      const { conn } = connReturning(null);
      await expect(assertAssignableTechnician(null, { conn })).resolves.toBeNull();
      await expect(assertAssignableTechnician(undefined, { conn })).resolves.toBeNull();
      await expect(assertAssignableTechnician('', { conn })).resolves.toBeNull();
      expect(conn).not.toHaveBeenCalled();
    });

    test('returns the row for an assignable technician', async () => {
      const row = { id: 't1', name: 'Tech One', employment_status: 'active', field_dispatchable: true };
      const { conn, chain } = connReturning(row);
      await expect(assertAssignableTechnician('t1', { conn })).resolves.toBe(row);
      expect(chain.where).toHaveBeenCalledWith({ id: 't1' });
    });

    test.each([
      ['a prospective placeholder', { employment_status: 'prospective', field_dispatchable: true }, /has not started yet/],
      ['an inactive account', { employment_status: 'inactive', field_dispatchable: true }, /no longer active/],
      ['an active office-only admin', { employment_status: 'active', field_dispatchable: false }, /not field-dispatchable/],
      ['an unknown id', null, /unknown technician/],
    ])('throws 422 TECH_NOT_ASSIGNABLE for %s', async (_label, row, message) => {
      const { conn } = connReturning(row ? { id: 't1', name: 'Tech One', ...row } : null);
      await expect(assertAssignableTechnician('t1', { conn })).rejects.toMatchObject({
        status: 422,
        // The shared error middleware (middleware/errors.js) only surfaces
        // isOperational errors with their statusCode — without both this
        // would reach the client as a generic 500.
        statusCode: 422,
        isOperational: true,
        code: NOT_ASSIGNABLE,
        technicianId: 't1',
        message: expect.stringMatching(message),
      });
    });

    test('on a transaction the row is read FOR SHARE so a concurrent status change cannot commit underneath the assignment', async () => {
      const row = { id: 't1', name: 'Tech One', employment_status: 'active', field_dispatchable: true };
      const { conn, chain } = connReturning(row, { transaction: true });
      await expect(assertAssignableTechnician('t1', { conn })).resolves.toBe(row);
      expect(chain.forShare).toHaveBeenCalledTimes(1);
    });

    test('on a plain connection no row lock is taken', async () => {
      const { conn, chain } = connReturning({ id: 't1', employment_status: 'active', field_dispatchable: true });
      await assertAssignableTechnician('t1', { conn });
      expect(chain.forShare).not.toHaveBeenCalled();
    });

    test('defaults to the shared db handle when no connection is passed', async () => {
      const chain = { where: jest.fn(() => chain), first: jest.fn(async () => ({ id: 't1', employment_status: 'active', field_dispatchable: true })) };
      db.mockReturnValue(chain);
      await expect(assertAssignableTechnician('t1')).resolves.toMatchObject({ id: 't1' });
      expect(db).toHaveBeenCalledWith('technicians');
    });
  });
});
