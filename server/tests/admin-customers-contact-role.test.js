/**
 * customers.contact_role — payer/occupant relationship on a profile
 * (owner | property_manager | tenant). The route accepts camelCase
 * `contactRole`, clears on ''/null, and 400s on anything unknown.
 */
const { CONTACT_ROLES, normalizeContactRole } = require('../constants/contact-roles');
const { mapCustomerListRow } = require('../routes/admin-customers')._private;

describe('normalizeContactRole', () => {
  test('accepts every known role, case/space-insensitively', () => {
    for (const role of CONTACT_ROLES) {
      expect(normalizeContactRole(role)).toEqual({ ok: true, value: role });
      expect(normalizeContactRole(`  ${role.toUpperCase()} `)).toEqual({ ok: true, value: role });
    }
  });

  test('empty / null / undefined clear the column', () => {
    expect(normalizeContactRole('')).toEqual({ ok: true, value: null });
    expect(normalizeContactRole('   ')).toEqual({ ok: true, value: null });
    expect(normalizeContactRole(null)).toEqual({ ok: true, value: null });
    expect(normalizeContactRole(undefined)).toEqual({ ok: true, value: null });
  });

  test('rejects unknown roles and non-strings', () => {
    expect(normalizeContactRole('landlord')).toEqual({ ok: false });
    expect(normalizeContactRole('owner;drop')).toEqual({ ok: false });
    expect(normalizeContactRole(42)).toEqual({ ok: false });
    expect(normalizeContactRole({ role: 'owner' })).toEqual({ ok: false });
  });
});

describe('mapCustomerListRow contactRole', () => {
  test('exposes contact_role as contactRole (null when unset)', () => {
    expect(mapCustomerListRow({ id: 'c1', contact_role: 'property_manager' }).contactRole).toBe('property_manager');
    expect(mapCustomerListRow({ id: 'c2' }).contactRole).toBeNull();
  });
});
