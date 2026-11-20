// Does a record of this account stand against a NEW residential plan that the
// app would price, or offer, with nobody watching?
//
// planStartBlocker(database, customerId) answers null when none of the records
// it reads stands against it, or the first reason that does:
//   'not_live'    no such customer, an inactive account, or a deleted one
//   'commercial'  a record of the account says commercial: the account row,
//                 a saved property, an estimate, a lead, a visit, a service
//                 report, a contract, a call or a day-agreement decision
//                 (never a residential plan)
//   'has_plan'    the customer already holds a plan (customerHoldsPlan below)
// A failed read THROWS. An outage is never "nothing stands against it": the
// caller is a job that tries again, or a pricer that must return no price.
//
// What it reads: the customers row, and the records that carry the id of that
// ONE account. For the commercial rule: its saved properties, its estimates,
// its leads, its visits, its service reports, its contracts, its calls and
// its day-agreement decisions (hasCommercialRecord below). For the plan rule:
// its plan records (customerHoldsPlan below lists them).
// What it does not read:
// - another account of the same person or home (a duplicate profile, a payer,
//   a family link), and a lead or an estimate with no customer id on it (one
//   that matches the person by phone, email or address only);
// - free text: the transcript or the summary of a call, a note, the body of a
//   text or an email, and what a model wrote about one of those. The verdict
//   the app SAVED on such a record is read (a call's extraction and triage, a
//   day-agreement decision), never its words. One exception: the notes of an
//   estimate with no service line, which the app's own reader sorts into
//   service lines;
// - what came in before a record was saved: a form post, a parcel lookup, the
//   page a visitor came from. The app sorts those when it saves a lead or an
//   estimate, and the saved record is read;
// - a copy on another table: a service name (an invoice, a reminder, a review
//   request, the coverage text of a prepay term), or the flag of a call (its
//   triage card, its route decision). The record it was copied from is read;
// - an open estimate as a PLAN record (an accept writes the tier, the lane
//   and the series, and those are read). The commercial rule reads every
//   estimate of the account;
// - termite_bonds, customer_contracts and payment_plans as PLAN records. A
//   bond rides the quarterly station check, whose recurring visits are read;
//   a bond alone is a warranty with a renewal date (no tier count, no bundle
//   discount). A contract is the signing workflow of a service (the
//   commercial rule reads its template). A payment plan is the instalments of
//   an invoice.
//
// null is not "this is a home". The commercial rule is a list of marks on the
// records above. A caller that prices must still refuse a commercial property
// on the profile it prices, by the pricing engine's own rule, as the restart
// flow does (assertNotCommercial in cancellation-resolution/restart.js: the
// stored type, then the resolved one).
//
// It is a rule about those records at the moment of the call. It does not
// decide who gets an offer on a given day (a former plan customer, a
// complaint, an open estimate, the wait after a job): those are the sender's
// rules. It takes no lock: a caller that writes (an accept, a mint) keeps its
// own guard at the write.
//
// The phone-yes accept has its own check for its own flow (existingPlan in
// call-phone-yes-accept.js: the membership, the two annual-prepay reads and
// the calendar, less the visit the accept is about). It is live and is not
// changed here.
const PLAN_START_BLOCKERS = Object.freeze(['not_live', 'commercial', 'has_plan']);

// The billing lanes only a plan has (billing-lane.js BILLING_MODES): dues on
// the 1st, a fee per application, a year paid up front. The other two
// (per_visit, one_time) say nothing about a plan.
const PLAN_ONLY_BILLING_LANES = Object.freeze(['monthly_membership', 'per_application', 'annual_prepay']);

