import { useEffect, useRef, useState } from 'react';
import { completionDraftKey } from '../lib/completion-drafts';
import { getAdminUser } from '../lib/adminAuth';

const STORAGE_ERROR = 'Draft could not be saved on this device. Keep this visit open until completion succeeds.';
const RESTORE_ERROR = 'Could not verify this draft against the current visit. Close and reopen to refresh, or discard the draft to use the current record.';

// Ownership identity of the live visit as the recap context reports it.
// The same object is sent with the completion request so the server can
// re-check it under its row lock. Lifecycle status is deliberately not
// part of it: pending → en_route → on_site keeps the same treatment, and
// a terminal or concurrent completion shows up in the record identity.
// Absence is preserved rather than normalized to null: during a rolling
// deploy an older pod serves a context without the newer keys, and a
// null asserted for one of those would make a newer pod reject the
// completion as visit_identity_changed (codex P1 r4). Restoring a draft
// across that key gap is a separate question, answered by
// recapDraftCompatible below.
const IDENTITY_KEYS = ['customerId', 'propertyId', 'catalogServiceId', 'serviceType', 'scheduledDate', 'address'];
export function recapVisitIdentity(service) {
  const s = service || {};
  return Object.fromEntries(IDENTITY_KEYS.filter((key) => s[key] !== undefined).map((key) => [key, s[key]]));
}

export function recapSubmitError(err) {
  if (err?.message === 'visit_identity_changed') {
    return 'This visit changed since it was opened. Close and reopen to review the current property before completing.';
  }
  return err?.message || 'Could not complete recap';
}

function recordIdentity(record) {
  if (!record) return null;
  return [record.id, record.status, record.technician_notes, (record.products || []).map((p) => JSON.stringify([
    p.product_id, p.product_name, p.product_category, p.active_ingredient, p.moa_group, p.application_rate, p.rate_unit,
  ])).sort()];
}

// Recorded products the picker could not represent at load time are part
// of the identity: a draft saved while a recorded product was missing from
// the catalog holds an empty selection for it and must not be restored
// once that product is representable (the live preselection would be
// replaced and the completion would drop it).
export function recapContextIdentity(ctx, authoritative, unrepresented = []) {
  if (!ctx || !authoritative) return null;
  return JSON.stringify({ visit: recapVisitIdentity(ctx.service), record: recordIdentity(ctx.existingRecord), unrepresented: [...unrepresented].sort() });
}

// A saved draft is restorable only when its identity equals the live one
// exactly, key set included. A key the live context reports but the draft
// never recorded (draft saved from an older pod during a rolling deploy)
// is treated as incompatible: the draft cannot prove the visit was not
// reassigned to another property for the same customer, service and day
// while that key was unobserved, and a restore would then submit the old
// property's treatment under the new identity (codex P1 r5). The cost is
// that a draft that straddles a deploy must be discarded, which the
// verification message already explains.
export function recapDraftCompatible(savedIdentity, liveIdentity) {
  return typeof savedIdentity === 'string' && savedIdentity.length > 0 && savedIdentity === liveIdentity;
}

// Rates travel only for selected products: deselecting leaves the typed
// rate in state on purpose, and a snapshot carrying that hidden entry
// would keep an unchanged form dirty and create a phantom draft. Only the
// technician-entered rate and unit are saved; the catalog label ceiling
// is re-derived from the live catalog on restore (codex P2 r4).
export function recapDraftSnapshot({ note, message, rates, sendText, includeComms, selected, productById, restoredNames }) {
  // Canonical order: a deselect + reselect moves an id to the end of the
  // Set without changing the treatment, and must not read as a new draft.
  const ids = [...selected].sort((a, b) => String(a).localeCompare(String(b)));
  return {
    note,
    message,
    sendText,
    includeComms,
    rates: Object.fromEntries(ids.filter((id) => rates[id]).map((id) => [id, { rate: rates[id].rate, unit: rates[id].unit }])),
    selectedProducts: ids.map((id) => ({ id, name: productById.get(id)?.name || restoredNames[id] || String(id) })),
  };
}

