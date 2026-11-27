/**
 * IB set_customer_service_contact (IB gap #28): add, change or remove one of the three extra contacts on a customer
 * account, the customer page's contact editor run in process behind a card. What the card shows (the contacts after
 * the save, who gets visit emails, the texting consent it clears, that nothing is sent), the refusals (three contacts
 * already, an empty slot, a phone already on the account, a bad phone from the route's own check), pin drift, admin
 * only, and that the commit runs the page's handler once with the exact slot body and the in-transaction re-check.
 * The handler is mocked; the slot normalizer and compactor are the route's real ones. Synthetic names only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../routes/admin-customers', () => {
  const actual = jest.requireActual('../routes/admin-customers');
  return { _private: actual._private, setServiceContactsFromBar: jest.fn() };
});

const db = require('../models/db');
const Customers = require('../routes/admin-customers');
const { executeServiceContactTool, cardLines } = require('../services/intelligence-bar/service-contact-tools');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const CUST = '00000000-0000-4000-8000-0000000000d8';
const ADMIN = { isAdmin: true, technicianId: 'staff-1' };

let state;
function emptySlots() {
  const row = {};
  for (const n of ['', '2', '3']) {
    for (const part of ['name', 'phone', 'email', 'role']) row[`service_contact${n}_${part}`] = null;
  }
  return row;
}
function freshState() {
  return {
    customer: {
      id: CUST, first_name: 'Robin', last_name: 'Sample', company_name: null, phone: '+19415550100', email: 'robin@example.invalid',
      service_contacts_consent_at: null, deleted_at: null, ...emptySlots(),
    },
  };
}

beforeEach(() => {
  state = freshState();
  db.mockImplementation(() => {
    const b = {
      where: () => b, whereNull: () => b,
      first: () => Promise.resolve(state.customer ? { ...state.customer } : undefined),
    };
    return b;
  });
  Customers.setServiceContactsFromBar.mockReset();
});

const preview = (input) => executeServiceContactTool('set_customer_service_contact', { customer_id: CUST, ...input }, ADMIN);
const confirm = (input, pinned) => executeServiceContactTool('set_customer_service_contact', {
  customer_id: CUST, ...input, confirmed: true, _verified_service_contact_version: pinned,
}, ADMIN);
const effectText = (p) => p.effects.map((e) => e.text).join('\n');

describe('set_customer_service_contact preview', () => {
  test('add puts the person in the first empty slot and says who gets what', async () => {
    state.customer.service_contact_name = 'Ava Example';
    state.customer.service_contact_phone = '+19415550111';
    const p = await preview({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '(941) 555-0122', email: 'Sam@Example.invalid' });
    expect(p.preview).toBe(true);
    expect(p.contacts_after).toEqual(['Ava Example (+19415550111)', 'Sam Example (family member, +19415550122, sam@example.invalid)']);
    expect(p._version.body).toMatchObject({ serviceContact2Name: 'Sam Example', serviceContact2Phone: '(941) 555-0122', serviceContact3Name: '' });
    const lines = effectText(p);
    expect(lines).toMatch(/sam@example\.invalid can get this account's appointment emails and service reports, as the account's notification settings/);
    expect(lines).toMatch(/No contact gets texts until the account holder confirms the contact list/);
    expect(lines).toMatch(/Nothing is sent now/);
    expect(cardLines('set_customer_service_contact', p)[0].text).toBe('Add contact: Sam Example (family member, +19415550122, sam@example.invalid) on Robin Sample');
    const contract = buildContract({ toolName: 'set_customer_service_contact', params: { customer_id: CUST }, displayParams: {}, preview: p, summary: 'x' });
    expect(JSON.stringify(contract)).toMatch(/appointment emails and service reports/);
  });

  test('refuses a fourth contact, an empty slot, a number already on the account and a bad phone', async () => {
    expect((await preview({ action: 'remove', slot: 2 })).code).toBe('slot_empty');
    expect((await preview({ action: 'add', name: 'No Relation', phone: '+19415550155' })).code).toBe('invalid_input');
    expect((await preview({ action: 'add', relationship: 'family_member', name: 'Holder Twin', phone: '941-555-0100' })).code).toBe('already_on_account');
    expect((await preview({ action: 'add', relationship: 'family_member', name: 'No Way' })).code).toBe('invalid_input');
    expect((await preview({ action: 'add', relationship: 'family_member', name: 'Short Number', phone: '555' })).code).toBe('invalid_contact');
    for (const [n, i] of [['', 1], ['2', 2], ['3', 3]]) {
      state.customer[`service_contact${n}_name`] = `Person ${i}`;
      state.customer[`service_contact${n}_phone`] = `+1941555013${i}`;
    }
    expect((await preview({ action: 'add', relationship: 'family_member', name: 'Fourth Person', phone: '+19415550199' })).code).toBe('slots_full');
  });

  test('remove compacts the list and says the stored texting consent is cleared', async () => {
    state.customer.service_contacts_consent_at = new Date('2026-11-01T12:00:00Z');
    Object.assign(state.customer, {
      service_contact_name: 'Ava Example', service_contact_phone: '+19415550111',
      service_contact2_name: 'Sam Example', service_contact2_phone: '+19415550122',
      service_contact3_name: 'Lee Example', service_contact3_email: 'lee@example.invalid',
    });
    const p = await preview({ action: 'remove', slot: 2 });
    expect(p.contacts_after).toEqual(['Ava Example (+19415550111)', 'Lee Example (lee@example.invalid)']);
    const lines = effectText(p);
    expect(lines).toMatch(/every contact, including the ones who stay, loses app sign-in/);
    expect(lines).toMatch(/\+19415550122 is no longer a contact number: anyone signed into the app with it is signed out/);
  });

  test('a tenant is recorded as a tenant and the card says they get no service reports', async () => {
    const p = await preview({ action: 'add', relationship: 'tenant', name: 'Tess Tenant', email: 'tess@example.invalid' });
    expect(p._version.roles).toEqual({ service_contact_role: 'tenant' });
    expect(p.contacts_after).toEqual(['Tess Tenant (tenant, tess@example.invalid)']);
    expect(effectText(p)).toMatch(/appointment emails but no service reports/);
  });

  test('a change of every detail without a relationship shows the role the save clears, not the old one', async () => {
    Object.assign(state.customer, { service_contact_name: 'Tess Tenant', service_contact_email: 'tess@example.invalid', service_contact_role: 'tenant' });
    const refused = await preview({ action: 'change', slot: 1, name: 'New Person', email: 'new@example.invalid' });
    expect(refused.code).toBe('invalid_input');
    expect(refused.error).toMatch(/their current one: tenant/);
    const p = await preview({ action: 'change', slot: 1, relationship: 'tenant', name: 'New Person', email: 'new@example.invalid' });
    expect(p.contacts_after).toEqual(['New Person (tenant, new@example.invalid)']);
    expect(p.summary).toBe('Change contact 1: Tess Tenant (tenant, tess@example.invalid) → New Person (tenant, new@example.invalid)');
    expect(effectText(p)).toMatch(/appointment emails but no service reports/);
  });

  test('every person who stays keeps their own role, even when two share a phone', async () => {
    Object.assign(state.customer, {
      service_contact_name: 'Lou Landlord', service_contact_phone: '+19415550111', service_contact_email: 'lou@example.invalid', service_contact_role: 'landlord',
      service_contact2_name: 'Tess Tenant', service_contact2_phone: '+19415550111', service_contact2_email: 'tess@example.invalid', service_contact2_role: 'tenant',
    });
    const p = await preview({ action: 'remove', slot: 1 });
    expect(p._version.roles).toEqual({ service_contact2_role: 'tenant' });
    expect(p._version.after[0]).toMatchObject({ name: 'Tess Tenant', role: 'tenant' });
    expect(effectText(p)).toMatch(/Tess Tenant becomes the first contact/);
  });

  test('a number that keeps its slot but loses its email says its email-only choices reset', async () => {
    Object.assign(state.customer, { service_contact_name: 'Ava Example', service_contact_phone: '+19415550111', service_contact_email: 'ava@example.invalid' });
    const p = await preview({ action: 'change', slot: 1, relationship: 'family_member', email: '' });
    expect(effectText(p)).toMatch(/\+19415550111 has no email after this/);
  });

  test('a phone another slot still lists is not described as signed out', async () => {
    Object.assign(state.customer, {
      service_contact_name: 'Ava Example', service_contact_phone: '+19415550111',
      service_contact2_name: 'Ava Again', service_contact2_phone: '+19415550111', service_contact2_email: 'ava@example.invalid',
    });
    const p = await preview({ action: 'remove', slot: 1 });
    expect(effectText(p)).not.toMatch(/no longer a contact number/);
  });

  test('a consent renewed after the card makes the confirm refuse', async () => {
    state.customer.service_contacts_consent_at = new Date('2026-11-01T12:00:00Z');
    const input = { action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' };
    const p = await preview(input);
    state.customer.service_contacts_consent_at = new Date('2026-11-20T12:00:00Z');
    expect((await confirm(input, p._version)).code).toBe('preview_changed');
    expect(Customers.setServiceContactsFromBar).not.toHaveBeenCalled();
  });

  test('without a slot, the reply lists the numbered contacts on file', async () => {
    Object.assign(state.customer, { service_contact_name: 'Ava Example', service_contact_phone: '+19415550111', service_contact_role: 'spouse_partner' });
    const r = await preview({ action: 'remove' });
    expect(r.code).toBe('invalid_input');
    expect(r.contacts).toEqual([{ slot: 1, contact: 'Ava Example (spouse partner, +19415550111)' }]);
  });
});

describe('set_customer_service_contact commit', () => {
  test('runs the page handler once with the card body and the locked re-check, then reads it back', async () => {
    const p = await preview({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' });
    Customers.setServiceContactsFromBar.mockImplementation(async ({ verifyPlan }) => {
      await verifyPlan(db); // the locked re-check over the same row passes
      state.customer.service_contact_name = 'Sam Example';
      state.customer.service_contact_phone = '+19415550122';
      state.customer.service_contact_role = 'family_member';
      return { status: 200, json: { success: true } };
    });
    const r = await confirm({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' }, p._version);
    expect(r.success).toBe(true);
    expect(r.sent_to_customer).toBe(false);
    expect(Customers.setServiceContactsFromBar).toHaveBeenCalledTimes(1);
    const call = Customers.setServiceContactsFromBar.mock.calls[0][0];
    expect(call.customerId).toBe(CUST);
    expect(call.slots).toEqual(p._version.body);
    expect(call.roles).toEqual({ service_contact_role: 'family_member' });
    expect(call.actor).toEqual({ technicianId: 'staff-1' });
  });

  test('refuses when the contacts changed after the card, without calling the handler', async () => {
    const p = await preview({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' });
    state.customer.service_contact_name = 'Someone Else';
    const r = await confirm({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' }, p._version);
    expect(r.code).toBe('preview_changed');
    expect(Customers.setServiceContactsFromBar).not.toHaveBeenCalled();
  });

  test('a change that lands inside the transaction refuses as preview_changed', async () => {
    const p = await preview({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' });
    Customers.setServiceContactsFromBar.mockImplementation(async ({ verifyPlan }) => {
      state.customer.service_contact_email = 'late@example.invalid';
      await verifyPlan(db);
      return { status: 200, json: {} };
    });
    const r = await confirm({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' }, p._version);
    expect(r.code).toBe('preview_changed');
  });

  test('reports the handler refusal and an unverified save', async () => {
    const p = await preview({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' });
    Customers.setServiceContactsFromBar.mockResolvedValueOnce({ status: 400, json: { error: 'Service contact 1 name must be 100 characters or fewer.' } });
    expect((await confirm({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' }, p._version)).code).toBe('contact_refused');
    Customers.setServiceContactsFromBar.mockResolvedValueOnce({ status: 200, json: {} });
    expect((await confirm({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' }, p._version)).code).toBe('contact_unverified');
  });

  test('admin only, and a confirmed run needs the card pin', async () => {
    const tech = await executeServiceContactTool('set_customer_service_contact', { customer_id: CUST, action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' }, { isAdmin: false });
    expect(tech.code).toBe('permission_denied');
    expect((await confirm({ action: 'add', relationship: 'family_member', name: 'Sam Example', phone: '+19415550122' }, undefined)).code).toBe('approval_required');
  });
});
