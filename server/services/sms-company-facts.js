'use strict';
// Owner-approved company facts for the texting agent (owner rulings
// 2026-09-29/30; service knowledge added 2026-10-03; aftercare added 2026-10-09; answer-book rulings 2026-10-22). Rendered as one COMPANY FACTS section in the per-draft
// facts block by sms-shadow-drafter.buildFactsBlock, ONLY while
// GATE_SMS_REAL_ANSWERS is on (gate off: the facts block is byte-identical
// to before). Because the verifier grounds a draft against that same block,
// a reply that restates one of these lines is grounded by construction.
//
// Wording notes: no line may trip the drafter's own compliance screens
// (hasBannedCustomerCopy: "safe" claims, fixed dry/re-entry times, EPA) —
// sms-company-facts.test.js asserts that for every line, so an edit that
// would make a plain restatement unpublishable fails in CI.

const { WAVES_BRAND_NAME, WAVES_ADDRESS_LINE } = require('../constants/business');

const COMPANY_FACTS_HEADER = 'COMPANY FACTS (owner-approved; state these plainly):';

// The holidays the closed-days line (COMPANY_FACTS[6]) names, as scheduling/holidays.js keys (owner 2026-11-24). The line is static on
// purpose: the voice agent renders this section when its module loads and the sealed exam pins the render by hash, so it cannot follow
// the editable `schedule_holiday_closures` setting. PUT /admin/schedule/blackout-dates/holidays raises one admin alert when a saved
// closed set differs from this list, and sms-company-facts.test.js checks that the line names exactly these.
const FACT_CLOSED_HOLIDAY_KEYS = Object.freeze(['new_years_day', 'memorial_day', 'independence_day', 'labor_day', 'thanksgiving', 'christmas']);
/**
 * True when Settings still says what the closed-days line says: the closed holidays are exactly the six AND no weekday is a weekly
 * day off. The line says "We work Sundays and all other holidays", and any weekly day off closes holidays that fall on it (a Friday
 * off closes Good Friday and Black Friday), so ANY weekly day off is a mismatch. `weeklyDaysOff`: any iterable of 0 to 6. Pure.
 */
function factsLineMatchesSettings({ closedHolidays, weeklyDaysOff } = {}) {
  return closedHolidaysMatchFactsLine(closedHolidays) && new Set(weeklyDaysOff || []).size === 0;
}
/** True when `closedKeys` (any iterable of holiday keys) is exactly the set the facts line names. Pure. */
function closedHolidaysMatchFactsLine(closedKeys) {
  const closed = new Set(closedKeys || []);
  return closed.size === FACT_CLOSED_HOLIDAY_KEYS.length && FACT_CLOSED_HOLIDAY_KEYS.every((key) => closed.has(key));
}

