#!/usr/bin/env node
'use strict';

/**
 * Zero-cost historical churn-reason export & CSV-apply helper.
 *
 * Usage:
 *   1. Export unclassified churned/dormant accounts (read-only, zero PII):
 *        node server/scripts/export-unclassified-churn.js [--months 12] [--out /tmp/unclassified-churn.csv]
 *   2. Fill `new_churn_reason_code` in the CSV (valid codes: price, moving,
 *      service_quality, results, competitor, seasonal_pause, financial,
 *      no_longer_needed, other — v2 cancel codes also normalize automatically).
 *   3. Dry-run the apply (default — writes NOTHING):
 *        node server/scripts/export-unclassified-churn.js --apply /tmp/unclassified-churn.csv
 *   4. Apply after reviewing the dry-run summary:
 *        node server/scripts/export-unclassified-churn.js --apply /tmp/unclassified-churn.csv --confirm
 *
 * Uses zero paid APIs or LLM calls. Only updates rows that are still in a
 * churned/dormant stage with churn_reason_code IS NULL or 'unclassified'.
 */

const fs = require('fs');
const { normalizeChurnReasonCode, churnCodeForCancelReason } = require('../services/churn-reason-map');

const CSV_HEADERS = [
  'customer_id',
  'pipeline_stage',
  'churned_at',
  'monthly_rate',
  'legacy_churn_reason',
  'case_reason_code',
  'suggested_code',
  'new_churn_reason_code',
];

