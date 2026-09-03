/**
 * ops/agents/skill-doctor.js — parser + clusterer contract on fixture Codex
 * comments (no gh, no network). Protects: severity/title/path parsing of the
 * bot's comment shape, rule resolution against the PR-head AGENTS.md (not the
 * local file), recurrence needs ≥2 PRs, and the home heuristic.
 */
const { run, _internals } = require('../../ops/agents/skill-doctor');

const AGENTS_AT_HEAD = [
  '## P1 — correctness',
  '',
  '- **Public route surface.** Every unauthenticated route is documented.',
  '  more text',
  '- **Parameterized SQL only.** Never interpolate.',
  '',
].join('\n');

function codexComment({ pr, sev, title, path, line, cite, body = '' }) {
  return {
    user: { login: 'chatgpt-codex-connector[bot]' },
    path,
    line,
    original_commit_id: 'abc1234567890',
    html_url: `https://github.com/o/r/pull/${pr}#discussion_r${line}`,
    body: `**<sub><sub>![${sev} Badge](https://img.shields.io/badge/${sev}-red?style=flat)</sub></sub>  ${title}**\n\n${body}\n\n${cite ? `AGENTS.md reference: AGENTS.md:L${cite}` : ''}\n\nUseful? React with 👍 / 👎.`,
  };
}

const PRS = [
  { number: 1, title: 'a', state: 'MERGED', mergedAt: new Date().toISOString(), headRefOid: 'h1' },
  { number: 2, title: 'b', state: 'MERGED', mergedAt: new Date().toISOString(), headRefOid: 'h2' },
  { number: 3, title: 'c', state: 'MERGED', mergedAt: new Date().toISOString(), headRefOid: 'h3' },
];

const COMMENTS = {
  1: [
    codexComment({ pr: 1, sev: 'P1', title: 'Remove customer PII from the commit message', path: 'server/routes/public-quote.js', line: 10, body: 'The commit title names a customer.' }),
    codexComment({ pr: 1, sev: 'P0', title: 'Document the new public field', path: 'server/routes/lead-webhook.js', line: 20, cite: 3, body: 'public route contract' }),
    { user: { login: 'chatgpt-codex-connector[bot]' }, body: 'Codex Review Summary — no badge here' },
    { user: { login: 'someone' }, body: '![P1 Badge](x) human comment' },
    { user: { login: 'codex-fan-human' }, body: '**<sub><sub>![P1 Badge](x)</sub></sub>  Looks like a bot but is not**', path: 'a.js', line: 1 },
  ],
  2: [
    codexComment({ pr: 2, sev: 'P1', title: 'Remove customer PII from the commit message', path: 'server/services/invoice.js', line: 30, body: 'commit message carries a surname' }),
    codexComment({ pr: 2, sev: 'P2', title: 'Wrap the backfill in a transaction', path: 'server/models/migrations/x.js', line: 5, body: 'knex migration without trx' }),
  ],
  3: [
    codexComment({ pr: 3, sev: 'P1', title: 'Name the actual auth routes', path: 'docs/public-route-contracts.md', line: 1, cite: 3, body: 'public route' }),
  ],
};

function runFixture(extra = {}) {
  return run(
    { repo: 'o/r', days: 14, minPrs: 2, includeOpen: false, json: false },
    {
      listPrs: () => PRS,
      fetchCodexComments: (_repo, n) => COMMENTS[n] || [],
      agentsMdAt: () => AGENTS_AT_HEAD.split('\n'),
      ...extra,
    },
  );
}

describe('parseFinding', () => {
  test('reads severity, title, path, line, cite; ignores wrapper and human comments', () => {
    const f = _internals.parseFinding(COMMENTS[1][1], PRS[0]);
    expect(f).toMatchObject({ pr: 1, severity: 'P0', title: 'Document the new public field', path: 'server/routes/lead-webhook.js', line: 20, agentsLines: [3, 3] });
    expect(_internals.parseFinding(COMMENTS[1][2], PRS[0])).toBeNull();
  });
});

