/**
 * Waves Pest Insider "Your home" facts against real Postgres (services/pest-insider/home.js loadHomeFacts), by
 * subscriber id. The last visit is the latest service_records day that is 'completed' (a NULL status counts, as
 * in the Waves app's own history) and not after today (Eastern); "since" is customers.member_since. A reader
 * gets an entry only when its link is unambiguous: the customer is live and active, has the reader's address,
 * shares that address with no other live customer and its account with no sibling profile, has at most one
 * active saved property, a lived-in one (owner_occupied or seasonal, not commercial), is not a commercial
 * account, and its last visit is at most 365 days old. Real Postgres, because the LATERAL joins, the NOT EXISTS
 * rules and the array_agg are the parts that can be wrong.
 * Runs in CI's DB-gated step or this worktree's private QA database; every test runs in one transaction that is
 * rolled back, so no row stays. Synthetic rows only.
 */
jest.setTimeout(60000);

// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  return db;
});

// The tool block resolves the proof and approver addresses through newsletter-proof.js; its own load chain is not under test here.
jest.mock('../services/newsletter-proof', () => ({ proofRecipient: () => 'contact@wavespestcontrol.com', syncedApprovalMailbox: () => 'contact@wavespestcontrol.com', approvalSenders: () => [] }));

const { randomUUID } = require('crypto');