const COMPANY_FACTS = Object.freeze([
  'On a residential general pest plan that includes inside service (not mosquito service), the first visit includes an inside spray. After that, the inside is up to the customer: we treat it whenever they ask. A customer who chose exterior-only service can ask the office to add inside service back. Commercial accounts follow their sold service scope.',
  'The customer does not need to be home for the exterior treatment. For the inside spray, someone needs to be home, or the customer leaves us access.',
  'Regular pest visits include the lanai and the pool cage.',
  'Wasps, mud daubers and hornet nests on the house are included on regular pest visits.',
  'We treat honeybees. Offer the soonest available time.',
  'Wildlife: we do rodent trapping only. Snakes, raccoons, squirrels and other wildlife are referred to a wildlife company.',
  // Owner 2026-11-24: Waves is closed on the Big 6 holidays (scheduling/holidays.js keys new_years_day,
  // memorial_day, independence_day, labor_day, thanksgiving, christmas); every other day works. The three fixed-date ones
  // (New Year's Day, 4th of July, Christmas) also close the observed weekday when they fall on a weekend (holidays.js).
  'We are closed on New Year\'s Day, Memorial Day, the 4th of July, Labor Day, Thanksgiving and Christmas. When New Year\'s Day, the 4th of July or Christmas falls on a Saturday, we are also closed the Friday before. When one falls on a Sunday, we are also closed the Monday after. We work Sundays and all other holidays. For a given date, the open times we offer are the final word.',
  'Rain: a treatment needs to dry and bond to surfaces; after that it holds up to weather.',
  'Lawn program: fertilizer, weed control and insect control only. No mowing. Treatments follow a seasonal rotation. Never name product brands.',
  'Watering advice you may give: follow the county\'s watering days, water early in the morning, and water deeply and less often.',
  `Paying: the technician can take a card, check or cash at the visit. Customers can also pay by the card or bank account on file, or by check or cash through the office. Checks are mailed to ${WAVES_BRAND_NAME}, ${WAVES_ADDRESS_LINE}.`,
  // Service knowledge (owner-approved 2026-10-03; each line restates an earlier ruling).
  // Scoped to what holds for EVERY customer the line could reach (Codex #5723 r1): the
  // German roach cleanout runs 2-4 visits by severity; pay-after-first-visit is the
  // recurring card rail only (invoice / commercial / one-time differ); 6x lawn plans
  // still exist for older customers; only qualifying services count toward a tier.
  'A standalone cockroach treatment (one that is not part of a recurring plan) is two visits for one price. The second visit is included. A German roach cleanout can take more visits, depending on how heavy it is.',
  // Two termite lines the owner also approved are NOT here yet (Codex #5723 r3): the
  // member's free annual termite inspection is not bookable (termite_inspection is
  // inactive in the catalog, 20260928190000) and "free inspection" trips the
  // re-service guard; and a pre-slab treatment includes a basic one-year warranty,
  // so "a warranty is a separate purchase" would deny an included benefit.
  'There is no deposit. New recurring customers who pay by card save the card when they book and are charged after the first visit.',
  'New residential lawn plans run 9 or 12 applications a year.',
  'Arrival windows are two hours and start on the hour.',
  'WaveGuard tiers (Bronze, Silver, Gold, Platinum) depend on how many qualifying recurring services a customer has.',
  // Aftercare and common pest answers (owner delegated the wording 2026-10-09, text agent
  // fix plan). Each line restates guidance the repo already carries, never a new claim
  // (Codex #6197 r2): recap-visit-context LINE_EXPECTATIONS.pest (some activity for up to two
  // weeks, pest only), the species catalog (drain fly traits and its fungus-gnat look-alike)
  // and the lawn guide (chinch treatment only after the technician confirms it). Each holds
  // for every customer it can reach and promises no visit: a return visit is the FREE
  // RE-SERVICE fact's job, never a COMPANY FACTS line.
  // NOT here: cleaning after a treatment. The prep guides tie it to dry surfaces and to the
  // treatment type, which a static line cannot carry; the agent hands that question off.
  'After a pest treatment it is normal to see some activity for up to two weeks as the treatment flushes pests out, and it fades as the products keep working. This is true of pest treatments only, not of other services. If it has not slowed down after two weeks, tell us.',
  'Drain flies are small, fuzzy, moth-shaped flies that rest on walls near sinks, tubs and showers. Their larvae live in the film inside the drain: scrubbing the drain and an enzyme drain cleaner fix that, a spray does not. Small flies hovering around houseplants are usually fungus gnats, a different insect. A photo tells them apart.',
  'On a lawn plan, insect control is part of the program. When a customer reports chinch bugs or other lawn insects, the technician checks at the next visit and treats where the technician confirms them and the product label allows.',
  // Owner rulings 2026-10-21/22 (Waves AI answer book). Plain customer wording, no prices, no
  // product brands. NOT here: the German roach cleanout re-treat after visit two (owner R1) - it promises a return visit, which is the
  // FREE RE-SERVICE fact's job (Codex #6447 r2: its restatements read as a re-service offer); the agent hands it to the office.
  // Also NOT here (Codex #6447 r3): when to mow (some lawn visit cards carry no mow timing). Paying (owner 2026-10-22 "add it"):
  // the technician takes card, check or cash at the visit, as the technician checkout does.
  // Scoped to what holds for every customer: no contract = residential; rodent checks past the first = the office (pre-2026-09-27
  // jobs keep them included); WDO report = after the signature, normally same day (a payment hold can delay it). Codex r4: the
  // inside line keeps the exterior-only exception; the refund line states the 90-day refund only (the cancel flow can still
  // refund later, so a cancel after 90 days goes to the office); products applied = the office (some reports carry no product rows).
  // Rain that washes off a treatment before it dries is deliberately NOT here:
  // the owner ruled it earns no free return visit, and a return visit is the FREE RE-SERVICE
  // fact's job, so no line promises one.
  'Rodent trapping includes the setup visit and at least one trap check. For more trap checks, the office confirms what the job includes.',
  'Residential pest and lawn plans have no long-term contract, and those customers can cancel any time. Termite plans and commercial accounts follow their signed agreement.',
  'A customer who prepays a year of pest or lawn service and cancels within 90 days gets a refund for the visits not yet done.',
  'We serve Manatee and Sarasota counties and Charlotte County except Punta Gorda, plus Ruskin, Apollo Beach, Sun City Center, Wimauma, Gibsonton and Riverview. We do not serve Punta Gorda, DeSoto County, Tampa, St. Petersburg or Lee County.',
  'A WDO (termite) inspection report is emailed after the licensed inspector signs it, normally the same business day as the inspection. The office can check on a late report.',
  'We do not tent for termites. For drywood termites in wood we can reach, we treat the infested wood directly with spot treatment, a borate wood treatment or injected foam. When the activity is widespread or in wood we cannot reach, we refer the customer to a fumigation company.',
  'Product labels: the office can tell a customer which products were applied at a visit and can email a product label or Safety Data Sheet on request.',
  // Standing answers the owner approved (2026-11-23 "yes we do" and the ant-label answer; 2026-11-25 "all rec" for the tube line), appended
  // in this order, each the owner's words with no dollar amount, fixed dry time or "safe" claim. The sms-label-facts reply guard reads
  // these lines too, so each one is worded to stay clear of its timing patterns (a vague time word such as "overnight", "stay out").
  // NOT here, on purpose: (1) "we text you when the technician is on the way": the text does not go out on every visit (the customer's own
  // text switch, one text for several same-day visits); (2) "you can go in after an inside treatment" and the flea "keep people and pets
  // out" answer: they are re-entry claims, which only a LABEL FACTS sentence may make (the facts block carries no "keep people and pets"
  // text when no label is on file, sms-label-facts.test.js r18), so the texting agent hands those questions to the office.
  'Yes, we offer emergency service day or night.',
  'The ant products we use inside are labeled for indoor ant treatment, including kitchens and pantries.',
  'We don\'t service in-wall tube systems, and that\'s on purpose. They push spray into the walls inside your home. We\'d rather treat the outside of the house thoroughly and fix the moisture problems that draw pests in, without spraying inside your walls.',
  // Owner rulings 2026-11-25 (texting AI fix, step 2: feed the facts staff know), appended in this order. Each line follows the company
  // facts bank's own text rules (company-facts-bank checkFactText: at most three sentences, no digit or number word, no product name, no
  // "safe" claim), which sms-company-facts.test.js runs over these lines. The width of the perimeter band is left out on purpose: a
  // number word is banned, so the line says "a band around the home" and no other line carries the width. NOT here: a return-visit offer
  // (a pest report before a visit moves that visit; the FREE RE-SERVICE fact owns return visits, so no line uses its words).
  'The perimeter treatment is applied as a band around the home.',
  'Lawn insect control is part of the lawn care plan, not the pest plan. The pest plan still treats the shrubs, ornamentals and bed areas around the home.',
  'When a customer on a recurring plan reports pests before their next scheduled visit, we can move that visit earlier, and the later visits in the plan move up with it.',
  'When rain forces a move and the customer is notified, we send our standard moved-visit text with the new day or a link to choose a day.',
  'New sod and plugs get the same watering instructions as any other lawn: follow the water district\'s watering days and times.',
  'For a wasp nest, we can explain how the nest is removed, and we suggest turning the outdoor lights off.',
  'We never tell a customer that ants may stay. The ant products we use are non-repellents: ants carry them back to the colony, so results build over time.',
]);

