// Internal/office-only finding keys that must never print on ANY
// customer-facing rendering of a project report. Shared by the public report
// page and the admin "Customer report preview" so the preview staff approve
// can't diverge from what the customer actually sees. (inspection_fee is a
// fee-tier helper for invoicing — the invoice carries the actual price.)
export const INTERNAL_FINDING_KEYS = new Set(['inspection_fee']);