// A plan visit that is live now and that the calendar read never returns. Two
// row shapes:
// - a legacy plan visit. It carries no recurring flag (NULL) and a
//   recurring_parent_id, and it is a plan visit all the same: the plan's own
//   row rule counts it (isPlanSeriesRow in recurring-series-cancel-reseed.js;
//   PLAN_ROW_SQL in rate-review.js is its SQL form), and that rule drops a
//   free re-service callback and an included follow-up. The calendar read
//   (loadLiveRecurringObligationRows) asks for is_recurring = true;
// - a visit with the recurring flag and NO status. The column takes a NULL.
//   The calendar read drops the visits that are over with NOT IN, and in SQL
//   a NULL fails NOT IN, so that read drops this visit too. The row rule
//   reads a visit with no status as open.
// "Live" is the calendar read's own row rule (isLiveObligationRow): not
// terminal, not a callback, not a one-time booking source, and today or later
// in Eastern time, or in progress now. That rule judges the status. So
// neither read here filters on the status in SQL: such a filter is what loses
// the NULL.
const PLAN_VISIT_COLUMNS = Object.freeze(['id', 'scheduled_date', 'status', 'source', 'is_recurring', 'recurring_parent_id', 'is_callback', 'followup_included']);
async function hasLivePlanVisitOffCalendar(database, customerId) {
  const { isLiveObligationRow } = require('./waveguard-existing-services');
  const { isPlanSeriesRow } = require('./recurring-series-cancel-reseed');
  const { etDateString } = require('../utils/datetime-et');
  const legacy = await database('scheduled_services')
    .where({ customer_id: customerId })
    .whereNull('is_recurring')
    .whereNotNull('recurring_parent_id')
    .select(...PLAN_VISIT_COLUMNS);
  const noStatus = await database('scheduled_services')
    .where({ customer_id: customerId, is_recurring: true })
    .whereNull('status')
    .select(...PLAN_VISIT_COLUMNS);
  const today = etDateString();
  // Two rules, each from its owner: a plan row, and live. The plan's row rule
  // also holds the shape (a booster, or a row with no parent, is no plan row),
  // so the answer does not rest on the SQL filter alone.
  return [...legacy, ...noStatus].some((row) => isPlanSeriesRow(row) && isLiveObligationRow(row, today));
}

// Does the customer already hold a plan? `customer` is the customers row of a
// live account, as read from the database. Every record of a plan counts, and
// one alone is enough. Each is read by the module that owns it:
// - the account: a membership tier, or a legacy monthly rate with no tier, by
//   the predicate the setup-fee decision reads (isMembershipCustomerRow). Also
//   a monthly rate beside a tier value that names no plan ('None',
//   'One-Time'): that predicate reads such a row as "no plan", and a rate on
//   the account is a billed plan amount whatever the tier column says. And a
//   billing lane that only a plan has, by the lane's one reader
//   (resolveBillingLane): an accept or the office set it, also on an account
//   with no tier and no rate. A churn keeps the per-application lane on the
//   account on purpose (cancellation-processor.js: it is the price of work
//   not settled yet), so such an account reads as a plan holder until the
//   office clears the lane. That is the fail-closed side;
// - the calendar: any live recurring obligation, at any property. The test is
//   the live rows, never the owned keys: a recurring palm injection or a
//   termite bond maps to no service family and is still the customer's plan.
//   A plan visit the calendar read never returns counts too: a legacy plan
//   visit, and a visit with no status (hasLivePlanVisitOffCalendar). One row
//   rule judges every shape (isLiveObligationRow), so a visit that rides a
//   job without being a plan visit (a callback, an included follow-up, a
//   one-time booking) is not a plan, whatever its flag says;
// - an ongoing series BETWEEN visits: its root says the plan goes on (a cancel
//   of the series clears the flag; the nightly top-up extends the series),
//   also on a day with no visit of it on the calendar. The top-up's own
//   selector, as the billing rules read it (unpricedOngoingSeries in
//   billing-mode-rules.js). A root the top-up skips today (a plan hold, an
//   annual prepay, a second series) is still a plan record, so the skip rules
//   are not applied;
// - the plan-rate ledger: any billed component, also one the ledger could not
//   name. The read asks for a strict table probe: with GATE_PLAN_RATE_LEDGER
//   off the ledger answers a failed probe as "no ledger", and here a billed
//   rate is evidence in either mode;
// - an active plan hold (cancellation-resolution/holds.js): the plan is
//   paused, not over. The hold itself takes two of the records above away
//   until the return date (the family's ledger component and the account's
//   monthly rate go to 0), and it skips the visits inside the pause;
// - annual prepay: a term whose paid coverage is live, or a prepay invoice
//   still payable (a payment starts the term and seeds its visits), by the
//   churn guard's own two reads (customer-lifecycle-guard.js).
async function customerHoldsPlan(database, customer) {
  const existing = require('./waveguard-existing-services');
  if (existing.isMembershipCustomerRow(customer)) return true;
  // Any billed amount on the account, in whatever way the account is billed.
  // This asks "is there a plan record", fail closed. It does not sort the
  // account into a way of billing (that is resolveBillingLane's question).
  if (Number(customer.monthly_rate) > 0) return true;
  if (PLAN_ONLY_BILLING_LANES.includes(require('./billing-lane').resolveBillingLane(customer).mode)) return true;
  if ((await existing.loadLiveRecurringObligationRows(database, customer.id)).length) return true;
  if (await hasLivePlanVisitOffCalendar(database, customer.id)) return true;
  const ongoingSeries = await require('./recurring-series-topup').eligibleSeriesParentIds(database, { customerId: customer.id });
  if (ongoingSeries.length) return true;
  const billedRates = (await require('./plan-rate-ledger').loadComponents(database, customer.id, { strictProbe: true }))
    .filter((row) => Number(row.monthly_rate) > 0);
  if (billedRates.length) return true;
  if (await database('plan_holds').where({ customer_id: customer.id, status: 'active' }).first('id')) return true;
  if (await require('./customer-lifecycle-guard').findActivePrepayTerm(database, customer.id)) return true;
  return Boolean(await require('./admin-cancellation').findPendingPrepayInvoice(customer.id, null, database));
}

