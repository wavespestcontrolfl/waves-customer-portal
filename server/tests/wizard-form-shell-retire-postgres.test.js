// lockUntouchedWebFormShellsInTx + archiveWebFormShellsInTx against real
// PostgreSQL (the migrated schema, synthetic rows, one rolled-back transaction
// per test).
//
// Owner 2026-11-21, "build" (GATE_WIZARD_SUPERSEDES_FORM_DRAFT): an old web-form
// draft estimate with no price that nobody touched must not block the quote
// wizard's own estimate. The rule is one SQL predicate (jsonb paths, two NOT
// EXISTS reads, an advisory try-lock, a guarded UPDATE) plus the street
// comparison, so only a real database can prove which rows it archives and
// which rows it must leave alone. The
// route's own wiring is pinned in public-quote-mirror-refresh.test.js.
// No network, no spend, no customer.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
// The clarify gate is read when feature-gates loads: set it before any module
// loads. The wizard's own gate is read by the route only (planFormShellClear),
// never by the two steps or by parkClarifyAsk, so this suite does not set it.
process.env.GATE_ESTIMATE_CLARIFY_ASKS = 'true';
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const { randomUUID } = require('node:crypto');
const {
  archiveWebFormShellsInTx,
  listOpenEstimatesByPhone,
  lockUntouchedWebFormShellsInTx,
} = require('../services/estimate-automation-duplicates');
const { parkClarifyAsk } = require('../services/estimate-clarify-asks');

