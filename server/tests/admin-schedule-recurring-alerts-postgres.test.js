/**
 * GET /api/admin/schedule/recurring-alerts: which recurring plans raise an
 * end-of-plan alert, and that the derived scans read their plans in grouped
 * queries, so plans that cannot alert add no queries (the scans used to run
 * several queries per plan: ~5,700 per page load on a Waves-size book).
 *
 * Real migrated PostgreSQL, real router, real adminAuthenticate with a signed
 * staff token (the admin-schedule-neighborhood-gate-actions.pg.test.js
 * pattern). Synthetic records only; deleted in afterAll.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

describeOrSkip('recurring end-of-plan alerts on GET /api/admin/schedule/recurring-alerts', () => {
  let db; let server; let baseUrl; let admin; let token; let service;
  const customers = { live: randomUUID(), other: randomUUID(), former: randomUUID() };
  const plans = {};
  const visitIds = [];
  const day = (offset) => etDateString(addETDays(new Date(), offset));

  // A plan = its parent row (the first, completed visit) plus child visits.
  async function addPlan(name, { customer = customers.live, ongoing = false, visits = [] } = {}) {
    const id = randomUUID();
    plans[name] = id;
    const base = {
      customer_id: customer, service_type: service.name, service_id: service.id,
      is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: ongoing,
    };
    await db('scheduled_services').insert({ ...base, id, scheduled_date: day(-200), status: 'completed' });
    visitIds.push(id);
    for (const visit of visits) {
      const visitId = randomUUID();
      await db('scheduled_services').insert({
        ...base, id: visitId, recurring_parent_id: id, scheduled_date: day(visit.day), status: visit.status,
        is_recurring: !visit.booster,
      });
      visitIds.push(visitId);
    }
    return id;
  }

  async function fetchAlerts() {
    const res = await fetch(`${baseUrl}/api/admin/schedule/recurring-alerts`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const mine = new Set(Object.values(plans));
    return (await res.json()).alerts.filter((alert) => mine.has(alert.parentId));
  }

  beforeAll(async () => {
    db = require('../models/db');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/schedule', require('../routes/admin-schedule'));
    app.use((err, req, res, next) => res.status(500).json({ error: String(err && err.message) }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    [admin] = await db('technicians')
      .insert({ name: 'Recurring Alerts Admin', role: 'admin', employment_status: 'active', auth_token_version: 1 }).returning('*');
    token = jwt.sign({ technicianId: admin.id, type: 'access', tokenVersion: 1 }, process.env.JWT_SECRET);
    service = await db('services').where({ name: 'Quarterly Pest Control Service' }).first('id', 'name');
    await db('customers').insert([
      { id: customers.live, first_name: 'Synthetic', last_name: 'PlanLive', phone: `+1555${customers.live.slice(0, 7)}`, active: true },
      { id: customers.other, first_name: 'Synthetic', last_name: 'PlanOther', phone: `+1555${customers.other.slice(0, 7)}`, active: true },
      { id: customers.former, first_name: 'Synthetic', last_name: 'PlanFormer', phone: `+1555${customers.former.slice(0, 7)}`, active: false },
    ]);
    const past = { day: -100, status: 'completed' };
    await addPlan('endingSoon', { visits: [past, { day: 7, status: 'pending' }] });
    await addPlan('twoLeft', { visits: [past, { day: 7, status: 'pending' }, { day: 30, status: 'confirmed' }] });
    await addPlan('endingLater', { visits: [past, { day: 30, status: 'pending' }] });
    await addPlan('ownQueue', { visits: [past, { day: 5, status: 'pending' }] });
    await addPlan('oldOwnerQueue', { visits: [past, { day: 6, status: 'pending' }] });
    await addPlan('exhausted', { ongoing: true, visits: [past, { day: -20, status: 'completed' }, { day: -10, status: 'completed', booster: true }] });
    await addPlan('formerExhausted', { customer: customers.former, ongoing: true, visits: [past] });
    await addPlan('ongoingWithVisits', { ongoing: true, visits: [past, { day: 20, status: 'pending' }] });
    await db('recurring_plan_alerts').insert([
      { recurring_parent_id: plans.ownQueue, customer_id: customers.live, alert_type: 'plan_ending', last_visit_date: day(5), recurring_pattern: 'quarterly', remaining_visits: 1 },
      // An old owner's open queue row does not hide the current owner's alert.
      { recurring_parent_id: plans.oldOwnerQueue, customer_id: customers.other, alert_type: 'plan_ending', last_visit_date: day(6), recurring_pattern: 'quarterly', remaining_visits: 1 },
    ]);
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    if (db) {
      await db('recurring_plan_alerts').whereIn('recurring_parent_id', Object.values(plans)).del();
      if (visitIds.length) await db('scheduled_services').whereIn('id', visitIds).del();
      await db('customers').whereIn('id', Object.values(customers)).del();
      if (admin) await db('technicians').where({ id: admin.id }).del();
      await db.destroy();
    }
  });

  test('raises ending-soon and run-dry alerts only for plans that are ending, for live customers', async () => {
    const alerts = await fetchAlerts();
    const byPlan = Object.fromEntries(Object.entries(plans).map(([name, id]) => [name, alerts.filter((a) => a.parentId === id)]));
    expect(byPlan.endingSoon).toEqual([expect.objectContaining({
      id: `derived-${plans.endingSoon}`, alertType: 'plan_ending_soon', remainingVisits: 1, lastVisitDate: day(7),
    })]);
    expect(byPlan.oldOwnerQueue).toEqual([expect.objectContaining({
      id: `derived-${plans.oldOwnerQueue}`, alertType: 'plan_ending_soon', customerId: customers.live,
    })]);
    // The current owner's open queue row stands in for the derived alert.
    expect(byPlan.ownQueue).toEqual([expect.objectContaining({ source: 'queue', alertType: 'plan_ending' })]);
    expect(byPlan.exhausted).toEqual([expect.objectContaining({
      id: `derived-${plans.exhausted}`, alertType: 'ongoing_plan_exhausted', remainingVisits: 0,
    })]);
    for (const name of ['twoLeft', 'endingLater', 'formerExhausted', 'ongoingWithVisits']) expect(byPlan[name]).toEqual([]);
  });

  test('plans that cannot alert add no queries', async () => {
    const countQueries = async () => {
      let queries = 0;
      const onQuery = () => { queries += 1; };
      db.on('query', onQuery);
      try { await fetchAlerts(); } finally { db.removeListener('query', onQuery); }
      return queries;
    };
    await fetchAlerts(); // warm any per-process schema caches first
    const before = await countQueries();
    for (let i = 0; i < 15; i += 1) {
      await addPlan(`fixedLater${i}`, { visits: [{ day: -100, status: 'completed' }, { day: 60, status: 'pending' }] });
      await addPlan(`ongoingLater${i}`, { ongoing: true, visits: [{ day: -100, status: 'completed' }, { day: 60, status: 'pending' }] });
    }
    expect(await countQueries()).toBe(before);
  });
});
