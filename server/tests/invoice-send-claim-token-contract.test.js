/**
 * Round-18 class work (#4131): processScheduledSends' own preclaim restore
 * used to match the exact updated_at its status flip wrote — an
 * optimistic-concurrency token that ANY unrelated write to the invoice row
 * during the claim window silently invalidates (round 15 introduced it,
 * round 16 fixed restoreSendClaim re-stamping it, round 18 found
 * autoApplyAccountCreditIfEnabled's partial credit apply doing the same
 * thing). The fix replaces that token with send_claim_token — a column
 * no unrelated writer in the codebase touches. Stale recovery and a new
 * ordinary claim deliberately clear it when ending/replacing an episode.
 *
 * This is the SOURCE CONTRACT that locks the shape in place — a future edit
 * that reintroduces updated_at as the match key, or that writes
 * send_claim_token outside claim/restore/episode invalidation, fails HERE,
 * not at the next review round. No database required.
 */
const fs = require('fs');
const path = require('path');

const invoiceSource = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');

// Every OTHER file known to write the invoices row from inside a live send
// claim — i.e. the writers this class of bug keeps recurring in. Extend this
// list (never widen the assertion below) as new intra-claim writers turn up.
const OTHER_INTRA_CLAIM_WRITERS = [
  '../services/customer-credit.js', // applyAccountCreditToInvoice — round 18's finding
  '../services/invoice-issued-closeout.js',
  '../services/invoice-followups.js',
];

describe('processScheduledSends send-claim token — source contract (round 18 #4131)', () => {
  test('the preclaim flip mints a fresh send_claim_token and returns it (not updated_at) for the restore to key on', () => {
    const claimUpdate = invoiceSource.indexOf('.update({ status: "sending", updated_at: new Date(), send_claim_token: claimToken })');
    expect(claimUpdate).toBeGreaterThan(-1);
    const returningBlock = invoiceSource.slice(claimUpdate, claimUpdate + 400);
    expect(returningBlock).toMatch(/\.returning\(\[[\s\S]*?"send_claim_token"[\s\S]*?\]\)/);
    // The returning list must NOT ask back updated_at for this claim — a
    // token still lying around invites a future writer to key on it again.
    expect(returningBlock).not.toMatch(/"updated_at"/);
    expect(invoiceSource).toMatch(/const claimToken = crypto\.randomUUID\(\);/);
  });

  test('restoreClaimedInvoice matches on status + send_claim_token — never on updated_at', () => {
    const helperAt = invoiceSource.indexOf('const restoreClaimedInvoice = async (payload, label) => {');
    expect(helperAt).toBeGreaterThan(-1);
    const helperBlock = invoiceSource.slice(helperAt, helperAt + 400);
    expect(helperBlock).toMatch(/\.where\(\{ id: inv\.id, status: "sending", send_claim_token: claimed\.send_claim_token \}\)/);
    expect(helperBlock).not.toMatch(/updated_at/);
    // The restore clears the token on its way out so a stale value can never
    // be mistaken for a live claim by a later read.
    expect(helperBlock).toMatch(/\.update\(\{ \.\.\.payload, send_claim_token: null \}\)/);
  });

  test('a new ordinary claim rotates the ownership token atomically', () => {
    expect(invoiceSource).toMatch(/const freshClaimToken = crypto\.randomUUID\(\);[\s\S]{0,500}?\.update\(\{ status: "sending", updated_at: new Date\(\), send_claim_token: freshClaimToken \}\)/);
  });

  test('stale recovery clears ownership while restores and finalizers compare the caller token', () => {
    const staleRecoveryAt = invoiceSource.indexOf('// Stale-claim recovery PARKS the row');
    const staleRecoveryBlock = invoiceSource.slice(staleRecoveryAt, staleRecoveryAt + 1800);
    expect(staleRecoveryBlock).toMatch(/status: "scheduled",[\s\S]{0,500}?send_claim_token: null,/);
    expect(invoiceSource).toMatch(/whereSendClaimOwned\([\s\S]*?send_claim_token: claimToken/);
    expect(invoiceSource).toMatch(/status: "sending", send_claim_token: claimToken/);
  });

  test.each(OTHER_INTRA_CLAIM_WRITERS)('%s never references send_claim_token — an intra-claim writer here cannot invalidate the scheduled-send restore', (relPath) => {
    const filePath = path.join(__dirname, relPath);
    if (!fs.existsSync(filePath)) return; // file moved/renamed — nothing to guard here anymore
    const source = fs.readFileSync(filePath, 'utf8');
    expect(source).not.toMatch(/send_claim_token/);
  });
});
