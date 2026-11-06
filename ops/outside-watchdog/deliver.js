#!/usr/bin/env node
/**
 * Outside watchdog: one run of the MacBook Air job (launchd com.waves.portal-watchdog,
 * every 10 min; runbook: ops/outside-watchdog/README.md). READ-ONLY on the portal:
 * its only writes are its own alert rows (POST /api/ops/digest) and internal emails.
 *
 * A run polls the portal once from outside with the Hermes poll script
 * (docs/hermes/watchdog_poll.py --json) and turns what it sees into a few writes:
 *   - down: 3 failed polls in a row (about 30 min), or the database degraded. A down
 *     portal cannot take a row, so this alert usually goes out as an email to the ops
 *     inbox. When the portal answers again: a closing email (only when the alert went by
 *     email) and one Claude fault row per outage, to find the cause.
 *   - runner: the job runner stopped (the scheduler heartbeat is stale, the cron gate is
 *     off, or the heartbeat cannot be read), on 2 good polls in a row. A Claude fault
 *     row; it closes itself on the first poll that no longer sees it.
 *   - setup: the portal refuses the poll (signature, key, lane off), so the watchdog is
 *     blind. A row that closes on the next good poll.
 * The snapshot's other reasons (one failing job, an ops-queue lane, the link worker) stay
 * with the portal's own checks. Those run inside a portal that answers; the runner check
 * covers the case where they cannot run at all.
 *
 * Each write is a row first: an engineering FIX row (Agents → Activity and the Claude
 * fault launcher, never the owner's bell). When the row cannot be written, the write goes
 * out as an email through ~/waves-ops/heartbeat/send-email.js (internal inbox only). A
 * write that fails both ways stays in the outbox and is retried on the next run, for up
 * to 48 hours. The row words follow docs/admin-notifications.md (a test runs each one
 * through composeAdminAlert).
 *
 * Runs under `railway run --service waves-customer-portal`: the poll secret, the ingest
 * token and the SMTP password come from the portal's env. It never prints a secret, and
 * the snapshot it reads carries counts, job names and state words only.
 *
 * Exit: 0 done; 1 a write is still owed (retried next run); 2 local error (the poll did
 * not run or printed no report, or the state file cannot be written).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_PORTAL_URL = 'https://portal.wavespestcontrol.com';
const OPS_INBOX = 'contact@wavespestcontrol.com';
const CHECK_ID = 'outside-watchdog';
const QUEUE_LINK = '/admin/agents?tab=queue';
const KEYS = { down: 'outside-watchdog-down', runner: 'outside-watchdog-runner', setup: 'outside-watchdog-setup' };
const OUTAGE_KEY_PREFIX = 'outside-watchdog-outage';
// watchdog_poll.py pages an outage at this many failed polls in a row.
const PAGE_AFTER_FAILURES = 3;
// A runner reason must show on this many good polls in a row before a row opens, so a
// single dropped scheduler tick (node-cron under load) clears before it alerts.
const RUNNER_CONFIRM_POLLS = 2;
const RUNNER_REASONS = ['scheduler:unavailable', 'scheduler:disabled', 'scheduler:silent'];
const DEFAULT_SILENT_AFTER_MINUTES = 60;
// An owed write older than this is dropped (logged): the run log has shown it ~288 times.
// A dropped clear can leave its row standing; the next alert for that key retires it
// first (`replace`), and an outage row is meant to stand until someone closes it.
const OWED_MAX_MS = 48 * 60 * 60 * 1000;
const POLL_TIMEOUT_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 20 * 1000;
const EMAIL_TIMEOUT_MS = 60 * 1000;
const SIGNATURE = 'Sent by the outside watchdog on the MacBook Air (launchd com.waves.portal-watchdog, every 10 min).';

function settings(env = process.env) {
  const home = env.HOME || '';
  const dir = env.OUTSIDE_WATCHDOG_DIR || path.join(home, 'waves-ops', 'portal-watchdog');
  return {
    dir,
    portalUrl: String(env.OUTSIDE_WATCHDOG_PORTAL_URL || DEFAULT_PORTAL_URL).replace(/\/+$/, ''),
    python: env.OUTSIDE_WATCHDOG_PYTHON || 'python3',
    pollScript: env.OUTSIDE_WATCHDOG_POLL_SCRIPT || path.join(dir, 'watchdog_poll.py'),
    pollState: path.join(dir, 'poll-state.json'),
    deliverState: path.join(dir, 'deliver-state.json'),
    emailScript: env.OUTSIDE_WATCHDOG_EMAIL_SCRIPT || path.join(home, 'waves-ops', 'heartbeat', 'send-email.js'),
    ingestToken: env.OPS_DIGEST_INGEST_TOKEN || '',
  };
}

// ---------------------------------------------------------------------------
// Words. Every headline and why passes composeAdminAlert (the test checks).
// ---------------------------------------------------------------------------

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function etTime(iso) {
  const at = new Date(iso);
  if (!iso || !Number.isFinite(at.getTime())) return 'an unknown time';
  return ET.format(at).replace(/\s+/g, ' ');
}

const minutesBetween = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000));

// A compose spec plus the rendered parts a row and an email need.
function alertParts(spec, { emailSubject, body }) {
  return {
    spec,
    headline: `${spec.area} — ${spec.action}`,
    summary: spec.why,
    emailSubject,
    body: [...body, '', SIGNATURE].join('\n'),
  };
}

const faultSpec = (action, why, doneWhen) => ({
  area: 'System', action, why, severity: 'broken', link: QUEUE_LINK,
  subject: { type: 'check', id: CHECK_ID }, doneWhen, who: 'claude',
});

function downAlert({ since, failures, detail, portalUrl }) {
  return alertParts(
    faultSpec('check why the portal is down or degraded', `The outside watchdog failed ${failures} polls in a row since ${etTime(since)}.`, 'portal_answering'),
    {
      emailSubject: 'FIX: Waves portal down or degraded (outside watchdog)',
      body: [
        `The outside watchdog on the MacBook Air got no healthy answer from the portal on ${failures} polls in a row, since ${etTime(since)} ET.`,
        `Last poll: ${detail}.`,
        `Check Railway: the portal service and Postgres (status, deploys, logs), then ${portalUrl}/api/health.`,
        'When the portal answers again, this alert closes and a new alert asks Claude to find the cause.',
      ],
    },
  );
}

function outageAlert({ since, until, failures }) {
  return alertParts(
    faultSpec('find why the portal was down', `It was down or degraded from ${etTime(since)} to ${etTime(until)}.`, 'cause_found'),
    {
      emailSubject: 'FIX: find why the Waves portal was down (outside watchdog)',
      body: [
        `The outside watchdog on the MacBook Air saw the portal down or degraded from ${etTime(since)} to ${etTime(until)} ET (about ${minutesBetween(since, until)} min, ${failures} failed polls in a row).`,
        'Find the cause: the Railway deploy history and the logs of the portal service and Postgres around that time.',
        'Report the cause to the owner. Ask the owner before a restart, a rollback or a variable change.',
        'This alert does not close by itself.',
      ],
    },
  );
}

function runnerAlert(reason, scheduler) {
  const sched = scheduler && typeof scheduler === 'object' ? scheduler : {};
  const age = Number.isFinite(sched.age_minutes) ? sched.age_minutes : null;
  const limit = Number.isFinite(sched.silent_after_minutes) ? sched.silent_after_minutes : DEFAULT_SILENT_AFTER_MINUTES;
  if (reason === 'scheduler:disabled') {
    return alertParts(
      faultSpec('check why portal crons are off', 'The cron gate is off on the portal, so no scheduled job runs.', 'crons_enabled'),
      {
        emailSubject: 'FIX: Waves portal crons are off (outside watchdog)',
        body: [
          'The portal answers the outside watchdog, but its cron gate (GATE_CRON_JOBS) is off.',
          'No scheduled job runs while it is off, and the portal cannot raise its own alerts either.',
          'Find out who turned it off and why (Railway → Variables, the deploy history). If it was turned off on purpose, leave it and tell the owner.',
          'This alert closes itself on the first poll that sees crons on and the heartbeat fresh.',
        ],
      },
    );
  }
  if (reason === 'scheduler:unavailable') {
    return alertParts(
      faultSpec('check the scheduler heartbeat read', `The portal could not read its scheduler heartbeat on ${RUNNER_CONFIRM_POLLS} polls in a row.`, 'heartbeat_readable'),
      {
        emailSubject: 'FIX: the Waves portal cannot read its scheduler heartbeat (outside watchdog)',
        body: [
          `The portal answers the outside watchdog, but it could not read its scheduler heartbeat (the hermes-watchdog-liveness row in job_health) on ${RUNNER_CONFIRM_POLLS} polls in a row.`,
          'Until it can, the outside watchdog cannot tell whether scheduled jobs run.',
          'Check the portal logs for "[agent-watchdog] scheduler read failed" and the database.',
          'This alert closes itself on the first poll that reads the heartbeat.',
        ],
      },
    );
  }
  return alertParts(
    faultSpec(
      'find why portal crons stopped',
      age === null ? 'The scheduler heartbeat has never ticked, so no scheduled job runs.' : `No scheduler tick for ${age} min, so no scheduled job runs.`,
      'crons_ticking',
    ),
    {
      emailSubject: 'FIX: Waves portal crons stopped (outside watchdog)',
      body: [
        `The portal answers the outside watchdog, but its scheduler heartbeat (the hermes-watchdog-liveness job, every 23 min) ${age === null ? 'has never ticked' : `last ticked ${age} min ago`} (the limit is ${limit} min), on ${RUNNER_CONFIRM_POLLS} polls in a row.`,
        'So the job runner has stopped: no scheduled job runs, and the portal cannot raise its own alerts either.',
        "Check the Railway logs of the portal service: scheduler errors, an event-loop stall, or repeated boots. The Agents → Queue tab shows each job's last run.",
        'Report the cause to the owner. Ask the owner before a restart.',
        'This alert closes itself on the first poll that sees the heartbeat fresh.',
      ],
    },
  );
}

const SETUP_WHY = {
  401: 'The portal rejected the watchdog signature, so the outside check sees nothing.',
  403: 'The portal refused the watchdog key, so the outside check sees nothing.',
  404: 'The watchdog lane is off on the portal, so the outside check sees nothing.',
  503: 'The portal has no watchdog key set, so the outside check sees nothing.',
};
const SETUP_FIX = {
  401: "The poll signs with LINK_WORKER_SECRET_HERMES_WATCHDOG from the portal's own env (railway run), so check the Air's clock (the portal allows 5 min of skew) and the hermes_watchdog key record (server/middleware/link-worker-auth.js).",
  403: "Check GATE_HERMES_WORKER (Railway → Variables) and the hermes_watchdog key's endpoints (server/middleware/link-worker-auth.js).",
  404: 'GATE_HERMES_WATCHDOG is off. Turn it back on, or stop the Air job: launchctl bootout gui/$(id -u)/com.waves.portal-watchdog (ops/outside-watchdog/README.md).',
  503: 'Set LINK_WORKER_SECRET_HERMES_WATCHDOG on the portal service (Railway → Variables).',
};

function setupAlert(detail) {
  const code = (/^HTTP (\d{3})\b/.exec(String(detail || '')) || [])[1];
  return alertParts(
    faultSpec('fix the outside watchdog setup', SETUP_WHY[code] || 'The portal refused the watchdog poll, so the outside check sees nothing.', 'watchdog_polling'),
    {
      emailSubject: 'FIX: the Waves portal refuses the outside watchdog poll',
      body: [
        `The portal refused the outside watchdog's poll: ${detail}.`,
        ...(SETUP_FIX[code] ? [SETUP_FIX[code]] : []),
        'While this stands, nothing outside the portal watches it or its job runner.',
        'This alert closes itself on the first good poll.',
      ],
    },
  );
}

// The closing email for an alert that went out by email (a row closes on its own).
function clearedEmail(slot, { since, until } = {}) {
  if (slot === 'down') {
    return {
      subject: 'Waves portal answering again (outside watchdog)',
      body: [
        `The portal answers the outside watchdog again. It was down or degraded from ${etTime(since)} to ${etTime(until)} ET.`,
        'A separate alert asks Claude to find the cause.',
        '', SIGNATURE,
      ].join('\n'),
    };
  }
  if (slot === 'runner') {
    return {
      subject: 'Waves portal crons running again (outside watchdog)',
      body: ["The outside watchdog sees the portal's crons on and its scheduler heartbeat fresh again, so scheduled jobs run. This closes the earlier email.", '', SIGNATURE].join('\n'),
    };
  }
  return {
    subject: 'Outside watchdog poll working again',
    body: ["The portal answers the outside watchdog's poll again. This closes the earlier email.", '', SIGNATURE].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// State: what is announced (slots) and what is still owed (outbox).
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    v: 1,
    down: { open: false, since: null, failures: 0, via: null, alertId: null },
    runner: { seen: null, polls: 0, open: null, via: null, alertId: null },
    setup: { open: false, detail: null, via: null, alertId: null },
    outbox: [],
  };
}

const isMail = (m) => !!m && typeof m.subject === 'string' && typeof m.body === 'string';
// An outbox item a run can flush; anything else in a hand-edited or old file is dropped.
function wellFormed(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.key !== 'string' || typeof item.at !== 'string') return false;
  if (item.kind === 'alert') return !!item.row && typeof item.row === 'object' && isMail(item.email);
  if (item.kind === 'clear') return item.via !== 'email' || isMail(item.email);
  return false;
}

const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// launchd never starts a second run of the job while one runs, so this file has one writer.
function loadState(file, notes) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') notes.push(`state unreadable (${err.code}), starting fresh`);
    return defaultState();
  }
  try {
    const parsed = JSON.parse(raw);
    const base = defaultState();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return {
      v: 1,
      down: { ...base.down, ...plainObject(parsed.down) },
      runner: { ...base.runner, ...plainObject(parsed.runner) },
      setup: { ...base.setup, ...plainObject(parsed.setup) },
      outbox: Array.isArray(parsed.outbox) ? parsed.outbox.filter(wellFormed) : [],
    };
  } catch {
    notes.push('state file corrupt, starting fresh');
    return defaultState();
  }
}

function saveState(file, state) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const safeKey = (raw) => String(raw).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 120);

function rowFor(key, parts, observedAt) {
  return {
    key,
    kind: 'FIX',
    subject: parts.emailSubject.replace(/^FIX:\s*/, ''),
    body: parts.body,
    headline: parts.headline,
    summary: parts.summary,
    audience: 'engineering',
    link: parts.spec.link,
    metadata: {
      area: parts.spec.area, severity: parts.spec.severity, who: parts.spec.who, doneWhen: parts.spec.doneWhen,
      check: { id: CHECK_ID }, via: 'outside-watchdog',
    },
    observedAt,
  };
}

