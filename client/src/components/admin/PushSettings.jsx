import { useState, useEffect } from 'react';
import { ensurePushSubscription, disablePush, isPushEnabled, sendTestPush } from '../../lib/push-subscribe.js';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = {
  bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0', input: '#FFFFFF',
  teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B',
  text: '#334155', muted: '#64748B', white: '#fff',
};

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function Toggle({ on, onChange, color = D.teal }) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        width: 36, height: 20, borderRadius: 10, padding: 2, border: 'none',
        background: on ? color : D.border, cursor: 'pointer', position: 'relative', transition: 'background 120ms',
      }}
    >
      <span style={{
        display: 'block', width: 16, height: 16, borderRadius: 8, background: D.white,
        transform: on ? 'translateX(16px)' : 'translateX(0)', transition: 'transform 120ms',
      }} />
    </button>
  );
}

const PRIORITY_COLOR = { urgent: D.red, high: D.amber, normal: D.teal, low: D.muted };

export default function PushSettings() {
  const [pushOn, setPushOn] = useState(false);
  const [prefs, setPrefs] = useState([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [pushError, setPushError] = useState('');

  useEffect(() => {
    isPushEnabled({ apiBase: API_BASE, verifyServer: true }).then(setPushOn);
    adminFetch('/admin/push/preferences')
      .then((r) => setPrefs(r.preferences || []))
      .catch(() => setPrefs([]));
  }, []);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2500); };

  const togglePush = async () => {
    setBusy(true);
    setPushError('');
    try {
      if (pushOn) { await disablePush({ apiBase: API_BASE }); setPushOn(false); showToast('Push disabled on this device'); }
      else { await ensurePushSubscription({ apiBase: API_BASE }); setPushOn(true); showToast('Push enabled on this device'); }
    } catch (e) { setPushError(e.message || 'Failed to enable push notifications'); }
    finally { setBusy(false); }
  };

  const updatePref = (key, field, value) => {
    setPrefs((cur) => cur.map((p) => (p.key === key ? { ...p, [field]: value } : p)));
  };

  const save = async () => {
    setSaving(true);
    try {
      await adminFetch('/admin/push/preferences', {
        method: 'PUT',
        body: JSON.stringify({ preferences: prefs }),
      });
      showToast('Preferences saved');
    } catch (e) { alert('Save failed: ' + e.message); }
    finally { setSaving(false); }
  };

  const test = async () => {
    try {
      const result = await sendTestPush({ apiBase: API_BASE });
      showToast(result.sent ? 'Test notification sent' : 'No active device subscription');
    }
    catch (e) { alert(e.message); }
  };

  // Group by .group
  const groups = prefs.reduce((acc, p) => {
    (acc[p.group] = acc[p.group] || []).push(p);
    return acc;
  }, {});

  return (
    <div id="notifications" style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>Notifications</div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
            Choose how you'd like to be alerted for each event type.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={test}
            style={{ padding: '8px 14px', background: 'transparent', border: `1px solid ${D.border}`, color: D.text, borderRadius: 8, fontSize: 13, cursor: 'pointer' }}
          >
            Send test
          </button>
          <button
            onClick={save}
            disabled={saving}
            style={{ padding: '8px 14px', background: D.teal, border: 'none', color: D.white, borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Push subscription card */}
      <div style={{
        padding: 14, marginBottom: 18, background: D.input, border: `1px solid ${D.border}`, borderRadius: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <div style={{ color: '#0F172A', fontSize: 14, fontWeight: 600 }}>
            📱 Push notifications on this device
          </div>
          <div style={{ color: D.muted, fontSize: 12, marginTop: 4 }}>
            {pushOn
              ? 'Active. You\'ll receive native OS notifications when this tab is closed.'
              : 'Not enabled. Click to allow notifications in your browser.'}
          </div>
        </div>
        <button
          onClick={togglePush}
          disabled={busy}
          style={{
            padding: '8px 16px', background: pushOn ? D.red : D.green, color: D.white, border: 'none',
            borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', minWidth: 96,
          }}
        >
          {busy ? '…' : pushOn ? 'Disable' : 'Enable'}
        </button>
      </div>

      {pushError && (
        <div style={{
          padding: 12, marginBottom: 18, background: '#FDECEA', border: `1px solid ${D.red}44`,
          borderRadius: 8, color: D.red, fontSize: 13, lineHeight: 1.5,
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>⚠️</span>
          <div style={{ flex: 1 }}>{pushError}</div>
          <button
            onClick={() => setPushError('')}
            style={{ background: 'none', border: 'none', color: D.red, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
            title="Dismiss"
          >×</button>
        </div>
      )}

      {/* Header row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 60px 60px 60px', gap: 12, padding: '8px 12px', fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        <div>Event</div>
        <div style={{ textAlign: 'center' }}>Push</div>
        <div style={{ textAlign: 'center' }}>Bell</div>
        <div style={{ textAlign: 'center' }}>Sound</div>
      </div>

      {Object.entries(groups).map(([group, list]) => (
        <div key={group} style={{ marginBottom: 12 }}>
          <div style={{
            padding: '6px 12px', fontSize: 11, color: D.muted, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: 0.6,
          }}>
            {group}
          </div>
          <div style={{ background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, overflow: 'hidden' }}>
            {list.map((p, i) => (
              <div
                key={p.key}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 60px 60px 60px', gap: 12, padding: '12px',
                  alignItems: 'center', borderTop: i === 0 ? 'none' : `1px solid ${D.border}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 3, background: PRIORITY_COLOR[p.priority] }} />
                  <span style={{ color: D.text, fontSize: 13 }}>{p.label}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <Toggle on={p.push_enabled} onChange={(v) => updatePref(p.key, 'push_enabled', v)} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <Toggle on={p.bell_enabled} onChange={(v) => updatePref(p.key, 'bell_enabled', v)} color={D.green} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <Toggle on={p.sound_enabled} onChange={(v) => updatePref(p.key, 'sound_enabled', v)} color={D.amber} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, padding: '10px 16px', background: D.green,
          color: D.white, borderRadius: 8, fontSize: 13, fontWeight: 600, boxShadow: '0 8px 20px rgba(0,0,0,0.15)',
        }}>{toast}</div>
      )}
    </div>
  );
}
