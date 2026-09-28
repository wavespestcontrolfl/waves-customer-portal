#!/usr/bin/env node
// MUTATES (dry-run default)
//
// inventory-agent-undo.js — reverses ONE inventory-agent decision
// (a purchase_receipt_lines row the agent logged, agent_decision set):
//   - reverses the stock movement through adjustStock with a correction of
//     -received (never deletes/edits the original movement — same ledger
//     discipline as every other stock write in this codebase), keeping a
//     movement record of the undo so the ledger shows it;
//   - for an EXISTING product the agent restocked (never one it created —
//     see below), restores container_size, inventory_unit,
//     inventory_on_hand and default_unit to the exact values they held
//     before the agent's own write (agent_decision.originalProductFields,
//     recorded under the product lock in the same transaction as the
//     original restock) — a product that was untracked (inventory_on_hand
//     null) returns to null, not 0, and its unit reverts with it;
//   - deletes the agent-created product_aliases row, if any;
//   - retires the line's own "logged a purchase" bell (unread, dedupeKey
//     purchase-receipt:<lineId>) in the SAME transaction as the reversal,
//     the way auto-order-revoke.js retires its own bell — it's stale once
//     the restock is undone;
//   - NEVER deactivates a product, even one the agent itself created (2026-09-27
//     review): once created, staff may have linked it somewhere this row's
//     own hash can't see. When the product was agent-created, this prints an
//     informational line pointing at Inventory → Products instead of
//     touching the row;
//   - marks the line 'agent_unsure' with agent_decision.undoneAt.
// Refuses — dry run or --execute — when anything wrote the product row
// after the agent's own restock (usage, another restock, a manual count, an
// edit): the row's version must still equal the one the agent recorded, and
// stock must still equal the movement's stock_after. Reversing past a later
// write would not cleanly restore the pre-agent state. ALSO refuses (item 4,
// 2026-09-27 round 7 review; widened by the 2026-09-27 pre-push audits)
// when any row referencing the product — a service COGS mapping, a visit's
// applied product, a protocol or lawn-protocol product, a recorded
// application, nutrient or limit row, or a restock request — was added,
// re-pointed, edited or removed since the agent's decision: the row hash
// above only ever covers the products_catalog row itself, never a reference
// INTO it, so the agent records a per-table footprint of those rows at its
// write and this compares it (productReferencesUnchangedSinceAgent,
// server/services/purchase-receipts/inventory-agent.js).
//
//   railway run --service Postgres node ops/agents/inventory-agent-undo.js --line=<id|8-char-prefix>            # dry run
//   railway run --service Postgres node ops/agents/inventory-agent-undo.js --line=<id|8-char-prefix> --execute  # apply
//
// Run from the repo root (resolves the server's modules). Output carries
// ids, product/alias names and quantities only.
//
// Testability: everything below `undoLine` is pure with respect to argv,
// DATABASE_PUBLIC_URL and process.exit — every input is a parameter, so a
// PG test can drive it directly against a schema-scoped connection (see
// server/tests/inventory-agent-postgres.test.js). Only the block guarded by
// `require.main === module` at the bottom touches argv/env/process.exit; a
// thrown Error's `.exitCode` is what that block turns into the real exit
// code, so the two paths (CLI, test) share the exact same validation.
//
// DATABASE_URL, for the CLI path only: server/models/db.js opens its knex
// pool the moment it's `require`d, and that pool keeps whatever URL was set
// at that instant no matter what a later reassignment does. Setting
// DATABASE_URL from DATABASE_PUBLIC_URL inside main() — AFTER the requires
// below had already pulled db.js in via inventory-operations/inventory-agent
// — left the pool pinned to Railway's own internal DATABASE_URL, unreachable
// from `railway run`'s outside-the-service-network shell (2026-09-27
// review). So this runs before any of those requires, and only when this
// file is the CLI entry point (require.main === module) — a test importing
// {undoLine, findLine} mocks ../models/db before requiring this file, so it
// never reaches this branch.
if (require.main === module) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/inventory-agent-undo.js --line=<id>');
    process.exit(2);
  }
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  // The public proxy needs TLS, and railway run's own DATABASE_URL (the
  // internal host) is unreachable from outside the service network — knex's
  // own ssl config only applies when NODE_ENV=production (server/knexfile.js),
  // so without this a `railway run --service Postgres` invocation (this
  // script's own advertised command) never negotiates TLS at all and the
  // connection just hangs/refuses. Same pattern as
  // archive-catalog-service.js: enable it unless the URL already states a
  // mode or PGSSLMODE is already set (2026-09-27 round 9 review, item 5).
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
}

const path = require('path');
const { adjustStock } = require(path.join(__dirname, '..', '..', 'server', 'services', 'inventory-operations'));
const { productUnchangedSinceAgent, productReferencesUnchangedSinceAgent, lockProductReferences } = require(path.join(__dirname, '..', '..', 'server', 'services', 'purchase-receipts', 'inventory-agent'));

function arg(name, argv) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function usageError(message, exitCode = 2) {
  return Object.assign(new Error(message), { exitCode });
}