// ---- The commercial rule ----
//
// The app keeps no single "this customer is a business" mark. The account row
// carries three (the tier, a mirror of the primary property's type, the
// building use of a won proposal), and each has a gap: the mirror can be
// behind, nothing on the row mirrors a property's occupancy, and a won
// proposal writes a building use only when it carries one (and the column
// came with no backfill for the wins before it). So the rule also reads the
// records of the account that the app itself sorts as commercial: its saved
// properties, its estimates, its leads, its visits, its service reports, its
// contracts, its calls and its day-agreement decisions (hasCommercialRecord).
// Each kind is read by the rules the app applies to a SAVED record of that
// kind. ONE mark is enough, whatever its age or status: an old estimate, a
// cancelled visit, a deleted lead, a removed address, a call of last year.
// That is the fail-closed side, on purpose: this proof
// clears an account for an offer nobody reads before it goes out. A business
// that gets a home price is the costly mistake. A home with one old
// commercial mark only gets no automatic offer.

// One rule for a property type, wherever it is saved: the account-level list
// (commercial, business: isCommercialAccount in self-booking-plan-sync.js) or
// the pricing engine's own rule (isCommercialProperty).
function isCommercialPropertyType(propertyType) {
  const { isCommercialAccount } = require('./self-booking-plan-sync');
  const { isCommercialProperty } = require('./pricing-engine/commercial-helpers');
  return isCommercialAccount({ property_type: propertyType }) || isCommercialProperty({ propertyType });
}

// A sold commercial scope in the account's service preferences
// (commercial_interior_scope). Only the accept of a commercial pest estimate
// writes the key (estimate-public.js: 'excluded' for an exterior-only scope,
// 'included' after a re-price), and no customer request can set it
// (routes/service-preferences.js keeps it across writes). So the key alone
// says a commercial plan was sold on this account. A value that is not an
// object carries no key (the route reads it the same way), and a text that
// is not JSON throws, as a failed read does.
function hasCommercialSoldScope(customer) {
  const raw = customer.service_preferences;
  const preferences = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
  return Boolean(preferences) && typeof preferences === 'object' && isSet(preferences.commercial_interior_scope);
}

// Is one of the account's saved properties commercial? The account row carries
// only a mirror of the PRIMARY property's type (and the mirror can be behind),
// and nothing on it mirrors a property's occupancy. So an account that reads
// residential by its own row can have a saved property that says commercial:
// by its occupancy (the property's own mark, which the tax rule and the
// estimate tools read) or by its own type.
// EVERY saved property counts. Not only the primary one: this proof gets no
// property to answer for, so it answers for the account, fail closed. And
// also one that was removed from the account (active = false): the removal of
// a business address does not make the account a home.
async function hasCommercialProperty(database, customerId) {
  const properties = await database('customer_properties')
    .where({ customer_id: customerId })
    .select('occupancy_type', 'property_type');
  return properties.some((property) => property.occupancy_type === 'commercial' || isCommercialPropertyType(property.property_type));
}

