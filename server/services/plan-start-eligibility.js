// Does a record of this account stand against a NEW residential plan that the
// app would price, or offer, with nobody watching?
//
// planStartBlocker(database, customerId) answers null when none of the records
// it reads stands against it, or the first reason that does:
//   'not_live'    no such customer, an inactive account, or a deleted one
//   'commercial'  a record of the account says commercial: the account row,
//                 a saved property, an estimate, a lead, a visit, one of
//                 its add-ons or the service its series goes on with, a
//                 service report, a contract, a call or a day-agreement
//                 decision (never a residential plan)
//   'has_plan'    the customer already holds a plan (customerHoldsPlan below)
// A failed read THROWS. An outage is never "nothing stands against it": the
// caller is a job that tries again, or a pricer that must return no price.
//
// What it reads: the customers row, and the records that carry the id of that
// ONE account. For the commercial rule: its saved properties, its estimates,
// its leads, its visits and their add-ons, its service reports, its
// contracts, its calls and its day-agreement decisions (hasCommercialRecord
// below). For the plan rule:
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
// properties, its estimates, its leads, its visits and their add-ons, its
// service reports, its contracts, its calls and its day-agreement decisions
// (hasCommercialRecord).
// Each kind is read by the rules the app applies to a SAVED record of that
// kind. ONE mark is enough, whatever its age or status: an old estimate, a
// cancelled visit, a deleted lead, a removed address, a call of last year.
// That is the fail-closed side, on purpose: this proof
// clears an account for an offer nobody reads before it goes out. A business
// that gets a home price is the costly mistake. A home with one old
// commercial mark only gets no automatic offer.

// One rule for a property type the app SAVED (on the account, on a property,
// in a payload). The app has three rules for a type, and any one is enough:
// - the account-level list (commercial, business: isCommercialAccount in
//   self-booking-plan-sync.js);
// - the pricing engine's own rule (isCommercialProperty);
// - the estimator's recognition of a typed premises
//   (commercialCategoryConflict in estimator-engine/unit-scope-model.js,
//   asked here of a property that carries the type alone): its commercial
//   families and the common area of an association. The first two rules read
//   a 'hotel', a 'motel', a 'resort', a 'church' and a 'flex space' as homes.
// The estimator's rule reads one more input, the client: a property manager
// on an apartment, a multi-family or a condo property is commercial. The
// first two types read commercial alone, so the client decides a condo. The
// rule is asked with a manager (`managed`) where the saved record has one:
// - the account, by its contact role (property_manager). The role covers the
//   whole profile (constants/contact-roles.js: a manager's primary property
//   is never a residence), so it counts for every type saved for the account;
// - a saved property, by its own relationship (managed_for_client);
// - a payload or a call, where one object of it names a manager (namesManager
//   below).
// With no manager the owner of a condo stays a home.
// The property a CALL describes is read by the call system's rule alone
// (describesCommercialProperty below). That rule knows the caller: the tenant
// of a multi-family building is a home there, and the engine's rule reads any
// 'multi_family' as a business.
const MANAGER_WORD = 'property_manager';
const MANAGED_PROPERTY = 'managed_for_client';
const MANAGER_CALLER = Object.freeze({ relationship_to_property: MANAGER_WORD });
const isManagerWord = (value) => String(value ?? '').trim().toLowerCase() === MANAGER_WORD;
function estimatorReadsCommercial(propertyType, managed) {
  const { commercialCategoryConflict } = require('./estimator-engine/unit-scope-model');
  const extraction = { property: { property_type: propertyType }, caller: managed ? MANAGER_CALLER : null };
  return Boolean(commercialCategoryConflict({ extraction, intent: null }));
}
function isCommercialPropertyType(propertyType, managed) {
  const { isCommercialAccount } = require('./self-booking-plan-sync');
  const { isCommercialProperty } = require('./pricing-engine/commercial-helpers');
  return isCommercialAccount({ property_type: propertyType }) || isCommercialProperty({ propertyType })
    || estimatorReadsCommercial(propertyType, managed);
}
// One object of a JSON record that names the client as a manager. The app
// writes the role's word under two names: the relationship the estimator
// resolved, in the unit scope a draft keeps (customerRelationship), and the
// caller's relationship in a call's extraction (relationship_to_property).
// The word is matched exactly: each writer saves it from a closed vocabulary
// (the contact roles, the estimator's resolver, the enum of the call schema),
// and the tests ask the estimator's rule about every word of the first and
// of the last. Not read as a manager: the role of a SECONDARY contact (the
// account's service_contact_role, the secondary contact of a call or of a
// lead). The estimator's rule reads the client alone. And the manager one
// JSON record names is the client of that record: a condo in another record
// of the account stays a home.
const RELATIONSHIP_NAMES = Object.freeze(['customerRelationship', 'relationship_to_property']);
const namesManager = (node) => RELATIONSHIP_NAMES.some((name) => isManagerWord(node[name]));
// Has this JSON record a manager: the account's, or one it names itself?
const hasManager = (record, managed) => managed || someObject(record, namesManager);

// A sold commercial scope in the account's service preferences
// (commercial_interior_scope). Only the accept of a commercial pest estimate
// writes the key (estimate-public.js: 'excluded' for an exterior-only scope,
// 'included' after a re-price), and no customer request can set it
// (routes/service-preferences.js keeps it across writes). So the key alone
// says a commercial plan was sold on this account. A value that is not an
// object carries no key (the route reads it the same way).
function hasCommercialSoldScope(customer) {
  const preferences = jsonbValue(customer.service_preferences);
  return Boolean(preferences) && typeof preferences === 'object' && isSet(preferences.commercial_interior_scope);
}

