/**
 * /calculate without a lead token files a repeat of the same inquiry as a
 * 'duplicate' of the visitor's open quote_wizard lead instead of a second
 * 'new' lead (2026-08-31: two identical calculator quotes two minutes apart
 * became two open leads). The match is email AND phone AND quoted address —
 * a typed email alone is not ownership evidence on a public route, and the
 * helper only ever labels the NEW row; it never selects a row to mutate.
 */
const { _internals } = require('../routes/public-quote');
const { OPEN_LEAD_STATUSES } = require('../services/lead-statuses');
const { OPEN_ESTIMATE_STATUSES } = require('../services/estimate-automation-duplicates');

function chainMock(firstResult) {
  const calls = { where: [], whereRaw: [], whereIn: [], whereNull: [], whereNot: [], orderBy: [] };
  const api = {
    where: jest.fn((...a) => { calls.where.push(a); return api; }),
    whereNot: jest.fn((...a) => { calls.whereNot.push(a); return api; }),
    modify: jest.fn((fn) => { fn(api); return api; }),
    whereNull: jest.fn((...a) => { calls.whereNull.push(a); return api; }),
    whereRaw: jest.fn((...a) => { calls.whereRaw.push(a); return api; }),
    whereIn: jest.fn((...a) => { calls.whereIn.push(a); return api; }),
    orderBy: jest.fn((...a) => { calls.orderBy.push(a); return api; }),
    first: jest.fn(async () => firstResult),
  };
  const dbh = jest.fn(() => api);
  return { dbh, api, calls };
}

const SAME = { email: '  Visitor.One@Example.com ', phone: '(941) 555-0142', address: '123  Sample St, Parrish, FL 34219', serviceKey: 'pest_general_quarterly' };