// The fixed money policy lines (paying, prepay refund): the payment-status contract treats a verbatim copy of one of their
// sentences as policy, not an account status (payment-status-contract.withoutCompanyPolicyCopies). An explicit list, never
// "every line that mentions money" (Codex #6447 r9).
const MONEY_POLICY_FACT_PREFIXES = Object.freeze(['Paying:', 'A customer who prepays']);
const moneyPolicyFacts = () => COMPANY_FACTS.filter((f) => MONEY_POLICY_FACT_PREFIXES.some((p) => f.startsWith(p)));

// Lines retired by a wording change, keyed by their index in COMPANY_FACTS (0 and 10: owner 2026-10-22;
// 22, the service area: owner 2026-11-23 held places until a second technician was hired, in two wordings (six places,
// then seven the same day); the hold ended with the hire and the line says again what it said before 2026-11-23. So the
// newest hold wording is here and the first one is in OLDER_RETIRED_COMPANY_FACT_LINES;
// 6, holidays: owner 2026-11-24 closed Waves on six holidays, so "we work Sundays and holidays, same as any other day" ended).
// A stored facts_block keeps the render it was drafted with, so the text each retired line had
// is kept here, verbatim, to rebuild those earlier renders (PRIOR_COMPANY_FACTS_RENDERS below).
const RETIRED_COMPANY_FACT_LINES = Object.freeze({
  0: 'Recurring, one-time and re-service pest visits include an interior spray as well as the exterior. The only exception is a customer who does not want the inside done.',
  6: 'We work Sundays and holidays, same as any other day.',
  10: `Paying: technicians accept cards at the visit, never cash. Checks are mailed to ${WAVES_BRAND_NAME}, ${WAVES_ADDRESS_LINE}.`,
  22: 'We serve Manatee and Sarasota counties, plus Englewood, Port Charlotte, Ruskin, Apollo Beach, Sun City Center, Wimauma, Gibsonton and Riverview. We are not taking new customers in Rotonda, Placida, Boca Grande, Babcock Ranch, Gulf Cove, Charlotte Harbor or Deep Creek yet; we plan to start there once we add a second technician. Existing customers there keep their visits, reschedules and re-service. We do not serve Punta Gorda, DeSoto County, Tampa, St. Petersburg or Lee County.',
});
// A line reworded more than once keeps its earlier retired wordings here (renders name them with `olderRetired`).
// 22: the first hold wording (2026-11-23): six places not taking new customers (Port Charlotte, Englewood, Rotonda, Placida,
// Boca Grande, Babcock Ranch).
const OLDER_RETIRED_COMPANY_FACT_LINES = Object.freeze({
  22: 'We serve Manatee and Sarasota counties, plus Ruskin, Apollo Beach, Sun City Center, Wimauma, Gibsonton and Riverview. We are not taking new customers in Port Charlotte, Englewood, Rotonda, Placida, Boca Grande or Babcock Ranch yet; we plan to start there once we add a second technician. Existing customers there keep their visits, reschedules and re-service. We do not serve Punta Gorda, DeSoto County, Tampa, St. Petersburg or Lee County.',
});