postgres('Pest Insider "Your home" facts (real Postgres)', () => {
  const db = require('../models/db');
  const { loadHomeFacts } = require('../services/pest-insider/home');
  let database;
  const NOW = new Date('2026-11-21T15:00:00Z');

  async function customer(over = {}) {
    const id = randomUUID();
    await db('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Fixture', email: `${id}@example.invalid`, phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
      member_since: '2024-03-05', ...over,
    });
    return id;
  }
  // The subscriber for a customer, on the customer's own address unless told otherwise; returns its id.
  async function reader(customerId, email) {
    const row = email ? { email } : { email: (await db('customers').where({ id: customerId }).first('email')).email };
    const [inserted] = await db('newsletter_subscribers').insert({ ...row, status: 'active', customer_id: customerId }).returning('id');
    return typeof inserted === 'object' ? inserted.id : inserted;
  }
  // One catalog service of a category, made in this test's transaction; returns its key.
  async function catalogService(category, over = {}) {
    const key = `fixture_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    await db('services').insert({ service_key: key, name: `Fixture service ${key}`, category, ...over });
    return key;
  }
  // A finished record with the catalog key its completion froze (category null: a record with
  // no key and a name the catalog does not have).
  async function record(customerId, date, category = 'pest_control', status = 'completed') {
    const key = category ? await catalogService(category) : null;
    await db('service_records').insert({
      id: randomUUID(), customer_id: customerId, service_date: date, service_type: 'Fixture visit, no catalog name', status,
      service_data: JSON.stringify(key ? { completedServiceKey: key } : {}),
    });
  }
  const property = (customerId, over = {}) => db('customer_properties')
    .insert({ customer_id: customerId, occupancy_type: 'owner_occupied', active: true, ...over });
  // A customer with a recent visit and a reader: the base case every exclusion test varies.
  async function eligible(customerOver = {}, readerEmail) {
    const c = await customer(customerOver);
    await record(c, '2026-11-05');
    return { c, s: await reader(c, readerEmail) };
  }

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId)
      && target.pathname === `/waves_qa_${worktreeId}`;
    if (!ci && !ownedQA) throw new Error('Use the isolated CI database or this worktree\'s private QA database');
    // The driver copies every query parameter of a connection string into its
    // settings, so the pool gets the parts checked above, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 2 },
    });
  });

  beforeEach(async () => { db.connection = await database.transaction(); });
  afterEach(async () => { await db.connection?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  test('the last visit is the latest completed record up to today; member since is the since date; the line is the day\'s one line', async () => {
    const c = await customer({ member_since: '2024-03-05' });
    await record(c, '2025-08-20', 'lawn_care');
    await record(c, '2026-02-10', 'mosquito');
    await record(c, '2026-11-05', 'pest_control');
    const s = await reader(c);
    const facts = await loadHomeFacts(db, [s], NOW);
    expect(facts.get(s)).toEqual({ customerId: c, address: `${c}@example.invalid`, lastVisit: { date: '2026-11-05', line: 'pest' }, sinceDate: '2024-03-05' });
  });

  test('a record with a NULL status counts as completed; a non-completed or future-dated record does not', async () => {
    const c = await customer();
    const s = await reader(c);
    await record(c, '2026-06-01');
    await db('service_records').insert({ id: randomUUID(), customer_id: c, service_date: '2026-09-09', service_type: 'Quarterly Pest Control', status: null });
    for (const status of ['scheduled', 'in_progress', 'cancelled']) await record(c, '2026-11-18', 'pest_control', status);
    await record(c, '2026-11-22');
    await record(c, '2026-12-15');
    expect((await loadHomeFacts(db, [s], NOW)).get(s).lastVisit.date).toBe('2026-09-09');
    // A visit dated today counts.
    await record(c, '2026-11-21');
    expect((await loadHomeFacts(db, [s], NOW)).get(s).lastVisit.date).toBe('2026-11-21');
  });

  test('today is the Eastern date: a record on the 21st is not yet finished late on the 20th Eastern', async () => {
    const c = await customer();
    const s = await reader(c);
    await record(c, '2026-11-20');
    await record(c, '2026-11-21');
    expect((await loadHomeFacts(db, [s], new Date('2026-11-21T03:00:00Z'))).get(s).lastVisit.date).toBe('2026-11-20');
  });

  test('member since is what the customer has, or null: never the first record', async () => {
    const c = await customer({ member_since: null });
    await record(c, '2025-08-20');
    await record(c, '2026-11-05');
    const s = await reader(c);
    expect((await loadHomeFacts(db, [s], NOW)).get(s).sinceDate).toBeNull();
    await db('customers').where({ id: c }).update({ member_since: '2023-01-31' });
    expect((await loadHomeFacts(db, [s], NOW)).get(s).sinceDate).toBe('2023-01-31');
  });

  test('two services on the last day: from two lines gives no label, from one line gives that line', async () => {
    const two = await customer();
    await record(two, '2026-11-05', 'pest_control');
    await record(two, '2026-11-05', 'lawn_care');
    await record(two, '2026-10-01', 'mosquito');
    const one = await customer();
    await record(one, '2026-11-05', 'lawn_care');
    await record(one, '2026-11-05', 'lawn_care');
    const [sTwo, sOne] = [await reader(two), await reader(one)];
    const facts = await loadHomeFacts(db, [sTwo, sOne], NOW);
    expect(facts.get(sTwo).lastVisit.line).toBeNull();
    expect(facts.get(sOne).lastVisit.line).toBe('lawn');
  });

  test('a saved owner-occupied or seasonal property, or none, is a lived-in home', async () => {
    const withOne = await eligible();
    await property(withOne.c);
    const seasonal = await eligible();
    await property(seasonal.c, { occupancy_type: 'seasonal' });
    const none = await eligible();
    const facts = await loadHomeFacts(db, [withOne.s, seasonal.s, none.s], NOW);
    expect([...facts.keys()].sort()).toEqual([withOne.s, seasonal.s, none.s].sort());
  });

  test.each([
    ['an archived customer', { deleted_at: new Date('2026-10-01T00:00:00Z') }],
    ['an inactive customer', { active: false }],
    ['a commercial property type', { property_type: 'commercial' }],
    ['a business property type', { property_type: 'business' }],
    // The tier's stored spelling (customers_waveguard_tier_check allows 'Commercial', capitalized).
    ['the commercial tier', { waveguard_tier: 'Commercial' }],
  ])('%s has no entry', async (_label, over) => {
    const { s } = await eligible(over);
    expect((await loadHomeFacts(db, [s], NOW)).size).toBe(0);
  });

  test('a reader whose address is not the one the customer has on file has no entry (any letter case or spacing still matches)', async () => {
    const { c, s } = await eligible();
    const other = await reader(c, `other-${randomUUID()}@example.invalid`);
    const { email } = await db('customers').where({ id: c }).first('email');
    const spaced = await reader(c, ` ${email.toUpperCase()} `);
    const facts = await loadHomeFacts(db, [s, other, spaced], NOW);
    expect([...facts.keys()].sort()).toEqual([s, spaced].sort());
    // A customer with no address on file has no entry for anyone.
    await db('customers').where({ id: c }).update({ email: '' });
    expect((await loadHomeFacts(db, [s, other, spaced], NOW)).size).toBe(0);
  });

  test('another live customer with the same address leaves the reader out; an archived one does not', async () => {
    const { c, s } = await eligible();
    const { email } = await db('customers').where({ id: c }).first('email');
    const archived = await customer({ email, deleted_at: new Date('2026-10-01T00:00:00Z') });
    expect(archived).toBeDefined();
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(true);
    await customer({ email: email.toUpperCase() });
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(false);
  });

  test.each([
    ['service_contact_email', (address) => customer({ service_contact_email: address })],
    ['service_contact3_email', (address) => customer({ service_contact3_email: address.toUpperCase() })],
    ['notification_prefs.billing_email', async (address) => db('notification_prefs').insert({ customer_id: await customer(), billing_email: address })],
  ])('a mailbox that is also another live customer\'s %s leaves the reader out', async (_column, addOwner) => {
    const { c, s } = await eligible();
    const { email } = await db('customers').where({ id: c }).first('email');
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(true);
    await addOwner(email);
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(false);
  });

  test('another live customer on the same Gmail mailbox, in another spelling, leaves the reader out', async () => {
    const tag = randomUUID().slice(0, 12);
    const { s } = await eligible({ email: `fixture.${tag}@gmail.com` });
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(true);
    await customer({ email: `fixture${tag}+other@googlemail.com` });
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(false);
  });

  test('a sibling profile on the account leaves the reader out, whichever profile the reader is linked to; an inactive or archived sibling does not', async () => {
    const [account] = await db('customer_accounts').insert({ first_name: 'Synthetic' }).returning('id');
    const accountId = typeof account === 'object' ? account.id : account;
    const a = await eligible({ account_id: accountId });
    expect((await loadHomeFacts(db, [a.s], NOW)).has(a.s)).toBe(true);
    await customer({ account_id: accountId, active: false });
    await customer({ account_id: accountId, deleted_at: new Date('2026-10-01T00:00:00Z') });
    expect((await loadHomeFacts(db, [a.s], NOW)).has(a.s)).toBe(true);
    const sibling = await customer({ account_id: accountId });
    await record(sibling, '2026-11-05');
    const sibReader = await reader(sibling);
    const facts = await loadHomeFacts(db, [a.s, sibReader], NOW);
    expect(facts.size).toBe(0);
    // A customer who is the account itself (account_id NULL, another profile pointing at its id) has a sibling too.
    const root = await eligible();
    const rootReader = root.s;
    expect((await loadHomeFacts(db, [rootReader], NOW)).has(rootReader)).toBe(true);
    // customers.account_id references customer_accounts(id): the root's own id needs an account row.
    await db('customer_accounts').insert({ id: root.c, first_name: 'Synthetic' });
    await customer({ account_id: root.c });
    expect((await loadHomeFacts(db, [rootReader], NOW)).has(rootReader)).toBe(false);
  });

  test('one active saved property keeps the reader; a second one, active or retired, leaves the reader out', async () => {
    const two = await eligible();
    await property(two.c);
    expect((await loadHomeFacts(db, [two.s], NOW)).has(two.s)).toBe(true);
    await property(two.c);
    expect((await loadHomeFacts(db, [two.s], NOW)).has(two.s)).toBe(false);
    // The last visit is read over the whole history: a visit to a retired second property must not stand as this home's.
    const retired = await eligible();
    await property(retired.c);
    await property(retired.c, { occupancy_type: 'rental_investment', active: false });
    expect((await loadHomeFacts(db, [retired.s], NOW)).has(retired.s)).toBe(false);
  });

  test('a customer whose only saved property is retired has no entry', async () => {
    const { c, s } = await eligible();
    await property(c, { active: false });
    expect((await loadHomeFacts(db, [s], NOW)).size).toBe(0);
  });

  test.each([
    ['own_home', true],
    [null, true],
    ['rental_owned', false],
    ['family_home', false],
    ['managed_for_client', false],
  ])('a saved property with relationship %p: the reader has an entry = %p', async (relationship, shown) => {
    const { c, s } = await eligible();
    await property(c, { relationship });
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(shown);
  });

  test.each([
    ['owner', true],
    [null, true],
    ['property_manager', false],
    ['tenant', false],
  ])('a customer whose contact role is %p: the reader has an entry = %p', async (role, shown) => {
    const { s } = await eligible({ contact_role: role });
    expect((await loadHomeFacts(db, [s], NOW)).has(s)).toBe(shown);
  });

  test.each([
    ['rental_investment', {}],
    ['family_occupied', {}],
    ['commercial', {}],
    ['vacant', {}],
    ['unknown', {}],
    ['owner_occupied', { property_type: 'commercial' }],
    ['owner_occupied', { property_type: 'Business' }],
  ])('a saved property with occupancy %s %j leaves the reader out', async (occupancy, over) => {
    const { c, s } = await eligible();
    await property(c, { occupancy_type: occupancy, ...over });
    expect((await loadHomeFacts(db, [s], NOW)).size).toBe(0);
  });

  // A completed record behind an appointment, with the appointment's own property pointer and address stamp.
  async function visitRecord(customerId, date, appointment = {}) {
    const visitId = randomUUID();
    await db('scheduled_services').insert({ id: visitId, customer_id: customerId, service_type: 'Quarterly Pest Control', scheduled_date: date, status: 'completed', ...appointment });
    await db('service_records').insert({ id: randomUUID(), customer_id: customerId, service_date: date, service_type: 'Quarterly Pest Control', status: 'completed', scheduled_service_id: visitId });
  }

  test('the address the finished report froze must be the home; a live quote-wizard draft places no appointment', async () => {
    const frozenRecord = (customerId, address) => db('service_records').insert({
      id: randomUUID(), customer_id: customerId, service_date: '2026-11-05', service_type: 'Quarterly Pest Control', status: 'completed',
      service_data: JSON.stringify({ reportIdentitySnapshot: { address } }),
    });
    const HOME = { line1: '100 Test Lane', line2: null, city: 'Test City', state: 'FL', zip: '00000' };
    const stayed = await customer();
    await frozenRecord(stayed, HOME);
    // The report froze the old home; the customer's address on file is the new one.
    const moved = await customer();
    await frozenRecord(moved, { ...HOME, line1: '9 Old Road' });
    const noSnapshot = await customer();
    await db('service_records').insert({ id: randomUUID(), customer_id: noSnapshot, service_date: '2026-11-05', service_type: 'Quarterly Pest Control', status: 'completed', service_data: JSON.stringify({}) });
    const WIZARD = { source: 'quote_wizard', status: 'draft' };
    const liveDraft = await customer();
    await visitRecord(liveDraft, '2026-11-05', { source_estimate_id: await estimate(liveDraft, '100 Test Lane, Test City, FL 00000', WIZARD) });
    const archivedDraft = await customer();
    await visitRecord(archivedDraft, '2026-11-05', { source_estimate_id: await estimate(archivedDraft, '100 Test Lane, Test City, FL 00000', { ...WIZARD, archived_at: new Date('2026-11-01T12:00:00Z') }) });
    const readers = {};
    for (const [name, id] of Object.entries({ stayed, moved, noSnapshot, liveDraft, archivedDraft })) readers[name] = await reader(id);
    const facts = await loadHomeFacts(db, Object.values(readers), NOW);
    expect(Object.keys(readers).filter((name) => facts.has(readers[name])).sort()).toEqual(['archivedDraft', 'noSnapshot', 'stayed']);
  });

  test('the one saved property must be the home on file, also for an appointment that carries only the property pointer', async () => {
    const pointerVisit = async (propertyAddress) => {
      const c = await customer();
      const [inserted] = await db('customer_properties')
        .insert({ customer_id: c, occupancy_type: 'owner_occupied', active: true, ...propertyAddress }).returning('id');
      await visitRecord(c, '2026-11-05', { property_id: typeof inserted === 'object' ? inserted.id : inserted });
      return c;
    };
    const same = await pointerVisit({ address_line1: '100 Test Ln', city: 'Test City', zip: '00000' });
    const other = await pointerVisit({ address_line1: '9 Other Road', city: 'Test City', zip: '00000' });
    const noAddress = await pointerVisit({});
    const readers = {};
    for (const [name, id] of Object.entries({ same, other, noAddress })) readers[name] = await reader(id);
    const facts = await loadHomeFacts(db, Object.values(readers), NOW);
    expect(Object.keys(readers).filter((name) => facts.has(readers[name])).sort()).toEqual(['noAddress', 'same']);
  });

  test('a saved property typed office or warehouse is commercial: no entry, though its occupancy says owner-occupied', async () => {
    const withProperty = async (propertyType) => {
      const { c, s } = await eligible();
      await property(c, { property_type: propertyType });
      return s;
    };
    const office = await withProperty('office');
    const warehouse = await withProperty('warehouse');
    const house = await withProperty('single_family');
    const facts = await loadHomeFacts(db, [office, warehouse, house], NOW);
    expect([...facts.keys()]).toEqual([house]);
  });

  test('an appointment stamped with a unit but no street must not name another unit than the home\'s', async () => {
    const atUnit = async (unit) => {
      const c = await customer({ address_line2: 'Apt 3' });
      await visitRecord(c, '2026-11-05', { service_address_line2: unit });
      return reader(c);
    };
    const other = await atUnit('Apt 4');
    const same = await atUnit('Apt 3');
    const facts = await loadHomeFacts(db, [other, same], NOW);
    expect([...facts.keys()]).toEqual([same]);
  });

  test('the label comes from the service catalog: the frozen key, or a name that is one catalog name; never words in a name', async () => {
    const lineFor = async (insertRecord) => {
      const c = await customer();
      await insertRecord(c);
      const s = await reader(c);
      return (await loadHomeFacts(db, [s], NOW)).get(s).lastVisit.line;
    };
    const plain = (c, over) => db('service_records').insert({ id: randomUUID(), customer_id: c, service_date: '2026-11-05', status: 'completed', ...over });
    const tag = randomUUID().slice(0, 8);
    // The catalog's placeholder appointment holds the company name; an aeration holds "rat".
    const placeholder = await catalogService('specialty', { name: `Waves Pest Control Appointment Service ${tag}` });
    const aeration = await catalogService('lawn_care', { name: `Core Aeration Service ${tag}` });
    await catalogService('termite', { name: `Twin name ${tag}` });
    await catalogService('rodent', { name: `Twin name ${tag}` });
    // The frozen key decides, whatever the name says.
    expect(await lineFor((c) => plain(c, { service_type: 'Rodent Trapping', service_data: JSON.stringify({ completedServiceKey: placeholder }) }))).toBeNull();
    expect(await lineFor((c) => plain(c, { service_type: 'Quarterly Pest Control', service_data: JSON.stringify({ completedServiceKey: aeration }) }))).toBe('lawn');
    // A key the catalog does not have gives no label; the name is not tried.
    expect(await lineFor((c) => plain(c, { service_type: `Core Aeration Service ${tag}`, service_data: JSON.stringify({ completedServiceKey: `gone_${tag}` }) }))).toBeNull();
    // No key: the name must be one catalog name, in any case.
    expect(await lineFor((c) => plain(c, { service_type: ` core aeration service ${tag} ` }))).toBe('lawn');
    expect(await lineFor((c) => plain(c, { service_type: `Waves Pest Control Appointment Service ${tag}` }))).toBeNull();
    expect(await lineFor((c) => plain(c, { service_type: 'Core Aeration' }))).toBeNull();
    expect(await lineFor((c) => plain(c, { service_type: 'Quarterly Pest Control', service_data: JSON.stringify({ completedServiceKey: '  ' }) }))).toBeNull();
    // A name two catalog services of two categories share is not one line.
    expect(await lineFor((c) => plain(c, { service_type: `Twin name ${tag}` }))).toBeNull();
  });

  test('a visit that performed no work keeps its date and prints no label; a frozen add-on line of another category makes the day two lines', async () => {
    const visitOf = async (recordOver) => {
      const c = await customer();
      await db('service_records').insert({ id: randomUUID(), customer_id: c, service_date: '2026-11-05', service_type: 'Fixture visit, no catalog name', status: 'completed', ...recordOver });
      const s = await reader(c);
      return (await loadHomeFacts(db, [s], NOW)).get(s).lastVisit;
    };
    const lawn = await catalogService('lawn_care');
    const pest = await catalogService('pest_control');
    const sweep = await catalogService('pest_control');
    const mosquito = await catalogService('mosquito');
    const data = (key, addons = []) => JSON.stringify({ completedServiceKey: key, completedAddonLines: addons.map((serviceKey) => ({ serviceKey })) });
    expect(await visitOf({ service_data: data(lawn), structured_notes: JSON.stringify({ visitOutcome: 'completed' }) })).toEqual({ date: '2026-11-05', line: 'lawn' });
    expect(await visitOf({ service_data: data(lawn), structured_notes: JSON.stringify({ visitOutcome: 'customer_declined' }) })).toEqual({ date: '2026-11-05', line: null });
    expect(await visitOf({ service_data: data(pest), structured_notes: JSON.stringify({ visitOutcome: 'inspection_only' }) })).toEqual({ date: '2026-11-05', line: null });
    expect(await visitOf({ service_data: data(pest, [sweep]) })).toEqual({ date: '2026-11-05', line: 'pest' });
    expect(await visitOf({ service_data: data(pest, [mosquito]) })).toEqual({ date: '2026-11-05', line: null });
    // An add-on list that is not a list, or a line with a key the catalog does not have, changes nothing.
    expect(await visitOf({ service_data: JSON.stringify({ completedServiceKey: pest, completedAddonLines: 'none' }) })).toEqual({ date: '2026-11-05', line: 'pest' });
    expect(await visitOf({ service_data: data(pest, [`gone_${randomUUID().slice(0, 8)}`]) })).toEqual({ date: '2026-11-05', line: 'pest' });
    // A frozen line with no key is read by its catalog id.
    const mosquitoId = (await db('services').where({ service_key: mosquito }).first('id')).id;
    expect(await visitOf({ service_data: JSON.stringify({ completedServiceKey: pest, completedAddonLines: [{ serviceId: mosquitoId, serviceName: 'Typed by the office' }] }) }))
      .toEqual({ date: '2026-11-05', line: null });
    expect(await visitOf({ service_data: JSON.stringify({ completedServiceKey: pest, completedAddonLines: [{ serviceId: null, serviceName: 'Mosquito Control' }, 'text', 7, null] }) }))
      .toEqual({ date: '2026-11-05', line: 'pest' });
  });

  test('a record with no frozen add-on list reads its appointment\'s add-on rows (key snapshot, else catalog id); a record with a list never does', async () => {
    const pest = await catalogService('pest_control');
    const mosquito = await catalogService('mosquito');
    const termite = await catalogService('termite');
    const termiteId = (await db('services').where({ service_key: termite }).first('id')).id;
    const visitWithAddon = async (addon, serviceData) => {
      const c = await customer();
      const appointment = randomUUID();
      await db('scheduled_services').insert({ id: appointment, customer_id: c, scheduled_date: '2026-11-05', service_type: 'Fixture visit, no catalog name', status: 'completed' });
      await db('scheduled_service_addons').insert({ scheduled_service_id: appointment, service_name: 'Fixture add-on', ...addon });
      await db('service_records').insert({
        id: randomUUID(), customer_id: c, scheduled_service_id: appointment, service_date: '2026-11-05', service_type: 'Fixture visit, no catalog name', status: 'completed',
        service_data: JSON.stringify(serviceData),
      });
      const s = await reader(c);
      return (await loadHomeFacts(db, [s], NOW)).get(s).lastVisit.line;
    };
    // No frozen list: the appointment's add-on of another line makes the day two lines.
    expect(await visitWithAddon({ service_key_snapshot: mosquito }, { completedServiceKey: pest })).toBeNull();
    expect(await visitWithAddon({ service_id: termiteId }, { completedServiceKey: pest })).toBeNull();
    // An add-on of the same line, or one with no key and no id, changes nothing.
    expect(await visitWithAddon({ service_key_snapshot: pest }, { completedServiceKey: pest })).toBe('pest');
    expect(await visitWithAddon({}, { completedServiceKey: pest })).toBe('pest');
    // A frozen list, even an empty one, is the record: a later add-on row on the appointment is not read.
    expect(await visitWithAddon({ service_key_snapshot: mosquito }, { completedServiceKey: pest, completedAddonLines: [] })).toBe('pest');
  });

  test('a customer staff marked multi-home, or one with no street on file, has no entry', async () => {
    // has_multi_home: a second premises that never got a customer_properties row.
    const { s: flagged } = await eligible({ has_multi_home: true });
    const { s: unflagged } = await eligible({ has_multi_home: false });
    const { s: noStreet } = await eligible({ address_line1: null });
    const { s: blankStreet } = await eligible({ address_line1: '  ' });
    const facts = await loadHomeFacts(db, [flagged, unflagged, noStreet, blankStreet], NOW);
    expect([...facts.keys()]).toEqual([unflagged]);
  });

  // An estimate of the customer with the address it quoted; returns its id.
  async function estimate(customerId, address, over = {}) {
    const [inserted] = await db('estimates').insert({ id: randomUUID(), customer_id: customerId, address, estimate_data: JSON.stringify({}), ...over }).returning('id');
    return typeof inserted === 'object' ? inserted.id : inserted;
  }

  test('a last visit booked at another address or another property has no entry; the home\'s own stamp, or none, does', async () => {
    const plain = await customer();
    await visitRecord(plain, '2026-11-05');
    const same = await customer();
    await visitRecord(same, '2026-11-05', { service_address_line1: '100 Test Ln', service_address_city: 'Test City', service_address_zip: '00000' });
    const elsewhere = await customer();
    await visitRecord(elsewhere, '2026-11-05', { service_address_line1: '9 Other Road', service_address_city: 'Test City', service_address_zip: '00000' });
    // An older visit elsewhere does not matter: only the last day's visits are named.
    const older = await customer();
    await visitRecord(older, '2026-08-05', { service_address_line1: '9 Other Road', service_address_city: 'Test City', service_address_zip: '00000' });
    await visitRecord(older, '2026-11-05');
    // A pointer at the customer's one saved property is this home; a pointer at any other property is not.
    const own = await customer();
    const [ownProperty] = await db('customer_properties').insert({ customer_id: own, occupancy_type: 'owner_occupied', active: true }).returning('id');
    await visitRecord(own, '2026-11-05', { property_id: typeof ownProperty === 'object' ? ownProperty.id : ownProperty });
    const stranger = await customer();
    const [strangerProperty] = await db('customer_properties').insert({ customer_id: stranger, occupancy_type: 'owner_occupied', active: true }).returning('id');
    const pointed = await customer();
    await visitRecord(pointed, '2026-11-05', { property_id: typeof strangerProperty === 'object' ? strangerProperty.id : strangerProperty });
    // A unit on the stamp that the home on file does not have is another premise.
    const unit = await customer();
    await visitRecord(unit, '2026-11-05', { service_address_line1: '100 Test Lane', service_address_line2: 'Apt 4', service_address_city: 'Test City', service_address_zip: '00000' });
    // An appointment with no location of its own takes its source estimate's address.
    const quotedHome = await customer();
    await visitRecord(quotedHome, '2026-11-05', { source_estimate_id: await estimate(quotedHome, '100 Test Lane, Test City, FL 00000') });
    const quotedElsewhere = await customer();
    await visitRecord(quotedElsewhere, '2026-11-05', { source_estimate_id: await estimate(quotedElsewhere, '9 Other Road, Test City, FL 00000') });
    const readers = {};
    for (const [name, id] of Object.entries({ plain, same, elsewhere, older, own, pointed, unit, quotedHome, quotedElsewhere })) readers[name] = await reader(id);
    const facts = await loadHomeFacts(db, Object.values(readers), NOW);
    expect(Object.keys(readers).filter((name) => facts.has(readers[name])).sort()).toEqual(['older', 'own', 'plain', 'quotedHome', 'same']);
  });

  test('a last visit over 365 days old has no entry; exactly 365 days old still does; no record at all has none', async () => {
    const old = await customer();
    await record(old, '2024-05-01');
    await record(old, '2025-11-20');
    const edge = await customer();
    await record(edge, '2025-11-21');
    const none = await customer();
    const [sOld, sEdge, sNone] = [await reader(old), await reader(edge), await reader(none)];
    const facts = await loadHomeFacts(db, [sOld, sEdge, sNone], NOW);
    expect([...facts.keys()]).toEqual([sEdge]);
  });

  test('two readers do not mix: each has its own customer, dates and line', async () => {
    const a = await customer({ member_since: '2023-02-01' });
    const b = await customer({ member_since: '2025-09-15' });
    await record(a, '2026-10-01', 'lawn_care');
    await record(b, '2026-05-01', 'termite');
    await record(b, '2026-11-01', null);
    const [sA, sB] = [await reader(a), await reader(b)];
    const facts = await loadHomeFacts(db, [sA, sB], NOW);
    expect(facts.get(sA)).toEqual({ customerId: a, address: `${a}@example.invalid`, lastVisit: { date: '2026-10-01', line: 'lawn' }, sinceDate: '2023-02-01' });
    expect(facts.get(sB)).toEqual({ customerId: b, address: `${b}@example.invalid`, lastVisit: { date: '2026-11-01', line: null }, sinceDate: '2025-09-15' });
  });

  test('a reader with no customer, an empty list and a reader not asked for return nothing', async () => {
    const lead = (await db('newsletter_subscribers').insert({ email: `lead-${randomUUID()}@example.invalid`, status: 'active' }).returning('id'))[0];
    const leadId = typeof lead === 'object' ? lead.id : lead;
    const asked = await eligible();
    const other = await eligible();
    expect((await loadHomeFacts(db, [leadId], NOW)).size).toBe(0);
    expect((await loadHomeFacts(db, [], NOW)).size).toBe(0);
    expect([...(await loadHomeFacts(db, [asked.s], NOW)).keys()]).toEqual([asked.s]);
    expect(other.s).not.toBe(asked.s);
  });

  // "A tool we'd use" at send time (services/pest-insider/tool-block.js): the three reads are real SQL here: the
  // send's issue row (pest_insider_issues.send_id), the batch's subscriber rows (opt-in evidence) and the staff logins.
  test('the tool block goes only to the reader with opt-in evidence who is no Waves address: real issue, subscriber and staff rows', async () => {
    const { toolBlockForBatch, TOOL_TOKEN } = require('../services/pest-insider/tool-block');
    const { toolBlock } = require('../services/pest-insider/render');
    const { toolById } = require('../services/pest-insider/tools');
    const gate = process.env.GATE_PEST_INSIDER_AUTO_SEND;
    process.env.GATE_PEST_INSIDER_AUTO_SEND = 'true';
    try {
      const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
      const send = idOf(await db('newsletter_sends').insert({ subject: 'Synthetic tool block', html_body: '<p>x</p>', text_body: 'x', status: 'draft', auto_share_social: false }).returning('id'));
      await db('pest_insider_issues').insert({ issue_date: '2099-01-01', status: 'drafted', send_id: send, tool_id: 'acurite-glass-rain-gauge' });
      const tag = randomUUID().slice(0, 8);
      const click = new Date('2026-10-01T12:05:00Z');
      const readers = {};
      // A row the reader confirmed by link: both stamps and the address, as confirmByToken writes them.
      const add = async (name, over = {}) => {
        const email = `${name}-${tag}@example.invalid`;
        const id = idOf(await db('newsletter_subscribers').insert({
          email, status: 'active', confirmed_at: click, reader_confirmed_at: click, reader_confirmed_email: email, ...over,
        }).returning('id'));
        readers[name] = { id, email };
      };
      await add('optedin');
      await add('trusted', { reader_confirmed_at: null, reader_confirmed_email: null });
      await add('beehiiv', { reader_confirmed_at: null, reader_confirmed_email: null, source: 'beehiiv_migration' });
      await add('moved', { reader_confirmed_email: 'old-address@example.invalid' });
      await add('reactivated', { confirmed_at: new Date(click.getTime() + 60000) });
      await add('optedout', { unsubscribed_at: new Date(click.getTime() + 60000) });
      await add('sunset', { deactivated_at: new Date(click.getTime() + 60000) });
      await add('gone', { status: 'unsubscribed' });
      await add('staff');
      await db('technicians').insert({ name: 'Fixture Tech', email: `LOGIN-${tag}@example.invalid`, google_email: readers.staff.email.toUpperCase() });
      const run = (subscribers) => toolBlockForBatch({ send: { id: send, newsletter_type: 'pest-insider-monthly' }, html: TOOL_TOKEN, text: '', subscribers, planned: true, db });
      const batch = await run(Object.values(readers));
      const block = toolBlock(toolById('acurite-glass-rain-gauge')).html;
      expect(Object.fromEntries(Object.entries(readers).map(([name, r]) => [name, batch.forReader(r)[TOOL_TOKEN]]))).toEqual({
        optedin: block, trusted: '', beehiiv: '', moved: '', reactivated: '', optedout: '', sunset: '', gone: '', staff: '',
      });
      // The address on the row now must be the address mailed: a changed address gets ''.
      expect((await run([{ id: readers.optedin.id, email: 'old-address@example.invalid' }])).forReader(readers.optedin)[TOOL_TOKEN]).toBe('');
      // A send with no issue row names no tool.
      const other = idOf(await db('newsletter_sends').insert({ subject: 'Synthetic other', html_body: '<p>x</p>', text_body: 'x', status: 'draft', auto_share_social: false }).returning('id'));
      const noIssue = await toolBlockForBatch({ send: { id: other, newsletter_type: 'pest-insider-monthly' }, html: TOOL_TOKEN, text: '', subscribers: [readers.optedin], planned: true, db });
      expect(noIssue.forReader(readers.optedin)[TOOL_TOKEN]).toBe('');
    } finally {
      if (gate === undefined) delete process.env.GATE_PEST_INSIDER_AUTO_SEND;
      else process.env.GATE_PEST_INSIDER_AUTO_SEND = gate;
    }
  });
});
