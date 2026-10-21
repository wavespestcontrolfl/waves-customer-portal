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
    const codeLines = jobStatus.split('\n').filter((line) => !line.trim().startsWith('//') && line.includes("'pending_approved'"));
    expect(codeLines).toHaveLength(1);
  });

  test('the approved marker is mandatory: a failed claim aborts the cancellation instead of committing without it', () => {
    expect(jobStatus).toMatch(/\} catch \(claimErr\) \{\s*\n(?:\s*\/\/.*\n)*\s*if \(cancelNoticeApproved\) throw claimErr;/);
  });

  test('the Dispatch handler passes cancelNoticeApproved only for the bar\'s approved text', () => {
    expect(dispatch).toContain("...(req.ibApprovedCancelNotice ? { cancelNoticeApproved: true } : {}),");
  });

  test('inside appointment-reminders.js every pending_approved is in handleCancellation (the approved send), none in a sweep', () => {
    const start = reminders.indexOf('  async handleCancellation(scheduledServiceId, options = {}) {');
    const end = reminders.indexOf('  async handleNoShow(');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const outside = reminders.slice(0, start) + reminders.slice(end);
    expect(outside).not.toContain('pending_approved');
    // Inside it, the state is added to the live-state lists only when this call carries an approvedNotice.
    expect(reminders.slice(start, end)).toContain("const claimStates = approvedSend ? ['pending', 'pending_notify', 'pending_approved'] : ['pending', 'pending_notify'];");
  });

  test('the sweeps and the late-claim fallback list only pending / pending_notify', () => {
    const start = reminders.indexOf('  async handleCancellation(scheduledServiceId, options = {}) {');
    const end = reminders.indexOf('  async handleNoShow(');
    const sweepLists = (reminders.slice(0, start) + reminders.slice(end)).match(/cancellation_notice_state'?,? ?\[[^\]]*\]/g) || [];
    expect(sweepLists.length).toBeGreaterThan(0);
    for (const list of sweepLists) expect(list).not.toContain('pending_approved');
  });

  test('a visit restored to a live status sheds the marker like any other (the clear is state-agnostic)', () => {
    expect(jobStatus).toMatch(/\.whereNotNull\('cancellation_notice_state'\)\s*\n\s*\.update\(\{ cancellation_notice_at: null, cancellation_notice_state: null/);
  });
});
