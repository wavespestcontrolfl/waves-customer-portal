// Terminal writer (GATE_CONTENT_WRITER_TERMINAL): the draft step reads one JSON
// file a terminal session pushed to the Astro repo. Proves what counts as a
// usable draft, what waits, and the life of the one admin item that names the
// waiting rows. The seam in the runner is covered in autonomous-runner.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The editorial-evidence gate, switched per test.
let mockEditorialOn = false;
jest.mock('../services/content/editorial-evidence', () => ({ enabled: () => mockEditorialOn }));

const tw = require('../services/content/terminal-writer');

const ID = '00000000-0000-4000-8000-0000000000aa';
const BRIEF = 'brief-aa';
const body = 'Ghost ants trail along the kitchen backsplash in the wet season. '.repeat(8);
const good = (over = {}) => ({ opportunity_id: ID, brief_id: BRIEF, frontmatter: { title: 'Ghost Ants' }, body, ...over });
const file = (obj) => ({ sha: 'blob', content: typeof obj === 'string' ? obj : JSON.stringify(obj) });
// One branch per test: `content` undefined = no branch.
const ghWith = (content, { sha = 'commit-1' } = {}) => ({
  getBranchSha: jest.fn(async () => (content === undefined ? null : sha)),
  getFile: jest.fn(async () => (content === null ? null : file(content))),
  retireBranch: jest.fn(async () => true),
});

describe('terminal writer gate', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  test('on only for exactly "true"; a title/meta rewrite is never written in the terminal', () => {
    delete process.env.GATE_CONTENT_WRITER_TERMINAL;
    expect(tw.writesInTerminal({ action_type: 'new_supporting_blog', page_type: 'blog' })).toBe(false);
    process.env.GATE_CONTENT_WRITER_TERMINAL = '1';
    expect(tw.terminalWriterLive()).toBe(false);
    process.env.GATE_CONTENT_WRITER_TERMINAL = 'true';
    expect(tw.writesInTerminal({ action_type: 'new_supporting_blog', page_type: 'blog' })).toBe(true);
    expect(tw.writesInTerminal({ action_type: 'rewrite_title_meta', page_type: 'metadata' })).toBe(false);
  });
});

describe('with the editorial-evidence gate on, briefs that need an approved answer plan stay on the agent', () => {
  const saved = { ...process.env };
  beforeEach(() => { process.env.GATE_CONTENT_WRITER_TERMINAL = 'true'; mockEditorialOn = true; });
  afterEach(() => { process.env = { ...saved }; mockEditorialOn = false; });

  test.each([
    ['a supporting blog', { action_type: 'new_supporting_blog', page_type: 'supporting-blog' }, false],
    ['a customer question page', { action_type: 'create_customer_question_page', page_type: 'customer-question' }, false],
    ['a refresh', { action_type: 'refresh_existing_page', page_type: 'refresh' }, false],
    ['a city service page (no answer plan)', { action_type: 'create_or_refresh_city_service_page', page_type: 'city-service' }, true],
  ])('%s', (_label, brief, inTerminal) => {
    expect(tw.writesInTerminal(brief)).toBe(inTerminal);
    expect(tw.draftSourceFor(ID, { id: BRIEF, ...brief }, { handed: true }) !== null).toBe(inTerminal);
  });

  test('with that gate off, the same briefs are written in the terminal', () => {
    mockEditorialOn = false;
    expect(tw.writesInTerminal({ action_type: 'new_supporting_blog', page_type: 'supporting-blog' })).toBe(true);
  });
});

describe('waitingBriefId: the brief on the latest run, only when that run waits for a draft', () => {
  const skipped = [];
  const conn = (latest) => () => ({ where: () => ({ whereRaw: (...a) => { skipped.push(a); return { orderBy: () => ({ first: async () => latest }) }; } }) });
  test.each([
    ['a waiting run', { outcome: 'deferred_terminal_draft', brief_id: BRIEF }, BRIEF],
    ['a gate retry (the row needs a new brief first)', { outcome: 'deferred_gate_retry', brief_id: BRIEF }, null],
    ['a cap deferral after the draft was taken (the late backstop)', { outcome: 'deferred_publish_cap', brief_id: BRIEF }, null],
    ['no run at all', undefined, null],
  ])('%s', async (_label, latest, expected) => {
    expect(await tw.waitingBriefId(ID, { conn: conn(latest) })).toBe(expected);
    // a publish-cap deferral that ended before the draft step (no agent) is not the row's "latest run"
    expect(skipped.at(-1)).toEqual(['NOT (outcome = ? AND agent_id IS NULL)', ['deferred_publish_cap']]);
  });
});