// The static section: fixed owner-approved policy, identical on every draft
// (the judge's sanitizer exempts exactly this text from its size budget).
function renderCompanyFactsSection() {
  return renderCompanyFactsLines(COMPANY_FACTS.length);
}
// `retired` says which lines of an earlier render still had the wording RETIRED_COMPANY_FACT_LINES keeps:
// true = lines 0, 6 and 10 (the renders before 2026-10-22), or a list of indexes (the seven-place hold render has lines 6 and 22).
// `olderRetired` lists indexes that still had the OLDER wording of a line reworded twice (OLDER_RETIRED_COMPANY_FACT_LINES).
// Every other line is the first `count` of today's list.
const LEGACY_RETIRED_INDEXES = Object.freeze([0, 10, 6]);
function renderCompanyFactsLines(count, { retired = false, olderRetired = [] } = {}) {
  const put = retired === true ? LEGACY_RETIRED_INDEXES : (Array.isArray(retired) ? retired : []);
  const older = Array.isArray(olderRetired) ? olderRetired : [];
  const lines = COMPANY_FACTS.slice(0, count).map((f, i) => (older.includes(i) && OLDER_RETIRED_COMPANY_FACT_LINES[i])
    || (put.includes(i) && RETIRED_COMPANY_FACT_LINES[i]) || f);
  return `${COMPANY_FACTS_HEADER}\n${lines.map((f) => `- ${f}`).join('\n')}\n`;
}

