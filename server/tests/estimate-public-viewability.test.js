const {
  isEstimateCustomerViewable,
  isEstimateAcceptActive,
} = require('../routes/estimate-public');

const FUTURE = new Date(Date.now() + 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

describe('isEstimateCustomerViewable (React /:token/data security gate)', () => {
  it('serves a published, unexpired estimate', () => {
    expect(isEstimateCustomerViewable({ status: 'sent', expires_at: FUTURE })).toBe(true);
    expect(isEstimateCustomerViewable({ status: 'viewed', expires_at: FUTURE })).toBe(true);
    expect(isEstimateCustomerViewable({ status: 'sending', expires_at: FUTURE })).toBe(true);
  });

  it('withholds an unreviewed draft, including a no-expiry draft', () => {
    expect(isEstimateCustomerViewable({ status: 'draft', expires_at: FUTURE })).toBe(false);
    expect(isEstimateCustomerViewable({ status: 'draft', expires_at: null })).toBe(false);
  });

  it('withholds a sent estimate with a missing or past expiry', () => {
    expect(isEstimateCustomerViewable({ status: 'sent', expires_at: null })).toBe(false);
    expect(isEstimateCustomerViewable({ status: 'sent', expires_at: PAST })).toBe(false);
  });

  it('withholds expired / send_failed / archived estimates', () => {
    expect(isEstimateCustomerViewable({ status: 'expired', expires_at: FUTURE })).toBe(false);
    expect(isEstimateCustomerViewable({ status: 'send_failed', expires_at: FUTURE })).toBe(false);
    expect(isEstimateCustomerViewable({ status: 'sent', expires_at: FUTURE, archived_at: PAST })).toBe(false);
  });

  it('still serves accepted/declined terminal views (legacy parity), even past expiry', () => {
    expect(isEstimateCustomerViewable({ status: 'accepted', expires_at: PAST })).toBe(true);
    expect(isEstimateCustomerViewable({ status: 'declined', expires_at: PAST })).toBe(true);
  });
});

describe('isEstimateAcceptActive — draft/expiry hardening', () => {
  it('rejects an unreviewed draft and a no-expiry estimate', () => {
    expect(isEstimateAcceptActive({ status: 'draft', expires_at: FUTURE })).toBe(false);
    expect(isEstimateAcceptActive({ status: 'sent', expires_at: null })).toBe(false);
  });

  it('rejects expired and already-terminal estimates', () => {
    expect(isEstimateAcceptActive({ status: 'sent', expires_at: PAST })).toBe(false);
    expect(isEstimateAcceptActive({ status: 'accepted', expires_at: FUTURE })).toBe(false);
    expect(isEstimateAcceptActive({ status: 'declined', expires_at: FUTURE })).toBe(false);
  });

  it('accepts a published, unexpired estimate', () => {
    expect(isEstimateAcceptActive({ status: 'sent', expires_at: FUTURE })).toBe(true);
    expect(isEstimateAcceptActive({ status: 'viewed', expires_at: FUTURE })).toBe(true);
  });
});
