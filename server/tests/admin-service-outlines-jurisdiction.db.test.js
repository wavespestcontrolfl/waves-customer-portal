const express = require('express');
const { createPublicToken, hashToken } = require('../services/lawn-service-outline');

jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
const NORTH_PORT = '101 Test Way, North Port, FL 34286';
const VENICE = '100 Test Way, Venice, FL 34285';
const lawnInputs = { svcLawn: true, grassType: 'st_augustine' };

postgres('service outline regeneration against PostgreSQL', () => {
  let db;
  let server;
  let base;
  const estimateIds = [];
  const savedGates = {};

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1', ''].includes(url.hostname)) throw new Error('Use a local test database');
    for (const gate of ['GATE_LAWN_V13', 'GATE_LAWN_OUTLINE_DETAIL', 'GATE_TS_OUTLINE']) {
      savedGates[gate] = process.env[gate];
      process.env[gate] = 'true';
    }
    db = require('../models/db');
    const app = express();
    app.use(express.json());
    app.use('/admin', require('../routes/admin-service-outlines'));
    app.use('/public', require('../routes/service-outlines-public'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (!estimateIds.length) return;
    await db('service_outline_packets').whereIn('estimate_id', estimateIds).del();
    await db('estimates').whereIn('id', estimateIds).del();
    estimateIds.length = 0;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (db) await db.destroy();
    for (const [key, value] of Object.entries(savedGates)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  async function estimate(address = VENICE, data = {}) {
    const [row] = await db('estimates').insert({
      customer_name: 'Synthetic outline test', address, estimate_data: { inputs: lawnInputs, ...data },
    }).returning('id');
    estimateIds.push(row.id);
    return row.id;
  }

  async function legacyPacket(estimateId, serviceLine = 'lawn_care') {
    const token = createPublicToken();
    const [packet] = await db('service_outline_packets').insert({
      estimate_id: estimateId, service_line: serviceLine, title: 'Synthetic prior outline', status: 'approved',
      jurisdiction_id: 'sarasota_county_fl', input_snapshot_json: { jurisdictionId: 'sarasota_county_fl', month: 4 },
      token_hash: hashToken(token), expires_at: new Date(Date.now() + 86400000),
    }).returning('id');
    return { id: packet.id, token };
  }

  async function post(path, body) {
    const response = await fetch(base + '/admin' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }

  const publicStatus = async (token) => (await fetch(base + '/public/' + token)).status;

  test.each(['lawn_care', 'tree_shrub'])('a corrected commercial %s address requires a valid jurisdiction before replacing the original', async (serviceLine) => {
    const estimateId = await estimate(VENICE, {
      property: { city: 'Venice', county: 'Sarasota', zip: '34285' },
      proposal: { enabled: true, provenance: { source: 'proposal-editor' }, propertyAddress: NORTH_PORT, buildings: [{ name: 'Test building' }] },
    });
    const source = await legacyPacket(estimateId, serviceLine);
    const path = '/' + source.id + '/regenerate';
    const preview = await post('/preview', { estimateId, serviceLine, month: 4 });
    expect(preview.data.outline.property.addressSummary).toBe('101 Test Way, North Port');
    expect(preview.data.summary.jurisdictionId).toBe('north_port_fl');
    for (const choice of [undefined, null, 'charlotte_county_fl', 'generic_swfl', 'missing_rule']) {
      const result = await post(path, { jurisdictionId: choice });
      expect(result).toMatchObject({ status: 409, data: { code: 'outline_jurisdiction_confirmation_required' } });
    }
    expect(await db('service_outline_packets').where({ estimate_id: estimateId })).toHaveLength(1);
    expect(await db('service_outline_events').where({ estimate_id: estimateId })).toHaveLength(0);
    expect(await publicStatus(source.token)).toBe(200);
    const result = await post(path, { jurisdictionId: 'north_port_fl' });
    expect(result).toMatchObject({ status: 201, data: {
      packet: { status: 'approved', jurisdictionId: 'north_port_fl', validationErrors: [], adminWarnings: [] },
      sourcePacket: { id: source.id, status: 'revoked', revokedAt: expect.any(String) },
    } });
    const row = await db('service_outline_packets').where({ id: result.data.packet.id }).first();
    expect(row.estimate_snapshot_json.address).toBe(NORTH_PORT);
    expect(row.input_snapshot_json.jurisdictionSource).toBe('staff');
    expect(await publicStatus(source.token)).toBe(404);
    expect(await publicStatus(new URL(result.data.publicUrl).pathname.split('/').pop())).toBe(200);
  });

  test.each([
    [{ approve: false }, 'draft', 'passed'],
    [{ turfType: 'bahia' }, 'draft', 'blocked'],
    [{ revokeOld: false }, 'approved', 'passed'],
  ])('keeps the public link for %j and records whether a replacement can be shared', async (options, status, validationStatus) => {
    const source = await legacyPacket(await estimate(NORTH_PORT));
    const result = await post('/' + source.id + '/regenerate', { jurisdictionId: 'sarasota_county_fl', ...options });
    expect(result).toMatchObject({ status: 201, data: {
      packet: { status, jurisdictionId: 'sarasota_county_fl', validationStatus },
      sourcePacket: { id: source.id, status: 'approved', revokedAt: null },
      publicUrl: status === 'draft' ? null : expect.any(String),
    } });
    if (validationStatus === 'blocked') expect(result.data.packet.validationErrors[0]).toMatch(/bahiagrass/i);
    const event = await db('service_outline_events').where({ packet_id: result.data.packet.id, event_type: 'regenerated_from_packet' }).first();
    expect(event.metadata_json.revokedSource).toBe(false);
    expect(await publicStatus(source.token)).toBe(200);
  });

  test('persists warning and error lists as JSON arrays and reads legacy empty objects as empty lists', async () => {
    const estimateId = await estimate('100 Test Way, Englewood, FL 34223');
    const body = { estimateId, month: 4 };
    const preview = await post('/preview', body);
    expect(preview.data.validation.status).toBe('warning');
    const result = await post('/', body);
    expect(result).toMatchObject({ status: 201, data: { packet: {
      jurisdictionId: 'generic_swfl', validationErrors: [], adminWarnings: preview.data.validation.warnings,
    } } });
    const id = result.data.packet.id;
    const row = await db('service_outline_packets').where({ id }).first();
    expect(row.admin_warnings_json).toEqual(preview.data.validation.warnings);
    expect(row.validation_errors_json).toEqual([]);
    await db('service_outline_packets').where({ id }).update({ validation_errors_json: {}, admin_warnings_json: {} });
    const saved = await (await fetch(base + '/admin/' + id)).json();
    expect(saved.packet).toMatchObject({ validationErrors: [], adminWarnings: [] });
  });

  test('an older unconfirmed jurisdiction is resolved when the property address becomes known', async () => {
    const source = await legacyPacket(await estimate(NORTH_PORT));
    await db('service_outline_packets').where({ id: source.id }).update({
      jurisdiction_id: 'generic_swfl', input_snapshot_json: { month: 4, jurisdictionId: 'generic_swfl' },
    });
    const result = await post('/' + source.id + '/regenerate', {});
    expect(result).toMatchObject({ status: 201, data: { packet: { jurisdictionId: 'north_port_fl', status: 'approved' } } });
    const row = await db('service_outline_packets').where({ id: result.data.packet.id }).first('input_snapshot_json');
    expect(row.input_snapshot_json.jurisdictionSource).toBe('estimate');
  });
});
