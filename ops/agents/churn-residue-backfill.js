// MUTATES (dry-run default; pass --execute to write)
//
// Churned-account residue backfill (owner-approved 2026-08-30, PR #3618).
// Moved OUT of the deploy-time migration on codex review: a migration runs
// while the old server still serves traffic, and no table/row lock protocol
// can serialize against booking writers that never lock the customer row —
// so this data fix is a QUIET-WINDOW operator script instead. Run it when
// no bookings are being created (owner judgment); the per-customer guards,
// locks, and post-commit compensation below still protect against the
// unexpected.
//
// What it does (per account, one real transaction each):
// - scope: churned-or-inactive accounts still carrying billing residue —
//   active-while-churned, tier, rate, per-application lane, autopay flags,
//   armed next_charge_date / payment methods / failed-payment retries,
//   surviving customer_plan_rates components, or recurring_ongoing=true on
//   cancelled rows (the 2026-08-30 prod audit found 5 such accounts).
// - guards (re-run under a customers FOR UPDATE + scheduled_services SHARE
//   ROW EXCLUSIVE lock, and re-checked after writes): live series, upcoming
//   or date-exempt rescheduled visits, in-progress work, live annual-prepay
//   coverage, reprices since candidate selection — any of these skips the
//   account (it stays visible in audit-churned-accounts-live-state.js).
// - wind-down: active=false, autopay off, next_charge_date cleared, tier/
//   tier-source/rate cleared (churn_mrr snapshotted first when missing),
//   per-application lane cleared ONLY when every visit is settled, plan-rate
//   components deleted, stale recurring_ongoing flags on cancelled rows
//   cleared, payment methods + failed retries disarmed, timeline note.
// - compensation: if live state appears right after a commit anyway, the
//   exact wound-down billing identity is restored from the snapshot (only
//   while the row still carries the wound-down state) with a review note.
//
// No customer comms. Idempotent — re-runs converge.
// Run: railway run --service Postgres -- node ops/agents/churn-residue-backfill.js [--execute]

const path = require('path');

// FAIL CLOSED on the connection: without an explicit URL, pg can fall back
// to the OS-user database — a mutating script must never guess its target.
if (!process.env.DATABASE_URL && !process.env.DATABASE_PUBLIC_URL) {
  console.error('[churn-residue-backfill] DATABASE_URL / DATABASE_PUBLIC_URL not set — aborting. Run via: railway run --service Postgres -- node ops/agents/churn-residue-backfill.js');
  process.exit(1);
}
process.env.DATABASE_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const db = require(path.join(__dirname, '..', '..', 'server', 'models', 'db'));

const EXECUTE = process.argv.includes('--execute');

