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
// In-memory ib_pending_actions with the real claim's one-use semantics: a card
// is claimed once, by the admin who opened it (claimForConfirm's UPDATE ...
// WHERE status = 'pending').
jest.mock('../services/intelligence-bar/pending-actions', () => {
  const rows = new Map();
  let seq = 0;
  return {
    _rows: rows,
    createPendingAction: jest.fn(async ({ toolName, params, requestedBy }) => {
      const row = { id: `pa-${++seq}`, tool_name: toolName, params, requested_by: String(requestedBy), status: 'pending' };
      rows.set(row.id, row);
      return row;
    }),
    getPendingRow: jest.fn(async (id, requestedBy) => {
      const row = rows.get(id);
      return row && row.requested_by === String(requestedBy) ? { ...row } : null;
    }),
    claimForConfirm: jest.fn(async (id, requestedBy) => {
      const row = rows.get(id);
      if (!row) return { error: 'not_found' };
      if (row.requested_by !== String(requestedBy)) return { error: 'actor_mismatch' };
      if (row.status !== 'pending') return { error: 'already_used' };
      row.status = 'confirmed';
      return { action: { ...row } };
    }),
    recordResult: jest.fn(async () => true),
  };
});
jest.mock('../services/intelligence-bar/ops-tools', () => ({
  executeOpsTool: jest.fn(),
  recordGateFlipAudit: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const role = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.techRole = role;
    req.technicianId = req.headers['x-tech-id'] || 'tech-1';
    req.technician = { id: req.technicianId, email: req.headers['x-email'] || '' };
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
  a.use(express.json());
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

describe('readsOn follows each gate\'s own parser (codex #7732)', () => {
  test('a strict gate is on only for exactly "true"; a gateEnvValue gate also takes 1 / on', () => {
    const catalog = featureGates.knownGateCatalog();
    expect(catalog.get('GATE_HIRED_PACKET').reader).toBe('strict');
    for (const [value, on] of [['true', true], ['on', false], ['1', false], ['TRUE', false], [' true ', false], [undefined, false]]) {
      withEnv({ GATE_HIRED_PACKET: value }, () => expect(row('GATE_HIRED_PACKET').readsOn).toBe(on));
    }
    expect(catalog.get('GATE_ADMIN_OPS_QUEUE').reader).toBe('loose');
    for (const [value, on] of [['true', true], ['on', true], ['1', true], ['TRUE', true], ['false', false]]) {
      withEnv({ GATE_ADMIN_OPS_QUEUE: value }, () => expect(row('GATE_ADMIN_OPS_QUEUE').readsOn).toBe(on));
    }
  });
});

describe('flipStatus', () => {
  test('flippable = a described on/off gate; everything else says why it is Railway-only', () => {
    const { flipStatus } = require('../services/gate-list');
    const catalog = featureGates.knownGateCatalog();
    expect(flipStatus('GATE_LAWN_MIN_AFTER_DISCOUNT', catalog.get('GATE_LAWN_MIN_AFTER_DISCOUNT')).flippable).toBe(true);
    expect(flipStatus('GATE_SETTINGS_GATE_FLIP', catalog.get('GATE_SETTINGS_GATE_FLIP'))).toMatchObject({ flippable: false });
    expect(flipStatus('GATE_REVIEW_AUTO_REPLY', catalog.get('GATE_REVIEW_AUTO_REPLY')).notFlippableReason).toMatch(/mode/);
    expect(flipStatus('GATE_NOT_IN_CATALOGUE', undefined).notFlippableReason).toMatch(/catalogue/);
    expect(flipStatus('GATE_X', { kind: 'boolean', boolean: true, description: null }).notFlippableReason).toMatch(/No description/);
  });
});

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
    expect(Object.keys(body.gates[0]).sort()).toEqual(['description', 'flippable', 'inverted', 'name', 'notFlippableReason', 'readByCode', 'readsOn', 'set', 'value']);
    expect(body.flipAvailable).toBe(false);
  });
});

