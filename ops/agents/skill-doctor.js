#!/usr/bin/env node
/**
 * skill-doctor.js — READ-ONLY. The evidence half of the skill-improvement
 * loop (`.claude/commands/skill-doctor.md` is the proposing half).
 *
 * Pulls every Codex review finding (the `chatgpt-codex-connector[bot]`
 * inline review comments) on PRs merged or closed in the last `--days`,
 * parses severity / path / cited AGENTS.md rule, and clusters findings that
 * RECUR across PRs. A finding class that hits two or more PRs is a rule the
 * repo is missing, or a rule it has and keeps breaking — the second kind is
 * flagged `rule exists but not followed`, and it is the more valuable
 * signal: the fix is sharpening or relocating the rule, not writing a new
 * one.
 *
 * No DB, no LLM, no secrets: the only external call is `gh api` (the
 * operator's own `gh auth` session; never a PAT in the environment or in
 * this file). Nothing here writes anywhere — the report goes to stdout.
 *
 *   node ops/agents/skill-doctor.js                  # last 14 days, markdown
 *   node ops/agents/skill-doctor.js --days 7 --json  # machine-readable
 *   node ops/agents/skill-doctor.js --repo wavespestcontrolfl/wavespestcontrol-astro
 *     (candidate homes are read from ../wavespestcontrol-astro when it exists,
 *      or from --root=<checkout>; with neither, "rule exists" is not checked)
 *   node ops/agents/skill-doctor.js --include-open   # also read open PRs
 *
 * The candidate-home heuristic mirrors `.claude/commands/lesson.md`'s
 * placement rules: a public-route finding belongs in
 * docs/public-route-contracts.md, a procedural finding in the matching
 * skill, a review-rule finding in AGENTS.md. It is a starting point for the
 * human/agent reading the report, not a verdict.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_REPO = 'wavespestcontrolfl/waves-customer-portal';
// Exact bot account — a human or service login that merely contains "codex"
// must never enter the evidence corpus (Codex r1).
const CODEX_LOGIN = /^chatgpt-codex-connector(\[bot\])?$/;
const SEVERITY_WEIGHT = { P0: 8, P1: 4, P2: 2, P3: 1 };
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const args = { days: 14, repo: DEFAULT_REPO, json: false, includeOpen: false, minPrs: 2, root: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--json') args.json = true;
    else if (a === '--include-open') args.includeOpen = true;
    else if (a === '--days') args.days = Number(next());
    else if (a.startsWith('--days=')) args.days = Number(a.slice(7));
    else if (a === '--repo') args.repo = next();
    else if (a.startsWith('--repo=')) args.repo = a.slice(7);
    else if (a === '--min-prs') args.minPrs = Number(next());
    else if (a.startsWith('--min-prs=')) args.minPrs = Number(a.slice(10));
    else if (a === '--root') args.root = next();
    else if (a.startsWith('--root=')) args.root = a.slice(7);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.days) || args.days < 1) throw new Error('--days must be a positive integer');
  if (!Number.isInteger(args.minPrs) || args.minPrs < 1) throw new Error('--min-prs must be a positive integer');
  if (!/^[\w.-]+\/[\w.-]+$/.test(args.repo)) throw new Error('--repo must be owner/name');
  if (args.root === undefined) args.root = defaultRootFor(args.repo);
  else if (!fs.existsSync(path.join(args.root, 'AGENTS.md'))) throw new Error(`--root has no AGENTS.md: ${args.root}`);
  return args;
}

// Candidate-home files are read from a checkout of the SELECTED repo, never
// from this one: with --repo astro the PRs and the cited AGENTS.md are
// Astro's, so "rule exists" must be judged against Astro's files (Codex r1
// P1). Without a checkout the check is skipped (root null → ruleExists
// null → the report says "not checked") rather than answered from the
// wrong repo.
function defaultRootFor(repo) {
  if (repo === DEFAULT_REPO) return REPO_ROOT;
  const sibling = path.resolve(REPO_ROOT, '..', repo.split('/')[1]);
  return fs.existsSync(path.join(sibling, 'AGENTS.md')) ? sibling : null;
}

// ---------------------------------------------------------------- gh

function gh(argv) {
  const res = spawnSync('gh', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`gh ${argv.slice(0, 3).join(' ')} failed: ${res.stderr.trim()}`);
  return res.stdout;
}

function listPrs({ repo, days, includeOpen }) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sinceDay = since.toISOString().slice(0, 10);
  const out = gh([
    'pr', 'list', '--repo', repo, '--state', 'all', '--limit', '1000',
    '--search', `updated:>=${sinceDay}`,
    '--json', 'number,title,state,mergedAt,closedAt,updatedAt,headRefOid',
  ]);
  const prs = JSON.parse(out);
  return prs.filter((pr) => {
    if (pr.state === 'OPEN') return includeOpen;
    const ended = pr.mergedAt || pr.closedAt;
    return ended && new Date(ended) >= since;
  });
}

function fetchCodexComments(repo, number) {
  // --slurp wraps every page in one outer array, so the pages are parsed as
  // JSON and flattened — never regex-rewritten as raw text, which would also
  // rewrite "][" inside a comment body (Codex r2).
  const out = gh(['api', `repos/${repo}/pulls/${number}/comments`, '--paginate', '--slurp']);
  const rows = out.trim() ? JSON.parse(out).flat() : [];
  return rows.filter((c) => c.user && CODEX_LOGIN.test(c.user.login));
}

// ---------------------------------------------------------------- parse

const BADGE_RE = /!\[(P[0-3]) Badge\]/;
const TITLE_RE = /<\/sub><\/sub>\s*(.+?)\*\*/s;
const AGENTS_CITE_RE = /AGENTS\.md:L(\d+)(?:-L(\d+))?/;
const SKILL_RE = /\bwaves-(billing|content|db|design|ib|llm|ship)\b|\bib-write-tools\b|\bpricing-config\b|\bui-verify\b/g;
const STOPWORDS = new Set(('a an the of to in on for and or with when before after into from by is are be as at ' +
  'this that it its not no never always every each any only also than then so if while until via per').split(' '));

