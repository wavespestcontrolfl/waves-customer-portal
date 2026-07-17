// Internal/office-only finding keys that must never print on ANY
// customer-facing rendering of a project report. Shared by the public report
// page and the admin "Customer report preview" so the preview staff approve
// can't diverge from what the customer actually sees. (inspection_fee is a
// fee-tier helper for invoicing — the invoice carries the actual price.)
//
// The registry and the inspection-fee cue scrubber live in
// @waves/report-redaction — the server egress/write guards
// (server/services/project-types.js) import the SAME module, so the client
// surfaces and the server payload cannot drift.
import {
  INTERNAL_FINDING_KEYS as INTERNAL_FINDING_KEY_LIST,
  redactInspectionFeeCues,
} from "@waves/report-redaction";

export const INTERNAL_FINDING_KEYS = new Set(INTERNAL_FINDING_KEY_LIST);
export { redactInspectionFeeCues };