describe('fetchTerminalDraft', () => {
  test('reads the file at the branch commit and returns the dispatcher\'s result shape with only draft fields', async () => {
    const gh = ghWith(good({ schema: { '@type': 'Article' }, notes_for_reviewer: 'n', extra: 'dropped' }));
    const out = await tw.fetchTerminalDraft(ID, { gh, expectedBriefId: BRIEF });
    expect(gh.getBranchSha).toHaveBeenCalledWith(`terminal-writer/${ID}`);
    expect(gh.getFile).toHaveBeenCalledWith(`terminal-drafts/${ID}.json`, 'commit-1');
    expect(out).toMatchObject({ ok: true, agent_id: 'terminal-writer', session_id: null, brief_id: BRIEF, revision: 'commit-1' });
    expect(out.draft).toEqual({ type: 'draft', frontmatter: { title: 'Ghost Ants' }, body, schema: { '@type': 'Article' }, notes_for_reviewer: 'n' });
    expect(typeof out.duration_ms).toBe('number');
  });

  // Live 2026-10-09: two terminal refresh drafts passed every gate and then parked as
  // publisher_adapter_unavailable, because the publisher only takes a draft stamped type 'draft'
  // (the agent's emit_draft handler stamps it; the terminal path did not).
  test('a terminal draft is one the publisher takes: stamped type draft, whatever the file says', async () => {
    const publisher = require('../services/content-astro/astro-publisher');
    const out = await tw.fetchTerminalDraft(ID, { gh: ghWith(good({ type: 'metadata' })), expectedBriefId: BRIEF });
    expect(out.draft.type).toBe('draft');
    expect(publisher.canPublishRefresh(out.draft, { action_type: 'refresh_existing_page', target_url: 'https://www.wavespestcontrol.com/x/' })).toBe(true);
    expect(publisher.canPublishDraftBrief(out.draft, { action_type: 'new_supporting_blog' })).toBe(true);
  });

  test('no brief handed out, no branch, no file, or a 404 is "missing"', async () => {
    const unread = ghWith(good());
    expect(await tw.fetchTerminalDraft(ID, { gh: unread, expectedBriefId: null })).toMatchObject({ ok: false, code: tw.MISSING });
    expect(unread.getBranchSha).not.toHaveBeenCalled();
    expect(await tw.fetchTerminalDraft(ID, { gh: ghWith(undefined), expectedBriefId: BRIEF })).toMatchObject({ ok: false, code: tw.MISSING });
    expect(await tw.fetchTerminalDraft(ID, { gh: ghWith(null), expectedBriefId: BRIEF })).toMatchObject({ ok: false, code: tw.MISSING });
    const notFound = ghWith(good());
    notFound.getFile.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await tw.fetchTerminalDraft(ID, { gh: notFound, expectedBriefId: BRIEF })).toMatchObject({ ok: false, code: tw.MISSING });
  });

  test('any other GitHub failure throws: it must not read as "no draft yet"', async () => {
    const down = ghWith(good());
    down.getBranchSha.mockRejectedValue(Object.assign(new Error('Bad Gateway'), { status: 502 }));
    await expect(tw.fetchTerminalDraft(ID, { gh: down, expectedBriefId: BRIEF })).rejects.toThrow('Bad Gateway');
  });

  test.each([
    ['not JSON', '{nope'],
    ['a JSON array', []],
    ['another row\'s id', good({ opportunity_id: 'someone-else' })],
    ['a draft written from another brief', good({ brief_id: 'brief-old' })],
    ['a draft that names no brief', good({ brief_id: undefined })],
    ['no frontmatter object', good({ frontmatter: 'x' })],
    ['a body that is too short', good({ body: 'short' })],
    ['a claims_ledger that is not a list', good({ claims_ledger: {} })],
    ['an oversized file', good({ body: 'x'.repeat(400001) })],
  ])('%s is rejected with a reason', async (_label, content) => {
    const out = await tw.fetchTerminalDraft(ID, { gh: ghWith(content), expectedBriefId: BRIEF });
    expect(out).toMatchObject({ ok: false, code: tw.INVALID });
    expect(out.reason).toMatch(/^terminal draft rejected: /);
  });
});