// Is one of the account's saved properties commercial? The account row carries
// only a mirror of the PRIMARY property's type (and the mirror can be behind),
// and nothing on it mirrors a property's occupancy. So an account that reads
// residential by its own row can have a saved property that says commercial:
// by its occupancy (the property's own mark, which the tax rule and the
// estimate tools read) or by its own type. The type is asked with a manager
// where the customer manages the property for a client: by the property's
// own relationship, or by the account's role.
// EVERY saved property counts. Not only the primary one: this proof gets no
// property to answer for, so it answers for the account, fail closed. And
// also one that was removed from the account (active = false): the removal of
// a business address does not make the account a home.
async function hasCommercialProperty(database, customerId, managed) {
  const properties = await database('customer_properties')
    .where({ customer_id: customerId })
    .select('occupancy_type', 'property_type', 'relationship');
  return properties.some((property) => property.occupancy_type === 'commercial'
    || isCommercialPropertyType(property.property_type, managed || property.relationship === MANAGED_PROPERTY));
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
// commercialCategoryConflict in estimator-engine/unit-scope-model.js). The
// form's spelling (commercialSubtype) is not read this way: there the payload
// scan of the save takes ANY text as a subtype, these two words too.
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
// - the kind of premises the object names (namesCommercialPremises below): a
//   property type, an occupancy, the flag of a common-area service, or the
//   estimator's verdict on its own draft;
// - a commercial subtype in the engine's other spelling (commercial_subtype:
//   the engine's intent, commercialSubtypeFromInput in estimate-engine.js);
// - a commercial risk type (the business-type bucket that sets the visits per
//   year), in either spelling. Any value that is set counts, also one that
//   names no bucket of today;
// - a service line the converter reads as commercial. The converter has two
//   rules for a line and neither holds the other: the word in any of the
//   line's names (isCommercialRecurringLine), and the key it gives the line
//   (recurringServiceKey, which also reads a line's `key`: the rule behind
//   hasCommercialRecurringLine, the bait check and the accept's own check).
//   The converter asks them of a service line, and so does the proof: of an
//   item of a list of service lines (LINE_LIST_NAMES below), and of an object
//   that names a service itself (one of SERVICE_NAMES is set). The three
//   other names the rules read (name, label, displayName) name anything: a
//   contact, a listed business and a product have a name too, and none of
//   those is a service line;
// - the property answer of a quiz page, where the object keeps a quiz
//   ('business': quizIsCommercial in lead-quiz.js). A lead keeps the quiz in
//   its payload, and the intake marks the lead by the same rule;
// - the commercial category and a commercial subtype, each read ALONE. The
//   engine's rule prices one profile, so a residential type or a toggle set
//   to no in the same object wins there over a category or a subtype. Here
//   one mark is enough, as it is for the intake's rule for a form
//   (structuredCommercialSignal in lead-estimate-automation.js) and for the
//   payload scan of the save;
// - each mark the payload scan of the save reads, at ANY depth. That scan
//   stops 12 levels down, and a mark must not change its meaning with its
//   depth. No rule above holds two of its marks: the mark of an auto-priced
//   commercial quote (commercialEstimatedPricing, which the accept routes
//   read too; read here as the toggle is read), and a subtype in the form's
//   spelling that is any text, also the word 'none';
// - the estimator's own verdict on the premises, where the object is the
//   property facts a draft keeps (estimatorEngine.propertyFactsV2): the
//   occupancy class 'commercial', or a commercial service scope (a suite, a
//   whole commercial building, a commercial parcel of several buildings, the
//   common area of an association: isCommercialServiceScope in
//   property-lookup/property-facts-v2.js);
// - what the lookup keeps on a profile about a business at the address, and
//   an estimate saves the profile (lookupSaysBusiness below);
// - the estimator engine's mark on a draft it made as a commercial proposal
//   (estimatorEngine.commercialProposal: the engine reads it back when it
//   meets the draft again). Read as the toggle is read;
// - a service the payload keeps as a label or a name, away from a service
//   line (namesCommercialService below).
// Not read: the parameters of a commercial price the estimator form keeps
// (commercialPricingMode, the pest and lawn cadences, the interior service)
// and the size of a suite the engine keeps with a commercial draft
// (commercialSuiteSize). They are not verdicts. Every home estimate carries
// the form's default pricing mode, the form writes the cadences only beside
// the toggle, a tool can set the interior service on any estimate, and the
// engine sizes a suite only for inputs it saves with the toggle set.
// Not read either, each one written beside a mark that is read: the notice
// text of an auto-priced commercial quote (commercialDisclaimer: its two
// writers set the quote mark from it), the research brief of a commercial
// proposal draft (commercialProspect: written with the engine's mark) and
// the terms block of a proposal (commercialTerms: a proposal counts when it
// is turned on or scaffolded, and the save of a proposal turns it on).
const COMMERCIAL_SERVICE_SCOPES = Object.freeze([
  'commercial_suite', 'entire_commercial_building', 'multi_building_commercial_parcel', 'association_common_area',
]);
const factsSayCommercial = (node) => node.occupancyClass === 'commercial' || COMMERCIAL_SERVICE_SCOPES.includes(node.serviceScope);
// The lookup asks staff about a business that is listed at the address ("Are
// we treating just your space or the whole building?"). It keeps three
// fields on the profile (profileCarriesBusinessScope in
// property-lookup/business-scope.js), and each one alone is a mark:
// - the scope staff decided (one suite, the whole building). The open
//   question ('scope_unresolved') decides nothing;
// - the answer itself ('suite', 'building'). The answer 'none' says "not
//   this business";
// - the source the lookup names for a commercial verdict. It writes a source
//   only on a commercial profile, so any source that is set counts
//   ('staff_confirmed_business' is the one an answer stamps).
// The listing itself (businessIdentity, serviceScopeSuggestion) is not read.
// A listing only suggests (the owner ruling that module carries): a home
// business at the number of a house is still a house. So a payload is read
// without the listing (LISTING_NAME below): what it keeps (the name of the
// listed business, its kind) says nothing of the customer.
// (The suggestion is one of two plain words, 'suite' or 'building', and no
// rule reads those.)
function lookupSaysBusiness(node) {
  const { SCOPE, normalizeOccupancyAnswer } = require('./property-lookup/business-scope');
  const answer = normalizeOccupancyAnswer(node.occupancyAnswer);
  return (isSet(node.serviceScopeDecision) && node.serviceScopeDecision !== SCOPE.UNRESOLVED)
    || (Boolean(answer) && answer !== 'none')
    || isSet(node.commercialDetectionSource);
}
// A service LABEL: the words a form, an office user or a model saved for the
// service somebody asked about. It says commercial in two ways:
// - the word in it ('Commercial Pest Control'), as the rule for a service row
//   reads a text (isCommercialServiceRow);
// - the wording the lead intake reads as a business premises ('Pest control
//   for a hotel', 'lawn care at our office': commercialTextSignal in
//   estimator-engine/unit-scope-model.js). The intake asks it of a lead's
//   service interest, and a match keeps the lead out of the automatic
//   residential draft (evaluateLeadEstimateAutomationReadiness in
//   lead-estimate-automation.js). Only the lead webhook saves a match: on
//   the lead's two flags, which the proof reads. A label from another writer
//   (the office's lead form, a call, the quote page) and a label edited
//   later carry no saved verdict, so the label is asked again here.
// A catalog key or a booked service row is not a label: those are read by
// the rule for a service row alone.
const carriesCommercialWord = (text) => text.toLowerCase().includes('commercial');
const labelSaysCommercial = (text) => carriesCommercialWord(text)
  || require('./estimator-engine/unit-scope-model').commercialTextSignal(text);
// The value of a label: a text, or a list or an object of texts.
const isCommercialLabel = (value) => someText(value, labelSaysCommercial);
// A label the app keeps away from a label column and away from a service line
// (the converter's two rules read a line's own names). Three families of
// names. Each is read on every object, by the rule for a label:
// - the names of the label columns, in both spellings (service_interest on an
//   estimate and a lead, lead_service_interest on an account). A payload
//   keeps copies under them: the lead's interest the estimator form carries
//   (inputs.leadServiceInterest), the interest the engine was given
//   (engineInputs.serviceInterest), the interest a web form or the
//   classification of an email named (service_interest in a lead payload).
//   The reader of service lines reads the first two only for an estimate
//   with no service line;
// - the three names a call keeps a service under (requested_service,
//   matched_service, specific_service_name: the fields the call system's
//   service resolvers read, CALL_SERVICE_VIEW_FIELDS in
//   call-recording-processor.js). A payload made from a call keeps them too;
// - the name of a row's own service text (service_type), in both spellings.
const SERVICE_LABEL_NAMES = Object.freeze([
  'serviceInterest', 'service_interest', 'leadServiceInterest', 'lead_service_interest',
  'requested_service', 'matched_service', 'specific_service_name',
  'serviceType', 'service_type',
]);
const namesCommercialService = (node) => isCommercialLabel(SERVICE_LABEL_NAMES.map((name) => node[name]));
// The kind of premises one object of a payload names. Six marks:
// - a property type, under either spelling of the name (property_type,
//   propertyType), by the rule for a saved type and with the manager of the
//   record (isCommercialPropertyType);
// - an occupancy, under one of the five names a payload keeps one. The
//   estimator form and the engine keep the occupancy of a bed bug job apart
//   from the property type (bedbugOccupancyType in the form's inputs,
//   occupancyType on the engine's service and on its priced line), and the
//   form saves a residential type by default. The engine prices four
//   occupancies and reads the three that are not a single-family home as an
//   explicit commercial scope (estimate-engine.js): an apartment, a hotel,
//   student housing. Each one is a mark here, also where the bed bug service
//   was not picked in the end: staff typed the premises. A lead keeps each
//   extra property the intake named in the shape of a call's property, with
//   its occupancy (occupancy). The lead's merge keeps every field of such an
//   entry (unionAdditionalProperties in lead-extracted-data-merge.js), so
//   the occupancy a call gives its main address (service_address_occupancy)
//   is read under its own name too. A property's own vocabulary has one
//   value that is not a home: 'commercial';
// - the use of the building, in the unit scope the estimator keeps with a
//   draft (unitScope.propertyUse: resolvePropertyUse in
//   estimator-engine/unit-scope-model.js). The estimator reads it from the
//   record's type AND from the land use of the parcel, so it can say 'office',
//   'retail' or 'industrial_flex' where the type beside it is generic, and no
//   other field of the draft keeps the land use. It is asked by the
//   estimator's own rule for a typed premises (estimatorReadsCommercial
//   above), with the manager of the record: an office, a retail building and
//   an industrial or flex building are commercial alone, a multifamily
//   building and a condominium with a manager. Not by the other two rules for
//   a type: the engine's reads any multifamily building as a business, and
//   the tenant of one unit is a home for the estimator (the owner ruling that
//   module carries);
// - the answer of the lookup's model on the use of the property, which the
//   lookup keeps under the same name in four words of its own (RESIDENTIAL,
//   COMMERCIAL, MIXED, UNKNOWN) and beside a use type (commercialUseType).
//   It is asked by the lookup's own rule for that answer
//   (hasStructuredCommercialAiSignal in property-lookup/commercial-ai-signal.js,
//   the last vote of the lookup for the category it saves): a mixed use is a
//   business there, and it is here;
// - the flag a call sets when the service is for the common areas of an
//   association (hoa_common_area_service). The call system routes such a job
//   commercial by definition: commercialCategoryConflict reads the flag
//   before the type. It is the other field of a call's property that says
//   commercial with a home type beside it, so it is read wherever a payload
//   keeps a property in that shape. The flag of a home IN an association
//   (hoa_community_flag) is another field, and it says nothing;
// - the estimator's verdict on a draft it made (categoryConflict, in the
//   property facts the draft keeps): the call or the lookup typed the
//   premises commercial while the draft stayed residential. It is the saved
//   answer of the rule this proof asks of a call (commercialCategoryConflict,
//   with the caller) or of the lookup's own (lookupCategoryConflict). A draft
//   can be the only record of that call on the account. Any value that is
//   set counts.
const OCCUPANCY_NAMES = Object.freeze(['bedbugOccupancyType', 'occupancyType', 'occupancy_type', 'occupancy', 'service_address_occupancy']);
const COMMERCIAL_OCCUPANCIES = Object.freeze(['apartment', 'hotel', 'studenthousing', 'commercial']);
const isCommercialOccupancy = (value) => COMMERCIAL_OCCUPANCIES.includes(String(value ?? '').trim().toLowerCase());
function namesCommercialPremises(node, managed) {
  const { hasStructuredCommercialAiSignal } = require('./property-lookup/commercial-ai-signal');
  return [node.property_type, node.propertyType].some((type) => isCommercialPropertyType(type, managed))
    || estimatorReadsCommercial(node.propertyUse, managed) || hasStructuredCommercialAiSignal(node)
    || OCCUPANCY_NAMES.some((name) => isCommercialOccupancy(node[name]))
    || node.hoa_common_area_service === true
    || isSet(node.categoryConflict);
}
// The lists a payload keeps service lines in, by the names the app's readers
// of lines take them from: the recurring services (services), the engine's
// priced lines (lineItems), the one-time lines (items, specItems), the manual
// commercial quote lines (manualQuoteLines, commercialManualQuoteLines) and
// the lines of a breakdown that need a quote (quoteRequiredItems).
const LINE_LIST_NAMES = Object.freeze(['services', 'lineItems', 'items', 'specItems', 'manualQuoteLines', 'commercialManualQuoteLines', 'quoteRequiredItems']);
// The fields of the converter's two rules that name a SERVICE. An object
// with one of them set is a service line wherever it sits.
const SERVICE_NAMES = Object.freeze(['service', 'serviceKey', 'service_key', 'key', 'serviceName', 'service_name']);
const namesAService = (node) => SERVICE_NAMES.some((name) => isSet(node[name]));
function isCommercialServiceLine(node, inLineList) {
  if (!inLineList && !namesAService(node)) return false;
  const converter = require('./estimate-converter');
  return converter.isCommercialRecurringLine(node) || String(converter.recurringServiceKey(node) || '').startsWith('commercial_');
}
function nodeSaysCommercial(node, managed, inLineList) {
  return saysYes(node.isCommercial) || saysYes(node.is_commercial) || saysYes(node.commercialEstimatedPricing)
    || require('./pricing-engine/commercial-helpers').isCommercialProperty(node)
    || namesCommercialPremises(node, managed)
    || isSetSubtype(node.commercial_subtype) || isSet(node.commercialSubtype)
    || String(node.category ?? '').trim().toUpperCase() === 'COMMERCIAL'
    || factsSayCommercial(node) || lookupSaysBusiness(node)
    || saysYes(node.commercialProposal)
    || namesCommercialService(node)
    || isSet(node.commercialRiskType) || isSet(node.commercial_risk_type)
    || isCommercialServiceLine(node, inLineList)
    || require('./lead-quiz').quizIsCommercial(node.quiz);
}

// Every object of the payload, at any depth. (The app's own scan stops 12
// levels down. This one has no limit: a mark it does not reach would read as
// a home.)
// And every TEXT in it, under any name or in a list, that IS a key with the
// prefix 'commercial_'. That is the prefix of the app's commercial service
// keys ('commercial_pest'), scopes ('commercial_suite') and review reasons
// ('commercial_risk_type_review'), and a payload also keeps such a key where
// no rule above looks: a list of picked keys, a field of another name. It is
// the value half of the broadest rule the app has for a saved estimate (the
// termite agreement's classifier searches the payload text for
// '"commercial_'), narrowed to a key: one word of letters, digits and '_',
// with ':' (the estimator's 'commercial_subtype:office'). Every such key in
// the app's code has that shape. A payload also keeps contact details (a call
// saves the email of a second contact in a lead payload), and an email like
// commercial_accounts@example.test starts with the prefix and is no key. Nor
// is a web address or a sentence.
// The other half is not read: a NAME that starts with 'commercial_' is also
// the name of a service pick that was not taken, and of the lawn area the
// price card keeps for any lawn quote (measuredBasisAnchor.commercial_lawn).
const COMMERCIAL_KEY_PREFIX = 'commercial_';
const COMMERCIAL_KEY = /^commercial_[a-z0-9_:]*$/;
// An object is an item of a list of service lines where the list sits under
// one of LINE_LIST_NAMES (inLineList). A list in such a list keeps the place;
// an object under a name of an item starts again.
// One name holds no part of the payload's own: the customer's OTHER
// properties (additional_properties), as a call's extraction describes them.
// The intakes copy the list to a lead whole, each entry in the call's format
// (normalizeAdditionalProperties in utils/intake-normalize.js makes the
// entries of a call and of a web form; the call processor and the hold of an
// unverified lead save them in extracted_data). So an entry there is asked
// by the CALL's rule for a property (describesCommercialProperty below), with
// the manager of the record, and by no mark of this scan: the copy of what a
// call said says what the call said. The pricing engine reads the type
// 'multi_family' as commercial for a quote; the call's rule reads it so for a
// manager only, and the tenant of a unit in a second building stays a home,
// on the call and on the lead made from it. (The app's own classifiers of a
// payload get the whole payload, as at a save. None of them reads a property
// type there.)
const CALL_PROPERTIES_NAME = 'additional_properties';
function payloadSaysCommercial(value, managed, inLineList = false) {
  if (typeof value === 'string') return COMMERCIAL_KEY.test(value.trim().toLowerCase());
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => payloadSaysCommercial(item, managed, inLineList));
  return nodeSaysCommercial(value, managed, inLineList)
    || Object.entries(value).some(([name, item]) => (name === CALL_PROPERTIES_NAME
      ? someObject(item, (property) => describesCommercialProperty(property, managed))
      : payloadSaysCommercial(item, managed, Array.isArray(item) && LINE_LIST_NAMES.includes(name))));
}

