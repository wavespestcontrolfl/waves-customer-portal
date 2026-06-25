# One-Time Card-on-File Hold — Go-Live Runbook

Operational runbook for enabling the one-time card-on-file hold (PR #2058,
merged `98573acfb`). The feature is **dark by default** behind the
`ONE_TIME_CARD_HOLD` env flag — merging changed nothing in production. This doc
is the procedure to turn it on safely, verify it, monitor it, and roll it back.

---

## 1. What it does (one paragraph)

When a customer books a **one-time** visit from an estimate, they save a card to
**reserve** the appointment — **no money is charged at booking**. The saved card
is charged the **final total on completion**, and a **flat $49 fee** is charged
only if the customer **no-shows or cancels within 24h**. The card requirement,
fee amount ($49), and cancel window (24h) are all configurable. The feature is
*additive* — it does not touch the separate, also-dark required-deposit system
(`ESTIMATE_DEPOSIT_REQUIRED`); a required hold supersedes the one-time deposit if
both are ever on at once.

---

## 2. Config surface (what you control)

| Knob | Where | Default | Notes |
|---|---|---|---|
| On/off | env `ONE_TIME_CARD_HOLD` | off | `true` / `1` / `on` enables. Anything else = dark. |
| No-show fee | `pricing_config.estimate_card_hold.noShowFeeAmount` | `49` | Dollars. Synced into the engine on deploy/startup or via the admin pricing path — **not** by a raw SQL edit alone (see §3). |
| Cancel window | `pricing_config.estimate_card_hold.cancelWindowHours` | `24` | Hours before the slot. Same sync caveat. |

The $49 / 24h defaults are the in-code constants — they apply with **no DB row
at all**. A `pricing_config` row is only needed to *change* them. The card-hold
path reads the in-memory `CARD_HOLD` constants, which are refreshed from
`pricing_config` only by `syncConstantsFromDB()` (on startup, or when an edit
goes through the admin pricing routes) — a raw `UPDATE`/`INSERT` is **not**
picked up until a sync/restart, so staff could see the old fee still being
frozen onto new bookings.

Amounts are **frozen onto each hold row at booking**, so changing them never
moves a fee a customer already consented to — only new bookings (after a sync)
pick up the new value.

---

## 3. Pre-flight checklist (before flipping the flag)

- [ ] **Deploy `main`.** The migration `20260624000010_estimate_card_holds.js`
      runs on deploy and creates the `estimate_card_holds` table.
- [ ] **Verify the table exists:**
      ```sql
      SELECT to_regclass('public.estimate_card_holds');  -- non-null = created
      \d estimate_card_holds
      ```
- [ ] **Confirm Stripe is healthy** (the capture uses a SetupIntent + the
      Payment Element; completion reuses `chargeInvoiceWithSavedCard`):
      `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` set, and the
      `setup_intent.succeeded` + `payment_intent.succeeded` webhook events are
      subscribed.
- [ ] **Decide the amounts.** $49 / 24h need no DB row. To change them, seed the
      row — `pricing_config` requires `name` + `category` (both NOT NULL) — and
      then **sync** (the admin pricing route only *updates* an existing key, so
      seed first):
      ```sql
      INSERT INTO pricing_config (config_key, name, category, data)
      VALUES ('estimate_card_hold', 'One-time card hold', 'estimate',
              '{"noShowFeeAmount": 49, "cancelWindowHours": 24}'::jsonb)
      ON CONFLICT (config_key) DO UPDATE SET data = EXCLUDED.data;
      ```
      Then run a sync so the engine picks it up: **restart the server**, or save
      the value once through the admin Pricing Config route (`PUT
      /api/admin/pricing-config/estimate_card_hold`), which calls
      `syncConstantsFromDB()`. A bare SQL edit without a sync stays inert.
- [ ] **Heads-up the office (Virginia) + techs:** one-time estimates will now
      require a card to book, and completing a one-time job through the billing
      completion path auto-charges that card (no driveway collection).
      No-shows/late-cancels auto-charge $49. **Important:** pest visits completed
      from the tech **recap** flow do NOT charge the hold — see §7.

---

## 4. Smoke test (do this immediately after flipping, with your own estimate)

The flag is **global** for one-time bookings — there is no per-estimate gate. The
safe way to test is to flip it on, run **one of your own** one-time estimates all
the way through, verify the rows below, then keep it on (or flip back off — fully
reversible). Use a real card you control.

1. Set `ONE_TIME_CARD_HOLD=true` and restart/redeploy the server.
2. Open a one-time estimate → pick a slot → the button should read **"Add a card
   to hold your appointment"** with the "not charged today / $49 fee" disclosure.
