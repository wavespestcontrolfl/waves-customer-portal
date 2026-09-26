'use strict';

/**
 * Customer copy audit (2026-09-26) — Automations-tab sequence emails and
 * their companion SMS (automation_steps, automation_templates.sms_template).
 *
 * new_lead (267 sends in 90 days) and estimate_sent (213) are the busiest
 * emails Waves sends that no one had re-read since they were seeded:
 *  - "Based right here in Bradenton" — the office is in Lakewood Ranch
 *    (server/config/locations.js).
 *  - "Free re-services" was promised to every lead and every estimate; the
 *    guarantee belongs to recurring plans (estimate-followup-copy.js scopes
 *    it the same way). "Price is locked in" now says until the estimate
 *    expires, matching FAQ_PRICE.
 * Manual-trigger sequences carried claims nothing backs:
 *  - cold_lead: "the quote we gave you is still good" (estimates expire),
 *    "first-month service is flat-rate", "fit you in within a few days".
 *  - payment_failed: "we'll retry in 3 business days", "no late fee".
 *  - pricing_update: "starting with your next service" (no advance notice),
 *    "below what the national chains charge", "same tech".
 *  - referral_nudge: "mention your name ... no cap" — the program runs on
 *    the portal referral link, and both sides get a $25 account credit
 *    only after the referee's first RECURRING service completes
 *    (creditReferralOnFirstService in referral-engine.js).
 *  - review_thank_you_*: "this morning" — the send has no time-of-day.
 *  - service_renewal preview said "Nothing changes automatically" over a
 *    body that says service continues unchanged.
 *  - lawn_service: "water 1–2x per week" ignores county restrictions.
 * Companion SMS lose the "Let's get your home bed bug-free" promise and the
 * em dashes that force UCS-2.
 *
 * Exact-value CAS on each field: anything an administrator has edited since
 * the audit read is left alone.
 */

const MIGRATION = '20260926120200_customer_copy_audit_automations';

