// client/src/components/admin/PushSettingsV2.jsx
// Monochrome V2 of PushSettings (Notifications tab). Strict 1:1 on endpoints + behavior:
//   GET  /admin/push/preferences
//   PUT  /admin/push/preferences   { preferences }
// Plus device push enable/disable + test via shared helpers in lib/push-subscribe.
// alert-fg reserved for priority=urgent dot, push-error banner, and Disable button.
import { useState, useEffect } from 'react';
import { Badge, Button, Card, CardBody, Switch, cn } from '../../components/ui';
import {
  ensurePushSubscription, disablePush, isPushEnabled, sendTestPush,
} from '../../lib/push-subscribe.js';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const PRIORITY_CLASS = {
  urgent: 'bg-alert-fg',
  high: 'bg-zinc-700',
  normal: 'bg-zinc-500',
  low: 'bg-zinc-300',
};

export default function PushSettingsV2() {
  const [pushOn, setPushOn] = useState(false);
  const [prefs, setPrefs] = useState([]);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [pushError, setPushError] = useState('');

  useEffect(() => {
    isPushEnabled().then(setPushOn);
    adminFetch('/admin/push/preferences')
      .then((r) => setPrefs(r.preferences || []))
      .catch(() => setPrefs([]));
  }, []);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2500); };

  const togglePush = async () => {
    setBusy(true);
    setPushError('');
    try {
      if (pushOn) { await disablePush(); setPushOn(false); showToast('Push disabled on this device'); }
      else { await ensurePushSubscription(); setPushOn(true); showToast('Push enabled on this device'); }
    } catch (e) {
      setPushError(e.message || 'Failed to enable push notifications');
    } finally {
      setBusy(false);
    }
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
    try { await sendTestPush(); showToast('Test notification sent'); }
    catch (e) { alert(e.message); }
  };

  const groups = prefs.reduce((acc, p) => {
    (acc[p.group] = acc[p.group] || []).push(p);
    return acc;
  }, {});

  return (
    <Card id="notifications">
      <CardBody>
        {/* Header */}
        <div className="flex justify-between items-start mb-4 gap-3 flex-wrap">
          <div>
            <div className="text-16 font-medium text-ink-primary">Notifications</div>
            <div className="text-12 text-ink-tertiary mt-1">
              Choose how you'd like to be alerted for each event type.
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={test}>Send test</Button>
            <Button variant="primary" size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>

        {/* Device push card */}
        <div className="p-3 mb-4 bg-zinc-50 border-hairline rounded-md flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-13 font-medium text-ink-primary">Push notifications on this device</div>
            <div className="text-12 text-ink-tertiary mt-1">
              {pushOn
                ? "Active. You'll receive native OS notifications when this tab is closed."
                : 'Not enabled. Click to allow notifications in your browser.'}
            </div>
          </div>
          <Button
            variant={pushOn ? 'danger' : 'primary'}
            size="sm"
            onClick={togglePush}
            disabled={busy}
            className="min-w-[96px]"
          >
            {busy ? '…' : pushOn ? 'Disable' : 'Enable'}
          </Button>
        </div>

        {/* Push error */}
        {pushError && (
          <div className="p-3 mb-4 bg-alert-bg border-hairline border-alert-fg rounded-md flex items-start gap-2.5">
            <div className="flex-1 text-13 text-alert-fg leading-relaxed">{pushError}</div>
            <button
              type="button"
              onClick={() => setPushError('')}
              className="text-alert-fg hover:text-ink-primary text-16 leading-none"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {/* Column headers */}
        <div className="grid grid-cols-[1fr_48px_48px_48px] md:grid-cols-[1fr_60px_60px_60px] gap-2 md:gap-3 px-3 py-2 text-11 uppercase tracking-label text-ink-tertiary">
          <div>Event</div>
          <div className="text-center">Push</div>
          <div className="text-center">Bell</div>
          <div className="text-center">Sound</div>
        </div>

        {Object.entries(groups).map(([group, list]) => (
          <div key={group} className="mb-3">
            <div className="px-3 py-1.5 text-11 uppercase tracking-label text-ink-tertiary font-medium">
              {group}
            </div>
            <div className="bg-white border-hairline rounded-md overflow-hidden">
              {list.map((p, i) => (
                <div
                  key={p.key}
                  className={cn(
                    'grid grid-cols-[1fr_48px_48px_48px] md:grid-cols-[1fr_60px_60px_60px] gap-2 md:gap-3 p-3 items-center min-h-[44px]',
                    i > 0 && 'border-t border-zinc-200',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', PRIORITY_CLASS[p.priority] || 'bg-zinc-400')} />
                    <span className="text-13 text-ink-secondary">{p.label}</span>
                  </div>
                  <div className="flex justify-center">
                    <Switch checked={!!p.push_enabled} onChange={(v) => updatePref(p.key, 'push_enabled', v)} />
                  </div>
                  <div className="flex justify-center">
                    <Switch checked={!!p.bell_enabled} onChange={(v) => updatePref(p.key, 'bell_enabled', v)} />
                  </div>
                  <div className="flex justify-center">
                    <Switch checked={!!p.sound_enabled} onChange={(v) => updatePref(p.key, 'sound_enabled', v)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {toast && (
          <div className="fixed bottom-6 right-6 px-4 py-2.5 bg-zinc-900 text-white rounded-md text-13 font-medium shadow-lg z-[300]">
            {toast}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