3. Save a card and confirm. Then check the hold landed:
   ```sql
   SELECT id, status, no_show_fee_amount, cancel_window_hours,
          scheduled_service_id, stripe_payment_method_id, agreed_at
   FROM estimate_card_holds ORDER BY created_at DESC LIMIT 5;
   -- expect one row: status='held', fee/window frozen, scheduled_service_id set
   ```
4. **Completion charge:** complete that visit via the tech "Complete" button
   (`POST /api/admin/dispatch/:serviceId/complete`). Verify:
   ```sql
   SELECT status, completion_payment_intent_id, charged_amount, charged_at
   FROM estimate_card_holds WHERE scheduled_service_id = '<ss_id>';
   -- expect status='charged_completion', a PI id, charged_amount = invoice total
   ```
5. **No-show fee:** on a *second* test booking, mark the appointment **no-show**
   from the dispatch detail sheet. Verify the fee + the ledger row:
   ```sql
   SELECT status, no_show_payment_intent_id, charged_amount
   FROM estimate_card_holds WHERE scheduled_service_id = '<ss_id>';
   -- expect status='charged_no_show', charged_amount = 49
   SELECT amount, description, metadata FROM payments
   WHERE stripe_payment_intent_id = '<no_show_pi_id>';
   -- expect a 'paid' $49 row with metadata.purpose='card_hold_no_show_fee'
   ```
6. **Cancel release:** on a third booking, cancel it **outside** the 24h window
   and confirm `status='released'` (no charge). Cancel one **inside** the window
   and confirm `status='charged_no_show'` (reason `late_cancel`).

If all six pass, you're live. If any step is off, flip the flag back off and
review the logs (grep `[estimate-card-holds]`).

---

## 5. Day-2 monitoring (run these for the first week)

**Hold state distribution** — a quick health glance:
```sql
SELECT status, count(*) FROM estimate_card_holds GROUP BY status ORDER BY 2 DESC;
```

**`charge_review` — the manual-reconcile queue (should normally be empty).**
A row lands here when Stripe took money but our DB write failed, OR on an
**ambiguous** Stripe connection/API error where no PaymentIntent id came back —
in that second case the money may NOT have moved. **Always inspect Stripe
first** (a row with null `*_payment_intent_id` columns is the ambiguous kind —
confirm whether a charge actually exists before reconciling or refunding):
```sql
SELECT id, estimate_id, scheduled_service_id, charged_amount,
       completion_payment_intent_id, no_show_payment_intent_id, updated_at
FROM estimate_card_holds WHERE status = 'charge_review';
```

**Holds stuck in `held` on already-completed jobs** (should be ~0 — completion
charges or releases them):
```sql
SELECT h.id, h.scheduled_service_id, s.status AS service_status, h.held_at
FROM estimate_card_holds h
JOIN scheduled_services s ON s.id = h.scheduled_service_id
WHERE h.status = 'held' AND s.status IN ('completed','no_show','cancelled');
```

**No-show fee revenue** — use this query as the source of truth. These fees
land as `payments.status='paid'` with no `service_record`, so they do **not**
necessarily show up in the standard revenue/P&L views (some tax/P&L paths sum
`status='completed'`, and the revenue overview reads `service_records.revenue`):
```sql
SELECT count(*), sum(amount) FROM payments
WHERE metadata->>'purpose' = 'card_hold_no_show_fee' AND status = 'paid';
```

**Log greps:** `[estimate-card-holds]` (all hold activity),
`completion charge FAILED` / `no-show fee charge` / `charge_review`.

---

## 6. Rollback

Set `ONE_TIME_CARD_HOLD=false` (or unset) and restart. Immediately:

