// client/src/components/ServiceRecapModal.jsx
//
// Lightweight "Service Recap" modal for pest_control services — the slim
// alternative to the heavy CreateProjectModal "project report". Used on
// BOTH surfaces: admin dispatch (DispatchPageV2, theme="light") and the
// tech portal (TechHomePage, theme="dark").
//
// It is a thin UI over the recap-only completion path:
//   GET  /admin/dispatch/:id/pest-recap/context   (timeline + catalog)
//   POST /admin/dispatch/:id/pest-recap/draft      (AI customer copy)
//   POST /admin/dispatch/:id/pest-recap            (complete, no bill)
//
// The `request(path, options)` prop is the surface's fetch helper
// (adminFetch on admin; a bearer-token wrapper on tech). It must resolve
// to parsed JSON and throw on non-2xx — matching adminFetch's contract.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultApplicationMethodForLine, resolveRatePrefill } from '../lib/product-rate-prefill';

const PALETTES = {
  dark: {
    overlay: 'rgba(2,6,12,0.72)',
    bg: '#0f1923', card: '#1e293b', border: '#334155', chip: '#243244',
    accent: '#0ea5e9', accentText: '#fff', text: '#e2e8f0', muted: '#94a3b8',
    green: '#10b981', red: '#ef4444',
    headingFont: "'Montserrat', sans-serif", bodyFont: "'Nunito Sans', sans-serif",
  },
  light: {
    overlay: 'rgba(30,24,16,0.45)',
    bg: '#F7F3EC', card: '#FFFFFF', border: '#E7DFD2', chip: '#F2ECE1',
    accent: '#1F6F43', accentText: '#fff', text: '#2B2620', muted: '#857B6B',
    green: '#1F6F43', red: '#991B1B',
    headingFont: "'Source Serif 4', Georgia, serif", bodyFont: "'Inter', system-ui, sans-serif",
  },
};

// Timeline status -> { label, icon }. Only the events that matter to a
// recap; anything else falls through to a generic row.
const TIMELINE_LABELS = {
  en_route: { label: 'En route', icon: '🚐' },
  on_site: { label: 'Arrived on site', icon: '📍' },
  completed: { label: 'Completed', icon: '✅' },
  confirmed: { label: 'Confirmed', icon: '🗓️' },
  rescheduled: { label: 'Rescheduled', icon: '🔁' },
  cancelled: { label: 'Cancelled', icon: '🚫' },
  skipped: { label: 'Skipped', icon: '⏭️' },
};

// Catalog rate prefill for a selected product — the SHARED resolver
// CompletionPanel uses (lib/product-rate-prefill.js), so the same visit and
// product prefill the same rate on either completion path: verified per-1k
// rate first, then the pest 4-oz perimeter house default, then a per-basis
// display default's LOW bound in its label-native unit ("0.1 g/spot"). The
// recap path is server-gated to pest control, so the service line is fixed.
// The value is only a STARTING point: the tech edits/confirms it before
// submit, and only the submitted value is recorded.
function catalogRatePrefill(p, serviceType) {
  if (!p) return null;
  const applicationMethod = defaultApplicationMethodForLine(p, 'pest', { serviceType });
  const resolved = resolveRatePrefill(p, { applicationMethod, serviceLine: 'pest' });
  const rate = Number(resolved.rate);
  if (!Number.isFinite(rate) || rate <= 0 || !resolved.rateUnit) return null;
  return { rate: String(rate), unit: resolved.rateUnit };
}

function fmtTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    });
  } catch { return ''; }
}