// ---- Earlier renders still stored in message_drafts.facts_block -----------
//
// Lines are APPENDED to COMPANY_FACTS. A line whose wording changes is the one exception
// (owner 2026-10-22): its old text moves to RETIRED_COMPANY_FACT_LINES and every earlier
// render that carried it is listed with `retired: true`; those renders are the first N lines
// of today's list with the retired wording put back. A stored block keeps the render it was drafted with, and the READERS
// of stored blocks (the nightly judge's size exemption, the label-facts reader behind
// grounding and send-time rechecks) must still recognize it (Codex #6197 r1 P0): otherwise a
// block drafted the day before a facts change loses the exemption, the company section eats
// the judge's prefix budget, and the calls/thread evidence falls off the end.
// Each entry is pinned by the sha256 of its render (sms-company-facts.test.js),
// so editing one of the first N lines fails CI instead of silently orphaning
// stored blocks. The sealed-eval CONTRACT stays exact-current on purpose
// (hasExactCompanyFacts): an old item must never grade the new identity. Any change to the
// render also moves both prompt version numbers in sms-shadow-drafter.
const PRIOR_COMPANY_FACTS_RENDERS = Object.freeze([
  // 2026-11-25 owner rulings (texting AI fix, step 2): seven lines APPENDED (perimeter band, lawn insect control, pest report before a
  // visit, rain moves, new sod, wasp nests, ants). The 29-line render live 2026-11-25 (prompts 45 to 52) has today's wording for every
  // one of its lines, so it is the first 29 lines of today's list and needs no `retired` entry. No line was reworded.
  { lines: 29, sha256: 'f22377899d74db87a65fcd13745316b89ff3e6b672216d88dd236774aaa5baa2' },
  // 2026-11-25 standing answers (owner 2026-11-23 / 2026-11-25 "all rec"): three lines APPENDED (emergency service, ants near a
  // pantry, in-wall tube systems). The 26-line render live 2026-11-24 to
  // 2026-11-25 (prompts 41 to 44) has today's wording for every one of its lines, so it is the first 26 lines of today's list and
  // needs no `retired` entry. No line was reworded, so the retired-facts send guard does not move.
  { lines: 26, sha256: 'c1280281fafe73f1447b09f7bc92d3a20d3e7b2150b2b7835d110d5b180d8138' },
  // 2026-11-24 holidays line 6 (owner: closed on six holidays): the 26-line render live 2026-10-22 to 2026-11-23 (prompts 25 to 28)
  // and again until this change (prompts 37 to 40, the service area served again), with the old holidays line 6 only.
  { lines: 26, retired: [6], sha256: 'f58c532ee993a9b46b3af4505b5ab82f000c68e3a3209b0f65c51397804f02f0' },
  // Service area held places ended with the second hire (prompts 33 to 36): the 26-line render of the seven-place hold, with that
  // service-area line 22 and the old holidays line 6. The render before it (six places, prompts 29 to 32) follows.
  { lines: 26, retired: [22, 6], sha256: '73b8adba115c4c1eb3bd8c306a37b8ba3609f39cda15ac6aeb99e64080c9aa69' },
  { lines: 26, olderRetired: [22], retired: [6], sha256: '468057aeb7bdddbca9bb3c796decc7f34f86800e6957c00a0c2e7b435356891e' },
  // 2026-10-09 aftercare lines (#6197): identities 9_m to 14_n, the last render with the old inside-spray and paying wording
  { lines: 19, retired: true, sha256: '3a72b3d4acb47ca8f95cfe6ddb9aedf65c696f6cc3f60efb5999725bf7880577' },
  // 2026-10-03 service knowledge (#5723): identities 6_cflvp, 7_m, 8_m
  { lines: 16, retired: true, sha256: 'abed23421e2f7745d97d48a70e95a496f6636a411764cc02e43360d0d9a2e1e2' },
]);
// Today's render first, then each earlier one, newest first.
function knownCompanyFactsRenders() {
  return [renderCompanyFactsSection(), ...PRIOR_COMPANY_FACTS_RENDERS.map((r) => renderCompanyFactsLines(r.lines, r))];
}

