/**
 * Lead-writer registry — groundwork for #3137 (lead identity dedup across
 * every inbound channel). NO behavior lives here.
 *
 * Problem: ~17 distinct `leads` INSERT sites exist across server/ and only the
 * phone-call pipeline runs real identity reuse (findReusableCallLead — phone
 * key + nickname-aware name corroboration, PR #3627). Web forms, the quote
 * wizard, lawn/pest claim flows, referrals, field leads etc. can mint a
 * duplicate lead for a person the system already knows. The dedup RULE those
 * writers should adopt is blocked on an owner ruling, tracked in issue #3137
 * ("Identity-dedupe protocol rollout": which shared identity lock/read
 * protocol the non-call writers adopt), so this file does not fix them — it
 * makes the writer set VISIBLE and makes every NEW writer declare its
 * identity resolver.
 *
 * Enforcement (tests/lead-writer-registry.test.js, no DB): the test scans
 * server/ for every knex insert spelling — `<qb>('leads').insert(`,
 * `<qb>.table('leads').insert(`, `.into('leads')`, `insert('leads')`,
 * `batchInsert('leads'`, raw SQL (`INSERT INTO leads`, schema-qualified
 * included), the stored-builder alias form
 * (`const leads = trx('leads'); ... leads.insert(`), and every shape again
 * with an identifier a same-file constant binds to 'leads'
 * (`const TABLE = 'leads'`) — and requires a 1:1
 * match with the entries below. A new insert site that is
 * not registered FAILS CI; a registered site that no longer exists (stale
 * registry) FAILS CI.
 *
 * Adding a new lead writer:
 *   1. Prefer routing through an existing resolver (findReusableCallLead /
 *      attributeInboundContact / findUnconvertedLeadsByContact) over a bare
 *      insert.
 *   2. Add an entry: `file` (server-relative), `anchor` (the exact trimmed
 *      source line where the insert statement STARTS — unique within the
 *      file; never a line number), `context` (route/function, informational),
 *      `identityResolver` (helper name that the file actually references, or
 *      'none'), and `reason` when 'none'.
 *   3. 'none' is allowed only with a reason. The pre-existing sites below use
 *      PENDING_RULING_REASON — do NOT reuse it for a new writer; a new writer
 *      without a resolver needs its own justification.
 *
 * Anchor contract: the anchor is the trimmed text of the line on which the
 * scanner's match begins (the `const [x] = await db('leads')` head line). It
 * is stable across edits elsewhere in the file and fails loudly if the
 * statement is rewritten, which is the intent — a rewrite is a re-review.
 */

const PENDING_RULING_REASON = 'pre-existing — dedup pending #3137 ruling';

const LEAD_WRITERS = [
  // ── Routes ────────────────────────────────────────────────────────────────
  {
    file: 'routes/admin-leads.js',
    anchor: "const [lead] = await db('leads').insert({",
    context: 'POST /api/admin/leads — manual lead create from the admin UI',
    identityResolver: 'none',
    reason: PENDING_RULING_REASON,
  },
  {
    file: 'routes/lead-webhook.js',
    anchor: "const [newLead] = await db('leads').insert({",
    // Mounted at POST /api/webhooks/lead AND the POST /api/leads alias
    // (server/index.js) — both execute this insert.
    context: 'POST /api/webhooks/lead + /api/leads alias — main-site web forms (astro BookingForm/QuoteForm/ChatWidget)',
    // Partial: attaches to an OPEN phone-call lead on the same number (and to
    // a voicemail text-back prefill lead by token). No email/name reuse for
    // web-only repeat submitters.
    identityResolver: 'attachOpenCallLeadByPhone',
    note: 'partial — phone-matched open call leads only; web-vs-web duplicates not resolved (#3137)',
  },
  {
    file: 'routes/public-lawn-assessment.js',
    anchor: "const [lead] = await trx('leads').insert({",
    context: 'POST /:id/claim — lawn assessment claim → lead',
    identityResolver: 'none',
    reason: PENDING_RULING_REASON,
  },
  {
    file: 'routes/public-lawn-diagnostic.js',
    anchor: "const [lead] = await trx('leads').insert({",
    context: 'POST /:token/quote-request — lawn diagnostic quote request → lead',
    identityResolver: 'none',
    reason: PENDING_RULING_REASON,
  },
  {
    file: 'routes/public-pest-identifier.js',
    anchor: "const [lead] = await trx('leads').insert({",
    context: 'POST /:id/claim — pest identifier claim → lead',
    identityResolver: 'none',
    reason: PENDING_RULING_REASON,
  },
  {
    file: 'routes/public-property-lookup.js',
    anchor: "[lead] = await db('leads').insert({",
    context: 'POST /property-lookup — quote wizard step 1 (lead captured before the property API chain)',
    // The prefill-token branch above it UPDATES the same-session lead by id;
    // that is session continuity, not identity resolution.
    identityResolver: 'none',
    reason: PENDING_RULING_REASON,
  },
  {
    file: 'routes/public-quote.js',
    anchor: "const rows = await db('leads').insert({",
    context: 'POST /calculate — quote wizard calculate (mints when no same-session lead id)',
    identityResolver: 'none',
    reason: PENDING_RULING_REASON,
  },
  {
    file: 'routes/tech-field-lead.js',
    anchor: "const [lead] = await db('leads')",
    context: 'POST / — technician field-observation lead (customer_id linked, no lead dedup)',
    identityResolver: 'none',
    reason: PENDING_RULING_REASON,
  },
  {
    file: 'routes/tech-lawn-diagnostic.js',
    anchor: "const [lead] = await trx('leads').insert({",
    context: 'POST /:id/lead — tech-portal lawn diagnostic → lead',
    identityResolver: 'none',
    reason: PENDING_RULING_REASON,
  },

  // ── Services ──────────────────────────────────────────────────────────────
  {
    file: 'services/call-recording-processor.js',
    anchor: "const [newLead] = await db('leads').insert({",
    context: 'processRecording Step 4 — fresh lead when findReusableCallLead returns none',
    identityResolver: 'findReusableCallLead',
  },
  {
    file: 'services/call-recording-processor.js',
    anchor: "const [conflictFresh] = await db('leads').insert({",
    context: 'processRecording — deliberate fresh mint on shared-phone NAME CONFLICT observed under the row lock (#3627)',
    identityResolver: 'findReusableCallLead',
  },
  {
    file: 'services/call-recording-processor.js',
    anchor: "const [raceFresh] = await db('leads').insert({",
    context: 'processRecording — deliberate fresh mint after losing the email claim race',
    identityResolver: 'findReusableCallLead',
  },
  {
    file: 'services/email/email-actions.js',
    anchor: "const [lead] = await db('leads').insert({",
    context: 'handleLeadInquiry — inbound email classified as a lead inquiry',
    // Inline lookup: open lead by exact email (dedupEmail) OR phone, no name
    // corroboration. Named by the variable that drives it.
    identityResolver: 'dedupEmail',
    note: 'inline exact email-or-phone match on open leads; no name corroboration, no normalization',
  },
  {
    file: 'services/lead-attribution.js',
    anchor: "const [newLead] = await db('leads').insert({",
    context: 'attributeInboundContact — inbound call/SMS attribution (phone-keyed, concurrent-call sid guard)',
    // The inline phone-keyed lookup that decides update-vs-mint inside
    // attributeInboundContact (naming the enclosing function itself would be
    // a header, not a resolution).
    identityResolver: 'existingLead',
  },
  {
    file: 'services/lead-estimate-link.js',
    anchor: "const [minted] = await database('leads').insert({",
    context: 'attributeSelfBooking — self-serve booking with no prior lead',
    identityResolver: 'findUnconvertedLeadsByContact',
  },
  {
    file: 'services/lead-from-extraction.js',
    anchor: "const [newLead] = await q('leads').insert(insert).returning('*');",
    context: 'createLeadFromExtraction — voice-agent/relay extraction → lead (phone lookup + nameConflicts)',
    identityResolver: 'nameConflicts',
    note: 'phone-keyed reuse with exact-first-name conflict check (not nickname-aware)',
  },
  {
    file: 'services/referral-engine.js',
    anchor: "const [lead] = await db('leads').insert({",
    // Reached from BOTH referral surfaces: the customer portal
    // (routes/referrals-v2.js router.post('/') → POST /api/referrals) and the
    // admin portal (routes/admin-referrals-v2.js router.post('/submit') →
    // POST /api/admin/referrals/submit, source: 'admin') — server/index.js
    // mounts at /api/referrals and /api/admin/referrals.
    context: 'submitReferral — referral → lead for the referred contact (POST /api/referrals + POST /api/admin/referrals/submit)',
    identityResolver: 'none',
    reason: PENDING_RULING_REASON,
  },
];