describe('flip a gate from Settings → Features (GATE_SETTINGS_GATE_FLIP)', () => {
  const ops = require('../services/intelligence-bar/ops-tools');
  const OWNER = 'contact@wavespestcontrol.com';
  const FLIPPABLE = () => listGates().find((g) => g.flippable).name;
  const post = (path, body, { role = 'admin', email = OWNER, techId = 'tech-1' } = {}) => fetch(`${base}/api/admin/settings${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${role}`, 'x-email': email, 'x-tech-id': techId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const previewResult = (name, value) => ({
    preview: true, gate: name, controls: 'what it does', current_value: 'unset', new_value: value,
    inverted: false, meaning: 'm', redeploy_notice: 'restarts',
    target: { service_id: 'svc', environment_id: 'env' }, prior_kind: 'unset', prior_value: null, prior_value_digest: null,
  });
  let saved;
  beforeEach(() => {
    saved = { gate: process.env.GATE_SETTINGS_GATE_FLIP, secret: process.env.JWT_SECRET, emails: process.env.IB_FULL_ACCESS_EMAILS };
    process.env.GATE_SETTINGS_GATE_FLIP = 'true';
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.IB_FULL_ACCESS_EMAILS;
    ops.executeOpsTool.mockReset();
    ops.recordGateFlipAudit.mockReset();
  });
  afterEach(() => {
    for (const [k, env] of [['gate', 'GATE_SETTINGS_GATE_FLIP'], ['secret', 'JWT_SECRET'], ['emails', 'IB_FULL_ACCESS_EMAILS']]) {
      if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k];
    }
  });

  test('gate off: the page stays read-only and both routes answer 404', async () => {
    delete process.env.GATE_SETTINGS_GATE_FLIP;
    const body = await (await fetch(`${base}/api/admin/settings/gates`, { headers: { Authorization: 'Bearer admin', 'x-email': OWNER } })).json();
    expect(body.flipAvailable).toBe(false);
    expect((await post(`/gates/${FLIPPABLE()}/preview`, { value: 'true' })).status).toBe(404);
    expect((await post(`/gates/${FLIPPABLE()}/commit`, { pendingActionId: 'pa-x' })).status).toBe(404);
    expect(ops.executeOpsTool).not.toHaveBeenCalled();
  });

  test('switches show for the owner login only; another admin gets 403', async () => {
    const owner = await (await fetch(`${base}/api/admin/settings/gates`, { headers: { Authorization: 'Bearer admin', 'x-email': OWNER } })).json();
    const office = await (await fetch(`${base}/api/admin/settings/gates`, { headers: { Authorization: 'Bearer admin', 'x-email': 'office@example.com' } })).json();
    expect([owner.flipAvailable, office.flipAvailable]).toEqual([true, false]);
    expect((await post(`/gates/${FLIPPABLE()}/preview`, { value: 'true' }, { email: 'office@example.com' })).status).toBe(403);
  });

  test('refuses a gate that cannot be flipped here, with the reason the row shows', async () => {
    for (const name of ['GATE_SETTINGS_GATE_FLIP', 'GATE_REVIEW_AUTO_REPLY']) {
      const res = await post(`/gates/${name}/preview`, { value: 'true' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(row(name).notFlippableReason);
    }
    expect(ops.executeOpsTool).not.toHaveBeenCalled();
  });

  test('preview → commit writes exactly the previewed change, asks for the typed name to turn on, and audits it', async () => {
    const name = FLIPPABLE();
    ops.executeOpsTool.mockResolvedValueOnce(previewResult(name, 'true'));
    const preview = await (await post(`/gates/${name}/preview`, { value: 'true' })).json();
    expect(ops.executeOpsTool).toHaveBeenLastCalledWith('set_railway_gate', { gate_name: name, value: 'true' });
    expect(preview).toMatchObject({ gate: name, newValue: 'true', requireTypedName: true });

    const noName = await post(`/gates/${name}/commit`, { pendingActionId: preview.pendingActionId, confirmName: 'GATE_WRONG' });
    expect(noName.status).toBe(400);

    ops.executeOpsTool.mockResolvedValueOnce({ success: true, gate: name, value: 'true', redeploy_notice: 'r' });
    const res = await post(`/gates/${name}/commit`, { pendingActionId: preview.pendingActionId, confirmName: name });
    expect(res.status).toBe(200);
    expect(ops.executeOpsTool).toHaveBeenLastCalledWith('set_railway_gate', expect.objectContaining({
      confirmed: true,
      _verified_railway_gate_name: name,
      _verified_railway_gate_value: 'true',
      _verified_railway_service_id: 'svc',
      _verified_railway_environment_id: 'env',
      _verified_railway_gate_prior_kind: 'unset',
    }));
    expect(ops.recordGateFlipAudit).toHaveBeenCalledWith(expect.objectContaining({ via: 'settings_page', gate: name, value: 'true', actorId: 'tech-1' }));
  });

  test('turning off is one click (no typed name)', async () => {
    const name = FLIPPABLE();
    ops.executeOpsTool.mockResolvedValueOnce(previewResult(name, 'false'));
    const preview = await (await post(`/gates/${name}/preview`, { value: 'false' })).json();
    expect(preview.requireTypedName).toBe(false);
    ops.executeOpsTool.mockResolvedValueOnce({ success: true, gate: name, value: 'false' });
    expect((await post(`/gates/${name}/commit`, { pendingActionId: preview.pendingActionId })).status).toBe(200);
  });

  test('a card is used once: a repeated or concurrent confirm writes nothing more (codex #7732)', async () => {
    const name = FLIPPABLE();
    ops.executeOpsTool.mockResolvedValueOnce(previewResult(name, 'false'));
    const { pendingActionId } = await (await post(`/gates/${name}/preview`, { value: 'false' })).json();
    ops.executeOpsTool.mockResolvedValue({ success: true, gate: name, value: 'false' });
    const statuses = (await Promise.all([1, 2, 3].map(() => post(`/gates/${name}/commit`, { pendingActionId })))).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    expect((await post(`/gates/${name}/commit`, { pendingActionId })).status).toBe(409);
    expect(ops.executeOpsTool.mock.calls.filter(([, input]) => input.confirmed === true)).toHaveLength(1);
  });

  test("an unknown card, another admin's card or another gate's card writes nothing", async () => {
    const name = FLIPPABLE();
    ops.executeOpsTool.mockResolvedValueOnce(previewResult(name, 'false'));
    const { pendingActionId } = await (await post(`/gates/${name}/preview`, { value: 'false' })).json();
    ops.executeOpsTool.mockClear();
    const other = listGates().filter((g) => g.flippable)[1].name;
    for (const [path, payload, opts] of [
      [`/gates/${name}/commit`, { pendingActionId: 'pa-unknown' }, {}],
      [`/gates/${name}/commit`, { pendingActionId }, { techId: 'tech-2' }],
      [`/gates/${other}/commit`, { pendingActionId }, {}],
    ]) {
      expect((await post(path, payload, opts)).status).toBe(409);
    }
    expect(ops.executeOpsTool).not.toHaveBeenCalled();
    // None of those used the card up: the right admin can still confirm it.
    ops.executeOpsTool.mockResolvedValueOnce({ success: true, gate: name, value: 'false' });
    expect((await post(`/gates/${name}/commit`, { pendingActionId })).status).toBe(200);
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
    expect(row('GATE_PREVISIT_BRIEF')).toMatchObject({ readByCode: true });
  });

  test('a GATE_ variable set in the environment but read by no code is listed as such', () => {
    withEnv({ GATE_ZZ_NOT_READ_ANYWHERE: 'true' }, () => {
      expect(row('GATE_ZZ_NOT_READ_ANYWHERE')).toMatchObject({ set: true, value: 'true', readByCode: false });
    });
  });

  test('call-time-only gates are listed; retired gates and non-GATE variables are not', () => {
    expect(row('GATE_ADMIN_MFA')).toBeDefined();
    expect(row('GATE_PORTAL_GLASS')).toBeUndefined();
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