// The words the estimator forms, the lead intake and the engine save for a
// yes on the commercial toggle ('YES', true, 1).
const COMMERCIAL_FLAG_WORDS = Object.freeze(['yes', 'y', 'true', '1', 'on', 'commercial']);
const saysYes = (flag) => COMMERCIAL_FLAG_WORDS.includes(String(flag ?? '').trim().toLowerCase());
// A value that is set: a text that is not blank, or any other value that is
// not empty (not false, not 0).
const isSet = (value) => (typeof value === 'string' ? value.trim() !== '' : Boolean(value));
// The engine's intent is written by a model, and it can spell "no subtype" as
// a word. The two readers of that spelling take 'none' and 'null' as empty
// (structuredCommercialSignal in lead-estimate-automation.js,
// commercialCategoryConflict in estimator-engine/unit-scope-model.js).
const NO_SUBTYPE_WORDS = Object.freeze(['none', 'null']);
const isSetSubtype = (value) => isSet(value) && !(typeof value === 'string' && NO_SUBTYPE_WORDS.includes(value.trim().toLowerCase()));

// Does ONE object of an estimate payload say commercial? An estimate keeps
// its inputs under several generations of shapes (the form's inputs, the
// engine's request and result, the engine's intent, the service lines). So
// each rule below is asked of every object of the payload, never of a list of
// paths:
// - the commercial toggle, under either spelling of its name. The payload
//   scan of the save (isCommercialEstimateData) reads only the boolean, and
//   never the engine's spelling (is_commercial);
// - the pricing engine's own rule for a profile (isCommercialProperty): a
//   property type by the engine's list ('Office', 'Restaurant', 'HOA Common
//   Area'), a commercial subtype, a commercial category, a commercial service
//   pick. It is the rule that decides whether the engine prices a home;
// - the same property-type rule on the saved spelling (property_type);
// - a commercial subtype in the engine's other spelling (commercial_subtype:
//   the engine's intent, commercialSubtypeFromInput in estimate-engine.js);
// - a commercial risk type (the business-type bucket that sets the visits per
//   year), in either spelling. Any value that is set counts, also one that
//   names no bucket of today;
// - a service line the converter reads as commercial. The converter has two
//   rules for a line and neither holds the other: the word in any of the
//   line's names (isCommercialRecurringLine), and the key it gives the line
//   (recurringServiceKey, which also reads a line's `key`: the rule behind
//   hasCommercialRecurringLine, the bait check and the accept's own check);
// - the property answer of a quiz page, where the object keeps a quiz
//   ('business': quizIsCommercial in lead-quiz.js). A lead keeps the quiz in
//   its payload, and the intake marks the lead by the same rule;
// - the commercial category and a commercial subtype, each read ALONE. The
//   engine's rule prices one profile, so a residential type or a toggle set
//   to no in the same object wins there over a category or a subtype. Here
//   one mark is enough, as it is for the intake's rule for a form
//   (structuredCommercialSignal in lead-estimate-automation.js) and for the
//   payload scan of the save.
function nodeSaysCommercial(node) {
  const converter = require('./estimate-converter');
  return saysYes(node.isCommercial) || saysYes(node.is_commercial)
    || require('./pricing-engine/commercial-helpers').isCommercialProperty(node)
    || isCommercialPropertyType(node.property_type)
    || isSetSubtype(node.commercial_subtype) || isSetSubtype(node.commercialSubtype)
    || String(node.category ?? '').trim().toUpperCase() === 'COMMERCIAL'
    || isSet(node.commercialRiskType) || isSet(node.commercial_risk_type)
    || converter.isCommercialRecurringLine(node)
    || String(converter.recurringServiceKey(node) || '').startsWith('commercial_')
    || require('./lead-quiz').quizIsCommercial(node.quiz);
}