- New one-time accepts stop requiring a card (revert to "book + pay on service
  day"). The estimate view falls back to the legacy server-HTML page.
- **In-flight holds are NOT auto-cancelled.** A booking that already captured a
  card stays `held`; its completion/no-show charge logic is gated on the flag, so
  with the flag off those charges **will not fire**. If you roll back with live
  held bookings, either (a) flip back on long enough to let them complete, or
  (b) charge/refund them manually and mark the rows `released`. Query open holds:
  ```sql
  SELECT * FROM estimate_card_holds WHERE status IN ('held','pending');
  ```

Rolling back is safe and instant for *new* bookings; the only care needed is the
handful of already-held appointments.

---

## 7. Known limitations / by-design behavior

- **⚠️ Pest "recap" completion does NOT charge the hold (important for go-live).**
  The tech portal routes **pest** jobs into the recap flow (`ServiceRecapModal`
  → `POST /api/admin/dispatch/:serviceId/pest-recap`), which is *recap-only —
  no invoicing* yet still transitions the visit to `completed`. Because no
  completion invoice is created, the card-hold completion charge never fires and
  the hold is left `held`. Since pest is the most common one-time service and
  recap is how techs complete it, **this is a real coverage gap**: either
  complete one-time card-hold pest jobs via the billing completion path (`POST
  /api/admin/dispatch/:serviceId/complete`), or land the code follow-up that
  wires charging into the recap path before relying on auto-charge for pest.
  Watch the "stuck `held` on completed jobs" query in §5 to catch these.
- **Status-dropdown "completed" doesn't charge either.** The charge fires on the
  real completion route (`POST /api/admin/dispatch/:serviceId/complete`, used by
  the tech "Complete" button and admin). The lighter admin status-dropdown →
  "completed" doesn't auto-create an invoice, so it doesn't charge — same as
  existing billing behavior.
- **Credit-card processing fee applies on completion.** Completion goes through
  the shared `chargeInvoiceWithSavedCard`, which adds the standard card surcharge
  for credit cards (debit/bank exempt). This is disclosed in the hold consent
  copy. The $49 no-show fee is charged at face value (surcharge-exempt).
- **3DS-redirect slot hold.** If a card triggers a full-page 3DS redirect, the
  captured card is carried back but the slot reservation is not re-held in the UI
  (15-min server-side reservation still stands). Same accepted behavior as the
  deposit flow. Follow-up if it proves to matter.
- **No-show fee reporting + receipt.** The fee lands as a `payments` row
  (`status='paid'`, no `service_record`), so it may not surface in the standard
  revenue/P&L views — use the §5 query as the source of truth. A customer
  receipt + a refundable fee invoice are added by the pending follow-up **PR
  #2070** (not in the merged feature this runbook describes); until that merges,
  no receipt is sent at charge time.
- **Existing plan members are not exempted** — a current WaveGuard member booking
  a one-time visit is still asked for a card hold (faithful to "all one-time
  services"). One-line change in `resolveCardHoldPolicy` to skip them if desired.

---

## 8. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| One-time accept rejected `CARD_HOLD_REQUIRED` | No captured card reached accept | Customer must complete the card modal; check the SetupIntent succeeded in Stripe. |
| One-time accept rejected `APPOINTMENT_REQUIRED` | Hold requires a booked slot | Customer must pick a time first (by design). |
| Completion didn't charge | Pest **recap** completion (no invoicing), status-dropdown completion, or invoice was prepaid/credit-covered | Confirm completion went through `POST /api/admin/dispatch/:serviceId/complete`; check `estimate_card_holds.status` (`released` = nothing owed, `held` on a completed job = the recap-path gap in §7). |
| `charge_review` row appears | Stripe charged but DB write failed, OR an ambiguous error (maybe no charge) | **Look up the PI in Stripe first.** If money moved, reconcile the `payments`/invoice state; if not (null PI columns), just clear the row. |
| No-show fee not in standard revenue report | These `paid` payment rows aren't in the `completed`/`service_records` report paths (by design today) | Use the §5 no-show fee query. If the `payments` row is missing entirely, re-deliver the `payment_intent.succeeded` webhook (the recorder is idempotent). |
| Hold stuck `pending` | Card never confirmed | Harmless; the estimate's next accept re-verifies, or it ages out with the estimate. |

---

## 9. Reference

- **Flag:** `ONE_TIME_CARD_HOLD` (read by `isCardHoldEnabled()` in
  `server/services/estimate-card-holds.js`).
- **Core service:** `server/services/estimate-card-holds.js`.
- **Migration:** `server/models/migrations/20260624000010_estimate_card_holds.js`.
- **Capture endpoint:** `POST /api/public/estimates/:token/card-hold-intent`.
- **Accept (gate + record):** `PUT /api/estimates/:token/accept`.
- **Completion charge:** `POST /api/admin/dispatch/:serviceId/complete`
  (admin-dispatch.js, after the auto-invoice).
- **Cancel/no-show triggers** (full paths — Express mounts these under `/api`):
  `PUT /api/admin/dispatch/:id/status` (no-show + cancel),
  `PUT /api/admin/schedule/:id/status` (cancel),
  `POST /api/admin/schedule/bulk-action` (cancel). These are `adminFetch`
  endpoints (auth required) — a bare `/admin/...` curl hits the SPA/404.
- **Webhooks:** `setup_intent.succeeded` (card captured) + `payment_intent.succeeded`
  with `metadata.purpose='card_hold_no_show_fee'` (fee ledger) — `stripe-webhook.js`.
- **Status flow:** `pending → held → charged_completion | charged_no_show |
  released | charge_review | failed`.