// The part of a payload that NO rule reads, under seven names, at any depth:
// - the listing of a business at the address, as the lookup keeps it on a
//   profile (lookupSaysBusiness above gives the reason);
// - the marketing attribution of a web submission, under the six names the
//   intakes save it (lead-webhook.js, public-quote.js,
//   public-property-lookup.js, booking-preferred-time.js,
//   public-lawn-assessment.js, lead-unverified-hold.js): the tags of the link
//   the visitor came by (utm), its click ids (clickIds), the page before and
//   the page landed on (referrer, landing_url), the object an intake keeps
//   them in (attribution), and the proof of the lead's source the server
//   makes from them (source_evidence). A campaign named 'commercial_pest'
//   names an advertisement, and the label of a source is no service line:
//   neither says what the premises of the visitor is. And the quote page
//   saves the tags as the browser sent them (public-quote.js keeps
//   attribution.utm whole), so a link can put any name there: a category, a
//   toggle, a relationship.
// So a payload is cut ONCE, before any rule sees it (readablePayload below):
// the proof's own scan, the manager lookup and each of the app's classifiers
// get the same cut payload. A rule that got the whole payload would read a
// mark in a link's tags (the save's scan reads a category at any depth). The
// same text under any other name (a picked service key) is a mark.
const LISTING_NAME = 'businessIdentity';
const ATTRIBUTION_NAMES = Object.freeze(['attribution', 'utm', 'clickIds', 'source_evidence', 'referrer', 'landing_url']);
const UNREAD_NAMES = Object.freeze([LISTING_NAME, ...ATTRIBUTION_NAMES]);
function withoutUnreadNames(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(withoutUnreadNames);
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !UNREAD_NAMES.includes(name))
    .map(([name, item]) => [name, withoutUnreadNames(item)]));
}

