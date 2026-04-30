import { useState, useEffect, useMemo } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// Match LawnAssessmentPanel's V2 token pass for visual consistency.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', input: '#FFFFFF', heading: '#09090B', inputBorder: '#D4D4D8' };
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });
}

const cardStyle = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 16 };
const inputStyle = { width: '100%', padding: '10px 12px', border: `1px solid ${D.inputBorder}`, borderRadius: 8, fontSize: 14, background: D.input, color: D.text };
const btnStyle = (bg) => ({ background: bg, color: D.white, border: 'none', borderRadius: 8, padding: '10px 14px', fontSize: 14, fontWeight: 600, cursor: 'pointer' });

// Pure: gal/1,000 sqft = captured_gallons / (test_area_sqft / 1000).
// Returns null when inputs aren't both finite + positive.
export function computeCarrierRate(testAreaSqft, capturedGallons) {
  const a = Number(testAreaSqft);
  const g = Number(capturedGallons);
  if (!Number.isFinite(a) || !Number.isFinite(g) || a <= 0 || g <= 0) return null;
  // Round to 3 decimals so display doesn't suggest false precision.
  return Math.round((g / (a / 1000)) * 1000) / 1000;
}

export default function EquipmentCalibrationPanel() {
  const [systems, setSystems] = useState([]);
  const [selectedSystemId, setSelectedSystemId] = useState('');
  const [activeCalibration, setActiveCalibration] = useState(null);
  const [testAreaSqft, setTestAreaSqft] = useState('');
  const [capturedGallons, setCapturedGallons] = useState('');
  const [pressurePsi, setPressurePsi] = useState('');
  const [enginRpm, setEngineRpm] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  // Load systems on mount.
  useEffect(() => {
    adminFetch('/admin/equipment-systems').then(d => setSystems(d.systems || [])).catch(() => {});
  }, []);

  // When the tech picks a system, fetch its current active calibration
  // so they can see what they're about to supersede.
  useEffect(() => {
    if (!selectedSystemId) { setActiveCalibration(null); return; }
    setLoading(true);
    adminFetch(`/admin/equipment-systems/${selectedSystemId}`)
      .then(d => setActiveCalibration(d.calibration || null))
      .catch(() => setActiveCalibration(null))
      .finally(() => setLoading(false));
  }, [selectedSystemId]);

  const computedRate = useMemo(
    () => computeCarrierRate(testAreaSqft, capturedGallons),
    [testAreaSqft, capturedGallons],
  );

  const selectedSystem = systems.find(s => s.id === selectedSystemId);

  const canSave = !!selectedSystemId && computedRate != null && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSavedAt(null);
    try {
      const payload = {
        carrier_gal_per_1000: computedRate,
        test_area_sqft: Number(testAreaSqft),
        captured_gallons: Number(capturedGallons),
      };
      if (pressurePsi !== '') payload.pressure_psi = Number(pressurePsi);
      if (enginRpm !== '') payload.engine_rpm_setting = String(enginRpm);
      if (notes !== '') payload.notes = notes;

      const d = await adminFetch(`/admin/equipment-systems/${selectedSystemId}/calibrations`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setActiveCalibration(d.calibration);
      setSavedAt(new Date());
      // Clear the form except the picked system — tech can immediately
      // re-calibrate the same rig on a different course if needed.
      setTestAreaSqft('');
      setCapturedGallons('');
      setPressurePsi('');
      setEngineRpm('');
      setNotes('');
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const fmtExpiry = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString();
  };

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: D.heading, marginBottom: 16 }}>
        Equipment Calibration
      </div>

      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Equipment system</div>
        <select
          value={selectedSystemId}
          onChange={e => setSelectedSystemId(e.target.value)}
          style={{ ...inputStyle, marginBottom: 0 }}
        >
          <option value="">— select a spray rig —</option>
          {systems.map(s => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.system_type}{s.tank_capacity_gal ? `, ${s.tank_capacity_gal} gal` : ''})
            </option>
          ))}
        </select>

        {selectedSystem?.notes && (
          <div style={{ marginTop: 10, padding: '8px 10px', background: D.bg, borderRadius: 6, fontSize: 12, color: D.muted, lineHeight: 1.4 }}>
            {selectedSystem.notes}
          </div>
        )}

        {/* Current active calibration — what we'll supersede on save */}
        {selectedSystemId && (
          loading ? (
            <div style={{ marginTop: 12, color: D.muted, fontSize: 12 }}>Loading current calibration…</div>
          ) : activeCalibration ? (
            <div style={{ marginTop: 12, padding: 10, background: D.bg, borderRadius: 8, fontSize: 12, color: D.text }}>
              <div style={{ fontWeight: 600, color: D.heading, marginBottom: 4 }}>Current active calibration</div>
              <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
                <div>
                  <span style={{ color: D.muted }}>carrier:</span>{' '}
                  <span style={{ fontFamily: MONO, fontWeight: 700 }}>{activeCalibration.carrier_gal_per_1000}</span>{' '}
                  <span style={{ color: D.muted }}>gal/1,000 sqft</span>
                </div>
                <div>
                  <span style={{ color: D.muted }}>expires:</span>{' '}
                  <span>{fmtExpiry(activeCalibration.expires_at)}</span>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 12, padding: 10, background: D.bg, borderRadius: 8, fontSize: 12, color: D.amber }}>
              No active calibration. Plan engine cannot use this rig until one is recorded.
            </div>
          )
        )}
      </div>

      {/* Calibration form */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 12 }}>
          New calibration test
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Test area (sqft)</div>
          <input
            type="number" inputMode="decimal" step="1"
            placeholder="e.g. 1000"
            value={testAreaSqft} onChange={e => setTestAreaSqft(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Captured gallons</div>
          <input
            type="number" inputMode="decimal" step="0.01"
            placeholder="e.g. 2.0"
            value={capturedGallons} onChange={e => setCapturedGallons(e.target.value)}
            style={inputStyle}
          />
        </div>

        {/* Computed carrier rate — read-only, recomputes on each input */}
        <div style={{ marginBottom: 12, padding: 12, background: D.bg, borderRadius: 8, textAlign: 'center' }}>
          <div style={{ fontSize: 11, color: D.muted, letterSpacing: 0.5 }}>COMPUTED CARRIER RATE</div>
          <div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 800, color: computedRate != null ? D.green : D.muted }}>
            {computedRate != null ? `${computedRate} gal / 1,000 sqft` : '—'}
          </div>
        </div>

        {/* Optional context */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Pressure (PSI, optional)</div>
            <input
              type="number" inputMode="decimal" step="1"
              value={pressurePsi} onChange={e => setPressurePsi(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Engine RPM (optional)</div>
            <input
              type="text"
              value={enginRpm} onChange={e => setEngineRpm(e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>Notes (optional)</div>
          <textarea
            rows={2}
            value={notes} onChange={e => setNotes(e.target.value)}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
        </div>

        <button
          onClick={handleSave}
          disabled={!canSave}
          style={{ ...btnStyle(D.green), width: '100%', padding: 14, fontSize: 15, opacity: canSave ? 1 : 0.5 }}
        >
          {saving ? 'Saving…' : 'Save Calibration (expires in 30 days)'}
        </button>

        {savedAt && (
          <div style={{ marginTop: 10, fontSize: 12, color: D.green, textAlign: 'center' }}>
            ✓ Calibration saved at {savedAt.toLocaleTimeString()}
          </div>
        )}
      </div>
    </div>
  );
}
