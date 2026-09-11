// Keep the full completion form's existing storage keys stable. Recap-only
// drafts use a separate purpose because their treatment payload differs.
export function completionDraftKey(serviceId, purpose) {
  return `waves_completion_draft_${serviceId}${purpose ? `_${purpose}` : ''}`;
}