// Queue an alert. `slot` ties it to a slot (its delivery sets the slot's `via`);
// `replace` retires the key's standing row first, so one row stands per key.
function enqueueAlert(state, { slot = null, key, parts, at, replace }) {
  const id = `${slot || 'alert'}:${key}:${at}`;
  if (slot) {
    // A newer alert for the slot supersedes one still owed.
    state.outbox = state.outbox.filter((i) => !(i.kind === 'alert' && i.slot === slot));
    state[slot].alertId = id;
    state[slot].via = null;
  }
  state.outbox.push({
    id, kind: 'alert', slot, key, at, replace: !!replace, tries: 0,
    row: rowFor(key, parts, at),
    email: { subject: parts.emailSubject, body: parts.body },
  });
}

// Close a slot. An alert still owed is dropped, but its row is retired all the same:
// a POST that timed out may have landed while its email failed, so an owed alert does
// not prove that no row stands. Only an alert that went out by email (via 'email')
// gets a closing email.
function enqueueClear(state, { slot, key, at, email }) {
  state.outbox = state.outbox.filter((i) => !(i.kind === 'alert' && i.slot === slot));
  const { via } = state[slot];
  state[slot].alertId = null;
  state[slot].via = null;
  state.outbox.push({
    id: `clear:${key}:${at}`, kind: 'clear', slot, key, at, via, tries: 0, resolved: false,
    ...(via === 'email' ? { email, emailed: false } : {}),
  });
}