describe('run + clusterFindings', () => {
  test('findings from the bot only; recurrence requires two PRs', () => {
    const { findings, clusters } = runFixture();
    expect(findings).toHaveLength(5);
    const phrase = clusters.find((c) => c.kind === 'phrase' && /remove customer pii/.test(c.label));
    expect(phrase).toBeDefined();
    expect(phrase.prs).toEqual([1, 2]);
    expect(phrase.worst).toBe('P1');
    // A single-PR class never clusters.
    expect(clusters.find((c) => c.kind === 'phrase' && /transaction/.test(c.label))).toBeUndefined();
  });

  test('cited rules resolve against AGENTS.md at the PR head, not the local file', () => {
    const { clusters } = runFixture();
    const rule = clusters.find((c) => c.kind === 'rule');
    expect(rule.label).toBe('Public route surface');
    expect(rule.prs).toEqual([1, 3]);
    expect(rule.ruleExists).toBe(true);
  });

  test('home heuristic: commit-message findings go to waves-ship, migrations to waves-db, public routes to the contracts doc', () => {
    const [pii, pub] = [COMMENTS[1][0], COMMENTS[1][1]].map((c) => _internals.parseFinding(c, PRS[0]));
    expect(_internals.candidateHome(pii)).toBe('waves-ship');
    expect(_internals.candidateHome(pub)).toBe('docs/public-route-contracts.md');
    expect(_internals.candidateHome(_internals.parseFinding(COMMENTS[2][1], PRS[1]))).toBe('waves-db');
  });

  test('cited findings never double as uncited phrase classes; unfetchable head AGENTS.md leaves the cite unresolved', () => {
    const cited = runFixture().clusters.filter((c) => c.kind === 'phrase' && /public/.test(c.label));
    expect(cited).toHaveLength(0);
    const { findings, clusters } = runFixture({ agentsMdAt: () => null });
    expect(findings.filter((f) => f.agentsLines).every((f) => f.agentsRule === null)).toBe(true);
    expect(clusters.find((c) => c.kind === 'rule')).toBeUndefined();
  });

  test('score and home are one representative per PR — a noisy single PR cannot outrank or out-vote cross-PR recurrence', () => {
    const noisy = Array.from({ length: 20 }, (_, i) => codexComment({ pr: 1, sev: 'P1', title: 'Wrap the backfill in a transaction', path: 'server/models/migrations/x.js', line: i + 1, body: 'knex migration without trx' }));
    const { clusters } = runFixture({ fetchCodexComments: (_r, n) => (n === 1 ? [...COMMENTS[1], ...noisy] : COMMENTS[n] || []) });
    const trx = clusters.find((c) => c.kind === 'phrase' && /transaction/.test(c.label));
    // 21 findings, but PR 1 counts once (P1=4) and PR 2 once (P2=2).
    expect(trx.count).toBe(21);
    expect(trx.score).toBe(6);
    const pii = clusters.find((c) => c.kind === 'phrase' && /remove customer pii/.test(c.label));
    expect(pii.score).toBe(8);
    expect(clusters.indexOf(pii)).toBeLessThan(clusters.indexOf(trx));
    // Home vote: the noisy PR's 20 waves-db votes are one vote; PR 2 also says waves-db.
    expect(trx.home).toBe('waves-db');
  });

  test('a citation whose head AGENTS.md could not be fetched stays out of the uncited phrase section', () => {
    const { clusters } = runFixture({ agentsMdAt: () => null });
    expect(clusters.find((c) => c.kind === 'phrase' && /(document the new public field|name the actual auth routes)/.test(c.label))).toBeUndefined();
  });

  test('normalizePhrase keeps inline-code identifiers so two classes do not merge', () => {
    expect(_internals.normalizePhrase('Preserve `email` when updating customer')).not.toBe(_internals.normalizePhrase('Preserve `status` when updating customer'));
    expect(_internals.normalizePhrase('Preserve `email` when updating customer')).toContain('email');
  });

  test('path clusters are looked up by their finding titles, not the path tokens; no checkout → not checked', () => {
    const { clusters } = runFixture();
    const pathCluster = { kind: 'path', label: 'server/services/content/content-guardrails.js', home: 'waves-content', findings: [{ title: 'Reject send-bound terms on non-outreach paths' }, { title: 'Reject send-bound terms in newsletter copy' }] };
    expect(_internals.clusterTerms(pathCluster)).toEqual(expect.arrayContaining(['reject', 'send', 'bound', 'terms']));
    expect(_internals.clusterTerms(pathCluster)).not.toContain('services');
    expect(_internals.ruleExists(pathCluster, null)).toBeNull();
    expect(clusters.every((c) => c.ruleExists !== null)).toBe(true);
    expect(_internals.renderMarkdown({ ...runFixture(), clusters: clusters.map((c) => ({ ...c, ruleExists: c.kind === 'rule' ? true : null })) })).toContain('not checked');
  });

  test('--root defaults to this repo for the portal and to a sibling checkout (or null) for another repo', () => {
    expect(_internals.defaultRootFor('wavespestcontrolfl/waves-customer-portal')).toBe(require('path').resolve(__dirname, '../..'));
    expect(_internals.defaultRootFor('o/does-not-exist-anywhere')).toBeNull();
    expect(() => _internals.parseArgs(['--root', '/nonexistent-dir'])).toThrow(/AGENTS\.md/);
  });

  test('markdown report renders the three sections with one example per PR', () => {
    const result = runFixture();
    const md = _internals.renderMarkdown(result);
    expect(md).toContain('## Cited rules that keep being broken');
    expect(md).toContain('## Recurring finding classes with no cited rule');
    expect(md).toContain('### 1. Public route surface');
    expect((md.match(/Remove customer PII from the commit message/g) || []).length).toBe(2);
    expect(md).not.toContain('AGENTS.md reference:');
  });
});
