# Third-party Payer NET Statements — Go-Live Runbook

The whole payer NET-statements lane (P1 accrual → P2 close/deliver → P3 pay/settle →
P4 AR/dunning → P5 admin UI + public pay page) ships behind one env gate,
`GATE_PAYER_STATEMENTS`, **off in dev and prod**. Nothing about NET-terms payers
changes until it's flipped — a `net15`/`net30` payer is invoiced per-visit
(`due_on_receipt` behaviour) while the gate is off.

This runbook is the dry-run-first sequence to turn it on safely. It mirrors how
the auto-dispatch lane went live (gate armed → dry-run review → enable apply).

Lane PRs (all merged): P1 #1929 · P2 #1941 · P3 #1961 · P4 #1969 · P5a #1976 ·
P5b #1979. Design: `docs/design/payer-net-statements-plan.md`.

---

## 0. Pre-flight (before touching the gate)

- [ ] **Confirm all PRs are merged to `main` and deployed on Railway.**
- [ ] **Confirm the migrations ran on the Railway deploy** (they run on deploy,
      not at merge): `payers`, `payer_statements`, `invoices.payer_statement_id`,
      `payments.statement_id`/`payer_id` (nullable `customer_id`),
      `payer_statement_followups`, and the email templates
      `payer.statement.sent` + `payer.statement.followup` (incl. the CTA
      re-publish, migration `20260622000003`). Spot-check:
      `select template_key, status from email_templates where template_key like 'payer.statement.%';`
- [ ] **Confirm Stripe + SendGrid are configured** in the prod env
      (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, SendGrid key). The public
      pay page needs the publishable key from the same Stripe account.
- [ ] **Pick (or create) ONE real test payer** with `payment_terms = net30`, a
      valid `ap_email` you control, and (for the pay-page test) a billing
      contact. Do NOT use a live builder/PM account for the first run.

---

## 1. Flip the gate in a STAGING/preview env first (if available)

If there's a Railway preview/staging service, enable it there before prod:

```
GATE_PAYER_STATEMENTS=true
```

If there's no separate staging, go straight to prod but follow the
low-blast-radius test below (one test payer, one tiny statement) before any real
payer is enabled — the gate is global, so "enable for one payer only" is not a
thing; instead keep real net-terms payers from accruing material balances until
the dry-run passes (see §2).

---

## 2. Dry-run the accrual → close → deliver path (no money yet)

With the gate on:

1. **Accrual.** Complete (or back-date) a small NET-terms visit for the test
   payer so an invoice accrues to an OPEN statement. Verify in
   `/admin/payers` → open the payer → **Statements** tab shows an `Open
   (accruing)` statement with the visit line.
2. **Close & send.** In the statement row, **Close & send**. Verify:
   - the status flips `Open → Sent`,
   - the AP inbox (`ap_email`) receives the consolidated PDF statement,
   - the statement shows a due date (`close + terms`).
3. **AR view.** Open the **AR / aging** tab and the header **AR aging** dialog —
   confirm the statement appears in the right bucket and the totals match.

> If close-and-send 422s with a delivery error, the row now flips to `Closed`
> and exposes a forced **Send to AP** retry (P5a fix) — use it after fixing the
> AP email / suppression.

---

## 3. Dry-run the PUBLIC PAY PAGE — **this is the critical money test**

The pay page (`/pay/statement/:token`) had **never executed in prod** before
go-live (no local client build exists; it was verified only by static analysis +
the Codex review). It MUST be exercised end-to-end before any real payer pays
online.

From the **Sent** test statement, open its pay link (the `token` →
`https://<portal>/pay/statement/<token>`):

- [ ] **Card (credit) → settles.** Pay with a real credit card (small amount).
      Verify: the surcharge line shows, the charge lands on the **payer's**
      Stripe customer (not a homeowner), the page shows "payment is in", and
      within ~seconds the **webhook flips the statement to `Paid`** and cascades
      its child invoices to paid (check `/admin/payers` + the `payments` row has
      `customer_id = NULL`, `payer_id` set, `statement_id` set).
