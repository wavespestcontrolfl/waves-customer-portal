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
const { buildIssue } = require('../services/pest-insider');
const { FACTS, factById, factsForSend } = require('../services/pest-insider/facts');
const { SPECIES, RECENT_WINDOW, planIssue } = require('../services/pest-insider/plan');

const realPlanIssue = jest.requireActual('../services/pest-insider/plan').planIssue;
const A01 = factById('A01');
const WFA = SPECIES.find((s) => s.slug === 'white-footed-ant');
// A fixed plan: fact A01 (white-footed ants) and the White-footed Ant species,
// so these cases test check -> render -> validate, not the planner's rotation.
const usePlan = (leadFact, idItem = WFA) => planIssue.mockImplementation(() => ({ leadFact, idItem }));

afterEach(() => {
  planIssue.mockReset();
  planIssue.mockImplementation(realPlanIssue);
});

describe('buildIssue', () => {
  test("builds the issue from the fact's reviewed lead, title and species entry", () => {
    usePlan(A01);
    const r = buildIssue({ sendDate: '2026-12-03' });
    expect(r.ok).toBe(true);
    expect(planIssue).toHaveBeenCalledWith({ sendDate: '2026-12-03', recentFactIds: [], recentSpeciesSlugs: [], recheckedFactIds: [] });
    expect(r.issue.subject).toBe(`🐜 ${A01.title}`);
    expect(r.issue.preview).toBe("What's this? White-footed Ant");
    for (const line of A01.lead) {
      expect(r.issue.html_body).toContain(line);
      expect(r.issue.text_body).toContain(line);
    }
    expect(r.issue.text_body).toContain(WFA.fact);
    expect(r.diagnostics).toEqual({ sendDate: '2026-12-03', factId: 'A01', speciesSlug: 'white-footed-ant', problems: [] });
  });

  test('recent picks are passed to the plan', () => {
    // T03 and the brown widow are what 2026-12-03 picks with no recent issues.
    const r = buildIssue({ sendDate: '2026-12-03', recent: { factIds: ['T03'], speciesSlugs: ['brown-widow'] } });
    expect(r.ok).toBe(true);
    expect(r.diagnostics.factId).not.toBe('T03');
    expect(r.diagnostics.speciesSlug).not.toBe('brown-widow');
  });

  test('a copy problem fails the issue and names every problem; nothing is cut', () => {
    const bad = { ...A01, lead: [A01.lead[0], 'Colonies hold 9 million ants.', 'Bleach works on them.'] };
    usePlan(bad);
    const r = buildIssue({ sendDate: '2026-12-03' });
    expect(r).toMatchObject({ ok: false, issue: null, reason: expect.stringMatching(/^copy_check_failed: lead: number not in the source: 9; lead: pesticide or brand name/) });
    expect(r.diagnostics.problems.map((p) => p.text)).toEqual(['Colonies hold 9 million ants.', 'Bleach works on them.']);
  });

  test('the send validator reads the whole rendered issue, where one sentence reads the one before it', () => {
    // On its own "They swarm again in June." names no termite, so the copy
    // check passes it; under the "Formosan Termite" heading the shared
    // register reads it as the false second-swarm claim, as the send would.
    const formosan = { ...SPECIES.find((s) => s.slug === 'formosan-termite'), fact: 'They swarm again in June.' };
    usePlan(factById('T02'), formosan);
    const r = buildIssue({ sendDate: '2027-05-06' });
    expect(r).toMatchObject({ ok: false, issue: null, reason: expect.stringMatching(/^send_validator_blocked: Unverified claim \(termite_second_swarm\)/) });
    expect(r.diagnostics.problems[0]).toMatchObject({ part: 'send_validator' });
  });

  test('a lead fact marked for a send-time recheck is refused unless the caller names it as rechecked', () => {
    const M01 = factById('M01');
    expect(M01.recheck_before_send).toBe(true);
    // the planner skips such a fact; the builder refuses one the planner returns anyway
    usePlan(M01, SPECIES.find((s) => s.slug === 'house-centipede'));
    expect(buildIssue({ sendDate: '2027-06-03' })).toMatchObject({ ok: false, issue: null, reason: 'recheck_needed: M01' });
    expect(buildIssue({ sendDate: '2027-06-03', recheckedFactIds: ['M01'] }).ok).toBe(true);
    expect(planIssue.mock.calls[1][0].recheckedFactIds).toEqual(['M01']);
  });

  test('passes planning failures through', () => {
    const used = factsForSend('2026-12-03').map((f) => f.id);
    expect(buildIssue({ sendDate: '2026-12-03', recent: { factIds: used } })).toMatchObject({ ok: false, reason: 'no_fact_for_month', issue: null });
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
      "const r = buildIssue({ sendDate: '2026-12-03' });",
      "const loaded = Object.keys(require.cache).filter((k) => /[\\\\/]models[\\\\/]db\\.js$|[\\\\/]node_modules[\\\\/]knex[\\\\/]/.test(k));",
      "process.stdout.write('\\nRESULT ' + JSON.stringify({ ok: r.ok, factId: r.diagnostics.factId, loaded }) + '\\n');",
    ].join('\n');
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'offline-sample' }, encoding: 'utf8', timeout: 60000,
    });
    const line = out.split('\n').find((l) => l.startsWith('RESULT '));
    expect(JSON.parse(line.slice('RESULT '.length))).toEqual({ ok: true, factId: 'T03', loaded: [] });
  }, 60000);

  test('a planner passed by the caller is ignored (pre-push round 17)', () => {
    const plan = jest.fn(() => ({ leadFact: { ...A01, lead: ['Colonies hold 9 million ants.', 'They are everywhere.'] }, idItem: WFA }));
    const r = buildIssue({ sendDate: '2026-12-03', plan });
    expect(plan).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.diagnostics.factId).toBe('T03');
  });
});