// A value of a JSONB column, as the driver returns it. PostgreSQL checks a
// jsonb value when it is written, so what comes back is never "not JSON": a
// text from such a column is a JSON string, a valid value. A text that parses
// is read as what it holds (a writer that serialized a payload twice). Any
// other text stays a text: a record with no structured mark, never a failed
// read. A throw here would stop this account on every run.
function jsonbValue(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
// A TEXT column that holds serialized JSON (call_log.ai_extraction is the one
// this proof reads). There a text that is not JSON is a failed read, as a
// failed query is: never "nothing in it".
function jsonText(raw, what) {
  if (typeof raw !== 'string') return raw;
  if (raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`planStartBlocker could not read ${what}`);
  }
}
// The payload of an estimate or a lead as every rule reads it: the value of
// the column, less the names no rule reads.
const readablePayload = (raw) => withoutUnreadNames(jsonbValue(raw));
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

// Is this estimate commercial? The app has several rules for that, each made
// for its own flow, and none of them holds all the others. Any one is enough:
// - the category column. A save stamps it, but not every writer does: an
//   auto-priced commercial estimate can keep the default 'RESIDENTIAL';
// - the estimate's own tier column, by the account's rule for the tier (the
//   'commercial' value);
// - the estimate's own service label (service_interest), by the rule for a
//   label (isCommercialLabel: the word in it, or the intake's wording for a
//   business premises). A quote request and the office save the label apart
//   from the payload, so it can be the only mark ('Commercial Pest Control'
//   over an empty payload);
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
//   in it that starts with 'commercial_' (payloadSaysCommercial). A type in
//   the payload is asked with a manager where the account has one, or where
//   an object of the payload names one (hasManager);
// - the reader the pipeline shows an estimate's service lines with
//   (inferEstimateServiceLines in estimate-service-lines.js): a line whose
//   key starts with 'commercial_'. For an estimate with no service line it
//   sorts the label, the label's copies in the payload and the notes by the
//   app's text patterns. (The label and its copies are also read on every
//   estimate, by the rule for a label: the reader answers with the service
//   lines first, where the estimate has one.) The reader looks for a
//   RECURRING line there, and it joins the notes to whatever else names a
//   service: the picks of the form, the label, an area add-on. Notes are
//   free text ("No commercial service" carries the word). So the reader is
//   asked WITHOUT the notes first, and with them only where nothing of the
//   estimate names a service: no line it answers but 'unknown', and no
//   one-time line (oneTimeServicesFromData, the reader's own list: it does
//   not answer with those for a home estimate).
// Not the termite agreement's classifier itself (isCommercialEstimate in
// termite-program-agreement.js). It is broad on purpose, and three of its
// rules read homes: it parks a duplex, a condo and a townhome; it reads a
// NAME that starts with 'commercial_' (a service pick that was not taken);
// and it reads the words "commercial proposal" in free text. Every other
// mark it reads is read here (the toggle, the category, a subtype, a risk
// type, a commercial property type, the tier column, a commercial service
// key, a proposal).
// Every rule for the payload reads it less the listing and the marketing
// attribution it keeps (readablePayload).
function isCommercialEstimateRow(estimate, managed) {
  if (String(estimate.category || '').trim().toUpperCase() === 'COMMERCIAL') return true;
  const { isCommercialAccount } = require('./self-booking-plan-sync');
  if (isCommercialAccount({ waveguard_tier: estimate.waveguard_tier })) return true;
  if (isCommercialLabel(estimate.service_interest)) return true;
  // The payload (a jsonb column). One that is not an object or a list (a
  // text, a number) carries no structured mark: only the rule for a text can
  // read it, and the columns above still answer.
  const payload = readablePayload(estimate.estimate_data);
  return require('./estimate-proposal').isCommercialProposalData(payload)
    || require('./estimate-delivery-options').isCommercialEstimateData(payload)
    || require('./estimate-commercial-identity').isCommercialAutoAcceptEstimate({ estimate_data: payload })
    || payloadSaysCommercial(payload, hasManager(payload, managed))
    || commercialServiceLine(estimate, payload);
}
const UNKNOWN_LINE_KEY = 'unknown';
function commercialServiceLine(estimate, payload) {
  const { inferEstimateServiceLines, oneTimeServicesFromData } = require('./estimate-service-lines');
  const linesWith = (notes) => inferEstimateServiceLines({ ...estimate, estimate_data: payload, notes });
  const isCommercialLine = (line) => String(line.key || '').startsWith(COMMERCIAL_KEY_PREFIX);
  const structured = linesWith(null);
  if (structured.some(isCommercialLine)) return true;
  const namesAServiceAlready = structured.some((line) => line.key !== UNKNOWN_LINE_KEY) || oneTimeServicesFromData(payload).length > 0;
  return !namesAServiceAlready && linesWith(estimate.notes).some(isCommercialLine);
}

