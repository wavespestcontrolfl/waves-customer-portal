jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

test('applicant emails stay off the generic transactional provider-retry rail', () => {
  const { isTransactionalRetryEligible } = require('../services/transactional-email-provider-retry');
  const base = { has_attachments: false, recipient_email_snapshot: 'a@example.com', subject_snapshot: 'Hi', suppression_group_key_snapshot: '' };
  expect(isTransactionalRetryEligible({ ...base, recipient_type: 'customer' })).toBe(true);
  expect(isTransactionalRetryEligible({ ...base, recipient_type: 'job_application' })).toBe(false);
});

test('bounce recovery never resolves an applicant email to a customer (source guard) and the estimator context excludes recruiting texts', () => {
  const fs = require('fs');
  const bounce = fs.readFileSync(require.resolve('../services/email-bounce-recovery'), 'utf8');
  expect(bounce).toMatch(/recipient_type[^\n]*=== 'job_application'\) return null;/);
  const ctx = fs.readFileSync(require.resolve('../services/estimator-engine/context-builder'), 'utf8');
  expect(ctx.split("NOT LIKE 'job").length - 1).toBeGreaterThanOrEqual(1);
});