function escapeCsvCell(val) {
  if (val == null) return '';
  const s = String(val).replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
  // Guard against spreadsheet formula injection when opened in Excel/Sheets.
  const safe = /^[=+\-@\t]/.test(s) ? `'${s}` : s;
  if (/[",]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

function formatDateOnly(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

function buildExportCsv(rows) {
  const lines = [CSV_HEADERS.join(',')];
  for (const r of rows) {
    const suggested = churnCodeForCancelReason(r.case_reason_code) || '';
    const cells = [
      r.id,
      r.pipeline_stage || '',
      formatDateOnly(r.churned_at),
      r.monthly_rate != null ? Number(r.monthly_rate).toFixed(2) : '',
      r.churn_reason || '',
      r.case_reason_code || '',
      suggested,
      '',
    ];
    lines.push(cells.map(escapeCsvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line, idx) => {
    const cols = parseCsvLine(line);
    const row = { __line: idx + 2 };
    headers.forEach((h, i) => {
      row[h] = (cols[i] ?? '').trim();
    });
    return row;
  });
}

function validateAssignments(csvRows) {
  const accepted = [];
  const errors = [];
  const seen = new Set();

  for (const r of csvRows) {
    const id = r.customer_id;
    const rawCode = r.new_churn_reason_code;
    if (!rawCode) continue;
    if (!id) {
      errors.push(`line ${r.__line}: missing customer_id`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`line ${r.__line}: duplicate customer_id ${id}`);
      continue;
    }
    seen.add(id);
    const code = normalizeChurnReasonCode(rawCode, { allowUnclassified: false });
    if (!code) {
      errors.push(`line ${r.__line}: invalid churn reason "${rawCode}" for customer ${id}`);
      continue;
    }
    accepted.push({ customerId: id, code, line: r.__line });
  }

  return { accepted, errors };
}

async function queryUnclassifiedRows(db, { months = 12 } = {}) {
  const clampedMonths = Math.max(1, Math.min(60, parseInt(months, 10) || 12));
  return db('customers as c')
    .whereNull('c.deleted_at')
    .whereIn('c.pipeline_stage', ['churned', 'dormant'])
    .whereRaw(`COALESCE(c.churned_at, (c.pipeline_stage_changed_at AT TIME ZONE 'America/New_York')::date) >= ((NOW() AT TIME ZONE 'America/New_York')::date - (?::int * INTERVAL '1 month'))::date`, [clampedMonths])
    .where(function unclassifiedOnly() {
      this.whereNull('c.churn_reason_code').orWhere('c.churn_reason_code', 'unclassified');
    })
    .select(
      'c.id',
      'c.pipeline_stage',
      db.raw(`COALESCE(c.churned_at, (c.pipeline_stage_changed_at AT TIME ZONE 'America/New_York')::date) as churned_at`),
      db.raw('COALESCE(c.churn_mrr, c.monthly_rate, 0) as monthly_rate'),
      'c.churn_reason',
      db.raw(`(
        SELECT cc.reason_code FROM cancellation_cases cc
        WHERE cc.customer_id = c.id AND cc.reason_code IS NOT NULL
        ORDER BY cc.created_at DESC LIMIT 1
      ) as case_reason_code`),
    )
    .orderBy('churned_at', 'desc');
}

async function applyAssignments(db, assignments, { confirm = false } = {}) {
  const ids = assignments.map((a) => a.customerId);
  if (ids.length === 0) return { applied: 0, skipped: [], dryRun: !confirm };

  const existing = await db('customers')
    .whereIn('id', ids)
    .whereNull('deleted_at')
    .select('id', 'pipeline_stage', 'churn_reason_code');
  const byId = new Map(existing.map((r) => [String(r.id), r]));

  const eligible = [];
  const skipped = [];
  for (const item of assignments) {
    const row = byId.get(String(item.customerId));
    if (!row) {
      skipped.push({ customerId: item.customerId, reason: 'not_found' });
    } else if (!['churned', 'dormant'].includes(row.pipeline_stage)) {
      skipped.push({ customerId: item.customerId, reason: `stage_is_${row.pipeline_stage}` });
    } else if (row.churn_reason_code && row.churn_reason_code !== 'unclassified') {
      skipped.push({ customerId: item.customerId, reason: `already_classified_${row.churn_reason_code}` });
    } else {
      eligible.push(item);
    }
  }

  if (!confirm || eligible.length === 0) {
    return { applied: 0, wouldApply: eligible.length, eligible, skipped, dryRun: !confirm };
  }

  let applied = 0;
  await db.transaction(async (trx) => {
    for (const item of eligible) {
      const n = await trx('customers')
        .where({ id: item.customerId })
        .whereNull('deleted_at')
        .whereIn('pipeline_stage', ['churned', 'dormant'])
        .where(function stillUnclassified() {
          this.whereNull('churn_reason_code').orWhere('churn_reason_code', 'unclassified');
        })
        .update({ churn_reason_code: item.code, updated_at: trx.fn.now() });
      applied += Number(n || 0);
    }
  });

  return { applied, wouldApply: eligible.length, eligible, skipped, dryRun: false };
}

function parseCliArgs(argv) {
  const opts = { months: 12, out: null, apply: null, confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--months' && argv[i + 1]) { opts.months = parseInt(argv[i + 1], 10) || 12; i += 1; }
    else if (a === '--out' && argv[i + 1]) { opts.out = argv[i + 1]; i += 1; }
    else if (a === '--apply' && argv[i + 1]) { opts.apply = argv[i + 1]; i += 1; }
    else if (a === '--confirm') { opts.confirm = true; }
  }
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const db = require('../models/db');
  try {
    if (opts.apply) {
      const csvText = fs.readFileSync(opts.apply, 'utf8');
      const { accepted, errors } = validateAssignments(parseCsv(csvText));
      if (errors.length > 0) {
        console.error('Validation failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
        process.exitCode = 1;
        return;
      }
      const res = await applyAssignments(db, accepted, { confirm: opts.confirm });
      console.log(JSON.stringify({
        mode: res.dryRun ? 'dry_run' : 'applied',
        parsed: accepted.length,
        wouldApply: res.wouldApply,
        applied: res.applied,
        skipped: res.skipped,
      }, null, 2));
      return;
    }

    const rows = await queryUnclassifiedRows(db, { months: opts.months });
    const csv = buildExportCsv(rows);
    if (opts.out) {
      fs.writeFileSync(opts.out, csv, 'utf8');
      console.log(`Exported ${rows.length} unclassified churn rows to ${opts.out}`);
    } else {
      process.stdout.write(csv);
    }
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  CSV_HEADERS,
  escapeCsvCell,
  buildExportCsv,
  parseCsv,
  validateAssignments,
  queryUnclassifiedRows,
  applyAssignments,
  parseCliArgs,
};
