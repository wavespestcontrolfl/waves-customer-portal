/**
 * Source guard: every "recent messages" read of sms_log must exclude
 * unresolved send reservations, or be explicitly allowlisted with a reason.
 *
 * Codex #4331 P2 stack — six rounds each found ANOTHER general reader
 * (conversation history, outbound counts, composer/estimator/LLM context)
 * that loaded sms_log without excludeUnresolvedSendReservations
 * (server/services/messaging/review-ask-reservation.js) and so could
 * present an in-flight review-ask or reply reservation (a synthetic
 * 'sending' row) to a human or model as a message that was actually
 * delivered. This guard is the structural stop for that class: every site
 * this scan finds is either wired through the shared helper, or is in
 * ALLOWLIST with a reason the exclusion genuinely does not apply there
 * (already scoped to a status/direction the reservation marker can never
 * match, or not a live reader at all).
 *
 * Detection is deliberately narrow and mechanical (filesystem only, no DB):
 * a `db('sms_log')` / `knex('sms_log')` / `trx('sms_log')` / `conn('sms_log')`
 * table reference whose surrounding ~15 lines also chain BOTH `.orderBy(`
 * and `.limit(` — the "give me the latest N messages" shape every fix on
 * this stack has been. A narrower query (a single row by id, a bare
 * `.count()`) isn't this shape and won't be flagged; if one becomes a list
 * read later, this guard starts seeing it. A site is compliant when
 * `excludeUnresolvedSendReservations(` appears in that same window —
 * anywhere else, ALLOWLIST is the only way through, and a stale or
 * newly-unmatched entry fails its own check below.
 */

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', 'migrations', '__tests__', 'coverage', 'dist']);
const HELPER_MARKER = 'excludeUnresolvedSendReservations(';
const WINDOW_SPAN = 15;

