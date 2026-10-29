// Real PostgreSQL transactions (rolled back): "Sold by" from a technician's field flag that the
// truck GPS confirms (owner ruling 2026-10-29, D5 part 3b-1), dark behind GATE_COMMISSION_SOLD_BY.
// Covers the flag route in both modes, the estimate auto-fill, the admin routes and the table
// CHECKs. Records who sold; pays, texts and charges nothing. All names are synthetic.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = req.headers['x-test-tech'] || null;
    req.technician = { id: req.technicianId, name: req.headers['x-test-name'] || 'Sample Tech' };
    req.techRole = req.headers['x-test-role'] || 'technician';
    next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/geocoder', () => ({ geocodeAddressWithStatus: jest.fn() }));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(), PutObjectCommand: jest.fn(), GetObjectCommand: jest.fn(), DeleteObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const { randomUUID } = require('node:crypto');
const express = require('express');
const { geocodeAddressWithStatus } = require('../services/geocoder');
const TwilioService = require('../services/twilio');
const { autoFillSoldBy, setEstimateSoldBy, loadSoldByForList } = require('../services/estimate-sold-by');
const { describeGpsCheck } = require('../services/field-lead-gps');
const { createOrReuseAdminEstimate, reviseAdminEstimate } = require('../services/admin-estimate-persistence');

jest.setTimeout(60000);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A synthetic house and a truck 40 m north of it (0.00036 degrees of latitude is about 40 m).
const HOUSE = { lat: 27.4, lng: -82.45 };
const TRUCK_NEAR = { lat: 27.40036, lng: -82.45 };
const TRUCK_FAR = { lat: 27.41, lng: -82.45 }; // about 1.1 km
const PROSPECT = { firstName: 'Neighbor', lastName: 'Sample', phone: '(941) 555-0142', address: '12 Sample Way', city: 'Bradenton', zip: '34202' };

