/**
 * ops/agents/inventory-agent-replay.js — assertReadOnly's error
 * classification (2026-09-27 pre-push review P1: the script's own
 * dedicated read-only pool doesn't cover the SHARED server/models/db pool
 * dispatchWithFallback's LLM ledger/trace/dispatch-metrics recording can
 * write through). This is a pure unit test of the classification logic
 * against a mocked `db.raw` — it never opens a real connection, so it can't
 * prove PGOPTIONS itself works end-to-end; that's what the live self-check
 * (this same function, run against the real shared db module before the
 * script does anything else) is for.
 */
const {
  assertReadOnly, parseSince, parseLimit, lineKey, dedupe, recordedOwners, inQueueOrder, tableOnlyLines, emptyProposals, earlierProposalReach, recordProposal, catalogWithProposals, replayLine,
} = require('../../ops/agents/inventory-agent-replay');
const { classifyItem } = require('../services/purchase-receipts/receipt-processor');

function mockDb(behavior) {
  return { raw: jest.fn(behavior) };
}

describe('assertReadOnly', () => {
  test('a write rejected with a read-only-transaction error is exactly the expected, passing case', async () => {
    const db = mockDb(async () => {
      throw new Error('cannot execute UPDATE in a read-only transaction');
    });
    await expect(assertReadOnly(db)).resolves.toBeUndefined();
    expect(db.raw).toHaveBeenCalledTimes(1);
    expect(db.raw.mock.calls[0][0]).toMatch(/^UPDATE products_catalog/);
    // Zero rows by construction, never an id assumed not to exist.
    expect(db.raw.mock.calls[0][0]).toMatch(/WHERE false$/);
  });

  test('the write matches zero rows by construction, so it is a no-op even in the failure branch below', () => {
    // Documents the safety property directly: an unconditional false
    // predicate, never an id assumed not to exist (Codex round 1 on #5080 —
    // nothing in the schema forbids the nil uuid), checked here as a static
    // guard against someone loosening the WHERE clause later.
    expect(assertReadOnly.toString()).toContain("'UPDATE products_catalog SET name = name WHERE false'");
  });

  test('a write that succeeds outright (no error at all) fails the self-check loudly', async () => {
    const db = mockDb(async () => ({ rowCount: 0 }));
    await expect(assertReadOnly(db)).rejects.toThrow(/READ-ONLY SELF-CHECK FAILED/);
  });

  test('an error that is NOT the read-only rejection (e.g. a connection failure) also fails the self-check, distinctly', async () => {
    const db = mockDb(async () => {
      throw new Error('connection terminated unexpectedly');
    });
    await expect(assertReadOnly(db)).rejects.toThrow(/not with the expected read-only rejection/);
  });
});

// Codex round 2 on #5080: a bare --since date is Eastern midnight (the
// portal is Eastern-only), never UTC midnight; an unreadable one refuses.
describe('parseSince', () => {
  test('a bare date is Eastern midnight, in daylight and standard time alike', () => {
    expect(parseSince('2026-06-01').toISOString()).toBe('2026-06-01T04:00:00.000Z');
    expect(parseSince('2026-01-15').toISOString()).toBe('2026-01-15T05:00:00.000Z');
  });

  test('a full timestamp keeps its own offset; no value means everything', () => {
    expect(parseSince('2026-06-01T12:00:00Z').toISOString()).toBe('2026-06-01T12:00:00.000Z');
    expect(parseSince(null).toISOString()).toBe('2000-01-01T00:00:00.000Z');
  });

  test('an unreadable value refuses to run', () => {
    expect(() => parseSince('June first')).toThrow(/is not a date/);
  });

  // Codex round 3: 2026-02-30 would roll forward to March 2 and silently
  // drop two days.
  test('an impossible calendar date refuses rather than rolling forward', () => {
    expect(() => parseSince('2026-02-30')).toThrow(/is not a date/);
    expect(() => parseSince('2026-13-01')).toThrow(/is not a date/);
    expect(parseSince('2028-02-29').toISOString()).toBe('2028-02-29T05:00:00.000Z');
  });

  // Codex round 4: the calendar check covers full timestamps too.
  test('an impossible day in a full timestamp refuses as well', () => {
    expect(() => parseSince('2026-02-30T05:00:00Z')).toThrow(/is not a date/);
    expect(parseSince('2028-02-29T05:00:00Z').toISOString()).toBe('2028-02-29T05:00:00.000Z');
  });
});