function parseFinding(comment, pr) {
  const body = String(comment.body || '');
  const sevMatch = body.match(BADGE_RE);
  if (!sevMatch) return null; // wrapper / summary / non-finding comment
  const severity = sevMatch[1];
  const titleMatch = body.match(TITLE_RE);
  const title = (titleMatch ? titleMatch[1] : body.split('\n')[0]).replace(/\*+/g, '').trim();
  const cite = body.match(AGENTS_CITE_RE);
  const skills = new Set();
  let m;
  SKILL_RE.lastIndex = 0;
  while ((m = SKILL_RE.exec(body)) !== null) skills.add(m[0]);
  const text = body
    .replace(/<sub>.*?<\/sub><\/sub>/s, '')
    .replace(/Useful\? React with.*$/s, '')
    .replace(/AGENTS\.md reference:.*$/s, '')
    .trim();
  return {
    pr: pr.number,
    prTitle: pr.title,
    severity,
    title,
    text,
    path: comment.path || null,
    line: comment.line ?? comment.original_line ?? null,
    commit: comment.original_commit_id ? String(comment.original_commit_id).slice(0, 10) : null,
    agentsLines: cite ? [Number(cite[1]), Number(cite[2] || cite[1])] : null,
    skills: [...skills],
    url: comment.html_url || null,
  };
}