// EVERY estimate of the account counts, whatever its status: a won one (the
// customer bought commercial work), an open one (the office quotes commercial
// work now) and an old one (the account was quoted as a business). An
// archived one too.
// The read carries the columns the rules above read. The reader of service
// lines reads four of the row: the label, the notes, the payload, and the
// pricing authority (it names the result the add-on lines come from).
async function hasCommercialEstimate(database, customerId, managed) {
  const estimates = await database('estimates').where({ customer_id: customerId })
    .select('category', 'waveguard_tier', 'service_interest', 'notes', 'pricing_authority', 'estimate_data');
  return estimates.some((estimate) => isCommercialEstimateRow(estimate, managed));
}

// Does this lead say commercial? A lead keeps what the intake knew, each fact
// in a column of its own, and no writer keeps the columns in step (the office
// form saves each one as it was typed). Any one is enough:
// - the commercial flag (is_commercial: the flag the booking-link rule
//   refuses on, call-booking-link-text.js);
// - the residential flag set to no (is_residential = false). The intake
//   writes it with the commercial flag, and the office form can clear it
//   alone;
// - the service the lead asked for: its label (service_interest) by the rule
//   for a label, and its catalog key (service_key) by the rule for a service
//   row. The intake reads a commercial service label as a commercial lead,
//   and a label that names a business premises too
//   (lead-estimate-automation.js);
// - the lead's own tier, by the account's rule for the tier;
// - the payload the intake kept (extracted_data: a form, a quiz, the
//   classification of an email), by the rules for an estimate payload: the
//   marks on every object (with the manager of the record, as for an
//   estimate), the text prefix, and the payload scan of the save
//   (isCommercialEstimateData). It keeps the same fields (isCommercial,
//   category, commercialSubtype, propertyType), and a web form keeps the
//   service label in it too (service_interest). A web form also keeps the
//   marketing attribution of the submission there: no rule reads that part,
//   the save's scan neither (readablePayload). The intake's own commercial
//   verdict reads the words and the service of the submission, never its
//   campaign (lead-estimate-automation.js), and it is in the two flags above.
function isCommercialLeadRow(lead, managed) {
  const { isCommercialAccount, isCommercialServiceRow } = require('./self-booking-plan-sync');
  if (lead.is_commercial === true || lead.is_residential === false) return true;
  if (isCommercialLabel(lead.service_interest) || isCommercialServiceRow({ service_key: lead.service_key })) return true;
  if (isCommercialAccount({ waveguard_tier: lead.waveguard_tier })) return true;
  const payload = readablePayload(lead.extracted_data);
  return payloadSaysCommercial(payload, hasManager(payload, managed)) || require('./estimate-delivery-options').isCommercialEstimateData(payload);
}

