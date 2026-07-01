/**
 * Bahia broadleaf label corrections + CarbonPro-L rate (owner ruling 2026-07-01).
 *
 * Corrects three catalog-label-vs-protocol conflicts on bahiagrass plus the
 * CarbonPro-L operational rate. All UPDATE/INSERT (the B2 seed already shipped in
 * #2213, so these adjust the seeded rows rather than editing the seed):
 *
 *  A) SpeedZone Southern IS labeled for bahiagrass (owner: SpeedZone Southern EW
 *     label lists bahia in the warm-season turf rate group, 0.7-1.5 fl oz/M). Add
 *     'bahia' to the catalog labeled_turf_species so the structured bahia SpeedZone
 *     rows map to a turf-labeled row. Drive XLR8 + Celsius WG are NOT added — both
 *     are genuinely bahia-excluded on their labels (handled in protocols.json, which
 *     drops them from the bahia broadleaf/crabgrass paths in this same PR).
 *
 *  B) CarbonPro-L operational default = 1.375 fl oz/M (owner: the catalog/cost-model
 *     rate, inside the 1-2 fl oz/M label range). Store the label range on the gate
 *     (min 1.0 / max 2.0); no over-app gate — it's a biostimulant.
 *
 *  C) Bahia SpeedZone: now catalog-labeled, so drop the bahiaLabelUnverified flag,
 *     keep it CONDITIONAL with the temp/stress gates + a hand-spot area cap (label:
 *     spot treatment with hand sprayers <= 1,000 sq ft/acre; larger => broadcast/zone).
 *     The structured rate is LEFT at the catalog value (1.1) because the mix math in
 *     buildWaveGuardTreatmentPlan reads products_catalog.default_rate_per_1000 (shared
 *     across turf) — a divergent structured rate would disagree with the runtime mix.
 *     The owner's bahia-preferred 1.0 (label 0.7-1.5) is recorded as gate metadata.
 *
 *  D) Bahia March broadleaf-cleanup now uses SpeedZone (was Celsius, bahia-excluded),
 *     so seed the matching conditional structured row for completion-matching.
 *
 * Idempotent; down() is a non-destructive no-op (data correction, not schema).
 */

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return Array.isArray(value) ? [...value] : { ...value };
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

async function findSpeedZoneCatalog(knex) {
  return knex('products_catalog').whereRaw('LOWER(name) LIKE ?', ['%speedzone southern%']).first();
}

