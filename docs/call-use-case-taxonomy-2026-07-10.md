# Canonical Call Use-Case Taxonomy — merged from 625 transcripts (4 discovery agents) + prior-session memory
Counts = approximate occurrences across the 625-transcript corpus (one call can hit several). Citations live in the per-slice agent outputs.

## FAMILY A — Revenue acquisition (route to: booked / estimate_send / lead_followup)
- A1 new-service quote: recurring pest (~84), lawn program (~27), mosquito (~7), bundle requests
- A2 targeted one-time treatment: ants(13) rodents(37) termites(35) roaches, wasps/bees(9), fleas, black widows, bed bugs(8), springtails
- A3 WDO inspection / real-estate closing (~24) — HARD DEADLINES (inspection periods, key handovers, VA loans)
- A4 pre-construction termite treatment / pre-pour (~20) — contractor coordination against concrete-pour schedules
- A5 treatment CERTIFICATE for building inspector (5+) — sticker/paperwork is the deliverable, not just the spray
- A6 commercial / HOA / condo association (~21) — multi-unit bids, board approval cycles, per-unit written reports, COI/licensing prereqs
- A7 new-homeowner onboarding (~21) + new-to-Florida education (4) — closing-date-anchored starts
- A8 move-in / pre-occupancy treatment (5), Airbnb/STR turnarounds (12) — guest-window scheduling
- A9 same-day/urgent dispatch (~41) — "going elsewhere if you can't come today"
- A10 competitor-switch leads (~32) — dissatisfaction context = sales intel + service_notes
- A11 quote-acceptance callbacks (2) + estimate clarification (13) + price negotiation/match (8+) + discounts (military/first-responder/veteran 5-15%)
- A12 vehicle/vessel treatment (4): cars, trucks, 70-ft yacht
- A13 exclusion/repair add-ons (8): sealing, steel mesh, attic insulation, gutter guards

## FAMILY B — Existing-customer service ops (route to: existing_customer_routed / reservice / reschedule)
- B1 appointment confirmation "are you coming?" (~33) + ETA/window asks (10) + arrival-notice prefs (5) → GPS-link answerable
- B2 reschedule/move (19) + customer cancellation (11) + BUSINESS-initiated reschedule (3)
- B3 free re-service / guarantee callbacks (18) — fire ants, webs, roaches between visits
- B4 no-show / late complaints (~32) — top churn driver; needs instant escalation
- B5 recurring-visit scheduling (9) + weather/rain questions (6+)
- B6 seasonal/snowbird handling (~20): pause, exterior-only-while-away, partial-year programs, prep-for-arrival
- B7 promised quote/callback/report NEVER ARRIVED (~29!) — self-inflicted; the #1 fixable leak
- B8 invoice/report/receipt delivery chases (13) + "do I owe?" (2)

## FAMILY C — Money (route to: billing flows, never triage)
- C1 portal/payment failures (12+): Stripe element errors, bank-link failures, frozen links, 404s — calls exist BECAUSE the portal broke
- C2 CC surcharge objection → fee-free ACH path demanded (4)
- C3 alternative payment offers: Zelle/check/cash/phone-card (6)
- C4 prepay-annual interest (10) + plan/tier confusion (8) + billing errors incl. cancelled-but-billed (3)
- C5 pay-at-closing / third-party payer (4) + W9/COI vendor paperwork (3)
- C6 autopay/ACH setup (5) + erroneous autopay texts to wrong recipients (2)

## FAMILY D — Data the pipeline must WRITE (owner directive; today extracted-then-dropped)
- D1 gate codes / lockboxes / guard-house / entry instructions (~19) → property_preferences
- D2 pets on property + product-safety context (~29 safety questions, 8 pet disclosures) → property_preferences + visit prep
- D3 contact/channel preferences: do-not-ring, text-not-email, call-before-arrival, night-shift-no-contact (~10) → notification prefs
- D4 secondary contacts: spouse/partner (15), family-manages-account (5), third-party arrangers (8), add-to-notifications (2) → #2534 slots + enrollment
- D5 tenant/landlord/PM coordination (~17): authorization chains, tenant notification enrollment
- D6 multi-property owners (8) → customer_properties
- D7 availability windows / blackout times (~11) → scheduling prefs
- D8 third-party report delivery (10): realtor/lender/buyer emails on WDO + closing docs
- D9 internal notes: DIY history (11), competitor context, health context (immune-compromised, pregnant, elderly), referral source (9 incl. ChatGPT×2!)
- D10 photo/video SMS intake (13) — caller texts evidence to the business number; needs linking to the customer/lead

## FAMILY E — Non-revenue terminal (route to: vendor_logged / wrong_number_closed / spam_discarded / applicant_logged)
- E1 vendor/B2B solicitation (~31) + preferred-vendor-list promoters + collections cold-calls
- E2 robocalls/spam (~20)
- E3 wrong number / competitor brand confusion (13): Venice Pest Control, "Waynes", Parrish Lawn domain confusion
- E4 job applicants (12) — point to careers page; page reported vague
- E5 out-of-scope declines (~26): mowing, tenting, snakes, bats, dead wildlife, love bugs/midges (honest can't-treat) — REFERRAL opportunity (Advent)
- E6 out-of-area (~13): service-area check (Arcadia/Ruskin/Tampa/St Pete no)
- E7 genuine partnership offers (mold remediation mutual referral) — log separately from spam

## FAMILY F — Trust/edge (route to: complaint_escalation / human)
- F1 legal/safety/irate: none observed in 625 → the RED path is rare, as designed
- F2 spoofed-number report (1), unlicensed-tech legitimacy question (1)
- F3 Spanish/limited-English (~7 + 17 language flags) — currently unserved; lost leads
- F4 system-migration comms errors (9+): wrong-name texts, 6:15AM notifications, erroneous invoices — self-inflicted trust damage
- F5 dead-air/no-message voicemails (22 in one slice) — missed-call recapture lane
- F6 receptionist-relay limitations (10): fill-in answerer can't quote/schedule/bill → callback queue that must not die

## Notable operational intel (one-offs worth keeping)
ChatGPT cited as referral source twice; Google's automated AI shopper price-checks on recorded lines; competitor's AI agent distrusted by a landlord ("say ooga booga"); Adam already TELLS callers the CRM captures from recordings; holiday/Sunday work surprises customers (retention moment); estimate-portal bug reports arrive via phone (deselect-option price bug); "did my husband already call" dedup checks.
