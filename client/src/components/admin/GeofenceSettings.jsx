/**
 * Geofence Timers settings panel — mode / radius / cooldown / auto-complete
 * plus the tech ↔ Bouncie IMEI mapping table and an event log.
 *
 * Mounted as a tab on SettingsPage. Light theme (BRAND palette).
 */
import { useEffect, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = {
  bg: '#F1F5F9', card: '#FFFFFF', border: '#E2E8F0',
  teal: '#0A7EC2', green: '#16A34A', amber: '#F0A500', red: '#C0392B',
  text: '#334155', muted: '#64748B', white: '#FFFFFF', heading: '#0F172A',
};
const MONO = "'JetBrains Mono', monospace";

function token() { return localStorage.getItem('waves_admin_token') || localStorage.getItem('adminToken'); }
function api(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e))));
}

const ACTION_COLORS = {
  timer_started: D.green,
  timer_stopped: D.teal,
  reminder_sent: D.amber,
  ignored_duplicate: D.muted,
  no_customer_match: D.muted,
  no_active_timer: D.muted,
  unknown_vehicle: D.red,
  timer_already_running: D.amber,
  dismissed: D.muted,
};

export default function GeofenceSettings() {
  const [settings, setSettings] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [events, setEvents] = useState([]);
  const [saving, setSaving] = useState(false);
  const [editingTech, setEditingTech] = useState(null);
  const [imeiInput, setImeiInput] = useState('');
  const [vinInput, setVinInput] = useState('');
  const [vehNameInput, setVehNameInput] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const [s, v, e] = await Promise.all([
        api('/admin/geofence/settings'),
        api('/admin/geofence/vehicles'),
        api('/admin/geofence/events?limit=50'),
      ]);
      setSettings(s);
      setVehicles(v.technicians || []);
      setEvents(e.events || []);
    } catch (err) {
      console.error('[geofence-settings] load failed', err);
    }
  }

  async function saveSettings(partial) {
    setSaving(true);
    const next = { ...settings, ...partial };
    setSettings(next);
    try {
      await api('/admin/geofence/settings', { method: 'PUT', body: JSON.stringify(next) });
    } catch (err) {
      alert('Save failed: ' + (err.error || String(err)));
    } finally {
      setSaving(false);
    }
  }

  function startEditVehicle(tech) {
    setEditingTech(tech.id);
    setImeiInput(tech.bouncie_imei || '');
    setVinInput(tech.bouncie_vin || '');
    setVehNameInput(tech.vehicle_name || '');
  }

  async function saveVehicle(techId) {
    try {
      await api(`/admin/geofence/vehicles/${techId}`, {
        method: 'PUT',
        body: JSON.stringify({ bouncie_imei: imeiInput.trim(), bouncie_vin: vinInput.trim(), vehicle_name: vehNameInput.trim() }),
      });
      setEditingTech(null);
      await load();
    } catch (err) {
      alert(err.error || 'Save failed');
    }
  }

  if (!settings) return <div style={{ color: D.muted, padding: 24 }}>Loading geofence settings…</div>;

  const hasMapping = vehicles.some((t) => t.bouncie_imei);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!hasMapping && (
        <Card style={{ borderLeft: `4px solid ${D.amber}` }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>Connect your Bouncie devices</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 4 }}>
            Geofence auto-timers need at least one tech mapped to a Bouncie IMEI. Add a mapping below to enable.
          </div>
        </Card>
      )}

      {/* ── MODE ── */}
      <Card>
        <SectionTitle>Timer Mode</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <ModeOption
            active={settings.mode === 'reminder'}
            onClick={() => saveSettings({ mode: 'reminder' })}
            title="Reminder"
            body="Tech gets a prompt on arrival and confirms with one tap. Safer in dense neighborhoods."
          />
          <ModeOption
            active={settings.mode === 'automatic'}
            onClick={() => saveSettings({ mode: 'automatic' })}
            title="Automatic"
            body="Timer starts and stops automatically on van enter/exit. No tech interaction."
          />
        </div>
      </Card>

      {/* ── RADIUS / COOLDOWN / AUTO-COMPLETE ── */}
      <Card>
        <SectionTitle>Matching Rules</SectionTitle>
        <NumberField
          label="Match radius"
          suffix="meters"
          value={settings.radius_meters}
          min={100} max={500} step={25}
          onChange={(v) => saveSettings({ radius_meters: v })}
          help="How close the vehicle needs to be to the customer's address. Larger = triggers earlier but may false-positive on neighbors."
        />
        <NumberField
          label="Cooldown window"
          suffix="minutes"
          value={settings.cooldown_minutes}
          min={5} max={60} step={5}
          onChange={(v) => saveSettings({ cooldown_minutes: v })}
          help="Ignore duplicate arrivals within this window. Prevents restarts from GPS jitter."
        />
        <ToggleField
          label="Auto-complete job on exit"
          checked={settings.auto_complete_on_exit}
          onChange={(v) => saveSettings({ auto_complete_on_exit: v })}
          help={settings.auto_complete_on_exit
            ? '⚠️ Leaving the property will mark jobs complete. Careful with supply runs and van moves.'
            : 'Only the timer stops on exit. Tech still marks the job complete manually.'}
          warn={settings.auto_complete_on_exit}
        />
      </Card>

      {/* ── VEHICLE MAPPING ── */}
      <Card>
        <SectionTitle>Vehicle Mapping</SectionTitle>
        <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>
          Map each Bouncie device IMEI to the tech who drives that van.
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${D.border}`, textAlign: 'left', color: D.muted }}>
              <Th>Tech</Th><Th>Vehicle</Th><Th>IMEI</Th><Th>VIN</Th><Th>Status</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((t) => (
              <tr key={t.id} style={{ borderBottom: `1px solid ${D.border}` }}>
                <Td><strong>{t.name}</strong></Td>
                {editingTech === t.id ? (
                  <>
                    <Td><input value={vehNameInput} onChange={(e) => setVehNameInput(e.target.value)} placeholder="Transit Van #1" style={inputStyle} /></Td>
                    <Td><input value={imeiInput} onChange={(e) => setImeiInput(e.target.value)} placeholder="IMEI" style={{ ...inputStyle, fontFamily: MONO }} /></Td>
                    <Td><input value={vinInput} onChange={(e) => setVinInput(e.target.value)} placeholder="VIN (optional)" style={{ ...inputStyle, fontFamily: MONO }} /></Td>
                    <Td></Td>
                    <Td>
                      <button onClick={() => saveVehicle(t.id)} style={btnPrimary}>Save</button>
                      <button onClick={() => setEditingTech(null)} style={btnGhost}>Cancel</button>
                    </Td>
                  </>
                ) : (
                  <>
                    <Td>{t.vehicle_name || <span style={{ color: D.muted }}>—</span>}</Td>
                    <Td style={{ fontFamily: MONO, fontSize: 12 }}>{t.bouncie_imei || <span style={{ color: D.muted }}>Not set</span>}</Td>
                    <Td style={{ fontFamily: MONO, fontSize: 12 }}>{t.bouncie_vin || <span style={{ color: D.muted }}>—</span>}</Td>
                    <Td><Badge color={t.bouncie_imei ? D.green : D.muted} label={t.bouncie_imei ? 'Active' : 'Unmapped'} /></Td>
                    <Td><button onClick={() => startEditVehicle(t)} style={btnGhost}>Edit</button></Td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* ── EVENT LOG ── */}
      <Card>
        <SectionTitle>Recent Geofence Events</SectionTitle>
        <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>
          Last 50 ENTER / EXIT events processed from Bouncie.
        </div>
        {events.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: D.muted }}>No events yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${D.border}`, textAlign: 'left', color: D.muted }}>
                <Th>Time</Th><Th>Tech</Th><Th>Event</Th><Th>Customer</Th><Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} style={{ borderBottom: `1px solid ${D.border}` }}>
                  <Td style={{ fontFamily: MONO }}>{new Date(e.event_timestamp).toLocaleString()}</Td>
                  <Td>{e.tech_name || '—'}</Td>
                  <Td><Badge color={e.event_type === 'ENTER' ? D.green : D.red} label={e.event_type} /></Td>
                  <Td>{[e.customer_first_name, e.customer_last_name].filter(Boolean).join(' ') || <span style={{ color: D.muted }}>—</span>}</Td>
                  <Td><Badge color={ACTION_COLORS[e.action_taken] || D.muted} label={e.action_taken} /></Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {saving && <div style={{ position: 'fixed', bottom: 24, right: 24, background: D.heading, color: D.white, padding: '8px 14px', borderRadius: 8, fontSize: 12 }}>Saving…</div>}
    </div>
  );
}