describe('a hold in place of a draft (owner 2026-11-02): the row cannot be written as briefed', () => {
  const hold = (over = {}, extra = {}) => ({ opportunity_id: ID, brief_id: BRIEF, hold: { reason: 'duplicate', detail: 'The live termite swarmers post covers this topic.', ...over }, ...extra });

  test('a usable hold is read as HELD, never as a draft, with its text tidied', async () => {
    const r = await tw.fetchTerminalDraft(ID, { gh: ghWith(hold({ detail: '  The live post\n covers it.\t ' })), expectedBriefId: BRIEF });
    expect(r).toMatchObject({ ok: false, code: tw.HELD, hold: { reason: 'duplicate', detail: 'The live post covers it.' }, brief_id: BRIEF, revision: 'commit-1', agent_id: 'terminal-writer' });
    expect(r.draft).toBeUndefined();
    expect(r.hold.question).toBeUndefined();
    const owner = await tw.fetchTerminalDraft(ID, { gh: ghWith(hold({ reason: 'needs_owner', question: 'Remove the competitor names from the page text?' })), expectedBriefId: BRIEF });
    expect(owner.hold).toEqual({ reason: 'needs_owner', detail: 'The live termite swarmers post covers this topic.', question: 'Remove the competitor names from the page text?' });
  });

  test.each([
    ['another row', hold({}, { opportunity_id: 'someone-else' }), /opportunity_id does not match/],
    ['another brief', hold({}, { brief_id: 'brief-before' }), /brief_id is not the brief this row waits on/],
    ['a draft and a hold at once', hold({}, { body, frontmatter: {} }), /a draft or a hold, not both/],
    ['a hold that is not an object', { opportunity_id: ID, brief_id: BRIEF, hold: 'duplicate' }, /hold must be an object/],
    ['an unknown reason', hold({ reason: 'too_hard' }), /hold.reason must be one of duplicate, blocked_by_rule, brief_unusable, needs_owner/],
    ['no detail', hold({ detail: '   ' }), /hold.detail must be 1 to 500 characters/],
    ['a detail too long', hold({ detail: 'x'.repeat(501) }), /hold.detail must be 1 to 500 characters/],
    ['a needs_owner hold with no question', hold({ reason: 'needs_owner' }), /needs a question of 1 to 300 characters/],
  ])('%s is rejected like a bad draft: the row keeps waiting', async (_name, content, why) => {
    const r = await tw.fetchTerminalDraft(ID, { gh: ghWith(content), expectedBriefId: BRIEF });
    expect(r).toMatchObject({ ok: false, code: tw.INVALID });
    expect(r.reason).toMatch(why);
  });

  test('the draft source answers a hold with `held`, not `wait`', async () => {
    process.env.GATE_CONTENT_WRITER_TERMINAL = 'true';
    try {
      const source = tw.draftSourceFor(ID, { id: BRIEF, action_type: 'new_supporting_blog', page_type: 'supporting-blog' }, { handed: true, gh: ghWith(hold()) });
      const r = await source.runWithBrief();
      expect(r).toMatchObject({ held: true, code: tw.HELD, hold: { reason: 'duplicate' }, revision: 'commit-1' });
      expect(r.wait).toBeUndefined();
    } finally { delete process.env.GATE_CONTENT_WRITER_TERMINAL; }
  });
});

describe('draftSourceFor: the terminal as a draft source with the dispatcher\'s contract', () => {
  const saved = { ...process.env };
  beforeEach(() => { process.env.GATE_CONTENT_WRITER_TERMINAL = 'true'; });
  afterEach(() => { process.env = { ...saved }; });
  const brief = { id: BRIEF, action_type: 'new_supporting_blog', page_type: 'supporting-blog' };

  test('no source (the agent writes) with the gate off, on a dry run, and for a title/meta rewrite', () => {
    expect(tw.draftSourceFor(ID, brief, { handed: true, dryRun: true })).toBeNull();
    expect(tw.draftSourceFor(ID, { ...brief, action_type: 'rewrite_title_meta', page_type: 'metadata' }, { handed: true })).toBeNull();
    process.env.GATE_CONTENT_WRITER_TERMINAL = 'false';
    expect(tw.draftSourceFor(ID, brief, { handed: true })).toBeNull();
  });

  test('a usable draft is returned as the dispatcher would return one', async () => {
    const out = await tw.draftSourceFor(ID, brief, { handed: true, gh: ghWith(good()) }).runWithBrief();
    expect(out).toMatchObject({ ok: true, brief_id: BRIEF, revision: 'commit-1' });
    expect(out.wait).toBeUndefined();
  });

  test('a brief that was not handed out yet, a missing or rejected file, and a GitHub failure all WAIT', async () => {
    const unread = ghWith(good());
    expect(await tw.draftSourceFor(ID, brief, { handed: false, gh: unread }).runWithBrief()).toMatchObject({ ok: false, wait: true, code: tw.MISSING });
    expect(unread.getBranchSha).not.toHaveBeenCalled();
    expect(await tw.draftSourceFor(ID, brief, { handed: true, gh: ghWith('{nope') }).runWithBrief()).toMatchObject({ ok: false, wait: true, code: tw.INVALID });
    const down = ghWith(good());
    down.getBranchSha.mockRejectedValue(Object.assign(new Error('Bad Gateway'), { status: 502 }));
    expect(await tw.draftSourceFor(ID, brief, { handed: true, gh: down }).runWithBrief()).toMatchObject({ ok: false, wait: true, code: tw.UNREADABLE, agent_id: 'terminal-writer' });
  });
});