const STEP_SWAPS = [
  {
    "key": "new_lead",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — thanks for your interest in Waves</h2>\n<p>We're a family-owned pest control and lawn care company based right here in Bradenton. Our trucks run Manatee, Sarasota, and Charlotte counties — and our techs are the ones you'll actually see at your door.</p>\n\n<h2>How we work</h2>\n<ul>\n  <li><strong>No commitment contracts.</strong> You can pause or cancel anytime.</li>\n  <li><strong>No up-sells at the door.</strong> Quotes come from the office, not from whoever's at your house.</li>\n  <li><strong>Free re-services.</strong> If you see activity between visits, we come back — no extra charge.</li>\n</ul>\n\n{{consultation_booking}}\n<h2>What's next</h2>\n<p>If you'd like a quote or a free inspection, just reply to this email with your address and a good time for us to swing by. Or give us a call at <a href=\"tel:+19412975749\">(941) 297-5749</a>.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Hi {{first_name}} — thanks for your interest in Waves</h2>\n<p>We're a family-owned pest control and lawn care company based right here in Lakewood Ranch. Our trucks run Manatee, Sarasota, and Charlotte counties — and our techs are the ones you'll actually see at your door.</p>\n\n<h2>How we work</h2>\n<ul>\n  <li><strong>No commitment contracts.</strong> You can pause or cancel anytime.</li>\n  <li><strong>No up-sells at the door.</strong> Quotes come from the office, not from whoever's at your house.</li>\n  <li><strong>Free re-services on recurring plans.</strong> If pests come back between scheduled visits, so do we — no extra charge.</li>\n</ul>\n\n{{consultation_booking}}\n<h2>What's next</h2>\n<p>If you'd like a quote or a free inspection, just reply to this email with your address and a good time for us to swing by. Or give us a call at <a href=\"tel:+19412975749\">(941) 297-5749</a>.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "key": "new_lead",
    "field": "text_body",
    "before": "Hi {{first_name}} — thanks for your interest in Waves. We're a family-owned pest control + lawn care company in Bradenton, serving Manatee, Sarasota, and Charlotte counties. No commitment contracts. No door-step upsells. Free re-services between visits. {{consultation_booking_text}}\nReply with your address and a good time and we'll swing by, or call (941) 297-5749. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — thanks for your interest in Waves. We're a family-owned pest control + lawn care company in Lakewood Ranch, serving Manatee, Sarasota, and Charlotte counties. No commitment contracts. No door-step upsells. Free re-services between visits on recurring plans. {{consultation_booking_text}}\nReply with your address and a good time and we'll swing by, or call (941) 297-5749. — The Waves Pest Control team"
  },
  {
    "key": "estimate_sent",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — thanks for considering Waves</h2>\n<p>We sent your estimate over a couple of hours ago and wanted to follow up personally. No sales pitch — just making sure it landed and answering anything you're wondering about.</p>\n\n<h2>A few things folks usually ask</h2>\n<ul>\n  <li><strong>When can I start?</strong> Whenever. Most new customers pick a start date within 1–2 weeks.</li>\n  <li><strong>Am I locked in?</strong> No. We don't do commitment contracts — you can pause or cancel anytime.</li>\n  <li><strong>What if I see activity between visits?</strong> Free re-service. Reply to a service reminder text and we're back out.</li>\n  <li><strong>Is the price locked in?</strong> Yes, for the quoted service. We'll always tell you before anything changes.</li>\n</ul>\n\n<p>If you've got a question that's not on that list, just reply to this email. It goes straight to our team in Bradenton — no call center, no ticket queue.</p>\n\n<p>— The Waves Pest Control team</p>",
    "after": "<h2>Hi {{first_name}} — thanks for considering Waves</h2>\n<p>We sent your estimate over a couple of hours ago and wanted to follow up personally. No sales pitch — just making sure it landed and answering anything you're wondering about.</p>\n\n<h2>A few things folks usually ask</h2>\n<ul>\n  <li><strong>When can I start?</strong> Whenever. Most new customers pick a start date within 1–2 weeks.</li>\n  <li><strong>Am I locked in?</strong> No. We don't do commitment contracts — you can pause or cancel anytime.</li>\n  <li><strong>What if I see activity between visits?</strong> On recurring plans, re-services between visits are free — reply to a service reminder text and we're back out.</li>\n  <li><strong>Is the price locked in?</strong> Yes — for the quoted service, your price holds until the expiration date on your estimate. We'll always tell you before anything changes.</li>\n</ul>\n\n<p>If you've got a question that's not on that list, just reply to this email. It goes straight to our local team — no call center, no ticket queue.</p>\n\n<p>— The Waves Pest Control team</p>"
  },
  {
    "key": "estimate_sent",
    "field": "text_body",
    "before": "Hi {{first_name}} — thanks for considering Waves. No sales pitch, just a quick follow-up to make sure the estimate landed. A few common questions: you can start whenever (most folks pick 1–2 weeks out); no commitment contracts, pause/cancel anytime; free re-service between visits if you see activity; price is locked in for the quoted service. Reply with any questions — it goes straight to our team in Bradenton. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — thanks for considering Waves. No sales pitch, just a quick follow-up to make sure the estimate landed. A few common questions: you can start whenever (most folks pick 1–2 weeks out); no commitment contracts, pause/cancel anytime; free re-service between visits on recurring plans; your price holds for the quoted service until the estimate expires. Reply with any questions — it goes straight to our local team. — The Waves Pest Control team"
  },
  {
    "key": "cold_lead",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — no pressure, just checking in</h2>\n<p>We understand timing doesn't always work out. If pests or lawn issues pick up later, a few things worth knowing:</p>\n\n<ul>\n  <li>The quote we gave you is still good — no need to re-do paperwork</li>\n  <li>First-month service is flat-rate; no hidden fees, no commitment</li>\n  <li>We're local to Bradenton — if you're in Manatee, Sarasota, or Charlotte counties we can usually fit you in within a few days</li>\n</ul>\n\n<p>If now's not the right time, that's fine — we're not going anywhere. Reply here whenever you're ready, or just delete this email.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Hi {{first_name}} — no pressure, just checking in</h2>\n<p>We understand timing doesn't always work out. If pests or lawn issues pick up later, a few things worth knowing:</p>\n\n<ul>\n  <li>Reply and we'll refresh your quote — no need to start over</li>\n  <li>Our recurring plans have no long-term contract</li>\n  <li>We're local to Lakewood Ranch and serve Manatee, Sarasota, and Charlotte counties</li>\n</ul>\n\n<p>If now's not the right time, that's fine — we're not going anywhere. Reply here whenever you're ready, or just delete this email.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "key": "cold_lead",
    "field": "text_body",
    "before": "Hi {{first_name}} — no pressure, just checking in. If pests or lawn issues pick up: your original quote is still good, first month is flat-rate, no commitment, and we can usually fit you in within a few days across Manatee/Sarasota/Charlotte. Reply when you're ready, or delete this email. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — no pressure, just checking in. If pests or lawn issues pick up: reply and we'll refresh your quote, our recurring plans have no long-term contract, and we serve Manatee, Sarasota, and Charlotte counties. Reply when you're ready, or delete this email. — The Waves Pest Control team"
  },
  {
    "key": "payment_failed",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — quick billing note</h2>\n<p>Your autopay payment for your Waves service didn't go through. This usually means:</p>\n\n<ul>\n  <li>The card on file expired or was replaced</li>\n  <li>The bank flagged it as an unusual charge</li>\n  <li>There was a temporary processor hiccup</li>\n</ul>\n\n<h2>What to do</h2>\n<p>Log into your portal to update your card, or reply to this email and we'll send a secure payment link. We'll retry the charge automatically in 3 business days — no need to do anything if you've already fixed it.</p>\n\n<p>No service interruption right now, and no late fee. Just wanted you to know.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Hi {{first_name}} — quick billing note</h2>\n<p>Your Auto Pay payment for your Waves service didn't go through. This usually means:</p>\n\n<ul>\n  <li>The card on file expired or was replaced</li>\n  <li>The bank flagged it as an unusual charge</li>\n  <li>There was a temporary processor hiccup</li>\n</ul>\n\n<h2>What to do</h2>\n<p>Log into your portal to update your card, or reply to this email and we'll send a secure payment link. If you've already updated it, you're all set.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "key": "payment_failed",
    "field": "text_body",
    "before": "Hi {{first_name}} — your last Waves autopay didn't go through. Usually means expired card, bank flag, or a processor hiccup. Log into your portal to update your card, or reply and we'll send a secure payment link. We retry in 3 business days. No service interruption, no late fee. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — your last Waves Auto Pay payment didn't go through. Usually means expired card, bank flag, or a processor hiccup. Log into your portal to update your card, or reply and we'll send a secure payment link. Already updated it? You're all set. — The Waves Pest Control team"
  },
  {
    "key": "pricing_update",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — a note on pricing</h2>\n<p>We don't like price letters any more than you do, so we'll keep this short.</p>\n\n<p>Starting with your next service, your rate will be adjusted to reflect increased product and labor costs across SWFL. The change is modest and keeps us below what the national chains charge for equivalent service.</p>\n\n<h2>What this changes</h2>\n<p>Nothing about what we do. Same tech, same service, same free re-service guarantee. Same no-commitment policy — if the new rate doesn't work for you, reply and we'll cancel with no fee.</p>\n\n<p>If you have questions, reply here and someone from the office will get back to you within a business day.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Hi {{first_name}} — a note on pricing</h2>\n<p>We don't like price letters any more than you do, so we'll keep this short.</p>\n\n<p>Your service rate is going up to reflect higher product and labor costs across SWFL. Before it takes effect, we'll send you the new price and the date it starts.</p>\n\n<h2>What this changes</h2>\n<p>Nothing about what we do. Same service, same free re-services between visits, and still no long-term contract — if the new rate doesn't work for you, reply and we'll talk it through or cancel with no fee.</p>\n\n<p>If you have questions, reply here and someone from the office will get back to you within a business day.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "key": "pricing_update",
    "field": "text_body",
    "before": "Hi {{first_name}} — short note: starting next service, your rate is adjusting for increased product + labor costs. We stay below national chain pricing for equivalent service. Same tech, same free re-service guarantee, same no-commitment policy — reply to cancel with no fee if it doesn't work. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — short note: your service rate is going up to reflect higher product and labor costs, and we'll send the new price and start date before it takes effect. Same service, same free re-services, still no long-term contract — reply if it doesn't work for you and we'll talk it through or cancel with no fee. — The Waves Pest Control team"
  },
  {
    "key": "referral_nudge",
    "field": "preview_text",
    "before": "Refer a neighbor, we both get $25 off next service.",
    "after": "Refer a neighbor: you each get a $25 account credit."
  },
  {
    "key": "referral_nudge",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}}!</h2>\n<p>Hope our last service was solid. If it was, we'd love your help growing by word-of-mouth — that's how almost every customer on our route today found us.</p>\n\n<h2>The referral deal</h2>\n<p>Tell a neighbor, friend, or family member about Waves. When they book their first service and mention your name, you both get <strong>$25 off</strong> your next visit. No cap — refer as many as you want.</p>\n\n<h2>Easiest way to do it</h2>\n<p>Forward this email to someone who might need us. Or just reply with their name and we'll reach out personally (no spam — one contact, then we drop off).</p>\n\n<p>Thanks for being on our route.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Hi {{first_name}}!</h2>\n<p>Hope our last service was solid. If it was, we'd love your help growing by word-of-mouth — that's how almost every customer on our route today found us.</p>\n\n<h2>The referral deal</h2>\n<p>Share your personal referral link — it's in the Refer tab of your customer portal. When a neighbor, friend, or family member signs up for a recurring plan with it and we complete their first service, you each get a <strong>$25 account credit</strong>.</p>\n\n<h2>Easiest way to do it</h2>\n<p>Send them your link from the portal, or just reply with their name and we'll reach out personally (no spam — one contact, then we drop off).</p>\n\n<p>Thanks for being on our route.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "key": "referral_nudge",
    "field": "text_body",
    "before": "Hi {{first_name}}! If our last service was solid, we'd love your help growing by word-of-mouth. Refer a neighbor — when they book their first service and mention your name, you both get $25 off. No cap. Forward this email, or reply with their name and we'll reach out (one contact, no spam). Thanks for being on our route. — The Waves Pest Control team",
    "after": "Hi {{first_name}}! If our last service was solid, we'd love your help growing by word-of-mouth. Share your referral link from the Refer tab in your portal — when a neighbor signs up for a recurring plan with it and we complete their first service, you each get a $25 account credit. Or reply with their name and we'll reach out (one contact, no spam). Thanks for being on our route. — The Waves Pest Control team"
  },
  {
    "key": "review_thank_you_lwr",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — thank you</h2>\n<p>We saw your Google review this morning. It genuinely made our day.</p>\n\n<p>Small family-owned companies like ours live or die by what neighbors say about us in Lakewood Ranch, so taking a minute to leave that review means more than you probably realize. Thank you.</p>\n\n<p>If there's ever anything you need from us — extra service, a question about your yard, or just a recommendation on another local business — just reply here. We've got you.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Hi {{first_name}} — thank you</h2>\n<p>We saw your Google review, and it genuinely made our day.</p>\n\n<p>Small family-owned companies like ours live or die by what neighbors say about us in Lakewood Ranch, so taking a minute to leave that review means more than you probably realize. Thank you.</p>\n\n<p>If there's ever anything you need from us — extra service, a question about your yard, or just a recommendation on another local business — just reply here. We've got you.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "key": "review_thank_you_lwr",
    "field": "text_body",
    "before": "Hi {{first_name}} — thank you for your Google review this morning. It made our day. Small family-owned companies like ours live or die by word-of-mouth in Lakewood Ranch, so taking a minute to leave that review means more than you probably realize. If there's ever anything you need — extra service, a yard question, or a recommendation on another local business — reply here. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — thank you for your Google review. It made our day. Small family-owned companies like ours live or die by word-of-mouth in Lakewood Ranch, so taking a minute to leave that review means more than you probably realize. If there's ever anything you need — extra service, a yard question, or a recommendation on another local business — reply here. — The Waves Pest Control team"
  },
  {
    "key": "review_thank_you_parrish",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — thank you</h2>\n<p>We saw your Google review this morning. It genuinely made our day.</p>\n\n<p>Small family-owned companies like ours live or die by what neighbors say about us in Parrish, so taking a minute to leave that review means more than you probably realize. Thank you.</p>\n\n<p>If there's ever anything you need from us — extra service, a question about your yard, or just a recommendation on another local business — just reply here. We've got you.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Hi {{first_name}} — thank you</h2>\n<p>We saw your Google review, and it genuinely made our day.</p>\n\n<p>Small family-owned companies like ours live or die by what neighbors say about us in Parrish, so taking a minute to leave that review means more than you probably realize. Thank you.</p>\n\n<p>If there's ever anything you need from us — extra service, a question about your yard, or just a recommendation on another local business — just reply here. We've got you.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "key": "review_thank_you_parrish",
    "field": "text_body",
    "before": "Hi {{first_name}} — thank you for your Google review this morning. It made our day. Small family-owned companies like ours live or die by word-of-mouth in Parrish, so taking a minute to leave that review means more than you probably realize. If there's ever anything you need — extra service, a yard question, or a recommendation on another local business — reply here. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — thank you for your Google review. It made our day. Small family-owned companies like ours live or die by word-of-mouth in Parrish, so taking a minute to leave that review means more than you probably realize. If there's ever anything you need — extra service, a yard question, or a recommendation on another local business — reply here. — The Waves Pest Control team"
  },
  {
    "key": "review_thank_you_sarasota",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — thank you</h2>\n<p>We saw your Google review this morning. It genuinely made our day.</p>\n\n<p>Small family-owned companies like ours live or die by what neighbors say about us in Sarasota, so taking a minute to leave that review means more than you probably realize. Thank you.</p>\n\n<p>If there's ever anything you need from us — extra service, a question about your yard, or just a recommendation on another local business — just reply here. We've got you.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Hi {{first_name}} — thank you</h2>\n<p>We saw your Google review, and it genuinely made our day.</p>\n\n<p>Small family-owned companies like ours live or die by what neighbors say about us in Sarasota, so taking a minute to leave that review means more than you probably realize. Thank you.</p>\n\n<p>If there's ever anything you need from us — extra service, a question about your yard, or just a recommendation on another local business — just reply here. We've got you.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "key": "review_thank_you_sarasota",
    "field": "text_body",
    "before": "Hi {{first_name}} — thank you for your Google review this morning. It made our day. Small family-owned companies like ours live or die by word-of-mouth in Sarasota, so taking a minute to leave that review means more than you probably realize. If there's ever anything you need — extra service, a yard question, or a recommendation on another local business — reply here. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — thank you for your Google review. It made our day. Small family-owned companies like ours live or die by word-of-mouth in Sarasota, so taking a minute to leave that review means more than you probably realize. If there's ever anything you need — extra service, a yard question, or a recommendation on another local business — reply here. — The Waves Pest Control team"
  },
  {
    "key": "review_thank_you_venice",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — thank you</h2>\n<p>We saw your Google review this morning. It genuinely made our day.</p>\n\n<p>Small family-owned companies like ours live or die by what neighbors say about us in Venice, so taking a minute to leave that review means more than you probably realize. Thank you.</p>\n\n<p>If there's ever anything you need from us — extra service, a question about your yard, or just a recommendation on another local business — just reply here. We've got you.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Hi {{first_name}} — thank you</h2>\n<p>We saw your Google review, and it genuinely made our day.</p>\n\n<p>Small family-owned companies like ours live or die by what neighbors say about us in Venice, so taking a minute to leave that review means more than you probably realize. Thank you.</p>\n\n<p>If there's ever anything you need from us — extra service, a question about your yard, or just a recommendation on another local business — just reply here. We've got you.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "key": "review_thank_you_venice",
    "field": "text_body",
    "before": "Hi {{first_name}} — thank you for your Google review this morning. It made our day. Small family-owned companies like ours live or die by word-of-mouth in Venice, so taking a minute to leave that review means more than you probably realize. If there's ever anything you need — extra service, a yard question, or a recommendation on another local business — reply here. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — thank you for your Google review. It made our day. Small family-owned companies like ours live or die by word-of-mouth in Venice, so taking a minute to leave that review means more than you probably realize. If there's ever anything you need — extra service, a yard question, or a recommendation on another local business — reply here. — The Waves Pest Control team"
  },
  {
    "key": "service_renewal",
    "field": "preview_text",
    "before": "Nothing changes automatically — here's what to know.",
    "after": "Your service continues as is — here's what to know."
  },
  {
    "key": "lawn_service",
    "field": "html_body",
    "before": "<h2>Welcome to the Waves lawn program, {{first_name}}!</h2>\n<p>SWFL lawns are tough to manage — sandy soil, heavy rain in summer, nitrogen blackout June through September. Our plan is built around what actually works in this climate.</p>\n\n<h2>Before the first visit</h2>\n<ul>\n  <li>Mow at the tallest setting your mower allows (3.5–4\" for St. Augustine)</li>\n  <li>Water deeply 1–2x per week, early morning — skip if rain is forecast</li>\n  <li>Don't apply any store-bought \"weed & feed\" between visits</li>\n</ul>\n\n<h2>What we'll do</h2>\n<p>Fertilization, weed control, and pest/fungus treatments on a schedule tuned to the season. Chinch bugs and sod webworms peak in our service window, so expect focused treatment when we see pressure.</p>\n\n<p>Reply with any questions about your yard — we're happy to take a look at photos.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>",
    "after": "<h2>Welcome to the Waves lawn program, {{first_name}}!</h2>\n<p>SWFL lawns are tough to manage — sandy soil, heavy rain in summer, nitrogen blackout June through September. Our plan is built around what actually works in this climate.</p>\n\n<h2>Before the first visit</h2>\n<ul>\n  <li>Mow at the tallest setting your mower allows (3.5–4\" for St. Augustine)</li>\n  <li>Water deeply in the early morning, only on the days your county allows — and skip it if rain is forecast</li>\n  <li>Don't apply any store-bought \"weed & feed\" between visits</li>\n</ul>\n\n<h2>What we'll do</h2>\n<p>Fertilization, weed control, and pest/fungus treatments on a schedule tuned to the season. Chinch bugs and sod webworms peak in our service window, so expect focused treatment when we see pressure.</p>\n\n<p>Reply with any questions about your yard — we're happy to take a look at photos.</p>\n\n<p>— The Waves Pest Control team</p>\n<p style=\"color:#71717A;font-size:12px;margin-top:16px;\">Reply to this email anytime — it goes straight to our team.</p>"
  },
  {
    "key": "lawn_service",
    "field": "text_body",
    "before": "Welcome to the Waves lawn program, {{first_name}}! SWFL lawns are tough — sandy soil, heavy summer rain, nitrogen blackout June–Sept. Before the first visit: mow at 3.5–4\", water deeply 1–2x per week early AM, and skip any store-bought weed & feed. We handle fertilization, weed control, and pest/fungus treatments on a seasonal schedule. Reply with photos if you have questions. — The Waves Pest Control team",
    "after": "Welcome to the Waves lawn program, {{first_name}}! SWFL lawns are tough — sandy soil, heavy summer rain, nitrogen blackout June–Sept. Before the first visit: mow at 3.5–4\", water deeply in the early morning on your county's allowed days, and skip any store-bought weed & feed. We handle fertilization, weed control, and pest/fungus treatments on a seasonal schedule. Reply with photos if you have questions. — The Waves Pest Control team"
  }
];