// ---- Trusted presence check (sealed-eval compatibility) -----------------
//
// A header substring is NOT proof a block carried the section: a customer's
// multi-line SMS in the thread can contain the header text. The real section
// sits directly before the FIRST "BILLING:" line (buildFactsBlock's spot), so
// a block "has" COMPANY FACTS only when the text before that first BILLING:
// line ends with the exact static render. Any edit to COMPANY_FACTS text
// therefore needs a new version suffix (old items no longer match).
const BILLING_DELIMITER = '\nBILLING:\n';
function exactSectionSuffix() {
  return `\n${renderCompanyFactsSection().replace(/\n$/, '')}`;
}
// The exact structure ahead of the first BILLING: line, as ONE regex source
// (JS and Postgres ARE compatible, so the SQL twin in sms-sealed-eval runs the
// very same pattern): the static COMPANY FACTS render, then the LABEL FACTS
// section (sms-label-facts: the exact "none on file" section or an exact-shape filled one).
// `label`: 'optional' (a pre-LABEL-FACTS block ends at the company section),
// 'required' (a `_cfl` block), so each is an exact-structure test, never a
// substring one (Codex: a header typed into an SMS proves nothing).
// `anyRender` (readers of STORED blocks only, never the sealed contract): the
// company part matches today's render or any earlier one.
function exactStructureRegexSource(label, { anyRender = false } = {}) {
  const { LABEL_SECTION_REGEX_SRC, escapeRegex } = require('./sms-label-facts');
  const company = anyRender
    ? `(?:${knownCompanyFactsRenders().map((r) => escapeRegex(`\n${r.replace(/\n$/, '')}`)).join('|')})`
    : escapeRegex(exactSectionSuffix());
  // 'capture' = 'required' with the label section as capture group 1 (JS only).
  const tail = label === 'capture' ? `\n(${LABEL_SECTION_REGEX_SRC})`
    : (label === 'required' ? `\n${LABEL_SECTION_REGEX_SRC}` : `(?:\n${LABEL_SECTION_REGEX_SRC})?`);
  return `${company}${tail}$`;
}
function textBeforeFirstBilling(factsBlock) {
  const facts = String(factsBlock || '');
  const at = facts.indexOf(BILLING_DELIMITER);
  return at < 0 ? null : facts.slice(0, at);
}
function hasExactCompanyFacts(factsBlock) {
  const before = textBeforeFirstBilling(factsBlock);
  return before !== null && new RegExp(exactStructureRegexSource('optional')).test(before);
}
// The LABEL FACTS section text, located ONLY by the exact structure (static
// COMPANY FACTS -> LABEL FACTS -> first
// BILLING:). '' when the block has no such section: a header (and a fake time)
// typed into an SMS line, before or after the real BILLING:, is never found,
// so it can ground nothing. Every reader of LABEL FACTS figures (compliance
// grounding, frozen replays, the sealed contract) goes through this.
function exactLabelFactsSection(factsBlock) {
  const before = textBeforeFirstBilling(factsBlock);
  if (before === null) return '';
  // a stored block keeps the company render it was drafted with (anyRender)
  const m = new RegExp(exactStructureRegexSource('capture', { anyRender: true })).exec(before);
  return m ? m[1] : '';
}
// The sealed CONTRACT's test: today's exact render only (see hasExactCompanyFacts).
function hasExactLabelFacts(factsBlock) {
  const before = textBeforeFirstBilling(factsBlock);
  return before !== null && new RegExp(exactStructureRegexSource('required')).test(before);
}