postgres('commission sold by', () => {
  let database;
  let trx;
  let server;
  let baseUrl;
  const OLD_GATE = process.env.GATE_COMMISSION_SOLD_BY;
  const ADMIN_ID = randomUUID();

  const tech = async (name, patch = {}) => {
    const id = randomUUID();
    await trx('technicians').insert({ id, name, employment_type: 'w2', active: true, role: 'technician', ...patch });
    return id;
  };
  const customer = async (patch = {}) => {
    const id = randomUUID();
    await trx('customers').insert({ id, first_name: 'Sample', last_name: 'Customer', phone: '+19415550111', ...patch });
    return id;
  };
  const visit = async (technicianId, customerId, patch = {}) => {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, technician_id: technicianId, customer_id: customerId, scheduled_date: new Date().toISOString().slice(0, 10),
      service_type: 'Pest Control', status: 'confirmed', ...patch,
    });
    return id;
  };
  const arrival = (visitId, hoursAgo, techId, distance = 40) => trx('audit_log').insert({
    actor_type: 'system:gps-arrival', action: 'gps_arrival.mark_on_property', resource_type: 'scheduled_service',
    resource_id: visitId, metadata: { tech_id: techId, distance_meters: distance }, created_at: new Date(Date.now() - hoursAgo * HOUR),
  });
  const truck = async (technicianId, position, hoursAgo = 0.1) => {
    const imei = `IMEI${Math.floor(Math.random() * 1e12)}`;
    await trx('technicians').where({ id: technicianId }).update({ bouncie_imei: imei });
    await trx('vehicle_locations').insert({
      bouncie_imei: imei, lat: position.lat, lng: position.lng, reported_at: new Date(Date.now() - hoursAgo * HOUR),
    });
    return imei;
  };
  const flagLead = async (technicianId, patch = {}) => {
    const [row] = await trx('leads').insert({
      first_name: 'Sample', lead_type: 'field_observation', first_contact_channel: 'field_observation', status: 'new',
      assigned_to: technicianId, gps_verified: true,
      gps_check: { result: 'verified', mode: 'customer', technician_id: technicianId, premise: { customer_id: patch.customer_id || null } },
      created_at: new Date(Date.now() - 2 * DAY), ...patch,
    }).returning('id');
    return row.id || row;
  };
  const estimate = async (patch = {}) => {
    const [row] = await trx('estimates').insert({ customer_name: 'Sample Customer', status: 'draft', ...patch }).returning('id');
    return row.id || row;
  };
  const estimateRow = (id) => trx('estimates').where({ id }).first();
  const flag = async (headers, body) => {
    const response = await fetch(`${baseUrl}/api/tech/field-lead`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const admin = (method, path, body) => fetch(`${baseUrl}/api/admin/estimates${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-tech': ADMIN_ID, 'x-test-role': 'admin' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const leadFor = (technicianId) => trx('leads').where({ assigned_to: technicianId }).orderBy('created_at', 'desc').first();
  const activityFor = (leadId) => trx('lead_activities').where({ lead_id: leadId }).first();

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/api/tech/field-lead', require('../routes/tech-field-lead'));
    app.use('/api/admin/estimates', require('../routes/admin-estimates'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_COMMISSION_SOLD_BY = 'true';
    trx = await database.transaction();
    mockConnection = trx;
    await trx('technicians').insert({ id: ADMIN_ID, name: 'Sample Admin', role: 'admin', employment_type: '1099', active: true });
    geocodeAddressWithStatus.mockResolvedValue({ location: HOUSE });
  });
  afterEach(async () => {
    await trx.rollback();
    if (OLD_GATE === undefined) delete process.env.GATE_COMMISSION_SOLD_BY; else process.env.GATE_COMMISSION_SOLD_BY = OLD_GATE;
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (database) await database.destroy();
  });

  describe('the field flag with the gate off', () => {
    it('writes exactly what it wrote before and ignores the new fields', async () => {
      delete process.env.GATE_COMMISSION_SOLD_BY;
      const id = await tech('Sample Alpha');
      const cust = await customer();
      const v = await visit(id, cust);
      await arrival(v, 1);
      const res = await flag({ 'x-test-tech': id, 'x-test-name': 'Sample Alpha' }, {
        customerId: cust, leadServiceType: 'Lawn', notes: 'Brown patch', urgency: 'high', scheduledServiceId: v, prospect: PROSPECT,
      });
      expect(res.status).toBe(200);
      const lead = await leadFor(id);
      expect(lead.gps_verified).toBe(false);
      expect(lead.gps_check).toBeNull();
      expect(lead.zip).toBeNull();
      expect((await activityFor(lead.id)).description).toBe('Field lead created by Sample Alpha: Lawn — Brown patch');
    });

    it('still makes a customer-less lead from a body with no customer, ignoring a prospect', async () => {
      delete process.env.GATE_COMMISSION_SOLD_BY;
      const id = await tech('Sample Alpha');
      const res = await flag({ 'x-test-tech': id }, { leadServiceType: 'Pest', prospect: PROSPECT });
      expect(res.status).toBe(200);
      const lead = await leadFor(id);
      expect(lead.customer_id).toBeNull();
      expect(lead.first_name).toBeNull();
      expect(lead.gps_check).toBeNull();
      expect(geocodeAddressWithStatus).not.toHaveBeenCalled();
    });
  });

  describe('the field flag with the gate on, from a visit', () => {
    const run = async ({ arrivalHoursAgo, mutate } = {}) => {
      const id = await tech('Sample Alpha');
      const cust = await customer();
      const v = await visit(id, cust);
      if (arrivalHoursAgo !== undefined) await arrival(v, arrivalHoursAgo, id);
      const extra = mutate ? await mutate({ id, cust, v }) : {};
      const res = await flag({ 'x-test-tech': id, 'x-test-name': 'Sample Alpha' }, {
        customerId: cust, leadServiceType: 'Lawn', notes: 'Chinch bugs', urgency: 'normal', scheduledServiceId: v, ...extra,
      });
      return { id, cust, v, res, lead: await leadFor(id) };
    };

    it('verifies a truck arrival logged 2 hours earlier', async () => {
      const { res, lead, v } = await run({ arrivalHoursAgo: 2 });
      expect(res.status).toBe(200);
      expect(lead.gps_verified).toBe(true);
      expect(lead.gps_check).toMatchObject({ result: 'verified', mode: 'customer', scheduled_service_id: v, distance_m: 40 });
      expect((await activityFor(lead.id)).description).toBe('Field lead created by Sample Alpha: Lawn — Chinch bugs · GPS: verified, 40 m');
    });

    it('keeps the distance unknown when the arrival row logged none', async () => {
      const { lead } = await run({
        mutate: async ({ id, v }) => {
          await trx('audit_log').insert({
            actor_type: 'system:gps-arrival', action: 'gps_arrival.mark_on_property', resource_type: 'scheduled_service',
            resource_id: v, metadata: { tech_id: id, distance_meters: null }, created_at: new Date(Date.now() - HOUR),
          });
          return {};
        },
      });
      expect(lead.gps_verified).toBe(true);
      expect(lead.gps_check.distance_m).toBeNull();
      expect((await activityFor(lead.id)).description).toMatch(/ · GPS: verified$/);
    });

    it('makes the lead, unverified, when no arrival was logged', async () => {
      const { res, lead } = await run();
      expect(res.status).toBe(200);
      expect(lead.gps_verified).toBe(false);
      expect(lead.gps_check.result).toBe('no_gps_arrival');
      expect((await activityFor(lead.id)).description).toContain('GPS: not verified (no truck arrival logged at this visit)');
    });

    it('does not count an arrival 13 hours earlier', async () => {
      const { lead } = await run({ arrivalHoursAgo: 13 });
      expect(lead.gps_verified).toBe(false);
      expect(lead.gps_check.result).toBe('no_gps_arrival');
    });

    it('counts an arrival logged on another stop of the same grouped visit', async () => {
      const { lead } = await run({
        mutate: async ({ id, cust, v }) => {
          const [{ id: group }] = await trx('service_visits').insert({
            customer_id: cust, scheduled_date: new Date().toISOString().slice(0, 10), stop_base_key: `sample-${randomUUID()}`, created_by: 'sample',
          }).returning('id');
          await trx('scheduled_services').where({ id: v }).update({ visit_id: group });
          const sibling = await visit(id, cust, { visit_id: group });
          await arrival(sibling, 1, id);
          return {};
        },
      });
      expect(lead.gps_verified).toBe(true);
    });

    it('does not verify with the visit of another customer or another technician', async () => {
      const other = await tech('Sample Bravo');
      const otherCustomer = await customer({ first_name: 'Other' });
      const foreignVisit = await visit(other, otherCustomer);
      await arrival(foreignVisit, 1, other);
      const { lead } = await run({ mutate: async () => ({ scheduledServiceId: foreignVisit }) });
      expect(lead.gps_verified).toBe(false);
      expect(lead.gps_check.result).toBe('no_gps_arrival');
    });

    it("does not count another technician's arrival on a visit reassigned to this technician", async () => {
      const { lead } = await run({
        mutate: async ({ v }) => {
          const before = await tech('Sample Bravo');
          await arrival(v, 1, before); // Bravo's truck arrived; the visit was then given to Alpha
          return {};
        },
      });
      expect(lead.gps_verified).toBe(false);
      expect(lead.gps_check.result).toBe('no_gps_arrival');
    });

    it('answers 404 for a customer on another technician\'s route, as before', async () => {
      const mine = await tech('Sample Alpha');
      const other = await tech('Sample Bravo');
      const theirs = await customer({ first_name: 'Theirs' });
      await visit(other, theirs);
      const res = await flag({ 'x-test-tech': mine }, { customerId: theirs, leadServiceType: 'Pest' });
      expect(res.status).toBe(404);
      expect(await trx('leads').where({ assigned_to: mine }).first()).toBeUndefined();
    });

    it('keeps the owner alert text', async () => {
      await run({ arrivalHoursAgo: 1 });
      expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
      expect(TwilioService.sendSMS.mock.calls[0][1]).toBe('🔔 Field Lead: Sample Alpha flagged Lawn opportunity at Sample Customer.\nNotes: Chinch bugs');
    });
  });

  describe('the Neighbor flag with the gate on', () => {
    const neighbor = (id, body = {}) => flag({ 'x-test-tech': id, 'x-test-name': 'Sample Alpha' }, {
      leadServiceType: 'Pest', notes: 'Ants', urgency: 'normal', prospect: PROSPECT, ...body,
    });

    it('verifies a truck 40 m away and stores the prospect, with distance only', async () => {
      const id = await tech('Sample Alpha');
      await truck(id, TRUCK_NEAR);
      const res = await neighbor(id);
      expect(res.status).toBe(200);
      const lead = await leadFor(id);
      expect(lead).toMatchObject({
        customer_id: null, first_name: 'Neighbor', last_name: 'Sample', phone: '+19415550142', address: '12 Sample Way',
        city: 'Bradenton', zip: '34202', assigned_to: id, gps_verified: true,
      });
      expect(lead.gps_check).toMatchObject({ result: 'verified', mode: 'prospect', radius_m: 300 });
      expect(lead.gps_check.distance_m).toBeGreaterThan(30);
      expect(lead.gps_check.distance_m).toBeLessThan(50);
      const stored = JSON.stringify(lead.gps_check);
      expect(stored).not.toContain('27.4');
      expect(stored).not.toContain('82.45');
      expect(Object.keys(lead.gps_check).sort()).toEqual([
        'checked_at', 'distance_m', 'mode', 'premise', 'radius_m', 'result', 'scheduled_service_id', 'technician_id', 'truck_reported_at',
      ]);
      expect(lead.gps_check.premise).toEqual({ address: '12 Sample Way', city: 'Bradenton', zip: '34202' });
      expect(lead.gps_check.technician_id).toBe(id);
      expect((await activityFor(lead.id)).description).toMatch(/ · GPS: verified, \d+ m$/);
      // The owner's alert names the Neighbor (first name, last initial), not "Unknown customer".
      expect(TwilioService.sendSMS.mock.calls.at(-1)[1]).toBe('🔔 Field Lead: Sample Alpha flagged Pest opportunity at Neighbor S. (neighbor).\nNotes: Ants');
    });

    it('is not verified when the truck is too far, and says how far', async () => {
      const id = await tech('Sample Alpha');
      await truck(id, TRUCK_FAR);
      const res = await neighbor(id);
      expect(res.status).toBe(200);
      const lead = await leadFor(id);
      expect(lead.gps_verified).toBe(false);
      expect(lead.gps_check.result).toBe('too_far');
      expect((await activityFor(lead.id)).description).toMatch(/GPS: not verified \(too far, 1\.\d km\)$/);
    });

    it('is not verified on a truck position 7 hours old', async () => {
      const id = await tech('Sample Alpha');
      await truck(id, TRUCK_NEAR, 7);
      await neighbor(id);
      expect((await leadFor(id)).gps_check.result).toBe('stale_truck_position');
    });

    it('is not verified for a technician with no truck, or a truck with no position', async () => {
      const noTruck = await tech('Sample Alpha');
      await neighbor(noTruck);
      expect((await leadFor(noTruck)).gps_check.result).toBe('no_truck');
      const noPosition = await tech('Sample Bravo');
      await trx('technicians').where({ id: noPosition }).update({ bouncie_imei: `IMEI${Math.floor(Math.random() * 1e12)}` });
      await neighbor(noPosition);
      expect((await leadFor(noPosition)).gps_check.result).toBe('no_truck_position');
    });

    it('makes the lead when the address cannot be geocoded', async () => {
      const id = await tech('Sample Alpha');
      await truck(id, TRUCK_NEAR);
      geocodeAddressWithStatus.mockResolvedValueOnce({ location: null, reason: 'outside_service_area' });
      const res = await neighbor(id);
      expect(res.status).toBe(200);
      const lead = await leadFor(id);
      expect(lead.gps_verified).toBe(false);
      expect(lead.gps_check.result).toBe('address_not_found');
    });

    it('refuses a Neighbor with no phone, no first name, no address or no ZIP, and makes no lead', async () => {
      const id = await tech('Sample Alpha');
      for (const patch of [{ phone: '' }, { phone: '555' }, { firstName: ' ' }, { address: '' }, { zip: '' }]) {
        const res = await neighbor(id, { prospect: { ...PROSPECT, ...patch } });
        expect(res.status).toBe(400);
      }
      expect(await trx('leads').where({ assigned_to: id }).first()).toBeUndefined();
    });

    it('honors the radius setting, and falls back to 300 m when it is not a whole number', async () => {
      const id = await tech('Sample Alpha');
      await truck(id, TRUCK_FAR);
      await trx('system_settings').insert({ key: 'field_flag.gps_radius_m', value: '1500', category: 'field_flag' });
      await neighbor(id);
      let lead = await leadFor(id);
      expect(lead.gps_check).toMatchObject({ result: 'verified', radius_m: 1500 });
      await trx('system_settings').where({ key: 'field_flag.gps_radius_m' }).update({ value: '12 km' });
      await trx('leads').where({ assigned_to: id }).del();
      await neighbor(id);
      lead = await leadFor(id);
      expect(lead.gps_check).toMatchObject({ result: 'too_far', radius_m: 300 });
    });
  });

  describe('Sold by auto-fill', () => {
    const fill = async (id) => autoFillSoldBy(trx, await estimateRow(id));
    // A visit flag on a customer, and the estimate the office built from it for that customer.
    const bound = async (t, { lead = {}, est = {} } = {}) => {
      const cust = await customer();
      const e = await estimate({ customer_id: cust, ...est });
      const l = await flagLead(t, { customer_id: cust, estimate_id: e, ...lead });
      return { cust, est: e, lead: l };
    };
    const NEIGHBOR = (t) => ({
      address: '12 Sample Way', city: 'Bradenton', zip: '34202',
      gps_check: { result: 'verified', mode: 'prospect', technician_id: t, premise: { address: '12 Sample Way', city: 'Bradenton', zip: '34202' } },
    });

    it('fills from a verified visit flag the estimate was built from, for the visited customer', async () => {
      const t = await tech('Sample Alpha');
      const { est, lead } = await bound(t);
      const filled = await fill(est);
      expect(filled).toMatchObject({ sold_by_technician_id: t, sold_by_source: 'flag', sold_by_lead_id: lead });
      expect((await estimateRow(est)).sold_by_set_at).toBeInstanceOf(Date);
    });

    it('never fills from the same customer or a typed phone alone: only the lead the estimate was built from', async () => {
      const t = await tech('Sample Alpha');
      const cust = await customer();
      const lead = await flagLead(t, { customer_id: cust, phone: '+19415550142' });
      const est = await estimate({ customer_id: cust, customer_phone: '(941) 555-0142' });
      expect((await fill(est)).sold_by_source).toBeFalsy();
      await trx('leads').where({ id: lead }).update({ estimate_id: est });
      expect((await fill(est)).sold_by_lead_id).toBe(lead);
    });

    it("does not fill a visit flag's estimate made for another customer", async () => {
      const t = await tech('Sample Alpha');
      const visited = await customer();
      const other = await customer({ first_name: 'Other' });
      const est = await estimate({ customer_id: other });
      await flagLead(t, { customer_id: visited, estimate_id: est });
      expect((await fill(est)).sold_by_source).toBeFalsy();
    });

    it("fills a Neighbor flag's estimate only at the address the truck was near", async () => {
      const t = await tech('Sample Alpha');
      const here = await estimate({ address: '12 Sample Way, Bradenton, FL 34202' });
      const lead = await flagLead(t, { estimate_id: here, ...NEIGHBOR(t) });
      expect((await fill(here)).sold_by_lead_id).toBe(lead);

      const moved = await estimate({ address: '480 Faraway Rd, Bradenton, FL 34202' });
      await flagLead(t, { estimate_id: moved, ...NEIGHBOR(t) });
      expect((await fill(moved)).sold_by_source).toBeFalsy();

      const otherZip = await estimate({ address: '12 Sample Way, Venice, FL 34285' });
      await flagLead(t, { estimate_id: otherZip, ...NEIGHBOR(t) });
      expect((await fill(otherZip)).sold_by_source).toBeFalsy();
    });

    it("never follows an office edit to the lead's customer or address", async () => {
      const t = await tech('Sample Alpha');
      // A visit flag at customer A; the office edits the lead to customer B and builds B's estimate.
      const a = await customer();
      const b = await customer({ first_name: 'Other' });
      const estB = await estimate({ customer_id: b });
      const visitLead = await flagLead(t, { customer_id: a, estimate_id: estB });
      await trx('leads').where({ id: visitLead }).update({ customer_id: b });
      expect((await fill(estB)).sold_by_source).toBeFalsy();
      // A Neighbor flag at 12 Sample Way; the office edits the lead's address to the estimate's.
      const far = await estimate({ address: '480 Faraway Rd, Bradenton, FL 34202' });
      const nLead = await flagLead(t, { estimate_id: far, ...NEIGHBOR(t) });
      await trx('leads').where({ id: nLead }).update({ address: '480 Faraway Rd' });
      expect((await fill(far)).sold_by_source).toBeFalsy();
    });

    it('credits the technician who flagged, not the one the lead was reassigned to', async () => {
      const flagger = await tech('Sample Alpha');
      const other = await tech('Sample Bravo');
      const { est, lead } = await bound(flagger);
      await trx('leads').where({ id: lead }).update({ assigned_to: other });
      await fill(est);
      expect(await estimateRow(est)).toMatchObject({ sold_by_technician_id: flagger, sold_by_source: 'flag' });
    });

    it('credits one estimate per flag, and an office clear frees it', async () => {
      const t = await tech('Sample Alpha');
      const { cust, est: first, lead } = await bound(t);
      const second = await estimate({ customer_id: cust });
      expect((await fill(first)).sold_by_lead_id).toBe(lead);
      await trx('leads').where({ id: lead }).update({ estimate_id: second });
      expect((await fill(second)).sold_by_source).toBeFalsy();
      await admin('PUT', `/${first}/sold-by`, { technicianId: null });
      expect((await fill(second)).sold_by_lead_id).toBe(lead);
    });

    it('ignores a flag older than 60 days, an unverified flag and a flag with another channel', async () => {
      const t = await tech('Sample Alpha');
      const cust = await customer();
      const est = await estimate({ customer_id: cust });
      for (const patch of [{ created_at: new Date(Date.now() - 61 * DAY) }, { gps_verified: false }, { first_contact_channel: 'web_form' }]) {
        await flagLead(t, { customer_id: cust, estimate_id: est, ...patch });
      }
      expect((await fill(est)).sold_by_source).toBeFalsy();
    });

    it('ignores a 1099 technician, an inactive technician and the owner', async () => {
      const cust = await customer();
      const est = await estimate({ customer_id: cust });
      for (const patch of [{ employment_type: '1099' }, { active: false }]) {
        await flagLead(await tech(`Sample ${JSON.stringify(patch)}`, patch), { customer_id: cust, estimate_id: est });
      }
      await flagLead(ADMIN_ID, { customer_id: cust, estimate_id: est });
      expect((await fill(est)).sold_by_source).toBeFalsy();
      expect((await estimateRow(est)).sold_by_technician_id).toBeNull();
    });

    it('takes the newest of two flags', async () => {
      const older = await tech('Sample Alpha');
      const newer = await tech('Sample Bravo');
      const cust = await customer();
      const est = await estimate({ customer_id: cust });
      await flagLead(older, { customer_id: cust, estimate_id: est, created_at: new Date(Date.now() - 5 * DAY) });
      const newest = await flagLead(newer, { customer_id: cust, estimate_id: est, created_at: new Date(Date.now() - 1 * DAY) });
      expect(await fill(est)).toMatchObject({ sold_by_technician_id: newer, sold_by_lead_id: newest });
    });

    it('never refills a cleared estimate or overwrites an office choice', async () => {
      const t = await tech('Sample Alpha');
      const chosen = await tech('Sample Bravo');
      const { est: cleared } = await bound(t, { est: { sold_by_source: 'cleared', sold_by_set_by: ADMIN_ID } });
      expect((await fill(cleared)).sold_by_technician_id).toBeFalsy();
      const { est: office } = await bound(t, { est: { sold_by_source: 'office', sold_by_technician_id: chosen, sold_by_set_by: ADMIN_ID } });
      expect((await fill(office)).sold_by_technician_id).toBe(chosen);
      expect((await estimateRow(office)).sold_by_technician_id).toBe(chosen);
    });

    it('does nothing once the customer accepted', async () => {
      const t = await tech('Sample Alpha');
      const { est } = await bound(t, { est: { accepted_at: new Date() } });
      await fill(est);
      expect((await estimateRow(est)).sold_by_source).toBeNull();
    });

    it('does nothing with the gate off', async () => {
      delete process.env.GATE_COMMISSION_SOLD_BY;
      const t = await tech('Sample Alpha');
      const { est } = await bound(t);
      await fill(est);
      expect((await estimateRow(est)).sold_by_source).toBeNull();
    });
  });

  describe('Sold by on the admin routes', () => {
    it('lets an admin set an active W-2 technician and records one audit event', async () => {
      const t = await tech('Sample Alpha');
      const est = await estimate();
      const res = await admin('PUT', `/${est}/sold-by`, { technicianId: t });
      expect(res.status).toBe(200);
      expect(res.body.soldBy).toEqual({ technicianId: t, source: 'office' });
      expect(await estimateRow(est)).toMatchObject({ sold_by_technician_id: t, sold_by_source: 'office', sold_by_set_by: ADMIN_ID, sold_by_lead_id: null });
      const events = await trx('audit_log').where({ action: 'estimate.sold_by_set', resource_id: est });
      expect(events).toHaveLength(1);
      expect(events[0].actor_id).toBe(ADMIN_ID);
      expect(events[0].actor_type).toBe('admin');
      expect(events[0].metadata).toEqual({ previous_technician_id: null, previous_source: null, technician_id: t, source: 'office' });
    });

    it('answers a malformed estimate id with 404 and a malformed technician id with 400', async () => {
      const est = await estimate();
      expect((await admin('PUT', '/not-an-id/sold-by', { technicianId: null })).status).toBe(404);
      expect((await admin('PUT', `/${est}/sold-by`, { technicianId: 'not-an-id' })).status).toBe(400);
      expect((await estimateRow(est)).sold_by_source).toBeNull();
    });

    it('clears with null, and the flag does not refill it', async () => {
      const t = await tech('Sample Alpha');
      const cust = await customer();
      await flagLead(t, { customer_id: cust });
      const est = await estimate({ customer_id: cust });
      await admin('PUT', `/${est}/sold-by`, { technicianId: t });
      const res = await admin('PUT', `/${est}/sold-by`, { technicianId: null });
      expect(res.status).toBe(200);
      expect(await estimateRow(est)).toMatchObject({ sold_by_technician_id: null, sold_by_source: 'cleared', sold_by_set_by: ADMIN_ID });
      await autoFillSoldBy(trx, await estimateRow(est));
      expect((await estimateRow(est)).sold_by_source).toBe('cleared');
    });

    it('refuses a 1099, an inactive or an unknown technician, and a missing field', async () => {
      const est = await estimate();
      const contractor = await tech('Sample Contractor', { employment_type: '1099' });
      const gone = await tech('Sample Gone', { active: false });
      for (const technicianId of [contractor, gone, randomUUID()]) {
        expect((await admin('PUT', `/${est}/sold-by`, { technicianId })).status).toBe(400);
      }
      expect((await admin('PUT', `/${est}/sold-by`, {})).status).toBe(400);
      expect((await estimateRow(est)).sold_by_source).toBeNull();
    });

    it('answers 409 once the customer accepted', async () => {
      const t = await tech('Sample Alpha');
      const est = await estimate({ accepted_at: new Date() });
      const res = await admin('PUT', `/${est}/sold-by`, { technicianId: t });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Sold by is locked once the customer accepts.');
      expect((await estimateRow(est)).sold_by_source).toBeNull();
      expect(await trx('audit_log').where({ action: 'estimate.sold_by_set' }).first()).toBeUndefined();
    });

    it('is admin only', async () => {
      const t = await tech('Sample Alpha');
      const est = await estimate();
      const response = await fetch(`${baseUrl}/api/admin/estimates/${est}/sold-by`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-test-tech': t, 'x-test-role': 'technician' },
        body: JSON.stringify({ technicianId: t }),
      });
      expect(response.status).toBe(403);
      const options = await fetch(`${baseUrl}/api/admin/estimates/sold-by/options`, {
        headers: { 'x-test-tech': t, 'x-test-role': 'technician' },
      });
      expect(options.status).toBe(403);
    });

    it('lists active W-2 technicians as the choices', async () => {
      await tech('Sample Alpha');
      await tech('Sample Contractor', { employment_type: '1099' });
      await tech('Sample Gone', { active: false });
      const res = await admin('GET', '/sold-by/options');
      expect(res.status).toBe(200);
      expect(res.body.technicians.map((x) => x.name)).toEqual(['Sample Alpha']);
    });

    it('answers 404 on both routes with the gate off', async () => {
      delete process.env.GATE_COMMISSION_SOLD_BY;
      const t = await tech('Sample Alpha');
      const est = await estimate();
      expect((await admin('PUT', `/${est}/sold-by`, { technicianId: t })).status).toBe(404);
      expect((await admin('GET', '/sold-by/options')).status).toBe(404);
      expect((await estimateRow(est)).sold_by_source).toBeNull();
    });
  });

  describe('Sold by on the estimate list', () => {
    it('returns soldBy with the gate on, and no key with the gate off', async () => {
      const t = await tech('Sample Alpha');
      const cust = await customer();
      const lead = await flagLead(t, {
        customer_id: cust, gps_check: JSON.stringify({ result: 'verified', mode: 'prospect', distance_m: 40 }),
      });
      const est = await estimate({
        customer_id: cust, sold_by_technician_id: t, sold_by_source: 'flag', sold_by_lead_id: lead, sold_by_set_at: new Date(),
      });
      const plain = await estimate({ customer_name: 'Plain Customer' });
      const on = await admin('GET', '?limit=all');
      expect(on.status).toBe(200);
      const rows = Object.fromEntries(on.body.estimates.map((e) => [e.id, e]));
      expect(rows[est].soldBy).toMatchObject({
        technicianId: t, name: 'Sample Alpha', source: 'flag', leadId: lead, gpsDistanceM: 40,
      });
      expect(rows[est].soldBy.flaggedAt).toBeTruthy();
      expect(rows[plain].soldBy).toEqual({
        technicianId: null, name: null, source: null, leadId: null, gpsDistanceM: null, flaggedAt: null,
      });
      delete process.env.GATE_COMMISSION_SOLD_BY;
      const off = await admin('GET', '?limit=all');
      expect(off.body.estimates.every((e) => !('soldBy' in e))).toBe(true);
      expect(await loadSoldByForList(trx, [])).toBeNull();
    });

    it('keeps an unknown GPS distance unknown, never 0 m', async () => {
      const t = await tech('Sample Alpha');
      const cust = await customer();
      const lead = await flagLead(t, {
        customer_id: cust, gps_check: JSON.stringify({ result: 'verified', mode: 'customer', technician_id: t, distance_m: null }),
      });
      const est = await estimate({
        customer_id: cust, sold_by_technician_id: t, sold_by_source: 'flag', sold_by_lead_id: lead, sold_by_set_at: new Date(),
      });
      const rows = Object.fromEntries((await admin('GET', '?limit=all')).body.estimates.map((e) => [e.id, e]));
      expect(rows[est].soldBy.gpsDistanceM).toBeNull();
    });
  });

  describe('Sold by inside the estimate save', () => {
    const body = (patch = {}) => ({
      address: '123 Palm Ave', customerName: 'Van Lee', customerPhone: '(941) 555-0142', customerEmail: 'van@example.invalid',
      leadId: null, customerId: null, monthlyTotal: 125, annualTotal: 1500, onetimeTotal: 0, waveguardTier: 'Gold',
      showOneTimeOption: false, billByInvoice: false,
      estimateData: { inputs: { address: '123 Palm Ave' }, result: { total: 125 } }, ...patch,
    });
    const NO_INPUTS = async () => ({ recomputed: false, reason: 'NO_INPUTS' });
    const create = (patch) => createOrReuseAdminEstimate({
      database: trx, body: body(patch), technicianId: ADMIN_ID, technician: { id: ADMIN_ID, name: 'Sample Admin' }, recompute: NO_INPUTS,
    });

    it('fills a new estimate built from a verified flag (leadId), and returns it', async () => {
      const t = await tech('Sample Alpha');
      const lead = await flagLead(t, { phone: '+19415550142', address: '123 Palm Ave', gps_check: { result: 'verified', mode: 'prospect', technician_id: t, premise: { address: '123 Palm Ave' } } });
      const { estimate: created } = await create({ leadId: lead });
      expect(created).toMatchObject({ sold_by_technician_id: t, sold_by_source: 'flag', sold_by_lead_id: lead });
      expect(await estimateRow(created.id)).toMatchObject({ sold_by_technician_id: t, sold_by_source: 'flag' });
      expect(created.created_by_technician_id).toBe(ADMIN_ID);
    });

    it('leaves a new estimate alone with the gate off', async () => {
      delete process.env.GATE_COMMISSION_SOLD_BY;
      const t = await tech('Sample Alpha');
      const lead = await flagLead(t, { phone: '+19415550142', address: '123 Palm Ave', gps_check: { result: 'verified', mode: 'prospect', technician_id: t, premise: { address: '123 Palm Ave' } } });
      const { estimate: created } = await create({ leadId: lead });
      expect(await estimateRow(created.id)).toMatchObject({ sold_by_technician_id: null, sold_by_source: null });
    });

    it('fills on a revision that comes after the flag, and keeps an office choice through it', async () => {
      const { estimate: created } = await create();
      expect(created.sold_by_source).toBeNull();
      const t = await tech('Sample Alpha');
      const lead = await flagLead(t, { estimate_id: created.id, address: '123 Palm Ave', gps_check: { result: 'verified', mode: 'prospect', technician_id: t, premise: { address: '123 Palm Ave' } } });
      const revised = await reviseAdminEstimate({
        database: trx, estimateId: created.id, body: body({ notes: 'Revised' }), technicianId: ADMIN_ID,
        technician: { id: ADMIN_ID, name: 'Sample Admin' }, recompute: NO_INPUTS,
      });
      expect(revised.estimate).toMatchObject({ sold_by_technician_id: t, sold_by_source: 'flag', sold_by_lead_id: lead });
      const chosen = await tech('Sample Bravo');
      await admin('PUT', `/${created.id}/sold-by`, { technicianId: chosen });
      const again = await reviseAdminEstimate({
        database: trx, estimateId: created.id, body: body({ notes: 'Revised again' }), technicianId: ADMIN_ID,
        technician: { id: ADMIN_ID, name: 'Sample Admin' }, recompute: NO_INPUTS,
      });
      expect(again.estimate).toMatchObject({ sold_by_technician_id: chosen, sold_by_source: 'office' });
    });

    it('does not change the edit version when Sold by changes', async () => {
      const { estimateEditVersion } = require('../services/admin-estimate-persistence');
      const { estimate: created } = await create();
      const before = estimateEditVersion(await estimateRow(created.id));
      const t = await tech('Sample Alpha');
      await admin('PUT', `/${created.id}/sold-by`, { technicianId: t });
      expect(estimateEditVersion(await estimateRow(created.id))).toBe(before);
    });
  });

  describe('the table checks', () => {
    const rejects = async (patch) => {
      const sp = await trx.transaction();
      try {
        await sp('estimates').insert({ customer_name: 'Sample', status: 'draft', ...patch });
        await sp.rollback();
        return false;
      } catch (err) {
        await sp.rollback().catch(() => {});
        return /check|violates/i.test(err.message);
      }
    };

    it('rejects every invalid combination and accepts the valid ones', async () => {
      const t = await tech('Sample Alpha');
      const lead = await flagLead(t);
      expect(await rejects({ sold_by_source: 'bogus' })).toBe(true);
      expect(await rejects({ sold_by_technician_id: t })).toBe(true); // technician with no source
      expect(await rejects({ sold_by_lead_id: lead })).toBe(true); // lead with no source
      expect(await rejects({ sold_by_source: 'flag', sold_by_lead_id: lead })).toBe(true); // flag without technician
      expect(await rejects({ sold_by_source: 'office' })).toBe(true); // office without technician
      expect(await rejects({ sold_by_source: 'cleared', sold_by_technician_id: t })).toBe(true); // cleared with technician
      expect(await rejects({ sold_by_source: 'flag', sold_by_technician_id: t, sold_by_lead_id: lead })).toBe(false);
      expect(await rejects({ sold_by_source: 'flag', sold_by_technician_id: t })).toBe(false); // the flag's lead was deleted
      expect(await rejects({ sold_by_source: 'office', sold_by_technician_id: t })).toBe(false);
      expect(await rejects({ sold_by_source: 'cleared' })).toBe(false);
      expect(await rejects({})).toBe(false);
    });

    it('refuses to delete a technician who is the recorded seller (the foreign key, not the shape check)', async () => {
      const t = await tech('Sample Alpha');
      await estimate({ sold_by_source: 'office', sold_by_technician_id: t });
      const sp = await trx.transaction();
      await expect(sp('technicians').where({ id: t }).del()).rejects.toThrow(/sold_by_technician_id_foreign|estimates_sold_by_technician_id_fkey|foreign key/);
      await sp.rollback().catch(() => {});
    });

    it("lets a flag's lead be deleted: the link empties and the seller stays", async () => {
      const t = await tech('Sample Alpha');
      const lead = await flagLead(t);
      const est = await estimate({ sold_by_source: 'flag', sold_by_technician_id: t, sold_by_lead_id: lead });
      await trx('leads').where({ id: lead }).del();
      expect(await estimateRow(est)).toMatchObject({ sold_by_source: 'flag', sold_by_technician_id: t, sold_by_lead_id: null });
    });

    it('lets a technician who is only the setting admin be deleted: the admin id is nulled', async () => {
      const admin2 = await tech('Sample Admin Two', { role: 'admin' });
      const t = await tech('Sample Alpha');
      const est = await estimate({ sold_by_source: 'office', sold_by_technician_id: t, sold_by_set_by: admin2 });
      await trx('technicians').where({ id: admin2 }).del();
      expect((await estimateRow(est)).sold_by_set_by).toBeNull();
    });
  });

  describe('describeGpsCheck', () => {
    it('words each result', () => {
      expect(describeGpsCheck({ result: 'verified', distance_m: 40 })).toBe('GPS: verified, 40 m');
      expect(describeGpsCheck({ result: 'too_far', distance_m: 1234 })).toBe('GPS: not verified (too far, 1.2 km)');
      expect(describeGpsCheck({ result: 'stale_truck_position' })).toBe('GPS: not verified (truck position too old)');
      expect(describeGpsCheck(null)).toBeNull();
    });
  });

  describe('setEstimateSoldBy', () => {
    it('rejects a non-string technician id', async () => {
      await expect(setEstimateSoldBy({ estimateId: randomUUID(), technicianId: 5, actorId: ADMIN_ID })).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