// Explicit exemptions. Each entry names the exact file + line the scan
// reports and why the exclusion genuinely does not apply. Default is ZERO —
// every OTHER unwrapped site fails.
const ALLOWLIST = [
  {
    file: 'routes/twilio-webhook.js',
    line: 1677,
    reason: 'inbound-only (where from_phone = the opting-out customer\'s own number) — every send reservation (review-ask or reply) is Waves\' own outbound row, so its from_phone can never match a customer\'s number here.',
  },
  {
    file: 'scripts/backfill-comms-pr2.js',
    line: 79,
    reason: 'one-off historical backfill script (ops tooling, run manually once, idempotent on re-run) — not a live reader feeding a human or a model.',
  },
  {
    file: 'scripts/backfill-comms-pr2.js',
    line: 88,
    reason: 'same one-off historical backfill script as line 79 (the paged batch read).',
  },
  {
    file: 'services/completion-comms-guard.js',
    line: 191,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
  {
    file: 'services/completion-comms-guard.js',
    line: 199,
    reason: 'filtered to CONFIRMED_OUTBOUND_STATUS, which excludes \'sending\' — an unresolved reservation cannot match this status filter.',
  },
  {
    file: 'services/customer-intelligence/signal-detector.js',
    line: 65,
    reason: 'inbound-only count (direction: \'inbound\') — a send reservation is always an outbound row; the outbound-count query a few lines below already uses the helper.',
  },
  {
    file: 'services/customer-intelligence/signal-detector.js',
    line: 74,
    reason: 'inbound-only message read (direction: \'inbound\') feeding sentiment mining — a send reservation is always an outbound row.',
  },
  {
    file: 'services/recipient-optin.js',
    line: 476,
    reason: 'single-row lookup (.first(\'status\')) — not a list read; the .limit( this scan\'s window sees belongs to the enclosing, unrelated recipient_optin sweep query above it.',
  },
  {
    file: 'services/messaging/deferred-replay-registry.js',
    line: 1319,
    reason: 'whereIn(status, [blocked, failed, cancelled]) excludes \'sending\' — an unresolved reservation cannot match this status filter.',
  },
  {
    file: 'services/messaging/sync-optout.js',
    line: 65,
    reason: 'from_phone = the opting-out customer\'s own number — every send reservation is Waves\' own outbound row and can never match a customer\'s from_phone.',
  },
  {
    file: 'services/outbound-call-reason.js',
    line: 146,
    reason: 'inbound-only (direction: \'inbound\') — a send reservation is always an outbound row.',
  },
];

function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

// A bare table-call — db/knex/trx/conn/database('sms_log') or '...as alias'.
const TABLE_CALL = /\b(?:db|knex|trx|conn|database)\(\s*(['"`])sms_log(?:\s+as\s+\w+)?\1/;

let cachedCandidates = null;
function findCandidates() {
  if (cachedCandidates) return cachedCandidates;
  const candidates = [];
  for (const abs of walk(SERVER_ROOT)) {
    const rel = path.relative(SERVER_ROOT, abs).split(path.sep).join('/');
    if (rel === 'services/messaging/review-ask-reservation.js') continue; // the definition itself
    const src = fs.readFileSync(abs, 'utf8');
    if (!src.includes('sms_log')) continue;
    const lines = stripComments(src).split('\n');
    lines.forEach((line, idx) => {
      if (!TABLE_CALL.test(line)) return;
      // A few lines BACKWARD too: `excludeUnresolvedSendReservations(` often
      // opens on its own line just before a multi-line `.where(...)` filter
      // forces the table call onto the next one.
      const start = Math.max(0, idx - 3);
      const window = lines.slice(start, Math.min(lines.length, idx + WINDOW_SPAN)).join('\n');
      if (!/\.orderBy\(/.test(window) || !/\.limit\(/.test(window)) return;
      candidates.push({
        file: rel,
        line: idx + 1,
        snippet: line.trim(),
        compliant: window.includes(HELPER_MARKER),
      });
    });
  }
  cachedCandidates = candidates;
  return candidates;
}

function isAllowed(c) {
  return ALLOWLIST.some((a) => a.file === c.file && a.line === c.line);
}

describe('sms_log general-reader source guard (codex #4331)', () => {
  test('the shared exclusion helper still exports what this guard requires', () => {
    const reservation = require('../services/messaging/review-ask-reservation');
    expect(typeof reservation.excludeUnresolvedSendReservations).toBe('function');
  });

  test('finds the known reader shape (self-check on a synthetic fixture)', () => {
    // Guards against a regex/window regression silently turning this guard
    // into a no-op that always passes.
    const fixtureCompliant = "const rows = await excludeUnresolvedSendReservations(db('sms_log').where({ customer_id: id }))\n  .orderBy('created_at', 'desc')\n  .limit(5);";
    const fixtureRaw = "const rows = await db('sms_log').where({ customer_id: id })\n  .orderBy('created_at', 'desc')\n  .limit(5);";
    const scan = (src) => {
      const lines = src.split('\n');
      const idx = lines.findIndex((l) => TABLE_CALL.test(l));
      const window = lines.slice(idx, idx + WINDOW_SPAN).join('\n');
      return { found: idx >= 0, compliant: window.includes(HELPER_MARKER) };
    };
    expect(scan(fixtureCompliant)).toEqual({ found: true, compliant: true });
    expect(scan(fixtureRaw)).toEqual({ found: true, compliant: false });
  });

  test('every "latest N messages" sms_log read either uses the shared helper or is explicitly allowlisted', () => {
    const candidates = findCandidates();
    const violations = candidates.filter((c) => !c.compliant && !isAllowed(c));
    const message = violations
      .map((v) => `  server/${v.file}:${v.line}  ${v.snippet}`)
      .join('\n');
    if (violations.length) {
      throw new Error(
        `Unwrapped sms_log "latest N messages" read(s) found — an unresolved send reservation ` +
        `('sending', a synthetic placeholder) can be presented as a delivered message.\n` +
        `Wrap the query in excludeUnresolvedSendReservations(...) from ` +
        `server/services/messaging/review-ask-reservation.js BEFORE .orderBy()/.limit(), ` +
        `or add the site to ALLOWLIST in this test with a one-line reason the exclusion ` +
        `genuinely does not apply (e.g. already direction/status-scoped so a reservation ` +
        `structurally cannot match, or not a live reader).\n` +
        `Offending site(s):\n${message}\n` +
        `(Codex #4331 — this exact class of gap has recurred across six review rounds on this stack.)`,
      );
    }
    expect(violations).toEqual([]);
  });

  test('every ALLOWLIST entry still matches a real (still-unwrapped) candidate — no stale entries', () => {
    const candidates = findCandidates();
    for (const entry of ALLOWLIST) {
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(10);
      const hit = candidates.find((c) => c.file === entry.file && c.line === entry.line);
      if (!hit) {
        throw new Error(`ALLOWLIST entry server/${entry.file}:${entry.line} no longer matches any candidate site — remove it.`);
      }
      if (hit.compliant) {
        throw new Error(`ALLOWLIST entry server/${entry.file}:${entry.line} now uses the shared helper directly — remove the now-redundant entry.`);
      }
    }
  });
});