const SMS_SWAPS = [
  {
    "key": "service_renewal",
    "field": "sms_template",
    "before": "Hi {first_name}! Your Waves service is coming up for renewal. We just emailed you the details — take a look when you get a chance.\n\nQuestions? Just reply here!",
    "after": "Hi {first_name}! Your Waves service is coming up for renewal. We emailed the details; take a look when you get a chance.\n\nQuestions? Reply here."
  },
  {
    "key": "bed_bug",
    "field": "sms_template",
    "before": "Hello {first_name}! Let's get your home bed bug-free. We just emailed you your Waves treatment guide—please review it to help us get the best results for your home!\n\nIf you have any questions or need assistance, simply reply to this message.",
    "after": "Hello {first_name}! We just emailed your Waves bed bug treatment guide. Please read it before your visit so the treatment works as well as it can.\n\nQuestions? Reply here."
  },
  {
    "key": "cockroach",
    "field": "sms_template",
    "before": "Hello {first_name}! Let's get your home cockroach-free. We just emailed you your Waves treatment guide—please review it to help us get the best results for your home!\n\nIf you have any questions or need assistance, simply reply to this message.",
    "after": "Hello {first_name}! We just emailed your Waves cockroach treatment guide. Please read it before your visit so the treatment works as well as it can.\n\nQuestions? Reply here."
  },
  {
    "key": "new_appointment",
    "field": "sms_template",
    "before": "Hello {first_name}! We just emailed you a breakdown of what to expect with your upcoming service with Waves!\n\nIf you have any questions or need assistance, simply reply to this message.",
    "after": "Hello {first_name}! We just emailed what to expect at your first Waves service.\n\nQuestions? Reply here."
  }
];

