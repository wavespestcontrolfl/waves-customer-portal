// Pest Insider buildIssue: plan -> copy check -> render -> send validator.
// Every word comes from the fact bank's reviewed copy; no model is called.
// buildIssue takes no planner (pre-push round 17), so a case that needs a
// fixed plan mocks the plan module; every other case runs the real planner.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../services/pest-insider/plan', () => {
  const actual = jest.requireActual('../services/pest-insider/plan');
  return { ...actual, planIssue: jest.fn(actual.planIssue) };
});
// Every main fact gets a post here, so each case tests the build, not how
// many facts the reviewed post list covers today (pest-insider-posts.test.js
// holds the real list; the offline and sample-script cases below use it).
jest.mock('../services/pest-insider/posts', () => {
  const actual = jest.requireActual('../services/pest-insider/posts');
  const { FACTS: facts } = jest.requireActual('../services/pest-insider/facts');
  const POSTS = Object.freeze(Object.fromEntries(facts.filter((f) => !f.reserve).map((f) => {
    const name = `fact-${f.id.toLowerCase()}`;
    return [f.id, Object.freeze({ path: `/pest-control/${name}/`, file: `src/content/blog/pest-control/${name}.md`, states: f.statement })];
  })));
  const postUrl = (id) => (Object.prototype.hasOwnProperty.call(POSTS, id) ? `${actual.SITE}${POSTS[id].path}` : null);
  return { ...actual, POSTS, postUrl, POST_URLS: Object.freeze([...new Set(Object.keys(POSTS).map(postUrl))]) };
});
const { buildIssue, NEWSLETTER_TYPE } = require('../services/pest-insider');
const { FACTS, factById, factsForSend } = require('../services/pest-insider/facts');
const { SPECIES, planIssue } = require('../services/pest-insider/plan');
const { postUrl } = require('../services/pest-insider/posts');
const { POST_LINK_TEXT, withToolBlock } = require('../services/pest-insider/render');
const { validateNewsletterDraft } = require('../services/newsletter-validator');
const { TOOLS, toolById, toolLinkText, AMAZON_DISCLOSURE } = require('../services/pest-insider/tools');

// Every main fact's post answers as live, unless a case says otherwise.
const LIVE = FACTS.filter((f) => !f.reserve).map((f) => f.id);

const realPlanIssue = jest.requireActual('../services/pest-insider/plan').planIssue;
const A01 = factById('A01');
const WFA = SPECIES.find((s) => s.slug === 'white-footed-ant');
// A fixed plan: fact A01 (white-footed ants) and the White-footed Ant species,
// so these cases test check -> render -> validate, not the planner's rotation.
const usePlan = (leadFact, idItem = WFA, tool = null) => planIssue.mockImplementation(() => ({ leadFact, idItem, tool }));
const ALL_TOOLS = TOOLS.map((t) => t.productId);

afterEach(() => {
  planIssue.mockReset();
  planIssue.mockImplementation(realPlanIssue);
});

