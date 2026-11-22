/**
 * Waves Pest Insider "A tool we'd use" at send time (services/pest-insider/tool-block.js): who gets the block
 * for one batch of a send, from one read of the send's issue row, the batch's subscriber rows and the staff
 * logins. Owner 2026-11-22 "A": no live check of the Amazon page; the block goes only to readers with opt-in
 * evidence on record, never to a Waves address, in the HTML part only (the text part is tracked, so an Amazon
 * link there would be rewritten). Every reader of a body with the token gets the one key, '' when any rule
 * fails. The database is a fake: no network, nothing sent. The real-SQL cases are in pest-insider-home-postgres.test.js (CI).
 */
const mockWarn = jest.fn();
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: (...a) => mockWarn(...a), debug: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: () => true, sendBroadcast: jest.fn(), unsubscribeUrl: jest.fn() }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn() }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));

const { toolBlockForBatch, TOOL_TOKEN, hasToolToken } = require('../services/pest-insider/tool-block');
const render = require('../services/pest-insider/render');
const tools = require('../services/pest-insider/tools');
const { AMAZON_DISCLOSURE } = tools;
const { POST_URLS } = require('../services/pest-insider/posts');

const GAUGE = 'acurite-glass-rain-gauge';
const SEND = { id: 'send-1', newsletter_type: 'pest-insider-monthly' };
const HTML = `<p>body</p>\n${TOOL_TOKEN}`;
const SENT = new Date('2026-10-01T12:00:00Z');
const CONFIRMED = new Date('2026-10-01T12:05:00Z');
const GATE = 'GATE_PEST_INSIDER_AUTO_SEND';
const ENV = ['NEWSLETTER_PROOF_EMAIL', 'NEWSLETTER_PROOF_APPROVERS', 'GMAIL_USER_EMAIL', 'INTERNAL_EMAIL_ALLOWLIST', 'ADMIN_EMAIL_ALLOWLIST', GATE];
const envBefore = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const sub = (id, email = `reader${id}@example.net`) => ({ id, email });
// A subscriber row with opt-in evidence, or with the given change.
const row = (id, over = {}) => ({ id, email: `reader${id}@example.net`, status: 'active', confirmation_sent_at: SENT, confirmed_at: CONFIRMED, ...over });

// A fake knex: `db(table)` answers the three reads the helper makes. `failOn` names a table whose read throws.
function fakeDb(opts = {}) {
  const { rows = [], staff = [], failOn = null } = opts;
  const issue = 'issue' in opts ? opts.issue : { tool_id: GAUGE };
  const reads = [];
  const db = jest.fn((table) => {
    reads.push(table);
    if (failOn === table) throw new Error(`${table} read failed`);
    const q = { ids: null };
    q.where = () => q;
    q.select = () => q;
    q.whereIn = (_col, ids) => { q.ids = ids; return q; };
    q.first = async () => issue;
    q.then = (resolve, reject) => Promise.resolve(table === 'technicians' ? staff : rows.filter((r) => !q.ids || q.ids.includes(r.id))).then(resolve, reject);
    return q;
  });
  db.reads = reads;
  return db;
}

const run = (over = {}) => toolBlockForBatch({
  send: SEND, html: HTML, text: 'text body', subscribers: [sub(1)], planned: true, db: fakeDb({ rows: [row(1)] }), ...over,
});
const keyOf = async (over, subscriber = sub(1)) => (await run(over)).forReader(subscriber);
const BLOCK = render.toolBlock(tools.toolById(GAUGE)).html;
const GOT = { [TOOL_TOKEN]: BLOCK };
const NOT = { [TOOL_TOKEN]: '' };