describe('retireTerminalDraft', () => {
  test('deletes the branch while it still points at the commit that was read', async () => {
    const gh = ghWith(good());
    expect(await tw.retireTerminalDraft(ID, { gh, revision: 'commit-1' })).toBe(true);
    expect(gh.retireBranch).toHaveBeenCalledWith(`terminal-writer/${ID}`);
  });

  test('a push since the read is kept: nothing is deleted', async () => {
    const gh = ghWith(good(), { sha: 'commit-2' });
    expect(await tw.retireTerminalDraft(ID, { gh, revision: 'commit-1' })).toBe(false);
    expect(gh.retireBranch).not.toHaveBeenCalled();
  });

  test('an unconfirmed delete or a GitHub error is false, never a throw', async () => {
    const gh = ghWith(good());
    gh.retireBranch.mockResolvedValue(false);
    expect(await tw.retireTerminalDraft(ID, { gh, revision: 'commit-1' })).toBe(false);
    gh.retireBranch.mockRejectedValue(new Error('boom'));
    expect(await tw.retireTerminalDraft(ID, { gh, revision: 'commit-1' })).toBe(false);
  });
});

test('cleanupConsumedDrafts deletes the branch of a stored run that took a draft, and nothing else', async () => {
  const gh = ghWith(good());
  await tw.cleanupConsumedDrafts([
    { id: 'run_1', opportunity_id: ID, terminal_draft_revision: 'commit-1' },
    { id: null, opportunity_id: ID, terminal_draft_revision: 'commit-1' }, // never stored: the pushed file is the only copy
    { id: 'run_3', opportunity_id: ID }, // waited; took no draft
  ], { gh });
  expect(gh.retireBranch).toHaveBeenCalledTimes(1);
});

