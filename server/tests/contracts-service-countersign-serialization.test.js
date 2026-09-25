/**
 * serializeContract's countersignature fields (server/services/contracts.js)
 * — owner ruling 2026-09-25 (A-14). Pure function, no DB.
 */
const { serializeContract } = require('../services/contracts');

const BASE_ROW = {
  id: 'k1',
  customer_id: 'c1',
  contract_type: 'document_template',
  document_template_key: 'service_agreement.termite_annual_protection',
  status: 'signed',
  title: 'Waves Subterranean Termite Protection — Annual Service Agreement',
  countersigned_at: null,
  countersigned_by: null,
  countersigner_name: null,
  countersigner_ip: null,
  countersigner_user_agent: null,
};

test('countersign fields are null when the contract has never been countersigned', () => {
  const out = serializeContract(BASE_ROW);
  expect(out.countersignedAt).toBeNull();
  expect(out.countersignedBy).toBeNull();
  expect(out.countersignerName).toBeNull();
});

test('countersign fields surface once stamped, including under includeAudit:false (the public sign response)', () => {
  const countersignedAt = new Date('2026-09-25T14:00:00Z');
  const row = {
    ...BASE_ROW,
    countersigned_at: countersignedAt,
    countersigned_by: 'admin-1',
    countersigner_name: 'Adam Owner',
    countersigner_ip: '203.0.113.9',
    countersigner_user_agent: 'jest',
  };
  const full = serializeContract(row);
  expect(full.countersignedAt).toBe(countersignedAt.toISOString());
  expect(full.countersignedBy).toBe('admin-1');
  expect(full.countersignerName).toBe('Adam Owner');
  expect(full.countersignerIp).toBe('203.0.113.9');
  expect(full.countersignerUserAgent).toBe('jest');

  const publicView = serializeContract(row, { includeAudit: false });
  expect(publicView.countersignedAt).toBe(countersignedAt.toISOString());
  expect(publicView.countersignerName).toBe('Adam Owner');
  // Audit-only fields (IP/UA) are stripped from the public-facing view, same
  // treatment as signerIp/signerUserAgent.
  expect(publicView).not.toHaveProperty('countersignerIp');
  expect(publicView).not.toHaveProperty('countersignerUserAgent');
});

test('an autopay authorization contract never carries a document template key, so the countersign-bell condition can never match it', () => {
  const out = serializeContract({ id: 'k2', customer_id: 'c1', contract_type: 'autopay_authorization', status: 'signed' });
  expect(out.documentTemplateKey).toBeNull();
});

test('a non-annual document template contract carries its own key, distinct from the annual key', () => {
  const out = serializeContract({ ...BASE_ROW, document_template_key: 'service_agreement.termite_bait_program_purchase' });
  expect(out.documentTemplateKey).toBe('service_agreement.termite_bait_program_purchase');
  expect(out.documentTemplateKey).not.toBe('service_agreement.termite_annual_protection');
});