describe('buildIssue', () => {
  test("builds the issue from the fact's reviewed lead, title and species entry", () => {
    usePlan(A01);
    const r = buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE });
    expect(r.ok).toBe(true);
    expect(planIssue).toHaveBeenCalledWith({
      sendDate: '2026-12-03', recentFactIds: [], recentSpeciesSlugs: [], recheckedFactIds: [], livePostFactIds: LIVE, liveToolIds: [], recentToolIds: [],
    });
    expect(r.issue.subject).toBe(`🐜 ${A01.title}`);
    expect(r.issue.preview).toBe("What's this? White-footed Ant");
    for (const line of A01.lead) {
      expect(r.issue.html_body).toContain(line);
      expect(r.issue.text_body).toContain(line);
    }
    expect(r.issue.text_body).toContain(WFA.fact);
    // the lead links A01's own reviewed post
    expect(r.issue.html_body).toContain(`href="${postUrl('A01')}"`);
    expect(r.issue.text_body).toContain(`${POST_LINK_TEXT}: ${postUrl('A01')}`);
    expect(r.diagnostics).toEqual({ sendDate: '2026-12-03', factId: 'A01', speciesSlug: 'white-footed-ant', toolId: null, problems: [] });
    // no live tool named: no tool, and no Amazon link anywhere
    expect(r.toolId).toBeNull();
    for (const part of [r.issue.html_body, r.issue.text_body]) expect(part).not.toMatch(/amazon/i);
  });

  test('a live tool comes back as toolId, outside the shared body; its opted-in copy still fails the send check until PR 4', () => {
    const mesh = toolById('stuff-it-copper-mesh');
    usePlan(A01, WFA, mesh);
    const r = buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE, liveToolIds: [mesh.productId] });
    expect(r).toMatchObject({ ok: true, reason: null, toolId: 'stuff-it-copper-mesh' });
    expect(r.diagnostics.toolId).toBe('stuff-it-copper-mesh');
    // the shared body, which the archive serves, has no Amazon link (pre-push PR 3 r1)
    for (const part of [r.issue.html_body, r.issue.text_body]) expect(part).not.toMatch(/amazon/i);
    const optedIn = withToolBlock(r.issue, r.toolId);
    expect(optedIn.html_body).toContain(`>${toolLinkText(mesh)}</a>`);
    expect(optedIn.text_body).toContain(`${mesh.lines.join(' ')}\n\n${toolLinkText(mesh)}: ${mesh.url}\n${AMAZON_DISCLOSURE}`);
    // No newsletter type may carry it yet: PR 4 adds the per-recipient check with opt-in evidence.
    const { errors } = validateNewsletterDraft({
      subject: optedIn.subject, preview_text: optedIn.preview, html_body: optedIn.html_body, text_body: optedIn.text_body, newsletter_type: NEWSLETTER_TYPE,
    });
    expect(errors.join(' ')).toMatch(/AFFILIATE_LINK_IN_UNAPPROVED_CHANNEL/);
  });

  test('the builder refuses a tool the planner returns without a live check', () => {
    usePlan(A01, WFA, toolById('stuff-it-copper-mesh'));
    expect(buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE, liveToolIds: ['acurite-glass-rain-gauge'] }))
      .toMatchObject({ ok: false, issue: null, reason: 'no_live_tool: stuff-it-copper-mesh' });
  });

  test('the live tools and the recent tools are passed to the plan', () => {
    buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE, liveToolIds: ALL_TOOLS, recent: { toolIds: ['stuff-it-copper-mesh'] } });
    expect(planIssue).toHaveBeenCalledWith(expect.objectContaining({ liveToolIds: ALL_TOOLS, recentToolIds: ['stuff-it-copper-mesh'] }));
  });

  test('with no live-post list, no issue builds: every issue links its lead fact\'s post', () => {
    expect(buildIssue({ sendDate: '2026-12-03' })).toMatchObject({ ok: false, issue: null, reason: 'no_live_post_for_month' });
    expect(buildIssue({ sendDate: '2026-12-03', livePostFactIds: [] })).toMatchObject({ ok: false, reason: 'no_live_post_for_month' });
  });

  test('a fact whose post is down does not lead: the next fact with a live post leads in its place', () => {
    const first = buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE });
    const swapped = buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE.filter((id) => id !== first.diagnostics.factId) });
    expect(swapped.ok).toBe(true);
    expect(swapped.diagnostics.factId).not.toBe(first.diagnostics.factId);
    expect(swapped.issue.html_body).toContain(`href="${postUrl(swapped.diagnostics.factId)}"`);
  });

  test('the builder refuses a lead fact the planner returns without a live post', () => {
    usePlan(A01);
    expect(buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE.filter((id) => id !== 'A01') }))
      .toMatchObject({ ok: false, issue: null, reason: 'no_live_post: A01' });
  });

  test('recent picks are passed to the plan', () => {
    // T03 and the brown widow are what 2026-12-03 picks with no recent issues.
    const r = buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE, recent: { factIds: ['T03'], speciesSlugs: ['brown-widow'] } });
    expect(r.ok).toBe(true);
    expect(r.diagnostics.factId).not.toBe('T03');
    expect(r.diagnostics.speciesSlug).not.toBe('brown-widow');
  });

  test('a copy problem fails the issue and names every problem; nothing is cut', () => {
    const bad = { ...A01, lead: [A01.lead[0], 'Colonies hold 9 million ants.', 'Bleach works on them.'] };
    usePlan(bad);
    const r = buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE });
    expect(r).toMatchObject({ ok: false, issue: null, reason: expect.stringMatching(/^copy_check_failed: lead: number not in the source: 9; lead: pesticide or brand name/) });
    expect(r.diagnostics.problems.map((p) => p.text)).toEqual(['Colonies hold 9 million ants.', 'Bleach works on them.']);
  });

  test('the send validator reads the whole rendered issue, where one sentence reads the one before it', () => {
    // On its own "They swarm again in June." names no termite, so the copy
    // check passes it; under the "Formosan Termite" heading the shared
    // register reads it as the false second-swarm claim, as the send would.
    const formosan = { ...SPECIES.find((s) => s.slug === 'formosan-termite'), fact: 'They swarm again in June.' };
    usePlan(factById('T02'), formosan);
    const r = buildIssue({ sendDate: '2027-05-06', livePostFactIds: LIVE });
    expect(r).toMatchObject({ ok: false, issue: null, reason: expect.stringMatching(/^send_validator_blocked: Unverified claim \(termite_second_swarm\)/) });
    expect(r.diagnostics.problems[0]).toMatchObject({ part: 'send_validator' });
  });

  test('a lead fact marked for a send-time recheck is refused unless the caller names it as rechecked', () => {
    const M01 = factById('M01');
    expect(M01.recheck_before_send).toBe(true);
    // the planner skips such a fact; the builder refuses one the planner returns anyway
    usePlan(M01, SPECIES.find((s) => s.slug === 'house-centipede'));
    expect(buildIssue({ sendDate: '2027-06-03', livePostFactIds: LIVE })).toMatchObject({ ok: false, issue: null, reason: 'recheck_needed: M01' });
    expect(buildIssue({ sendDate: '2027-06-03', livePostFactIds: LIVE, recheckedFactIds: ['M01'] }).ok).toBe(true);
    expect(planIssue.mock.calls[1][0].recheckedFactIds).toEqual(['M01']);
  });

  test('passes planning failures through', () => {
    const used = factsForSend('2026-12-03').map((f) => f.id);
    expect(buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE, recent: { factIds: used } })).toMatchObject({ ok: false, reason: 'no_fact_for_month', issue: null });
  });

  test('an impossible send date is refused before any plan is made', () => {
    expect(() => buildIssue({ sendDate: '2027-02-30' })).toThrow(/not a real calendar date/);
    expect(planIssue).not.toHaveBeenCalled();
  });

  test('the builder loads and builds offline: no database module, under any NODE_ENV (pre-push round 21)', () => {
    // models/db.js opens Knex and throws for a NODE_ENV the knexfile lacks.
    // The send validator's fact register used to load it at import.
    const probe = [
      "const { buildIssue } = require('./services/pest-insider');",
      "const { POSTS } = require('./services/pest-insider/posts');",
      "const r = buildIssue({ sendDate: '2026-12-03', livePostFactIds: Object.keys(POSTS) });",
      "const loaded = Object.keys(require.cache).filter((k) => /[\\\\/]models[\\\\/]db\\.js$|[\\\\/]node_modules[\\\\/]knex[\\\\/]/.test(k));",
      "process.stdout.write('\\nRESULT ' + JSON.stringify({ ok: r.ok, factId: r.diagnostics.factId, loaded }) + '\\n');",
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'offline-sample' }, encoding: 'utf8', timeout: 60000,
    });
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    // the real reviewed post list here (a fresh process has no jest mock)
    expect(JSON.parse(line.slice('RESULT '.length))).toEqual({ ok: true, factId: expect.any(String), loaded: [] });
  }, 60000);

  test('a planner passed by the caller is ignored (pre-push round 17)', () => {
    const plan = jest.fn(() => ({ leadFact: { ...A01, lead: ['Colonies hold 9 million ants.', 'They are everywhere.'] }, idItem: WFA }));
    const r = buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE, plan });
    expect(plan).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.diagnostics.factId).toBe('T03');
  });
});