describe('waiting rows and the admin item', () => {
  const B = '00000000-0000-4000-8000-0000000000bb';
  const C = '00000000-0000-4000-8000-0000000000cc';
  const R = '00000000-0000-4000-8000-0000000000dd';
  const waiting = (id, over = {}) => ({ opportunity_id: id, brief_id: `brief-${id.slice(-2)}`, brief_created_at: new Date(), action_type: 'new_supporting_blog', outcome: tw.AWAITING_OUTCOME, agent_id: null, skip_reason: tw.MISSING, query: `topic ${id.slice(-2)}`, score: 80, ...over });
  const draftFor = (id, over = {}) => ({ opportunity_id: id, brief_id: `brief-${id.slice(-2)}`, frontmatter: {}, body, ...over });
  // branches: opportunity id -> the file on its branch (absent = no branch)
  function deps({ rows, branches = {}, openKeys = [] }) {
    const idOf = (branch) => branch.split('/')[1];
    const gh = {
      getBranchSha: jest.fn(async (branch) => (branches[idOf(branch)] === undefined ? null : `sha-${idOf(branch)}`)),
      getFile: jest.fn(async (path) => file(branches[path.split('/')[1].replace('.json', '')])),
    };
    return {
      gh,
      db: { raw: jest.fn(async () => ({ rows })) },
      episodes: {
        openAdminAlertKeys: jest.fn(async (_conn, prefix) => openKeys.filter((key) => key.startsWith(prefix))),
        closeAdminAlertKeys: jest.fn(async () => 0),
        raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', rang: true })),
      },
    };
  }

  test('no file = due; a usable file = written; a file the run would reject (bad JSON, another brief) stays due; a failed check waits for its retry brief', async () => {
    const branches = { [B]: draftFor(B), [C]: draftFor(C, { brief_id: 'brief-from-before-the-retry' }) };
    const d = deps({ rows: [waiting(ID), waiting(B), waiting(C), waiting(R, { outcome: tw.GATE_RETRY_OUTCOME, agent_id: tw.TERMINAL_AGENT_ID })], branches });
    const out = await tw.awaitingTerminalDrafts({ deps: d });
    expect(out.due.map((r) => r.opportunity_id)).toEqual([ID, C]);
    expect(out.due[1].problem).toMatch(/brief_id is not the brief this row waits on/);
    expect(out.written.map((r) => r.opportunity_id)).toEqual([B]);
    expect(out.rebrief.map((r) => r.opportunity_id)).toEqual([R]);
    expect(out.due[0]).toMatchObject({ branch: `terminal-writer/${ID}`, draft_path: `terminal-drafts/${ID}.json`, brief_id: 'brief-aa' });
    // the latest run of each pending row: waiting ones, and gate retries of a terminal draft
    expect(d.db.raw.mock.calls[0][1]).toEqual([7, 'deferred_publish_cap', tw.AWAITING_OUTCOME, tw.GATE_RETRY_OUTCOME, tw.TERMINAL_AGENT_ID]);

    branches[C] = draftFor(C);
    expect((await tw.awaitingTerminalDrafts({ deps: d })).written.map((r) => r.opportunity_id)).toEqual([B, C]);

    // A hold on the branch: the row is held, neither due nor written.
    branches[ID] = { opportunity_id: ID, brief_id: 'brief-aa', hold: { reason: 'brief_unusable', detail: 'The brief has no search data, so the quality check fails any draft.' } };
    const withHold = await tw.awaitingTerminalDrafts({ deps: d });
    expect(withHold.held.map((r) => [r.opportunity_id, r.hold.reason])).toEqual([[ID, 'brief_unusable']]);
    expect(withHold.due.map((r) => r.opportunity_id)).toEqual([]);
    expect(withHold.written.map((r) => r.opportunity_id)).toEqual([B, C]);
  });

  test('a waiting row whose brief is too old, or gone, is not offered for writing, nor listed written with its draft pushed: the next run briefs it again', async () => {
    const now = new Date('2026-10-09T13:00:00Z');
    const d = deps({ rows: [
      waiting(ID, { brief_created_at: new Date('2026-10-03T13:00:00Z') }),
      waiting(B, { brief_created_at: new Date('2026-10-01T13:00:00Z') }),
      waiting(C, { brief_created_at: null }),
    ], branches: { [B]: draftFor(B) } });
    const out = await tw.awaitingTerminalDrafts({ now, deps: d });
    expect(out.due.map((r) => r.opportunity_id)).toEqual([ID]);
    // `written` is what the daily batch claims first; a stale brief never is.
    expect(out.written).toEqual([]);
    expect(out.rebrief.map((r) => r.opportunity_id)).toEqual([B, C]);
  });

  test('rows due: one item for today through the reopen mechanism, versioned by what is due; earlier days are closed', async () => {
    const now = new Date('2026-10-09T13:00:00Z');
    const d = deps({ rows: [waiting(ID), waiting(C)], branches: { [C]: '{bad' }, openKeys: ['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09'] });
    expect(await tw.raiseTerminalDue({ now, deps: d })).toEqual({ due: 2, written: 0, rebrief: 0, delivered: true });
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-08']);
    const [category, title, why, opts] = d.episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect([category, title]).toEqual(['content', 'Content — write 2 website posts in the terminal']);
    expect(why).toBe('The content queue has 2 posts that wait for a draft from the terminal.');
    // bellDefault: the content category is off the bell policy's default list; this item asks for work
    expect(opts).toMatchObject({ dedupeKey: 'content-terminal-due:2026-10-09', refreshOnDedupe: true, link: '/admin/blog?tab=autopilot', bellDefault: true });
    expect(opts.metadata).toMatchObject({ severity: 'needs-you', doneWhen: 'drafts_written', who: 'claude' });
    expect(opts.ringOnRefresh()).toBe(false);
    expect(opts.detail).toContain('topic aa');
    expect(opts.detail).toContain('topic cc (the last draft file was rejected)');

    // the same list again is the same version; a different list is a new one
    await tw.raiseTerminalDue({ now, deps: d });
    const versions = d.episodes.raiseAdminAlertWithReopen.mock.calls.map((c) => c[3].dedupeVersion);
    expect(versions[1]).toBe(versions[0]);
    const other = deps({ rows: [waiting(ID)] });
    await tw.raiseTerminalDue({ now, deps: other });
    expect(other.episodes.raiseAdminAlertWithReopen.mock.calls[0][3].dedupeVersion).not.toBe(versions[0]);
  });

  test('an item the bell policy suppressed is reported as not delivered', async () => {
    const d = deps({ rows: [waiting(ID)] });
    d.episodes.raiseAdminAlertWithReopen.mockResolvedValue({ id: null, suppressed: true, rang: false });
    expect(await tw.raiseTerminalDue({ now: new Date('2026-10-09T13:00:00Z'), deps: d })).toMatchObject({ due: 1, delivered: false });
  });

  test('nothing due: no item, and today\'s open item is closed too; a row that waits for its retry brief raises nothing', async () => {
    const now = new Date('2026-10-09T17:00:00Z');
    const d = deps({ rows: [waiting(B), waiting(R, { outcome: tw.GATE_RETRY_OUTCOME, agent_id: tw.TERMINAL_AGENT_ID })], branches: { [B]: draftFor(B) }, openKeys: ['content-terminal-due:2026-10-09'] });
    expect(await tw.raiseTerminalDue({ now, deps: d })).toEqual({ due: 0, written: 1, rebrief: 1, delivered: false });
    expect(d.episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(d.episodes.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-09']);
  });
});

describe("owner 2026-11-02: the daily item is Claude's; the owner's bell is a list the terminal stopped handling", () => {
  const routing = require('../services/admin-alert-routing');
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.AUTONOMOUS_CONTENT_TERMINAL_DUE_QUIET; });
  afterEach(() => { process.env = { ...saved }; });

  const now = new Date('2026-11-04T14:20:00Z');
  const hoursAgo = (h) => new Date(now.getTime() - h * 60 * 60 * 1000);
  const OLD = '00000000-0000-4000-8000-0000000000e1';
  const NEW = '00000000-0000-4000-8000-0000000000e2';
  const row = (id, briefAgeHours) => ({ opportunity_id: id, brief_id: `brief-${id.slice(-2)}`, brief_created_at: hoursAgo(briefAgeHours), action_type: 'new_supporting_blog', outcome: tw.AWAITING_OUTCOME, agent_id: tw.TERMINAL_AGENT_ID, skip_reason: tw.MISSING, query: `topic ${id.slice(-2)}`, score: 79 });
  function deps(rows, openKeys = []) {
    return {
      gh: { getBranchSha: jest.fn(async () => null), getFile: jest.fn(async () => null) },
      db: { raw: jest.fn(async () => ({ rows })) },
      episodes: {
        openAdminAlertKeys: jest.fn(async (_conn, prefix) => openKeys.filter((key) => key.startsWith(prefix))),
        closeAdminAlertKeys: jest.fn(async () => 0),
        raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', rang: true })),
      },
    };
  }
  const raises = (d) => Object.fromEntries(d.episodes.raiseAdminAlertWithReopen.mock.calls.map((c) => [c[3].dedupeKey, c]));

  test('the daily item is stamped for Claude\'s queue: Activity only and fyi, so it never rings and opens no Claude tab', async () => {
    const d = deps([row(NEW, 20)]);
    await tw.raiseTerminalDue({ now, deps: d });
    const [, title, , opts] = raises(d)['content-terminal-due:2026-11-04'];
    expect(title).toBe('Content — write 1 website post in the terminal');
    expect(opts.metadata).toMatchObject({ terminalDue: 'claude', who: 'claude', doneWhen: 'drafts_written' });
    expect(opts.detail.split('\n')[0]).toBe('The 9:15 AM blog-run job on the Mac writes these. Waiting for a draft:');
    expect(routing.stampClaudeQueue({ category: 'content', metadata: { ...opts.metadata, dedupeKey: opts.dedupeKey } }))
      .toMatchObject({ feed: 'activity', who: 'claude', severity: 'fyi', claudeQueue: 'content-terminal-due' });
    // A fresh brief has not stalled: no owner item, and nothing to close.
    expect(Object.keys(raises(d))).toEqual(['content-terminal-due:2026-11-04']);
  });

  test('a row left on the same brief 44 hours (two 9:15 AM runs) rings the owner once a day; a newer one does not', async () => {
    const d = deps([row(OLD, 44), row(NEW, 43.5)], ['content-terminal-stalled:2026-11-03']);
    await tw.raiseTerminalDue({ now, deps: d });
    const [category, title, why, opts] = raises(d)['content-terminal-stalled:2026-11-04'];
    expect([category, title]).toEqual(['content', 'Content — blog-run left 1 website post for 2 days']);
    expect(why).toBe('The terminal has not handled them in 2 days, so the 9:15 AM blog-run job on the Mac may be down.');
    expect(opts).toMatchObject({ bellDefault: true, refreshOnDedupe: true, link: '/admin/blog?tab=autopilot' });
    expect(opts.ringOnRefresh()).toBe(false);
    expect(opts.metadata).toMatchObject({ severity: 'needs-you', who: 'person', doneWhen: 'terminal_caught_up' });
    expect(opts.metadata.terminalDue).toBeUndefined();
    // The owner's item is never routed to Claude's queue.
    expect(routing.classifyClaudeQueue({ category: 'content', metadata: opts.metadata, dedupeKey: opts.dedupeKey })).toBeNull();
    expect(opts.detail).toContain('- new supporting blog: topic e1');
    expect(opts.detail).not.toContain('topic e2');
    // Yesterday's owner item is closed; the daily item still lists both rows.
    expect(d.episodes.closeAdminAlertKeys.mock.calls.find((c) => c[2] === 'terminal_caught_up')[1]).toEqual(['content-terminal-stalled:2026-11-03']);
    expect(raises(d)['content-terminal-due:2026-11-04'][1]).toBe('Content — write 2 website posts in the terminal');
  });

  test('nothing stalled: the owner item standing from earlier today is closed', async () => {
    const d = deps([row(NEW, 2)], ['content-terminal-stalled:2026-11-04']);
    await tw.raiseTerminalDue({ now, deps: d });
    expect(Object.keys(raises(d))).toEqual(['content-terminal-due:2026-11-04']);
    expect(d.episodes.closeAdminAlertKeys.mock.calls.find((c) => c[2] === 'terminal_caught_up')[1]).toEqual(['content-terminal-stalled:2026-11-04']);
  });

  test('switch off: the daily item rings the owner as before and no owner item is raised', async () => {
    for (const env of [{ AUTONOMOUS_CONTENT_TERMINAL_DUE_QUIET: 'false' }]) {
      Object.assign(process.env, env);
      const d = deps([row(OLD, 60)], ['content-terminal-stalled:2026-11-04']);
      await tw.raiseTerminalDue({ now, deps: d });
      expect(Object.keys(raises(d))).toEqual(['content-terminal-due:2026-11-04']);
      const opts = raises(d)['content-terminal-due:2026-11-04'][3];
      expect(opts.metadata.terminalDue).toBeUndefined();
      expect(opts.detail.split('\n')[0]).toBe('Run blog-run in the terminal. Waiting for a draft:');
      expect(routing.classifyClaudeQueue({ category: 'content', metadata: opts.metadata, dedupeKey: opts.dedupeKey })).toBeNull();
      // The daily item rings itself, so a standing owner item is closed.
      expect(d.episodes.closeAdminAlertKeys.mock.calls.find((c) => c[2] === 'terminal_caught_up')[1]).toEqual(['content-terminal-stalled:2026-11-04']);
      delete process.env.AUTONOMOUS_CONTENT_TERMINAL_DUE_QUIET;
    }
  });
});

