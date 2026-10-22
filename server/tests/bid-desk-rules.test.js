// Bid Desk rules (GATE_BID_DESK): the addendum / date rule, reminder eligibility and the notification copy.
// Pure: no database, no clock. Synthetic bids only.
const { attachPatch, reminderDue, daysLeft } = require('../services/bid-desk/rules');
const { newBidSpec, addendumSpec, reminderSpec } = require('../services/bid-desk/alerts');
const { composeAdminAlert } = require('../services/admin-alert-compose');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-01T14:00:00Z'); // 10:00 ET
const bid = (over = {}) => ({
  id: '11111111-2222-4333-8444-555555555555', status: 'new', historical: false, due_at: null, due_source_line: null,
  due_confirmed: false, needs_date_confirmation: false, gc_or_agency: null, project_title: null, location: null,
  buyer_name: null, buyer_email: null, job_walk_at: null, reminder_7d_sent_at: null, reminder_2d_sent_at: null, ...over,
});
const parsed = (over = {}) => ({
  gc_or_agency: null, project_title: null, location: null, buyer_name: null, buyer_email: null, job_walk_at: null,
  due_at: null, due_source_line: null, ...over,
});

describe('attachPatch: an email never overwrites a due date', () => {
  const confirmed = new Date('2026-10-20T03:59:00Z');
  const moved = new Date('2026-10-27T03:59:00Z');

  test('an addendum with a new date leaves a confirmed due date alone and asks for confirmation', () => {
    const { patch } = attachPatch(bid({ due_at: confirmed, due_confirmed: true }), parsed({ due_at: moved, due_source_line: 'Bid Due: October 26, 2026' }), 'addendum');
    expect(patch).toEqual({ needs_date_confirmation: true });
  });

  test('an addendum fills a due date that was never read, still unconfirmed', () => {
    const { patch } = attachPatch(bid(), parsed({ due_at: moved, due_source_line: 'Bid Due: October 26, 2026' }), 'addendum');
    expect(patch).toEqual({ due_at: moved, due_source_line: 'Bid Due: October 26, 2026', needs_date_confirmation: true });
    expect(patch).not.toHaveProperty('due_confirmed');
  });

  test('an unconfirmed date read earlier stays as read when a later email says something else', () => {
    const { patch } = attachPatch(bid({ due_at: confirmed }), parsed({ due_at: moved }), 'reminder');
    expect(patch).toEqual({ needs_date_confirmation: true });
  });

  test('a later email with the same date, or no date, changes nothing', () => {
    expect(attachPatch(bid({ due_at: confirmed }), parsed({ due_at: new Date(confirmed) }), 'reminder').patch).toEqual({});
    expect(attachPatch(bid({ due_at: confirmed }), parsed(), 'message').patch).toEqual({});
  });

  test('empty fields fill; fields already set are not replaced', () => {
    const { patch } = attachPatch(bid({ project_title: 'Existing Project' }), parsed({ project_title: 'Other', location: '9 Fixture Rd', gc_or_agency: 'Fixture Build Co' }), 'message');
    expect(patch).toEqual({ location: '9 Fixture Rd', gc_or_agency: 'Fixture Build Co' });
  });

  test('only an addendum on an open, non-historical bid asks for a notification', () => {
    expect(attachPatch(bid({ status: 'new' }), parsed(), 'addendum').notifyAddendum).toBe(true);
    expect(attachPatch(bid({ status: 'bid' }), parsed(), 'addendum').notifyAddendum).toBe(true);
    for (const status of ['no_bid', 'submitted', 'won', 'lost']) expect(attachPatch(bid({ status }), parsed(), 'addendum').notifyAddendum).toBe(false);
    expect(attachPatch(bid({ historical: true }), parsed(), 'addendum').notifyAddendum).toBe(false);
    expect(attachPatch(bid(), parsed(), 'reminder').notifyAddendum).toBe(false);
  });
});