// One field's exact CURRENT db value, formatted for the dry-run print: null
// rendered as the bare word `null`, anything else JSON-quoted (a string
// prints as `"each"`, a number as `60`, matching how Postgres actually
// returned it — numeric columns come back as strings through this driver,
// same as the fixture assertions elsewhere in this lane check them).
function fieldDisplay(value) {
  return value === null || value === undefined ? 'null' : JSON.stringify(value);
}

// Prints exactly what an existing product's restore would change (item 3,
// 2026-09-27 round 9 review; ops/agents/README.md requires a mutating
// script to print exactly what would change) — every field's CURRENT value
// -> the exact ORIGINAL value recorded at the agent's own write.
function logRestoredFields(log, product, originalFields) {
  log(`  restore "${product?.name}"'s fields to what they were before the agent's restock:`);
  const restoredFields = [
    ['container_size', product?.container_size, originalFields.containerSize],
    ['inventory_unit', product?.inventory_unit, originalFields.inventoryUnit],
    ['inventory_on_hand', product?.inventory_on_hand, originalFields.inventoryOnHand],
    ['default_unit', product?.default_unit, originalFields.defaultUnit],
  ];
  for (const [field, current, original] of restoredFields) {
    log(`    ${field}: ${fieldDisplay(current)} → ${fieldDisplay(original)}`);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A prefix must be EXACTLY the first-8-characters the "logged" bell prints
// (see inventory-agent.js's applyDecision) — never a shorter or longer run of
// hex, which would either match far too broadly or just be typo'd input.
const PREFIX_RE = /^[0-9a-f]{8}$/i;
const USAGE = 'Usage: --line=<purchase_receipt_lines.id or its first 8 characters> [--execute]';

// Exact id, or an exactly-8-hex-character prefix. Anything else is refused
// before any query — the LIKE below is only ever run against a full UUID or
// that fixed-width prefix, both safe.
async function findLine(conn, lineArg) {
  if (UUID_RE.test(lineArg)) return conn('purchase_receipt_lines').where({ id: lineArg }).first();
  if (!PREFIX_RE.test(lineArg)) throw usageError(`"${lineArg}" is not a full id or an 8-character id prefix.\n${USAGE}`);
  const matches = await conn('purchase_receipt_lines').whereRaw('id::text LIKE ?', [`${lineArg.toLowerCase()}%`]);
  if (matches.length > 1) {
    throw usageError(`"${lineArg}" matches ${matches.length} lines — be more specific:\n`
      + matches.map((m) => `  ${m.id}  (${m.status}) "${m.raw_title}"`).join('\n'));
  }
  return matches[0] || null;
}

// Every reason a line can't be undone at all — one ordered table of checks
// sharing the same shape (a guard against the found `line`, its message)
// instead of four separate ifs that all just throw the same usage error.
const UNDOABLE_GUARDS = [
  { fails: (line) => !line, message: (line, lineArg) => `No purchase_receipt_lines row matches "${lineArg}".` },
  {
    fails: (line) => !line.agent_decision,
    message: (line) => `Line ${line.id} was never decided by the inventory agent (agent_decision is null) — nothing to undo.`,
  },
  {
    fails: (line) => line.status !== 'logged',
    message: (line) => `Line ${line.id} is "${line.status}", not "logged" — nothing was moved, nothing to reverse.`,
  },
  {
    fails: (line) => !line.movement_id || !line.product_id,
    message: (line) => `Line ${line.id} has no movement/product recorded — nothing to reverse.`,
  },
];

// Every validation + the dry-run description + (when execute) the actual
// transaction. `log` defaults to console.log; a test can pass a spy.
async function undoLine(conn, { lineArg, execute = false, log = console.log }) {
  const line = await findLine(conn, lineArg);
  const guard = UNDOABLE_GUARDS.find((g) => g.fails(line));
  if (guard) throw usageError(guard.message(line, lineArg));

  const movement = await conn('product_inventory_movements').where({ id: line.movement_id }).first();
  if (!movement) throw usageError(`Movement ${line.movement_id} referenced by the line no longer exists.`);
  const unchanged = await productUnchangedSinceAgent(conn, line, movement);
  if (!unchanged.ok) {
    throw usageError(`Refusing: ${unchanged.why}. Reversing now would not cleanly restore the pre-agent count; fix the stock by hand.`, 1);
  }
  // Checked BEFORE any reversal or restoration (the row hash above only ever
  // covers the product row itself, never a reference INTO it): staff may
  // have built on this product since the agent's decision — a service
  // mapping it for COGS (new, or an older one re-pointed at it), a completed
  // visit applying it, a protocol adopting it, or a restock request — and
  // undoing past that would leave that reference pointed at a state that no
  // longer makes sense (2026-09-27 review, item 4; pre-push audit).
  const downstream = await productReferencesUnchangedSinceAgent(conn, line);
  if (!downstream.ok) {
    throw usageError(`Refusing: ${downstream.why}. Reversing now would not account for it; fix the stock by hand instead.`, 1);
  }

  const product = await conn('products_catalog').where({ id: line.product_id }).first();
  const alias = line.agent_created_alias_id ? await conn('product_aliases').where({ id: line.agent_created_alias_id }).first() : null;
  const isAgentCreatedProduct = Boolean(line.agent_created_product_id) && line.agent_created_product_id === line.product_id;
  // Only ever set for an 'existing'-decision restock (never a new_product
  // create — that row is never touched beyond the stock reversal; see
  // isAgentCreatedProduct below).
  const originalFields = line.agent_decision?.originalProductFields || null;

  log(`Line ${line.id} ("${line.raw_title}"):`);
  log(`  reverse ${line.received_qty} ${line.received_unit} on "${product?.name || line.product_id}" (a correction of -${line.received_qty} ${line.received_unit})`);
  if (originalFields && !isAgentCreatedProduct) logRestoredFields(log, product, originalFields);
  if (alias) log(`  delete product_aliases row ${alias.id} ("${alias.alias_name}")`);
  // Never deactivated (2026-09-27 review) — staff may have linked this row
  // somewhere the undo can't see since the agent created it.
  if (isAgentCreatedProduct) log(`  Product "${product?.name}" was created by the agent; if it shouldn't exist, deactivate it in Inventory → Products.`);
  log('  retire the line\'s "logged a purchase" bell (mark it read)');
  log('  set the line\'s status to agent_unsure, stamping agent_decision.undoneAt');
  if (!execute) {
    log('\nDry run — pass --execute to apply.');
    return { executed: false };
  }

  await conn.transaction(async (trx) => {
    const lockedLine = await trx('purchase_receipt_lines').where({ id: line.id }).forUpdate().first();
    if (!lockedLine || lockedLine.status !== 'logged' || lockedLine.movement_id !== line.movement_id) {
      throw new Error('The line changed since the dry run — re-run to see the current state before undoing.');
    }
    // References first, then the product (see lockProductReferences): from
    // here to commit, nothing that references the product can change under
    // the footprint check below.
    await lockProductReferences(trx, line.product_id);
    await trx('products_catalog').where({ id: line.product_id }).forUpdate().first('id');
    const stillUnchanged = await productUnchangedSinceAgent(trx, line, movement);
    if (!stillUnchanged.ok) throw new Error(`Refusing to reverse: ${stillUnchanged.why}.`);
    const stillNoDownstream = await productReferencesUnchangedSinceAgent(trx, line);
    if (!stillNoDownstream.ok) throw new Error(`Refusing to reverse: ${stillNoDownstream.why}.`);

    await adjustStock(line.product_id, { movementType: 'correction', quantity: -Number(line.received_qty), unit: line.received_unit }, {
      source: 'inventory_agent_undo', extraMetadata: { undoOfLineId: line.id, undoOfMovementId: movement.id }, trx,
    });

    // The compensating movement above is the ledger record (kept, never
    // edited); this restores the catalog ROW itself to exactly what it was
    // before the agent's write, under the same product lock — the reversal's
    // own arithmetic only ever touches inventory_on_hand/inventory_unit, and
    // never container_size/default_unit at all, so without this a
    // setContainerSize or the count-product default_unit fix would survive
    // an undo untouched, and an originally-untracked product would land on
    // 0 instead of back to null.
    if (originalFields && !isAgentCreatedProduct) {
      await trx('products_catalog').where({ id: line.product_id }).update({
        container_size: originalFields.containerSize,
        inventory_unit: originalFields.inventoryUnit,
        inventory_on_hand: originalFields.inventoryOnHand,
        default_unit: originalFields.defaultUnit,
        updated_at: new Date(),
      });
    }

    if (alias) await trx('product_aliases').where({ id: alias.id }).del();

    // The line's own "logged a purchase" bell is now stale — reversed, not
    // still true — so retire it in the SAME transaction as the reversal,
    // the same way auto-order-revoke.js retires its own bell.
    await trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`purchase-receipt:${line.id}`]).whereNull('read_at').update({ read_at: new Date() });

    await trx('purchase_receipt_lines').where({ id: line.id }).update({
      status: 'agent_unsure',
      agent_decision: { ...(line.agent_decision || {}), undoneAt: new Date().toISOString() },
      agent_decided_at: new Date(),
    });
  });
  log('Done.');
  return { executed: true };
}

async function main() {
  // DATABASE_URL is already set from DATABASE_PUBLIC_URL by the module-top
  // block above (it must happen before db.js is ever required — see the
  // comment there); this require is the first thing that actually opens the
  // pool.
  const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
  const execute = process.argv.includes('--execute');
  const lineArg = arg('line', process.argv);
  if (!lineArg) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    await undoLine(db, { lineArg, execute });
  } catch (err) {
    console.error(err.message);
    process.exitCode = err.exitCode || 1;
  } finally {
    // Always release the pool, or the command hangs after it prints; a
    // failure keeps its nonzero exit code (set above).
    await db.destroy();
  }
}

if (require.main === module) {
  main();
}

module.exports = { undoLine, findLine };