// Codex round 5: the live agent changes the catalog as it carries out a
// proposal, so a later line — the same title or a differently worded one —
// may then resolve by the receipt rules with no model call. Round 7: that
// change can still be rolled back at apply time, so the replay only uses
// this view to MARK a later line as depending on an earlier proposal.
describe('catalogWithProposals', () => {
  const base = () => ({
    products: [{ id: 'p-taurus', name: 'Taurus SC', container_size: null, active: true }],
    aliasRows: [],
  });
  const logged = (decision) => ({ decision: { status: 'logged', ...decision } });
  const classify = (title, proposals) => classifyItem({ title, quantity: 1 }, null, catalogWithProposals(base(), proposals));

  test('a proposed new product resolves a differently worded later title by the rules', async () => {
    const proposals = emptyProposals();
    expect((await classify('Syngenta Alpine WSG Insecticide 500 g', proposals)).status).toBe('unmatched');
    recordProposal(proposals, {
      outcome: logged({ kind: 'new_product', newProduct: { name: 'Alpine WSG', category: 'insecticide', containerSize: '500 g' } }),
      found: { status: 'unmatched', productId: null },
      title: 'Alpine WSG Insecticide 500 g',
    });
    const later = await classify('Syngenta Alpine WSG Insecticide 500 g', proposals);
    expect(later).toMatchObject({ status: 'logged', receivedQty: 500, receivedUnit: 'g' });
  });

  test('a proposed container size sizes the product for every later title', async () => {
    const proposals = emptyProposals();
    expect((await classify('Taurus SC Termiticide 78 oz', proposals)).status).toBe('needs_size');
    recordProposal(proposals, {
      outcome: logged({ kind: 'existing', product: { id: 'p-taurus', name: 'Taurus SC' }, setContainerSize: '78 fl oz' }),
      found: { status: 'needs_size', productId: 'p-taurus' },
      title: 'Taurus SC Termiticide 78 oz',
    });
    expect((await classify('Control Solutions Taurus SC 78 oz', proposals)).status).toBe('logged');
    // A matched title gets no alias — only an unmatched one does, as live.
    expect(proposals.aliases).toEqual([]);
  });

  test('an unmatched title chosen as an existing product becomes its alias', async () => {
    const proposals = emptyProposals();
    recordProposal(proposals, {
      outcome: logged({ kind: 'existing', product: { id: 'p-taurus', name: 'Taurus SC' }, setContainerSize: '78 fl oz' }),
      found: { status: 'unmatched', productId: null },
      title: 'Fipronil Termiticide 78 oz',
    });
    expect(await classify('Fipronil Termiticide 78 oz', proposals)).toMatchObject({ status: 'logged', productId: 'p-taurus' });
  });

  test('a hold, an unsure answer or a failed call changes nothing', async () => {
    const proposals = emptyProposals();
    recordProposal(proposals, { outcome: { decision: { kind: 'unsure', status: 'agent_unsure' } }, found: { productId: null }, title: 'x' });
    recordProposal(proposals, { outcome: { llmFailed: true }, found: { productId: null }, title: 'x' });
    expect(proposals).toEqual(emptyProposals());
  });
});