// ---- Rebasing a stored block onto today's static section (sealed-eval freezer) ----
//
// The COMPANY FACTS section is STATIC: byte-identical on every draft of one identity, so it carries
// nothing about the customer or the day. A block drafted under an EARLIER render (a known one in
// PRIOR_COMPANY_FACTS_RENDERS) therefore differs from today's block for the same inbound and the same
// day-of facts ONLY in that section. Without this, every wording edit (three in three weeks) emptied the
// sealed exam's candidate pool for the 7-day age window and left it with a handful of items.
// Returns the block with the earlier render swapped for today's, or null when the block does not end its
// pre-BILLING text with one known earlier render (+ the optional LABEL FACTS section) - already current,
// no company section, or typed text. Only the exact structure counts, same as hasExactCompanyFacts.
// The caller still owns the topic question: the human reply of an old draft may restate a policy
// whose line was reworded (RETIRED_COMPANY_FACT_TOPIC_RE).
function rebaseCompanyFactsToCurrent(factsBlock) {
  const facts = String(factsBlock || '');
  const before = textBeforeFirstBilling(facts);
  if (before === null) return null;
  const { LABEL_SECTION_REGEX_SRC } = require('./sms-label-facts');
  const tailOk = new RegExp(`^(?:\\n${LABEL_SECTION_REGEX_SRC})?$`);
  for (const prior of knownCompanyFactsRenders().slice(1)) {
    const needle = `\n${prior.replace(/\n$/, '')}`;
    const at = before.lastIndexOf(needle);
    if (at < 0) continue;
    const tail = before.slice(at + needle.length);
    if (!tailOk.test(tail)) continue;
    return `${before.slice(0, at)}${exactSectionSuffix()}${tail}${facts.slice(before.length)}`;
  }
  return null;
}
// Words around the topics of the lines in RETIRED_COMPANY_FACT_LINES (inside spray; paying; service area). A reply
// written under the old wording may state the old policy, so a rebased item whose inbound or human reply
// touches these topics is not sealed. Extend this when a line is added to RETIRED_COMPANY_FACT_LINES.
// The service-area topic (line 22, owner ruling 2026-11-23, ended when the second technician was hired): every place either retired
// hold wording of the line named (six places, then seven the same day), the names their ZIPs also go by, and their ZIPs, written
// out here on purpose (this file stays free of the booking code's list). A question about a ZIP ("do you cover 33948?") or an
// alias ("Deep Creek") touches the topic as much as the town name does. None of these places is held today but they stay on this
// list: an exchange drafted under a hold line told a customer there "we are not taking new customers", so it is stale and must
// not be sealed as a reference answer.
const HELD_PLACE_TOPIC_WORDS = 'serve|serves|serving|service area|punta gorda|charlotte|charlotte harbor|englewood|rotonda|rotunda|placida|boca grande|babcock|gulf cove|el jobean|deep creek';
const HELD_PLACE_TOPIC_ZIPS = '33947|34223|34224|34295|33946|33927|33921|33938|33948|33949|33952|33953|33954|33981|33980|33983|33982';
const PAYMENT_AND_INSIDE_TOPIC_WORDS = 'inside|interior|indoors?|cash|checks?|cards?|zelle|paid|pay(?:s|ing|ment|ments)?';
const SERVICE_AREA_TOPIC_RE = new RegExp(`\\b(?:${HELD_PLACE_TOPIC_WORDS}|(?:${HELD_PLACE_TOPIC_ZIPS})(?:-\\d{4})?)\\b`, 'i');
const PAYMENT_AND_INSIDE_TOPIC_RE = new RegExp(`\\b(?:${PAYMENT_AND_INSIDE_TOPIC_WORDS})\\b`, 'i');
// Every retired topic at once (the render before 2026-10-22 had all three reworded lines).
const RETIRED_COMPANY_FACT_TOPIC_RE = new RegExp(
  `\\b(?:${PAYMENT_AND_INSIDE_TOPIC_WORDS}|${HELD_PLACE_TOPIC_WORDS}|(?:${HELD_PLACE_TOPIC_ZIPS})(?:-\\d{4})?)\\b`, 'i');
// The topics a block's OWN earlier render had reworded since: the 26-line renders live until 2026-11-23 already carried today's
// payment and inside-spray lines, so only the service area counts for it; the older renders had all of them. null = no earlier render.
// The prior-render entry a stored block carries (PRIOR_COMPANY_FACTS_RENDERS), or null: the block's own recorded render, not its text.
function priorRenderForBlock(factsBlock) {
  const before = textBeforeFirstBilling(factsBlock);
  if (before === null) return null;
  const renders = knownCompanyFactsRenders().slice(1);
  // A render whose lines are all still today's lines is a PREFIX of today's render, so a plain substring test would also match a
  // block drafted under today's render. The block's own render ends where the LABEL FACTS section (or the end of the text) starts.
  const { LABEL_SECTION_REGEX_SRC } = require('./sms-label-facts');
  const tailOk = new RegExp(`^(?:\\n${LABEL_SECTION_REGEX_SRC})?$`);
  for (let i = 0; i < renders.length; i += 1) {
    const needle = `\n${renders[i].replace(/\n$/, '')}`;
    const at = before.lastIndexOf(needle);
    if (at >= 0 && tailOk.test(before.slice(at + needle.length))) return PRIOR_COMPANY_FACTS_RENDERS[i];
  }
  return null;
}
// `retired: true` (the renders before 2026-10-22) had every reworded line of the time; a list names its lines.
const renderHadRetiredLine = ({ retired, olderRetired }, index) => retired === true
  || (Array.isArray(retired) && retired.includes(index)) || (Array.isArray(olderRetired) && olderRetired.includes(index));
