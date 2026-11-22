// onlyUntouchedWebFormShellsOpen against real PostgreSQL (the migrated schema,
// synthetic rows, one rolled-back transaction per test).
//
// Owner 2026-11-21, "build" (GATE_WIZARD_SUPERSEDES_FORM_DRAFT): an old web-form
// draft estimate with no price that nobody touched must not block the quote
// wizard's own estimate. The rule is one SQL predicate (the draft-retire
// sweep's rule, jsonb paths, two NOT EXISTS reads) plus the contact and street
// comparison, so only a real database can prove which drafts stop blocking and
// which still block. The rule reads only: the old draft is never changed.
// The route's own wiring is pinned in public-quote-mirror-refresh.test.js.
// No network, no spend, no customer.
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

const { randomUUID } = require('node:crypto');
const { onlyUntouchedWebFormShellsOpen } = require('../services/estimate-automation-duplicates');

const DAY = 86400000;
// The property the wizard run is for. Every fixture is for it unless a test says otherwise.
const HOME = '12 Sample St, Parrish, FL 34219';
// The person the wizard run is by: this email, and the customer row made in beforeEach.
const EMAIL = 'sample.person@example.com';

postgres('untouched web-form shell drafts and the quote wizard (live Postgres)', () => {
  jest.setTimeout(60000);
  let database;
  let trx;
  let phone;
  let digits;
  let customerId;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's, or CI's database.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    // The driver copies every query parameter of a connection string into its
    // settings, so the pool gets the parts this guard read, never the URL text.
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

  afterAll(async () => {
    await database?.destroy();
  });

  // A phone no other suite left a row on: the lane's other suites commit rows on
  // random +1941555NNNN numbers, and this rule reads every open estimate of a phone.
  async function freshPhone() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = `941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
      const used = await trx('estimates')
        .whereRaw("right(regexp_replace(coalesce(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [candidate])
        .first('id');
      const asked = await trx('message_drafts').where({ source_ref: `clarify:${candidate}` }).first('id');
      if (!used && !asked) return candidate;
    }
    throw new Error('no free synthetic phone');
  }

  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
    digits = await freshPhone();
    phone = `+1${digits}`;
    // The web form makes its draft for a customer row, and the sweep's rule asks for one.
    [{ id: customerId }] = await trx('customers').insert({ first_name: 'Sample', last_name: 'Person', phone }).returning('id');
  });

  afterEach(async () => {
    await trx.rollback();
  });

  let age = 0;
  // An open estimate for the test phone. Default: an untouched web-form shell
  // for HOME, never written since it was made. Each call is older than the one before it.
  async function estimate(fields = {}) {
    age += 1;
    const made = new Date(Date.now() - age * 3600000);
    const [row] = await trx('estimates').insert({
      customer_id: customerId,
      customer_phone: phone,
      customer_email: EMAIL,
      customer_name: 'Sample Person',
      address: HOME,
      status: 'draft',
      source: 'lead_webhook',
      created_at: made,
      updated_at: made,
      ...fields,
    }).returning('id');
    return row.id;
  }

  // A clarify ask as the portal writes it: parked as 'pending' (the only shape
  // the table's insert guard lets through), then moved on by an UPDATE.
  async function clarifyAsk(fields = {}) {
    const [ask] = await trx('message_drafts').insert({
      intent: 'estimate_clarify',
      source_ref: `clarify:${digits}`,
      status: 'pending',
      draft_response: 'Which service are you looking for?',
      flags: JSON.stringify({ estimate_clarify: true, missing: ['specific_service'] }),
    }).returning('id');
    if (Object.keys(fields).length) await trx('message_drafts').where({ id: ask.id }).update(fields);
  }

  // Does the wizard run go on as for a new visitor? (false = the run stays blocked.)
  const shellsOnly = (run = {}) => onlyUntouchedWebFormShellsOpen(trx, { phone, address: HOME, customerId, email: EMAIL, ...run });
  const snapshot = (id) => trx('estimates').where({ id }).first('status', 'archived_at', 'updated_at', 'created_at', 'estimate_data');

  test('an untouched shell that is the phone\'s only open estimate does not block, and the read changes nothing on it', async () => {
    const shell = await estimate({ estimate_data: JSON.stringify({ automation: { gate: 'disabled' } }) });
    const before = await snapshot(shell);

    expect(await shellsOnly()).toBe(true);

    // The caller is a public route: the old draft is read, never written.
    expect(await snapshot(shell)).toEqual(before);
    expect(before.archived_at).toBeNull();
  });

  test('two untouched shells do not block, and another phone\'s estimate is not read', async () => {
    await estimate();
    await estimate();
    const otherDigits = digits === '9415550000' ? '9415550001' : '9415550000';
    await trx('estimates').insert({
      customer_id: customerId, customer_phone: `+1${otherDigits}`, customer_email: EMAIL, customer_name: 'Other Person', address: HOME, status: 'sent', source: 'manual', sent_at: new Date(),
    });

    expect(await shellsOnly()).toBe(true);
  });

  // The shells must be EVERY open estimate of the phone.
  test.each([
    ['an office estimate', () => ({ source: 'manual' })],
    ['a sent office estimate', () => ({ source: 'manual', status: 'sent', sent_at: new Date() })],
    // Not in the duplicate block's own status list, but live work for the phone.
    ['an estimate that is being sent right now', () => ({ source: 'manual', status: 'sending' })],
    ['an estimate whose send failed', () => ({ source: 'manual', status: 'send_failed' })],
    ['a web-form draft with a price', () => ({ monthly_total: 59 })],
    ['the wizard\'s own older draft', () => ({ source: 'quote_wizard', monthly_total: 59 })],
    ['a wizard estimate that was already sent', () => ({ source: 'quote_wizard', status: 'sent', sent_at: new Date(), monthly_total: 59 })],
    ['a web-form draft for another property', () => ({ address: '88 Other Ave, Parrish, FL 34219' })],
  ])('%s beside the shell still blocks', async (_label, fields) => {
    await estimate();
    await estimate(fields());

    expect(await shellsOnly()).toBe(false);
  });

  test('every open estimate is judged, not only the newest: an older office estimate behind two shells still blocks', async () => {
    await estimate();
    await estimate();
    await estimate({ source: 'manual', status: 'sent', sent_at: new Date() });

    expect(await shellsOnly()).toBe(false);
  });

  test.each([
    ['has a monthly price', () => ({ monthly_total: 59 })],
    ['has a one-time price', () => ({ onetime_total: 199 })],
    ['has an annual price', () => ({ annual_total: 708 })],
    ['was sent', () => ({ sent_at: new Date() })],
    ['was viewed', () => ({ viewed_at: new Date() })],
    ['has a send time', () => ({ scheduled_at: new Date(Date.now() + DAY) })],
    ['was claimed by auto-send', () => ({ estimate_data: JSON.stringify({ automation: { autoSend: { claimedAt: '2026-11-20T12:00:00.000Z' } } }) })],
    ['was claimed by auto-send (the older key)', () => ({ estimate_data: JSON.stringify({ automation: { autoSend: { claimed_at: '2026-11-20T12:00:00.000Z' } } }) })],
    ['was claimed by auto-send (the older key, beside an empty newer key)', () => ({ estimate_data: JSON.stringify({ automation: { autoSend: { claimedAt: '', claimed_at: '2026-11-20T12:00:00.000Z' } } }) })],
    // A staff edit can leave every total at 0 and every delivery time empty.
    ['was written again after it was made', () => ({ updated_at: new Date() })],
    // Staff work that does not move updated_at (created_at = updated_at here).
    ['has an office Sold-by action', () => ({ sold_by_source: 'cleared', sold_by_set_at: new Date() })],
    ['has a logged follow-up', () => ({ follow_up_count: 1, last_follow_up_at: new Date() })],
    // The web form's background work on a new draft is not done yet: it can still price and send the draft.
    ['is younger than 30 minutes', () => { const made = new Date(Date.now() - 10 * 60000); return { created_at: made, updated_at: made }; }],
    // Two people can share a phone and a home.
    ['belongs to another customer row', async () => ({
      customer_id: (await trx('customers').insert({ first_name: 'Other', last_name: 'Person', phone }).returning('id'))[0].id,
    })],
    ['has another email', () => ({ customer_email: 'other.person@example.com' })],
    ['has no email', () => ({ customer_email: null })],
    // One phone, two homes.
    ['is for another property', () => ({ address: '88 Other Ave, Parrish, FL 34219' })],
    ['is for the same street in another town', () => ({ address: '12 Sample St, Bradenton, FL 34205' })],
    ['is for another unit of the building', () => ({ address: '12 Sample St Apt 4, Parrish, FL 34219' })],
    // The shared street key drops the fraction; the typed house numbers differ.
    ['is for a house number with a fraction', () => ({ address: '12½ Sample St, Parrish, FL 34219' })],
    ['is for a house number with a fraction written as its own word', () => ({ address: '12 ½ Sample St, Parrish, FL 34219' })],
    ['is for a house number with a fraction written with small digits', () => ({ address: '12 ¹⁄₂ Sample St, Parrish, FL 34219' })],
    ['is for a house number with a fraction written with a slash', () => ({ address: '12 1/2 Sample St, Parrish, FL 34219' })],
    // No city or ZIP = no proof that it is the same home.
    ['has an address with no city or ZIP', () => ({ address: '12 Sample St' })],
    ['has no address', () => ({ address: '' })],
  ])('a web-form draft that %s is not a shell: it still blocks', async (_label, fields) => {
    await estimate(await fields());

    expect(await shellsOnly()).toBe(false);
  });

  test('the same property written another way is the same property', async () => {
    await estimate({ address: '12 sample street, parrish, fl 34219' });

    expect(await shellsOnly()).toBe(true);
  });

  // Found live 2026-11-21: the web form and the wizard wrote one name word
  // inside the street name in two ways, and the draft kept blocking. While
  // the rule's gate is on, the shared street key reads six such words as
  // one street (lead-address-unverified.js). In production this rule runs
  // only with the gate on.
  describe('a name word inside the street name, short on the draft and in full on the run', () => {
    const GATE = 'GATE_WIZARD_SUPERSEDES_FORM_DRAFT';
    const SHORT = '12 Sample Pt Dr, Parrish, FL 34219';
    const FULL = '12 Sample Point Dr, Parrish, FL 34219';
    let gateBefore;

    beforeEach(() => {
      gateBefore = process.env[GATE];
      process.env[GATE] = 'true';
    });

    afterEach(() => {
      if (gateBefore === undefined) delete process.env[GATE];
      else process.env[GATE] = gateBefore;
    });

    test.each([
      ['Point', SHORT, FULL],
      ['Glen', '12 Sample Gln Ct, Parrish, FL 34219', '12 Sample Glen Ct, Parrish, FL 34219'],
    ])('%s: the same property, in both directions', async (_word, onDraft, onRun) => {
      await estimate({ address: onDraft });

      expect(await shellsOnly({ address: onRun })).toBe(true);
      expect(await shellsOnly({ address: onDraft })).toBe(true);
    });

    test('with the gate off the shared key does not fold: the two spellings are two streets', async () => {
      delete process.env[GATE];
      await estimate({ address: SHORT });

      expect(await shellsOnly({ address: FULL })).toBe(false);
    });

    test.each([
      ['another word in the street name', '12 Sample Port Dr, Parrish, FL 34219'],
      ['another house number', '14 Sample Point Dr, Parrish, FL 34219'],
      ['another town', '12 Sample Point Dr, Bradenton, FL 34205'],
      ['another unit', '12 Sample Point Dr Apt 4, Parrish, FL 34219'],
    ])('the fold does not hide %s: the draft still blocks', async (_label, onRun) => {
      await estimate({ address: SHORT });

      expect(await shellsOnly({ address: onRun })).toBe(false);
    });

    // "St" is also Saint, "Dr" is also Doctor, and Island shortens to the
    // word "Is": none of them is on the list.
    test.each([
      ['St', '12 St Sample Dr, Parrish, FL 34219', '12 Street Sample Dr, Parrish, FL 34219'],
      ['Dr', '12 Dr Sample Blvd, Parrish, FL 34219', '12 Drive Sample Blvd, Parrish, FL 34219'],
      ['Is', '12 This Is Sample Dr, Parrish, FL 34219', '12 This Island Sample Dr, Parrish, FL 34219'],
    ])('"%s" inside the street name is not folded: the draft still blocks', async (_word, onDraft, onRun) => {
      await estimate({ address: onDraft });

      expect(await shellsOnly({ address: onRun })).toBe(false);
    });
  });

  test.each([
    ['Sample St, Parrish, FL 34219'],
    // A numbered street is not a house number.
    ['49th St, Parrish, FL 34219'],
  ])('a street with no house number is not a door, it can be many homes: %s', async (street) => {
    await estimate({ address: street });

    expect(await shellsOnly({ address: street })).toBe(false);
  });

  test('a house number on a numbered street is a door', async () => {
    const door = '12 49th St, Parrish, FL 34219';
    await estimate({ address: door });

    expect(await shellsOnly({ address: door })).toBe(true);
    // The typed house number is the first word only: how the street name
    // after it is written stays with the matcher.
    expect(await shellsOnly({ address: '12 49th-St, Parrish, FL 34219' })).toBe(true);
  });

  test('a number that starts the street name is not read into the house number', async () => {
    await estimate({ address: '12 7 Mile Rd, Parrish, FL 34219' });

    expect(await shellsOnly({ address: '12 7-Mile Rd, Parrish, FL 34219' })).toBe(true);
    expect(await shellsOnly({ address: '12 7 Mile Rd, Parrish, FL 34219' })).toBe(true);
  });

  // The run side of the same checks.
  test.each([
    ['no address', { address: '' }],
    ['an address with no city or ZIP', { address: '12 Sample St' }],
    ['no resolved customer', { customerId: null }],
    ['another customer', { customerId: randomUUID() }],
    ['another email', { email: 'other.person@example.com' }],
    ['no email', { email: '' }],
  ])('a run that gives %s stays blocked', async (_label, run) => {
    await estimate();

    expect(await shellsOnly(run)).toBe(false);
  });

  test('the email compares without case or outer spaces', async () => {
    await estimate();

    expect(await shellsOnly({ email: '  Sample.Person@Example.com ' })).toBe(true);
  });

  test.each([
    ['a lead', {}],
    // The draft-retire sweep's rule skips a soft-deleted lead; this rule does not.
    ['a soft-deleted lead', { deleted_at: new Date() }],
  ])('a web-form draft that %s points at is not a shell', async (_label, leadFields) => {
    const linked = await estimate();
    await trx('leads').insert({
      id: randomUUID(), status: 'new', first_name: 'Sample', last_name: 'Person', phone, estimate_id: linked, ...leadFields,
    });

    expect(await shellsOnly()).toBe(false);
  });

  // The answer to a clarify ask can still price and send the web-form draft.
  test.each([
    ['waits for the office to approve it', {}],
    ['is being sent', { status: 'approved' }],
    ['was sent 2 days ago and has no answer', { status: 'approved', sent_at: new Date(Date.now() - 2 * DAY) }],
  ])('a clarify ask for the phone that %s keeps the block', async (_label, fields) => {
    await estimate();
    await clarifyAsk(fields);

    expect(await shellsOnly()).toBe(false);
  });

  test.each([
    ['was answered', { status: 'approved', sent_at: new Date(Date.now() - DAY), flags: JSON.stringify({ estimate_clarify: true, missing: [], answered_at: '2026-11-20T12:00:00.000Z' }) }],
    ['was sent more than 7 days ago', { status: 'approved', sent_at: new Date(Date.now() - 8 * DAY) }],
    ['was rejected by the office', { status: 'rejected' }],
  ])('a clarify ask that %s no longer keeps the block', async (_label, fields) => {
    await estimate();
    await clarifyAsk(fields);

    expect(await shellsOnly()).toBe(true);
  });

  test('an archived shell, a phone with no open estimate and a phone that is not a phone give no answer to act on', async () => {
    await estimate({ archived_at: new Date() });

    expect(await shellsOnly()).toBe(false);
    expect(await shellsOnly({ phone: '555' })).toBe(false);
  });
});
