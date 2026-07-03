const {
  isEstimateCustomerViewable,
  isEstimateAcceptActive,
  adminDraftPreviewEligible,
} = require('../routes/estimate-public');

const FUTURE = new Date(Date.now() + 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

describe('isEstimateCustomerViewable (React /:token/data security gate)', () => {
  it('serves a published, unexpired estimate', () => {
    expect(isEstimateCustomerViewable({ status: 'sent', expires_at: FUTURE })).toBe(true);
    expect(isEstimateCustomerViewable({ status: 'viewed', expires_at: FUTURE })).toBe(true);
    expect(isEstimateCustomerViewable({ status: 'sending', expires_at: FUTURE })).toBe(true);
  });

  it('serves a mid-send row whose expiry is not written yet (sending, null expiry)', () => {
    // sendEstimateNow texts the link before the final expires_at write, so a
    // freshly claimed 'sending' row can momentarily have a null expiry.
    expect(isEstimateCustomerViewable({ status: 'sending', expires_at: null })).toBe(true);
  });

  it('withholds unpublished estimates: drafts and scheduled sends', () => {
    expect(isEstimateCustomerViewable({ status: 'draft', expires_at: FUTURE })).toBe(false);
    expect(isEstimateCustomerViewable({ status: 'draft', expires_at: null })).toBe(false);
    // Scheduled sends carry a FUTURE expiry but haven't gone out yet.
    expect(isEstimateCustomerViewable({ status: 'scheduled', expires_at: FUTURE })).toBe(false);
  });

  it('withholds a published estimate whose expiry has passed', () => {
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

describe('isEstimateAcceptActive — unpublished/expiry hardening', () => {
  it('rejects unpublished estimates (draft and scheduled)', () => {
    expect(isEstimateAcceptActive({ status: 'draft', expires_at: FUTURE })).toBe(false);
    expect(isEstimateAcceptActive({ status: 'scheduled', expires_at: FUTURE })).toBe(false);
  });

  it('rejects expired and already-terminal estimates', () => {
    expect(isEstimateAcceptActive({ status: 'sent', expires_at: PAST })).toBe(false);
    expect(isEstimateAcceptActive({ status: 'accepted', expires_at: FUTURE })).toBe(false);
    expect(isEstimateAcceptActive({ status: 'declined', expires_at: FUTURE })).toBe(false);
  });

  it('accepts published estimates, incl. a mid-send row with no expiry yet', () => {
    expect(isEstimateAcceptActive({ status: 'sent', expires_at: FUTURE })).toBe(true);
    expect(isEstimateAcceptActive({ status: 'viewed', expires_at: FUTURE })).toBe(true);
    // Preserves the existing onetime-breakdown expectation (viewed + null expiry).
    expect(isEstimateAcceptActive({ status: 'viewed', expires_at: null })).toBe(true);
  });
});

describe('adminDraftPreviewEligible (staff draft preview — cheap half of the /data bypass)', () => {
  it('is eligible only for unpublished rows with the explicit param', () => {
    expect(adminDraftPreviewEligible({ status: 'draft' }, '1')).toBe(true);
    expect(adminDraftPreviewEligible({ status: 'scheduled' }, '1')).toBe(true);
  });

  it('requires ?adminPreview=1 exactly', () => {
    expect(adminDraftPreviewEligible({ status: 'draft' }, undefined)).toBe(false);
    expect(adminDraftPreviewEligible({ status: 'draft' }, '')).toBe(false);
    expect(adminDraftPreviewEligible({ status: 'draft' }, 'true')).toBe(false);
  });

  it('never applies to published/terminal/archived rows — they keep the normal gate', () => {
    expect(adminDraftPreviewEligible({ status: 'sent' }, '1')).toBe(false);
    expect(adminDraftPreviewEligible({ status: 'viewed' }, '1')).toBe(false);
    expect(adminDraftPreviewEligible({ status: 'expired' }, '1')).toBe(false);
    expect(adminDraftPreviewEligible({ status: 'send_failed' }, '1')).toBe(false);
    expect(adminDraftPreviewEligible({ status: 'accepted' }, '1')).toBe(false);
    expect(adminDraftPreviewEligible({ status: 'draft', archived_at: PAST }, '1')).toBe(false);
    expect(adminDraftPreviewEligible(null, '1')).toBe(false);
  });
});