// Every object of the payload, at any depth. (The app's own scan stops 12
// levels down. This one has no limit: a mark it does not reach would read as
// a home.)
// And every TEXT in it, under any name or in a list, that starts with
// 'commercial_'. That is the prefix of the app's commercial service keys
// ('commercial_pest'), scopes ('commercial_suite') and review reasons
// ('commercial_risk_type_review'), and a payload also keeps such a key where
// no rule above looks: a list of picked keys, a field of another name. It is
// the value half of the broadest rule the app has for a saved estimate (the
// termite agreement's classifier searches the payload text for
// '"commercial_'). The other half is not read: a NAME that starts with
// 'commercial_' is also the name of a service pick that was not taken.
const COMMERCIAL_KEY_PREFIX = 'commercial_';
function payloadSaysCommercial(value) {
  if (typeof value === 'string') return value.trim().toLowerCase().startsWith(COMMERCIAL_KEY_PREFIX);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => payloadSaysCommercial(item));
  return nodeSaysCommercial(value) || Object.values(value).some((item) => payloadSaysCommercial(item));
}

// A JSON column as the driver returns it: the parsed value, or a text that
// still has to be parsed. A text that is not JSON is a failed read, as a
// failed query is: never "nothing in it".
function jsonValue(raw, what) {
  if (typeof raw !== 'string') return raw;
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`planStartBlocker could not read ${what}`);
  }
}
const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
// Does one object of a JSON value, at any depth, pass the test?
function someObject(value, test) {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && test(value)) return true;
  return Object.values(value).some((item) => someObject(item, test));
}
// Does one text of a JSON value, at any depth, pass the test?
function someText(value, test) {
  if (typeof value === 'string') return test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some((item) => someText(item, test));
}

// The payload of an estimate, null when the row has none. A payload that is
// not an object or a list is a failed read, as a failed query is.
function estimatePayload(raw) {
  if (raw === null || raw === undefined) return null;
  const data = require('./estimate-service-lines').parseEstimateData(raw);
  if (!data || typeof data !== 'object') throw new Error('planStartBlocker could not read an estimate payload');
  return data;
}

// Is this estimate commercial? The app has several rules for that, each made
// for its own flow, and none of them holds all the others. Any one is enough:
// - the category column. A save stamps it, but not every writer does: an
//   auto-priced commercial estimate can keep the default 'RESIDENTIAL';
// - the estimate's own tier column, by the account's rule for the tier (the
//   'commercial' value);
// - the estimate's own service label (service_interest), by the rule for a
//   service text (isCommercialServiceRow: the word in the label). A quote
//   request and the office save the label apart from the payload, so it can
//   be the only mark ('Commercial Pest Control' over an empty payload);
// - a commercial proposal, authored or scaffolded (isCommercialProposalData).
//   It is also the record of a WON proposal. A win marks the account
//   commercial only when the proposal has taxable lines, and it writes a
//   building use only when the proposal carries one (proposal-win.js), so a
//   won proposal can leave no mark on the account at all;
// - the payload scan the save stamps the category from
//   (isCommercialEstimateData);
// - the classifier of the accept and slot routes
//   (isCommercialAutoAcceptEstimate): commercial service rows;
// - a mark on any object of the payload (nodeSaysCommercial above), or a text
//   in it that starts with 'commercial_' (payloadSaysCommercial);
// - the reader the pipeline shows an estimate's service lines with
//   (inferEstimateServiceLines in estimate-service-lines.js): a line whose
//   key starts with 'commercial_'. For an estimate with no service line it
//   sorts the label, the label's copies in the payload and the notes by the
//   app's text patterns.
// Not the termite agreement's classifier itself (isCommercialEstimate in
// termite-program-agreement.js). It is broad on purpose, and three of its
// rules read homes: it parks a duplex, a condo and a townhome; it reads a
// NAME that starts with 'commercial_' (a service pick that was not taken);
// and it reads the words "commercial proposal" in free text. Every other
// mark it reads is read here (the toggle, the category, a subtype, a risk
// type, a commercial property type, the tier column, a commercial service
// key, a proposal).
function isCommercialEstimateRow(estimate) {
  if (String(estimate.category || '').trim().toUpperCase() === 'COMMERCIAL') return true;
  const { isCommercialAccount, isCommercialServiceRow } = require('./self-booking-plan-sync');
  if (isCommercialAccount({ waveguard_tier: estimate.waveguard_tier })) return true;
  if (isCommercialServiceRow({ service_type: estimate.service_interest })) return true;
  const data = estimatePayload(estimate.estimate_data);
  return require('./estimate-proposal').isCommercialProposalData(data)
    || require('./estimate-delivery-options').isCommercialEstimateData(data)
    || require('./estimate-commercial-identity').isCommercialAutoAcceptEstimate({ estimate_data: data })
    || payloadSaysCommercial(data)
    || require('./estimate-service-lines').inferEstimateServiceLines({ ...estimate, estimate_data: data })
      .some((line) => String(line.key || '').startsWith(COMMERCIAL_KEY_PREFIX));
}