- [ ] **Card (debit) → no surcharge.** Confirm a debit card shows $0 surcharge.
- [ ] **ACH (`us_bank_account`).** Run a bank-transfer payment. Verify it
      confirms (billing name/email prefilled), the statement goes `processing`,
      and settles to `paid` when the ACH clears (days later — check back).
- [ ] **Failed-card → ACH switch.** Force a card finalize failure (declined test
      card), then switch to ACH. Confirm the amount charged is the **base**
      (the PI reset worked — no stale surcharge).
- [ ] **Redirect return.** If your bank/card triggers a redirect, confirm the
      return shows "payment is in" (not a false "already in progress" error) and
      that reloading a stale pay URL after the fact doesn't hide the form.
- [ ] **Offline reconcile.** On a different Sent statement, use **Record offline
      payment** (check/ACH/wire) in the admin sheet → confirm it settles + the
      amount validates against the statement total.

If any of these misbehave, **set `GATE_PAYER_STATEMENTS=false`** and report —
nothing real is billed yet.

---

## 4. Dry-run dunning (optional, time-gated)

Statement-level dunning fires `due+0 / +15 / +30` (Tue–Fri 10:15am ET) to the AP
inbox once a statement is past due. To exercise without waiting weeks, back-date
a test statement's `due_date` and run the cron path (or wait for the tick).
Verify: the AP gets the reminder (with the **Pay this statement** CTA → the pay
page), and the dunning controls (pause/resume/stop/send-now) in the admin sheet
work. Paying the statement stops the reminders.

---

## 5. Go live for real payers

Once §2–§4 pass:

- [ ] Leave `GATE_PAYER_STATEMENTS=true`.
- [ ] Set the real net-terms payers' `payment_terms` to `net15`/`net30` as
      desired (until now they were effectively `due_on_receipt`). New visits
      accrue from that point; there is **no backfill** of past invoices into
      statements.
- [ ] Watch the first real month: statements accrue → close (operator-driven via
      **Close & send**; the month-end auto-close cron is deferred) → AP pays or
      is reconciled → AR/dunning track the rest.

---

## Rollback

`GATE_PAYER_STATEMENTS=false` instantly reverts to per-visit billing for **new**
visits, and a `Sent`/`Paid` statement is a historical document that is
unaffected. No data is destroyed by toggling the gate.

**But a clean rollback is only clean if no invoice has accrued to an OPEN
statement yet.** Once invoices are attached to an OPEN statement, flipping the
gate off **strands** them rather than freeing them:

- the admin close/send/reconcile paths are gated and return `403`
  (`server/routes/admin-payers.js`), so you can't deliver the statement; and
- the individual invoice email and pay surfaces refuse any invoice carrying a
  `payer_statement_id` — and those guards are **gate-independent, fail-closed**
  (`server/services/invoice-email.js`, `server/routes/pay-v2.js`), so the child
  invoices can't be billed one-by-one either.

So those balances sit uncollectable until you act. To roll back cleanly when an
OPEN statement has already accrued lines, do one of:

1. **Drain first (preferred).** Leave the gate **on**, **Close & send** the OPEN
   statement(s), let them settle (or **Record offline payment**), then flip the
   gate off once nothing is `Open (accruing)`. During the §2/§3 dry-run this just
   means finishing the test statement you created instead of abandoning it.
2. **Detach.** If you must flip off immediately, clear `payer_statement_id` on
   the affected child invoices (and reopen/void the empty statement) so they
   become individually billable again under per-visit billing. Treat this as a
   deliberate, audited DB step — there is no UI for it.

Sanity check before flipping off:
`select id, payer_id, status from payer_statements where status = 'open';` — if
that returns rows with lines, drain or detach before rollback.

## Still deferred (not blockers for go-live)

Month-end auto-close cron (close is operator-driven), payer-portal statement
view, PO hard-enforcement, the tech "Billed to … don't collect on site" banner
(waits on the CompletionPanel rebuild).
