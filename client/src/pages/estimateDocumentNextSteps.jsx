import React from 'react';
import { WAVES_ACCOUNT_MANAGER_FIRST_NAME, WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../constants/business';

// The estimate document's primary action and Next steps copy, derived from the
// CTA state and the server's acceptance contract (data.estimate.acceptance.mode).
// Kept apart from EstimateProposalDocument so the decisions live in one small
// pure resolver (resolveDocNextSteps) and the document stays a layout component
// (codex #6343 r7).

const NAVY = '#04395E';
const INK = '#04395E'; // the document's sheet ink
export const WAVES_EMAIL = 'contact@wavespestcontrol.com';

// Next-steps paragraphs: 14px, the repo's floor for customer-surface text
// (codex #6343 r5).
export const NEXT_STEP_P = { margin: '3px 0', fontSize: 14, lineHeight: 1.5, color: INK };

export function mailtoHref(estimateNumber) {
  const subject = estimateNumber ? `Estimate ${estimateNumber}` : 'My Waves estimate';
  return `mailto:${WAVES_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

// What the online page offers per acceptance mode, in EstimateViewPage's own
// wording. Any mode not listed (contact_office, quote_required,
// inspection_request, a future mode) has no online accept: call or email only.
export const ACCEPT_MODE_LABELS = Object.freeze({
  standard_slot_pick: 'Accept & pick a start date',
  existing_appointment: 'Confirm appointment',
  invoice_only: 'Accept + send invoice',
  commercial_site_confirmation: 'Approve estimate',
});

// Modes whose accepted estimate has a visit to show. Every other accepted mode
// (invoice-only, office-only, commercial site confirmation, ...) is accepted with
// no visit booked online, so its wording must not promise visit details.
const VISIT_MODES = new Set(['standard_slot_pick', 'existing_appointment']);

export function acceptanceModeOf(data) {
  const mode = data?.estimate?.acceptance?.mode;
  return typeof mode === 'string' && mode ? mode : 'standard_slot_pick';
}

const TERMINAL_VARIANTS = {
  accepted: null, // decided by mode below
  declined: 'declined',
  expired: 'expired',
};

// Returns { variant, primaryLabel }. `primaryLabel` null = no online action
// button (call and email stay). Precedence: terminal state, authored proposal,
// quote/review gating, then the acceptance mode.
export function resolveDocNextSteps({ cta = {}, authoredProposal = false, acceptanceMode = 'standard_slot_pick' } = {}) {
  const terminal = cta.terminalState;
  if (terminal === 'accepted') {
    return VISIT_MODES.has(acceptanceMode)
      ? { variant: 'accepted_visit', primaryLabel: 'See your visit details' }
      : { variant: 'accepted_neutral', primaryLabel: 'View your estimate' };
  }
  // Declined and expired estimates refuse acceptance online: no action button.
  if (TERMINAL_VARIANTS[terminal]) return { variant: TERMINAL_VARIANTS[terminal], primaryLabel: null };
  if (authoredProposal) return { variant: 'authored', primaryLabel: 'View estimate online' };
  if (cta.quoteRequired === true || cta.reviewBeforeBooking === true) return { variant: 'team_confirms', primaryLabel: 'View estimate online' };
  if (acceptanceMode === 'contact_office') return { variant: 'contact_office', primaryLabel: null };
  if (!ACCEPT_MODE_LABELS[acceptanceMode]) return { variant: 'team_confirms', primaryLabel: null };
  return { variant: 'go_ahead', primaryLabel: ACCEPT_MODE_LABELS[acceptanceMode] };
}

const GO_AHEAD_TAIL = {
  standard_slot_pick: ' — we’ll pick a start date with you.',
  existing_appointment: ' — your appointment stays as scheduled.',
  invoice_only: ' — no appointment is needed, and we’ll send your invoice by text and email.',
  commercial_site_confirmation: ' — after you approve, a Waves team member reaches out to schedule your service, and your account manager confirms the exact price on a quick site visit before your first invoice.',
};

const link = (href, children) => <a href={href} style={{ color: NAVY }}>{children}</a>;

const VARIANT_TEXT = {
  accepted_visit: ({ estimateUrl }) => (
    <>This estimate has been approved — your live estimate at {link(estimateUrl, estimateUrl)} has your visit details.
      {' '}Questions? Call {WAVES_SUPPORT_PHONE_DISPLAY} any time.</>
  ),
  accepted_neutral: ({ estimateUrl }) => (
    <>This estimate has been approved. Your estimate at {link(estimateUrl, estimateUrl)} has the details.
      {' '}Questions? Call {WAVES_SUPPORT_PHONE_DISPLAY} any time.</>
  ),
  declined: () => (
    <>This estimate was declined. Changed your mind? Call {WAVES_SUPPORT_PHONE_DISPLAY} and
      we’ll refresh the numbers with you.</>
  ),
  expired: () => (
    <>This estimate has expired. Call {link(WAVES_SUPPORT_PHONE_TEL, WAVES_SUPPORT_PHONE_DISPLAY)} and
      we’ll refresh the numbers with you.</>
  ),
  // Every customer surface (this document, the terminal card, the SSR banner)
  // names the shared account-manager constant (codex #3297 r1/r3).
  authored: ({ estimateUrl }) => (
    <>{WAVES_ACCOUNT_MANAGER_FIRST_NAME}, your Waves account manager, will follow up to answer
      questions and finalize this proposal — or call {WAVES_SUPPORT_PHONE_DISPLAY} any time.
      {' '}Your live estimate stays available at {link(estimateUrl, estimateUrl)}.</>
  ),
  team_confirms: ({ estimateUrl }) => (
    <>Our team will confirm the final details and scheduling with you — call {WAVES_SUPPORT_PHONE_DISPLAY} any
      time. Your live estimate stays available at {link(estimateUrl, estimateUrl)}.</>
  ),
  // The page's own wording (AcceptanceModeCard): no online accept.
  contact_office: ({ estimateUrl, estimateNumber }) => (
    <>Call {link(WAVES_SUPPORT_PHONE_TEL, WAVES_SUPPORT_PHONE_DISPLAY)} to finish this renewal — no
      appointment is needed, and we’ll set up your invoice and activate your coverage. You can also email{' '}
      {link(mailtoHref(estimateNumber), WAVES_EMAIL)}. Your estimate is online at {link(estimateUrl, estimateUrl)}.</>
  ),
  go_ahead: ({ estimateUrl, estimateNumber, acceptanceMode, primaryLabel }) => (
    <>To go ahead, tap <strong>{primaryLabel}</strong> above, call{' '}
      {link(WAVES_SUPPORT_PHONE_TEL, WAVES_SUPPORT_PHONE_DISPLAY)}, or email{' '}
      {link(mailtoHref(estimateNumber), WAVES_EMAIL)}{GO_AHEAD_TAIL[acceptanceMode] || '.'}
      {' '}Your estimate is online at {link(estimateUrl, estimateUrl)}.</>
  ),
};

// The Next steps paragraphs (the section header stays in the document).
export function NextSteps({ cta = {}, authoredProposal = false, acceptanceMode = 'standard_slot_pick', estimateUrl, estimateNumber, validThroughText = '' }) {
  const { variant, primaryLabel } = resolveDocNextSteps({ cta, authoredProposal, acceptanceMode });
  return (
    <>
      <p style={NEXT_STEP_P}>{VARIANT_TEXT[variant]({ estimateUrl, estimateNumber, acceptanceMode, primaryLabel })}</p>
      {!cta.terminalState && validThroughText ? (
        <p data-testid="doc-valid-through-line" style={NEXT_STEP_P}>Price valid through {validThroughText}.</p>
      ) : null}
    </>
  );
}
