// lockUntouchedWebFormShellsInTx + archiveWebFormShellsInTx against real
// PostgreSQL (the migrated schema, synthetic rows, one rolled-back transaction
// per test).
//
// Owner 2026-11-21, "build" (GATE_WIZARD_SUPERSEDES_FORM_DRAFT): an old web-form
// draft estimate with no price that nobody touched must not block the quote
// wizard's own estimate. The rule is one SQL predicate (jsonb paths, two NOT
// EXISTS reads, an advisory try-lock, a guarded UPDATE), so only a real database
// can prove which rows it archives and which rows it must leave alone. The
// route's own wiring is pinned in public-quote-mirror-refresh.test.js.
// No network, no spend, no customer.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
// Both gates are read from the environment: the clarify one when feature-gates
// loads, the wizard one at call time. Set before any module loads.
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
const WIZARD_GATE = 'GATE_WIZARD_SUPERSEDES_FORM_DRAFT';
// The wizard's rule (routes/public-quote.js planFormShellClear): only its own
// open draft may remain beside the shells.
const wizardRule = (existing) => !(existing.source === 'quote_wizard' && existing.status === 'draft');

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
    delete process.env[WIZARD_GATE];
    await trx.rollback();
  });

  let age = 0;
  // An open estimate for the test phone. Default: an untouched web-form shell,
  // never written since it was made. Each call is older than the one before it.
  async function estimate(fields = {}) {
    age += 1;
    const made = new Date(Date.now() - age * 3600000);
    const [row] = await trx('estimates').insert({
      customer_phone: phone,
      customer_name: 'Sample Person',
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
  // Step 1: which shells may go.
  const plan = () => lockUntouchedWebFormShellsInTx(trx, { phone, stillBlocks: wizardRule });
  // Both steps, as a wizard run whose own draft write landed.
  const retire = async () => {
    const planned = await plan();
    const retiredIds = await archiveWebFormShellsInTx(trx, { phone, shellIds: planned.shellIds, leadId: 'lead-1' });
    return { retiredIds, blockedById: planned.blockedById };
  };

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

  test('step 1 alone archives nothing: a wizard run whose own draft write was refused leaves the shell standing', async () => {
    const shell = await estimate();

    expect(await plan()).toEqual({ shellIds: [shell], newestRemaining: null, blockedById: null });

    expect((await row(shell)).archived_at).toBeNull();
    expect(await openIds()).toEqual([shell]);
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

  test('the wizard\'s own older draft does not block: it is the draft the run refreshes, the shell is archived', async () => {
    const shell = await estimate();
    const wizard = await estimate({ source: 'quote_wizard', monthly_total: 59 });

    const planned = await plan();
    expect(planned.shellIds).toEqual([shell]);
    expect(planned.newestRemaining).toMatchObject({ id: wizard, source: 'quote_wizard', status: 'draft' });

    await archiveWebFormShellsInTx(trx, { phone, shellIds: planned.shellIds, leadId: 'lead-1' });
    expect(await openIds()).toEqual([wizard]);
  });

  test('every other open estimate is judged, not only the newest: an older office estimate behind the wizard\'s draft still blocks', async () => {
    const shell = await estimate();
    await estimate({ source: 'quote_wizard', monthly_total: 59 });
    const office = await estimate({ source: 'manual', status: 'sent', sent_at: new Date() });

    const result = await retire();

    expect(result).toEqual({ retiredIds: [], blockedById: office });
    expect((await row(shell)).archived_at).toBeNull();
  });

  test('a wizard estimate that was already sent blocks like an office estimate', async () => {
    const shell = await estimate();
    const sent = await estimate({ source: 'quote_wizard', status: 'sent', sent_at: new Date(), monthly_total: 59 });

    const result = await retire();

    expect(result).toEqual({ retiredIds: [], blockedById: sent });
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
  ])('a web-form draft that %s is not a shell: it stays, and it still blocks', async (_label, fields) => {
    const touched = await estimate(fields());

    const result = await retire();

    expect(result.retiredIds).toEqual([]);
    expect((await row(touched)).archived_at).toBeNull();
    expect(await openIds()).toEqual([touched]);
  });

  test('a shell that staff restored after the wizard archived it is never archived again', async () => {
    const shell = await estimate();
    expect((await retire()).retiredIds).toEqual([shell]);
    // The unarchive route (routes/admin-estimates.js): archived_at back to null, updated_at now.
    await trx('estimates').where({ id: shell }).update({ archived_at: null, updated_at: trx.fn.now() });

    const again = await retire();

    expect(again.retiredIds).toEqual([]);
    expect((await row(shell)).archived_at).toBeNull();
    expect(await openIds()).toEqual([shell]);
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

  test('while a clarify writer holds the phone\'s clarify lock, no shell goes on this run', async () => {
    const shell = await estimate();
    // withClarifyLock (estimate-clarify-asks.js) on another connection, mid-write.
    const writer = await database.transaction();
    try {
      await writer.raw('select pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['estimate_clarify', digits]);

      expect(await plan()).toEqual({ shellIds: [], newestRemaining: null, blockedById: null });
    } finally {
      await writer.rollback();
    }
    // The writer is done: the next run may take the shell.
    expect((await plan()).shellIds).toEqual([shell]);
  });

  test('a clarify ask is not parked for a shell the wizard archived, and an ask parked first holds its shell', async () => {
    process.env[WIZARD_GATE] = 'true';
    const ask = (estimateId) => parkClarifyAsk({
      missing: ['specific_service'], phone, firstName: 'Sample', estimateId, source: 'lead_webhook_blocked', channelProvenance: 'web_form',
    });
    const asks = () => trx('message_drafts').where({ source_ref: `clarify:${digits}` });

    // The wizard archived the shell before the web form parked its question.
    const gone = await estimate();
    expect((await retire()).retiredIds).toEqual([gone]);
    expect(await ask(gone)).toEqual({ parked: false, skipped: 'estimate_superseded_by_wizard' });
    expect(await asks()).toHaveLength(0);

    // The question was parked first: it holds the next shell.
    const held = await estimate();
    expect(await ask(held)).toMatchObject({ parked: true });
    expect((await retire()).retiredIds).toEqual([]);
    expect((await row(held)).archived_at).toBeNull();
  });

  test('gate off: the park step reads nothing new and parks as before, even for an archived draft', async () => {
    const gone = await estimate();
    expect((await retire()).retiredIds).toEqual([gone]);

    const parked = await parkClarifyAsk({
      missing: ['specific_service'], phone, estimateId: gone, source: 'lead_webhook_blocked', channelProvenance: 'web_form',
    });

    expect(parked).toMatchObject({ parked: true });
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

  test('the archive step re-checks the rule: an id that is no longer a shell is not archived', async () => {
    const shell = await estimate();
    const planned = await plan();
    await trx('estimates').where({ id: shell }).update({ monthly_total: 59 });

    expect(await archiveWebFormShellsInTx(trx, { phone, shellIds: planned.shellIds, leadId: 'lead-1' })).toEqual([]);
    expect((await row(shell)).archived_at).toBeNull();
  });

  test('an archived shell and a phone with no open estimate give nothing to do', async () => {
    await estimate({ archived_at: new Date() });
    const nothing = { shellIds: [], newestRemaining: null, blockedById: null };

    expect(await plan()).toEqual(nothing);
    expect(await lockUntouchedWebFormShellsInTx(trx, { phone: '555', stillBlocks: wizardRule })).toEqual(nothing);
    expect(await archiveWebFormShellsInTx(trx, { phone, shellIds: [], leadId: 'lead-1' })).toEqual([]);
  });
});
