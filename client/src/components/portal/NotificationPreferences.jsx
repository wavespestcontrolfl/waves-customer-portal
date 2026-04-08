import React, { useState, useEffect } from 'react';

const NOTIFICATION_TYPES = [
  { key: 'serviceReminder24h', channelKey: 'serviceReminderChannel', label: 'Service Reminders', desc: '24-hour advance notice before appointments' },
  { key: 'techEnRoute', channelKey: 'enRouteChannel', label: 'Tech En Route', desc: 'Alert when your technician is on the way' },
  { key: 'serviceCompleted', channelKey: 'serviceCompleteChannel', label: 'Service Complete', desc: 'Summary after each service visit' },
  { key: 'paymentReceipt', channelKey: 'paymentReceiptChannel', label: 'Payment Receipts', desc: 'Confirmation when payments are processed' },
  { key: 'billingAlerts', channelKey: 'billingChannel', label: 'Billing Alerts', desc: 'Invoice and billing notifications' },
  { key: 'reviewRequest', channelKey: 'reviewRequestChannel', label: 'Review Requests', desc: 'Invitation to leave feedback after service' },
  { key: 'referralNudge', channelKey: 'referralChannel', label: 'Referral Program', desc: 'Referral rewards and program updates' },
  { key: 'seasonalTips', channelKey: 'seasonalChannel', label: 'Seasonal Tips', desc: 'Lawn and pest care tips for the season' },
  { key: 'weatherAlerts', channelKey: 'weatherAlertChannel', label: 'Weather Alerts', desc: 'Service changes due to weather' },
  { key: 'marketingOffers', channelKey: 'marketingChannel', label: 'Promotions & Offers', desc: 'Special deals and new services' },
];

const CHANNEL_OPTIONS = [
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
  { value: 'both', label: 'Both' },
];

export default function NotificationPreferences({ customerId, token }) {
  const [prefs, setPrefs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/notification-prefs', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => { setPrefs(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token]);

  const update = (key, value) => {
    setPrefs(p => ({ ...p, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    try {
      await fetch('/api/notification-prefs', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      });
      setSaved(true);
    } catch (e) { console.error(e); }
    setSaving(false);
  };

  if (loading) return <div style={{ padding: 20, color: '#666' }}>Loading preferences...</div>;
  if (!prefs) return <div style={{ padding: 20, color: '#999' }}>Unable to load preferences</div>;

  const cardStyle = {
    background: '#fff', borderRadius: 12, padding: 20, marginBottom: 16,
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)', border: '1px solid #e8e8e8',
  };

  const toggleStyle = (on) => ({
    width: 44, height: 24, borderRadius: 12, cursor: 'pointer', position: 'relative',
    background: on ? '#0b7a6f' : '#ccc', transition: 'background 0.2s', border: 'none', padding: 0,
  });

  const toggleDot = (on) => ({
    width: 20, height: 20, borderRadius: 10, background: '#fff', position: 'absolute', top: 2,
    left: on ? 22 : 2, transition: 'left 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
  });

  const selectStyle = {
    padding: '4px 8px', borderRadius: 6, border: '1px solid #ddd', fontSize: 13,
    background: '#f9f9f9', color: '#333', cursor: 'pointer',
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <h3 style={{ fontSize: 18, fontWeight: 700, color: '#1a1a2e', marginBottom: 4 }}>Notification Preferences</h3>
      <p style={{ color: '#888', fontSize: 14, marginBottom: 20 }}>Choose how and when you hear from us.</p>

      {/* Notification types */}
      <div style={cardStyle}>
        {NOTIFICATION_TYPES.map((nt, i) => (
          <div key={nt.key} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 0', borderBottom: i < NOTIFICATION_TYPES.length - 1 ? '1px solid #f0f0f0' : 'none',
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#1a1a2e' }}>{nt.label}</div>
              <div style={{ color: '#999', fontSize: 12, marginTop: 2 }}>{nt.desc}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <select
                value={prefs[nt.channelKey] || 'sms'}
                onChange={e => update(nt.channelKey, e.target.value)}
                style={{ ...selectStyle, opacity: prefs[nt.key] ? 1 : 0.4 }}
                disabled={!prefs[nt.key]}
              >
                {CHANNEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button
                style={toggleStyle(prefs[nt.key])}
                onClick={() => update(nt.key, !prefs[nt.key])}
                aria-label={`Toggle ${nt.label}`}
              >
                <div style={toggleDot(prefs[nt.key])} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Quiet hours */}
      <div style={cardStyle}>
        <h4 style={{ fontSize: 15, fontWeight: 600, color: '#1a1a2e', marginBottom: 8 }}>Quiet Hours</h4>
        <p style={{ color: '#999', fontSize: 12, marginBottom: 12 }}>
          We will not send notifications during these hours.
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13, color: '#555' }}>
            From
            <input type="time" value={prefs.quietHoursStart || ''}
              onChange={e => update('quietHoursStart', e.target.value)}
              style={{ ...selectStyle, marginLeft: 8 }} />
          </label>
          <label style={{ fontSize: 13, color: '#555' }}>
            To
            <input type="time" value={prefs.quietHoursEnd || ''}
              onChange={e => update('quietHoursEnd', e.target.value)}
              style={{ ...selectStyle, marginLeft: 8 }} />
          </label>
          {(prefs.quietHoursStart || prefs.quietHoursEnd) && (
            <button onClick={() => { update('quietHoursStart', null); update('quietHoursEnd', null); }}
              style={{ background: 'none', border: 'none', color: '#e53935', cursor: 'pointer', fontSize: 12 }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Save button */}
      <button onClick={save} disabled={saving}
        style={{
          background: saved ? '#4caf50' : '#0b7a6f', color: '#fff', border: 'none', borderRadius: 8,
          padding: '12px 32px', fontSize: 15, fontWeight: 600, cursor: saving ? 'wait' : 'pointer',
          width: '100%', transition: 'background 0.2s',
        }}>
        {saving ? 'Saving...' : saved ? 'Saved' : 'Save Preferences'}
      </button>
    </div>
  );
}
