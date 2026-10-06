// Multi-property (frozen sibling-row model) recipient fallback (#1995 A/D):
// a secondary "Additional property" row with blank contact fields takes the
// account primary's phone / email / first_name — blank fields ONLY, a value
// the row carries always wins, and a primary / unlinked row is untouched.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  isSecondaryProfile,
  withAccountPrimaryFallback,
  loadAccountPrimaryRow,
  withAccountPrimaryContact,
  withAccountContactRole,
} = require('../services/customer-contact');

const primary = { id: 'p1', first_name: 'Lana', phone: '+15551110000', email: 'lana@example.com' };

function knexStub({ primaryRow = primary, throwOnRead = false, calls = [] } = {}) {
  return (table) => {
    calls.push(table);
    const qb = {
      where: (arg) => { calls.push(arg); return qb; },
      whereNull: (col) => { calls.push(`whereNull:${col}`); return qb; },
      first: async () => { if (throwOnRead) throw new Error('boom'); return primaryRow; },
    };
    return qb;
  };
}

describe('account-primary contact fallback', () => {
  test('isSecondaryProfile: secondary needs account_id AND is_primary_profile !== true', () => {
    expect(isSecondaryProfile({ id: 's1', account_id: 'a1', is_primary_profile: false })).toBe(true);
    expect(isSecondaryProfile({ id: 's1', account_id: 'a1', is_primary_profile: null })).toBe(true);
    expect(isSecondaryProfile({ id: 'p1', account_id: 'a1', is_primary_profile: true })).toBe(false);
    expect(isSecondaryProfile({ id: 'x', account_id: null, is_primary_profile: false })).toBe(false);
    expect(isSecondaryProfile(null)).toBe(false);
  });

  test('fills ONLY blank phone/email/first_name from the primary and records what it filled', () => {
    const row = { id: 's1', account_id: 'a1', is_primary_profile: false, first_name: '', phone: '  ', email: null };
    const out = withAccountPrimaryFallback(row, primary);
    expect(out).toMatchObject({ id: 's1', first_name: 'Lana', phone: '+15551110000', email: 'lana@example.com' });
    expect(out.account_primary_fallback).toEqual({ customer_id: 'p1', fields: ['phone', 'email', 'first_name'] });
    // input untouched
    expect(row.email).toBeNull();
  });

  test('a value on the property row always wins (tenant contact is never overridden)', () => {
    const row = { id: 's1', account_id: 'a1', is_primary_profile: false, first_name: 'Terry', phone: '+15552220000', email: '' };
    const out = withAccountPrimaryFallback(row, primary);
    expect(out.first_name).toBe('Terry');
    expect(out.phone).toBe('+15552220000');
    expect(out.email).toBe('lana@example.com');
    expect(out.account_primary_fallback).toEqual({ customer_id: 'p1', fields: ['email'] });
  });

  test('no-op for a primary row, an unlinked row, a missing primary, or the primary being the row itself', () => {
    const prim = { id: 'p1', account_id: 'a1', is_primary_profile: true, email: '' };
    expect(withAccountPrimaryFallback(prim, primary)).toBe(prim);
    const loose = { id: 'x', email: '' };
    expect(withAccountPrimaryFallback(loose, primary)).toBe(loose);
    const sec = { id: 's1', account_id: 'a1', is_primary_profile: false, email: '' };
    expect(withAccountPrimaryFallback(sec, null)).toBe(sec);
    expect(withAccountPrimaryFallback({ ...sec, id: 'p1' }, primary)).toEqual({ ...sec, id: 'p1' });
  });

  test('loadAccountPrimaryRow reads the live primary (deleted rows excluded) only for secondary rows', async () => {
    const calls = [];
    const db = knexStub({ calls });
    const out = await loadAccountPrimaryRow({ id: 's1', account_id: 'a1', is_primary_profile: false }, { db });
    expect(out).toEqual(primary);
    expect(calls).toEqual(['customers', { account_id: 'a1', is_primary_profile: true }, 'whereNull:deleted_at']);

    const calls2 = [];
    expect(await loadAccountPrimaryRow({ id: 'p1', account_id: 'a1', is_primary_profile: true }, { db: knexStub({ calls: calls2 }) })).toBeNull();
    expect(calls2).toEqual([]);
  });

  test('a failed primary read fails OPEN to the row as-is (never an invented address)', async () => {
    const row = { id: 's1', account_id: 'a1', is_primary_profile: false, email: '' };
    const out = await withAccountPrimaryContact(row, { db: knexStub({ throwOnRead: true }) });
    expect(out).toBe(row);
    expect(out.account_primary_fallback).toBeUndefined();
  });

  test('withAccountPrimaryContact end to end', async () => {
    const row = { id: 's1', account_id: 'a1', is_primary_profile: false, first_name: 'Lana', phone: '', email: '' };
    const out = await withAccountPrimaryContact(row, { db: knexStub() });
    expect(out.phone).toBe('+15551110000');
    expect(out.email).toBe('lana@example.com');
    expect(out.account_primary_fallback.fields).toEqual(['phone', 'email']);
  });

  test('a property profile carries the account primary\'s role apart from its own', async () => {
    const managerPrimary = { ...primary, contact_role: 'property_manager' };
    const sec = { id: 's1', account_id: 'a1', is_primary_profile: false, first_name: 'Lana', phone: '+1', email: 'x@example.com' };
    expect(withAccountPrimaryFallback(sec, managerPrimary).account_contact_role).toBe('property_manager');
    // The property row's own role (its contact is a tenant) stays as it is.
    const own = withAccountPrimaryFallback({ ...sec, contact_role: 'tenant' }, managerPrimary);
    expect(own).toMatchObject({ contact_role: 'tenant', account_contact_role: 'property_manager' });
    expect(own.account_primary_fallback).toBeUndefined();

    // Only the account role is added: the sender keeps its own recipient fields.
    expect(await withAccountContactRole({ ...sec, phone: '', contact_role: 'tenant' }, { db: knexStub({ primaryRow: managerPrimary }) }))
      .toEqual({ ...sec, phone: '', contact_role: 'tenant', account_contact_role: 'property_manager' });
    // A failed read throws: the report waits rather than reach an occupant.
    await expect(withAccountContactRole(sec, { db: knexStub({ throwOnRead: true }) })).rejects.toThrow('boom');
    // A linked property whose primary is gone (archived) is not authorized.
    await expect(withAccountContactRole(sec, { db: knexStub({ primaryRow: null }) })).rejects.toThrow('account primary profile not found');
    // A primary with no role resolves to '' (an owner account), never left unknown.
    expect((await withAccountContactRole(sec, { db: knexStub() })).account_contact_role).toBe('');
    // A primary row is never re-read.
    const prim = { id: 'p1', account_id: 'a1', is_primary_profile: true };
    expect(await withAccountContactRole(prim, { db: knexStub({ throwOnRead: true }) })).toBe(prim);
  });
});