async function audit(knex, hasAudit, resourceType, id, key, field) {
  if (!hasAudit) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system', action: 'automation_copy_updated',
    // audit_log.resource_id is a uuid: automation_templates rows are keyed
    // by their text key, so those carry the key in metadata only.
    resource_type: resourceType, resource_id: id == null ? null : String(id),
    metadata: { migration: MIGRATION, template_key: key, field },
    critical: true, trx: knex,
  });
}

exports.up = async function up(knex) {
  const hasAudit = await knex.schema.hasTable('audit_log');
  if (await knex.schema.hasTable('automation_steps')) {
    for (const { key, field, before, after } of STEP_SWAPS) {
      const rows = await knex('automation_steps').where({ template_key: key, [field]: before }).select('id');
      for (const { id } of rows) {
        const changed = await knex('automation_steps')
          .where({ id, [field]: before })
          .update({ [field]: after, updated_at: knex.fn.now() });
        if (changed) await audit(knex, hasAudit, 'automation_steps', id, key, field);
      }
    }
  }
  if (await knex.schema.hasTable('automation_templates')) {
    for (const { key, before, after } of SMS_SWAPS) {
      const changed = await knex('automation_templates')
        .where({ key, sms_template: before })
        .update({ sms_template: after, updated_at: knex.fn.now() });
      if (changed) await audit(knex, hasAudit, 'automation_templates', null, key, 'sms_template');
    }
  }
};

exports.down = async function down() {
  // Intentionally no-op: reverting seeded copy would erase later admin edits.
};
exports._STEP_SWAPS = STEP_SWAPS;
exports._SMS_SWAPS = SMS_SWAPS;