describe('every issue the bank can make', () => {
  test.each(FACTS.filter((f) => !f.reserve).map((f) => [f.id, f]))('%s builds an issue the send validator accepts', (_id, fact) => {
    usePlan(fact);
    const r = buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE, recheckedFactIds: [fact.id] });
    expect({ reason: r.reason, problems: r.diagnostics.problems }).toEqual({ reason: null, problems: [] });
  });

  test('every identifier species builds an issue the send validator accepts', () => {
    const failed = SPECIES
      .map((species) => {
        usePlan(A01, species);
        return { slug: species.slug, r: buildIssue({ sendDate: '2026-12-03', livePostFactIds: LIVE }) };
      })
      .filter(({ r }) => !r.ok)
      .map(({ slug, r }) => `${slug}: ${r.reason}`);
    expect(failed).toEqual([]);
  });

});

describe('the sample script (ops/agents/pest-insider-sample.js)', () => {
  const SCRIPT = path.join(__dirname, '..', '..', 'ops', 'agents', 'pest-insider-sample.js');
  const run = (dates) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pest-insider-sample-'));
    try {
      // --assume-live: no web request in a test (the script's own default asks the website)
      const r = spawnSync(process.execPath, [SCRIPT, dir, ...dates, '--assume-live'], { encoding: 'utf8', timeout: 60000 });
      return { status: r.status, stderr: r.stderr, files: fs.readdirSync(dir).sort() };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test('checks every date before it writes a file: a repeated, earlier or impossible date writes nothing (pre-push round 23)', () => {
    // A repeated date built a second issue (R03 after T03) over the first one's files.
    for (const [dates, why] of [
      [['2026-12-03', '2026-12-03'], /2026-12-03 does not come after 2026-12-03/],
      [['2026-12-17', '2026-12-03'], /2026-12-03 does not come after 2026-12-17/],
      [['2026-12-03', '2027-02-30'], /2027-02-30 is not a real calendar date/],
    ]) {
      expect(run(dates)).toEqual({ status: 2, stderr: expect.stringMatching(why), files: [] });
    }
    expect(run(['2026-12-03', '2026-12-17'])).toMatchObject({
      status: 0,
      files: ['pest-insider-2026-12-03.html', 'pest-insider-2026-12-03.txt', 'pest-insider-2026-12-17.html', 'pest-insider-2026-12-17.txt'],
    });
  }, 120000);

  test('--assume-tools adds the opted-in copy; a rerun without a tool removes it (pre-push PR 3 r2)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pest-insider-sample-'));
    try {
      const go = (...flags) => spawnSync(process.execPath, [SCRIPT, dir, '2026-12-03', '--assume-live', ...flags], { encoding: 'utf8', timeout: 60000 }).status;
      expect(go('--assume-tools')).toBe(0);
      expect(fs.readdirSync(dir).sort()).toEqual(['.html', '.optin.html', '.optin.txt', '.txt'].map((ext) => `pest-insider-2026-12-03${ext}`));
      expect(fs.readFileSync(path.join(dir, 'pest-insider-2026-12-03.optin.txt'), 'utf8')).toContain(AMAZON_DISCLOSURE);
      expect(go()).toBe(0);
      expect(fs.readdirSync(dir).sort()).toEqual(['pest-insider-2026-12-03.html', 'pest-insider-2026-12-03.txt']);
      for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/amazon/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});
