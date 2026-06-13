jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => ({ sql }));
  db.schema = { hasTable: jest.fn() };
  db.transaction = jest.fn();
  return db;
});

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const adminInventoryRouter = require('../routes/admin-inventory');
const vendorLoginWorkerRouter = require('../routes/integrations-vendor-login-worker');

describe('Hermes vendor login discovery helpers', () => {
  const vendorNeedingLogin = {
    active: true,
    type: 'distributor',
    login_url: null,
    login_username: null,
    login_email: null,
    account_number: null,
    credential_status: 'needs_login',
    sync_method: 'portal_connector',
  };

  test('skips completed terminal discovery results unless explicitly retried', () => {
    const completedConnection = {
      is_active: true,
      connection_type: 'portal_connector',
      credential_status: 'missing',
      config_json: JSON.stringify({
        loginDiscovery: {
          status: 'completed',
          outcome: 'found',
          loginUrl: 'https://vendor.example/login',
        },
      }),
    };

    expect(adminInventoryRouter._test.vendorNeedsLoginDiscovery(
      vendorNeedingLogin,
      [completedConnection],
      false,
    )).toBe(false);

    expect(adminInventoryRouter._test.vendorNeedsLoginDiscovery(
      vendorNeedingLogin,
      [completedConnection],
      false,
      { retryTerminal: true },
    )).toBe(true);
  });

  test('allows failed discoveries to be queued again', () => {
    const failedVendor = {
      ...vendorNeedingLogin,
      credential_status: 'failed',
    };
    const failedConnection = {
      is_active: true,
      connection_type: 'portal_connector',
      credential_status: 'failed',
      config_json: JSON.stringify({
        loginDiscovery: {
          status: 'failed',
          outcome: 'failed',
          notes: 'temporary vendor outage',
        },
      }),
    };

    expect(adminInventoryRouter._test.hasTerminalLoginDiscoveryResult([failedConnection]))
      .toBe(false);
    expect(adminInventoryRouter._test.vendorNeedsLoginDiscovery(
      failedVendor,
      [failedConnection],
      false,
    )).toBe(true);
  });

  test('does not let inactive discovery rows suppress needed state', () => {
    const inactiveCompletedConnection = {
      is_active: false,
      connection_type: 'portal_connector',
      credential_status: 'missing',
      config_json: JSON.stringify({
        loginDiscovery: {
          status: 'completed',
          outcome: 'found',
          loginUrl: 'https://vendor.example/login',
        },
      }),
    };

    expect(adminInventoryRouter._test.hasTerminalLoginDiscoveryResult([inactiveCompletedConnection]))
      .toBe(false);
    expect(adminInventoryRouter._test.vendorNeedsLoginDiscovery(
      vendorNeedingLogin,
      [inactiveCompletedConnection],
      false,
    )).toBe(true);
  });

  test('finds open jobs independently from the batch cap', () => {
    const queuedConnection = {
      id: 'conn-queued',
      is_active: true,
      connection_type: 'api',
      credential_status: 'missing',
      config_json: JSON.stringify({ loginDiscovery: { status: 'queued' } }),
    };
    const expiredRunningConnection = {
      id: 'conn-expired',
      is_active: true,
      connection_type: 'api',
      credential_status: 'missing',
      config_json: JSON.stringify({
        loginDiscovery: {
          status: 'running',
          claimedUntil: '2026-01-01T00:00:00.000Z',
        },
      }),
    };

    expect(adminInventoryRouter._test.findOpenLoginDiscoveryConnection([queuedConnection]))
      .toBe(queuedConnection);
    expect(adminInventoryRouter._test.findOpenLoginDiscoveryConnection([expiredRunningConnection]))
      .toBeNull();
  });

  test('preserves specific credential statuses while queueing', () => {
    expect(adminInventoryRouter._test.vendorCredentialStatusWhileQueued('needs_rep_setup'))
      .toBe('needs_rep_setup');
    expect(adminInventoryRouter._test.vendorCredentialStatusWhileQueued('needs_api_key'))
      .toBe('needs_api_key');
    expect(adminInventoryRouter._test.vendorCredentialStatusWhileQueued('not_required'))
      .toBe('not_required');
    expect(adminInventoryRouter._test.vendorCredentialStatusWhileQueued('missing'))
      .toBe('needs_login');
  });

  test('normalizes absolute and relative worker URLs with informal vendor websites', () => {
    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      'https://portal.vendor.example/login',
      'www.vendor.example',
    )).toBe('https://portal.vendor.example/login');

    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      'portal.vendor.example/login',
      'www.vendor.example',
    )).toBe('https://portal.vendor.example/login');

    expect(vendorLoginWorkerRouter._test.isLikelySchemeLessHost('siteone.com'))
      .toBe(true);
    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      'siteone.com',
      'www.vendor.example',
    )).toBe('https://siteone.com/');

    expect(vendorLoginWorkerRouter._test.normalizeSchemeLessHttpUrl('login.aspx'))
      .toBeNull();
    expect(vendorLoginWorkerRouter._test.looksLikeRelativePortalFile('login.aspx'))
      .toBe(true);
    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      'login.aspx',
      'www.vendor.example',
    )).toBe('https://www.vendor.example/login.aspx');
    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      'login.aspx?ReturnUrl=/account',
      'www.vendor.example',
    )).toBe('https://www.vendor.example/login.aspx?ReturnUrl=/account');
    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      'login.action',
      'www.vendor.example',
    )).toBe('https://www.vendor.example/login.action');
    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      'login.aspx/account',
      'www.vendor.example',
    )).toBe('https://www.vendor.example/login.aspx/account');
    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      'signin.faces',
      'www.vendor.example',
    )).toBe('https://www.vendor.example/signin.faces');
    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      'signin.faces/path',
      'www.vendor.example',
    )).toBe('https://www.vendor.example/signin.faces/path');
    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      'AccountLogin.mvc',
      'www.vendor.example',
    )).toBe('https://www.vendor.example/AccountLogin.mvc');

    expect(vendorLoginWorkerRouter._test.normalizeHttpUrl(
      '/account/register',
      'www.vendor.example',
    )).toBe('https://www.vendor.example/account/register');
  });

  test('accepts phone-only manual signup evidence', () => {
    expect(vendorLoginWorkerRouter._test.hasDiscoveryEvidence({
      repPhone: '941-555-0100',
    })).toBe(true);
    expect(vendorLoginWorkerRouter._test.hasFoundPortalEvidence({
      repPhone: '941-555-0100',
    })).toBe(false);
    expect(vendorLoginWorkerRouter._test.hasFoundPortalEvidence({
      loginUrl: 'https://vendor.example/login',
    })).toBe(true);
  });

  test('routes manual signup outcomes to rep setup', () => {
    expect(vendorLoginWorkerRouter._test.vendorCredentialStatusFromOutcome('needs_manual_signup', 'missing'))
      .toBe('needs_rep_setup');
    expect(vendorLoginWorkerRouter._test.vendorCredentialStatusFromOutcome('not_found', 'missing'))
      .toBe('needs_rep_setup');
    expect(vendorLoginWorkerRouter._test.vendorCredentialStatusFromOutcome('found', 'missing'))
      .toBe('needs_login');
    expect(vendorLoginWorkerRouter._test.vendorCredentialStatusFromOutcome('needs_manual_signup', 'configured'))
      .toBe('configured');
  });
});