export default function ServiceRecapModal({
  service,
  request,
  theme = 'dark',
  onClose,
  onCompleted,
}) {
  const P = PALETTES[theme] || PALETTES.dark;
  const serviceId = service?.id;
  const base = `/admin/dispatch/${serviceId}/pest-recap`;

  const [loading, setLoading] = useState(true);
  const [ctx, setCtx] = useState(null);
  const [loadError, setLoadError] = useState('');

  const [note, setNote] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  // productId -> { rate: string, unit: string }. Seeded from the rate
  // already recorded on the visit (reopen) or the catalog prefill
  // (fresh selection); the tech edits it before submit.
  const [rates, setRates] = useState(() => ({}));
  const [message, setMessage] = useState('');
  const [sendText, setSendText] = useState(true);

  const [drafting, setDrafting] = useState(false);
  // F2 (ratified Q13): windowed comms context on the AI draft — default CHECKED.
  const [includeComms, setIncludeComms] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Synchronous re-entrancy guard: a fast double-tap can fire handleSubmit
  // twice before `submitting` re-renders the disabled button. The server is
  // idempotent regardless, but this avoids the redundant second request.
  const submitInFlight = useRef(false);
  // True unless a context load failure means the checkbox list cannot
  // enumerate the recorded state at all — only then does the submission
  // drop authority (productsConfirmed) entirely (codex P1 r11/r13/r15).
  const selectionAuthoritative = useRef(true);
  // Recorded products that matched NO active catalog row (renamed or
  // deactivated since the visit). The submission stays authoritative and
  // names these for the server to PRESERVE — dropping authority for the
  // whole set would let a deselected VISIBLE product survive the partial
  // path (codex P1 r16).
  const unrepresentedProducts = useRef([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await request(`${base}/context`);
        if (!active) return;
        setCtx(data);
        if (data?.existingRecord?.technician_notes) setNote(data.existingRecord.technician_notes);
        // Pre-select chemicals already recorded on this visit, matched to the
        // catalog by name, so re-sending/editing a recap preserves them
        // instead of starting empty (which would wipe the product history).
        const recorded = data?.existingRecord?.products || [];
        // A failed recorded-products load means the picker cannot speak
        // for what was applied — fail closed, never authoritative
        // (codex P1 r13). Same for a failed service-record lookup (codex
        // P1 r15): "no record" reported over a transient error must not
        // authorize an empty replacement of a real completed visit.
        if (data?.existingRecord?.productsLoadFailed || data?.existingRecordLoadFailed) {
          selectionAuthoritative.current = false;
        }
        if (recorded.length && !Array.isArray(data?.products)) {
          selectionAuthoritative.current = false;
        }
        if (recorded.length && Array.isArray(data?.products)) {
          // Stable catalog id first (codex P2 r16: a rename between
          // visits must not read as a different product), name fallback
          // for rows recorded before product_id was captured.
          const byId = new Map(
            data.products.map((p) => [String(p.id), p]),
          );
          const byName = new Map(
            data.products.map((p) => [String(p.name || '').trim().toLowerCase(), p]),
          );
          const preselect = new Set();
          const seededRates = {};
          recorded.forEach((rp) => {
            const cat = (rp.product_id != null ? byId.get(String(rp.product_id)) : null)
              || byName.get(String(rp.product_name || '').trim().toLowerCase());
            if (!cat) {
              // Recorded product not representable in the picker — name
              // it for server-side preservation; the rest of the
              // selection stays authoritative.
              if (rp.product_name) unrepresentedProducts.current.push(rp.product_name);
              return;
            }
            preselect.add(cat.id);
            // The rate RECORDED on the visit outranks the catalog prefill —
            // reopening a recap must show (and re-submit) what was applied,
            // not rewrite it to the current catalog default.
            if (rp.application_rate != null && Number(rp.application_rate) > 0) {
              // A recorded rate missing its unit (legacy rows) falls back
              // to the catalog unit — an empty unit would hide the rate
              // editor while rate_confirmed still marked the field
              // deliberate, and the server would read that as a clear
              // (codex P1 r11).
              const unit = rp.rate_unit
                || catalogRatePrefill(cat, data?.service?.serviceType)?.unit
                || '';
              seededRates[cat.id] = { rate: String(rp.application_rate), unit };
            } else {
              const prefill = catalogRatePrefill(cat, data?.service?.serviceType);
              if (prefill) seededRates[cat.id] = prefill;
            }
          });
          if (preselect.size) {
            setSelected(preselect);
            setRates(seededRates);
          }
        }
        if (!data?.service?.hasPhone) setSendText(false);
      } catch (err) {
        if (active) setLoadError(err?.message || 'Failed to load recap');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [base, request]);

  const products = ctx?.products || [];
  const productById = useMemo(() => {
    const m = new Map();
    products.forEach((p) => m.set(p.id, p));
    return m;
  }, [products]);

  const toggleProduct = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Seed the editable rate on first selection only — a re-toggle
        // keeps whatever the tech already typed.
        setRates((prevRates) => {
          if (prevRates[id]) return prevRates;
          const prefill = catalogRatePrefill(productById.get(id), ctx?.service?.serviceType);
          return prefill ? { ...prevRates, [id]: prefill } : prevRates;
        });
      }
      return next;
    });
  }, [ctx, productById]);

  const setRateValue = useCallback((id, value) => {
    setRates((prev) => ({ ...prev, [id]: { ...(prev[id] || { unit: '' }), rate: value } }));
  }, []);

  const handleDraft = useCallback(async () => {
    setDrafting(true);
    setError('');
    try {
      const data = await request(`${base}/draft`, {
        method: 'POST',
        body: JSON.stringify({
          technicianNotes: note,
          // Tech-chosen solutions feed the AI recap prompt (owner directive
          // 2026-07-21) — context only, the prompt keeps product names out
          // of the customer copy.
          products: [...selected]
            .map((id) => productById.get(id))
            .filter(Boolean)
            .map((p) => ({ name: p.name, product_category: p.category })),
          includeCustomerComms: includeComms,
        }),
      });
      if (data?.recap) setMessage(data.recap);
    } catch (err) {
      setError(err?.message || 'Draft failed');
    } finally {
      setDrafting(false);
    }
  }, [base, note, includeComms, request, selected, productById]);

  const handleSubmit = useCallback(async () => {
    if (submitInFlight.current) return;
    const willSend = sendText && !!message.trim() && !!ctx?.service?.hasPhone;
    if (willSend) {
      const name = ctx?.service?.customerName || 'the customer';
       
      if (!window.confirm(`Text this recap to ${name}?\n\n${message.trim()}`)) return;
    }
    submitInFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      const productPayload = [...selected]
        .map((id) => productById.get(id))
        .filter(Boolean)
        .map((p) => {
          // Technician-confirmed rate from the editable field. Cleared or
          // unresolvable -> no rate submitted; rate_confirmed tells the
          // server the field state is deliberate (a cleared rate is an
          // edit, not a legacy client's omission — codex P1 r9), so the
          // server must NOT restore a previously recorded rate.
          const entry = rates[p.id];
          const rate = entry ? parseFloat(entry.rate) : NaN;
          const hasRate = Number.isFinite(rate) && rate > 0 && !!entry?.unit;
          return {
            // The selected catalog row's id, so the server records
            // service_products.product_id and the compliance ledger keys
            // on the exact product instead of a name-pattern match
            // (codex P1 r9: "Advion Cockroach Gel" vs "... Gel Bait").
            product_id: p.id,
            product_name: p.name,
            product_category: p.category,
            active_ingredient: p.active_ingredient,
            moa_group: p.moa_group,
            // Confirm the rate field only when it was actually shown (the
            // editor renders per-unit) or a rate is being sent — never
            // vouch for a field the technician couldn't see (codex P1
            // r11); unconfirmed omission keeps the server's
            // preserve-prior behavior.
            rate_confirmed: hasRate || !!entry?.unit,
            ...(hasRate ? { application_rate: rate, rate_unit: entry.unit } : {}),
          };
        });
      const result = await request(base, {
        method: 'POST',
        body: JSON.stringify({
          technicianNotes: note,
          products: productPayload,
          // The selection state is deliberate (recorded products are
          // pre-selected on open), so an empty set is a full deselection,
          // not a resend-only omission — unless the context load failed,
          // in which case the server keeps its preserve-on-omission
          // behavior (codex P1 r11). Recorded products the picker could
          // not represent are named for preservation instead of dropping
          // authority for the whole set (codex P1 r16).
          productsConfirmed: selectionAuthoritative.current,
          ...(selectionAuthoritative.current && unrepresentedProducts.current.length
            ? { productsPreserve: unrepresentedProducts.current }
            : {}),
          customerRecap: message,
          sendSms: willSend,
        }),
      });
      onCompleted?.(result);
    } catch (err) {
      setError(err?.message || 'Could not complete recap');
      setSubmitting(false);
      submitInFlight.current = false;
    }
  }, [base, ctx, message, note, onCompleted, productById, rates, request, selected, sendText]);

  const timeline = (ctx?.timeline || []).filter((t) => t.to_status !== 'pending');

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: P.overlay,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        fontFamily: P.bodyFont,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 520, maxHeight: '92vh', overflowY: 'auto',
          background: P.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18,
          border: `1px solid ${P.border}`, boxShadow: '0 -8px 40px rgba(0,0,0,0.35)',
        }}
      >
        {/* Header */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 1, background: P.bg,
          padding: '16px 18px 12px', borderBottom: `1px solid ${P.border}`,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
        }}>
          <div>
            <div style={{ fontFamily: P.headingFont, fontSize: 18, fontWeight: 700, color: P.text }}>
              Service Recap
            </div>
            <div style={{ fontSize: 13, color: P.muted, marginTop: 2 }}>
              {service?.customerName || ctx?.service?.customerName || 'Customer'}
              {service?.serviceType ? ` · ${service.serviceType}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              border: 'none', background: 'transparent', color: P.muted,
              fontSize: 24, lineHeight: 1, cursor: 'pointer', padding: 4,
            }}
          >×</button>
        </div>

        {loading ? (
          <div style={{ padding: 28, textAlign: 'center', color: P.muted, fontSize: 14 }}>Loading…</div>
        ) : loadError ? (
          <div style={{ padding: 24, color: P.red, fontSize: 14 }}>{loadError}</div>
        ) : (
          <div style={{ padding: '14px 18px 18px' }}>
            {/* Timeline */}
            {timeline.length > 0 && (
              <div style={{
                background: P.card, border: `1px solid ${P.border}`, borderRadius: 12,
                padding: '10px 12px', marginBottom: 14,
              }}>
                {timeline.map((t, i) => {
                  const meta = TIMELINE_LABELS[t.to_status] || { label: t.to_status, icon: '•' };
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '4px 0', fontSize: 13, color: P.text,
                    }}>
                      <span><span style={{ marginRight: 8 }}>{meta.icon}</span>{meta.label}</span>
                      <span style={{ color: P.muted, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(t.transitioned_at)}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Quick note */}
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: P.text, marginBottom: 6 }}>
              What did you do?
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Quick internal note — areas treated, what you found, anything for the next visit."
              rows={3}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                background: P.card, color: P.text, border: `1px solid ${P.border}`,
                borderRadius: 10, padding: '10px 12px', fontSize: 14, fontFamily: P.bodyFont,
                marginBottom: 16,
              }}
            />

            {/* Products */}
            <div style={{ fontSize: 13, fontWeight: 600, color: P.text, marginBottom: 8 }}>
              Products applied
            </div>
            {products.length === 0 ? (
              <div style={{ fontSize: 13, color: P.muted, marginBottom: 16 }}>No products in catalog.</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {products.map((p) => {
                  const on = selected.has(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleProduct(p.id)}
                      style={{
                        border: `1px solid ${on ? P.accent : P.border}`,
                        background: on ? P.accent : P.chip,
                        color: on ? P.accentText : P.text,
                        borderRadius: 999, padding: '6px 12px', fontSize: 13,
                        cursor: 'pointer', fontFamily: P.bodyFont,
                      }}
                    >
                      {on ? '✓ ' : ''}{p.name}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Application rates for the selected products — editable so the
                recorded rate is what the tech actually applied, not the
                catalog default it starts from. Products with no known unit
                (no catalog default, nothing recorded) record no rate. */}
            {[...selected].some((id) => rates[id]?.unit) && (
              <div style={{
                background: P.card, border: `1px solid ${P.border}`, borderRadius: 12,
                padding: '10px 12px', marginBottom: 16,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: P.muted, marginBottom: 6 }}>
                  Application rates (adjust to what you applied)
                </div>
                {[...selected]
                  .map((id) => ({ id, p: productById.get(id), entry: rates[id] }))
                  .filter((row) => row.p && row.entry?.unit)
                  .map(({ id, p, entry }) => (
                    <div key={id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '4px 0', fontSize: 13, color: P.text,
                    }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        value={entry.rate}
                        onChange={(e) => setRateValue(id, e.target.value)}
                        aria-label={`Application rate for ${p.name}`}
                        style={{
                          width: 72, boxSizing: 'border-box', textAlign: 'right',
                          background: P.bg, color: P.text, border: `1px solid ${P.border}`,
                          borderRadius: 8, padding: '5px 8px', fontSize: 13, fontFamily: P.bodyFont,
                        }}
                      />
                      <span style={{ color: P.muted, fontSize: 12, minWidth: 56 }}>{entry.unit}</span>
                    </div>
                  ))}
              </div>
            )}

            {/* Customer message */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6,
            }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: P.text }}>Message to customer</label>
              <button
                type="button"
                onClick={handleDraft}
                disabled={drafting}
                style={{
                  border: `1px solid ${P.accent}`, background: 'transparent', color: P.accent,
                  borderRadius: 8, padding: '4px 10px', fontSize: 12, fontWeight: 600,
                  cursor: drafting ? 'default' : 'pointer', opacity: drafting ? 0.6 : 1,
                }}
              >
                {drafting ? 'Drafting…' : '✨ Draft with AI'}
              </button>
            </div>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
              color: P.muted, cursor: 'pointer', marginBottom: 6,
            }}>
              <input
                type="checkbox"
                checked={includeComms}
                onChange={(e) => setIncludeComms(e.target.checked)}
                style={{ width: 15, height: 15 }}
              />
              Include recent customer calls/texts/emails
            </label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="The recap your customer receives. Tap “Draft with AI” to generate from your note, then edit."
              rows={4}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                background: P.card, color: P.text, border: `1px solid ${P.border}`,
                borderRadius: 10, padding: '10px 12px', fontSize: 14, fontFamily: P.bodyFont,
                marginBottom: 12,
              }}
            />

            {/* Send toggle */}
            <label style={{
              display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: P.text,
              opacity: ctx?.service?.hasPhone ? 1 : 0.55, marginBottom: 4,
            }}>
              <input
                type="checkbox"
                checked={sendText && !!ctx?.service?.hasPhone}
                disabled={!ctx?.service?.hasPhone}
                onChange={(e) => setSendText(e.target.checked)}
              />
              Text this recap to the customer
            </label>
            {!ctx?.service?.hasPhone && (
              <div style={{ fontSize: 12, color: P.muted, marginBottom: 4 }}>
                No mobile number on file — recap will be saved without texting.
              </div>
            )}

            {error && (
              <div style={{ color: P.red, fontSize: 13, marginTop: 10 }}>{error}</div>
            )}

            {/* Footer */}
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                style={{
                  flex: '0 0 auto', border: `1px solid ${P.border}`, background: 'transparent',
                  color: P.text, borderRadius: 10, padding: '12px 18px', fontSize: 14,
                  cursor: 'pointer', fontFamily: P.bodyFont,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                style={{
                  flex: 1, border: 'none', background: P.green, color: '#fff',
                  borderRadius: 10, padding: '12px 18px', fontSize: 15, fontWeight: 700,
                  cursor: submitting ? 'default' : 'pointer', opacity: submitting ? 0.7 : 1,
                  fontFamily: P.bodyFont,
                }}
              >
                {submitting
                  ? 'Saving…'
                  : (sendText && !!message.trim() && !!ctx?.service?.hasPhone)
                    ? 'Complete & Send'
                    : 'Complete Service'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