function normalizePhrase(title, words = 8) {
  return title
    .toLowerCase()
    // Inline-code identifiers are often the only term that separates two
    // classes ("Preserve \`email\`…" vs "Preserve \`status\`…") — keep
    // their text, drop only the backticks (Codex r3).
    .replace(/`([^`]*)`/g, ' $1 ')
    .replace(/[a-z0-9_./-]+:\d+(-\d+)?/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, words)
    .join(' ');
}

function keyTerms(title, max = 3) {
  return normalizePhrase(title, 12)
    .split(' ')
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, max);
}

// File grain, not directory grain: "server/services" recurring across 100
// PRs says nothing; "server/services/invoice.js across 9 PRs" names the
// module whose rules (or tests) are missing.
function topLevelPath(p) {
  return p || null;
}

// ---------------------------------------------------------------- AGENTS.md rule lookup

// Codex cites AGENTS.md line numbers at the PR's OWN head, and AGENTS.md is
// restructured often enough (#3715 moved every rule) that resolving those
// numbers against the local file mis-files findings under the wrong rule.
// So the rule title is resolved against AGENTS.md AT THE PR HEAD, fetched
// once per PR through gh and cached on disk by commit SHA (the file is
// immutable at a SHA, so the cache never goes stale).
const CACHE_DIR = path.join(os.tmpdir(), 'skill-doctor-agents-md');
function agentsMdAt(repo, sha, deps = {}) {
  if (!sha) return null;
  const cacheFile = path.join(CACHE_DIR, `${sha}.md`);
  try { return fs.readFileSync(cacheFile, 'utf8').split('\n'); } catch (_) { /* miss */ }
  let text = null;
  try {
    const out = (deps.gh || gh)(['api', `repos/${repo}/contents/AGENTS.md?ref=${sha}`, '--jq', '.content']);
    text = Buffer.from(out.replace(/\s/g, ''), 'base64').toString('utf8');
  } catch (_) {
    return null;
  }
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cacheFile, text); } catch (_) { /* cache is best-effort */ }
  return text.split('\n');
}

let agentsLinesCache = null;
function agentsMdLines(agentsPath = path.join(REPO_ROOT, 'AGENTS.md')) {
  if (agentsLinesCache) return agentsLinesCache;
  try {
    agentsLinesCache = fs.readFileSync(agentsPath, 'utf8').split('\n');
  } catch (_) {
    agentsLinesCache = [];
  }
  return agentsLinesCache;
}

// Resolves a cited line range to the bold title of the nearest preceding
// rule bullet. Codex cites line numbers at the PR's own AGENTS.md SHA; the
// local file may have drifted a few lines, which is why the title (not the
// number) is the cluster key.
// The CONTAINING bullet is resolved first (nearest preceding "- " at column
// 0, bounded by the section heading), then its title is read from the
// bullet's joined text: the leading bold span when there is one — bold
// titles wrap across lines in AGENTS.md, so a single-line regex missed them
// and fell through to the previous rule — else the bullet's first sentence,
// so plain (unbolded) rule bullets resolve too (Codex r4 P1).
function agentsRuleTitle(range, lines = agentsMdLines()) {
  if (!range || !lines.length) return null;
  const start = Math.min(range[0], lines.length) - 1;
  let bullet = -1;
  for (let i = start; i >= 0; i--) {
    if (/^- /.test(lines[i])) { bullet = i; break; }
    if (/^## /.test(lines[i])) return null;
  }
  if (bullet < 0) return null;
  const parts = [lines[bullet].slice(2)];
  for (let i = bullet + 1; i < lines.length && /^  \S/.test(lines[i]); i++) parts.push(lines[i].trim());
  const text = parts.join(' ').trim();
  const bold = text.match(/^\*\*(.+?)\*\*/);
  const title = bold ? bold[1] : (text.match(/^(.+?[.:;])(\s|$)/) || [null, text.slice(0, 80)])[1];
  return title.replace(/[.:;]$/, '').trim() || null;
}

// ---------------------------------------------------------------- candidate home

const HOME_FILES = {
  'docs/public-route-contracts.md': 'docs/public-route-contracts.md',
  'waves-db': '.claude/skills/waves-db/SKILL.md',
  'waves-billing': '.claude/skills/waves-billing/SKILL.md',
  'waves-llm': '.claude/skills/waves-llm/SKILL.md',
  'waves-design': '.claude/skills/waves-design/SKILL.md',
  'ui-verify': '.claude/skills/ui-verify/SKILL.md',
  'waves-ship': '.claude/skills/waves-ship/SKILL.md',
  'waves-content': '.claude/skills/waves-content/SKILL.md',
  'waves-ib': '.claude/skills/waves-ib/SKILL.md',
  'ib-write-tools': '.claude/skills/ib-write-tools/SKILL.md',
  'pricing-config': '.claude/skills/pricing-config/SKILL.md',
  'AGENTS.md': 'AGENTS.md',
};

const HOME_RULES = [
  { home: 'waves-ship', test: (f) => /\bcommit (message|title|history)\b|\bpr (body|title)\b/i.test(f.title + ' ' + f.text) },
  // The finding TEXT must speak to the public/unauthenticated contract — a
  // route filename containing "webhook" alone sends Stripe amount or
  // idempotency findings at the contracts doc instead of billing (Codex r4).
  { home: 'docs/public-route-contracts.md', test: (f) => /^server\/routes\//.test(f.path || '') && /\bpublic\b|\/:token|\btoken(ized|-gated)?\b|unauth|signature|verif(y|ication)|by design/i.test(f.text) },
  { home: 'waves-db', test: (f) => /\b(sql|knex|migration|backfill|transaction|savepoint|for update|timestamp|timezone)\b/i.test(f.text) || /migrations\//.test(f.path || '') },
  { home: 'waves-billing', test: (f) => /\b(stripe|invoice|surcharge|refund|payment|autopay|deposit|prepay|charge)\b/i.test(f.text + ' ' + (f.path || '')) },
  { home: 'waves-llm', test: (f) => /\b(anthropic|openai|gemini|model|llm|prompt|max_tokens|fallback provider)\b/i.test(f.text + ' ' + (f.path || '')) || /services\/llm\//.test(f.path || '') },
  { home: 'pricing-config', test: (f) => /pricing-engine|pricing_config|\bbracket\b/i.test(f.text + ' ' + (f.path || '')) },
  { home: 'ib-write-tools', test: (f) => /intelligence-bar\/.*-tools\.js/.test(f.path || '') && /\b(write|send|create|update|schedule|confirm)\b/i.test(f.text) },
  { home: 'waves-ib', test: (f) => /intelligence-bar/.test(f.path || '') },
  { home: 'waves-content', test: (f) => /\b(blog|content|seo|spoke|hub|guardrail|newsletter)\b/i.test(f.text + ' ' + (f.path || '')) || /services\/content\//.test(f.path || '') },
  { home: 'ui-verify', test: (f) => /\.(jsx|tsx)$/.test(f.path || '') && /\b(screenshot|render|mobile|viewport|visual)\b/i.test(f.text) },
  { home: 'waves-design', test: (f) => /^client\/src\//.test(f.path || '') && /\b(style|palette|tailwind|font|color|button|layout|token)\b/i.test(f.text) },
  { home: 'waves-ship', test: (f) => /\b(push|pull request|codex|worktree|merge|deploy|railway|ci|rebase|commit)\b/i.test(f.text) || /^(\.github|scripts\/hooks)\//.test(f.path || '') },
];

function candidateHome(finding) {
  if (finding.skills.length) return finding.skills[0];
  for (const rule of HOME_RULES) if (rule.test(finding)) return rule.home;
  return 'AGENTS.md';
}

const homeTextCache = new Map();
function homeText(home, root = REPO_ROOT) {
  const rel = HOME_FILES[home] || HOME_FILES['AGENTS.md'];
  const key = `${root}:${rel}`;
  if (!homeTextCache.has(key)) {
    try { homeTextCache.set(key, fs.readFileSync(path.join(root, rel), 'utf8').toLowerCase()); } catch (_) { homeTextCache.set(key, ''); }
  }
  return homeTextCache.get(key);
}

// The terms a cluster is looked up by. A phrase cluster's label IS the
// finding phrase; a path cluster's label is a pathname whose tokens
// ("server", "services", "content") match any skill that describes its own
// scope, so path clusters use the most frequent terms across their finding
// TITLES instead (Codex r3).
function clusterTerms(cluster, max = 4) {
  if (cluster.kind !== 'path') return keyTerms(cluster.label, max);
  const freq = new Map();
  for (const f of cluster.findings) for (const t of new Set(keyTerms(f.title, 6))) freq.set(t, (freq.get(t) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([t]) => t);
}

// "Rule exists" = the home file already carries at least two of the
// cluster's key terms (or the cluster IS a cited AGENTS.md rule). A term
// hit is not proof the rule covers this exact class — it is the prompt to
// go read that rule before writing a new one.
// null = not checked (no local checkout of the selected repo).
function ruleExists(cluster, root = REPO_ROOT) {
  if (cluster.kind === 'rule') return true;
  if (!root) return null;
  const text = homeText(cluster.home, root);
  if (!text) return false;
  const terms = clusterTerms(cluster, 4);
  const hits = terms.filter((t) => text.includes(t));
  return terms.length > 0 && hits.length >= Math.min(2, terms.length);
}

// ---------------------------------------------------------------- clustering

function clusterFindings(findings, { minPrs = 2, root = REPO_ROOT, agentsLines } = {}) {
  const buckets = new Map();
  const add = (kind, label, f) => {
    if (!label) return;
    const key = `${kind}:${label}`;
    if (!buckets.has(key)) buckets.set(key, { kind, label, findings: [] });
    buckets.get(key).findings.push(f);
  };
  for (const f of findings) {
    const rule = f.agentsRule !== undefined ? f.agentsRule : agentsRuleTitle(f.agentsLines, agentsLines);
    add('rule', rule, f);
    add('path', topLevelPath(f.path), f);
    // A finding that cites a rule is evidence for THAT rule; it must not also
    // surface as an "uncited" phrase class (Codex r1) — and a citation whose
    // rule could not be resolved (head AGENTS.md unfetchable) is still a
    // citation, not a missing rule (Codex r3).
    if (!rule && !f.agentsLines) add('phrase', normalizePhrase(f.title), f);
  }
  const clusters = [];
  for (const b of buckets.values()) {
    const prs = [...new Set(b.findings.map((f) => f.pr))].sort((a, c) => a - c);
    if (prs.length < minPrs) continue;
    const worst = b.findings.map((f) => f.severity).sort()[0];
    // Recurrence is defined across PRs, so score and home are computed from
    // ONE representative per PR — a class repeated over twenty rounds of one
    // noisy PR must not outrank (or out-vote) a class found once in each of
    // ten PRs (Codex r3). Representative = the PR's worst finding.
    const perPr = new Map();
    for (const f of b.findings) {
      const cur = perPr.get(f.pr);
      if (!cur || (SEVERITY_WEIGHT[f.severity] || 1) > (SEVERITY_WEIGHT[cur.severity] || 1)) perPr.set(f.pr, f);
    }
    const score = [...perPr.values()].reduce((s, f) => s + (SEVERITY_WEIGHT[f.severity] || 1), 0);
    const homeVotes = new Map();
    for (const f of perPr.values()) {
      const h = b.kind === 'rule' ? 'AGENTS.md' : candidateHome(f);
      homeVotes.set(h, (homeVotes.get(h) || 0) + 1);
    }
    const home = [...homeVotes.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
    const cluster = { kind: b.kind, label: b.label, prs, count: b.findings.length, score, worst, home, findings: b.findings };
    cluster.ruleExists = ruleExists(cluster, root);
    clusters.push(cluster);
  }
  clusters.sort((a, b) => b.score - a.score || b.count - a.count || a.label.localeCompare(b.label));
  return clusters;
}

// Report order: cited AGENTS.md rules that keep being broken (a rule exists
// and is not followed — sharpen it or turn it into a scanner), then finding
// phrases that recur with no cited rule (a rule is missing), then the files
// that keep drawing findings (a module wants a contract test). Each section
// is capped so the report stays readable; --json carries everything.
const SECTIONS = [
  { kind: 'rule', title: 'Cited rules that keep being broken', limit: 10 },
  { kind: 'phrase', title: 'Recurring finding classes with no cited rule', limit: 15 },
  { kind: 'path', title: 'Files that keep drawing findings', limit: 10 },
];

// ---------------------------------------------------------------- report

function renderMarkdown({ repo, days, prs, findings, clusters }) {
  const lines = [];
  lines.push(`# skill-doctor — ${repo}, last ${days} days`);
  lines.push('');
  lines.push(`PRs read: ${prs.length} · Codex findings: ${findings.length} · recurring clusters: ${clusters.length}`);
  const bySev = findings.reduce((m, f) => { m[f.severity] = (m[f.severity] || 0) + 1; return m; }, {});
  lines.push(`Severity mix: ${['P0', 'P1', 'P2', 'P3'].map((s) => `${s}=${bySev[s] || 0}`).join(' ')}`);
  lines.push('');
  if (!clusters.length) {
    lines.push('No finding class recurred across two or more PRs in this window.');
    return lines.join('\n');
  }
  const MAX_EXAMPLES = 8;
  for (const section of SECTIONS) {
    const rows = clusters.filter((c) => c.kind === section.kind).slice(0, section.limit);
    if (!rows.length) continue;
    lines.push(`## ${section.title}`);
    lines.push('');
    rows.forEach((c, i) => {
      const flag = c.kind === 'rule' ? ''
        : c.ruleExists === null ? ' — not checked (no local checkout of this repo; pass --root)'
          : c.ruleExists ? ' — **rule exists but not followed**' : ' — no rule found in candidate home';
      const prList = c.prs.length > 12 ? `${c.prs.slice(0, 12).map((n) => `#${n}`).join(', ')} … (${c.prs.length} PRs)` : c.prs.map((n) => `#${n}`).join(', ');
      lines.push(`### ${i + 1}. ${c.label}`);
      lines.push(`score ${c.score} · ${c.count} findings across ${prList} · worst ${c.worst}`);
      lines.push(`candidate home: \`${HOME_FILES[c.home] || c.home}\`${flag}`);
      lines.push('');
      // Worst first, one example per PR, so the reader sees the class, not
      // one PR's 30-round history.
      const seenPr = new Set();
      const examples = [...c.findings]
        .sort((a, b) => (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0))
        .filter((f) => (seenPr.has(f.pr) ? false : seenPr.add(f.pr)))
        .slice(0, MAX_EXAMPLES);
      for (const f of examples) {
        const where = f.path ? `\`${f.path}${f.line ? `:${f.line}` : ''}\`` : '(no path)';
        lines.push(`- #${f.pr} ${f.severity} ${where} — ${f.title}${f.url ? ` ([link](${f.url}))` : ''}`);
      }
      lines.push('');
    });
  }
  lines.push('---');
  lines.push('Next: `/skill-doctor` turns the top clusters into rule diffs (lesson.md placement rules). Read the candidate home first — a flagged "rule exists" cluster wants a sharper rule or a scanner, not a duplicate.');
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