describe('findPriorOpenWizardLeadId', () => {
  test('matches the newest open quote_wizard lead on service + email + phone + address, normalized', async () => {
    const { dbh, calls } = chainMock({ id: 'lead-prior' });
    const now = Date.UTC(2026, 7, 31, 19, 0, 0);
    await expect(_internals.findPriorOpenWizardLeadId(dbh, SAME, now)).resolves.toBe('lead-prior');
    expect(dbh).toHaveBeenCalledWith('leads');
    expect(calls.whereNot).toEqual([]); // no own row to exclude on the tokenless path
    expect(calls.where[0]).toEqual([{ lead_type: 'quote_wizard', service_key: 'pest_general_quarterly' }]);
    expect(calls.whereNull[0]).toEqual(['deleted_at']);
    expect(calls.whereRaw[0]).toEqual(['LOWER(email) = ?', ['visitor.one@example.com']]);
    expect(calls.whereRaw[1][1]).toEqual(['%9415550142']);
    expect(calls.whereRaw[2][1]).toEqual(['123 sample st, parrish, fl 34219']);
    expect(calls.whereIn[0]).toEqual(['status', OPEN_LEAD_STATUSES]);
    // An original whose FK-linked estimate already closed is not a live
    // courtship — the rerun files as a fresh lead (codex r4 P1).
    expect(calls.whereRaw[4][0]).toMatch(/estimate_id IS NULL OR EXISTS \(SELECT 1 FROM estimates e WHERE e\.id = leads\.estimate_id AND e\.archived_at IS NULL AND e\.status IN \(\?, \?, \?, \?\)\)/);
    expect(calls.whereRaw[4][1]).toEqual(OPEN_ESTIMATE_STATUSES);
    // ...and a lead whose MIRRORED wizard draft (estimate_data.lead_id, no
    // FK until send/view) was declined, expired or archived is not a live
    // courtship either (codex r24 P1) — judged on the LATEST mirror, so a
    // newer open draft after a closed one keeps the lead a live target
    // (codex r26 P1).
    expect(calls.whereRaw[5][0]).toMatch(/NOT EXISTS \(SELECT 1 FROM estimates e WHERE e\.id = \(SELECT n\.id FROM estimates n WHERE n\.estimate_data->>'lead_id' = leads\.id::text ORDER BY n\.created_at DESC, n\.id DESC LIMIT 1\) AND \(e\.archived_at IS NOT NULL OR e\.status NOT IN \(\?, \?, \?, \?\)\)\)/);
    expect(calls.whereRaw[5][1]).toEqual(OPEN_ESTIMATE_STATUSES);
    const [col, op, cutoff] = calls.where[1];
    expect([col, op]).toEqual(['created_at', '>']);
    expect(cutoff.getTime()).toBe(now - _internals.WIZARD_LEAD_REUSE_DAYS * 86400000);
    expect(calls.orderBy[0]).toEqual(['created_at', 'desc']);
  });

  test('a prior run that added properties is a wider inquiry — never a duplicate target (codex r20 P1)', async () => {
    const { dbh, calls } = chainMock(null);
    await _internals.findPriorOpenWizardLeadId(dbh, SAME);
    expect(calls.whereRaw.some((c) => c[0] === "COALESCE(jsonb_array_length(COALESCE(extracted_data, '{}'::jsonb)->'additional_properties'), 0) = 0")).toBe(true);
  });

  test('the token path excludes its OWN row from the candidates (a row is never its own prior)', async () => {
    const { dbh, calls } = chainMock({ id: 'lead-prior' });
    await expect(_internals.findPriorOpenWizardLeadId(dbh, { ...SAME, excludeLeadId: 'lead-self' })).resolves.toBe('lead-prior');
    expect(calls.whereNot).toEqual([['id', 'lead-self']]);
  });

  test('the token path only looks BACK: candidates must be created before the current row (no mutual-duplicate cycle between concurrent lookup-minted rows)', async () => {
    const { dbh, calls } = chainMock({ id: 'lead-prior' });
    const createdAt = new Date('2026-09-03T12:00:00Z');
    await expect(_internals.findPriorOpenWizardLeadId(dbh, { ...SAME, excludeLeadId: 'lead-self', beforeCreatedAt: createdAt })).resolves.toBe('lead-prior');
    expect(calls.where).toContainEqual(['created_at', '<', createdAt]);
  });

  test('onlyLeadId re-validates one chosen target through the exact same predicate', async () => {
    const { dbh, calls } = chainMock(null);
    await expect(_internals.findPriorOpenWizardLeadId(dbh, { ...SAME, onlyLeadId: 'lead-target' })).resolves.toBeNull();
    expect(calls.where).toContainEqual(['id', 'lead-target']);
    expect(calls.whereIn).toEqual([['status', OPEN_LEAD_STATUSES]]);
    // The live-courtship (open estimate) predicate is part of the re-check.
    expect(calls.whereRaw.some(([sql]) => /estimate_id IS NULL OR EXISTS/.test(sql))).toBe(true);
  });

  test('without a current row (the tokenless insert path) no created_at ceiling is applied', async () => {
    const { dbh, calls } = chainMock(null);
    await _internals.findPriorOpenWizardLeadId(dbh, SAME);
    expect(calls.where.filter((a) => a[0] === 'created_at' && a[1] === '<')).toEqual([]);
  });

  test('the documented direct `services` shape (no catalog key) is identified by its normalized service mix label (codex r16 P2)', async () => {
    const { dbh, calls } = chainMock({ id: 'lead-prior-direct' });
    await expect(_internals.findPriorOpenWizardLeadId(dbh, { ...SAME, serviceKey: null, serviceInterest: ' Recurring Pest Control + Recurring Lawn Care ' })).resolves.toBe('lead-prior-direct');
    expect(calls.where[0]).toEqual([{ lead_type: 'quote_wizard', service_key: null, service_interest: 'Recurring Pest Control + Recurring Lawn Care' }]);
    // A catalog key wins over the label when both are present.
    const keyed = chainMock({ id: 'lead-prior-keyed' });
    await _internals.findPriorOpenWizardLeadId(keyed.dbh, { ...SAME, serviceInterest: 'Recurring Pest Control' });
    expect(keyed.calls.where[0]).toEqual([{ lead_type: 'quote_wizard', service_key: 'pest_general_quarterly' }]);
  });

  test('no matching open lead → null (the row inserts as a normal new lead)', async () => {
    const { dbh } = chainMock(undefined);
    await expect(_internals.findPriorOpenWizardLeadId(dbh, SAME)).resolves.toBeNull();
  });

  test.each([
    ['missing email', { ...SAME, email: '' }],
    ['short phone', { ...SAME, phone: '555-0142' }],
    ['missing address', { ...SAME, address: '  ' }],
    ['no catalog service key AND no service label', { ...SAME, serviceKey: null, serviceInterest: '  ' }],
  ])('%s → null without touching the database (all four keys are required)', async (_label, keys) => {
    const { dbh } = chainMock({ id: 'never' });
    await expect(_internals.findPriorOpenWizardLeadId(dbh, keys)).resolves.toBeNull();
    expect(dbh).not.toHaveBeenCalled();
  });
});