// Codex round 6: the live agent works its queue in the order the sweep
// recorded the lines (a backfill sweep records all Amazon lines before any
// SiteOne line), not the order the emails arrived.
describe('inQueueOrder', () => {
  const line = (vendor, emailId, receivedAt, lineNo = 1) => ({
    vendor, orderNumber: 'o', shipmentKey: emailId, lineNo, email: { id: emailId, received_at: receivedAt },
  });

  test('a recorded line replays at its recorded time; an unrecorded one at its email time', () => {
    const siteOne = line('siteone', 's1', '2026-09-01T10:00:00Z');
    const amazon = line('amazon', 'a1', '2026-09-02T10:00:00Z');
    const neverRecorded = line('amazon', 'a2', '2026-09-03T09:00:00Z');
    const recorded = new Map([
      [lineKey(amazon), { vendor: 'amazon', shipmentKey: 'a1', at: Date.parse('2026-09-03T08:00:00Z') }],
      [lineKey(siteOne), { vendor: 'siteone', shipmentKey: 's1', at: Date.parse('2026-09-03T08:00:05Z') }],
    ]);
    expect(inQueueOrder([siteOne, neverRecorded, amazon], recorded)).toEqual([amazon, siteOne, neverRecorded]);
  });

  // Codex round 7: a line the sweep skipped (handed off) keeps its scan
  // position after the recorded hold from the same sweep, never jumping
  // ahead of it on its earlier email time.
  test('an unrecorded line sorts in the sweep that scanned it, by email arrival', () => {
    const hold = line('amazon', 'a1', '2026-09-01T10:00:00Z');
    const skipped = { ...line('amazon', 'a2', '2026-09-01T10:05:00Z'), shipmentKey: 'a1', lineNo: 2 };
    const recorded = new Map([[lineKey(hold), { vendor: 'amazon', shipmentKey: 'a1', at: Date.parse('2026-09-01T12:00:00Z') }]]);
    expect(inQueueOrder([skipped, hold], recorded)).toEqual([hold, skipped]);
  });

  // 2026-09-27 pre-push P1: an unrelated row earlier in the same sweep never
  // pulls a skipped line ahead of the hold that skipped it.
  test('a skipped line stays after its own shipment hold, past an unrelated earlier row', () => {
    const unrelated = line('amazon', 'u1', '2026-09-01T09:00:00Z');
    const hold = line('amazon', 'h1', '2026-09-01T10:00:00Z');
    const skipped = { ...line('amazon', 'h2', '2026-09-01T10:05:00Z'), shipmentKey: 'h1', lineNo: 2 };
    const recorded = new Map([
      [lineKey(unrelated), { vendor: 'amazon', shipmentKey: 'u1', at: Date.parse('2026-09-01T12:00:00Z') }],
      [lineKey(hold), { vendor: 'amazon', shipmentKey: 'h1', at: Date.parse('2026-09-01T12:00:01Z') }],
    ]);
    expect(inQueueOrder([skipped, hold, unrelated], recorded)).toEqual([unrelated, hold, skipped]);
  });

  test('ties keep email, then line order', () => {
    const second = line('amazon', 'a1', '2026-09-01T10:00:00Z', 2);
    const first = line('amazon', 'a1', '2026-09-01T10:00:00Z', 1);
    expect(inQueueOrder([first, second], new Map())).toEqual([first, second]);
  });
});

// 2026-09-27 pre-push P1: a recorded undelivered hold and a late Delivered
// email for the same line share a key; the recorded hold always wins,
// whichever email id sorts first.
describe('dedupe', () => {
  const key = { vendor: 'amazon', orderNumber: 'o', shipmentKey: 'S1', lineNo: 1 };
  test.each([['a-hold', 'z-delivered'], ['z-hold', 'a-delivered']])('hold email %s vs Delivered email %s', (holdId, deliveredId) => {
    const hold = { ...key, email: { id: holdId, received_at: '2026-09-01T00:00:00Z' }, recordedStatus: 'no_delivery_email' };
    const delivered = { ...key, email: { id: deliveredId, received_at: '2026-09-01T00:00:00Z' } };
    const ordered = inQueueOrder([delivered, hold], new Map([[lineKey(key), { vendor: 'amazon', shipmentKey: 'S1', at: Date.parse('2026-09-01T00:00:00Z') }]]));
    expect(dedupe(ordered, new Map([[lineKey(key), holdId]]))).toEqual([hold]);
  });

  // 2026-09-27 pre-push P1: two emails rebuild one recorded line; the copy
  // the live lane recorded survives even when it arrived later.
  test('the recorded owner email survives an earlier-arriving copy of the same line', () => {
    const early = { ...key, email: { id: 'copy', received_at: '2026-09-01T00:00:00Z' }, item: { title: 'early' } };
    const owner = { ...key, email: { id: 'owner', received_at: '2026-09-01T02:00:00Z' }, item: { title: 'owner' } };
    const owners = recordedOwners([{ vendor: 'amazon', order_number: 'o', shipment_key: 'S1', line_no: 1, email_id: 'owner' }]);
    expect(dedupe([early, owner], owners)).toEqual([owner]);
  });

  test('a line never recorded keeps its first copy', () => {
    const first = { ...key, email: { id: 'a' } };
    expect(dedupe([first, { ...key, email: { id: 'b' } }])).toEqual([first]);
  });
});

