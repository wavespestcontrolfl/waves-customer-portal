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
// The reader's confirm click writes confirmed_at and reader_confirmed_at with one value.
const CLICK = new Date('2026-10-01T12:05:00Z');
const EARLIER = new Date(CLICK.getTime() - 60000);
const LATER = new Date(CLICK.getTime() + 60000);
const GATE = 'GATE_PEST_INSIDER_AUTO_SEND';
const ENV = ['NEWSLETTER_PROOF_EMAIL', 'NEWSLETTER_PROOF_APPROVERS', 'GMAIL_USER_EMAIL', 'INTERNAL_EMAIL_ALLOWLIST', 'ADMIN_EMAIL_ALLOWLIST', 'INTERNAL_EMAIL_DOMAINS', GATE];
const envBefore = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

const sub = (id, email = `reader${id}@example.net`) => ({ id, email });
// A subscriber row the reader confirmed by link for its own address (the click wrote both
// stamps and the address), or with the given change.
const row = (id, over = {}) => {
  const email = over.email ?? `reader${id}@example.net`;
  return {
    id, email, status: 'active', confirmed_at: CLICK, reader_confirmed_at: CLICK, reader_confirmed_email: email.trim().toLowerCase(),
    unsubscribed_at: null, deactivated_at: null, ...over,
  };
};

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

  describe('rule 4: the reader\'s own confirm click is on the row now, for the address mailed', () => {
    test.each([
      ['a trusted add of a pending row: no reader click on record', { reader_confirmed_at: null, reader_confirmed_email: null }],
      ['a Beehiiv import row: confirmed_at backfilled, no click', { reader_confirmed_at: null, reader_confirmed_email: null, source: 'beehiiv_migration' }],
      ['a Beehiiv orphan import row', { reader_confirmed_at: null, reader_confirmed_email: null, source: 'beehiiv_migration_orphan' }],
      ['a row moved to another address (the click was for the old one)', { reader_confirmed_email: 'old-address@example.net' }],
      ['a click with no address recorded', { reader_confirmed_email: null }],
      ['a later trusted re-activation (confirmed_at after the click)', { confirmed_at: LATER }],
      ['no confirmed_at', { confirmed_at: null }],
      ['an unsubscribe after the click', { unsubscribed_at: LATER }],
      ['an unsubscribe at the moment of the click', { unsubscribed_at: CLICK }],
      ['a sunset deactivation after the click', { deactivated_at: LATER }],
      ['an unreadable date', { reader_confirmed_at: 'not a date' }],
      ['an unreadable opt-out stamp', { unsubscribed_at: 'not a date' }],
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

    // A trusted add of a pending row in the same instant as the reader's click: its promotion
    // updates by id with its own timestamp, and the click's proof stays on the row. No opt-out
    // is involved, so the click counts unless the promotion's confirmed_at is later.
    test('a trusted add in the same instant as the click: the click counts with a confirmed_at that is equal or earlier, and not with a later one', async () => {
      const ms = (n) => new Date(CLICK.getTime() + n);
      const db = fakeDb({ rows: [row(1, { confirmed_at: ms(0) }), row(2, { confirmed_at: ms(-1) }), row(3, { confirmed_at: ms(1) })] });
      const r = await run({ subscribers: [sub(1), sub(2), sub(3)], db });
      expect(r.forReader(sub(1))).toEqual(GOT);
      expect(r.forReader(sub(2))).toEqual(GOT);
      expect(r.forReader(sub(3))).toEqual(NOT);
    });

    test('a reader who confirmed by link for this address gets the block, also after an older opt-out or deactivation and with a click after confirmed_at', async () => {
      const db = fakeDb({ rows: [
        row(1),
        row(2, { unsubscribed_at: EARLIER, deactivated_at: EARLIER, confirmed_at: EARLIER }),
        row(3, { email: ' READER3@Example.NET ' }),
      ] });
      const r = await run({ subscribers: [sub(1), sub(2), sub(3), sub(4)], db });
      expect(r.forReader(sub(1))).toEqual(GOT);
      expect(r.forReader(sub(2))).toEqual(GOT);
      // The address compares in any letter case and spacing.
      expect(r.forReader(sub(3))).toEqual(GOT);
      // A reader with no row gets ''.
      expect(r.forReader(sub(4))).toEqual(NOT);
      // The evidence is read for the batch's own subscriber ids, in one query.
      expect(db.mock.calls.filter(([t]) => t === 'newsletter_subscribers')).toHaveLength(1);
    });
  });

  describe('rule 5: no Waves address', () => {
    const cases = [
      ['an internal domain', { email: 'someone@wavespestcontrol.com' }, {}],
      ['the newsletter sending subdomain', { email: 'someone@news.wavespestcontrol.com' }, {}],
      ['the other Waves mail domain', { email: 'someone@wavesflorida.com' }, {}],
      ['a subdomain of a Waves mail domain', { email: 'someone@mail.WavesFlorida.com' }, {}],
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

    // INTERNAL_EMAIL_DOMAINS replaces the default domains for isInternalEmailRecipient. A list that leaves a
    // Waves domain out must not let an address on it get the block.
    test.each(['someone@wavespestcontrol.com', 'Someone@News.WavesPestControl.com', 'someone@wavesflorida.com'])('with another internal domain configured, %s still gets \'\', and so does an address on the configured domain', async (email) => {
      process.env.INTERNAL_EMAIL_DOMAINS = 'partner.example';
      process.env.NEWSLETTER_PROOF_EMAIL = 'proof@example.net';
      const waves = row(1, { email });
      const partner = row(3, { email: 'desk@partner.example' });
      const db = fakeDb({ rows: [waves, row(2), partner] });
      const r = await run({ subscribers: [{ id: 1, email }, sub(2), { id: 3, email: partner.email }], db });
      expect(r.forReader({ id: 1, email })).toEqual(NOT);
      expect(r.forReader({ id: 3, email: partner.email })).toEqual(NOT);
      expect(r.forReader(sub(2))).toEqual(GOT);
    });

    test('a domain that only ends with a Waves domain name is not a Waves domain', async () => {
      const near = row(1, { email: 'reader@notwavespestcontrol.com' });
      const db = fakeDb({ rows: [near] });
      expect((await run({ subscribers: [{ id: 1, email: near.email }], db })).forReader({ id: 1, email: near.email })).toEqual(GOT);
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

    // The proof address can change between the FYI copy and the send (or a resume). The issue row
    // records every address a copy of its FYI went to (diagnostics.fyiTo, newsletter-proof.js).
    test.each([
      ['as an object', (fyiTo) => ({ fyiTo })],
      ['as the JSON text a driver may hand back', (fyiTo) => JSON.stringify({ fyiTo })],
    ])('a mailbox that got this issue\'s FYI copy gets \'\' after the proof address changed (diagnostics %s), and so does its Gmail alias', async (_label, diagnostics) => {
      process.env.NEWSLETTER_PROOF_EMAIL = 'new-proof@example.net';
      const issue = { tool_id: GAUGE, diagnostics: diagnostics({ 'old-proof@example.net': true, 'jdoe@gmail.com': true }) };
      const old = row(1, { email: 'old-proof@example.net' });
      const alias = row(3, { email: 'j.doe+x@googlemail.com' });
      const db = fakeDb({ issue, rows: [old, row(2), alias] });
      const r = await run({ subscribers: [{ id: 1, email: old.email }, sub(2), { id: 3, email: alias.email }], db });
      expect(r.forReader({ id: 1, email: old.email })).toEqual(NOT);
      expect(r.forReader({ id: 3, email: alias.email })).toEqual(NOT);
      expect(r.forReader(sub(2))).toEqual(GOT);
    });

    test('an issue row with no recorded FYI address excludes nobody more', async () => {
      for (const diagnostics of [undefined, null, {}, { fyiTo: null }, '{}', 'null']) {
        expect(await keyOf({ db: fakeDb({ issue: { tool_id: GAUGE, diagnostics }, rows: [row(1)] }) })).toEqual(GOT);
      }
      expect(mockWarn).not.toHaveBeenCalled();
    });

    // An unreadable list must not read as "nobody got a copy": the old proof address could be in it.
    test.each([
      ['text that is not JSON', '{"fyiTo": {"old-proof@example.net": tru'],
      ['a list where the address map belongs', { fyiTo: ['old-proof@example.net'] }],
      ['a text where the address map belongs', { fyiTo: 'old-proof@example.net' }],
      ['a record that is no object', ['old-proof@example.net']],
      ['a key that is no address', { fyiTo: { address: 'old-proof@example.net' } }],
      ['a value that is not true', { fyiTo: { 'old-proof@example.net': 'yes' } }],
      ['one bad entry next to a good one', { fyiTo: { 'old-proof@example.net': true, note: true } }],
    ])('an unreadable FYI record (%s) gives every reader of the batch \'\' and one warning that holds no address', async (_label, diagnostics) => {
      const db = fakeDb({ issue: { tool_id: GAUGE, diagnostics }, rows: [row(1), row(2)] });
      const r = await run({ subscribers: [sub(1), sub(2)], db });
      expect(r.forReader(sub(1))).toEqual(NOT);
      expect(r.forReader(sub(2))).toEqual(NOT);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0].join(' ')).toContain('FYI recipient record is unreadable');
      expect(mockWarn.mock.calls[0].join(' ')).not.toContain('old-proof');
    });
  });

  describe('rule 5: a Gmail alias of a Waves address is the same mailbox', () => {
    const cases = [
      ['a staff login (technicians.email)', 'staff', {}],
      ['a staff Google sign-in (technicians.google_email)', 'google', {}],
      ['the proof address', 'proof', { NEWSLETTER_PROOF_EMAIL: 'jdoe@gmail.com' }],
      ['the synced approval mailbox', 'proof', { GMAIL_USER_EMAIL: 'jdoe@gmail.com' }],
      ['an approver address', 'proof', { NEWSLETTER_PROOF_APPROVERS: 'jdoe@gmail.com' }],
      ['an address on the internal allowlist', 'proof', { INTERNAL_EMAIL_ALLOWLIST: 'jdoe@gmail.com' }],
    ];
    const staffFor = (kind) => (kind === 'staff' ? [{ email: 'jdoe@gmail.com', google_email: null }]
      : kind === 'google' ? [{ email: null, google_email: 'jdoe@gmail.com' }] : []);
    test.each(cases)('%s: a dotted, plus-tagged or googlemail.com spelling gets \'\'', async (_label, kind, env) => {
      Object.assign(process.env, env);
      for (const alias of ['j.doe+x@googlemail.com', 'J.Doe@gmail.com', 'jdoe+news@gmail.com', ' jdoe@googlemail.com ']) {
        const bad = row(1, { email: alias });
        const db = fakeDb({ rows: [bad, row(2)], staff: staffFor(kind) });
        const r = await run({ subscribers: [{ id: 1, email: alias }, sub(2)], db });
        expect(r.forReader({ id: 1, email: alias })).toEqual(NOT);
        expect(r.forReader(sub(2))).toEqual(GOT);
      }
    });

    test('the alias on the Waves side counts too: a staff login j.doe+x@googlemail.com blocks jdoe@gmail.com', async () => {
      const bad = row(1, { email: 'jdoe@gmail.com' });
      const db = fakeDb({ rows: [bad, row(2)], staff: [{ email: 'j.doe+x@googlemail.com', google_email: null }] });
      const r = await run({ subscribers: [{ id: 1, email: bad.email }, sub(2)], db });
      expect(r.forReader({ id: 1, email: bad.email })).toEqual(NOT);
      expect(r.forReader(sub(2))).toEqual(GOT);
    });

    test('a non-Gmail address is an exact match: a plus tag or dots make another mailbox', async () => {
      const staff = [{ email: 'jdoe@example.net', google_email: null }];
      const aliases = ['jdoe+x@example.net', 'j.doe@example.net'];
      const db = fakeDb({ rows: aliases.map((email, i) => row(i + 1, { email })), staff });
      const r = await run({ subscribers: aliases.map((email, i) => ({ id: i + 1, email })), db });
      for (const [i] of aliases.entries()) expect(r.forReader({ id: i + 1 })).toEqual(GOT);
      // The exact address is still blocked.
      const exact = fakeDb({ rows: [row(1, { email: 'jdoe@example.net' })], staff });
      expect((await run({ subscribers: [{ id: 1, email: 'jdoe@example.net' }], db: exact })).forReader({ id: 1 })).toEqual(NOT);
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
