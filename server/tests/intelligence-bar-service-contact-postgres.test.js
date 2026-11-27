/**
 * IB set_customer_service_contact (IB gap #28) against real Postgres (committed rows, cleaned up): the confirmed card
 * runs the customer page's own PUT /:id handler (setServiceContactsFromBar), which stores the contact as the page
 * does (formatted phone and email, compacted slots, the consent stamp cleared on a change of who is listed), and a
 * contact edit that lands after the card refuses with nothing written. Synthetic names only.
 */
const { randomUUID } = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const db = require('../models/db');
const { executeServiceContactTool } = require('../services/intelligence-bar/service-contact-tools');

// The exact marker line the CI database lane selects suites by (tests.yml).
const SKIP = !process.env.DATABASE_URL;
const url = !SKIP ? new URL(process.env.DATABASE_URL) : null;
const usable = url && (/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)
  || (process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test'));
jest.setTimeout(30000);

const ADMIN = { isAdmin: true, technicianId: null };
const TOOL = 'set_customer_service_contact';

(!SKIP && usable ? describe : describe.skip)('IB set_customer_service_contact (real PG)', () => {
  const created = [];
  afterAll(async () => {
    for (const id of created) {
      await db('activity_log').where({ customer_id: id }).del().catch(() => {});
      await db('customers').where({ id }).del();
    }
    await db.destroy();
  });

  async function customer(fields = {}) {
    const id = randomUUID();
    await db('customers').insert({ id, first_name: 'Fixture', last_name: 'Contacts', phone: '+12025550161', email: `${id}@example.invalid`, property_type: 'residential', ...fields });
    created.push(id);
    return id;
  }

  async function run(input) {
    const card = await executeServiceContactTool(TOOL, input, ADMIN);
    expect(card.preview).toBe(true);
    return executeServiceContactTool(TOOL, { ...input, confirmed: true, _verified_service_contact_version: card._version }, ADMIN);
  }

  test('add then remove: stored as the page stores it, and the consent stamp is cleared', async () => {
    const id = await customer({
      service_contact_name: 'Ava Fixture', service_contact_phone: '+12025550162',
      service_contacts_consent_at: new Date('2026-11-01T12:00:00Z'), service_contacts_consent_source: 'fixture',
    });
    const added = await run({ customer_id: id, action: 'add', relationship: 'tenant', name: 'Sam Fixture', phone: '(202) 555-0163', email: 'Sam.Fixture@Example.invalid' });
    expect(added.success).toBe(true);
    let row = await db('customers').where({ id }).first();
    expect(row.service_contact2_name).toBe('Sam Fixture');
    expect(row.service_contact2_phone).toBe('+12025550163');
    expect(row.service_contact2_email).toBe('sam.fixture@example.invalid');
    expect(row.service_contact2_role).toBe('tenant');
    expect(row.service_contacts_consent_at).toBeNull();

    const removed = await run({ customer_id: id, action: 'remove', slot: 1 });
    expect(removed.success).toBe(true);
    row = await db('customers').where({ id }).first();
    expect(row.service_contact_name).toBe('Sam Fixture');
    expect(row.service_contact_role).toBe('tenant');
    expect(row.service_contact2_name).toBeNull();
  });

  test('a contact edit after the card refuses and writes nothing', async () => {
    const id = await customer();
    const input = { customer_id: id, action: 'add', relationship: 'family_member', name: 'Lee Fixture', phone: '+12025550164' };
    const card = await executeServiceContactTool(TOOL, input, ADMIN);
    await db('customers').where({ id }).update({ service_contact_name: 'Other Fixture', service_contact_phone: '+12025550165' });
    const result = await executeServiceContactTool(TOOL, { ...input, confirmed: true, _verified_service_contact_version: card._version }, ADMIN);
    expect(result.code).toBe('preview_changed');
    const row = await db('customers').where({ id }).first();
    expect(row.service_contact_name).toBe('Other Fixture');
    expect(row.service_contact2_name).toBeNull();
  });
});
