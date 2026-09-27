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
//   - deactivates the agent-CREATED catalog product (never an existing one
//     the agent merely restocked), but ONLY when, after the reversal, it
//     carries no other movement, no vendor_pricing row, and no
//     product_aliases row besides the agent's own (already deleted above);
//   - marks the line 'agent_unsure' with agent_decision.undoneAt.
// Refuses — dry run or --execute — when anything wrote the product row
// after the agent's own restock (usage, another restock, a manual count, an
// edit): the row's version must still equal the one the agent recorded, and
// stock must still equal the movement's stock_after. Reversing past a later
// write would not cleanly restore the pre-agent state.
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
const path = require('path');
const { adjustStock } = require(path.join(__dirname, '..', '..', 'server', 'services', 'inventory-operations'));
const { productUnchangedSinceAgent } = require(path.join(__dirname, '..', '..', 'server', 'services', 'purchase-receipts', 'inventory-agent'));

function arg(name, argv) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function usageError(message, exitCode = 2) {
  return Object.assign(new Error(message), { exitCode });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Exact id, or a prefix (the same first-8-characters the "logged" bell
// prints — see inventory-agent.js's applyDecision).
async function findLine(conn, lineArg) {
  if (UUID_RE.test(lineArg)) return conn('purchase_receipt_lines').where({ id: lineArg }).first();
  const matches = await conn('purchase_receipt_lines').whereRaw('id::text LIKE ?', [`${lineArg.toLowerCase()}%`]);
  if (matches.length > 1) {
    throw usageError(`"${lineArg}" matches ${matches.length} lines — be more specific:\n`
      + matches.map((m) => `  ${m.id}  (${m.status}) "${m.raw_title}"`).join('\n'));
  }
  return matches[0] || null;
}

// Movements on this product other than `excludeIds`.
async function otherMovements(conn, productId, excludeIds) {
  return conn('product_inventory_movements').where({ product_id: productId }).whereNotIn('id', excludeIds);
}

// Vendor pricing rows on this product — a person priced it since the agent
// created it, so it's no longer purely the agent's own throwaway row.
async function vendorPricingRows(conn, productId) {
  return conn('vendor_pricing').where({ product_id: productId }).select('id');
}

// product_aliases rows on this product OTHER than the agent's own (which is
// already deleted by the time this runs — see undoLine()). Any survivor
// means a person (or another line) linked another title to it since.
async function otherAliases(conn, productId) {
  return conn('product_aliases').where({ product_id: productId }).select('id');
}

// Every validation + the dry-run description + (when execute) the actual
// transaction. `log` defaults to console.log; a test can pass a spy.
async function undoLine(conn, { lineArg, execute = false, log = console.log }) {
  const line = await findLine(conn, lineArg);
  if (!line) throw usageError(`No purchase_receipt_lines row matches "${lineArg}".`);
  if (!line.agent_decision) {
    throw usageError(`Line ${line.id} was never decided by the inventory agent (agent_decision is null) — nothing to undo.`);
  }
  if (line.status !== 'logged') {
    throw usageError(`Line ${line.id} is "${line.status}", not "logged" — nothing was moved, nothing to reverse.`);
  }
  if (!line.movement_id || !line.product_id) {
    throw usageError(`Line ${line.id} has no movement/product recorded — nothing to reverse.`);
  }

  const movement = await conn('product_inventory_movements').where({ id: line.movement_id }).first();
  if (!movement) throw usageError(`Movement ${line.movement_id} referenced by the line no longer exists.`);
  const unchanged = await productUnchangedSinceAgent(conn, line, movement);
  if (!unchanged.ok) {
    throw usageError(`Refusing: ${unchanged.why}. Reversing now would not cleanly restore the pre-agent count; fix the stock by hand.`, 1);
  }

  const product = await conn('products_catalog').where({ id: line.product_id }).first();
  const alias = line.agent_created_alias_id ? await conn('product_aliases').where({ id: line.agent_created_alias_id }).first() : null;
  const isAgentCreatedProduct = Boolean(line.agent_created_product_id) && line.agent_created_product_id === line.product_id;
  // Only ever set for an 'existing'-decision restock (never a new_product
  // create — that row is deactivated instead, below).
  const originalFields = line.agent_decision?.originalProductFields || null;

  log(`Line ${line.id} ("${line.raw_title}"):`);
  log(`  reverse ${line.received_qty} ${line.received_unit} on "${product?.name || line.product_id}" (a correction of -${line.received_qty} ${line.received_unit})`);
  if (originalFields && !isAgentCreatedProduct) {
    log(`  restore "${product?.name}"'s container_size/inventory_unit/inventory_on_hand/default_unit to what they were before the agent's restock`);
  }
  if (alias) log(`  delete product_aliases row ${alias.id} ("${alias.alias_name}")`);
  if (isAgentCreatedProduct) log(`  deactivate "${product?.name}" (agent-created) IF it carries no other movement, vendor pricing, or alias after this undo`);
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
    await trx('products_catalog').where({ id: line.product_id }).forUpdate().first('id');
    const stillUnchanged = await productUnchangedSinceAgent(trx, line, movement);
    if (!stillUnchanged.ok) throw new Error(`Refusing to reverse: ${stillUnchanged.why}.`);

    const reversal = await adjustStock(line.product_id, { movementType: 'correction', quantity: -Number(line.received_qty), unit: line.received_unit }, {
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

    if (isAgentCreatedProduct) {
      // Deactivate only while the row is still, in every visible way, the
      // agent's own throwaway create: no movement besides the one just
      // reversed, no vendor pricing a person entered, and (with the agent's
      // own alias already gone above) no alias linking any OTHER title to it.
      const stillHasMovements = await otherMovements(trx, line.product_id, [movement.id, reversal.movement.id]);
      const stillHasVendorPricing = await vendorPricingRows(trx, line.product_id);
      const stillHasOtherAliases = await otherAliases(trx, line.product_id);
      if (stillHasMovements.length === 0 && stillHasVendorPricing.length === 0 && stillHasOtherAliases.length === 0) {
        await trx('products_catalog').where({ id: line.product_id }).update({ active: false, updated_at: new Date() });
      }
    }

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
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/inventory-agent-undo.js --line=<id>');
    process.exitCode = 2;
    return;
  }
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
  const execute = process.argv.includes('--execute');
  const lineArg = arg('line', process.argv);
  if (!lineArg) {
    console.error('Usage: --line=<purchase_receipt_lines.id or its first 8 characters> [--execute]');
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
