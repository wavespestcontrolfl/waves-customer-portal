/**
 * Migration — vendor order ledger (PR 2 of the supplies auto-purchase lane)
 *
 * 1. `vendor_orders`: one row per automatic order attempt. The row is the
 *    CLAIM — `restock_request_id` is UNIQUE, so a restock request is
 *    dispatched at most once, ever; inserted `placing` BEFORE any outbound
 *    call, so a deploy overlap or a crash mid-call can never double-order.
 *    Statuses: placing → placed | failed | needs_review. A `needs_review`
 *    row is an ambiguous or refused outcome (post-submit error, cap, no
 *    price, no address) — the office resolves it by hand; `failed` is a
 *    definite pre-submit failure. A request whose ledger row is anything but
 *    absent is never auto-dispatched again — a fresh restock request is the
 *    way back in (revoke = ops/agents/auto-order-revoke.js). The FK to the
 *    request is ON DELETE RESTRICT: catalog cleanup cannot erase the ledger.
 * 2. Seeds vendor Sticker Mule (code 25; .claude/vendor-codes.md) and points
 *    the "Serviced by Waves" sticker at it. NO vendor_pricing row: the
 *    Sticker Mule item id and paid price only exist after the owner's first
 *    manual order, and the dispatcher refuses to order without an eligible
 *    price row (needs_review 'no_price'), so an unpriced sticker parks
 *    instead of ordering blind.
 *
 * down(): drops the ledger. The vendor seed is a DOCUMENTED NO-OP (the row
 * may carry the owner's API-era edits by then; waves-db §4).
 */
const STICKER_MULE = { name: 'Sticker Mule', code: 25, type: 'online', website: 'https://www.stickermule.com', notes: 'Yard-sign stickers ("Serviced by Waves" 4x5). Reorder-only API — the first order of any item is placed by hand.', scraping_priority: 'skip' };
const STICKER_NAME = 'Yard sign sticker 4x5 "Serviced by Waves"';
// The row's identity beyond its code: the name, or the website (an admin may
// have renamed the row since a prior apply).
const isStickerMule = (row) => String(row.name || '').trim().toLowerCase() === STICKER_MULE.name.toLowerCase() || String(row.website || '').toLowerCase().includes('stickermule.com');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('vendor_orders'))) {
    await knex.schema.createTable('vendor_orders', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      // RESTRICT: this is a financial ledger — deleting a product (which
      // cascades its restock requests) must fail while an order row exists,
      // never erase order numbers, charged amounts and evidence.
      t.uuid('restock_request_id').notNullable().unique().references('id').inTable('product_restock_requests').onDelete('RESTRICT');
      t.uuid('vendor_id').references('id').inTable('vendors').onDelete('SET NULL');
      t.string('adapter', 40).notNullable();
      t.string('status', 24).notNullable().defaultTo('placing');
      t.string('external_order_number', 120);
      t.integer('amount_cents');
      t.string('currency', 3).notNullable().defaultTo('USD');
      t.jsonb('request_payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.jsonb('response_payload');
      t.jsonb('evidence').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.string('error', 400);
      t.timestamp('placed_at', { useTz: true });
      t.timestamps(true, true);
      t.index(['status', 'created_at']);
      t.index(['vendor_id', 'created_at']);
    });
    await knex.raw(`
      ALTER TABLE vendor_orders
        ADD CONSTRAINT vendor_orders_status_check
        CHECK (status IN ('placing', 'placed', 'failed', 'needs_review'))
    `);
  }

  if (!(await knex.schema.hasTable('vendors'))) return;
  const hasCode = await knex.schema.hasColumn('vendors', 'code');
  // The STABLE code is the identity (an admin may have renamed the row since
  // a prior apply; down() leaves it in place) — the name is only the lookup
  // for a pre-code schema (Codex r5 P1).
  let vendor = hasCode ? await knex('vendors').where({ code: STICKER_MULE.code }).first() : null;
  // A code-25 row that is NOT Sticker Mule (the earlier vendor-code guidance
  // allowed 25 as the next appended code) is a collision, not the seed:
  // adapterKeyFor reads every code-25 row as the Sticker Mule adapter, so
  // the sticker must never be pointed at it — refuse and name the fix
  // (Codex r31 P1).
  if (vendor && !isStickerMule(vendor)) throw new Error(`vendors row "${vendor.name}" (${vendor.id}) already holds code ${STICKER_MULE.code}, which the Sticker Mule adapter owns — move it to a free code (.claude/vendor-codes.md) before applying`);
  if (!vendor) vendor = await knex('vendors').whereRaw('LOWER(name) = ?', [STICKER_MULE.name.toLowerCase()]).first();
  if (!vendor) {
    const row = { ...STICKER_MULE };
    if (!hasCode) delete row.code;
    [vendor] = await knex('vendors').insert(row).returning('*');
  } else if (hasCode) {
    if (vendor.code == null) {
      await knex('vendors').where({ id: vendor.id }).update({ code: STICKER_MULE.code });
    } else if (Number(vendor.code) !== STICKER_MULE.code) {
      throw new Error(`vendors row "${vendor.name}" has code ${vendor.code}; expected ${STICKER_MULE.code} (.claude/vendor-codes.md)`);
    }
  }

  if (!(await knex.schema.hasColumn('products_catalog', 'auto_reorder_vendor_id'))) return;
  // Only the never-configured sticker row: an admin-chosen vendor survives.
  await knex('products_catalog')
    .whereRaw('LOWER(name) = ?', [STICKER_NAME.toLowerCase()])
    .whereNull('auto_reorder_vendor_id')
    .update({ auto_reorder_vendor_id: vendor.id });
};

exports.down = async function down(knex) {
  // The Sticker Mule vendor row and the sticker's vendor pointer are left in
  // place (documented no-op — admin edits may live on them by now).
  // The ledger is financial record (order numbers, charged amounts,
  // reconciliation evidence, audit linkage): a rollback drops the table only
  // while it is EMPTY and refuses once real rows exist — archive them first
  // (pre-push P0; same retention contract the header documents).
  if (await knex.schema.hasTable('vendor_orders')) {
    const [{ count }] = await knex('vendor_orders').count({ count: '*' });
    if (Number(count) > 0) throw new Error(`vendor_orders holds ${count} automatic-order ledger row(s) — rollback refused; archive the ledger before dropping it`);
  }
  await knex.schema.dropTableIfExists('vendor_orders');
};