// Dynamic-table inserts — `db(tableVar).insert(` where the table name is a
// parameter or object member the scanner cannot resolve to a string literal.
// The contract test requires every such site to be listed here with a reason
// its table set can NEVER contain 'leads'. Writing leads through a
// dynamic-table helper is prohibited — use a literal insert + a LEAD_WRITERS
// entry instead.
// Every entry MUST also declare a `callerContract` the contract test can
// machine-check — the reason string alone is prose. Supported kinds
// (tests/lead-writer-registry.test.js):
//   config-literals  — the expr reads in-file config literals; every listed
//                      prop's literal values are validated non-leads.
//   positional-call  — in-file helper; every call passes a LITERAL non-leads
//                      table at argIndex.
//   object-call      — exported helper taking { [prop]: table }; every call
//                      site under server/ must bind prop to a non-leads
//                      literal (or the declared allowIndirect expression).
const DYNAMIC_TABLE_INSERTS = [
  {
    file: 'routes/admin-photo-assessments.js',
    anchor: 'const [row] = await db(config.table).insert({',
    expr: 'config.table',
    reason: "FUNNEL_CONFIGS tables only — 'lawn_diagnostics' / 'pest_identifications' (routes/admin-photo-assessments.js), never leads",
    // Scoped to the named config OBJECT (balanced-brace extraction), where
    // spreads, shorthand, and noncanonical keys are rejected and every
    // listed prop must be a literal.
    callerContract: { kind: 'config-literals', object: 'TYPES', props: ['table', 'photoTable'], minValues: 4 },
  },
  {
    file: 'services/property-lookup/manatee-permit-sync.js',
    anchor: 'await trx(table).insert(chunk).onConflict(conflictCol).merge(mergeCols);',
    expr: 'table',
    reason: 'permit-sync upsert over the county permit dataset tables, never leads',
    callerContract: { kind: 'positional-call', helper: 'upsertChunked', argIndex: 1, minCallers: 3 },
  },
  {
    file: 'utils/funnel-photos.js',
    anchor: 'await db(table).insert({',
    expr: 'table',
    reason: 'caller-supplied funnel PHOTO table (lawn/pest assessment photo tables), never leads',
    // allowIndirect is accepted ONLY from indirectFile — the one file whose
    // config object the config-literals contract validates.
    callerContract: {
      kind: 'object-call',
      helper: 'storeFunnelPhotos',
      prop: 'table',
      allowIndirect: 'config.photoTable',
      indirectFile: 'routes/admin-photo-assessments.js',
      minCallers: 3,
    },
  },
];

module.exports = { LEAD_WRITERS, PENDING_RULING_REASON, DYNAMIC_TABLE_INSERTS };