describe('duplicate ancestry follows the token the browser holds', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/public-quote.js'), 'utf8');

  test('duplicateOfFromExtracted reads the marker off parsed jsonb and legacy strings', () => {
    expect(_internals.duplicateOfFromExtracted({ duplicate_of_lead_id: 'lead-1' })).toBe('lead-1');
    expect(_internals.duplicateOfFromExtracted(JSON.stringify({ duplicate_of_lead_id: 'lead-2' }))).toBe('lead-2');
    expect(_internals.duplicateOfFromExtracted({})).toBeNull();
    expect(_internals.duplicateOfFromExtracted('not json')).toBeNull();
    expect(_internals.duplicateOfFromExtracted(null)).toBeNull();
  });

  test('the token path re-derives duplicate state against what THIS stage typed, and attribution is skipped for duplicates', () => {
    expect(src).toMatch(/const RETURNING = \['id', 'lead_source_id', 'lead_type', 'status', 'extracted_data', 'created_at'\];/);
    // A repeat inserts no attribution row of its own — unless the original
    // never got one, in which case the single row is backfilled onto the
    // original's id (codex r10 P2).
    // The backfill is the ORIGINAL touch rebuilt from the root row (its
    // source's channel, click ids, service, date), resolved through the
    // chain root; a root that already has a row, or whose stored source has
    // no channel, gets nothing (codex r10 P2, pre-push r10, r11 P2).
    // The rebuild lives in the funnel-row module (stampLeadFunnelRow, one
    // implementation for the root repair and the winner stamp).
    expect(src).toMatch(/const root = await followDuplicateLink\(db, await db\('leads'\)\.where\(\{ id: duplicateOfLeadId \}\)\.first\(\)\);/);
    expect(src).toMatch(/stampedId = root \? await stampLeadFunnelRow\(db, root, \{ customerId, serviceInterest \}\) : null;/);
    expect(src).toMatch(/\} else if \(touch\) \{\n\s+const \[stamped\] = await db\('ad_service_attribution'\)\.insert\(\{\n\s+customer_id: touch\.customerId,\n\s+lead_id: touch\.leadId,/);
    // Every funnel insert is re-checked against its keeper after the write:
    // a keeper that filed as a duplicate meanwhile loses the row this request
    // added (codex r14 P1) — on both the current-touch and root-repair paths.
    expect(src).toMatch(/\}\)\.onConflict\('lead_id'\)\.ignore\(\)\.returning\('id'\);\n\s+stampedId = stamped \? stamped\.id : null;/);
    // A retry after a partial run (insert landed, reconcile did not) adopts
    // the existing row at the inserted stage and reconciles it (codex r26 P1).
    expect(src).toMatch(/if \(!stampedId && keeperId && \(duplicateOfLeadId \|\| touch\)\) \{\n[\s\S]*?const existing = await db\('ad_service_attribution'\)\.where\(\{ lead_id: keeperId, funnel_stage: stampedStage \}\)\.first\('id'\);\n\s+stampedId = existing \? existing\.id : null;\n\s+\}\n\s+if \(stampedId\) \{/);
    // The drop is one statement conditioned on the keeper STILL being
    // duplicate and the row STILL at its repair stage, so a promotion that
    // advanced the row between the read and the delete keeps it (codex r19 P1).
    expect(src).toMatch(/if \(stampedId\) \{[\s\S]*?const keeper = await db\('leads'\)\.where\(\{ id: keeperId \}\)\.first\('status'\);\n\s+if \(keeper\?\.status === 'duplicate'\) \{\n\s+await db\('ad_service_attribution'\)\n\s+\.where\(\{ id: stampedId, funnel_stage: stampedStage \}\)\n\s+\.whereExists\(db\('leads'\)\.where\(\{ id: keeperId, status: 'duplicate' \}\)\)\n\s+\.del\(\);/);
    expect(src).toMatch(/stampedStage = root \? LEAD_STATUS_TO_FUNNEL_STAGE\[root\.status\] \|\| 'lead' : 'lead';/);
    expect(src).not.toMatch(/where\(\{ id: stampedId \}\)\.del\(\)/);
    // ...and a keeper staff moved on while the repair was in flight has the
    // fresh row brought to its current stage (won → booked, lost → lost), so
    // the status bridge that found nothing to advance is caught up (codex r17 P1).
    expect(src).toMatch(/\} else if \(keeper && LEAD_STATUS_TO_FUNNEL_STAGE\[keeper\.status\]\) \{\n\s+await bridgeLeadFunnelStage\(keeperId, keeper\.status, db\);/);
    // A submission that adds properties is a wider inquiry, never a repeat
    // (codex r10 P1) — on both paths.
    expect(src).toMatch(/const desired = widerInquiry \? null : await findPriorOpenWizardLeadId\(db, \{ email: contactEmail/);
    // After the label lands (either path) the target is re-checked: a
    // target the office closed in the window makes this a fresh inquiry,
    // reopened on THIS row only (codex r12 P1).
    expect(src).toMatch(/const targetOpen = await findPriorOpenWizardLeadId\(db, \{ email: contactEmail, phone: contactPhone, address: quoteFullAddress, serviceKey: leadServiceKey, serviceInterest, onlyLeadId: duplicateOfLeadId \}\);/);
    // ...scoped to the identity this request typed AND the marker it just
    // validated, so a concurrent request's valid label on the same token is
    // never erased by this one's failed validation (codex r14 P1).
    expect(src).toMatch(/const reopened = await db\('leads'\)\n\s+\.where\(\{ id: lead\.id, status: 'duplicate' \}\)\n\s+\.whereRaw\("extracted_data->>'duplicate_of_lead_id' = \?", \[duplicateOfLeadId\]\)\n\s+\.modify\(scopedToTypedIdentity\)\n\s+\.update\(\{ status: 'new'/);
    expect(src).toMatch(/if \(reopened\) duplicateOfLeadId = null;/);
    // ...but a target that closed only because its OWN relabel landed in
    // flight (B → A → O) still reaches an open root through the recorded
    // chain: this row keeps its marker, no second 'new' lead (codex r20 P1).
    expect(src).toMatch(/const root = target && target\.status === 'duplicate' && !target\.deleted_at \? await followDuplicateLink\(db, target\) : null;\n\s+if \(root && root\.id !== target\.id && root\.id !== lead\.id\) \{\n\s+ancestryOpen = await findPriorOpenWizardLeadId\(db, \{ email: contactEmail, phone: contactPhone, address: quoteFullAddress, serviceKey: leadServiceKey, serviceInterest, onlyLeadId: root\.id \}\);/);
    expect(src).toMatch(/if \(!targetOpen && !ancestryOpen\) \{/);
    expect(src).toMatch(/if \(!lead && !additionalProperties\.length\) \{\n\s+duplicateOfLeadId = dedupeOn \? await findPriorOpenWizardLeadId\(db, \{ email: contactEmail/);
    // The merge write (gate off, or a lost claim) carries the marker forward...
    expect(src).toMatch(/'duplicate_of_lead_id', COALESCE\(extracted_data, '\{\}'::jsonb\)->'duplicate_of_lead_id'/);
    // ...while the CLAIMED write derives the label against what THIS stage
    // typed and lands it WITH the typed fields in one statement (codex r4
    // P1; PR B on r37 P1): a fields-first write followed by a separate
    // relabel left the row under the OLD marker with the NEW address or
    // service, and a conversion resolver in that gap booked the old root.
    // The lookup-minted 'new' row is re-checked here too (codex r7 P1): the
    // documented lookup→calculate flow is where a repeat is first fully typed.
    const block = src.slice(src.indexOf("let prior = dedupeOn ? await ownRow().first(RETURNING) : null;"), src.indexOf('if (lead && !lead.lead_source_id && sourceMeta.leadSourceId)'));
    expect(block.length).toBeGreaterThan(200);
    // Ownership stays INSIDE every write and read on the token (the typed
    // email must match the row's), and the pre-read is the run's OWN row —
    // never the original.
    expect(src).toMatch(/const ownRow = \(\) => db\('leads'\)\n\s+\.where\(\{ id: leadId \}\)\n\s+\.whereNull\('deleted_at'\)\n\s+\.whereRaw\('LOWER\(email\) = \?', \[String\(contactEmail\)\.toLowerCase\(\)\.trim\(\)\]\);/);
    expect(block).not.toMatch(/forUpdate/);
    // The stored additional-property list counts as well as the request's
    // (codex r12 P1).
    expect(block).toMatch(/const priorExtraCount = parseExtracted\(prior\.extracted_data\)\?\.additional_properties\?\.length \|\| 0;\n\s+const widerInquiry = additionalProperties\.length > 0 \|\| priorExtraCount > 0;/);
    expect(block).toMatch(/const desired = widerInquiry \? null : await findPriorOpenWizardLeadId\(db, \{ email: contactEmail, phone: contactPhone, address: quoteFullAddress, serviceKey: leadServiceKey, serviceInterest, excludeLeadId: prior\.id, beforeCreatedAt: prior\.created_at \}\);/);
    // The claim: the status just read (codex r9 P1 — a staff transition in
    // between wins and this public retry claims 0 rows) AND the marker just
    // read, NULL-safe; the typed fields and the derived label land together.
    // ...and the stored extra-property list as read: a concurrent
    // submission that added properties made the row a wider inquiry, and
    // this claim must lose rather than label it a duplicate (pre-push P1).
    expect(block).toMatch(/await land\(\(q\) => q\n\s+\.where\(\{ status: prior\.status \}\)\n\s+\.whereRaw\("extracted_data->>'duplicate_of_lead_id' IS NOT DISTINCT FROM \?", \[stored\]\)\n\s+\.whereRaw\("COALESCE\(jsonb_array_length\(COALESCE\(extracted_data, '\{\}'::jsonb\)->'additional_properties'\), 0\) = \?", \[priorExtraCount\]\), desired\);/);
    // One write function lands the fields for every outcome (codex #3883 r1
    // P2): a label (marker, or null for 'new') lands status + marker in the
    // same statement over the replace snapshot; no label = the merge write.
    const landSrc = src.slice(src.indexOf('const land = async (claim, label) => {'), src.indexOf('let prior = dedupeOn'));
    expect(landSrc).toMatch(/status: label \? 'duplicate' : 'new',/);
    expect(landSrc).toMatch(/'won_estimate_id', COALESCE\(extracted_data, '\{\}'::jsonb\)->'won_estimate_id'\)\) \|\| \?::jsonb \|\| \?::jsonb",\n\s+\[extractedData, JSON\.stringify\(label \? \{ duplicate_of_lead_id: label \} : \{\}\)\],/);
    expect(landSrc).toMatch(/const rows = await claim\(ownRow\(\)\)\.update\(\{ \.\.\.updateFields, \.\.\.relabel \}\)\.returning\(RETURNING\);\n\s+lead = rows\[0\] \|\| null;/);
    expect(landSrc).toMatch(/if \(lead && label !== undefined\) duplicateOfLeadId = label;\n\s+else if \(relabelable\(lead\)\) duplicateOfLeadId = lead\.status === 'duplicate' \? duplicateOfFromExtracted\(lead\.extracted_data\) : null;/);
    // The claimed snapshot never carries the OLD marker forward.
    expect(landSrc).not.toMatch(/'duplicate_of_lead_id', COALESCE/);
    // 0 rows: re-read the row AS IT IS NOW and claim once more (a concurrent
    // request on this token moved the label), never the stale read (codex
    // r17 P1); two lost claims fall through to the reopen, then the merge.
    expect(block).toMatch(/for \(let attempt = 0; !lead && relabelable\(prior\) && attempt < 2; attempt\+\+\) \{/);
    expect(block).toMatch(/if \(!lead\) prior = await ownRow\(\)\.first\(RETURNING\);/);
    // Claims exhausted with the row still in play: this request's fields
    // never land under another request's marker — the row reopens as 'new'
    // with the marker cleared, claimed on the status still being in play
    // (pre-push P1 on 5e2777f). Only a row that left play (gate off, or a
    // staff transition) takes the merge write, whose marker nothing follows.
    expect(block).toMatch(/if \(!lead && relabelable\(prior\)\) await land\(\(q\) => q\.whereIn\('status', \['new', 'duplicate'\]\), null\);/);
    expect(block).toMatch(/if \(!lead\) await land\(\(q\) => q\);/);
    expect(block).not.toMatch(/duplicateOfLeadId = stored;/);
    // The identity predicate is defined once and shared with the reopen.
    expect(src).toMatch(/const scopedToTypedIdentity = \(qb\) => qb\n\s+\.where\(\{ email: contactEmail, phone: contactPhone, address: quoteFullAddress, service_key: leadServiceKey, service_interest: serviceInterest \}\)\n\s+\.whereRaw\("COALESCE\(jsonb_array_length\(COALESCE\(extracted_data, '\{\}'::jsonb\)->'additional_properties'\), 0\) = \?", \[observedExtraCount\]\);/);
    // A row that just filed as a repeat drops its own lead-stage funnel row
    // (its earlier stamp, or a concurrent repeat's root repair that picked
    // it while the relabel was in flight) — the root carries the prospect
    // (codex r14 P1).
    // ...in ONE statement conditioned on the row still carrying this
    // request's label, marker and typed identity (codex r24 P2), and
    // whenever the row carries the desired label — not only when THIS
    // request wrote it — so a retry after a committed relabel + failed
    // delete finishes the cleanup (codex r26 P2).
    expect(block).toMatch(/if \(dedupeOn && duplicateOfLeadId\) \{[\s\S]*?await db\('ad_service_attribution'\)\n\s+\.where\(\{ lead_id: lead\.id, funnel_stage: 'lead' \}\)\n\s+\.whereExists\(db\('leads'\)\.select\(db\.raw\('1'\)\)\.where\(\{ id: lead\.id, status: 'duplicate' \}\)\.whereRaw\("extracted_data->>'duplicate_of_lead_id' = \?", \[duplicateOfLeadId\]\)\.modify\(scopedToTypedIdentity\)\)\n\s+\.del\(\);/);
  });

  test('DARK behind GATE_WIZARD_LEAD_DEDUPE, read at call time: off, no run is looked up as a repeat, the token path keeps a stored marker as is (no relabel, no re-validation) and the tokenless path files new', () => {
    expect(src).toMatch(/const dedupeOn = require\('\.\.\/config\/feature-gates'\)\.gateEnvValue\('GATE_WIZARD_LEAD_DEDUPE'\);/);
    // Off: no pre-read, no claim — the merge write keeps the stored marker.
    expect(src).toMatch(/let prior = dedupeOn \? await ownRow\(\)\.first\(RETURNING\) : null;/);
    expect(src).toMatch(/duplicateOfLeadId = dedupeOn \? await findPriorOpenWizardLeadId\(db, \{ email: contactEmail, phone: contactPhone, address: quoteFullAddress, serviceKey: leadServiceKey, serviceInterest \}\) : null;/);
    expect(src).toMatch(/if \(dedupeOn && duplicateOfLeadId\) \{\n\s+const targetOpen = await findPriorOpenWizardLeadId\(/);
    expect(src.match(/gateEnvValue\('GATE_WIZARD_LEAD_DEDUPE'\)/g).length).toBe(1); // one read per request, every decision hangs off it
  });

  test("a repeat run's draft estimate stays on THIS run's row, and /upsell touches only the authenticated lead's draft", () => {
    // A pointer at the open original would let a typed-contact repeat reach
    // a draft it never proved ownership of (pre-push P0, r4). The pipeline
    // does not read the key, so the draft is its own Draft opportunity.
    expect(src).toMatch(/lead_id: lead\.id,\n\s+\/\/ setupFeeQuote is injected/);
    expect(src).toMatch(/estimate_data->>'lead_id' = \?", \[leadId\]/);
    expect(src).not.toMatch(/estimate_data->>'lead_id' IN \(/);
  });

  test('nothing on the public surface follows the marker to the original (label only — the merge is a trusted-path job)', () => {
    // The marker is read only to label THIS row and skip its attribution;
    // no query selects the original for update from /calculate or /upsell.
    expect(src).not.toMatch(/where\(\{ id: originalId \}\)/);
    expect(src).not.toMatch(/const draftLeadIds/); // the /upsell draft sync never widens past the authenticated lead
    expect(src.match(/duplicateOfFromExtracted\(/g).length).toBe(3); // the definition + the token-path read + the lost-relabel re-read
  });
});