// Codex round 9: recorded rows the email collectors can't rebuild.
describe('tableOnlyLines', () => {
  const since = new Date('2026-09-01T00:00:00Z');
  const row = (extra) => ({
    vendor: 'amazon', order_number: 'o', shipment_key: 'S', line_no: 1, status: 'logged', email_id: 'e', created_at: '2026-09-02T00:00:00Z',
    raw_title: 't', quantity: '1', ...extra,
  });
  const keyOf = (r) => lineKey({ vendor: r.vendor, orderNumber: r.order_number, shipmentKey: r.shipment_key, lineNo: r.line_no });

  const from = (entries) => new Map(entries.map(([r, ids]) => [keyOf(r), new Set(ids)]));

  test('a row rebuilt from its own email is left to it; one rebuilt only by another email comes along', () => {
    const rebuilt = row({});
    const hold = row({ line_no: 2, status: 'no_delivery_email', email_id: 'shipped' });
    const out = tableOnlyLines([rebuilt, hold], from([[rebuilt, ['e']], [hold, ['delivered']]]), since);
    expect(out.map((l) => [l.lineNo, l.report])).toEqual([[2, 'no_delivery_email']]);
  });

  // 2026-09-27 pre-push P1: an old placeholder keeps its line and its
  // hand-off even when a later email rebuilds the same key.
  test('a pre-window placeholder owns its line against a later email for it', () => {
    const old = row({ status: 'no_items', created_at: '2026-08-01T00:00:00Z', email_id: 'old' });
    const [recorded] = tableOnlyLines([old], from([[old, ['later']]]), since);
    expect(recorded).toMatchObject({ recordedStatus: 'no_items', report: null });
    const later = { vendor: 'amazon', orderNumber: 'o', shipmentKey: 'S', lineNo: 1, email: { id: 'later', received_at: '2026-09-05T00:00:00Z' } };
    expect(dedupe([later, recorded], new Map([[keyOf(old), 'old']]))).toEqual([recorded]);
  });

  // 2026-09-27 pre-push P1: a surviving duplicate email rebuilding the same
  // line never displaces the recorded deleted-email row.
  test('a deleted-email row owns its line even when another email rebuilds it', () => {
    const orphan = row({ email_id: null, status: 'agent_pending' });
    const [recorded] = tableOnlyLines([orphan], from([[orphan, ['dup']]]), since);
    const duplicate = { vendor: 'amazon', orderNumber: 'o', shipmentKey: 'S', lineNo: 1, email: { id: 'dup', received_at: orphan.created_at } };
    expect(dedupe([duplicate, recorded], new Map([[keyOf(orphan), null]]))).toEqual([recorded]);
  });

  test('a deleted-email row in the window is reported; a pre-window row only feeds the rules', () => {
    const orphan = row({ email_id: null, status: 'agent_pending' });
    const old = row({ line_no: 2, status: 'no_items', created_at: '2026-08-01T00:00:00Z' });
    expect(tableOnlyLines([orphan, old], new Map(), since).map((l) => l.report)).toEqual(['email_deleted', null]);
  });
});

// Codex round 6: explicit 'false' — dotenv (loaded as server modules are
// required) only fills in variables that are absent.
test('the telemetry gates stay set to false once the server modules have loaded', () => {
  expect([process.env.GATE_LLM_CALL_LEDGER, process.env.GATE_LLM_CALL_TRACES, process.env.GATE_LLM_DISPATCH_METRICS])
    .toEqual(['false', 'false', 'false']);
});

// Codex round 10: an earlier proposal reaches a later line not only when
// the rules would then take it, but whenever it changes what the agent's
// decision reads — its match, or a product sharing a word with the title
// (the candidate list and the duplicate-name check).
describe('earlierProposalReach', () => {
  const saved = () => ({ products: [{ id: 'p-taurus', name: 'Taurus SC', container_size: null, active: true }], aliasRows: [] });
  const newAlpine = () => {
    const proposals = emptyProposals();
    recordProposal(proposals, {
      outcome: { decision: { status: 'logged', kind: 'new_product', newProduct: { name: 'Alpine WSG', category: 'insecticide', containerSize: '500 g' } } },
      found: { status: 'unmatched', productId: null },
      title: 'Alpine WSG Insecticide 500 g',
    });
    return proposals;
  };
  const reach = (title, proposals) => earlierProposalReach(saved(), { item: { title, quantity: 1 } }, { status: 'unmatched', productId: null }, proposals);

  test('rules when the change makes the line match and log', async () => {
    expect(await reach('Syngenta Alpine WSG 500 g', newAlpine())).toBe('rules');
  });

  test('context when a proposed product shares a word with a title it does not match', async () => {
    expect(await reach('Alpine Fly Bait 2 lb', newAlpine())).toBe('context');
  });

  test('nothing for an unrelated title, or with no proposals', async () => {
    expect(await reach('Chromebook charger', newAlpine())).toBeNull();
    expect(await reach('Alpine WSG 500 g', emptyProposals())).toBeNull();
  });
});