// EVERY estimate of the account counts, whatever its status: a won one (the
// customer bought commercial work), an open one (the office quotes commercial
// work now) and an old one (the account was quoted as a business). An
// archived one too.
// The read carries the columns the rules above read. The reader of service
// lines reads four of the row: the label, the notes, the payload, and the
// pricing authority (it names the result the add-on lines come from).
async function hasCommercialEstimate(database, customerId) {
  const estimates = await database('estimates').where({ customer_id: customerId })
    .select('category', 'waveguard_tier', 'service_interest', 'notes', 'pricing_authority', 'estimate_data');
  return estimates.some((estimate) => isCommercialEstimateRow(estimate));
}

// Does this lead say commercial? A lead keeps what the intake knew, each fact
// in a column of its own, and no writer keeps the columns in step (the office
// form saves each one as it was typed). Any one is enough:
// - the commercial flag (is_commercial: the flag the booking-link rule
//   refuses on, call-booking-link-text.js);
// - the residential flag set to no (is_residential = false). The intake
//   writes it with the commercial flag, and the office form can clear it
//   alone;
// - the service the lead asked for, as a label (service_interest) or as a
//   catalog key (service_key), by the rule for a service text. The intake
//   reads a commercial service label as a commercial lead
//   (lead-estimate-automation.js);
// - the lead's own tier, by the account's rule for the tier;
// - the payload the intake kept (extracted_data: a form, a quiz, the
//   classification of an email), by the rules for an estimate payload: the
//   marks on every object, the text prefix, and the payload scan of the save
//   (isCommercialEstimateData). It keeps the same fields (isCommercial,
//   category, commercialSubtype, propertyType).
function isCommercialLeadRow(lead) {
  const { isCommercialAccount, isCommercialServiceRow } = require('./self-booking-plan-sync');
  if (lead.is_commercial === true || lead.is_residential === false) return true;
  if (isCommercialServiceRow({ service_type: lead.service_interest, service_key: lead.service_key })) return true;
  if (isCommercialAccount({ waveguard_tier: lead.waveguard_tier })) return true;
  const payload = jsonValue(lead.extracted_data, 'a lead payload');
  return payloadSaysCommercial(payload) || require('./estimate-delivery-options').isCommercialEstimateData(payload);
}

// EVERY lead of the account counts. A deleted lead too: the removal of a lead
// does not make the caller a home.
async function hasCommercialLead(database, customerId) {
  const leads = await database('leads').where({ customer_id: customerId })
    .select('is_commercial', 'is_residential', 'service_interest', 'service_key', 'waveguard_tier', 'extracted_data');
  return leads.some((lead) => isCommercialLeadRow(lead));
}

// A visit or a service report of the account with a commercial service, by
// the rule the calendar and tier readers apply to a row joined to its catalog
// row (isCommercialServiceRow: the row's own service text, the catalog key,
// the catalog name). `table` is scheduled_services (every visit: done,
// cancelled or still to come) or service_records (every service report). The
// app applies the rule to a report too (isCommercialPlan in
// email-division/payload-builders.js, the cross-sell in
// service-report/cross-sell.js), and a report keeps its own service text: its
// link to a visit is optional.
// A visit also keeps the catalog key it was booked under
// (service_key_snapshot). That key outlives the visit's link to the catalog,
// and isCommercialPlan reads it by the same rule.
const SERVICE_TEXT_COLUMNS = Object.freeze({
  scheduled_services: Object.freeze(['record.service_type', 'record.service_key_snapshot as serviceKey', 'svc.service_key', 'svc.name as service_name']),
  service_records: Object.freeze(['record.service_type', 'svc.service_key', 'svc.name as service_name']),
});
async function hasCommercialServiceIn(database, table, customerId) {
  const { isCommercialServiceRow } = require('./self-booking-plan-sync');
  const kinds = await database(`${table} as record`)
    .leftJoin('services as svc', 'record.service_id', 'svc.id')
    .where({ 'record.customer_id': customerId })
    .distinct(...SERVICE_TEXT_COLUMNS[table]);
  return kinds.some((kind) => isCommercialServiceRow(kind));
}

