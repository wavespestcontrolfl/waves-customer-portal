/**
 * Settings → Advanced → Features reads GET /api/admin/settings/gates. The page
 * used to read gates from the public /api/health reply, which stopped carrying
 * them in #2853, so the tab sat empty and every cron badge read "Off". This
 * pins the replacement: owner-only, one row per gates-map entry, each tied to
 * the GATE_ variable its value expression reads (the last one; earlier ones are
 * prerequisites), never to a GATE_ named only in a comment.
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

describe('GET /api/admin/settings/gates', () => {
  test('refuses a signed-out caller and a non-admin role', async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get('technician')).status).toBe(403);
  });

  test('returns one row per gates-map entry with its live state', async () => {
    const res = await get('admin');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    const bootRows = body.gates.filter((row) => row.readAt === 'boot');
    // Every map entry except the retired selfBookDayCap (GATE_SELF_BOOK_DAY_CAP).
    expect(bootRows.map((row) => row.key).sort())
      .toEqual(Object.keys(featureGates.gates).filter((key) => key !== 'selfBookDayCap').sort());
    for (const row of bootRows) {
      expect(row.enabled).toBe(featureGates.gates[row.key] === true);
    }
  });
});

describe('listGates variable names', () => {
  const byKey = new Map(listGates().map((g) => [g.key, g]));

  test('a plain entry names its own variable', () => {
    expect(byKey.get('cronJobs')).toMatchObject({ envName: 'GATE_CRON_JOBS', requires: [] });
    expect(byKey.get('seoIntelligence')).toMatchObject({ envName: 'GATE_SEO_INTELLIGENCE', requires: [] });
  });

  test('a compound entry names the variable that spells its key, wherever it sits', () => {
    // Own variable last: typedDecisionsClef reads GATE_TYPED_DECISIONS first.
    expect(byKey.get('typedDecisionsClef')).toMatchObject({
      envName: 'GATE_TYPED_DECISIONS_CLEF',
      requires: ['GATE_TYPED_DECISIONS'],
    });
    // Own variable first: callIncidents reads its prerequisite second.
    expect(byKey.get('callIncidents')).toMatchObject({
      envName: 'GATE_CALL_INCIDENTS',
      requires: ['GATE_CALL_SELF_AUDIT'],
    });
  });

  test('a getter entry is parsed and does not bleed into the entry above it', () => {
    expect(byKey.get('visitGroups')).toMatchObject({ envName: 'GATE_VISIT_GROUPS', requires: [] });
    expect(byKey.get('visitCloseout')).toMatchObject({ envName: 'GATE_VISIT_CLOSEOUT', requires: [] });
  });

  test('a gate read through a helper function names its variable and prerequisite', () => {
    expect(byKey.get('termiteAnnualPlan')).toMatchObject({
      envName: 'GATE_TERMITE_ANNUAL_PLAN',
      requires: ['GATE_CANCEL_FLOW_V2'],
    });
    expect(byKey.get('emailTemplateAutomations')).toMatchObject({ envName: 'GATE_EMAIL_TEMPLATE_AUTOMATIONS', kind: 'mode' });
  });

  test('an entry with no GATE_ variable names the plain variable it reads', () => {
    expect(byKey.get('dunningCustomerScheduleAllowlist')).toMatchObject({ envName: 'DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST' });
  });

  test('mode gates carry their catalogue kind; no row claims inversion', () => {
    expect(byKey.get('reviewAutoReply')).toMatchObject({ envName: 'GATE_REVIEW_AUTO_REPLY', kind: 'mode' });
    expect(byKey.get('cronJobs')).toMatchObject({ kind: 'boolean' });
    // The catalogue's suffix-based inversion guess is wrong for this gate
    // (true turns the action on), so no row carries an inversion claim.
    expect(listGates().find((g) => g.envName === 'GATE_IB_STAFF_AUTOPAY_OFF')).not.toHaveProperty('inverted');
  });

  test('a GATE_ named only in a comment above an entry is not taken', () => {
    // The comment above appPropertyTexts names GATE_APP_PROPERTY_SCOPE; the
    // entry must still resolve to the variable in its own value expression.
    expect(byKey.get('appPropertyTexts')).toMatchObject({ envName: 'GATE_APP_PROPERTY_TEXTS', requires: [] });
  });

  test('a call-time-only gate with no map entry is listed from the catalogue', () => {
    const row = () => listGates().find((g) => g.envName === 'GATE_ADMIN_MFA');
    const saved = process.env.GATE_ADMIN_MFA;
    try {
      delete process.env.GATE_ADMIN_MFA;
      expect(row()).toMatchObject({ readAt: 'call', enabled: false, kind: 'boolean' });
      process.env.GATE_ADMIN_MFA = 'true';
      expect(row().enabled).toBe(true);
      // 'on' and '1' turn a gateEnvValue reader on but not a strict one; the
      // catalogue cannot prove which reader this gate uses, so: unknown.
      for (const value of ['on', '1']) {
        process.env.GATE_ADMIN_MFA = value;
        expect(row().enabled).toBeNull();
      }
      process.env.GATE_ADMIN_MFA = 'false';
      expect(row().enabled).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GATE_ADMIN_MFA;
      else process.env.GATE_ADMIN_MFA = saved;
    }
    // Every catalogue gate appears once, as a row or a map row's prerequisite,
    // except the two scan artifacts that are not variables.
    const rows = listGates();
    const named = new Set(rows.flatMap((g) => [g.envName, ...g.requires]));
    for (const name of featureGates.knownGateCatalog().keys()) {
      expect(named.has(name)).toBe(!['GATE_RE', 'GATE_X'].includes(name));
    }
    // A gate the catalogue cannot see the reader for is unknown, never "off".
    const unverified = [...featureGates.knownGateCatalog().values()].find((d) => d.kind === 'unverified' && !rows.some((g) => g.requires.includes(d.name)) && !['GATE_RE', 'GATE_X'].includes(d.name));
    expect(rows.find((g) => g.envName === unverified.name).enabled).toBeNull();
    const callNames = rows.filter((g) => g.readAt === 'call').map((g) => g.envName);
    expect(new Set(callNames).size).toBe(callNames.length);
  });

  test('a timestamp gate is on only for a valid past time', () => {
    const name = 'GATE_SMS_OPERATIONAL_ACTIONS_SINCE';
    const row = () => listGates().find((g) => g.envName === name);
    const saved = process.env[name];
    try {
      delete process.env[name];
      expect(row()).toMatchObject({ readAt: 'call', kind: 'mode', enabled: false });
      process.env[name] = 'true';
      expect(row().enabled).toBe(false);
      process.env[name] = '2026-01-01T00:00:00Z';
      expect(row().enabled).toBe(true);
      process.env[name] = '2099-01-01T00:00:00Z';
      expect(row().enabled).toBeNull();
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });

  test('a call-time gate lists the prerequisites its reader checks', () => {
    const row = () => listGates().find((g) => g.envName === 'GATE_ADMIN_MFA_ENFORCE');
    const saved = { mfa: process.env.GATE_ADMIN_MFA, enforce: process.env.GATE_ADMIN_MFA_ENFORCE };
    try {
      process.env.GATE_ADMIN_MFA_ENFORCE = 'true';
      delete process.env.GATE_ADMIN_MFA;
      expect(row()).toMatchObject({ requires: ['GATE_ADMIN_MFA'], enabled: null });
      process.env.GATE_ADMIN_MFA = 'true';
      expect(row().enabled).toBe(true);
      delete process.env.GATE_ADMIN_MFA_ENFORCE;
      expect(row().enabled).toBe(false);
    } finally {
      for (const [k, v] of [['GATE_ADMIN_MFA', saved.mfa], ['GATE_ADMIN_MFA_ENFORCE', saved.enforce]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('a helper that merely consumes a gate does not make it a prerequisite', () => {
    // lawnLightingLive() reads GATE_LAWN_VISIT_ASSESSMENT as its own
    // prerequisite; the assessment gate itself does not need lighting.
    const row = listGates().find((g) => g.envName === 'GATE_LAWN_VISIT_ASSESSMENT');
    expect(row.requires).toEqual([]);
    expect(listGates().find((g) => g.envName === 'GATE_VISIT_FACTS').requires).toEqual([]);
    // The gate's own reader still supplies real prerequisites.
    expect(listGates().find((g) => g.envName === 'GATE_IB_VOID_INVOICE').requires).toEqual(['GATE_IB_PLATFORM']);
  });

  test('a gate the catalogue retired is not listed', () => {
    expect(listGates().some((g) => g.envName === 'GATE_SELF_BOOK_DAY_CAP')).toBe(false);
  });

  test('every entry resolves to a variable', () => {
    expect(listGates().filter((g) => !g.envName).map((g) => g.key)).toEqual([]);
  });
});