describe('every issue the bank can make', () => {
  test.each(FACTS.filter((f) => !f.reserve).map((f) => [f.id, f]))('%s builds an issue the send validator accepts', (_id, fact) => {
    usePlan(fact);
    const r = buildIssue({ sendDate: '2026-12-03', recheckedFactIds: [fact.id] });
    expect({ reason: r.reason, problems: r.diagnostics.problems }).toEqual({ reason: null, problems: [] });
  });

  test('every identifier species builds an issue the send validator accepts', () => {
    const failed = SPECIES
      .map((species) => {
        usePlan(A01, species);
        return { slug: species.slug, r: buildIssue({ sendDate: '2026-12-03' }) };
      })
      .filter(({ r }) => !r.ok)
      .map(({ slug, r }) => `${slug}: ${r.reason}`);
    expect(failed).toEqual([]);
  });

  test('the first and third Thursdays from December 2026 through 2027 all build, in order', () => {
    const days = ['2026-12-03', '2026-12-17'];
    for (let month = 0; month < 12; month += 1) {
      const thursdays = [];
      for (let day = 1; day <= 31; day += 1) {
        const d = new Date(Date.UTC(2027, month, day));
        if (d.getUTCMonth() === month && d.getUTCDay() === 4) thursdays.push(d.toISOString().slice(0, 10));
      }
      days.push(thursdays[0], thursdays[2]);
    }
    const recent = { factIds: [], speciesSlugs: [] };
    const built = days.map((sendDate) => {
      const r = buildIssue({ sendDate, recent: { factIds: recent.factIds.slice(-RECENT_WINDOW), speciesSlugs: recent.speciesSlugs.slice(-RECENT_WINDOW) } });
      if (r.ok) {
        recent.factIds.push(r.diagnostics.factId);
        recent.speciesSlugs.push(r.diagnostics.speciesSlug);
      }
      return { sendDate, reason: r.reason };
    });
    expect(built).toHaveLength(26);
    expect(built.filter((b) => b.reason)).toEqual([]);
    // With no recheck recorded, no fact marked for one ever leads.
    expect(recent.factIds.filter((id) => factById(id).recheck_before_send)).toEqual([]);
    // The two default sample dates (ops/agents/pest-insider-sample.js).
    expect(recent.factIds.slice(0, 2)).toEqual(['T03', 'A01']);
  });
});

describe('the sample script (ops/agents/pest-insider-sample.js)', () => {
  const SCRIPT = path.join(__dirname, '..', '..', 'ops', 'agents', 'pest-insider-sample.js');
  const run = (dates) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pest-insider-sample-'));
    try {
      const r = spawnSync(process.execPath, [SCRIPT, dir, ...dates], { encoding: 'utf8', timeout: 60000 });
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
});
