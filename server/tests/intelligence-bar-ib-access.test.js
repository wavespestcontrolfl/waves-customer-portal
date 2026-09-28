/**
 * Full-access predicate for the Intelligence Bar (owner ruling 2026-09-28):
 * contact@wavespestcontrol.com — or the IB_FULL_ACCESS_EMAILS allow-list
 * when set — gets red-tier (confirmed-endpoint) tools; every other admin
 * login, and every technician login, does not.
 */

const { ibFullAccess, requireFullAccess, fullAccessAllowlist, assertMayChangeFullAccessEmail } = require('../services/intelligence-bar/ib-access');

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

describe('requireFullAccess middleware', () => {
  const ORIGINAL_ENV = process.env.IB_FULL_ACCESS_EMAILS;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.IB_FULL_ACCESS_EMAILS;
    else process.env.IB_FULL_ACCESS_EMAILS = ORIGINAL_ENV;
  });

  beforeEach(() => {
    delete process.env.IB_FULL_ACCESS_EMAILS;
  });

  test('calls next() for the owner account, with no response written', () => {
    const req = { techRole: 'admin', technician: { email: 'contact@wavespestcontrol.com' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireFullAccess(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  test('403s a non-owner admin with the owner-only message and never calls next()', () => {
    const req = { techRole: 'admin', technician: { email: 'virginia@wavespestcontrol.com' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireFullAccess(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'This action is limited to the owner account.' });
  });

  test('403s a technician login, even with the owner email', () => {
    const req = { techRole: 'technician', technician: { email: 'contact@wavespestcontrol.com' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireFullAccess(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('assertMayChangeFullAccessEmail', () => {
  const ORIGINAL_ENV = process.env.IB_FULL_ACCESS_EMAILS;
  const nonOwner = { techRole: 'admin', technician: { email: 'virginia@wavespestcontrol.com' } };
  const owner = { techRole: 'admin', technician: { email: 'contact@wavespestcontrol.com' } };

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.IB_FULL_ACCESS_EMAILS;
    else process.env.IB_FULL_ACCESS_EMAILS = ORIGINAL_ENV;
  });

  beforeEach(() => {
    delete process.env.IB_FULL_ACCESS_EMAILS;
  });

  describe('assignment (creation / an ordinary row picking up the owner email)', () => {
    test('a non-owner admin cannot assign the full-access email (fromEmail null = a new row)', () => {
      const result = assertMayChangeFullAccessEmail(nonOwner, { fromEmail: null, toEmail: 'contact@wavespestcontrol.com' });
      expect(result).toEqual({ error: 'Only the owner account can change this email address.' });
    });

    test('the full-access owner may assign it', () => {
      expect(assertMayChangeFullAccessEmail(owner, { fromEmail: null, toEmail: 'contact@wavespestcontrol.com' })).toBeNull();
    });

    test('a mixed-case/whitespace variant is still caught', () => {
      const result = assertMayChangeFullAccessEmail(nonOwner, { fromEmail: null, toEmail: '  Contact@WavesPestControl.COM  ' });
      expect(result).toEqual({ error: 'Only the owner account can change this email address.' });
    });

    test('assigning an ordinary email is never blocked, whoever the requester is', () => {
      expect(assertMayChangeFullAccessEmail(nonOwner, { fromEmail: null, toEmail: 'newtech@example.test' })).toBeNull();
    });
  });

  describe('stripping (moving a row’s CURRENT full-access email away)', () => {
    test('a non-owner admin cannot move the owner row’s email to an ordinary address', () => {
      const result = assertMayChangeFullAccessEmail(nonOwner, { fromEmail: 'contact@wavespestcontrol.com', toEmail: 'someone-else@example.test' });
      expect(result).toEqual({ error: 'Only the owner account can change this email address.' });
    });

    test('the full-access owner may move their own row’s email', () => {
      expect(assertMayChangeFullAccessEmail(owner, { fromEmail: 'contact@wavespestcontrol.com', toEmail: 'newcontact@example.test' })).toBeNull();
    });

    test('moving an ordinary row’s ordinary email is never blocked', () => {
      expect(assertMayChangeFullAccessEmail(nonOwner, { fromEmail: 'oldtech@example.test', toEmail: 'newtech@example.test' })).toBeNull();
    });
  });

  describe('unchanged email — never blocked, whatever the value', () => {
    test('resending the current full-access email unchanged is allowed for a non-owner', () => {
      expect(assertMayChangeFullAccessEmail(nonOwner, { fromEmail: 'contact@wavespestcontrol.com', toEmail: 'contact@wavespestcontrol.com' })).toBeNull();
    });

    test('unchanged is recognized case/whitespace-insensitively', () => {
      expect(assertMayChangeFullAccessEmail(nonOwner, { fromEmail: 'contact@wavespestcontrol.com', toEmail: '  Contact@WavesPestControl.COM  ' })).toBeNull();
    });

    test('both null (no email either side) is a no-op', () => {
      expect(assertMayChangeFullAccessEmail(nonOwner, { fromEmail: null, toEmail: null })).toBeNull();
    });
  });

  test('IB_FULL_ACCESS_EMAILS override protects the NEW email and stops protecting the old default', () => {
    process.env.IB_FULL_ACCESS_EMAILS = 'owner@example.test';
    // The old default is now an ordinary address — assigning it is fine.
    expect(assertMayChangeFullAccessEmail(nonOwner, { fromEmail: null, toEmail: 'contact@wavespestcontrol.com' })).toBeNull();
    // The new allow-listed email is what a non-owner is refused now.
    const result = assertMayChangeFullAccessEmail(nonOwner, { fromEmail: null, toEmail: 'owner@example.test' });
    expect(result).toEqual({ error: 'Only the owner account can change this email address.' });
  });

  test('a technician requester is refused in both directions, even with the owner email on their own request context', () => {
    const tech = { techRole: 'technician', technician: { email: 'contact@wavespestcontrol.com' } };
    expect(assertMayChangeFullAccessEmail(tech, { fromEmail: null, toEmail: 'contact@wavespestcontrol.com' }))
      .toEqual({ error: 'Only the owner account can change this email address.' });
  });
});
