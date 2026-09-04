# Website quote request → in-home consultation booking link — plan

Status: **PROPOSAL, nothing built.** Scoped 2026-09-04 from the live code
in this repo and the Astro site. Owner rulings in §3 are required before
Phase 1. Everything ships dark behind a `GATE_*` flag per the standard
pattern.

## 0. The ask

When someone requests a quote from the website, send them a booking link.
The link opens the same proximity-aware picker the site already uses
(offers cluster next to Adam's existing stops), and what they book is an
in-home consultation with Adam for the service they asked about.

## 1. What already exists (verified)

The pieces are ~80% built. The gap is one specific lane.

### 1.1 Website quote surfaces (Astro repo)

| Surface | Posts to | Today's outcome |
|---|---|---|
| `QuoteForm.tsx` (hub `/quote`, home, LPs, service pages), `AskWaves.tsx`, `EstimateForm.tsx` | `POST /api/public/estimator/property-lookup` → `POST /api/public/quote/calculate` | **Priced:** price card + "Book my first visit" link + SMS `quote_wizard_booking_invite` + email with `bookingUrl`. **`quote_required` (unpriceable):** "A Waves team member will review the property details and follow up" — no link, admin bell "Estimate requested". |
| `SliderForm.tsx` (hero, contact, referrer), `LeadForm.tsx` | `POST /api/leads` (`lead-webhook.js`) | Voice call to Adam, once-ever auto-reply SMS, `new_lead` email enrollment, draft estimate **only if** readiness passes. "Consultation" / "not sure" / "general inquiry" are explicitly NOT concrete (`lead-estimate-automation.js:31-44`), so those leads get a parked clarify-ask SMS and wait for a human. No link. |

`docs/public-route-contracts.md` governs every route above.

### 1.2 The picker(s)

- **`/book` funnel** — `server/routes/booking.js` + `client/src/pages/PublicBookingPage.jsx` + Astro `BookingForm.tsx`. Anonymous, address-anchored, runs `scheduling/find-time.js` (detour-cost scoring against that day's `scheduled_services`, HQ-anchored), HMAC-signed slot offers, `capture-intent` abandonment recovery, `lead=` param that converts the lead on confirm. Service menu is a fixed server-side allowlist (`BOOKING_FUNNEL_SERVICE_DURATIONS`, `booking.js:685`): pest 60, lawn 60, mosquito 60, tree_shrub 60, termite 90, rodent 60, bora_care 90. **No consultation entry.**
- **Estimate picker** — `/api/public/estimates/:token/available-slots` → `/reserve` (15-min hold) → `/accept`. Requires an `estimates` row and runs the accept / pricing / card-capture flow. Same engine underneath.
- Both share: one active tech (tech-blind occupancy, `scheduling/occupancy.js`), 08:00–17:00 ET customer day, 120-min minimum lead, `GATE_SLOT_TRAVEL_GAP` drive+15-min buffer, `GATE_SOUTH_ZONE_DAY_FUNNEL`, `booking_config` (advance 1–14 days, lunch 12–13, `max_self_books_per_day` 3), blackout dates, rain chips.

### 1.3 The consultation itself

- **Waves Assessment** — catalog `services` row `service_key='lawn_inspection'`, renamed and converted to the single catch-all consultation by migration `20260619000002`. `completion_mode='internal_only'` (no customer report, no completion SMS, no review request), variable price / `base_price NULL`, `default_duration_minutes` 45 (seed `20260401000105`, min 30 / max 60), `portal_visibility='internal_only'`.
- Bookable today from the **leads page** (`admin-leads.js:1304 /schedule-appointment`), the admin New Appointment sheet, and the **phone/voice booking catalog**. NOT bookable from `/book` and NOT selectable on the website quote form — **owner ruling 2026-08-29** (`20260829000020`): "every quote ends at a real product".
- **Booking pre-draft** — `estimator-engine/booking-predraft.js` (`GATE_ESTIMATOR_BOOKING_PREDRAFTS`, default OFF): when an assessment is booked, an unpriced shell estimate is created quietly so Adam prices an existing draft after the walkthrough instead of starting from scratch.

### 1.4 So the gap is exactly this

The "team member will follow up" outcomes (unpriceable quote, not-sure lead)
have no self-serve next step. Everything needed to give them one exists;
nothing connects the pieces, and the consultation is deliberately not on
the public menu.

## 2. Recommendation

**Do not replace the priced path.** The instant-price → self-book-the-service
flow is proven, converts without a free site visit, and the satellite
measurements make most residential quotes priceable remotely. Sending a
consultation link to *every* quote request would (a) reverse the 2026-08-29
ruling and (b) put Adam on the road for unpaid visits he currently prices
from his desk.

**Use the consultation link where the customer is told to wait today:**

1. `quote_required` outcomes of `/api/public/quote/calculate` (manual-quote
   service line, low-confidence measurement, unit on a multi-unit parcel,
   commercial).
2. `/api/leads` submissions that fail estimate readiness because the
   service is not concrete ("not sure", "consultation", "general inquiry")
   or the address can't be resolved well enough to price.
3. Optionally (owner call): an "I'd rather have Adam walk the property
   first" secondary button under the priced result. Low cost, but it
   creates unpaid visits on jobs that would have self-booked.

**Build it on the `/book` funnel, not the estimate picker.** The `/book`
path is address-anchored, needs no `estimates` row, already carries `lead=`
and a handoff token, has signed offers and abandonment capture, and shows
the proximity copy ("A tech will be working nearby"). The estimate picker
drags in accept / pricing / card-capture logic that makes no sense for a $0
consult. One new funnel service key (`assessment`) mapped to the Waves
Assessment catalog row does it; the key is **deep-link only** so bare
`/book` still never offers it (keeps the ruling intact).

**Keep the visit on Adam's one calendar.** No separate consult calendar or
third-party scheduler; consultations must occupy `scheduled_services` so
the detour scoring, travel gap, and daily caps see them.

## 3. Owner rulings needed before Phase 1

| # | Question | Recommendation |
|---|---|---|
| R1 | Which requests get the consult link? (§2 lanes 1+2 only, or also the secondary button under priced results?) | Lanes 1+2 only for v1. |
| R2 | Are any services *always* consult-first regardless of priceability (termite treatment, WDO, rodent exclusion, bed bug, German roach, commercial)? | Termite treatment, rodent exclusion, bed bug, commercial → consult; keep inspections (`wdo_inspection`, `rodent_inspection`) as priced products. |
| R3 | Consultation block length. Catalog says 45; `/book` windows start on the hour and the arrival promise is a 2-hour window. | 60 min (matches the on-the-hour rule and leaves walkthrough + conversation time). Bump `default_duration_minutes` on the catalog row via the Service Library, not a migration. |
| R4 | Card on file for a free consult? The 2026-08-25 amendment says "card required for EVERY booking"; `/book` confirm currently books price-less without card for unpriceable shapes. | No card for consults. A $75 no-show fee on a free visit is a conversion killer; treat no-shows as a lead-quality signal instead. |
| R5 | Do consults count against `max_self_books_per_day` (3)? | Yes, they share the cap — it is Adam's day either way. Consider a separate `max_consults_per_day` (1–2) later if consults crowd out paid work. |
| R6 | Restrict consult offers to route-optimal slots only (detour ≤ 20 min), since the visit is unpaid? | Start with the same offers `/book` shows (route-fit days lead anyway); add the filter only if data shows far-flung consults. |
| R7 | Send timing: the quote invite SMS is quiet-hours exempt by ruling. Should the consult invite be? | Respect quiet hours (it is a new outbound customer SMS; send-on-next-window). |
| R8 | Lead status when a consult is booked. `/booking/confirm` flips the lead to `won` when `lead=` rides the link — wrong for a consult (no revenue yet). | Consult booking → `contacted` + `lead_activities` row `consultation_booked`; `won` stays tied to estimate acceptance / service booking. |
| R9 | Existing customers who submit a quote form hit the early return in `lead-webhook.js:563` (no lead row, no automation). Include them? | Out of scope for v1; they already have a rep relationship. |

## 4. Design

### 4.1 Funnel: `assessment` service on `/book` (portal)

- `server/routes/booking.js`: add `assessment` to `BOOKING_FUNNEL_SERVICE_DURATIONS` (R3), `BOOKING_FUNNEL_SERVICE_LABELS` ("In-Home Consultation"), aliases (`consultation`, `waves_assessment`, `lawn_inspection`). Catalog link on confirm: `service_id` + `service_key_snapshot` → the `lawn_inspection` row (resolve by key at request time, same as `booking-predraft.js`), `service_type: 'Waves Assessment'` so the completion resolver, tagger, and pre-draft hook match. `is_recurring:false`, no `estimated_price`, no series seeding, no pay-at-visit pricing branch.
- Deep-link only: `GET /booking/config` does not list it; `normalizeBookingServiceKey` accepts it so `?service=assessment` works. `/availability` and `/find-slots` work unchanged (duration comes from the server map).
- Confirm side: skip the card-hold / pricing branches (R4); apply the lead-status rule (R8) keyed on the resolved service key, not on a client flag; new `source` values `quote-consult` and `lead-consult` (add to the `/booking/sources` list and `lead_sources` matching so attribution lands).
- Existing behaviors that stay ON and are correct for a consult: signed offers, occupancy lock + conflict probe, travel gap, zone funnel, daily caps (R5), abandonment `capture-intent`, confirmation SMS from the existing confirm path, appointment tagger, pre-visit brief.
- Turn on `GATE_ESTIMATOR_BOOKING_PREDRAFTS` alongside this: every website-booked consult then seeds a shell draft estimate (source `booking_assessment`) so the post-visit step is "price the draft, send it", and the customer lands on the existing estimate picker to book the actual service.

### 4.2 Link minting + sending (portal)

- One builder, `services/consultation-booking-link.js`: `buildConsultationBookingUrl({ leadId, serviceLabel, source })` → `${PORTAL_BASE_URL}/book?service=assessment&source=…&lead=<id>&service_label=<what they asked for>` through `shortenOrPassthrough` (`kind:'booking'`, entity `leads`) so click attribution works like the quote invite. No handoff token needed (no estimate) unless `GATE_BOOKING_CUSTOMERS_ONLY` is ever flipped in prod, in which case mint the same pass the quote invite mints.
- Gate: `GATE_CONSULTATION_BOOKING_LINK` (strict `=== 'true'`, read at call time; unset = kill; off = byte-identical responses and copy).
- Wire points:
  - `public-quote.js` `quote_required` branch (~`:3005`): build the URL, pass it as `bookingUrl` to `sendQuoteRequestEmail` with a consult-specific `nextStepSummary`, return it as `consult_booking_url` on the 202 payload, and send SMS template `consultation_booking_invite` (new `sms_templates` row, **inactive by default**, DB-editable, renders via `renderRequiredSmsTemplate`, entry point `public_quote_consult_sms`).
  - `lead-webhook.js` readiness-blocked branch (~`:970-1035`): when `missing` includes `specific_service` (R1/R2 rule via a small pure helper next to `hasConcreteServiceInterest`), send the same invite **instead of** parking the clarify ask; other `missing` reasons keep today's clarify path.
- Admin: bell title for these cases becomes "Consult link sent — awaiting booking" (same `new_lead` trigger, different title/metadata) so Adam/Virginia know not to call first. Lead card shows the sent link and, once booked, the appointment.
- Watcher: reuse the existing `lead-staleness` sweep; add a `consult_link_sent`/`consult_booked` `lead_activities` pair so the sweep and the Leads page can distinguish "invited, never booked" (follow-up candidate) from "booked".

### 4.3 Website copy (Astro repo)

- `BookingForm.tsx`: accept `?service=assessment` in `resolveService()` with a consult-specific hero ("Book your free in-home consultation — Adam walks the property with you and follows up with a written quote"), 60-min duration, and a confirmation card that says what happens next (walkthrough → written estimate → book online). Not in the visible service menu.
- `QuoteForm.tsx` `requested` stage and `AskWaves.tsx` `callback` stage: when the response carries `consult_booking_url`, render "Book a free in-home consultation →" as the primary CTA above "Call".
- `SliderForm.tsx` / `LeadForm.tsx` success cards: copy only ("check your texts for a link to pick a time") — the link itself arrives by SMS/email from the portal, since these forms don't get a synchronous URL back today. (Returning `consult_booking_url` from `/api/leads` is a small contract change; do it in Phase 3 if the SMS-only path shows a drop-off.)
- Keep all copy token-clean for spokes (`{{brandShort}}`); the link is the hub portal either way.

### 4.4 After the visit

- Completion of a Waves Assessment stays `internal_only` (no report, no review request). The pre-drafted estimate is Adam's to price; the existing promised-estimate watcher (`scheduler.js:1326`) should treat a completed consult with an unsent draft as a promised quote — verify it keys on `booking_assessment` drafts, extend if not.
- Estimate send → customer books the service on the existing estimate picker. Lead → `estimate_sent` → `won` through today's paths.

## 5. Phases

| Phase | Scope | Repo | Ships |
|---|---|---|---|
| 0 | Rulings R1–R9 | — | — |
| 1 | `assessment` funnel key on `/book` (server map, catalog link, confirm branches, sources, lead status), `BookingForm.tsx` deep-link + copy | portal + astro | dark (key is deep-link only; nothing links to it yet) |
| 2 | Link builder, gate, SMS template row (inactive), email `nextStepSummary`, wire into `quote_required` and readiness-blocked lanes, bell title | portal | dark (`GATE_CONSULTATION_BOOKING_LINK`) |
| 3 | `consult_booking_url` on the 202 payload; QuoteForm / AskWaves CTA; SliderForm/LeadForm copy | astro + portal | dark (renders only when URL present) |
| 4 | Flip: activate the SMS template, set the gate, set `GATE_ESTIMATOR_BOOKING_PREDRAFTS`; verify first sends; watch metrics | prod | live |

Phase 1 and 2 are each one PR. Contract edits required in the same PRs:
`docs/public-route-contracts.md` (`/api/booking/*` new service + sources,
`/api/public/quote/calculate` new response field, `/api/leads` behavior
change under the gate) and the `sms_templates` migration.

## 6. Tests that must exist

- `booking.js`: `assessment` resolves to the catalog row, duration is server-pinned (client minutes ignored), signed offer scope includes the duration, no pricing/card branch runs, lead status lands per R8, bare `/config` never lists it.
- `public-quote.js`: gate off → payload byte-identical; gate on + `quote_required` → URL present, SMS attempted only with an active template, quiet hours respected (R7).
- `lead-webhook.js`: readiness blocked on `specific_service` → invite path, no clarify ask parked; other `missing` reasons → unchanged.
- Astro: `resolveService('assessment')` deep-link renders consult copy; menu snapshot unchanged.

## 7. Metrics (define before the flip)

- Consult links sent → `/book` opened → booked (funnel canary already exists for `/book` entries; add the two new sources).
- Consult booked → estimate sent → accepted, and days between each.
- Detour minutes of consult bookings vs paid bookings (from `find-time` insertion data on the confirm).
- No-show rate on consults (feeds R4 revisit).

## 8. Alternatives considered

- **Reuse the estimate picker by minting a $0 estimate** — rejected: drags a free visit through accept / card / pricing logic and pollutes estimate metrics with non-quotes.
- **Send the consult link on every quote request** — rejected for v1 (reverses the 2026-08-29 ruling, unpaid visits on remotely-priceable jobs). Revisit with the funnel data.
- **External scheduler for Adam's consults** — rejected: breaks the one-calendar occupancy model the whole scheduling stack assumes.

## 9. Key files

Portal: `server/routes/booking.js`, `server/routes/public-quote.js`,
`server/routes/lead-webhook.js`, `server/services/lead-estimate-automation.js`,
`server/services/estimator-engine/booking-predraft.js`,
`server/services/scheduling/find-time.js`, `server/config/feature-gates.js`,
`docs/public-route-contracts.md`, `client/src/pages/PublicBookingPage.jsx`.
Astro: `src/components/BookingForm.tsx`, `src/components/QuoteForm.tsx`,
`src/components/AskWaves.tsx`, `src/components/SliderForm.tsx`,
`src/components/LeadForm.tsx`, `src/pages/book.astro`.
