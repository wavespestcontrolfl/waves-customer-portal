/**
 * ops/agents/review-link-audit.js — the read-only shadow report of the review evidence matcher.
 * Pins the rows it builds from the rows it reads: every ask delivery counts on its own (a text before
 * the review and an email or follow-up after it is an ask after it), a review linked to an archived
 * customer is reported apart, a linked review older than the customer's first contact is disputed,
 * and no full name reaches the output. All names are synthetic.
 */
const { auditRows } = require('../../ops/agents/review-link-audit');

const REVIEW_AT = '2026-10-20T18:00:00.000Z';

const customer = (id, first, last, extra = {}) => ({
  id,
  first_name: first,
  last_name: last,
  secondary_contact_name: null,
  service_contact_name: null,
  service_contact2_name: null,
  service_contact3_name: null,
  has_left_google_review: false,
  created_at: '2026-04-06T12:00:00Z',
  member_since: '2025-01-15',
  customer_since: null,
  lead_source: 'square',
  first_lead_at: null,
  first_sms_at: null,
  first_call_at: null,
  first_visit_on: null,
  first_estimate_at: null,
  ...extra,
});

const review = (id, reviewerName, extra = {}) => ({
  id,
  location_id: 'parrish',
  reviewer_name: reviewerName,
  star_rating: 5,
  review_created_at: REVIEW_AT,
  customer_id: null,
  link_source: null,
  ...extra,
});

const ask = (customerId, { sms = null, email = null, followup = null } = {}) => ({
  customer_id: customerId, sms_sent_at: sms, sent_at: email, followup_delivered_at: followup,
});

const rowsFor = (over) => auditRows({ customers: [], visits: [], asks: [], taps: [], texts: [], reviews: [], ...over });

describe('review-link-audit rows', () => {
  test('an email or a follow-up delivered after the review counts even when the text went before it', () => {
    const [row] = rowsFor({
      customers: [customer('c1', 'Marlow', 'Pemberton')],
      reviews: [review('r1', 'Marlow Pemberton', { customer_id: 'c1' })],
      asks: [
        ask('c1', { sms: '2026-10-19T15:00:00Z', followup: '2026-10-22T15:00:00Z' }),
        ask('c1', { sms: '2026-10-10T15:00:00Z', email: '2026-10-21T15:00:00Z' }),
      ],
    });
    expect(row).toMatchObject({ section: 'linked_ok', ownerId: 'c1', ownerAsksAfter: 2, ownerMarked: false });
  });

  test('an unlinked near-miss review names the customer whose asks pause, with the asks after it', () => {
    const [row] = rowsFor({
      customers: [customer('c1', 'Dana', 'Fenwick')],
      reviews: [review('r1', 'Dana Fenwikc')],
      asks: [ask('c1', { sms: '2026-10-25T15:00:00Z' })],
    });
    expect(row).toMatchObject({ section: 'unlinked_pause', result: 'pause', ownerId: 'c1', ownerAsksAfter: 1 });
  });

  test('a tap stamped for the review\'s profile counts as evidence', () => {
    const [row] = rowsFor({
      customers: [customer('c1', 'Peter', 'Quill')],
      reviews: [review('r1', 'Peter Q')],
      taps: [{
        customer_id: 'c1', redirected_at: '2026-10-20T17:00:00Z', google_location: 'parrish', last_redirected_at: null, last_google_location: null,
      }],
    });
    expect(row).toMatchObject({ result: 'pause', top: { activity: { tap: true } } });
  });

  test('a review linked to an archived customer is reported apart, with no owner', () => {
    const [row] = rowsFor({ reviews: [review('r1', 'Marlow Pemberton', { customer_id: 'gone' })] });
    expect(row).toMatchObject({ section: 'linked_archived', ownerId: null });
  });

  test('a linked review older than the customer\'s first contact is disputed', () => {
    const [row] = rowsFor({
      customers: [customer('c1', 'Marlow', 'Pemberton', { lead_source: 'website', created_at: '2026-10-15T14:00:00Z', member_since: null })],
      reviews: [review('r1', 'Marlow Pemberton', { customer_id: 'c1', review_created_at: '2026-09-01T15:00:00Z' })],
    });
    expect(row).toMatchObject({ section: 'linked_date_clash', ownerId: null });
  });

  test('rows carry initials and ids, never a full name', () => {
    const rows = rowsFor({
      customers: [customer('c1', 'Marlow', 'Pemberton')],
      reviews: [review('r1', 'Marlow Pemberton', { customer_id: 'c1' })],
    });
    expect(rows[0]).toMatchObject({ reviewer: 'M.P.', linkedCustomer: 'M.P.' });
    expect(JSON.stringify(rows)).not.toMatch(/marlow|pemberton/i);
  });
});