function Card({ children, style }) {
  return <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 24, ...style }}>{children}</div>;
}
function SectionTitle({ children }) {
  return <div style={{ fontSize: 16, fontWeight: 600, color: D.heading, marginBottom: 16 }}>{children}</div>;
}
function Th({ children }) { return <th style={{ padding: '10px 8px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>{children}</th>; }
function Td({ children, style }) { return <td style={{ padding: '10px 8px', color: D.text, ...style }}>{children}</td>; }

function Badge({ color, label }) {
  return (
    <span style={{
      background: color + '22', color, border: `1px solid ${color}44`,
      padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 500, fontFamily: MONO,
    }}>{label}</span>
  );
}

function ModeOption({ active, onClick, title, body }) {
  return (
    <div onClick={onClick} style={{
      padding: 16, borderRadius: 10, cursor: 'pointer',
      border: `2px solid ${active ? D.teal : D.border}`,
      background: active ? D.teal + '11' : D.white,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{title}</div>
      <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>{body}</div>
    </div>
  );
}

function NumberField({ label, suffix, value, min, max, step, onChange, help }) {
  return (
    <div style={{ padding: '12px 0', borderBottom: `1px solid ${D.border}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{label}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="number" value={value} min={min} max={max} step={step}
            onChange={(e) => onChange(parseInt(e.target.value, 10))}
            style={{ width: 80, padding: '6px 10px', borderRadius: 6, border: `1px solid ${D.border}`, fontFamily: MONO, fontSize: 13 }} />
          <span style={{ fontSize: 12, color: D.muted }}>{suffix}</span>
        </div>
      </div>
      {help && <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>{help}</div>}
    </div>
  );
}

function ToggleField({ label, checked, onChange, help, warn }) {
  return (
    <div style={{ padding: '14px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{label}</div>
        <div onClick={() => onChange(!checked)} style={{
          width: 44, height: 24, borderRadius: 12, padding: 2, cursor: 'pointer',
          background: checked ? D.teal : D.border, transition: 'background 0.2s',
        }}>
          <div style={{
            width: 20, height: 20, borderRadius: 10, background: D.white,
            transform: checked ? 'translateX(20px)' : 'translateX(0)',
            transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }} />
        </div>
      </div>
      {help && <div style={{ fontSize: 12, color: warn ? D.red : D.muted, marginTop: 6 }}>{help}</div>}
    </div>
  );
}

const inputStyle = { width: '100%', padding: '6px 10px', borderRadius: 6, border: `1px solid ${D.border}`, fontSize: 12 };
const btnPrimary = { marginRight: 6, padding: '6px 12px', borderRadius: 6, border: 'none', background: D.teal, color: D.white, fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const btnGhost = { padding: '6px 12px', borderRadius: 6, border: `1px solid ${D.border}`, background: 'transparent', color: D.text, fontSize: 12, cursor: 'pointer' };
