// retireUntouchedWebFormShellsInTx against real PostgreSQL (the migrated schema,
// synthetic rows, one rolled-back transaction per test).
//
// Owner 2026-11-21, "build" (GATE_WIZARD_SUPERSEDES_FORM_DRAFT): an old web-form
// draft estimate with no price that nobody touched must not block the quote
// wizard's own estimate. The rule is one SQL predicate (jsonb paths, two NOT
// EXISTS reads, a guarded UPDATE), so only a real database can prove which rows
// it archives and which rows it must leave alone. The route's own wiring is
// pinned in public-quote-mirror-refresh.test.js. No network, no spend, no customer.
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

const { randomUUID } = require('node:crypto');
const {
  listOpenEstimatesByPhone,
  retireUntouchedWebFormShellsInTx,
} = require('../services/estimate-automation-duplicates');

const DAY = 86400000;
// The wizard's rule (routes/public-quote.js shouldRefreshWizardDraft): only its
// own open draft lets the run go on.
const wizardRule = (existing) => !!existing && !(existing.source === 'quote_wizard' && existing.status === 'draft');

postgres('untouched web-form shell drafts and the quote wizard (live Postgres)', () => {
  jest.setTimeout(60000);
  let database;
  let trx;
  let phone;
  let digits;

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
  });

  afterEach(async () => {
    await trx.rollback();
  });

  let age = 0;
  // An open estimate for the test phone. Default: an untouched web-form shell.
  // Each call is older than the one before it unless `created_at` is given.
  async function estimate(fields = {}) {
    age += 1;
    const [row] = await trx('estimates').insert({
      customer_phone: phone,
      customer_name: 'Sample Person',
      status: 'draft',
      source: 'lead_webhook',
      created_at: new Date(Date.now() - age * 3600000),
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

  const row = (id) => trx('estimates').where({ id }).first('id', 'status', 'archived_at', 'estimate_data');
  const openIds = async () => (await listOpenEstimatesByPhone(phone, { database: trx })).map((r) => r.id);
  const retire = (extra = {}) => retireUntouchedWebFormShellsInTx(trx, { phone, leadId: 'lead-1', stillBlocks: wizardRule, ...extra });

  test('archives the untouched shell that is the phone\'s only open estimate, and records which wizard lead replaced it', async () => {
    const shell = await estimate({ estimate_data: JSON.stringify({ automation: { gate: 'disabled' } }) });

    const result = await retire();

    expect(result).toEqual({ retiredIds: [shell], blockedById: null });
    const after = await row(shell);
    expect(after.archived_at).toBeInstanceOf(Date);
    // Archived, not deleted and not promoted: staff can unarchive the same draft.
    expect(after.status).toBe('draft');
    expect(after.estimate_data.automation).toEqual({ gate: 'disabled' });
    expect(after.estimate_data.supersededByWizard).toEqual({ at: expect.any(String), leadId: 'lead-1' });
    // Not the stamp that makes the unarchive route refuse the row for good.
    expect(after.estimate_data.estimatorEngine).toBeUndefined();
    expect(await openIds()).toEqual([]);
  });

  test('archives every untouched shell of the phone and leaves another phone\'s shell alone', async () => {
    const first = await estimate();
    const second = await estimate();
    const otherDigits = digits === '9415550000' ? '9415550001' : '9415550000';
    const [other] = await trx('estimates').insert({
      customer_phone: `+1${otherDigits}`, customer_name: 'Other Person', status: 'draft', source: 'lead_webhook',
    }).returning('id');

    const result = await retire();

    expect([...result.retiredIds].sort()).toEqual([first, second].sort());
    expect((await row(other.id)).archived_at).toBeNull();
  });

  test('an office estimate still blocks, and then no shell is archived', async () => {
    const shell = await estimate();
    const office = await estimate({ source: 'manual' });

    const result = await retire();

    expect(result).toEqual({ retiredIds: [], blockedById: office });
    expect((await row(shell)).archived_at).toBeNull();
    expect(await openIds()).toEqual([shell, office]);
  });

  test('the wizard\'s own older draft does not block: the shell is archived and the wizard draft stays open', async () => {
    const shell = await estimate();
    const wizard = await estimate({ source: 'quote_wizard', monthly_total: 59 });

    const result = await retire();

    expect(result.retiredIds).toEqual([shell]);
    expect(await openIds()).toEqual([wizard]);
  });

  test('a wizard estimate that was already sent blocks like an office estimate', async () => {
    const shell = await estimate();
    const sent = await estimate({ source: 'quote_wizard', status: 'sent', sent_at: new Date(), monthly_total: 59 });

    const result = await retire();

    expect(result).toEqual({ retiredIds: [], blockedById: sent });
    expect((await row(shell)).archived_at).toBeNull();
  });

  test.each([
    ['has a monthly price', { monthly_total: 59 }],
    ['has a one-time price', { onetime_total: 199 }],
    ['has an annual price', { annual_total: 708 }],
    ['was sent', { sent_at: new Date() }],
    ['was viewed', { viewed_at: new Date() }],
    ['has a send time', { scheduled_at: new Date(Date.now() + DAY) }],
    ['was claimed by auto-send', { estimate_data: JSON.stringify({ automation: { autoSend: { claimedAt: '2026-11-20T12:00:00.000Z' } } }) }],
  ])('a web-form draft that %s is not a shell: it stays, and it still blocks', async (_label, fields) => {
    const touched = await estimate(fields);

    const result = await retire();

    expect(result.retiredIds).toEqual([]);
    expect((await row(touched)).archived_at).toBeNull();
    expect(await openIds()).toEqual([touched]);
  });

  test('a web-form draft that a lead points at is not a shell', async () => {
    const linked = await estimate();
    await trx('leads').insert({
      id: randomUUID(), status: 'new', first_name: 'Sample', last_name: 'Person', phone, estimate_id: linked,
    });

    const result = await retire();

    expect(result.retiredIds).toEqual([]);
    expect((await row(linked)).archived_at).toBeNull();
  });

  test.each([
    ['waits for the office to approve it', {}],
    ['is being sent', { status: 'approved' }],
    ['was sent 2 days ago and has no answer', { status: 'approved', sent_at: new Date(Date.now() - 2 * DAY) }],
  ])('a clarify ask for the phone that %s holds the shell', async (_label, fields) => {
    const shell = await estimate();
    await clarifyAsk(fields);

    const result = await retire();

    expect(result.retiredIds).toEqual([]);
    expect((await row(shell)).archived_at).toBeNull();
  });

  test.each([
    ['was answered', { status: 'approved', sent_at: new Date(Date.now() - DAY), flags: JSON.stringify({ estimate_clarify: true, missing: [], answered_at: '2026-11-20T12:00:00.000Z' }) }],
    ['was sent more than 7 days ago', { status: 'approved', sent_at: new Date(Date.now() - 8 * DAY) }],
    ['was rejected by the office', { status: 'rejected' }],
  ])('a clarify ask that %s no longer holds the shell', async (_label, fields) => {
    const shell = await estimate();
    await clarifyAsk(fields);

    const result = await retire();

    expect(result.retiredIds).toEqual([shell]);
  });

  test('a priced web-form draft beside an untouched shell still blocks: nothing is archived', async () => {
    const shell = await estimate();
    const priced = await estimate({ monthly_total: 59 });

    const result = await retire();

    expect(result).toEqual({ retiredIds: [], blockedById: priced });
    expect((await row(shell)).archived_at).toBeNull();
  });

  test('a shell whose data is not a JSON object is archived with its data unchanged', async () => {
    const shell = await estimate({ estimate_data: JSON.stringify('legacy text') });

    const result = await retire();

    expect(result.retiredIds).toEqual([shell]);
    const after = await row(shell);
    expect(after.archived_at).toBeInstanceOf(Date);
    expect(after.estimate_data).toBe('legacy text');
  });

  test('an archived shell and a phone with no open estimate give nothing to do', async () => {
    await estimate({ archived_at: new Date() });

    expect(await retire()).toEqual({ retiredIds: [], blockedById: null });
    expect(await retire({ phone: '555' })).toEqual({ retiredIds: [], blockedById: null });
  });
});
