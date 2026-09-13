# SMS "Reply STOP to opt out." policy

Owner rulings 2026-08-10 and 2026-09-11. This is the rule the two sweep
migrations implement (`20260810000060_stop_line_off_customer_transactional`,
`20260911000010_stop_line_off_remaining_transactional`).

## The mechanism is never in question

STOP is registered on the approved A2P campaign, enforced by Twilio
number-level opt-out, and detected again by
`server/services/messaging/opt-out-detector.js`. Anyone can opt out of any
message whether or not the line is printed. What follows is only about the
**visible disclosure**.

## Two tests, in this order

A template carries the line if EITHER test says yes.

**1. Is the message selling something?**
Copy that pitches a purchase — an add-on, an upgrade, a referral reward — is
marketing, and consent to service texts is not consent to marketing texts.
The recipient already being a customer does not change this; the *content*
decides.

**2. Is this our first text to someone who is not a customer yet?**
A cold first touch — an inbound caller, a lead form, a name a referrer gave
us — gets the disclosure. Once there is a booking and a relationship, later
operational texts do not.

Everything else is transactional and goes without the line. Printing it on a
receipt or an en-route text invites people to opt out of the messages they
actually need.

## Current keep-list

| Template | Why |
| --- | --- |
| `recipient_optin_request` | The CTIA opt-in copy itself. Note it is the one template that does not use the standard sentence — it reads "Reply YES to confirm, STOP to opt out, HELP for help." A search for the literal `Reply STOP to opt out` will not find it. |
| `missed_call`, `lead_auto_reply_biz`, `voicemail_quote_link`, `dropped_call_address_request`, `booking_abandonment_recovery` | Lead first contact — not a customer yet. |
| `estimate_sent`, `estimate_extended`, `estimate_followup_deposit`, `quote_wizard_booking_invite` | Estimate delivery / program entry; the recipient is often still a prospect. |
| `referral_invite` | A stranger the referrer named. |
| `referral_nudge` | A $25-off pitch — marketing content. |
| Hardcoded lawn-program-overview body in `server/routes/admin-service-outlines.js` | Sent against an estimate; audience can be `lead`. |

Two code paths already apply the rule conditionally and are correct as
written: `server/services/document-contract-delivery.js` prints the line only
when `smsPurpose` is a marketing purpose, and
`server/services/outbound-voicemail-sms.js` sets its `optout_clause` only when
there is no `customerId` — i.e. only for a stranger.

## Inactive rows that keep the line if they are ever reactivated

These are disabled in production today, so no sweep has touched them, but each
one would pass a test above the moment it went live. Treat the list as part of
the keep-list, not as leftovers to clean up:

- `estimate_followup_unviewed`, `estimate_followup_viewed`,
  `estimate_followup_final`, `estimate_followup_expiring` — estimate chasers,
  and the recipient is often still a prospect.
- `seasonal_reactivation` — a win-back pitch to a lapsed customer.
- The `cancellation_save_*` set — retention offers made to somebody on their
  way out, which is selling.

## Deliberate exceptions

`upsell_add_service` and `upsell_tier_upgrade` pitch a paid add-on to an
existing WaveGuard member, which test 1 would keep. The owner ruled on
2026-09-11 that a member hearing about their own plan is account servicing,
and had the line removed. Recorded here so it is not "fixed" back by
accident.

## Adding a template

Seed it without the line unless one of the two tests above says otherwise.
`server/tests/stop-line-off-remaining-transactional-migration.test.js` pins
both keep-lists; if a new template belongs on one, add it there too.

## Writing a sweep migration

Two traps, both found the hard way:

- **The body is not evidence of what you changed.** A row that already
  equalled your post-sweep text is indistinguishable from one you rewrote, so
  a body-only `down()` will print the line onto copy you never touched.
  Record the rows `up()` actually rewrote (`system_settings`, keyed on the
  migration's own stamp) and restore only those.
- **A DB-gated test may assert the seeded body.** Suites that run against the
  full migrated chain read the body *after* your sweep. Assert against the
  swept text, not the raw seed.