// ceilingFor(id, unit) returns the CURRENT catalog label ceiling for a
// restored rate in its own unit, so the over-label warning on a reopened
// draft reflects the live catalog rather than the one saved with it.
export function restoredRecapForm(saved, hasPhone, ceilingFor = () => null) {
  const selectedProducts = Array.isArray(saved?.selectedProducts) ? saved.selectedProducts : [];
  const savedRates = saved?.rates || {};
  return {
    note: saved?.note || '',
    message: saved?.message || '',
    rates: Object.fromEntries(selectedProducts.filter((p) => savedRates[p.id]).map((p) => {
      const { rate, unit } = savedRates[p.id];
      const max = ceilingFor(p.id, unit);
      return [p.id, { rate, unit, ...(max != null ? { max } : {}) }];
    })),
    sendText: saved?.sendText === true && !!hasPhone,
    includeComms: saved?.includeComms !== false,
    selected: new Set(selectedProducts.map((p) => p.id)),
    restoredNames: Object.fromEntries(selectedProducts.map((p) => [p.id, p.name])),
  };
}

export default function useServiceRecapDraft({ serviceId, ctx, loading, loadError, authoritative, unrepresented, submitting, form, ceilingFor }) {
  const user = getAdminUser();
  const [key] = useState(() => completionDraftKey(serviceId, `recap_${user?.id || 'local'}_${user?.role || 'local'}`));
  const [storageError, setStorageError] = useState('');
  const [saved, setSaved] = useState(false);
  const [candidate, setCandidate] = useState(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(key) || 'null');
      return draft?.serviceId === serviceId && Array.isArray(draft?.selectedProducts) ? draft : null;
    } catch { return null; }
  });
  const baseline = useRef(null);
  const complete = useRef(false);
  const ready = !loading && !loadError;
  const sourceIdentity = recapContextIdentity(ctx, authoritative && !loadError, unrepresented);
  const serialized = JSON.stringify(recapDraftSnapshot(form));

  useEffect(() => {
    if (!ready || complete.current) return;
    if (baseline.current === null) { baseline.current = { serialized, sourceIdentity }; return; }
    if (candidate) return;
    try {
      if (serialized === baseline.current.serialized) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify({ ...JSON.parse(serialized), serviceId, sourceIdentity: baseline.current.sourceIdentity, savedAt: Date.now() }));
      setSaved(serialized !== baseline.current.serialized);
      setStorageError('');
    } catch {
      setSaved(false);
      setStorageError(STORAGE_ERROR);
    }
  }, [candidate, key, ready, serialized, serviceId, sourceIdentity]);

  useEffect(() => {
    if (!storageError || candidate || complete.current || serialized === baseline.current?.serialized) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [candidate, serialized, storageError]);

  const discard = () => {
    try { localStorage.removeItem(key); }
    catch {
      setStorageError('Could not remove the saved draft on this device.');
      return false;
    }
    setCandidate(null);
    setSaved(false);
    setStorageError('');
    return true;
  };

  const finish = () => {
    complete.current = true;
    discard();
  };

  const missingSelections = [...form.selected].filter((id) => !form.productById.has(id));
  const restoreError = candidate && (!ready || sourceIdentity === null || !recapDraftCompatible(candidate.sourceIdentity, sourceIdentity))
    ? RESTORE_ERROR : '';
  return {
    candidate,
    saved,
    storageError,
    restoreError,
    missingSelections,
    formLocked: submitting || !!candidate,
    submitBlocked: submitting || !!candidate || missingSelections.length > 0,
    restoreForm: () => restoredRecapForm(candidate, ctx?.service?.hasPhone, ceilingFor),
    canClose: () => !storageError || window.confirm('This draft is not saved on this device. Close and lose these changes?'),
    discard,
    finish,
    restored: () => setCandidate(null),
  };
}
