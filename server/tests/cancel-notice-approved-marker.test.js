/**
 * The cancel-notice claim a card-approved send owns is minted 'pending_approved' (job-status.js transitionJobStatus
 * cancelNoticeApproved), and NO sweep lists that state: the stale-claim sweeps, the late-claim fallback and the
 * caller-intent outbox only ever look at 'pending' / 'pending_notify' (or NULL). So a process exit, or a transient
 * database failure, before the approved send finalizes leaves a marker nothing sends from; the receipt says the text
 * was not confirmed. Source-text guards in the style of this repo's other writer guards.
 */
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const reminders = read('../services/appointment-reminders.js');
const jobStatus = read('../services/job-status.js');
const dispatch = read('../routes/admin-dispatch.js');

describe('pending_approved is minted only for the approved send and read only by it', () => {
  test('job-status mints it only for notifyCustomer "caller" with cancelNoticeApproved, and writes no outbox for it', () => {
    expect(jobStatus).toContain("(notifyCustomer === 'caller' ? (cancelNoticeApproved ? 'pending_approved' : 'pending_notify') : 'pending')");
    expect(jobStatus).toContain("if (notifyCustomer === 'caller' && !cancelNoticeApproved) {");
    // The state is minted in exactly one place (the claim's targetState); every other mention is a comment.
    const codeLines = jobStatus.split('\n').filter((line) => !line.trim().startsWith('//') && line.includes("? 'pending_approved'"));
    expect(codeLines).toHaveLength(1);
  });

  test('the approved marker is minted whatever GATE_CANCEL_NOTICE_HOOK says; every other claim stays behind the gate', () => {
    // One gate expression guards the claim transaction, and it is open for an approved cancel.
    const gates = jobStatus.split('\n').filter((line) => !line.trim().startsWith('//') && line.includes("isEnabled('cancelNoticeHook')"));
    expect(gates.map((l) => l.trim())).toEqual([
      "if (isEnabled('cancelNoticeHook') || cancelNoticeApproved) {",
      "return isEnabled('cancelNoticeHook') ? 'may_send' : 'none';",
    ]);
    // Inside that gate, a non-approved claim is unchanged: hook-owned 'pending' / caller 'pending_notify' as before, and
    // the immediate post-commit worker still runs only for non-caller paths.
    expect(jobStatus).toContain("if (claimedRows && targetState === 'pending' && notifyCustomer !== 'caller') cancelNoticeClaimTs = claimTs;");
  });

  test('a no-text card writes its terminal suppressed marker through the same gate: caller_suppress -> suppressed, no outbox, abort when an older claim holds the row', () => {
    expect(jobStatus).toContain("let targetState = (notifyCustomer === false || notifyCustomer === 'caller_suppress')");
    expect(jobStatus).toContain("? 'suppressed'");
    // The outbox is only for 'caller' without an approval; caller_suppress never writes one.
    expect(jobStatus).toContain("if (notifyCustomer === 'caller' && !cancelNoticeApproved) {");
    expect(jobStatus).toContain('if (cancelNoticeApproved && !claimedRows) {');
  });

  test('the approved send does not read the hook gate: the only gate read in its code path is the sweep-retention branch an approved send never takes', () => {
    const start = reminders.indexOf('function makeCancellationFinalizer(');
    const end = reminders.indexOf('function makeCancellationPreDispatchCheck(');
    const finalizer = reminders.slice(start, end);
    const reads = finalizer.split('\n').filter((l) => !l.trim().startsWith('//') && l.includes("isEnabled('cancelNoticeHook')"));
    expect(reads).toHaveLength(1);
    // That read sits inside `if (!accepted && retryable && !options.approvedNotice) {`.
    expect(finalizer).toMatch(/if \(!accepted && retryable && !options\.approvedNotice\) \{[\s\S]*isEnabled\('cancelNoticeHook'\)/);
    // And handleCancellation itself reads no gate.
    const hc = reminders.slice(reminders.indexOf('  async handleCancellation('), reminders.indexOf('  async handleNoShow('));
    expect(hc).not.toContain('cancelNoticeHook');
  });

  test('the approved marker is mandatory: a failed claim aborts the cancellation instead of committing without it', () => {
    expect(jobStatus).toMatch(/\} catch \(claimErr\) \{\s*\n(?:\s*\/\/.*\n)*\s*if \(cancelNoticeApproved\) throw claimErr;/);
  });

  test('an approved cancel REPLACES a terminal / approved marker from an earlier cancellation cycle, and aborts on a live older claim', () => {
    // The claim's WHERE accepts those three states only for an approved cancel (otherwise `false`).
    expect(jobStatus).toContain("if (cancelNoticeApproved) this.whereIn('cancellation_notice_state', ['suppressed', 'sent', 'pending_approved']);\n                  else this.whereRaw('false');");
    // A row still unclaimed afterwards holds a live older claim: abort, whatever its state.
    expect(jobStatus).toMatch(/if \(cancelNoticeApproved && !claimedRows\) \{\s*\n\s*const existing = await sp\('appointment_reminders'\)\.where\(\{ scheduled_service_id: jobId \}\)\.first\('cancellation_notice_state'\);\s*\n\s*if \(existing\) \{\s*\n\s*throw new Error/);
    // The old allow-list that reused a stale terminal marker is gone.
    expect(jobStatus).not.toContain("!['suppressed', 'sent', 'pending_approved'].includes(existing.cancellation_notice_state)");
  });

  test('the Dispatch handler passes cancelNoticeApproved only for the bar\'s approved text', () => {
    expect(dispatch).toContain("...(req.ibApprovedCancelNotice || req.ibApprovedNoText ? { cancelNoticeApproved: true } : {}),");
    // ibApprovedNoText is set only by the bar replay, and only for an explicit no-text choice.
    expect(dispatch).toContain('ibApprovedNoText: notifyCustomer === false,');
    expect(dispatch.split('\n').filter((l) => !l.trim().startsWith('//') && l.includes('ibApprovedNoText'))).toHaveLength(2);
  });

  // The approved send is handleCancellation plus the claim/finalize helpers it was split into (Codex #6377 r4 P2):
  // the module-level block from claimCancellationNotice up to the AppointmentReminders object.
  const approvedSendRegions = () => {
    const start = reminders.indexOf('  async handleCancellation(scheduledServiceId, options = {}) {');
    const end = reminders.indexOf('  async handleNoShow(');
    const helpersStart = reminders.indexOf('async function claimCancellationNotice(');
    const helpersEnd = reminders.indexOf('const AppointmentReminders = {');
    return { start, end, helpersStart, helpersEnd };
  };

  test('inside appointment-reminders.js every pending_approved is in the approved send (handleCancellation and its claim helpers), none in a sweep', () => {
    const { start, end, helpersStart, helpersEnd } = approvedSendRegions();
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(helpersStart).toBeGreaterThan(-1);
    expect(helpersEnd).toBeGreaterThan(helpersStart);
    expect(helpersEnd).toBeLessThan(start);
    const outside = reminders.slice(0, helpersStart) + reminders.slice(helpersEnd, start) + reminders.slice(end);
    expect(outside).not.toContain('pending_approved');
    // In the helpers, the marker is adopted only when the call carries an approved send.
    expect(reminders.slice(helpersStart, helpersEnd)).toContain("if (approvedSend) this.where('cancellation_notice_state', 'pending_approved');");
    // Inside handleCancellation, the state is added to the live-state lists only when this call carries an approvedNotice.
    expect(reminders.slice(start, end)).toContain("const claimStates = approvedSend ? ['pending', 'pending_notify', 'pending_approved'] : ['pending', 'pending_notify'];");
  });

  test('the sweeps and the late-claim fallback list only pending / pending_notify', () => {
    const { start, end, helpersStart, helpersEnd } = approvedSendRegions();
    const sweepLists = (reminders.slice(0, helpersStart) + reminders.slice(helpersEnd, start) + reminders.slice(end)).match(/cancellation_notice_state'?,? ?\[[^\]]*\]/g) || [];
    expect(sweepLists.length).toBeGreaterThan(0);
    for (const list of sweepLists) expect(list).not.toContain('pending_approved');
  });

  test('a visit restored to a live status sheds the marker like any other (the clear is state-agnostic)', () => {
    expect(jobStatus).toMatch(/\.whereNotNull\('cancellation_notice_state'\)\s*\n\s*\.update\(\{ cancellation_notice_at: null, cancellation_notice_state: null/);
  });
});
