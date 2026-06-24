/**
 * One-off backfill: convert leads that are stuck in an open status even though
 * the deal has clearly closed (estimate accepted + deposit paid, or a service
 * completed + invoice sent). These funnel events did not used to write back to
 * the lead; the triggers added in this PR fix that going forward, but leads
 * that closed BEFORE the triggers shipped need a one-time nudge.
 *
 * For each target contact it resolves the customer record (by normalized phone
 * or email), then reuses the shared `convertLeadFromEvent` so the conversion is
 * identical to what the live triggers do — open, unconverted leads only,
 * idempotent, links the customer. Already-won leads are skipped.
 *
 * Targets are supplied at RUN TIME — never committed. Pass a non-committed JSON
 * file of `[{ "phone": "...", "email": "..." }]`, or a single contact inline:
 *
 *   node server/scripts/backfill-lead-acceptance-triggers.js --file=./targets.json
 *   node server/scripts/backfill-lead-acceptance-triggers.js --phone=+15551234567
 *   node server/scripts/backfill-lead-acceptance-triggers.js --email=a@b.com --commit
 *
 * SAFE BY DEFAULT: dry-run unless `--commit` is passed. Contacts are logged
 * masked (no full phone/email/name). This writes to whatever DATABASE_URL
 * points at, so run it deliberately (break-glass on prod, per the waves-db
 * policy).
 */
require('dotenv').config();
const fs = require('fs');
const db = require('../models/db');
const logger = require('../services/logger');
const { convertLeadFromEvent } = require('../services/lead-estimate-link');

const COMMIT = process.argv.includes('--commit');

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function loadTargets() {
  const file = argValue('file');
  if (file) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('--file must contain a JSON array of { phone, email }');
    return parsed;
  }
  const phone = argValue('phone');
  const email = argValue('email');
  if (phone || email) return [{ phone, email }];
  return [];
}

function last10(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// Mask for logs — never emit full phone/email (PII).
function maskContact({ phone, email }) {
  const parts = [];
  const np = last10(phone);
  if (np) parts.push(`phone:***${np.slice(-4)}`);
  const ne = String(email || '').trim().toLowerCase();
  if (ne.includes('@')) {
    const [user, domain] = ne.split('@');
    parts.push(`email:${user.slice(0, 1)}***@${domain}`);
  }
  return parts.join(' ') || '(no contact)';
}

// Resolve the target to EXACTLY ONE customer. Shared family phones, duplicate
// rows, or a phone from one customer + email from another can match multiple
// customers; converting onto an arbitrary `.first()` would corrupt attribution,
// so an ambiguous (or empty) match is reported and skipped, never guessed.
async function resolveCustomer({ phone, email }) {
  const np = last10(phone);
  const ne = String(email || '').trim().toLowerCase() || null;
  if (!np && !ne) return { customer: null, reason: 'no_contact' };
  const matches = await db('customers')
    .where((builder) => {
      if (np) builder.orWhereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = ?", [np]);
      if (ne) builder.orWhereRaw("LOWER(COALESCE(email, '')) = ?", [ne]);
    })
    .limit(2);
  if (!matches.length) return { customer: null, reason: 'no_customer' };
  if (matches.length > 1) return { customer: null, reason: 'ambiguous_customer' };
  return { customer: matches[0], reason: null };
}

async function run() {
  const targets = loadTargets();
  if (!targets.length) {
    logger.error('[backfill-lead-triggers] no targets — pass --file=<path>, or --phone=/--email=');
    return;
  }
  logger.info(`[backfill-lead-triggers] starting (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) — ${targets.length} target(s)`);
  let converted = 0;
  let skipped = 0;

  for (const target of targets) {
    const masked = maskContact(target);
    const { customer, reason } = await resolveCustomer(target);
    if (!customer) {
      logger.warn(`[backfill-lead-triggers] skipping ${masked} (${reason})`);
      skipped += 1;
      continue;
    }

    if (!COMMIT) {
      logger.info(`[backfill-lead-triggers] DRY-RUN would convert open lead(s) for ${masked} -> customer ${customer.id}`);
      continue;
    }

    const result = await convertLeadFromEvent({
      source: 'backfill',
      customerId: customer.id,
      phone: target.phone,
      email: target.email,
    });
    if (result.converted) {
      converted += result.count;
      logger.info(`[backfill-lead-triggers] converted ${result.count} lead(s) for ${masked}: ${result.leadIds.join(', ')}`);
    } else {
      skipped += 1;
      logger.info(`[backfill-lead-triggers] nothing to convert for ${masked} (${result.reason})`);
    }
  }

  logger.info(`[backfill-lead-triggers] done — converted=${converted} skipped=${skipped}${COMMIT ? '' : ' (dry-run, no writes)'}`);
}

run()
  .then(() => db.destroy())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`[backfill-lead-triggers] failed: ${err.message}`);
    db.destroy().finally(() => process.exit(1));
  });