// down: open at the paging threshold; close when the portal answers (ok or config).
function reconcileDown(state, report, at, portalUrl) {
  const failures = Number(report.consecutive_failures) || 0;
  const down = state.down;
  if (report.result === 'down') {
    if (failures < PAGE_AFTER_FAILURES) return;
    if (!down.open) {
      down.open = true;
      down.since = report.down_since || at;
      enqueueAlert(state, {
        slot: 'down', key: KEYS.down, at, replace: true,
        parts: downAlert({ since: down.since, failures, detail: report.detail, portalUrl }),
      });
    }
    down.failures = Math.max(down.failures || 0, failures);
    return;
  }
  if (!down.open) return;
  const since = down.since || at;
  enqueueClear(state, { slot: 'down', key: KEYS.down, at, email: clearedEmail('down', { since, until: at }) });
  enqueueAlert(state, {
    key: safeKey(`${OUTAGE_KEY_PREFIX}:${since}`), at, replace: false,
    parts: outageAlert({ since, until: at, failures: Math.max(down.failures || 0, PAGE_AFTER_FAILURES) }),
  });
  Object.assign(down, { open: false, since: null, failures: 0 });
}

// runner: called for a good poll only (no other poll sees the scheduler).
function reconcileRunner(state, report, at) {
  const reasons = Array.isArray(report.reasons) ? report.reasons : [];
  const reason = RUNNER_REASONS.find((r) => reasons.includes(r)) || null;
  const runner = state.runner;
  if (!reason) {
    runner.seen = null;
    runner.polls = 0;
    if (runner.open) {
      enqueueClear(state, { slot: 'runner', key: KEYS.runner, at, email: clearedEmail('runner') });
      runner.open = null;
    }
    return;
  }
  runner.polls = runner.seen === reason ? (Number(runner.polls) || 0) + 1 : 1;
  runner.seen = reason;
  if (runner.polls >= RUNNER_CONFIRM_POLLS && runner.open !== reason) {
    runner.open = reason;
    enqueueAlert(state, { slot: 'runner', key: KEYS.runner, at, replace: true, parts: runnerAlert(reason, report.scheduler) });
  }
}

