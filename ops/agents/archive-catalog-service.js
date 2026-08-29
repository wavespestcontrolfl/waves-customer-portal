// MUTATES (dry-run default; pass --execute to write)
//
// Archive ONE Service Library row by service_key through the catalog's own
// mechanism — service-library.deactivateService — so the full reference
// guard (open visits by id AND by live service_type match, add-ons, package
// items, discount rules, …) and the `service_catalog.archive` audit row are
// exactly what the admin UI's Archive button produces. Nothing is bypassed.
//
// Why a script and not a migration (owner ruling 2026-08-29, rodent_monitoring):
// a migration that skips on blocking references is recorded as applied and
// never retries, and throwing instead would block EVERY deploy for one
// catalog row. A dry-run-by-default operator script has neither failure mode.
//
// Dry run prints the row, its live references, and whether the archive would
// be refused. --execute archives (or is refused with the same reference list).
// No customer comms fire (catalog write only).
//
// Run: railway run --service Postgres node ops/agents/archive-catalog-service.js --key=<service_key> [--execute]
const path = require('path');
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const EXECUTE = process.argv.includes('--execute');
const keyArg = process.argv.find((a) => a.startsWith('--key='));
const serviceKey = keyArg ? keyArg.slice('--key='.length).trim() : '';
if (!serviceKey) { console.error('usage: --key=<service_key> [--execute]'); process.exit(2); }

const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
const { getServiceByKey, getServiceReferences, deactivateService } = require(path.join(__dirname, '..', '..', 'server', 'services', 'service-library'));

(async () => {
  const row = await getServiceByKey(serviceKey);
  if (!row) { console.log(`no catalog row for service_key=${serviceKey}`); process.exit(1); }
  console.log(`row: ${row.service_key} | ${row.name} | active=${row.is_active} archived=${row.is_archived}`);
  if (row.is_archived) { console.log('already archived — nothing to do'); process.exit(0); }
  const references = await getServiceReferences(row);
  console.log('references:', JSON.stringify(references));
  const blocking = Number(references && references.blocking_total) || 0;
  if (blocking > 0) {
    console.log(`WOULD BE REFUSED: ${blocking} blocking reference(s) — resolve them (reschedule/complete open visits, repoint add-ons/packages) and re-run`);
    process.exit(1);
  }
  if (!EXECUTE) { console.log('DRY RUN: archive would succeed (is_active=false, is_archived=true + audit row). Re-run with --execute.'); process.exit(0); }
  const after = await deactivateService(row.id, { audit: { changed_by: 'ops/agents/archive-catalog-service.js', reason: 'owner ruling 2026-08-29' } });
  console.log(`ARCHIVED: ${after.service_key} | ${after.name} | active=${after.is_active} archived=${after.is_archived}`);
})().catch(async (e) => { console.error(e.message, e.details ? JSON.stringify(e.details) : ''); process.exit(1); })
  .finally(() => db.destroy().catch(() => {}));