exports.up = async function up(knex) {
  // ── A) SpeedZone catalog: add bahia to labeled_turf_species ──────────────────
  if (await knex.schema.hasTable('products_catalog')) {
    const sz = await findSpeedZoneCatalog(knex);
    if (sz) {
      const labeled = parseJson(sz.labeled_turf_species, []);
      if (Array.isArray(labeled) && !labeled.includes('bahia')) {
        labeled.push('bahia');
        await knex('products_catalog')
          .where({ id: sz.id })
          .update({ labeled_turf_species: JSON.stringify(labeled), updated_at: knex.fn.now() });
      }
    }
  }

  if (!(await knex.schema.hasTable('lawn_protocol_products'))) return;

  // ── B) CarbonPro-L operational rate 1.375 + label range on the gate ──────────
  const carbonRows = await knex('lawn_protocol_products').where({ product_name: 'CarbonPro-L' });
  for (const r of carbonRows) {
    const gates = parseJson(r.gates, {});
    gates.minLabelRate = 1.0;
    gates.maxLabelRate = 2.0;
    gates.rateNote = 'operational default 1.375 fl oz/M; label range 1-2 (2.0 initial/high-performance, 1.0 maintenance)';
    await knex('lawn_protocol_products')
      .where({ id: r.id })
      .update({ rate_per_1000: 1.375, gates: JSON.stringify(gates), updated_at: knex.fn.now() });
  }

  // ── C & D) Bahia SpeedZone: re-rate/gate the existing rows + seed March ───────
  const bahiaProtocol = await knex('lawn_protocols')
    .where({ grass_track: 'bahia', status: 'active' })
    .orderBy('effective_from', 'desc')
    .orderBy('created_at', 'desc')
    .first();
  if (!bahiaProtocol) return; // B2 not applied yet — nothing to correct

  const windows = await knex('lawn_protocol_windows')
    .where({ lawn_protocol_id: bahiaProtocol.id })
    .select('id', 'window_key');
  const windowIdByKey = new Map(windows.map((w) => [w.window_key, w.id]));
  const bahiaWindowIds = windows.map((w) => w.id);

  // C) existing bahia SpeedZone rows
  const szRows = await knex('lawn_protocol_products')
    .whereIn('lawn_protocol_window_id', bahiaWindowIds)
    .where({ product_name: 'SpeedZone Southern + NIS' });
  for (const r of szRows) {
    const gates = parseJson(r.gates, {});
    delete gates.bahiaLabelUnverified; // catalog now labels bahia
    gates.gateProduct = 'SpeedZone';
    gates.maxTempF = 90;
    gates.establishedTurfOnly = true;
    gates.avoidHeatStress = true;
    gates.spotAreaCapSqFtPerAcre = 1000; // label hand-spot cap; larger => broadcast/zone
    gates.bahiaPreferredRatePer1000 = 1.0; // owner default; label range 0.7-1.5
    gates.labelRateRange = '0.7-1.5 fl_oz_per_1000';
    // rate LEFT at the B2/catalog value (1.1): buildWaveGuardTreatmentPlan mixes from
    // products_catalog.default_rate_per_1000 (shared across turf), so a divergent
    // structured rate would disagree with the runtime mix. Owner's 1.0 is metadata.
    await knex('lawn_protocol_products')
      .where({ id: r.id })
      .update({ gates: JSON.stringify(gates), updated_at: knex.fn.now() });
  }

  // D) March broadleaf-cleanup SpeedZone (replaces the removed Celsius secondary)
  const marId = windowIdByKey.get('mar_n1_pre_m');
  if (marId) {
    const exists = await knex('lawn_protocol_products')
      .where({ lawn_protocol_window_id: marId, product_name: 'SpeedZone Southern + NIS' })
      .first();
    if (!exists) {
      const sz = await findSpeedZoneCatalog(knex);
      await knex('lawn_protocol_products').insert({
        lawn_protocol_window_id: marId,
        product_name: 'SpeedZone Southern + NIS',
        product_id: sz ? sz.id : null,
        role: 'post_emergent',
        application_mode: 'broadcast',
        rate_per_1000: 1.1, // catalog default_rate (mix math uses this); see Part C note
        rate_unit: 'fl_oz',
        carrier_gal_per_1000: 1,
        default_in_plan: false,
        gates: JSON.stringify({
          trigger: 'broadleaf_heavy',
          gateProduct: 'SpeedZone',
          maxTempF: 90,
          establishedTurfOnly: true,
          avoidHeatStress: true,
          spotAreaCapSqFtPerAcre: 1000,
          bahiaPreferredRatePer1000: 1.0,
          labelRateRange: '0.7-1.5 fl_oz_per_1000',
        }),
        annual_counter: JSON.stringify({}),
        mixing: JSON.stringify({}),
        report_copy: JSON.stringify({ role: 'post_emergent' }),
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }
  }

  // ── E) Correct stale bahia window goals — B1 seeded Drive XLR8 / Celsius text in
  //       the goal (and the copy inside service_report_context.goal), which
  //       getProtocolWindowContext exposes to the Tech Treatment Plan.
  const BAHIA_WINDOW_GOALS = {
    may_micros_crabgrass: 'No fert (only 2 N/yr); micros + K (irrigated only); NO bahia-safe crabgrass curative — rely on pre-emergent timing + scout/manual, nonselective spot only where turf loss is acceptable.',
    jul_seed_head: 'No broadleaf herbicide labeled on bahiagrass (defer when hot); structured seed-head customer talk (proactive, not reactive); mowing upsell if available.',
    sep_blackout_crabgrass: 'K-Flow returns (irrigated); SpeedZone weather-gated broadleaf; NO bahia-safe crabgrass curative — rely on pre-emergent timing + scout/manual, nonselective spot only where turf loss is acceptable.',
  };
  const bahiaWindowRows = await knex('lawn_protocol_windows')
    .where({ lawn_protocol_id: bahiaProtocol.id })
    .select('id', 'window_key', 'service_report_context');
  for (const row of bahiaWindowRows) {
    const goal = BAHIA_WINDOW_GOALS[row.window_key];
    if (!goal) continue;
    const src = parseJson(row.service_report_context, {});
    src.goal = goal;
    await knex('lawn_protocol_windows')
      .where({ id: row.id })
      .update({ goal, service_report_context: JSON.stringify(src), updated_at: knex.fn.now() });
  }

  // ── F) bahia gates: the shared SpeedZone heat gate recommends Celsius as the
  //       hot-season broadleaf fallback (not labeled for bahia) -> defer instead;
  //       the Celsius annual-rate gate is inert on bahia (Celsius is never applied).
  if (await knex.schema.hasTable('lawn_protocol_gates')) {
    await knex('lawn_protocol_gates')
      .where({ lawn_protocol_id: bahiaProtocol.id, gate_key: 'speedzone_heat_gate' })
      .update({
        rule_text: 'Do not apply SpeedZone Southern above 90°F; DEFER broadleaf when hot — no bahia-safe hot-season herbicide (do not substitute a non-bahia-labeled product).',
        updated_at: knex.fn.now(),
      });
    await knex('lawn_protocol_gates')
      .where({ lawn_protocol_id: bahiaProtocol.id, gate_key: 'celsius_annual_rate' })
      .del();
  }
};

exports.down = async function down() {
  // Non-destructive: these are data corrections to already-seeded rows; a rollback
  // that reverted them would re-introduce the label conflicts. up() is idempotent.
};