// True when the block's own render carries the retired holidays line (RETIRED_COMPANY_FACT_LINES[6], "we work Sundays and holidays,
// same as any other day", owner 2026-11-24): every earlier render does, so the model drafting under it was told Waves works every
// holiday. The sealed exam never takes such an exchange as a reference answer. Keyed on the recorded render, never on message text.
function carriesRetiredHolidayLine(factsBlock) {
  const prior = priorRenderForBlock(factsBlock);
  return !!prior && renderHadRetiredLine(prior, 6);
}
// True when the block's own render carries a retired service-area wording (line 22, or the older renders that predate it): the
// held-place checks of the sealed exam apply to these only (the render live until 2026-11-24 carried today's service-area line).
function carriesRetiredServiceAreaLine(factsBlock) {
  const prior = priorRenderForBlock(factsBlock);
  return !!prior && renderHadRetiredLine(prior, 22);
}
function retiredTopicReForBlock(factsBlock) {
  const prior = priorRenderForBlock(factsBlock);
  if (!prior) return null;
  if (prior.retired === true) return RETIRED_COMPANY_FACT_TOPIC_RE;
  // Newer renders carried today's payment and inside-spray lines: only the service area counts for them, and only when the render had it reworded.
  return renderHadRetiredLine(prior, 22) ? SERVICE_AREA_TOPIC_RE : null;
}

// The earlier conversation: does the rest of the frozen facts block (the customer's address, the calls, the SMS thread) name a held
// place or its ZIP? A reply such as "Yes, Tuesday works" answers a first-visit question from a customer who said "I'm in Englewood"
// three messages up, and it must not become a reference answer under the new policy. The static COMPANY FACTS section itself is
// removed first (every known render, today's included): it names the held places in every block. The payment, cash and card
// words of RETIRED_COMPANY_FACT_TOPIC_RE are NOT used here: the facts block carries them in every draft.
const HELD_PLACE_CONTEXT_RE = new RegExp(
  `\\b(?:punta gorda|charlotte|englewood|rotonda|rotunda|placida|boca grande|babcock|gulf cove|el jobean|deep creek|(?:${HELD_PLACE_TOPIC_ZIPS})(?:-\\d{4})?)\\b`, 'i');
function heldPlaceInConversationContext(factsBlock) {
  let rest = String(factsBlock || '');
  for (const render of knownCompanyFactsRenders()) rest = rest.split(render.replace(/\n$/, '')).join('');
  return HELD_PLACE_CONTEXT_RE.test(rest);
}

// The booking location a frozen OPEN TIMES lookup used (message_drafts.intended_actions.open_times_snapshot.lookup: the city and
// ZIP the openings were fetched for). The facts block does not render it, so an exchange like "Can I book?" / "Tuesday works" from
// a lead whose lookup city is Port Charlotte shows no held place anywhere else. The lookup is read whole, as text.
function heldPlaceInOpenTimesLookup(intendedActions) {
  let actions = intendedActions;
  if (typeof actions === 'string') {
    try { actions = JSON.parse(actions); } catch { return HELD_PLACE_CONTEXT_RE.test(actions); }
  }
  const lookup = actions?.open_times_snapshot?.lookup;
  return lookup ? HELD_PLACE_CONTEXT_RE.test(JSON.stringify(lookup)) : false;
}

module.exports = {
  retiredTopicReForBlock,
  PAYMENT_AND_INSIDE_TOPIC_RE,
  SERVICE_AREA_TOPIC_RE,
  heldPlaceInOpenTimesLookup,
  heldPlaceInConversationContext,
  carriesRetiredHolidayLine,
  carriesRetiredServiceAreaLine,
  HELD_PLACE_CONTEXT_RE,
  rebaseCompanyFactsToCurrent,
  RETIRED_COMPANY_FACT_TOPIC_RE,
  BILLING_DELIMITER,
  exactSectionSuffix,
  exactStructureRegexSource,
  hasExactCompanyFacts,
  hasExactLabelFacts,
  exactLabelFactsSection,
  COMPANY_FACTS,
  FACT_CLOSED_HOLIDAY_KEYS,
  closedHolidaysMatchFactsLine,
  factsLineMatchesSettings,
  RETIRED_COMPANY_FACT_LINES, OLDER_RETIRED_COMPANY_FACT_LINES,
  moneyPolicyFacts,
  COMPANY_FACTS_HEADER,
  renderCompanyFactsSection,
  PRIOR_COMPANY_FACTS_RENDERS,
  knownCompanyFactsRenders,
};