// EVERY lead of the account counts. A deleted lead too: the removal of a lead
// does not make the caller a home.
async function hasCommercialLead(database, customerId, managed) {
  const leads = await database('leads').where({ customer_id: customerId })
    .select('is_commercial', 'is_residential', 'service_interest', 'service_key', 'waveguard_tier', 'extracted_data');
  return leads.some((lead) => isCommercialLeadRow(lead, managed));
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

// An add-on of a visit of the account with a commercial service, by the same
// rule. An add-on is a second service on the visit with an identity of its
// own, and the app reads that identity from four fields
// (tree-shrub-fast-context.js): the name the add-on was saved under, the
// catalog key it was booked under (service_key_snapshot), and the key and the
// name of its catalog row, where its link to the catalog still stands. Every
// add-on of every visit of the account counts, whatever the visit's status.
// (The join to a visit's add-ons has its index since migration
// 20261120200000.)
async function hasCommercialAddon(database, customerId) {
  const { isCommercialServiceRow } = require('./self-booking-plan-sync');
  const kinds = await database('scheduled_service_addons as addon')
    .join('scheduled_services as visit', 'addon.scheduled_service_id', 'visit.id')
    .leftJoin('services as svc', 'addon.service_id', 'svc.id')
    .where({ 'visit.customer_id': customerId })
    .distinct('addon.service_name', 'addon.service_key_snapshot as serviceKey', 'svc.service_key', 'svc.name as name');
  return kinds.some((kind) => isCommercialServiceRow(kind));
}

// The service a recurring series goes on with. An edit of "this visit and the
// ones after it" leaves the first visit as it was done and saves the new
// service on the series root, apart from the root's own columns
// (recurring_template_overrides). The app's reader of that value is
// parseTemplateOverrides in recurring-template-overrides.js: it keeps the
// service text, the saved catalog key and the catalog link. The visit read
// above sees a row's own columns only. A gate decides whether the scheduler
// uses a saved override. This proof reads it either way: someone saved a
// commercial service on a series of this account.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function hasCommercialSeriesTemplate(database, customerId) {
  const { parseTemplateOverrides } = require('./recurring-template-overrides');
  const { isCommercialServiceRow } = require('./self-booking-plan-sync');
  const rows = await database('scheduled_services as series').where({ 'series.customer_id': customerId })
    .whereNotNull('series.recurring_template_overrides').select('series.recurring_template_overrides');
  const templates = rows.map((row) => parseTemplateOverrides(row.recurring_template_overrides)).filter(Boolean);
  if (templates.some((template) => isCommercialServiceRow({ service_type: template.service_type, serviceKey: template.service_key_snapshot }))) return true;
  // The catalog rows the templates link to. A link that is not an id of the
  // catalog's kind (a uuid) names no catalog row.
  const serviceIds = [...new Set(templates.map((template) => template.service_id).filter((id) => UUID_SHAPE.test(String(id))))];
  if (!serviceIds.length) return false;
  const services = await database('services').whereIn('id', serviceIds).select('service_key', 'name');
  return services.some((service) => isCommercialServiceRow(service));
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
// the call (its transcript, its summary) are not. Nor is the call's record of
// what it wrote to a lead (metadata.lead_prior_state and lead_written_state:
// the restore record of a call that is linked again). The lead itself is
// read.
// The extraction is a verdict only where it passed its schema
// (v2_extraction_status = 'valid'). The call processor also keeps the output
// of a model that FAILED the schema, for the audit of the failure
// ('schema_failed'), and the app's readers take the extraction at 'valid'
// alone (call-intelligence.js, call-commitments.js, call-last-name-lookup.js,
// the processor itself). So an extraction at any other status is not read.
// The call's other three records are read at every status: the first format,
// the triage's decision and the address check. (The processor makes the last
// two from a valid extraction alone, so a failed one leaves no flag there.)
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
//   premises, as a saved property does. Each such property is asked with a
//   manager where the call has one (its caller, or the account's role): the
//   rule above reads the caller for the main property alone, and a manager's
//   second property is a client's too. The rule's other reading of the caller
//   (the owner of an apartment building with no unit line) stays with the
//   main property: an additional property keeps no service address to find a
//   unit line in.
// - The extraction's commercial-signals block with a value set in it (a
//   business name, a budget or a procurement remark). The extraction leaves
//   the block null for a home.
// - One of the two flags the triage raises for such a call
//   (computeDeterministicTriageFlags in call-triage-flags.js), in a list of
//   flags: the model's own (the extraction's triage_flags), or the routing
//   decision of the validation (its flags, the flags that hold a booking, any
//   list that decision keeps). No other part of either record is read for a
//   flag. The validation also keeps the schema errors of an extraction, and
//   the error for a flag the schema does not know lists every flag it allows
//   (the allowedValues of an enum), these two among them: a list of what a
//   model MAY say, on a call where the triage raised nothing.
// - The service the caller asked for, by name (namesCommercialService above),
//   on every object of both formats. The first format keeps it at its root
//   under three names (requested_service, matched_service,
//   specific_service_name) and again in the record of what an adoption
//   replaced there (pre_adoption_service_fields). The extraction keeps it in
//   service_request.specific_service_name. It is read by the rule for a
//   label, as the service label of a lead is. The first format's other two
//   service fields are the words of the call (call_summary, pain_points) and
//   are not read, and the extraction's service categories have no commercial
//   word.
// - The address check of the call's service address: Google reads it as a
//   business and not as a home (addressUse). Both halves must be
//   affirmative, as in the app's own rule for a business building
//   (applyBusinessWholeBuildingUnitWaiver in call-triage-flags.js). An address
//   Google reads as both (a home with a business listing), or does not know,
//   says nothing. And the check must have CONFIRMED the address: the status
//   validated_accept or corrected (a complete match at the level of a
//   premises, in the service area, with no unconfirmed part), which is what
//   the app's readers of a check take as a confirmed address
//   (call-triage-flags.js). The check keeps the use at every status, also of
//   the candidate an ambiguous or incomplete match found, and a misheard
//   home address can resolve to a business candidate.
const COMMERCIAL_CALL_FLAGS = Object.freeze(['commercial_requires_quote', 'hoa_common_area_requires_approval']);
const isCommercialCallFlag = (text) => COMMERCIAL_CALL_FLAGS.includes(text);
const hasSetValue = (block) => Object.values(asObject(block)).some((value) => (Array.isArray(value) ? value.length > 0 : isSet(value)));
function describesCommercialProperty(node, managed) {
  const { commercialCategoryConflict } = require('./estimator-engine/unit-scope-model');
  const extraction = { property: node, caller: managed ? MANAGER_CALLER : null };
  return node.service_address_occupancy === 'commercial' || node.occupancy === 'commercial'
    || Boolean(commercialCategoryConflict({ extraction, intent: null }));
}
function isBusinessAddress(addressCheck) {
  const { STATUSES } = require('./address-validation');
  const check = asObject(addressCheck);
  if (![STATUSES.VALIDATED_ACCEPT, STATUSES.CORRECTED].includes(check.status)) return false;
  const use = asObject(check.addressUse);
  return use.business === true && use.residential === false;
}
const VALID_EXTRACTION = 'valid';
function isCommercialCallRow(call, managed) {
  const extraction = call.v2_extraction_status === VALID_EXTRACTION ? asObject(jsonbValue(call.ai_extraction_enriched)) : {};
  const validation = jsonbValue(call.ai_validation);
  const firstFormat = asObject(jsonText(call.ai_extraction, "a call's first extraction"));
  const addressCheck = jsonbValue(call.ai_address_validation);
  const { commercialCategoryConflict } = require('./estimator-engine/unit-scope-model');
  const managedCall = hasManager(extraction, managed);
  const describes = (node) => describesCommercialProperty(node, managedCall);
  return Boolean(commercialCategoryConflict({ extraction, intent: null }))
    || someObject(extraction, describes) || someObject(firstFormat, describes)
    || hasSetValue(extraction.commercial_signals)
    || someText(extraction.triage_flags, isCommercialCallFlag) || someText(asObject(validation).routing, isCommercialCallFlag)
    || someObject(firstFormat, namesCommercialService) || someObject(extraction, namesCommercialService)
    || isBusinessAddress(addressCheck);
}

// EVERY call of the account counts, whatever its age or direction: the caller
// told the office about a business once. (Production, 2026-11-20: a call was
// the only commercial mark of more live accounts than any other record.)
async function hasCommercialCall(database, customerId, managed) {
  const calls = await database('call_log').where({ customer_id: customerId })
    .select('ai_extraction', 'ai_extraction_enriched', 'v2_extraction_status', 'ai_validation', 'ai_address_validation');
  return calls.some((call) => isCommercialCallRow(call, managed));
}

// A day-agreement decision of the account whose judge named the commercial
// blocker (BLOCKERS in prompts/day-agreement-v1.js). The judge read a call or
// a text thread of this customer as commercial work, and the app saved that
// with the decision (day-agreement-rules.js keeps the judge's blockers as a
// list of the vocabulary's words).
// (The lookup has its index since migration 20261120200000.)
const COMMERCIAL_DAY_BLOCKER = 'commercial';
async function hasCommercialDayAgreement(database, customerId) {
  const decisions = await database('day_agreement_decisions').where({ customer_id: customerId }).select('judged');
  // A list of the vocabulary's words (or one bare word, if a writer ever saves it so).
  return decisions.some((decision) => someText(
    asObject(jsonbValue(decision.judged)).blockers,
    (blocker) => blocker === COMMERCIAL_DAY_BLOCKER,
  ));
}

// Does a record of the account say commercial? Each kind of record is one
// read on the caller's handle.
async function hasCommercialRecord(database, customerId, managed) {
  return (await hasCommercialProperty(database, customerId, managed))
    || (await hasCommercialEstimate(database, customerId, managed))
    || (await hasCommercialLead(database, customerId, managed))
    || (await hasCommercialServiceIn(database, 'scheduled_services', customerId))
    || (await hasCommercialAddon(database, customerId))
    || (await hasCommercialSeriesTemplate(database, customerId))
    || (await hasCommercialServiceIn(database, 'service_records', customerId))
    || (await hasCommercialContract(database, customerId))
    || (await hasCommercialCall(database, customerId, managed))
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
  // property type) and the rule for a saved property type, asked with a
  // manager where the account's contact role is one. The membership predicate
  // reads the 'commercial' tier as "no plan", so without this a commercial
  // account between visits would read as a home with no plan.
  // Also a building use on the account. Only a won commercial proposal writes
  // one (recordProposalBuildingUse in proposal-win.js), and it marks the
  // account commercial only when the proposal has taxable lines. So the
  // account of a community or a builder ('residential': homes and their
  // common areas, not taxed) reads residential by the rule above, and it is a
  // commercial-proposal customer all the same.
  // And a sold commercial scope in the service preferences, which only a
  // commercial accept writes (hasCommercialSoldScope).
  // And the service the intake saved on the account itself
  // (lead_service_interest: a form, a text thread or a quote writes it), by
  // the rule for a label, as on a lead or an estimate. It can be the only
  // place that label was kept.
  const { isCommercialAccount } = require('./self-booking-plan-sync');
  const managed = isManagerWord(customer.contact_role);
  if (isCommercialAccount(customer) || isCommercialPropertyType(customer.property_type, managed) || customer.building_use) return 'commercial';
  if (hasCommercialSoldScope(customer) || isCommercialLabel(customer.lead_service_interest)) return 'commercial';
  if (await hasCommercialRecord(database, customer.id, managed)) return 'commercial';
  return (await customerHoldsPlan(database, customer)) ? 'has_plan' : null;
}

// The type of the property a pricer resolved for an account, after the proof
// above cleared it. A lookup or an estimate seed can name a type that no
// saved record of the account carries, and the proof reads saved records
// only. The type is judged as a type saved for the account is: by the same
// rule (isCommercialPropertyType), with a manager where the account has one:
// its contact role, or a saved property it manages for a client (any one:
// this answer gets no property to answer for, as the proof above). So a
// property manager's condo is a business here too, though the engine's rule
// reads a condo as a home.
// Answers 'commercial', null, or 'not_live' when the account is gone. Throws
// on a failed read.
async function resolvedPropertyTypeBlocker(database, customerId, propertyType) {
  if (!database || !customerId) throw new Error('resolvedPropertyTypeBlocker needs a database handle and a customer id');
  const customer = await database('customers').where({ id: customerId }).first('contact_role');
  if (!customer) return 'not_live';
  const managed = isManagerWord(customer.contact_role)
    || Boolean(await database('customer_properties').where({ customer_id: customerId, relationship: MANAGED_PROPERTY }).first('id'));
  return isCommercialPropertyType(propertyType, managed) ? 'commercial' : null;
}

// isCommercialEstimateRow: also read by the estimate email's "no visit needed" line (estimate-no-visit-line.js), which
// goes to a home estimate only. One reading of "this estimate says commercial" for both.
module.exports = { planStartBlocker, resolvedPropertyTypeBlocker, PLAN_START_BLOCKERS, isCommercialEstimateRow };
