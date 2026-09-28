/**
 * GET /api/admin/schedule — the `customerSentPhotos` stop chip flag
 * (customer-visit-photos scope doc §5.4 item 2, PR 3b).
 *
 * Real migrated PostgreSQL, real router, real adminAuthenticate with a
 * signed staff access token (same pattern as
 * admin-dispatch-day-feed-tech-scope.pg.test.js) — the day-view handler has
 * too many per-row collaborators (property_preferences, invoices, payments,
 * completion profiles, …) to mock faithfully, and the actual claim under
 * test — ONE batched query against visit_prep_photos, CURRENT
 * scheduled_services membership, gate-off omission — is a real-DB property
 * anyway.
 *
 * Skipped (not failed) without DATABASE_URL, like the sibling
 * visit-prep-postgres.test.js suite. All inserted fixtures are deleted in
 * afterAll. Synthetic names only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// admin-schedule.js is a very large module (25k+ lines, many transitive
// requires) — loading it plus the real per-row DB round trips on a loaded
// machine routinely exceeds Jest's 5s default hook/test timeout.
jest.setTimeout(30000);

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');

// A far-future, fixed date shared by every fixture in this file — admin
// requests aren't date-windowed (only technician tokens are), and using one
// date lets a single GET / call cover every scenario, filtered back out by
// the known scheduled_service ids (same shape as the day-feed-tech-scope
// pg test).
const DATE = '2099-04-15';

describeOrSkip('customerSentPhotos on GET /api/admin/schedule (PR 3b)', () => {
  let db, server, baseUrl, adminTech, adminToken, techA, techB;
  const insertedCustomerIds = [];
  const insertedServiceIds = [];
  const insertedSubmissionIds = [];
  const insertedVisitIds = [];

  beforeAll(async () => {
    db = require('../models/db');
    const router = require('../routes/admin-schedule');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/schedule', router);
    app.use((err, req, res, next) => res.status(500).json({ error: String(err && err.message) }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    [adminTech] = await db('technicians').insert({
      name: 'PR3b Admin', role: 'admin', employment_status: 'active', auth_token_version: 1,
    }).returning('*');
    adminToken = jwt.sign({ technicianId: adminTech.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);
    // Two real technician rows — the reassignment scenario needs a genuine
    // technician_id divergence, not a random UUID.
    [techA] = await db('technicians').insert({
      name: 'PR3b Tech A', role: 'technician', employment_status: 'active', auth_token_version: 1,
    }).returning('*');
    [techB] = await db('technicians').insert({
      name: 'PR3b Tech B', role: 'technician', employment_status: 'active', auth_token_version: 1,
    }).returning('*');
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) {
      if (insertedSubmissionIds.length) {
        await db('visit_prep_photos').whereIn('submission_id', insertedSubmissionIds).del();
        await db('visit_prep_submissions').whereIn('id', insertedSubmissionIds).del();
      }
      if (insertedServiceIds.length) await db('scheduled_services').whereIn('id', insertedServiceIds).del();
      if (insertedVisitIds.length) await db('service_visits').whereIn('id', insertedVisitIds).del();
      if (insertedCustomerIds.length) await db('customers').whereIn('id', insertedCustomerIds).del();
      const techIds = [adminTech, techA, techB].filter(Boolean).map((t) => t.id);
      if (techIds.length) await db('technicians').whereIn('id', techIds).del();
      await db.destroy();
    }
  });

  async function fixtureCustomer(label) {
    const id = randomUUID();
    await db('customers').insert({
      id, first_name: 'Synthetic', last_name: label,
      phone: `+1555${id.slice(0, 7)}`, address_line1: '1 Synthetic Ln',
      city: 'Bradenton', zip: '34201', active: true,
    });
    insertedCustomerIds.push(id);
    return id;
  }

  // scheduled_services.visit_id has a real FK to service_visits — every
  // grouped-stop fixture needs a row there first (same shape as the
  // sibling visit-prep-postgres.test.js's fixtureGroupedStop).
  async function fixtureVisit(customerId) {
    const id = randomUUID();
    await db('service_visits').insert({
      id, customer_id: customerId, scheduled_date: DATE,
      stop_base_key: `${customerId}:${DATE}`, stop_seq: 1, status: 'open', created_by: 'test',
    });
    insertedVisitIds.push(id);
    return id;
  }

  async function fixtureSvc(customerId, overrides = {}) {
    const id = randomUUID();
    await db('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: DATE,
      service_type: 'pest_control', status: 'confirmed', is_recurring: true,
      ...overrides,
    });
    insertedServiceIds.push(id);
    return id;
  }

  // Denormalized exactly like createVisitPrepSubmission's own persistLocked
  // insert: visit_prep_photos.scheduled_service_id is stamped at submission
  // time and never rewritten by a later regroup/detach.
  async function fixturePhoto(scheduledServiceId, customerId) {
    const submissionId = randomUUID();
    await db('visit_prep_submissions').insert({
      id: submissionId, scheduled_service_id: scheduledServiceId, customer_id: customerId, entry: 'appointment_page',
    });
    insertedSubmissionIds.push(submissionId);
    await db('visit_prep_photos').insert({
      id: randomUUID(), submission_id: submissionId, scheduled_service_id: scheduledServiceId,
      s3_key: `visitprep/${scheduledServiceId}.jpg`, mime_type: 'image/jpeg', byte_size: 100,
      image_sha256: randomUUID().replace(/-/g, '').padEnd(64, '0'), photo_index: 0,
    });
  }

  const get = async (envOverrides = {}) => {
    const prevValues = {};
    for (const [key, value] of Object.entries(envOverrides)) {
      prevValues[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const res = await fetch(`${baseUrl}/api/admin/schedule?date=${DATE}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      return { status: res.status, body: await res.json() };
    } finally {
      for (const [key, prev] of Object.entries(prevValues)) {
        if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
      }
    }
  };

  test('gate off: customerSentPhotos is omitted entirely, even for a stop that HAS photos', async () => {
    const customerId = await fixtureCustomer('GateOff');
    const svcId = await fixtureSvc(customerId);
    await fixturePhoto(svcId, customerId);

    const { status, body } = await get({ GATE_VISIT_PREP_PHOTOS: 'false' });
    expect(status).toBe(200);
    const row = body.services.find((s) => s.id === svcId);
    expect(row).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(row, 'customerSentPhotos')).toBe(false);
  });

  test('gate on: an ungrouped stop with no photos reads false; with a photo, true', async () => {
    const customerId = await fixtureCustomer('Ungrouped');
    const svcNoPhoto = await fixtureSvc(customerId);
    const svcWithPhoto = await fixtureSvc(customerId);
    await fixturePhoto(svcWithPhoto, customerId);

    const { status, body } = await get({ GATE_VISIT_PREP_PHOTOS: 'true' });
    expect(status).toBe(200);
    expect(body.services.find((s) => s.id === svcNoPhoto).customerSentPhotos).toBe(false);
    expect(body.services.find((s) => s.id === svcWithPhoto).customerSentPhotos).toBe(true);
  });

  test('gate on: a grouped stop reads true on EVERY member when either member has photos (shown once client-side)', async () => {
    const customerId = await fixtureCustomer('Grouped');
    const visitId = await fixtureVisit(customerId);
    const svcA = await fixtureSvc(customerId, { visit_id: visitId, service_type: 'pest_control' });
    const svcB = await fixtureSvc(customerId, { visit_id: visitId, service_type: 'lawn_care' });
    // The photo is stamped against svcA's own id only — svcB reads true
    // through CURRENT visit_id membership, not because it owns a photo row.
    await fixturePhoto(svcA, customerId);

    const { status, body } = await get({ GATE_VISIT_PREP_PHOTOS: 'true' });
    expect(status).toBe(200);
    expect(body.services.find((s) => s.id === svcA).customerSentPhotos).toBe(true);
    expect(body.services.find((s) => s.id === svcB).customerSentPhotos).toBe(true);
  });

  test('gate on: a member DETACHED from the group takes its photos with it — the remaining sibling stops reading true', async () => {
    const customerId = await fixtureCustomer('Detached');
    const visitId = await fixtureVisit(customerId);
    const svcA = await fixtureSvc(customerId, { visit_id: visitId, service_type: 'pest_control' });
    const svcB = await fixtureSvc(customerId, { visit_id: visitId, service_type: 'lawn_care' });
    await fixturePhoto(svcA, customerId);

    // svcA is detached from the group AFTER the photo was submitted — the
    // denormalized visit_prep_photos.scheduled_service_id still points at
    // svcA (never rewritten), but svcA's CURRENT visit_id is now null.
    await db('scheduled_services').where({ id: svcA }).update({ visit_id: null });

    const { status, body } = await get({ GATE_VISIT_PREP_PHOTOS: 'true' });
    expect(status).toBe(200);
    // svcA is its own stop now and still owns the photo.
    expect(body.services.find((s) => s.id === svcA).customerSentPhotos).toBe(true);
    // svcB is still grouped (alone, effectively) under visitId but no member
    // of ITS current group owns a photo any more — the flag must not stay
    // stuck on because it once shared a visit_id with svcA.
    expect(body.services.find((s) => s.id === svcB).customerSentPhotos).toBe(false);
  });

  test('gate on: ONE membership query + ONE photo query for the whole day, whatever the stop count', async () => {
    const customerId = await fixtureCustomer('QueryCount');
    const visitId = await fixtureVisit(customerId);
    await fixtureSvc(customerId, { visit_id: visitId, service_type: 'pest_control' });
    await fixtureSvc(customerId, { visit_id: visitId, service_type: 'lawn_care' });
    await fixtureSvc(customerId);

    const queries = [];
    const onQuery = (q) => queries.push(q.sql);
    db.on('query', onQuery);
    try {
      const { status } = await get({ GATE_VISIT_PREP_PHOTOS: 'true' });
      expect(status).toBe(200);
    } finally {
      db.removeListener('query', onQuery);
    }
    const photoQueries = queries.filter((sql) => /visit_prep_photos/i.test(sql));
    // The membership query selects FROM scheduled_services WHERE visit_id
    // IN (...) — distinguished from the day-view's own scheduled_services
    // query by the presence of "visit_id" in an IN-list WHERE clause.
    const membershipQueries = queries.filter((sql) => /from "scheduled_services"/i.test(sql) && /"visit_id" in/i.test(sql));
    expect(photoQueries).toHaveLength(1);
    expect(membershipQueries).toHaveLength(1);
  });

  test('gate on: a HIDDEN cancelled member (same tech/date) with photos still flags its live sibling true', async () => {
    const customerId = await fixtureCustomer('HiddenCancelled');
    const visitId = await fixtureVisit(customerId);
    const svcLive = await fixtureSvc(customerId, {
      visit_id: visitId, service_type: 'pest_control', technician_id: techA.id, status: 'confirmed',
    });
    // Cancelled rows are excluded from the day-view's own `services` query
    // (whereNotIn 'cancelled', 'rescheduled') — invisible in body.services,
    // but still a real scheduled_services row the membership query must see.
    const svcCancelled = await fixtureSvc(customerId, {
      visit_id: visitId, service_type: 'lawn_care', technician_id: techA.id, status: 'cancelled',
    });
    await fixturePhoto(svcCancelled, customerId);

    const { status, body } = await get({ GATE_VISIT_PREP_PHOTOS: 'true' });
    expect(status).toBe(200);
    expect(body.services.find((s) => s.id === svcCancelled)).toBeUndefined();
    expect(body.services.find((s) => s.id === svcLive).customerSentPhotos).toBe(true);
  });

  test('gate on: a member reassigned to a DIFFERENT technician is not counted as the same stop', async () => {
    const customerId = await fixtureCustomer('Reassigned');
    const visitId = await fixtureVisit(customerId);
    const svcMine = await fixtureSvc(customerId, { visit_id: visitId, service_type: 'pest_control', technician_id: techA.id });
    const svcOtherTech = await fixtureSvc(customerId, { visit_id: visitId, service_type: 'lawn_care', technician_id: techB.id });
    // Photo lives only on the OTHER technician's row.
    await fixturePhoto(svcOtherTech, customerId);

    const { status, body } = await get({ GATE_VISIT_PREP_PHOTOS: 'true' });
    expect(status).toBe(200);
    expect(body.services.find((s) => s.id === svcMine).customerSentPhotos).toBe(false);
    expect(body.services.find((s) => s.id === svcOtherTech).customerSentPhotos).toBe(true);
  });

  test('gate on: a member moved to a DIFFERENT day is not counted as the same stop', async () => {
    const customerId = await fixtureCustomer('MovedDay');
    const visitId = await fixtureVisit(customerId);
    const svcToday = await fixtureSvc(customerId, { visit_id: visitId, service_type: 'pest_control', technician_id: techA.id });
    const svcOtherDay = await fixtureSvc(customerId, {
      visit_id: visitId, service_type: 'lawn_care', technician_id: techA.id, scheduled_date: '2099-04-16',
    });
    // Photo lives only on the row that moved to the other day.
    await fixturePhoto(svcOtherDay, customerId);

    const { status, body } = await get({ GATE_VISIT_PREP_PHOTOS: 'true' });
    expect(status).toBe(200);
    expect(body.services.find((s) => s.id === svcToday).customerSentPhotos).toBe(false);
  });
});