beforeEach(() => {
  jest.restoreAllMocks();
  mockWarn.mockClear();
  for (const k of ENV) delete process.env[k];
  process.env[GATE] = 'true';
});
afterAll(() => {
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('toolBlockForBatch: the key', () => {
  test('a reader with opt-in evidence, on a planned Pest Insider send with the gate on and a usable tool, gets the HTML block (one key)', async () => {
    const db = fakeDb({ rows: [row(1)] });
    expect(await keyOf({ db })).toEqual(GOT);
    expect(BLOCK).toContain(AMAZON_DISCLOSURE);
    // One read of each table for the batch.
    expect(db.reads.sort()).toEqual(['newsletter_subscribers', 'pest_insider_issues', 'technicians']);
    expect(db.mock.calls.filter(([t]) => t === 'pest_insider_issues')).toHaveLength(1);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('rule 1: a body with no token gives no key and reads nothing; a text part that holds the token fails closed', async () => {
    const db = fakeDb({ rows: [row(1)] });
    expect(await keyOf({ html: '<p>body</p>', db })).toEqual({});
    expect(await keyOf({ html: '<p>{{ PI-Tool }} {{pi-tool-text}}</p>', text: '{{pi-tool-text}}', db })).toEqual({});
    expect(db).not.toHaveBeenCalled();
    // The block is HTML only: a token in the text part would be filled with HTML, so nobody gets it.
    expect(await keyOf({ text: `text ${TOOL_TOKEN}`, db })).toEqual(NOT);
    expect(db).not.toHaveBeenCalled();
    expect(hasToolToken(null)).toBe(false);
  });

  test('rule 2: another newsletter type, no planned audience, or the gate off gives \'\' and reads nothing', async () => {
    for (const over of [{ send: { ...SEND, newsletter_type: 'free-form' } }, { send: { ...SEND, newsletter_type: undefined } }, { planned: false }]) {
      const db = fakeDb({ rows: [row(1)] });
      expect(await keyOf({ ...over, db })).toEqual(NOT);
      expect(db).not.toHaveBeenCalled();
    }
    for (const gate of [undefined, 'false', '1', 'TRUE']) {
      if (gate === undefined) delete process.env[GATE];
      else process.env[GATE] = gate;
      const db = fakeDb({ rows: [row(1)] });
      expect(await keyOf({ db })).toEqual(NOT);
      expect(db).not.toHaveBeenCalled();
    }
  });

  test('rule 3: the send\'s issue row must name a tool that is usable now', async () => {
    for (const issue of [undefined, null, {}, { tool_id: null }, { tool_id: '' }, { tool_id: 'no-such-tool' }]) {
      expect(await keyOf({ db: fakeDb({ issue, rows: [row(1)] }) })).toEqual(NOT);
    }
    // Paused between the build and the send: the registry as it is now has no such tool.
    jest.spyOn(tools, 'toolById').mockReturnValue(null);
    const db = fakeDb({ rows: [row(1)] });
    expect(await keyOf({ db })).toEqual(NOT);
    // No reader is read once there is no tool.
    expect(db.reads).toEqual(['pest_insider_issues']);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  describe('rule 4: opt-in evidence on the subscriber\'s row, now, for the address mailed', () => {
    const SOURCE = { source: 'beehiiv_migration' };
    test.each([
      ['a Beehiiv import row: confirmed_at backfilled, no confirmation email sent', { confirmation_sent_at: null, ...SOURCE }],
      ['a Beehiiv orphan import row', { confirmation_sent_at: null, source: 'beehiiv_migration_orphan' }],
      ['a confirm that came before its confirmation email', { confirmed_at: new Date(SENT.getTime() - 1000) }],
      ['no confirm', { confirmed_at: null }],
      ['no date at all', { confirmed_at: null, confirmation_sent_at: null }],
      ['an unreadable date', { confirmed_at: 'not a date' }],
      ['a subscriber who is no longer active', { status: 'unsubscribed' }],
      ['a pending subscriber', { status: 'pending' }],
      ['an address that changed since the batch was selected', { email: 'changed@example.net' }],
    ])('%s gets \'\'', async (_label, over) => {
      const db = fakeDb({ rows: [row(1, over), row(2)] });
      const run2 = await run({ subscribers: [sub(1), sub(2)], db });
      expect(run2.forReader(sub(1))).toEqual(NOT);
      // The control reader of the same batch still gets the block.
      expect(run2.forReader(sub(2))).toEqual(GOT);
    });

    test('a confirm at the same moment as its email counts, the address compares in any letter case and spacing, and a reader with no row gets \'\'', async () => {
      const db = fakeDb({ rows: [row(1, { confirmed_at: SENT }), row(2, { email: ' READER2@Example.NET ' })] });
      const r = await run({ subscribers: [sub(1), sub(2), sub(3)], db });
      expect(r.forReader(sub(1))).toEqual(GOT);
      expect(r.forReader(sub(2))).toEqual(GOT);
      expect(r.forReader(sub(3))).toEqual(NOT);
      // The evidence is read for the batch's own subscriber ids, in one query.
      expect(db.mock.calls.filter(([t]) => t === 'newsletter_subscribers')).toHaveLength(1);
    });
  });

  describe('rule 5: no Waves address', () => {
    const cases = [
      ['an internal domain', { email: 'someone@wavespestcontrol.com' }, {}],
      ['the newsletter sending subdomain', { email: 'someone@news.wavespestcontrol.com' }, {}],
      ['the default proof address', { email: 'contact@wavespestcontrol.com' }, {}],
      ['an address on the internal allowlist', { email: 'family@example.net' }, { INTERNAL_EMAIL_ALLOWLIST: 'family@example.net' }],
      ['the configured proof address', { email: 'proof@example.net' }, { NEWSLETTER_PROOF_EMAIL: 'proof@example.net' }],
      ['the synced approval mailbox', { email: 'inbox@example.net' }, { GMAIL_USER_EMAIL: 'inbox@example.net' }],
      ['an approver address', { email: 'approver@example.net' }, { NEWSLETTER_PROOF_APPROVERS: 'other@example.net, Approver@Example.net' }],
    ];
    test.each(cases)('%s gets \'\'', async (_label, over, env) => {
      Object.assign(process.env, env);
      const bad = row(1, over);
      const db = fakeDb({ rows: [bad, row(2)] });
      const r = await run({ subscribers: [{ id: 1, email: bad.email }, sub(2)], db });
      expect(r.forReader({ id: 1, email: bad.email })).toEqual(NOT);
      expect(r.forReader(sub(2))).toEqual(GOT);
    });

    test.each([['email'], ['google_email']])('the staff login in technicians.%s (read once for the batch, any letter case) gets \'\'', async (column) => {
      const bad = row(1, { email: 'staff.login@example.net' });
      const staff = [{ email: null, google_email: null, [column]: ' Staff.Login@Example.net ' }, { email: 'other@example.net', google_email: null }];
      const db = fakeDb({ rows: [bad, row(2)], staff });
      const r = await run({ subscribers: [{ id: 1, email: bad.email }, sub(2)], db });
      expect(r.forReader({ id: 1, email: bad.email })).toEqual(NOT);
      expect(r.forReader(sub(2))).toEqual(GOT);
      expect(db.mock.calls.filter(([t]) => t === 'technicians')).toHaveLength(1);
    });
  });

  test('a reader no rule blocks is the only one that gets the key\'s block: every reader of the batch has the key', async () => {
    const db = fakeDb({ rows: [row(1), row(2, { status: 'unsubscribed' })] });
    const r = await run({ subscribers: [sub(1), sub(2), sub(3)], db });
    for (const s of [sub(1), sub(2), sub(3)]) expect(Object.keys(r.forReader(s))).toEqual([TOOL_TOKEN]);
  });
});

describe('toolBlockForBatch: reads and the send check', () => {
  test.each(['pest_insider_issues', 'newsletter_subscribers', 'technicians'])('a failed %s read gives every reader \'\', one warning, and never throws', async (failOn) => {
    const db = fakeDb({ rows: [row(1), row(2)], failOn });
    const r = await run({ subscribers: [sub(1), sub(2)], db });
    expect(r.forReader(sub(1))).toEqual(NOT);
    expect(r.forReader(sub(2))).toEqual(NOT);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toContain(`${failOn} read failed`);
    expect(mockWarn.mock.calls[0][0]).not.toMatch(/@example/);
  });

  test('the block is checked once for the batch, however many readers get it', async () => {
    const spy = jest.spyOn(render, 'toolBlockErrors');
    const db = fakeDb({ rows: [row(1), row(2), row(3)] });
    const r = await run({ subscribers: [sub(1), sub(2), sub(3)], db });
    for (const s of [sub(1), sub(2), sub(3)]) expect(r.forReader(s)).toEqual(GOT);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ html: BLOCK }, tools.toolById(GAUGE));
    // No reader qualifies: the block is not made or checked at all.
    spy.mockClear();
    await run({ db: fakeDb({ rows: [row(1, { status: 'unsubscribed' })] }) });
    expect(spy).not.toHaveBeenCalled();
  });

  test('a block the send check refuses gives every reader \'\' and one warning; a check that throws does the same', async () => {
    jest.spyOn(render, 'toolBlockErrors').mockReturnValue(['blocked: a claim']);
    const r = await run({ subscribers: [sub(1), sub(2)], db: fakeDb({ rows: [row(1), row(2)] }) });
    expect(r.forReader(sub(1))).toEqual(NOT);
    expect(r.forReader(sub(2))).toEqual(NOT);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toContain('blocked: a claim');

    mockWarn.mockClear();
    jest.spyOn(render, 'toolBlockErrors').mockImplementation(() => { throw new Error('validator broke'); });
    expect(await keyOf({ db: fakeDb({ rows: [row(1)] }) })).toEqual(NOT);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  test('the shipped tools all pass their own block check, and a tool changed since the build is the one in the registry now', async () => {
    for (const tool of tools.loadTools().tools) {
      expect(render.toolBlockErrors(render.toolBlock(tool), tool)).toEqual([]);
    }
    const [first] = tools.loadTools().tools;
    expect(await keyOf({ db: fakeDb({ issue: { tool_id: first.productId }, rows: [row(1)] }) }))
      .toEqual({ [TOOL_TOKEN]: render.toolBlock(first).html });
  });
});

describe('the block as it is mailed', () => {
  test('the link carries clicktracking=off before href, Amazon\'s sentence follows it, and the text part has no tool', async () => {
    const tool = tools.toolById(GAUGE);
    const value = (await keyOf({ db: fakeDb({ rows: [row(1)] }) }))[TOOL_TOKEN];
    expect(value).toContain(`<a clicktracking=off class="dm-link" href="${tool.url}"`);
    expect(value.indexOf('clicktracking=off')).toBeLessThan(value.indexOf('href='));
    expect(value.indexOf(AMAZON_DISCLOSURE)).toBeGreaterThan(value.indexOf('</a>'));
    expect(value.match(/<a\b/g)).toHaveLength(1);
    expect(value.match(new RegExp(AMAZON_DISCLOSURE.replace('.', '\\.'), 'g'))).toHaveLength(1);

    // An issue as rendered: the HTML part holds the token and the text part holds no tool word, link or token.
    const issue = render.renderIssue({
      subject: 's', preview: 'p',
      lead: { headline: 'h', sentences: [{ text: 'The CDC says eggs survive 8 months.' }], postUrl: POST_URLS[0] },
      idItem: { text: 'It raises a generation.', species: { slug: 'aedes-mosquito', name: 'Aedes Mosquito' } },
    });
    expect(issue.html_body).toContain(TOOL_TOKEN);
    const mailedText = issue.text_body.split('{{unsubscribe_url}}').join('x');
    expect(mailedText).not.toMatch(/amazon|pi-tool|A TOOL WE'D USE|Associate/i);
    for (const line of tool.lines) expect(issue.text_body).not.toContain(line);
    expect(issue.html_body.split(TOOL_TOKEN).join(value)).toContain(`>${require('../services/pest-insider/tools').toolLinkText(tool)}</a>`);
  });
});
