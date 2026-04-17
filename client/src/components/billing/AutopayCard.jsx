import React, { useEffect, useState } from 'react';
import { COLORS as B, FONTS } from '../../theme-brand';
import api from '../../utils/api';

/**
 * AutopayCard — customer-facing autopay transparency + controls.
 *
 * 3 visual states: active (green), paused (amber), disabled (neutral).
 * Controls: toggle on/off, pause until date, change card, change billing day.
 */
export default function AutopayCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(null); // 'pause' | 'card' | 'day' | null
  const [pauseUntil, setPauseUntil] = useState('');
  const [pauseReason, setPauseReason] = useState('');
  const [selectedCard, setSelectedCard] = useState('');
  const [selectedDay, setSelectedDay] = useState(1);

  const load = () =>
    api.getAutopay()
      .then((d) => { setData(d); setSelectedCard(d.autopay_payment_method_id || ''); setSelectedDay(d.billing_day || 1); })
      .catch((e) => setErr(e.message || 'Failed to load autopay'))
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  if (loading) return null;
  if (!data) return null;

  const { state, next_charge_date, monthly_rate, payment_methods = [], paused_until } = data;
  const activeCard = payment_methods.find((p) => p.id === data.autopay_payment_method_id)
    || payment_methods.find((p) => p.is_default)
    || payment_methods[0];

  const theme = {
    active: { bg: '#E8F5E9', border: '#C8E6C9', dot: B.green, label: 'Active' },
    paused: { bg: '#FFF8E1', border: '#FFE082', dot: B.orange, label: 'Paused' },
    disabled: { bg: B.offWhite || '#F5F5F5', border: B.grayLight, dot: B.grayMid, label: 'Disabled' },
  }[state];

  const formatDate = (s) => {
    if (!s) return '—';
    const d = new Date(s);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const runUpdate = async (patch) => {
    setSaving(true); setErr('');
    try {
      await api.updateAutopay(patch);
      await load();
      setModal(null);
    } catch (e) {
      setErr(e.message || 'Update failed');
    }
    setSaving(false);
  };

  const toggleAutopay = () => runUpdate({ autopay_enabled: !data.autopay_enabled });

  const submitPause = async () => {
    if (!pauseUntil) { setErr('Pick a date'); return; }
    setSaving(true); setErr('');
    try {
      await api.pauseAutopay(pauseUntil, pauseReason || null);
      await load();
      setModal(null); setPauseUntil(''); setPauseReason('');
    } catch (e) { setErr(e.message || 'Pause failed'); }
    setSaving(false);
  };

  const submitResume = async () => {
    setSaving(true); setErr('');
    try { await api.resumeAutopay(); await load(); } catch (e) { setErr(e.message || 'Resume failed'); }
    setSaving(false);
  };

  const card = {
    background: theme.bg, border: `1px solid ${theme.border}`, borderRadius: 14,
    padding: 18, display: 'flex', flexDirection: 'column', gap: 14,
    fontFamily: FONTS.body,
  };

  const btn = (kind = 'primary') => ({
    padding: '10px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
    cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
    fontFamily: FONTS.heading,
    border: kind === 'primary' ? 'none' : `1px solid ${B.grayLight}`,
    background: kind === 'primary' ? B.wavesBlue : '#fff',
    color: kind === 'primary' ? '#fff' : B.grayDark,
  });

  return (
    <div style={card}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: theme.dot, display: 'inline-block' }} />
            <span style={{ fontSize: 12, fontWeight: 700, color: B.grayMid, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Auto-Pay · {theme.label}
            </span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: B.grayDark, fontFamily: FONTS.heading }}>
            {state === 'active'
              ? `Next charge: $${Number(monthly_rate || 0).toFixed(2)} on ${formatDate(next_charge_date)}`
              : state === 'paused'
                ? `Paused until ${formatDate(paused_until)}`
                : 'Auto-pay is off — charges will not run automatically'}
          </div>
          {activeCard && state !== 'disabled' && (
            <div style={{ fontSize: 13, color: B.grayMid, marginTop: 4 }}>
              Charging {activeCard.brand || 'card'} ending in {activeCard.last4}
            </div>
          )}
        </div>
      </div>

      {err && <div style={{ color: B.red, fontSize: 13 }}>{err}</div>}

      {/* Actions row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {state === 'active' && (
          <>
            <button style={btn('secondary')} disabled={saving} onClick={() => setModal('pause')}>Pause</button>
            <button style={btn('secondary')} disabled={saving} onClick={() => setModal('card')}>Change card</button>
            <button style={btn('secondary')} disabled={saving} onClick={() => setModal('day')}>Change billing day</button>
            <button style={btn('secondary')} disabled={saving} onClick={toggleAutopay}>Turn off</button>
          </>
        )}
        {state === 'paused' && (
          <>
            <button style={btn('primary')} disabled={saving} onClick={submitResume}>Resume now</button>
            <button style={btn('secondary')} disabled={saving} onClick={toggleAutopay}>Turn off</button>
          </>
        )}
        {state === 'disabled' && (
          <button style={btn('primary')} disabled={saving} onClick={toggleAutopay}>Turn on auto-pay</button>
        )}
      </div>

      {modal && (
        <Modal title={
          modal === 'pause' ? 'Pause auto-pay' :
          modal === 'card' ? 'Change auto-pay card' :
          'Change billing day'
        } onClose={() => { setModal(null); setErr(''); }}>
          {modal === 'pause' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ fontSize: 13, color: B.grayDark, fontWeight: 600 }}>Pause until</label>
              <input type="date" value={pauseUntil} onChange={(e) => setPauseUntil(e.target.value)}
                min={new Date(Date.now() + 86400000).toISOString().split('T')[0]}
                style={{ padding: 10, fontSize: 14, border: `1px solid ${B.grayLight}`, borderRadius: 8 }} />
              <label style={{ fontSize: 13, color: B.grayDark, fontWeight: 600 }}>Reason (optional)</label>
              <textarea value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} rows={2}
                placeholder="e.g. Out of town for the month"
                style={{ padding: 10, fontSize: 14, border: `1px solid ${B.grayLight}`, borderRadius: 8, fontFamily: FONTS.body }} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button style={btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                <button style={btn('primary')} disabled={saving || !pauseUntil} onClick={submitPause}>
                  {saving ? 'Saving…' : 'Pause'}
                </button>
              </div>
            </div>
          )}

          {modal === 'card' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {payment_methods.length === 0 ? (
                <div style={{ fontSize: 13, color: B.grayMid }}>No cards on file. Add one below in Payment Methods.</div>
              ) : (
                payment_methods.map((pm) => (
                  <label key={pm.id} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: 12,
                    border: `1px solid ${selectedCard === pm.id ? B.wavesBlue : B.grayLight}`,
                    background: selectedCard === pm.id ? `${B.wavesBlue}10` : '#fff',
                    borderRadius: 8, cursor: 'pointer',
                  }}>
                    <input type="radio" name="autopay-card" checked={selectedCard === pm.id}
                      onChange={() => setSelectedCard(pm.id)} />
                    <span style={{ fontSize: 14, color: B.grayDark }}>
                      {pm.brand || 'Card'} •••• {pm.last4}
                      {pm.exp_month && pm.exp_year ? ` · exp ${String(pm.exp_month).padStart(2, '0')}/${String(pm.exp_year).slice(-2)}` : ''}
                    </span>
                  </label>
                ))
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button style={btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                <button style={btn('primary')} disabled={saving || !selectedCard}
                  onClick={() => runUpdate({ autopay_payment_method_id: selectedCard })}>
                  {saving ? 'Saving…' : 'Use this card'}
                </button>
              </div>
            </div>
          )}

          {modal === 'day' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ fontSize: 13, color: B.grayDark, fontWeight: 600 }}>Charge day of month (1–28)</label>
              <input type="number" min={1} max={28} value={selectedDay}
                onChange={(e) => setSelectedDay(parseInt(e.target.value) || 1)}
                style={{ padding: 10, fontSize: 14, border: `1px solid ${B.grayLight}`, borderRadius: 8 }} />
              <div style={{ fontSize: 12, color: B.grayMid }}>
                Auto-pay runs on this day each month. Max is the 28th so every month is covered.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button style={btn('secondary')} onClick={() => setModal(null)}>Cancel</button>
                <button style={btn('primary')} disabled={saving || selectedDay < 1 || selectedDay > 28}
                  onClick={() => runUpdate({ billing_day: selectedDay })}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#fff', borderRadius: 14, padding: 20, maxWidth: 440, width: '100%',
        display: 'flex', flexDirection: 'column', gap: 14, fontFamily: FONTS.body,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: B.grayDark, fontFamily: FONTS.heading }}>{title}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: B.grayMid }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