describe('reminderDue', () => {
  const due = (ms, over = {}) => bid({ due_at: new Date(NOW.getTime() + ms), due_confirmed: true, ...over });

  test('an unconfirmed date never reminds', () => {
    expect(reminderDue(due(3 * DAY, { due_confirmed: false }), NOW)).toBeNull();
    expect(reminderDue(due(1 * DAY, { due_confirmed: false }), NOW)).toBeNull();
  });

  test('a historical bid never reminds', () => {
    expect(reminderDue(due(1 * DAY, { historical: true }), NOW)).toBeNull();
  });

  test('only open bids remind', () => {
    for (const status of ['no_bid', 'submitted', 'won', 'lost']) expect(reminderDue(due(1 * DAY, { status }), NOW)).toBeNull();
    expect(reminderDue(due(1 * DAY, { status: 'bid' }), NOW)).toBe('2d');
  });

  test('7 days and 2 days, each once', () => {
    expect(reminderDue(due(8 * DAY), NOW)).toBeNull();
    expect(reminderDue(due(7 * DAY), NOW)).toBe('7d');
    expect(reminderDue(due(7 * DAY, { reminder_7d_sent_at: NOW }), NOW)).toBeNull();
    expect(reminderDue(due(5 * DAY, { reminder_7d_sent_at: NOW }), NOW)).toBeNull();
    expect(reminderDue(due(2 * DAY, { reminder_7d_sent_at: NOW }), NOW)).toBe('2d');
    expect(reminderDue(due(2 * DAY, { reminder_7d_sent_at: NOW, reminder_2d_sent_at: NOW }), NOW)).toBeNull();
  });

  test('a bid first seen inside 2 days gets the 2-day reminder, not a late 7-day one', () => {
    expect(reminderDue(due(1 * DAY), NOW)).toBe('2d');
    expect(reminderDue(due(1 * DAY, { reminder_2d_sent_at: NOW }), NOW)).toBeNull();
  });

  test('a past due date and a missing date never remind', () => {
    expect(reminderDue(due(-1 * DAY), NOW)).toBeNull();
    expect(reminderDue(bid({ due_confirmed: true }), NOW)).toBeNull();
  });
});

test('daysLeft counts ET calendar days', () => {
  expect(daysLeft(new Date('2026-10-04T03:59:00Z'), NOW)).toBe(2); // Oct 3 23:59 ET vs Oct 1
  expect(daysLeft(new Date('2026-10-02T02:00:00Z'), NOW)).toBe(0); // still Oct 1 ET
  expect(daysLeft(null, NOW)).toBeNull();
});

describe('notification copy follows the admin notification rule', () => {
  const email = { subject: 'Invitation to Bid: Sample Ridge Residences', from_name: 'Fixture Build Co via BuildingConnected', from_address: 'invites@buildingconnected.com' };
  const dated = bid({ project_title: 'Sample Ridge Residences', gc_or_agency: 'Fixture Build Co', due_at: new Date('2026-10-06T03:59:00Z') });

  test('new bid: undated, dated, and a very long project and buyer all compose', () => {
    for (const row of [bid({ project_title: 'Sample Ridge Residences' }), dated,
      bid({ project_title: 'P'.repeat(300), gc_or_agency: 'Fixture Build Company of the Greater Sampleville Area, LLC', due_at: dated.due_at }),
      bid()]) {
      const { spec, detail } = newBidSpec(row, email);
      expect(() => composeAdminAlert(spec)).not.toThrow();
      expect(detail).toMatch(/^New bid invite: .+ from .+, due /);
    }
    expect(newBidSpec(bid({ project_title: 'Sample Ridge Residences' }), email).detail).toBe('New bid invite: Sample Ridge Residences from Fixture Build Co via BuildingConnected, due date not read');
    expect(newBidSpec(dated, email).detail).toBe('New bid invite: Sample Ridge Residences from Fixture Build Co, due Oct 5 (not confirmed)');
  });

  test('a bid with no template fields is named from the email', () => {
    const { spec } = newBidSpec(bid(), { subject: 'RFP: Grounds pest control', from_name: 'Sample HOA', from_address: 'a@sample-hoa.example' });
    expect(spec.why).toMatch(/^RFP: Grounds pest control, due date not read/);
    expect(spec.action).toMatch(/Sample HOA/);
  });

  test('code-shaped words from an email are cleaned out so the bell still rings', () => {
    const messy = { subject: 'RFP 3f2b8c1d9a7e4b6f [urgent] bid_docs 2026-10-05! Phase 2. Pest', from_name: null, from_address: 'bids@sample-hoa.example' };
    const { spec } = newBidSpec(bid(), messy);
    expect(() => composeAdminAlert(spec)).not.toThrow();
    expect(spec.why).not.toMatch(/3f2b8c1d9a7e|\[|_|2026-10/);
    expect(spec.action).toMatch(/bids@sample-hoa/);
    expect(() => composeAdminAlert(newBidSpec(bid({ project_title: '2026-10-05_x'.repeat(3) }), messy).spec)).not.toThrow();
  });

  test('addendum and both reminders compose and link to the bid', () => {
    const confirmed = { ...dated, due_confirmed: true, needs_date_confirmation: true };
    for (const { spec } of [addendumSpec(confirmed, email), reminderSpec(confirmed, '7d'), reminderSpec(confirmed, '2d')]) {
      expect(() => composeAdminAlert(spec)).not.toThrow();
      expect(spec.link).toBe(`/admin/bid-desk?bid=${confirmed.id}`);
      expect(spec.severity).toBe('needs-you');
    }
    expect(addendumSpec(confirmed, email).detail).toBe('Addendum on Sample Ridge Residences: confirm the due date');
    expect(reminderSpec(confirmed, '2d').spec.action).toMatch(/due in 2 days/);
  });
});
