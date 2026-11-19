import { describe, expect, it } from 'vitest';
import { adminNavigationPreferenceKey, fieldViewLanding, readFieldViewPreference } from './fieldView';

const storageOf = (entries) => ({ getItem: (key) => (key in entries ? entries[key] : null) });
const admin = JSON.stringify({ id: 'acct-1', role: 'admin' });
const on = JSON.stringify({ version: 2, fieldView: true });

describe('fieldViewLanding (cold open, before the session check)', () => {
  const entries = { waves_admin_user: admin, [adminNavigationPreferenceKey('acct-1')]: on };

  it('sends /admin and /admin/ to Today for a stored admin with Field view on', () => {
    expect(fieldViewLanding('/admin', storageOf(entries))).toBe('/admin/today');
    expect(fieldViewLanding('/admin/', storageOf(entries))).toBe('/admin/today');
    expect(fieldViewLanding('/ADMIN', storageOf(entries))).toBe('/admin/today');
  });

  it('leaves every other path alone', () => {
    for (const pathname of ['/admin/dashboard', '/admin/today', '/admin/customers', '/', '/administrator', '']) {
      expect(fieldViewLanding(pathname, storageOf(entries)), pathname).toBeNull();
    }
  });

  it('does nothing with the switch off, missing, or saved for another login', () => {
    expect(fieldViewLanding('/admin', storageOf({ ...entries, [adminNavigationPreferenceKey('acct-1')]: JSON.stringify({ version: 2, fieldView: false }) }))).toBeNull();
    expect(fieldViewLanding('/admin', storageOf({ waves_admin_user: admin }))).toBeNull();
    expect(fieldViewLanding('/admin', storageOf({ waves_admin_user: admin, [adminNavigationPreferenceKey('acct-2')]: on }))).toBeNull();
  });

  it('does nothing for a stored role that is not admin, or a profile without an id', () => {
    for (const role of ['technician', 'owner', undefined]) {
      expect(fieldViewLanding('/admin', storageOf({ ...entries, waves_admin_user: JSON.stringify({ id: 'acct-1', role }) })), String(role)).toBeNull();
    }
    expect(fieldViewLanding('/admin', storageOf({ ...entries, waves_admin_user: JSON.stringify({ role: 'admin' }) }))).toBeNull();
    expect(fieldViewLanding('/admin', storageOf({}))).toBeNull();
  });

  it('does nothing for bad JSON, a non-boolean value, or storage that throws', () => {
    expect(fieldViewLanding('/admin', storageOf({ ...entries, waves_admin_user: '{nope' }))).toBeNull();
    expect(fieldViewLanding('/admin', storageOf({ ...entries, [adminNavigationPreferenceKey('acct-1')]: '{nope' }))).toBeNull();
    expect(fieldViewLanding('/admin', storageOf({ ...entries, [adminNavigationPreferenceKey('acct-1')]: JSON.stringify({ fieldView: 'true' }) }))).toBeNull();
    expect(fieldViewLanding('/admin', { getItem: () => { throw new Error('blocked'); } })).toBeNull();
  });
});

describe('readFieldViewPreference', () => {
  it('reads true only for a saved boolean true, per account', () => {
    const storage = storageOf({ [adminNavigationPreferenceKey('acct-1')]: on });
    expect(readFieldViewPreference('acct-1', storage)).toBe(true);
    expect(readFieldViewPreference('acct-2', storage)).toBe(false);
    expect(readFieldViewPreference('', storage)).toBe(false);
  });
});