// A contract of the account made from a commercial agreement template, at any
// status (a draft, one sent, one signed, one voided). The app knows the
// commercial agreement by its template key (TEMPLATE_KEY in
// commercial-proposal-agreement.js: routes/contracts-public.js and the
// renewal reminder read it). The rule here is the word in the key, so a
// second commercial template counts on the day it is added.
async function hasCommercialContract(database, customerId) {
  const templates = await database('customer_contracts').where({ customer_id: customerId }).distinct('document_template_key');
  return templates.some((contract) => String(contract.document_template_key || '').toLowerCase().includes('commercial'));
}

// Did the call system sort this call as commercial? A call keeps what the
// extraction said about the caller's premises and request
// (ai_extraction_enriched; ai_extraction is the first format, kept as JSON
// text), what the triage decided (ai_validation) and what the address check
// found (ai_address_validation). Those saved verdicts are read. The words of
// the call (its transcript, its summary) are not.
// - The app's rule for an extraction that typed the premises commercial
//   (commercialCategoryConflict in estimator-engine/unit-scope-model.js): a
//   commercial property type, any commercial subtype, an HOA common area, the
//   owner or the manager of a multi-unit building. By that rule the tenant of
//   an apartment and the owner of a condo stay homes.
// - A property the extraction describes, wherever a format keeps it: the
//   main one (`property` of the extraction, the root of the first format) or
//   an additional one (additional_properties, in both formats). It counts by
//   a commercial occupancy ('commercial': the mark a saved property carries
//   in occupancy_type) or by a type the rule above reads as commercial. A
//   second address that is a business makes the account one with a business
//   premises, as a saved property does.
// - The extraction's commercial-signals block with a value set in it (a
//   business name, a budget or a procurement remark). The extraction leaves
//   the block null for a home.
// - One of the two flags the triage raises for such a call
//   (computeDeterministicTriageFlags in call-triage-flags.js), anywhere in
//   either verdict: the model's own flags, the routing flags, the flags that
//   hold a booking, or a list a later gate moved the flag to.
// - The service the caller asked for as the first format kept it
//   (requested_service, a text or an object of texts): the word in it, as in
//   the service label of a lead.
// - The address check of the call's service address: Google reads it as a
//   business and not as a home (addressUse). Both halves must be
//   affirmative, as in the app's own rule for a business building
//   (applyBusinessWholeBuildingUnitWaiver in call-triage-flags.js). An address
//   Google reads as both (a home with a business listing), or does not know,
//   says nothing.
const COMMERCIAL_CALL_FLAGS = Object.freeze(['commercial_requires_quote', 'hoa_common_area_requires_approval']);
const isCommercialCallFlag = (text) => COMMERCIAL_CALL_FLAGS.includes(text);
const carriesCommercialWord = (text) => text.toLowerCase().includes('commercial');
const hasSetValue = (block) => Object.values(asObject(block)).some((value) => (Array.isArray(value) ? value.length > 0 : isSet(value)));
function describesCommercialProperty(node) {
  const { commercialCategoryConflict } = require('./estimator-engine/unit-scope-model');
  return node.service_address_occupancy === 'commercial' || node.occupancy === 'commercial'
    || Boolean(commercialCategoryConflict({ extraction: { property: node }, intent: null }));
}
function isBusinessAddress(addressCheck) {
  const use = asObject(asObject(addressCheck).addressUse);
  return use.business === true && use.residential === false;
}
function isCommercialCallRow(call) {
  const extraction = asObject(jsonValue(call.ai_extraction_enriched, "a call's extraction"));
  const validation = jsonValue(call.ai_validation, "a call's validation");
  const firstFormat = asObject(jsonValue(call.ai_extraction, "a call's first extraction"));
  const addressCheck = jsonValue(call.ai_address_validation, "a call's address check");
  const { commercialCategoryConflict } = require('./estimator-engine/unit-scope-model');
  return Boolean(commercialCategoryConflict({ extraction, intent: null }))
    || someObject(extraction, describesCommercialProperty) || someObject(firstFormat, describesCommercialProperty)
    || hasSetValue(extraction.commercial_signals)
    || someText(extraction, isCommercialCallFlag) || someText(validation, isCommercialCallFlag)
    || someText(firstFormat.requested_service, carriesCommercialWord)
    || isBusinessAddress(addressCheck);
}