function run(args, deps = {}) {
  const list = deps.listPrs || listPrs;
  const fetch = deps.fetchCodexComments || fetchCodexComments;
  const prs = list(args);
  const findings = [];
  // AGENTS.md at the commit EACH COMMENT reviewed (original_commit_id) —
  // AGENTS.md can change between rounds of one PR, so the final head would
  // mis-file an older round's citation. Memoized per SHA for this run
  // (agentsMdAt also caches on disk by SHA).
  const linesAt = new Map();
  const agentsLinesFor = (sha) => {
    if (!linesAt.has(sha)) linesAt.set(sha, (deps.agentsMdAt || agentsMdAt)(args.repo, sha));
    return linesAt.get(sha);
  };
  for (const pr of prs) {
    for (const c of fetch(args.repo, pr.number)) {
      // Bot comments only, re-checked here so an injected fetcher (tests,
      // a cached dump) cannot smuggle human comments into the corpus.
      if (!c.user || !CODEX_LOGIN.test(c.user.login)) continue;
      const f = parseFinding(c, pr);
      if (!f) continue;
      if (f.agentsLines) {
        // Review-commit AGENTS.md only. When it cannot be fetched the citation
        // stays unresolved (null) — resolving against the CURRENT local file
        // is exactly the mis-filing this lookup exists to avoid (Codex r1).
        const lines = agentsLinesFor(c.original_commit_id || pr.headRefOid);
        f.agentsRule = lines ? agentsRuleTitle(f.agentsLines, lines) : null;
      }
      findings.push(f);
    }
  }
  const clusters = clusterFindings(findings, { minPrs: args.minPrs, root: args.root === undefined ? REPO_ROOT : args.root });
  return { repo: args.repo, days: args.days, prs, findings, clusters };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    console.log('usage: skill-doctor.js [--days N] [--repo owner/name] [--root <checkout of --repo>] [--min-prs N] [--include-open] [--json]');
    return;
  }
  const result = run(args);
  if (args.json) {
    const { findings, ...rest } = result;
    console.log(JSON.stringify({ ...rest, findings, clusters: result.clusters.map((c) => ({ ...c, findings: c.findings.map((f) => f.url || `${f.pr}:${f.path}:${f.line}`) })) }, null, 2));
  } else {
    console.log(renderMarkdown(result));
  }
}

if (require.main === module) main();

module.exports = {
  run,
  _internals: {
    parseArgs, parseFinding, normalizePhrase, keyTerms, clusterTerms, topLevelPath, agentsRuleTitle, defaultRootFor,
    candidateHome, ruleExists, clusterFindings, renderMarkdown, SEVERITY_WEIGHT, HOME_FILES, SECTIONS, agentsMdAt,
  },
};