describe('the gate as a kill switch, and the 1pm catch-up', () => {
  const episodes = (open) => ({ openAdminAlertKeys: jest.fn(async (_conn, prefix) => open.filter((key) => key.startsWith(prefix))), closeAdminAlertKeys: jest.fn(async () => open.length) });

  test('gate off: every open terminal item is closed, the owner\'s stalled-list item too, with no GitHub read', async () => {
    const e = episodes(['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09', 'content-terminal-stalled:2026-10-09']);
    await tw.closeTerminalItems({ now: new Date('2026-10-09T13:00:00Z'), deps: { episodes: e, db: {} } });
    expect(e.closeAdminAlertKeys.mock.calls[0][1]).toEqual(['content-terminal-due:2026-10-08', 'content-terminal-due:2026-10-09', 'content-terminal-stalled:2026-10-09']);
    expect(e.closeAdminAlertKeys.mock.calls[0][2]).toBe('terminal_writer_off');
  });

  describe('blogDraftRequested: is the drought alert false news?', () => {
    const saved = { ...process.env };
    beforeEach(() => { process.env.GATE_CONTENT_WRITER_TERMINAL = 'true'; });
    afterEach(() => { process.env = { ...saved }; });
    const now = new Date('2026-10-09T17:00:00Z');
    const withBlog = (rows) => ({ raw: jest.fn(async () => ({ rows })) });

    test('true only when today\'s item stands AND a blog waits', async () => {
      expect(await tw.blogDraftRequested({ now, deps: { episodes: episodes(['content-terminal-due:2026-10-09']), db: withBlog([{}]) } })).toBe(true);
      // the item is open but only other page types wait
      expect(await tw.blogDraftRequested({ now, deps: { episodes: episodes(['content-terminal-due:2026-10-09']), db: withBlog([]) } })).toBe(false);
      // a blog waits but today's item is not open (never raised, suppressed, or closed)
      expect(await tw.blogDraftRequested({ now, deps: { episodes: episodes(['content-terminal-due:2026-10-08']), db: withBlog([{}]) } })).toBe(false);
    });

    test('false with the gate off and on any read failure: the drought alert is the fallback signal', async () => {
      const failing = { openAdminAlertKeys: jest.fn(async () => { throw new Error('db down'); }) };
      expect(await tw.blogDraftRequested({ now, deps: { episodes: failing, db: withBlog([{}]) } })).toBe(false);
      process.env.GATE_CONTENT_WRITER_TERMINAL = 'false';
      expect(await tw.blogDraftRequested({ now, deps: { episodes: episodes(['content-terminal-due:2026-10-09']), db: withBlog([{}]) } })).toBe(false);
    });
  });
});