// Codex round 5: the hand-off rule applies to the lines the replay has
// recorded so far, in order — never to today's table, which already holds
// the replayed line itself (a placeholder would otherwise hand itself off).
describe('replayLine hand-offs', () => {
  const state = () => ({ tally: {}, recorded: new Map(), invoiceOwner: new Map(), proposals: emptyProposals() });
  const line = (emailId, extra = {}) => ({
    vendor: 'amazon', orderNumber: '111', shipmentKey: 'S1', lineNo: 1, email: { id: emailId }, item: { title: 'x', quantity: 1 }, ...extra,
  });

  test('a placeholder is reported as itself, then hands off the rest of its shipment', async () => {
    const s = state();
    expect((await replayLine(null, line('e1', { forcedStatus: 'no_items' }), s)).status).toBe('no_items');
    expect((await replayLine(null, line('e2', { forcedStatus: 'no_items' }), s)).status).toBe('handed_to_person');
    expect(s.tally).toEqual({ no_items: 1, handed_to_person: 1 });
  });

  // Codex round 8: the first SiteOne copy to record a line owns the
  // invoice; the live sweep drops the other copy whole, extra lines and all.
  test('a second SiteOne copy of an invoice the replay already recorded is dropped whole', async () => {
    const s = state();
    const siteOne = (emailId, lineNo) => line(emailId, { vendor: 'siteone', shipmentKey: 'INV1', lineNo, forcedStatus: 'unreadable' });
    expect((await replayLine(null, siteOne('store', 1), s)).status).toBe('unreadable');
    expect((await replayLine(null, siteOne('billing', 2), s)).status).toBe('other_invoice_copy');
    expect((await replayLine(null, siteOne('store', 2), s)).status).toBe('handed_to_person');
  });

  // Codex round 9: a hand-off recorded before --since still stops a later
  // email for that shipment — the live check reads the whole table.
  test('a pre-window hand-off stops a later email silently', async () => {
    const s = state();
    expect(await replayLine(null, line('e1', { recordedStatus: 'no_items', report: null }), s)).toBeNull();
    expect((await replayLine(null, line('e2', { forcedStatus: 'no_items' }), s)).status).toBe('handed_to_person');
  });

  test('a recorded line whose email was deleted is reported as held for a person', async () => {
    const s = state();
    const row = await replayLine(null, line(null, { recordedStatus: 'agent_pending', report: 'email_deleted' }), s);
    expect(row).toMatchObject({ status: 'email_deleted', text: expect.stringContaining('holds it for a person') });
  });

  test('an undelivered-shipment hold hands off a later email for that shipment only', async () => {
    const s = state();
    await replayLine(null, line(null, { recordedStatus: 'no_delivery_email' }), s);
    expect((await replayLine(null, line('e2', { forcedStatus: 'no_items' }), s)).status).toBe('handed_to_person');
    expect((await replayLine(null, line('e3', { shipmentKey: 'S2', forcedStatus: 'no_items' }), s)).status).toBe('no_items');
  });
});

// Codex round 3: a mistyped cap on paid calls refuses instead of silently
// becoming 50.
describe('parseLimit', () => {
  test('a whole number, zero included; 50 when absent', () => {
    expect(parseLimit('20')).toBe(20);
    expect(parseLimit('0')).toBe(0);
    expect(parseLimit(null)).toBe(50);
  });

  test('anything else refuses', () => {
    for (const raw of ['5O', '-1', '2.5', '', 'ten']) expect(() => parseLimit(raw)).toThrow(/not a whole number/);
  });
});

// Codex round 3: deduplicate by the live lane's own purchase-line identity,
// so the same title bought on two orders stays two lines.
describe('lineKey', () => {
  const base = { vendor: 'amazon', orderNumber: '111-1', shipmentKey: 'ship-1', lineNo: 1, item: { title: 'Taurus SC Termiticide 78 oz', quantity: 1 } };

  test('the same line from two emails is one key; another order or line is another', () => {
    expect(lineKey({ ...base })).toBe(lineKey({ ...base, email: { id: 'other' } }));
    expect(lineKey({ ...base, orderNumber: '222-2', shipmentKey: 'ship-2' })).not.toBe(lineKey(base));
    expect(lineKey({ ...base, lineNo: 2 })).not.toBe(lineKey(base));
  });

  test('a missing order number keys as unknown, as the live lane keys it', () => {
    expect(lineKey({ ...base, orderNumber: null })).toBe('amazon|unknown|ship-1|1');
  });
});
