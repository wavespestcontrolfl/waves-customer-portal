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
  const [message, setMessage] = useState('');
  const [sendText, setSendText] = useState(true);

  const [drafting, setDrafting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Synchronous re-entrancy guard: a fast double-tap can fire handleSubmit
  // twice before `submitting` re-renders the disabled button. The server is
  // idempotent regardless, but this avoids the redundant second request.
  const submitInFlight = useRef(false);

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
        if (recorded.length && Array.isArray(data?.products)) {
          const idByName = new Map(
            data.products.map((p) => [String(p.name || '').trim().toLowerCase(), p.id]),
          );
          const preselect = new Set();
          recorded.forEach((rp) => {
            const id = idByName.get(String(rp.product_name || '').trim().toLowerCase());
            if (id != null) preselect.add(id);
          });
          if (preselect.size) setSelected(preselect);
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
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleDraft = useCallback(async () => {
    setDrafting(true);
    setError('');
    try {
      const data = await request(`${base}/draft`, {
        method: 'POST',
        body: JSON.stringify({ technicianNotes: note }),
      });
      if (data?.recap) setMessage(data.recap);
    } catch (err) {
      setError(err?.message || 'Draft failed');
    } finally {
      setDrafting(false);
    }
  }, [base, note, request]);

  const handleSubmit = useCallback(async () => {
    if (submitInFlight.current) return;
    const willSend = sendText && !!message.trim() && !!ctx?.service?.hasPhone;
    if (willSend) {
      const name = ctx?.service?.customerName || 'the customer';
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Text this recap to ${name}?\n\n${message.trim()}`)) return;
    }
    submitInFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      const productPayload = [...selected]
        .map((id) => productById.get(id))
        .filter(Boolean)
        .map((p) => ({
          product_name: p.name,
          product_category: p.category,
          active_ingredient: p.active_ingredient,
          moa_group: p.moa_group,
        }));
      const result = await request(base, {
        method: 'POST',
        body: JSON.stringify({
          technicianNotes: note,
          products: productPayload,
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
  }, [base, ctx, message, note, onCompleted, productById, request, selected, sendText]);

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