async function main() {
  const knex = db;
  const hasLedger = await knex.schema.hasTable('customer_plan_rates');
  const hasPrepayTerms = await knex.schema.hasTable('annual_prepay_terms');
  const hasPerAppFee = await knex.schema.hasColumn('customers', 'per_application_fee');
  const hasTierSource = await knex.schema.hasColumn('customers', 'waveguard_tier_source');
  const [{ et_today: etToday }] = (await knex.raw("SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS et_today")).rows;

  const candidates = await knex('customers')
    .where(function churnedOrInactive() {
      this.where({ pipeline_stage: 'churned' }).orWhere('active', false);
    })
    .where(function orResidue() {
      this.where(function activeChurned() {
        this.where('active', true).where('pipeline_stage', 'churned');
      })
        .orWhereNotNull('waveguard_tier')
        .orWhereRaw('COALESCE(monthly_rate, 0) > 0')
        .orWhere('billing_mode', 'per_application')
        .orWhere('autopay_enabled', true)
        .orWhereNotNull('next_charge_date')
        .orWhereExists(function staleSeriesFlag() {
          this.select(knex.raw('1')).from('scheduled_services')
            .whereRaw('scheduled_services.customer_id = customers.id')
            .where('scheduled_services.status', 'cancelled')
            .where('scheduled_services.recurring_ongoing', true);
        })
        .orWhereExists(function methodArmed() {
          this.select(knex.raw('1')).from('payment_methods')
            .whereRaw('payment_methods.customer_id = customers.id')
            .where('payment_methods.autopay_enabled', true);
        })
        .orWhereExists(function retryArmed() {
          this.select(knex.raw('1')).from('payments')
            .whereRaw('payments.customer_id = customers.id')
            .where('payments.status', 'failed')
            .whereNull('payments.superseded_by_payment_id')
            .whereNotNull('payments.next_retry_at');
        });
      if (hasLedger) {
        this.orWhereExists(function ledgerResidue() {
          this.select(knex.raw('1')).from('customer_plan_rates')
            .whereRaw('customer_plan_rates.customer_id = customers.id');
        });
      }
    })
    .select('id', 'active', 'pipeline_stage', 'waveguard_tier', 'monthly_rate', 'churn_mrr', 'billing_mode');

  console.log(`[churn-residue-backfill] ${candidates.length} candidate account(s); mode=${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);

  async function hasLiveState(dbh, customerId) {
    const [liveSeries, upcoming, inProgress, coveredTerm] = await Promise.all([
      dbh('scheduled_services')
        .where({ customer_id: customerId, recurring_ongoing: true })
        .whereNot('status', 'cancelled')
        .first('id'),
      dbh('scheduled_services')
        .where({ customer_id: customerId })
        .whereIn('status', ['pending', 'confirmed', 'scheduled', 'rescheduled'])
        .where(function dateOrRescheduled() {
          this.whereRaw("scheduled_date >= (now() AT TIME ZONE 'America/New_York')::date")
            .orWhere('status', 'rescheduled');
        })
        .first('id'),
      dbh('scheduled_services')
        .where({ customer_id: customerId })
        .where(function liveWork() {
          this.whereIn('status', ['en_route', 'on_site'])
            .orWhereIn('track_state', ['en_route', 'on_property']);
        })
        .first('id'),
      hasPrepayTerms
        ? dbh('annual_prepay_terms')
          .where({ customer_id: customerId })
          .where('term_start', '<=', etToday)
          .where('term_end', '>=', etToday)
          .first('id')
        : Promise.resolve(null),
    ]);
    return !!(liveSeries || upcoming || inProgress || coveredTerm);
  }

  let woundCount = 0;
  let skipped = 0;
  let reverted = 0;

  for (const candidate of candidates) {
    if (!EXECUTE) {
      const live = await hasLiveState(knex, candidate.id);
      if (live) {
        console.log(`  ${candidate.id}: stage=${candidate.pipeline_stage} active=${candidate.active} → SKIP (live state)`);
        continue;
      }
      // Dry-run prints EVERY planned mutation (ops/agents convention: the
      // dry run shows exactly what --execute would change).
      const [methods, retries, staleFlags, ledgerRows, uninvoiced] = await Promise.all([
        knex('payment_methods').where({ customer_id: candidate.id, autopay_enabled: true }).count({ n: '*' }).first(),
        knex('payments').where({ customer_id: candidate.id, status: 'failed' }).whereNull('superseded_by_payment_id').whereNotNull('next_retry_at').count({ n: '*' }).first(),
        knex('scheduled_services').where({ customer_id: candidate.id, status: 'cancelled', recurring_ongoing: true }).count({ n: '*' }).first(),
        hasLedger ? knex('customer_plan_rates').where({ customer_id: candidate.id }).count({ n: '*' }).first() : Promise.resolve({ n: 0 }),
        candidate.billing_mode === 'per_application'
          ? knex('scheduled_services as s').where('s.customer_id', candidate.id).where('s.status', 'completed')
            .whereNotExists(function invoiced() { this.select(1).from('invoices').whereRaw('invoices.scheduled_service_id = s.id'); })
            .first('s.id')
          : Promise.resolve(null),
      ]);
      const planned = [
        candidate.active ? 'active→false' : null,
        'autopay_enabled→false', 'next_charge_date→null',
        candidate.waveguard_tier ? `waveguard_tier ${candidate.waveguard_tier}→null (+tier_source→null)` : null,
        Number(candidate.monthly_rate) > 0 ? `monthly_rate $${Number(candidate.monthly_rate).toFixed(2)}→null${candidate.churn_mrr == null ? ' (churn_mrr snapshotted first)' : ''}` : null,
        candidate.billing_mode === 'per_application'
          ? (uninvoiced ? 'per_application lane RETAINED (completed uninvoiced visit)' : 'billing_mode+per_application_fee→null')
          : null,
        Number(methods && methods.n) > 0 ? `disable ${methods.n} payment method(s)` : null,
        Number(retries && retries.n) > 0 ? `disarm ${retries.n} failed-payment retr${Number(retries.n) === 1 ? 'y' : 'ies'}` : null,
        Number(staleFlags && staleFlags.n) > 0 ? `clear recurring_ongoing on ${staleFlags.n} cancelled row(s)` : null,
        Number(ledgerRows && ledgerRows.n) > 0 ? `delete ${ledgerRows.n} plan-rate component(s)` : null,
        'timeline note',
      ].filter(Boolean);
      console.log(`  ${candidate.id}: stage=${candidate.pipeline_stage} active=${candidate.active} → WOULD WIND DOWN:\n      - ${planned.join('\n      - ')}`);
      continue;
    }

    let wound = null;
    await knex.transaction(async (trx) => {
      const customer = await trx('customers')
        .where({ id: candidate.id })
        .forUpdate()
        .first('id', 'active', 'pipeline_stage', 'waveguard_tier', 'monthly_rate', 'churn_mrr', 'billing_mode',
          ...(hasPerAppFee ? ['per_application_fee'] : []),
          ...(hasTierSource ? ['waveguard_tier_source'] : []));
      if (!customer) return;
      if (!(customer.pipeline_stage === 'churned' || customer.active === false)) return;
      if (
        String(customer.waveguard_tier || '') !== String(candidate.waveguard_tier || '')
        || Math.round((Number(customer.monthly_rate) || 0) * 100) !== Math.round((Number(candidate.monthly_rate) || 0) * 100)
        || String(customer.billing_mode || '') !== String(candidate.billing_mode || '')
      ) return; // repriced since selection — leave to the audit script
      await trx.raw('LOCK TABLE scheduled_services IN SHARE ROW EXCLUSIVE MODE');
      if (await hasLiveState(trx, customer.id)) return;

      const update = {
        active: false,
        autopay_enabled: false,
        next_charge_date: null,
        waveguard_tier: null,
        monthly_rate: null,
        updated_at: trx.fn.now(),
      };
      if (hasTierSource) update.waveguard_tier_source = null;
      if (customer.churn_mrr == null && Number(customer.monthly_rate) > 0) update.churn_mrr = customer.monthly_rate;
      let laneCleared = false;
      let laneRetainedForUninvoiced = false;
      if (customer.billing_mode === 'per_application') {
        const completedUninvoiced = await trx('scheduled_services as s')
          .where('s.customer_id', customer.id)
          .where('s.status', 'completed')
          .whereNotExists(function invoiced() {
            this.select(1).from('invoices').whereRaw('invoices.scheduled_service_id = s.id');
          })
          .first('s.id');
        if (!completedUninvoiced) {
          update.billing_mode = null;
          if (hasPerAppFee) update.per_application_fee = null;
          laneCleared = true;
        } else {
          laneRetainedForUninvoiced = true;
        }
      }
      await trx('customers').where({ id: customer.id }).update(update);
      await trx('scheduled_services')
        .where({ customer_id: customer.id, status: 'cancelled', recurring_ongoing: true })
        .update({ recurring_ongoing: false, updated_at: trx.fn.now() });
      await trx('payment_methods')
        .where({ customer_id: customer.id })
        .update({ autopay_enabled: false });
      await trx('payments')
        .where({ customer_id: customer.id, status: 'failed' })
        .whereNull('superseded_by_payment_id')
        .whereNotNull('next_retry_at')
        .update({ next_retry_at: null });
      let planRates = [];
      if (hasLedger) {
        planRates = await trx('customer_plan_rates').where({ customer_id: customer.id }).select('*');
        await trx('customer_plan_rates').where({ customer_id: customer.id }).del();
      }
      await trx('customer_interactions').insert({
        customer_id: customer.id,
        interaction_type: 'note',
        subject: 'Churn residue backfill (2026-08-30)',
        body:
          `One-off cleanup with the cancellation engine ship: account was ${customer.pipeline_stage === 'churned' ? 'pipeline_stage=churned' : `inactive (stage ${customer.pipeline_stage || 'unset'})`} but still carried ` +
          `${customer.active ? 'active=true' : ''}${customer.active && (customer.waveguard_tier || Number(customer.monthly_rate) > 0) ? ' and ' : ''}` +
          `${customer.waveguard_tier ? `tier ${customer.waveguard_tier}` : ''}${customer.waveguard_tier && Number(customer.monthly_rate) > 0 ? ' / ' : ''}` +
          `${Number(customer.monthly_rate) > 0 ? `rate $${Number(customer.monthly_rate).toFixed(2)}` : ''}` +
          `${laneCleared ? ' (per-application lane + fee cleared)' : ''}` +
          `${laneRetainedForUninvoiced ? ' (per-application lane + fee RETAINED — a completed visit is not yet invoiced; office settles it, then clears the lane)' : ''}` +
          '. Deactivated, cleared tier/rate/plan-rate components, autopay off. No upcoming or in-progress work was live; no customer contact.',
      });
      if (await hasLiveState(trx, customer.id)) {
        const raceErr = new Error('BACKFILL_CONCURRENT_LIVE_WORK');
        raceErr.code = 'BACKFILL_CONCURRENT_LIVE_WORK';
        throw raceErr;
      }
      // laneCleared tells the compensation what billing_mode to EXPECT
      // post-wind-down (monthly_membership stays; per_application stays
      // when an uninvoiced completion retained it).
      wound = { prior: customer, planRates, expectedBillingMode: laneCleared ? null : (customer.billing_mode || null) };
    }).catch((err) => {
      if (err && err.code === 'BACKFILL_CONCURRENT_LIVE_WORK') { wound = null; return; }
      throw err;
    });

    if (!wound) { skipped += 1; console.log(`  ${candidate.id}: skipped (guards)`); continue; }
    woundCount += 1;
    console.log(`  ${candidate.id}: wound down`);

    // Compensation: live state right after commit → restore the exact
    // wound-down billing identity (only while the row still carries it).
    if (await hasLiveState(knex, candidate.id)) {
      await knex.transaction(async (trx) => {
        const current = await trx('customers')
          .where({ id: candidate.id })
          .forUpdate()
          .first('active', 'waveguard_tier', 'monthly_rate', 'billing_mode');
        // Any intervening plan-rate component is a concurrent state change:
        // restoring the old scalar over someone else's fresh ledger rows
        // would let a later reprice disagree with its components.
        const ledgerNow = hasLedger
          ? await trx('customer_plan_rates').where({ customer_id: candidate.id }).first('id')
          : null;
        const stillWoundDown = current
          && current.active === false
          && current.waveguard_tier == null
          && (current.monthly_rate == null || Number(current.monthly_rate) === 0)
          && String(current.billing_mode || '') === String(wound.expectedBillingMode || '')
          && !ledgerNow;
        let restored = false;
        if (stillWoundDown) {
          await trx('customers').where({ id: candidate.id }).update({
            active: wound.prior.active,
            waveguard_tier: wound.prior.waveguard_tier,
            monthly_rate: wound.prior.monthly_rate,
            billing_mode: wound.prior.billing_mode,
            ...(hasPerAppFee ? { per_application_fee: wound.prior.per_application_fee } : {}),
            // Provenance restores WITH the label: an auto-derived tier
            // restored without waveguard_tier_source='auto' would read as a
            // real membership and bypass label-only safeguards.
            ...(hasTierSource ? { waveguard_tier_source: wound.prior.waveguard_tier_source } : {}),
            updated_at: trx.fn.now(),
          });
          if (hasLedger && wound.planRates.length) {
            await trx('customer_plan_rates').insert(wound.planRates.map((r) => ({ ...r })));
          }
          restored = true;
        }
        await trx('customer_interactions').insert({
          customer_id: candidate.id,
          interaction_type: 'note',
          subject: restored ? 'Churn residue backfill REVERTED (2026-08-30)' : 'Churn residue backfill: live work appeared, state already changed (2026-08-30)',
          body: restored
            ? 'A booking landed while the residue backfill wound this account down — billing identity restored from the pre-clear snapshot (autopay left off). Office review: reconcile the new booking with the churned stage.'
            : 'Live work appeared right after the residue backfill wound this account down, but the billing fields no longer match the wound-down state (another writer touched them) — nothing restored automatically. Office review: reconcile pricing with the new booking.',
        });
        return restored;
      }).then((restored) => {
        if (restored) {
          reverted += 1;
          console.log(`  ${candidate.id}: REVERTED (live state appeared post-commit) — office review`);
        } else {
          console.log(`  ${candidate.id}: live state appeared post-commit but state changed — review note left, nothing restored`);
        }
      });
    }
  }

  console.log(`[churn-residue-backfill] done: ${woundCount} wound down, ${skipped} skipped, ${reverted} reverted (mode=${EXECUTE ? 'EXECUTE' : 'DRY RUN'})`);
}

main()
  .then(() => db.destroy())
  .catch((err) => {
    console.error(`[churn-residue-backfill] FAILED: ${err.message}`);
    return db.destroy().then(() => process.exit(1));
  });