const DAY = 86400000;
// The property the wizard run is for. Every fixture is for it unless a test says otherwise.
const HOME = '12 Sample St, Parrish, FL 34219';

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
    delete process.env.GATE_ESTIMATE_CLARIFY_ASKS;
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
  // An open estimate for the test phone. Default: an untouched web-form shell
  // for HOME, never written since it was made. Each call is older than the one before it.
  async function estimate(fields = {}) {
    age += 1;
    const made = new Date(Date.now() - age * 3600000);
    const [row] = await trx('estimates').insert({
      customer_phone: phone,
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

  const row = (id) => trx('estimates').where({ id }).first('id', 'status', 'archived_at', 'estimate_data');
  const openIds = async () => (await listOpenEstimatesByPhone(phone, { database: trx })).map((r) => r.id);
  // Step 1: the shells that may go ([] = the run stays blocked).
  const plan = (address = HOME) => lockUntouchedWebFormShellsInTx(trx, { phone, address });
  // Both steps, as a wizard run whose own draft write landed.
  const retire = async () => archiveWebFormShellsInTx(trx, { phone, shellIds: await plan(), leadId: 'lead-1' });

  test('archives the untouched shell that is the phone\'s only open estimate, and records which wizard lead replaced it', async () => {
    const shell = await estimate({ estimate_data: JSON.stringify({ automation: { gate: 'disabled' } }) });

    expect(await retire()).toEqual([shell]);

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

  test('step 1 alone archives nothing: a wizard run whose own draft write did not land leaves the shell standing', async () => {
    const shell = await estimate();

    expect(await plan()).toEqual([shell]);

    expect((await row(shell)).archived_at).toBeNull();
    expect(await openIds()).toEqual([shell]);
  });

  test('archives every untouched shell of the phone and leaves another phone\'s shell alone', async () => {
    const first = await estimate();
    const second = await estimate();
    const otherDigits = digits === '9415550000' ? '9415550001' : '9415550000';
    const [other] = await trx('estimates').insert({
      customer_phone: `+1${otherDigits}`, customer_name: 'Other Person', address: HOME, status: 'draft', source: 'lead_webhook',
    }).returning('id');

    expect([...(await retire())].sort()).toEqual([first, second].sort());
    expect((await row(other.id)).archived_at).toBeNull();
  });

  // The shells must be EVERY open estimate of the phone.
  test.each([
    ['an office estimate', () => ({ source: 'manual' })],
    ['a sent office estimate', () => ({ source: 'manual', status: 'sent', sent_at: new Date() })],
    ['a web-form draft with a price', () => ({ monthly_total: 59 })],
    // A refresh of it could overwrite a wizard draft that is for another property.
    ['the wizard\'s own older draft', () => ({ source: 'quote_wizard', monthly_total: 59 })],
    ['a wizard estimate that was already sent', () => ({ source: 'quote_wizard', status: 'sent', sent_at: new Date(), monthly_total: 59 })],
    ['a web-form draft for another property', () => ({ address: '88 Other Ave, Parrish, FL 34219' })],
  ])('%s beside the shell still blocks, and then the shell stays', async (_label, fields) => {
    const shell = await estimate();
    const other = await estimate(fields());

    expect(await retire()).toEqual([]);

    expect((await row(shell)).archived_at).toBeNull();
    expect((await row(other)).archived_at).toBeNull();
    expect(await openIds()).toEqual([shell, other]);
  });

  test('every open estimate is judged, not only the newest: an older office estimate behind two shells still blocks', async () => {
    const shell = await estimate();
    await estimate();
    await estimate({ source: 'manual', status: 'sent', sent_at: new Date() });

    expect(await retire()).toEqual([]);
    expect((await row(shell)).archived_at).toBeNull();
  });

  test.each([
    ['has a monthly price', () => ({ monthly_total: 59 })],
    ['has a one-time price', () => ({ onetime_total: 199 })],
    ['has an annual price', () => ({ annual_total: 708 })],
    ['was sent', () => ({ sent_at: new Date() })],
    ['was viewed', () => ({ viewed_at: new Date() })],
    ['has a send time', () => ({ scheduled_at: new Date(Date.now() + DAY) })],
    ['was claimed by auto-send', () => ({ estimate_data: JSON.stringify({ automation: { autoSend: { claimedAt: '2026-11-20T12:00:00.000Z' } } }) })],
    // A staff edit can leave every total at 0 and every delivery time empty.
    ['was written again after it was made', () => ({ updated_at: new Date() })],
    // It could not carry the marker that parkClarifyAsk reads.
    ['has data that is not a JSON object', () => ({ estimate_data: JSON.stringify('legacy text') })],
    // One phone, two homes: this run does not replace the other home's draft.
    ['is for another property', () => ({ address: '88 Other Ave, Parrish, FL 34219' })],
    ['is for the same street in another town', () => ({ address: '12 Sample St, Bradenton, FL 34205' })],
    ['is for another unit of the building', () => ({ address: '12 Sample St Apt 4, Parrish, FL 34219' })],
    // No city or ZIP = no proof that it is the same home.
    ['has an address with no city or ZIP', () => ({ address: '12 Sample St' })],
    ['has no address', () => ({ address: '' })],
  ])('a web-form draft that %s is not a shell: it stays, and it still blocks', async (_label, fields) => {
    const touched = await estimate(fields());

    expect(await retire()).toEqual([]);

    expect((await row(touched)).archived_at).toBeNull();
    expect(await openIds()).toEqual([touched]);
  });

  test('the same property written another way is the same property', async () => {
    const shell = await estimate({ address: '12 sample street, parrish, fl 34219' });

    expect(await retire()).toEqual([shell]);
  });

  test.each([
    ['no address', ''],
    ['an address with no city or ZIP', '12 Sample St'],
  ])('a run that gives %s takes no shell', async (_label, runAddress) => {
    const shell = await estimate();

    expect(await plan(runAddress)).toEqual([]);
    expect((await row(shell)).archived_at).toBeNull();
  });

  test('a shell that staff restored after the wizard archived it is never archived again', async () => {
    const shell = await estimate();
    expect(await retire()).toEqual([shell]);
    // The unarchive route (routes/admin-estimates.js): archived_at back to null, updated_at now.
    await trx('estimates').where({ id: shell }).update({ archived_at: null, updated_at: trx.fn.now() });

    expect(await retire()).toEqual([]);

    expect((await row(shell)).archived_at).toBeNull();
    expect(await openIds()).toEqual([shell]);
  });

  const linkLead = (estimateId) => trx('leads').insert({
    id: randomUUID(), status: 'new', first_name: 'Sample', last_name: 'Person', phone, estimate_id: estimateId,
  });

  test('a web-form draft that a lead points at is not a shell', async () => {
    const linked = await estimate();
    await linkLead(linked);

    expect(await retire()).toEqual([]);
    expect((await row(linked)).archived_at).toBeNull();
  });

  test('all or nothing: a lead that links a planned shell before the archive makes the archive throw', async () => {
    const shell = await estimate();
    const second = await estimate();
    const shellIds = await plan();
    expect([...shellIds].sort()).toEqual([shell, second].sort());
    // The row locks do not cover the leads table.
    await linkLead(second);

    // The caller's transaction rolls back on this throw, and its wizard draft with it.
    await expect(archiveWebFormShellsInTx(trx, { phone, shellIds, leadId: 'lead-1' }))
      .rejects.toThrow('planned 2, archived 1');
    expect((await row(second)).archived_at).toBeNull();
  });

  test.each([
    ['waits for the office to approve it', {}],
    ['is being sent', { status: 'approved' }],
    ['was sent 2 days ago and has no answer', { status: 'approved', sent_at: new Date(Date.now() - 2 * DAY) }],
  ])('a clarify ask for the phone that %s holds the shell', async (_label, fields) => {
    const shell = await estimate();
    await clarifyAsk(fields);

    expect(await retire()).toEqual([]);
    expect((await row(shell)).archived_at).toBeNull();
  });

  test.each([
    ['was answered', { status: 'approved', sent_at: new Date(Date.now() - DAY), flags: JSON.stringify({ estimate_clarify: true, missing: [], answered_at: '2026-11-20T12:00:00.000Z' }) }],
    ['was sent more than 7 days ago', { status: 'approved', sent_at: new Date(Date.now() - 8 * DAY) }],
    ['was rejected by the office', { status: 'rejected' }],
  ])('a clarify ask that %s no longer holds the shell', async (_label, fields) => {
    const shell = await estimate();
    await clarifyAsk(fields);

    expect(await retire()).toEqual([shell]);
  });

  test('while a clarify writer holds the phone\'s clarify lock, no shell goes on this run', async () => {
    const shell = await estimate();
    // withClarifyLock (estimate-clarify-asks.js) on another connection, mid-write.
    const writer = await database.transaction();
    try {
      await writer.raw('select pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['estimate_clarify', digits]);

      expect(await plan()).toEqual([]);
    } finally {
      await writer.rollback();
    }
    // The writer is done: the next run may take the shell.
    expect(await plan()).toEqual([shell]);
  });

  test('a clarify ask is not parked for a shell the wizard archived, and an ask parked first holds its shell', async () => {
    const ask = (estimateId) => parkClarifyAsk({
      missing: ['specific_service'], phone, firstName: 'Sample', estimateId, source: 'lead_webhook_blocked', channelProvenance: 'web_form',
    });
    const asks = () => trx('message_drafts').where({ source_ref: `clarify:${digits}` });

    // The wizard archived the shell before the web form parked its question.
    // The wizard's gate is not set here: the marker is honored with the gate
    // off too, because an archive outlives the gate.
    const gone = await estimate();
    expect(await retire()).toEqual([gone]);
    expect(await ask(gone)).toEqual({ parked: false, skipped: 'estimate_superseded_by_wizard' });
    expect(await asks()).toHaveLength(0);

    // The question was parked first: it holds the next shell.
    const held = await estimate();
    expect(await ask(held)).toMatchObject({ parked: true });
    expect(await retire()).toEqual([]);
    expect((await row(held)).archived_at).toBeNull();
  });

  test('a draft that staff restored can get its clarify ask again', async () => {
    const shell = await estimate();
    expect(await retire()).toEqual([shell]);
    await trx('estimates').where({ id: shell }).update({ archived_at: null, updated_at: trx.fn.now() });

    const parked = await parkClarifyAsk({
      missing: ['specific_service'], phone, estimateId: shell, source: 'lead_webhook_blocked', channelProvenance: 'web_form',
    });

    expect(parked).toMatchObject({ parked: true });
  });

  test('an archived shell, a phone with no open estimate and an empty plan give nothing to do', async () => {
    await estimate({ archived_at: new Date() });

    expect(await plan()).toEqual([]);
    expect(await lockUntouchedWebFormShellsInTx(trx, { phone: '555', address: HOME })).toEqual([]);
    expect(await archiveWebFormShellsInTx(trx, { phone, shellIds: [], leadId: 'lead-1' })).toEqual([]);
  });
});