// EVERY call of the account counts, whatever its age or direction: the caller
// told the office about a business once. (Production, 2026-11-20: a call was
// the only commercial mark of more live accounts than any other record.)
async function hasCommercialCall(database, customerId) {
  const calls = await database('call_log').where({ customer_id: customerId })
    .select('ai_extraction', 'ai_extraction_enriched', 'ai_validation', 'ai_address_validation');
  return calls.some((call) => isCommercialCallRow(call));
}

// A day-agreement decision of the account whose judge named the commercial
// blocker (BLOCKERS in prompts/day-agreement-v1.js). The judge read a call or
// a text thread of this customer as commercial work, and the app saved that
// with the decision (day-agreement-rules.js keeps the judge's blockers as a
// list of the vocabulary's words).
const COMMERCIAL_DAY_BLOCKER = 'commercial';
async function hasCommercialDayAgreement(database, customerId) {
  const decisions = await database('day_agreement_decisions').where({ customer_id: customerId }).select('judged');
  // A list of the vocabulary's words (or one bare word, if a writer ever saves it so).
  return decisions.some((decision) => someText(
    asObject(jsonValue(decision.judged, 'a day-agreement decision')).blockers,
    (blocker) => blocker === COMMERCIAL_DAY_BLOCKER,
  ));
}

// Does a record of the account say commercial? Each kind of record is one
// read on the caller's handle.
async function hasCommercialRecord(database, customerId) {
  return (await hasCommercialProperty(database, customerId))
    || (await hasCommercialEstimate(database, customerId))
    || (await hasCommercialLead(database, customerId))
    || (await hasCommercialServiceIn(database, 'scheduled_services', customerId))
    || (await hasCommercialServiceIn(database, 'service_records', customerId))
    || (await hasCommercialContract(database, customerId))
    || (await hasCommercialCall(database, customerId))
    || (await hasCommercialDayAgreement(database, customerId));
}

async function planStartBlocker(database, customerId) {
  if (!database || !customerId) throw new Error('planStartBlocker needs a database handle and a customer id');
  const customer = await database('customers').where({ id: customerId }).first();
  // The live rule of the offer surfaces (resolvePortalOfferPremises in
  // service-report/cross-sell.js). The calendar read answers no row for an
  // inactive account, so the plan check below cannot answer for one.
  if (!customer || customer.active === false || customer.deleted_at) return 'not_live';
  // The account-level rule (the 'commercial' tier, or a commercial or business
  // property type) and the pricing engine's own rule for a property type. The
  // membership predicate reads the 'commercial' tier as "no plan", so without
  // this a commercial account between visits would read as a home with no
  // plan.
  // Also a building use on the account. Only a won commercial proposal writes
  // one (recordProposalBuildingUse in proposal-win.js), and it marks the
  // account commercial only when the proposal has taxable lines. So the
  // account of a community or a builder ('residential': homes and their
  // common areas, not taxed) reads residential by the rule above, and it is a
  // commercial-proposal customer all the same.
  // And a sold commercial scope in the service preferences, which only a
  // commercial accept writes (hasCommercialSoldScope).
  const { isCommercialAccount } = require('./self-booking-plan-sync');
  if (isCommercialAccount(customer) || isCommercialPropertyType(customer.property_type) || customer.building_use) return 'commercial';
  if (hasCommercialSoldScope(customer)) return 'commercial';
  if (await hasCommercialRecord(database, customer.id)) return 'commercial';
  return (await customerHoldsPlan(database, customer)) ? 'has_plan' : null;
}

module.exports = { planStartBlocker, PLAN_START_BLOCKERS };