describe('a needs_owner hold asks the owner once, and the item closes when the row no longer waits on the owner', () => {
  const OPP = '00000000-0000-4000-8000-0000000000f1';
  const OTHER = '00000000-0000-4000-8000-0000000000f2';
  const episodes = (open = []) => ({
    openAdminAlertKeys: jest.fn(async (_conn, prefix) => open.filter((key) => key.startsWith(prefix))),
    closeAdminAlertKeys: jest.fn(async (_conn, keys) => keys.length),
    raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', rang: true })),
  });
  const hold = (question) => ({ reason: 'needs_owner', detail: 'The live page names a competitor in its text.', question });
  const row = { action_type: 'refresh_existing_page', query: 'in wall pest control system' };

  test('the question is the why when it fits; the item is the owner\'s, rings by default, one per row', async () => {
    const e = episodes();
    await tw.raiseHoldQuestion({ opportunityId: OPP, row, hold: hold('Remove the competitor names from the page text?'), deps: { episodes: e } });
    const [category, title, why, opts] = e.raiseAdminAlertWithReopen.mock.calls[0];
    expect([category, title, why]).toEqual(['content', 'Content — a website post needs your decision', 'Remove the competitor names from the page text?']);
    expect(opts).toMatchObject({ dedupeKey: `content-terminal-hold:${OPP}`, bellDefault: true, link: '/admin/blog?tab=autopilot' });
    expect(opts.metadata).toMatchObject({ severity: 'needs-you', who: 'person', doneWhen: 'owner_decided', opportunityId: OPP });
    expect(opts.detail).toContain('Post: refresh existing page: in wall pest control system');
    expect(opts.detail).toContain('Question: Remove the competitor names from the page text?');
    expect(opts.detail).toContain('Why the terminal held it: The live page names a competitor in its text.');
  });

  test('a question that breaks the why rules (two sentences, or too long) moves to the detail under a fixed why', async () => {
    for (const question of ['Strip the names from the text. Or exempt the page?', `Should the page ${'really '.repeat(20)}keep the names?`]) {
      const e = episodes();
      await tw.raiseHoldQuestion({ opportunityId: OPP, row, hold: hold(question), deps: { episodes: e } });
      const [, , why, opts] = e.raiseAdminAlertWithReopen.mock.calls[0];
      expect(why).toBe('The terminal held this website post until you decide; the question is in the details.');
      expect(opts.detail).toContain(`Question: ${question}`);
    }
  });

  describe('syncHoldQuestions (each batch end)', () => {
    const saved = { ...process.env };
    beforeEach(() => { process.env.GATE_CONTENT_WRITER_TERMINAL = 'true'; });
    afterEach(() => { process.env = { ...saved }; });
    const waitingRow = (id, question = 'Remove the competitor names from the page text?') => ({
      opportunity_id: id, outcome: tw.HOLD_OUTCOME, skip_reason: 'terminal_hold:needs_owner', action_type: 'refresh_existing_page',
      query: 'in wall pest control system', draft_payload: { hold: hold(question) },
    });
    const conn = (rows) => ({ raw: jest.fn(async () => ({ rows })) });

    test('a row that waits on the owner and has no item gets one (a failed raise is made again at the next batch end)', async () => {
      const e = episodes([]);
      const out = await tw.syncHoldQuestions({ deps: { episodes: e, db: conn([waitingRow(OPP)]) } });
      expect(out).toEqual({ raised: 1, closed: 0 });
      const [, , why, opts] = e.raiseAdminAlertWithReopen.mock.calls[0];
      expect(why).toBe('Remove the competitor names from the page text?');
      expect(opts.dedupeKey).toBe(`content-terminal-hold:${OPP}`);
      expect(opts.detail).toContain('Post: refresh existing page: in wall pest control system');
    });

    test('an item already open (read, Done by a person, or not) is not raised again; an answered row\'s item closes', async () => {
      const e = episodes([`content-terminal-hold:${OPP}`, `content-terminal-hold:${OTHER}`]);
      const db = conn([waitingRow(OPP)]);
      const out = await tw.syncHoldQuestions({ deps: { episodes: e, db } });
      expect(out).toEqual({ raised: 0, closed: 1 });
      expect(e.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
      expect(e.closeAdminAlertKeys.mock.calls[0][1]).toEqual([`content-terminal-hold:${OTHER}`]);
      expect(e.closeAdminAlertKeys.mock.calls[0][2]).toBe('owner_decided');
      expect(db.raw.mock.calls[0][1]).toEqual([31, 'deferred_publish_cap', tw.HOLD_OUTCOME, 'terminal_hold:needs_owner']);
    });

    test('one failed raise never stops the others; a stored hold with no question raises nothing', async () => {
      const e = episodes([]);
      e.raiseAdminAlertWithReopen.mockRejectedValueOnce(new Error('db down'));
      const noQuestion = { ...waitingRow(OTHER), draft_payload: JSON.stringify({ hold: { reason: 'needs_owner', detail: 'x' } }) };
      const THIRD = '00000000-0000-4000-8000-0000000000f3';
      const out = await tw.syncHoldQuestions({ deps: { episodes: e, db: conn([waitingRow(OPP), noQuestion, waitingRow(THIRD)]) } });
      expect(out).toEqual({ raised: 1, closed: 0 });
      expect(e.raiseAdminAlertWithReopen.mock.calls.map((c) => c[3].dedupeKey)).toEqual([`content-terminal-hold:${OPP}`, `content-terminal-hold:${THIRD}`]);
    });

    test('gate off: every item closes, none is raised, nothing is read', async () => {
      process.env.GATE_CONTENT_WRITER_TERMINAL = 'false';
      const e = episodes([`content-terminal-hold:${OPP}`]);
      const db = conn([waitingRow(OPP)]);
      const out = await tw.syncHoldQuestions({ deps: { episodes: e, db } });
      expect(out).toEqual({ raised: 0, closed: 1 });
      expect(db.raw).not.toHaveBeenCalled();
      expect(e.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    });
  });
});
