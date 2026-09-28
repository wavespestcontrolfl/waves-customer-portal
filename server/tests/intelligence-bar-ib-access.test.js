/**
 * Full-access predicate for the Intelligence Bar (owner ruling 2026-09-28):
 * contact@wavespestcontrol.com — or the IB_FULL_ACCESS_EMAILS allow-list
 * when set — gets red-tier (confirmed-endpoint) tools; every other admin
 * login, and every technician login, does not.
 */

const { ibFullAccess, fullAccessAllowlist } = require('../services/intelligence-bar/ib-access');

describe('ibFullAccess', () => {
  const ORIGINAL_ENV = process.env.IB_FULL_ACCESS_EMAILS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.IB_FULL_ACCESS_EMAILS;
    else process.env.IB_FULL_ACCESS_EMAILS = ORIGINAL_ENV;
  });

  describe('allow-list parsing', () => {
    test('unset env defaults to contact@wavespestcontrol.com only', () => {
      delete process.env.IB_FULL_ACCESS_EMAILS;
      expect(fullAccessAllowlist()).toEqual(['contact@wavespestcontrol.com']);
    });

    test('blank env (empty string) also defaults', () => {
      process.env.IB_FULL_ACCESS_EMAILS = '';
      expect(fullAccessAllowlist()).toEqual(['contact@wavespestcontrol.com']);
    });

    test('whitespace-only env also defaults', () => {
      process.env.IB_FULL_ACCESS_EMAILS = '   ,  ,';
      expect(fullAccessAllowlist()).toEqual(['contact@wavespestcontrol.com']);
    });

    test('comma-separated list is trimmed and lower-cased', () => {
      process.env.IB_FULL_ACCESS_EMAILS = ' Owner@Example.test , second@example.test ,,';
      expect(fullAccessAllowlist()).toEqual(['owner@example.test', 'second@example.test']);
    });

    test('a single override email replaces the default (contact@ is no longer implicit)', () => {
      process.env.IB_FULL_ACCESS_EMAILS = 'owner@example.test';
      expect(fullAccessAllowlist()).toEqual(['owner@example.test']);
    });
  });

  describe('role + email gate', () => {
    test('the default contact@ admin login has full access', () => {
      delete process.env.IB_FULL_ACCESS_EMAILS;
      const req = { techRole: 'admin', technician: { email: 'contact@wavespestcontrol.com' } };
      expect(ibFullAccess(req)).toBe(true);
    });

    test('email match is case- and whitespace-insensitive', () => {
      delete process.env.IB_FULL_ACCESS_EMAILS;
      const req = { techRole: 'admin', technician: { email: '  Contact@WavesPestControl.com  ' } };
      expect(ibFullAccess(req)).toBe(true);
    });

    test('another admin login (not on the allow-list) does not have full access', () => {
      delete process.env.IB_FULL_ACCESS_EMAILS;
      const req = { techRole: 'admin', technician: { email: 'virginia@wavespestcontrol.com' } };
      expect(ibFullAccess(req)).toBe(false);
    });

    test('a technician token never has full access, even with the owner email', () => {
      delete process.env.IB_FULL_ACCESS_EMAILS;
      const req = { techRole: 'technician', technician: { email: 'contact@wavespestcontrol.com' } };
      expect(ibFullAccess(req)).toBe(false);
    });

    test('an admin with no email on the technicians row is refused, not granted', () => {
      delete process.env.IB_FULL_ACCESS_EMAILS;
      const req = { techRole: 'admin', technician: { email: null } };
      expect(ibFullAccess(req)).toBe(false);
      expect(ibFullAccess({ techRole: 'admin', technician: {} })).toBe(false);
      expect(ibFullAccess({ techRole: 'admin' })).toBe(false);
    });

    test('the env override grants a synthetic owner email and revokes the old default', () => {
      process.env.IB_FULL_ACCESS_EMAILS = 'owner@example.test';
      expect(ibFullAccess({ techRole: 'admin', technician: { email: 'owner@example.test' } })).toBe(true);
      expect(ibFullAccess({ techRole: 'admin', technician: { email: 'contact@wavespestcontrol.com' } })).toBe(false);
    });

    test('a client-supplied email/role on the request is never trusted — only req.technician', () => {
      delete process.env.IB_FULL_ACCESS_EMAILS;
      const req = {
        techRole: 'admin',
        technician: { email: 'virginia@wavespestcontrol.com' },
        body: { email: 'contact@wavespestcontrol.com', techRole: 'admin' },
      };
      expect(ibFullAccess(req)).toBe(false);
    });

    test('no request / malformed request is refused, not thrown', () => {
      expect(ibFullAccess(null)).toBe(false);
      expect(ibFullAccess(undefined)).toBe(false);
      expect(ibFullAccess({})).toBe(false);
    });
  });
});
