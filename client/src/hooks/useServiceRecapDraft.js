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
export function recapVisitIdentity(service) {
  const s = service || {};
  return {
    customerId: s.customerId ?? null,
    propertyId: s.propertyId ?? null,
    catalogServiceId: s.catalogServiceId ?? null,
    serviceType: s.serviceType ?? null,
    scheduledDate: s.scheduledDate ?? null,
    address: s.address ?? null,
  };
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

export function recapContextIdentity(ctx, authoritative) {
  if (!ctx || !authoritative) return null;
  return JSON.stringify([recapVisitIdentity(ctx.service), recordIdentity(ctx.existingRecord)]);
}

// Rates travel only for selected products: deselecting leaves the typed
// rate in state on purpose, and a snapshot carrying that hidden entry
// would keep an unchanged form dirty and create a phantom draft.
export function recapDraftSnapshot({ note, message, rates, sendText, includeComms, selected, productById, restoredNames }) {
  // Canonical order: a deselect + reselect moves an id to the end of the
  // Set without changing the treatment, and must not read as a new draft.
  const ids = [...selected].sort((a, b) => String(a).localeCompare(String(b)));
  return {
    note,
    message,
    sendText,
    includeComms,
    rates: Object.fromEntries(ids.filter((id) => rates[id]).map((id) => [id, rates[id]])),
    selectedProducts: ids.map((id) => ({ id, name: productById.get(id)?.name || restoredNames[id] || String(id) })),
  };
}

export function restoredRecapForm(saved, hasPhone) {
  const selectedProducts = Array.isArray(saved?.selectedProducts) ? saved.selectedProducts : [];
  return {
    note: saved?.note || '',
    message: saved?.message || '',
    rates: saved?.rates || {},
    sendText: saved?.sendText === true && !!hasPhone,
    includeComms: saved?.includeComms !== false,
    selected: new Set(selectedProducts.map((p) => p.id)),
    restoredNames: Object.fromEntries(selectedProducts.map((p) => [p.id, p.name])),
  };
}

export default function useServiceRecapDraft({ serviceId, ctx, loading, loadError, authoritative, submitting, form }) {
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
  const sourceIdentity = recapContextIdentity(ctx, authoritative && !loadError);
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
  const restoreError = candidate && (!ready || sourceIdentity === null || candidate.sourceIdentity !== sourceIdentity)
    ? RESTORE_ERROR : '';
  return {
    candidate,
    saved,
    storageError,
    restoreError,
    missingSelections,
    formLocked: submitting || !!candidate,
    submitBlocked: submitting || !!candidate || missingSelections.length > 0,
    restoreForm: () => restoredRecapForm(candidate, ctx?.service?.hasPhone),
    canClose: () => !storageError || window.confirm('This draft is not saved on this device. Close and lose these changes?'),
    discard,
    finish,
    restored: () => setCandidate(null),
  };
}