// setup: the portal refused the poll; a changed refusal rewrites the alert.
function reconcileSetup(state, report, at) {
  const setup = state.setup;
  if (report.result === 'config') {
    if (setup.open && setup.detail === report.detail) return;
    setup.open = true;
    setup.detail = report.detail;
    enqueueAlert(state, { slot: 'setup', key: KEYS.setup, at, replace: true, parts: setupAlert(report.detail) });
  } else if (report.result === 'ok' && setup.open) {
    enqueueClear(state, { slot: 'setup', key: KEYS.setup, at, email: clearedEmail('setup') });
    Object.assign(setup, { open: false, detail: null });
  }
}

/**
 * Fold one poll report into the state. Pure apart from `state`: no I/O.
 * `at` is the report's observation time (ISO).
 */
function reconcile(state, report, at, { portalUrl = DEFAULT_PORTAL_URL } = {}) {
  reconcileDown(state, report, at, portalUrl);
  if (report.result === 'ok') reconcileRunner(state, report, at);
  reconcileSetup(state, report, at);
  return state;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

async function flushAlert(item, io) {
  // Best effort: when it fails, the post below still lands (a standing row is refreshed).
  if (item.replace) await io.resolveRow(item.key, item.at);
  const post = await io.postRow(item.row);
  if (post.ok) return { ok: true, via: 'row' };
  const mail = await io.sendEmail(item.email);
  if (mail.ok) return { ok: true, via: 'email' };
  return { ok: false, reason: `row ${post.reason}; email ${mail.reason}` };
}

// The two parts of a clear are tracked on the item, so a retry repeats only the part
// that failed: the retire (idempotent, always owed) and the closing email (once).
async function flushClear(item, io) {
  const failed = [];
  if (!item.resolved) {
    const resolved = await io.resolveRow(item.key, item.at);
    if (resolved.ok) item.resolved = true;
    else failed.push(`resolve ${resolved.reason}`);
  }
  if (item.via === 'email' && !item.emailed) {
    const mail = await io.sendEmail(item.email);
    if (mail.ok) item.emailed = true;
    else failed.push(`email ${mail.reason}`);
  }
  if (failed.length) return { ok: false, reason: failed.join('; ') };
  return { ok: true, via: item.via === 'email' ? 'email' : 'row' };
}

async function flush(state, io, now) {
  const wrote = [];
  const keep = [];
  for (const item of state.outbox) {
    const label = `${item.kind}:${item.slot || 'outage'}`;
    const age = now.getTime() - Date.parse(item.at);
    if (!Number.isFinite(age) || age > OWED_MAX_MS) {
      wrote.push(`${label}=dropped`);
      continue;
    }
    let result;
    try {
      result = item.kind === 'clear' ? await flushClear(item, io) : await flushAlert(item, io);
    } catch (err) {
      result = { ok: false, reason: `threw ${err.name}` };
    }
    if (result.ok) {
      if (item.kind === 'alert' && item.slot && state[item.slot].alertId === item.id) state[item.slot].via = result.via;
      wrote.push(`${label}=${result.via}`);
    } else {
      item.tries = (Number(item.tries) || 0) + 1;
      item.lastError = String(result.reason).slice(0, 200);
      keep.push(item);
      wrote.push(`${label}=owed`);
    }
  }
  state.outbox = keep;
  return wrote;
}

// ---------------------------------------------------------------------------
// I/O (the test replaces these)
// ---------------------------------------------------------------------------

function runPoll(cfg) {
  return new Promise((resolve) => {
    execFile(cfg.python, [cfg.pollScript, '--json'], {
      env: { ...process.env, PORTAL_URL: cfg.portalUrl, WAVES_WATCHDOG_STATE: cfg.pollState },
      timeout: POLL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
        timedOut: !!(err && err.killed),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

function parseReport(stdout) {
  const line = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!line) return null;
  try {
    const report = JSON.parse(line);
    if (!report || typeof report !== 'object' || !['ok', 'down', 'config'].includes(report.result) || !Array.isArray(report.pages)) return null;
    return report;
  } catch {
    return null;
  }
}

async function ingest(cfg, route, body, accepted) {
  if (!cfg.ingestToken) return { ok: false, reason: 'token_unset' };
  let res;
  try {
    res = await fetch(`${cfg.portalUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.ingestToken}`, 'user-agent': 'Waves-Outside-Watchdog/1.0' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: `unreachable:${err.name}` };
  }
  let json = {};
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (accepted(res.status, json)) return { ok: true, status: res.status };
  return { ok: false, status: res.status, reason: json.reason || `http_${res.status}` };
}

// 201 only: a 200 `stale` answer means the row did not land.
const postRow = (cfg, row) => ingest(cfg, '/api/ops/digest', row, (status, json) => status === 201 && json.ok === true);
const resolveRow = (cfg, key, observedAt) => ingest(cfg, '/api/ops/digest/resolve', { key, observedAt }, (status, json) => status === 200 && json.ok === true);

function sendEmail(cfg, { subject, body }) {
  return new Promise((resolve) => {
    const file = path.join(cfg.dir, `email-body-${process.pid}-${Date.now()}.txt`);
    try {
      fs.writeFileSync(file, `${body}\n`, { mode: 0o600 });
    } catch (err) {
      resolve({ ok: false, reason: `body_file_${err.code || err.name}` });
      return;
    }
    execFile(process.execPath, [cfg.emailScript, '--force-email', '--to', OPS_INBOX, '--subject', subject, '--body-file', file], {
      env: process.env, timeout: EMAIL_TIMEOUT_MS, maxBuffer: 256 * 1024,
    }, (err, stdout) => {
      try { fs.unlinkSync(file); } catch { /* best effort */ }
      // send-email.js prints "SENT <id>" right after the SMTP send, so a crash after
      // that line still counts as sent (a retry would send the email twice).
      if (!err || /\] SENT /.test(String(stdout || ''))) resolve({ ok: true });
      else resolve({ ok: false, reason: err.killed ? 'timeout' : `exit_${err.code}` });
    });
  });
}

function liveIo(cfg) {
  return {
    runPoll: () => runPoll(cfg),
    postRow: (row) => postRow(cfg, row),
    resolveRow: (key, observedAt) => resolveRow(cfg, key, observedAt),
    sendEmail: (mail) => sendEmail(cfg, mail),
  };
}

const lastLine = (text) => String(text || '').trim().split('\n').pop().slice(0, 200);

function pollProblem(poll, report) {
  if (poll.code === 0 && report) return null;
  if (poll.code === 0) return 'the poll printed no report';
  return `the poll failed (${poll.timedOut ? 'timeout' : `exit ${poll.code}`}): ${lastLine(poll.stderr) || 'no stderr'}`;
}

// The one run.log line: what the poll saw, what was written, what is still owed.
function logLine({ at, report, state, wrote, notes }) {
  return [
    at,
    `poll=${report ? report.result : 'error'}`,
    `failures=${report ? Number(report.consecutive_failures) || 0 : '-'}`,
    `runner=${state.runner.open || state.runner.seen || '-'}`,
    `wrote=${wrote.join(',') || '-'}`,
    `owed=${state.outbox.length}`,
    ...(notes.length ? [`note=${notes.join('; ')}`] : []),
  ].join(' ');
}

async function runOnce({ env = process.env, io = null, now = () => new Date() } = {}) {
  const cfg = settings(env);
  const deps = io || liveIo(cfg);
  const notes = [];
  const state = loadState(cfg.deliverState, notes);
  let exitCode = 0;

  const poll = await deps.runPoll();
  // A report printed before a failed exit (the poll could not save its own state) is
  // still this poll's finding; the run then exits 2 so the log shows the local fault.
  const report = parseReport(poll.stdout);
  if (report) {
    const observed = Date.parse(report.observed_at);
    reconcile(state, report, new Date(Number.isFinite(observed) ? observed : now().getTime()).toISOString(), { portalUrl: cfg.portalUrl });
  }
  const problem = pollProblem(poll, report);
  if (problem) {
    exitCode = 2;
    notes.push(problem);
  }

  // Owed writes go out even when this run's poll failed.
  const wrote = await flush(state, deps, now());
  try {
    saveState(cfg.deliverState, state);
  } catch (err) {
    exitCode = 2;
    notes.push(`cannot write ${cfg.deliverState} (${err.code || err.name})`);
  }
  if (exitCode === 0 && state.outbox.length) exitCode = 1;
  return { exitCode, line: logLine({ at: now().toISOString(), report, state, wrote, notes }), report, state, wrote };
}

if (require.main === module) {
  runOnce()
    .then((r) => { console.log(r.line); process.exit(r.exitCode); })
    .catch((err) => { console.error(`${new Date().toISOString()} deliver.js crashed: ${err.message}`); process.exit(2); });
}

module.exports = {
  runOnce, reconcile, flush, defaultState, loadState, saveState, settings, parseReport, sendEmail, runPoll,
  downAlert, outageAlert, runnerAlert, setupAlert, clearedEmail, rowFor, etTime,
  KEYS, CHECK_ID, OPS_INBOX, RUNNER_REASONS, RUNNER_CONFIRM_POLLS, PAGE_AFTER_FAILURES, OWED_MAX_MS, SIGNATURE,
};
