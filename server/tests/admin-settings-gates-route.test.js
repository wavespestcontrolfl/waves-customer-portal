/**
 * Settings → Advanced → Features reads GET /api/admin/settings/gates. The page
 * used to read gates from the public /api/health reply, which stopped carrying
 * them in #2853, so the tab sat empty and every cron badge read "Off". This
 * pins the replacement: owner-only, one row per catalogue GATE_ variable with
 * what it is set to now, never a value that is not a plain switch word or a
 * timestamp, and no claim about whether the feature runs.
 */
const express = require('express');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/google-business', () => ({}));
jest.mock('../services/linkedin', () => ({}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const role = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.techRole = role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));

const featureGates = require('../config/feature-gates');
const { listGates } = require('../services/gate-list');

let server;
let base;
beforeAll(async () => {
  const a = express();
  a.use('/api/admin/settings', require('../routes/admin-settings'));
  server = a.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const get = (role) => fetch(`${base}/api/admin/settings/gates`, role ? { headers: { Authorization: `Bearer ${role}` } } : {});

function withEnv(values, fn) {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const row = (name) => listGates().find((g) => g.name === name);

describe('GET /api/admin/settings/gates', () => {
  test('refuses a signed-out caller and a non-admin role', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get('technician')).status).toBe(403);
  });

  test('returns one no-store row per catalogue gate', async () => {
    const res = await get('admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.gates.length).toBe(listGates().length);
    expect(Object.keys(body.gates[0]).sort()).toEqual(['description', 'name', 'readByCode', 'set', 'value']);
  });
});

describe('listGates', () => {
  test('lists every gate the code reads (docs/gate-index.md), once each', () => {
    const names = listGates().map((g) => g.name);
    expect(new Set(names).size).toBe(names.length);
    const indexed = [...require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'docs', 'gate-index.md'), 'utf8')
      .matchAll(/^- `(GATE_[A-Z0-9_]+)`/gm)].map((m) => m[1]);
    const retired = featureGates.RETIRED_GATES;
    for (const name of indexed) expect(names.includes(name)).toBe(!retired.has(name));
    // Readers outside feature-gates.js are included.
    for (const name of ['GATE_PREVISIT_BRIEF', 'GATE_SOCIAL_INBOX']) expect(row(name)).toMatchObject({ readByCode: true });
  });

  test('a GATE_ variable set in the environment but read by no code is listed as such', () => {
    withEnv({ GATE_ZZ_NOT_READ_ANYWHERE: 'true' }, () => {
      expect(row('GATE_ZZ_NOT_READ_ANYWHERE')).toMatchObject({ set: true, value: 'true', readByCode: false });
    });
  });

  test('call-time-only gates are listed; retired gates and non-GATE variables are not', () => {
    expect(row('GATE_ADMIN_MFA')).toBeDefined();
    expect(row('GATE_SELF_BOOK_DAY_CAP')).toBeUndefined();
    expect(listGates().every((g) => /^GATE_/.test(g.name))).toBe(true);
  });

  test('reports the setting exactly: unset, a switch word, a timestamp', () => {
    withEnv({ GATE_CRON_JOBS: undefined }, () => expect(row('GATE_CRON_JOBS')).toMatchObject({ set: false, value: null }));
    withEnv({ GATE_CRON_JOBS: 'true' }, () => expect(row('GATE_CRON_JOBS')).toMatchObject({ set: true, value: 'true' }));
    withEnv({ GATE_REVIEW_AUTO_REPLY: 'shadow' }, () => expect(row('GATE_REVIEW_AUTO_REPLY').value).toBe('shadow'));
    withEnv({ GATE_SMS_OPERATIONAL_ACTIONS_SINCE: '2026-10-01T00:00:00Z' }, () => {
      expect(row('GATE_SMS_OPERATIONAL_ACTIONS_SINCE').value).toBe('2026-10-01T00:00:00Z');
    });
  });

  test('an empty value is a setting, not an absent variable', () => {
    withEnv({ GATE_CRON_JOBS: '' }, () => expect(row('GATE_CRON_JOBS')).toMatchObject({ set: true, value: '' }));
  });

  test('keeps stray spaces so a malformed setting is visible', () => {
    withEnv({ GATE_CRON_JOBS: ' true ' }, () => expect(row('GATE_CRON_JOBS')).toMatchObject({ set: true, value: ' true ' }));
  });

  test('withholds any other value', () => {
    withEnv({ GATE_ADMIN_MFA: '+19415550100,+19415550101' }, () => {
      expect(row('GATE_ADMIN_MFA')).toMatchObject({ set: true, value: null });
    });
  });

  test('makes no claim about whether a feature runs', () => {
    // GATE_ADMIN_MFA_ENFORCE=true with GATE_ADMIN_MFA unset: the feature is off
    // (adminMfaEnforceLive), and the row says only what the variable holds.
    withEnv({ GATE_ADMIN_MFA_ENFORCE: 'true', GATE_ADMIN_MFA: undefined }, () => {
      expect(featureGates.adminMfaEnforceLive()).toBe(false);
      expect(row('GATE_ADMIN_MFA_ENFORCE')).toEqual(expect.objectContaining({ set: true, value: 'true' }));
      expect(row('GATE_ADMIN_MFA_ENFORCE')).not.toHaveProperty('enabled');
    });
  });
});
