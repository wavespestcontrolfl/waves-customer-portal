#!/usr/bin/env node
// MUTATES (dry-run default)
//
// inventory-agent-undo.js — reverses ONE inventory-agent decision
// (a purchase_receipt_lines row the agent logged, agent_decision set):
//   - reverses the stock movement through adjustStock with a correction of
//     -received (never deletes/edits the original movement — same ledger
//     discipline as every other stock write in this codebase);
//   - deletes the agent-created product_aliases row, if any;
//   - deactivates the agent-CREATED catalog product (never an existing one
//     the agent merely restocked), but ONLY when, after the reversal, it
//     carries no other movement;
//   - marks the line 'agent_unsure' with agent_decision.undoneAt.
// Refuses — dry run or --execute — when a movement on the product landed
// AFTER the agent's own: usage, another restock, a manual count. Reversing
// past that point would not cleanly restore the pre-agent state.
//
//   railway run --service Postgres node ops/agents/inventory-agent-undo.js --line=<id|8-char-prefix>            # dry run
//   railway run --service Postgres node ops/agents/inventory-agent-undo.js --line=<id|8-char-prefix> --execute  # apply
//
// Run from the repo root (resolves the server's modules). Output carries
// ids, product/alias names and quantities only.
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/inventory-agent-undo.js --line=<id>');
  process.exit(2);
}
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
const path = require('path');
const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));
const { adjustStock } = require(path.join(__dirname, '..', '..', 'server', 'services', 'inventory-operations'));

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const EXECUTE = process.argv.includes('--execute');
const LINE = arg('line');
if (!LINE) {
  console.error('Usage: --line=<purchase_receipt_lines.id or its first 8 characters> [--execute]');
  process.exit(2);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Exact id, or a prefix (the same first-8-characters the "logged" bell
// prints — see inventory-agent.js's applyDecision).
async function findLine(conn) {
  if (UUID_RE.test(LINE)) return conn('purchase_receipt_lines').where({ id: LINE }).first();
  const matches = await conn('purchase_receipt_lines').whereRaw('id::text LIKE ?', [`${LINE.toLowerCase()}%`]);
  if (matches.length > 1) {
    console.error(`"${LINE}" matches ${matches.length} lines — be more specific:`);
    for (const m of matches) console.error(`  ${m.id}  (${m.status}) "${m.raw_title}"`);
    process.exit(2);
  }
  return matches[0] || null;
}

// Any movement on this product strictly after the agent's own — other than
// `excludeIds` (the agent's own movement, and, once inserted, the reversal
// correction itself) — makes a clean reversal unsafe.
async function laterMovements(conn, productId, afterCreatedAt, excludeIds) {
  return conn('product_inventory_movements')
    .where({ product_id: productId }).whereNotIn('id', excludeIds).where('created_at', '>', afterCreatedAt);
}

async function main() {
  const line = await findLine(db);
  if (!line) {
    console.error(`No purchase_receipt_lines row matches "${LINE}".`);
    process.exit(2);
  }
  if (!line.agent_decision) {
    console.error(`Line ${line.id} was never decided by the inventory agent (agent_decision is null) — nothing to undo.`);
    process.exit(2);
  }
  if (line.status !== 'logged') {
    console.error(`Line ${line.id} is "${line.status}", not "logged" — nothing was moved, nothing to reverse.`);
    process.exit(2);
  }
  if (!line.movement_id || !line.product_id) {
    console.error(`Line ${line.id} has no movement/product recorded — nothing to reverse.`);
    process.exit(2);
  }

  const movement = await db('product_inventory_movements').where({ id: line.movement_id }).first();
  if (!movement) {
    console.error(`Movement ${line.movement_id} referenced by the line no longer exists.`);
    process.exit(2);
  }
  const later = await laterMovements(db, line.product_id, movement.created_at, [movement.id]);
  if (later.length) {
    console.error(`Refusing: ${later.length} later movement(s) on this product since the agent's own restock — reversing now `
      + `would not cleanly restore the pre-agent count. Movement id(s): ${later.map((m) => m.id).join(', ')}`);
    process.exit(1);
  }

  const product = await db('products_catalog').where({ id: line.product_id }).first();
  const alias = line.agent_created_alias_id ? await db('product_aliases').where({ id: line.agent_created_alias_id }).first() : null;
  const isAgentCreatedProduct = Boolean(line.agent_created_product_id) && line.agent_created_product_id === line.product_id;

  console.log(`Line ${line.id} ("${line.raw_title}"):`);
  console.log(`  reverse ${line.received_qty} ${line.received_unit} on "${product?.name || line.product_id}" (a correction of -${line.received_qty} ${line.received_unit})`);
  if (alias) console.log(`  delete product_aliases row ${alias.id} ("${alias.alias_name}")`);
  if (isAgentCreatedProduct) console.log(`  deactivate "${product?.name}" (agent-created) IF it carries no other movement after this undo`);
  console.log('  set the line\'s status to agent_unsure, stamping agent_decision.undoneAt');
  if (!EXECUTE) {
    console.log('\nDry run — pass --execute to apply.');
    return;
  }

  await db.transaction(async (trx) => {
    const lockedLine = await trx('purchase_receipt_lines').where({ id: line.id }).forUpdate().first();
    if (!lockedLine || lockedLine.status !== 'logged' || lockedLine.movement_id !== line.movement_id) {
      throw new Error('The line changed since the dry run — re-run to see the current state before undoing.');
    }
    await trx('products_catalog').where({ id: line.product_id }).forUpdate().first('id');
    const stillLater = await laterMovements(trx, line.product_id, movement.created_at, [movement.id]);
    if (stillLater.length) throw new Error('A later movement landed since the dry run — refusing to reverse.');

    const reversal = await adjustStock(line.product_id, { movementType: 'correction', quantity: -Number(line.received_qty), unit: line.received_unit }, {
      source: 'inventory_agent_undo', extraMetadata: { undoOfLineId: line.id, undoOfMovementId: movement.id }, trx,
    });

    if (alias) await trx('product_aliases').where({ id: alias.id }).del();

    if (isAgentCreatedProduct) {
      const stillHasMovements = await laterMovements(trx, line.product_id, new Date(0), [movement.id, reversal.movement.id]);
      if (stillHasMovements.length === 0) {
        await trx('products_catalog').where({ id: line.product_id }).update({ active: false, updated_at: new Date() });
      }
    }

    await trx('purchase_receipt_lines').where({ id: line.id }).update({
      status: 'agent_unsure',
      agent_decision: { ...(line.agent_decision || {}), undoneAt: new Date().toISOString() },
      agent_decided_at: new Date(),
    });
  });
  console.log('Done.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
