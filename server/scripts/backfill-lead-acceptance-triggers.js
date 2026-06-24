/**
 * One-off backfill: convert leads that are stuck in an open status even though
 * the deal has clearly closed (estimate accepted + deposit paid, or a service
 * completed + invoice sent). These funnel events did not used to write back to
 * the lead; the triggers added in this PR fix that going forward, but leads
 * that closed BEFORE the triggers shipped need a one-time nudge.
 *
 * For each target contact it resolves the customer record (by normalized phone
 * or email), then reuses the shared `convertLeadFromEvent` so the conversion is
 * identical to what the live triggers do — open leads only, idempotent, links
 * the customer. Already-won leads are skipped.
 *
 * SAFE BY DEFAULT: dry-run unless `--commit` is passed. This writes to whatever
 * DATABASE_URL points at, so run it deliberately (break-glass on prod, per the
 * waves-db policy).
 *
 *   node server/scripts/backfill-lead-acceptance-triggers.js            # dry-run
 *   node server/scripts/backfill-lead-acceptance-triggers.js --commit   # write
 */
require('dotenv').config();
const db = require('../models/db');
const logger = require('../services/logger');
const { convertLeadFromEvent } = require('../services/lead-estimate-link');

// The two leads reported as stuck. Add more `{ phone, email }` entries here if
// other contacts surface; only one of phone/email is required per entry.
const TARGETS = [
  { phone: '+14022107112', email: 'taryn.n.hamer@gmail.com', note: 'Taryn Hamer — estimate accepted + deposit paid' },
  { phone: '+19412269100', email: 'bubbleyutea@gmail.com', note: 'Holly Thompson — service completed + invoice sent' },
];

const COMMIT = process.argv.includes('--commit');

function last10(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

async function findCustomer({ phone, email }) {
  const np = last10(phone);
  const ne = String(email || '').trim().toLowerCase() || null;
  if (!np && !ne) return null;
  return db('customers')
    .where((builder) => {
      if (np) builder.orWhereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = ?", [np]);
      if (ne) builder.orWhereRaw("LOWER(COALESCE(email, '')) = ?", [ne]);
    })
    .first();
}

async function run() {
  logger.info(`[backfill-lead-triggers] starting (${COMMIT ? 'COMMIT' : 'DRY-RUN'})`);
  let converted = 0;
  let skipped = 0;

  for (const target of TARGETS) {
    const customer = await findCustomer(target);
    if (!customer) {
      logger.warn(`[backfill-lead-triggers] no customer found for ${target.note}; skipping`);
      skipped += 1;
      continue;
    }

    if (!COMMIT) {
      logger.info(`[backfill-lead-triggers] DRY-RUN would convert open lead(s) for ${target.note} -> customer ${customer.id}`);
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
      logger.info(`[backfill-lead-triggers] converted ${result.count} lead(s) for ${target.note}: ${result.leadIds.join(', ')}`);
    } else {
      skipped += 1;
      logger.info(`[backfill-lead-triggers] nothing to convert for ${target.note} (${result.reason})`);
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
