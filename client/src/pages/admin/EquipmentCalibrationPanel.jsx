import { useState, useEffect, useMemo, useCallback } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
// Match LawnAssessmentPanel's V2 token pass for visual consistency.
const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  teal: "#18181B",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  text: "#27272A",
  muted: "#71717A",
  white: "#FFFFFF",
  input: "#FFFFFF",
  heading: "#09090B",
  inputBorder: "#D4D4D8",
};
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });
}

const cardStyle = {
  background: D.card,
  border: `1px solid ${D.border}`,
  borderRadius: 12,
  padding: 16,
};
const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  border: `1px solid ${D.inputBorder}`,
  borderRadius: 8,
  fontSize: 14,
  background: D.input,
  color: D.text,
};
const btnStyle = (bg) => ({
  background: bg,
  color: D.white,
  border: "none",
  borderRadius: 8,
  padding: "10px 14px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
});

// Pure: gal/1,000 sqft = captured_gallons / (test_area_sqft / 1000).
// Returns null when inputs aren't both finite + positive.
export function computeCarrierRate(testAreaSqft, capturedGallons) {
  const a = Number(testAreaSqft);
  const g = Number(capturedGallons);
  if (!Number.isFinite(a) || !Number.isFinite(g) || a <= 0 || g <= 0)
    return null;
  // Round to 3 decimals so display doesn't suggest false precision.
  return Math.round((g / (a / 1000)) * 1000) / 1000;
}

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function calibrationStatusLabel(status) {
  if (status === "field_verified") return "Field verified";
  if (status === "estimated_not_field_verified") {
    return "Estimated, not field verified";
  }
  return status || "Unspecified";
}

export default function EquipmentCalibrationPanel() {
  const [systems, setSystems] = useState([]);
  const [selectedSystemId, setSelectedSystemId] = useState("");
  const [activeCalibration, setActiveCalibration] = useState(null);
  const [testAreaSqft, setTestAreaSqft] = useState("");
  const [capturedGallons, setCapturedGallons] = useState("");
  const [pressurePsi, setPressurePsi] = useState("");
  const [enginRpm, setEngineRpm] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyTestAreaSqft, setVerifyTestAreaSqft] = useState("");
  const [verifyCapturedGallons, setVerifyCapturedGallons] = useState("");
  const [verifyDate, setVerifyDate] = useState(todayInputValue());
  const [verifyNotes, setVerifyNotes] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [reconciliation, setReconciliation] = useState(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);

  const loadReconciliation = useCallback(() => {
    setReconciliationLoading(true);
    return adminFetch("/admin/equipment-systems/reconciliation")
      .then((d) => setReconciliation(d))
      .catch(() => setReconciliation(null))
      .finally(() => setReconciliationLoading(false));
  }, []);

  // Load systems on mount.
  useEffect(() => {
    adminFetch("/admin/equipment-systems")
      .then((d) => setSystems(d.systems || []))
      .catch(() => {});
    loadReconciliation();
  }, [loadReconciliation]);

  // When the tech picks a system, fetch its current active calibration
  // so they can see what they're about to supersede.
  //
  // Stale-response guard: if the tech rapidly switches systems, an older
  // fetch could resolve after a newer one and overwrite the displayed
  // active calibration with data for the wrong rig. The cleanup function
  // sets `cancelled = true` before the next effect runs, and every state
  // setter checks it before applying. This is especially important here
  // because the displayed "Current active calibration" is what the tech
  // sees right before saving a superseding row — wrong display could
  // cause them to overwrite the wrong rig.
  useEffect(() => {
    if (!selectedSystemId) {
      setActiveCalibration(null);
      setVerifyOpen(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    adminFetch(`/admin/equipment-systems/${selectedSystemId}`)
      .then((d) => {
        if (!cancelled) setActiveCalibration(d.calibration || null);
      })
      .catch(() => {
        if (!cancelled) setActiveCalibration(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSystemId]);

  const computedRate = useMemo(
    () => computeCarrierRate(testAreaSqft, capturedGallons),
    [testAreaSqft, capturedGallons],
  );
  const verificationComputedRate = useMemo(
    () => computeCarrierRate(verifyTestAreaSqft, verifyCapturedGallons),
    [verifyTestAreaSqft, verifyCapturedGallons],
  );

  const selectedSystem = systems.find((s) => s.id === selectedSystemId);
  const selectedReconciliationSystem = reconciliation?.systems?.find(
    (s) => s.id === selectedSystemId,
  );

  const canSave = !!selectedSystemId && computedRate != null && !saving;
  const canVerify =
    !!activeCalibration &&
    verificationComputedRate != null &&
    !!verifyDate &&
    !verifying;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setSavedAt(null);
    // Capture the system-at-save so we can detect a switch during the
    // POST roundtrip. Without this, clicking Save for system A and
    // then switching to system B before the response resolves would
    // call setActiveCalibration with A's calibration while the UI is
    // showing B — the tech would see B's name + A's carrier rate.
    const systemAtSave = selectedSystemId;
    try {
      const payload = {
        carrier_gal_per_1000: computedRate,
        test_area_sqft: Number(testAreaSqft),
        captured_gallons: Number(capturedGallons),
      };
      if (pressurePsi !== "") payload.pressure_psi = Number(pressurePsi);
      if (enginRpm !== "") payload.engine_rpm_setting = String(enginRpm);
      if (notes !== "") payload.notes = notes;

      const d = await adminFetch(
        `/admin/equipment-systems/${systemAtSave}/calibrations`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
      // Only commit the response into UI state if the user is still
      // looking at the system we saved against. Otherwise, the
      // useEffect on selectedSystemId will refetch the new system's
      // calibration and we leave the response on the floor.
      if (systemAtSave !== selectedSystemId) return;
      setActiveCalibration(d.calibration);
      setSavedAt(new Date());
      // Clear the form except the picked system — tech can immediately
      // re-calibrate the same rig on a different course if needed.
      setTestAreaSqft("");
      setCapturedGallons("");
      setPressurePsi("");
      setEngineRpm("");
      setNotes("");
      loadReconciliation();
    } catch (e) {
      alert("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyCalibration = async () => {
    if (!canVerify) return;
    setVerifying(true);
    try {
      const d = await adminFetch(
        `/admin/equipment-systems/calibrations/${activeCalibration.id}/verify`,
        {
          method: "POST",
          body: JSON.stringify({
            verified_test_area_sqft: Number(verifyTestAreaSqft),
            verified_captured_gallons: Number(verifyCapturedGallons),
            verified_at: `${verifyDate}T12:00:00`,
            verification_notes: verifyNotes || null,
          }),
        },
      );
      setActiveCalibration(d.calibration);
      setVerifyOpen(false);
      setVerifyTestAreaSqft("");
      setVerifyCapturedGallons("");
      setVerifyDate(todayInputValue());
      setVerifyNotes("");
      loadReconciliation();
    } catch (e) {
      alert("Verification failed: " + e.message);
    } finally {
      setVerifying(false);
    }
  };

  const fmtExpiry = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString();
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {" "}
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: D.heading,
          marginBottom: 16,
        }}
      >
        Equipment Calibration
      </div>{" "}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        {" "}
        <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
          Equipment system
        </div>{" "}
        <select
          value={selectedSystemId}
          onChange={(e) => setSelectedSystemId(e.target.value)}
          style={{ ...inputStyle, marginBottom: 0 }}
        >
          {" "}
          <option value="">— select a spray rig —</option>
          {systems.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.system_type}
              {s.tank_capacity_gal ? `, ${s.tank_capacity_gal} gal` : ""})
            </option>
          ))}
        </select>
        {selectedSystem?.notes && (
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              background: D.bg,
              borderRadius: 6,
              fontSize: 12,
              color: D.muted,
              lineHeight: 1.4,
            }}
          >
            {selectedSystem.notes}
          </div>
        )}
        {selectedReconciliationSystem && (
          <SystemLinkSummary system={selectedReconciliationSystem} />
        )}
        {/* Current active calibration — what we'll supersede on save */}
        {selectedSystemId &&
          (loading ? (
            <div style={{ marginTop: 12, color: D.muted, fontSize: 12 }}>
              Loading current calibration…
            </div>
          ) : activeCalibration ? (
            <div
              style={{
                marginTop: 12,
                padding: 10,
                background: D.bg,
                borderRadius: 8,
                fontSize: 12,
                color: D.text,
              }}
            >
              {" "}
              <div
                style={{ fontWeight: 600, color: D.heading, marginBottom: 4 }}
              >
                Current active calibration
              </div>{" "}
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  alignItems: "baseline",
                  flexWrap: "wrap",
                }}
              >
                {" "}
                <div>
                  {" "}
                  <span style={{ color: D.muted }}>status:</span>{" "}
                  <span
                    style={{
                      fontWeight: 700,
                      color:
                        activeCalibration.calibration_status ===
                        "field_verified"
                          ? D.green
                          : D.amber,
                    }}
                  >
                    {calibrationStatusLabel(activeCalibration.calibration_status)}
                  </span>{" "}
                </div>{" "}
                <div>
                  {" "}
                  <span style={{ color: D.muted }}>carrier:</span>{" "}
                  <span style={{ fontFamily: MONO, fontWeight: 700 }}>
                    {activeCalibration.carrier_gal_per_1000}
                  </span>{" "}
                  <span style={{ color: D.muted }}>gal/1,000 sqft</span>{" "}
                </div>{" "}
                <div>
                  {" "}
                  <span style={{ color: D.muted }}>expires:</span>{" "}
                  <span>{fmtExpiry(activeCalibration.expires_at)}</span>{" "}
                </div>{" "}
              </div>{" "}
              {activeCalibration.verified_at && (
                <div style={{ marginTop: 6, color: D.muted }}>
                  Verified {new Date(activeCalibration.verified_at).toLocaleDateString()}
                  {activeCalibration.verified_test_area_sqft
                    ? ` over ${activeCalibration.verified_test_area_sqft} sqft`
                    : ""}
                  {activeCalibration.verified_captured_gallons
                    ? ` using ${activeCalibration.verified_captured_gallons} gal`
                    : ""}
                </div>
              )}
              {activeCalibration.calibration_status !== "field_verified" && (
                <div style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    onClick={() => setVerifyOpen((v) => !v)}
                    style={{
                      ...btnStyle(D.teal),
                      padding: "8px 12px",
                      fontSize: 12,
                    }}
                  >
                    {verifyOpen ? "Close verification" : "Verify Calibration"}
                  </button>
                </div>
              )}
              {verifyOpen && (
                <div
                  style={{
                    marginTop: 10,
                    padding: 10,
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    background: D.card,
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: 10,
                      marginBottom: 10,
                    }}
                  >
                    <div>
                      <div style={{ color: D.muted, marginBottom: 4 }}>
                        Measured sqft
                      </div>
                      <input
                        type="number"
                        inputMode="numeric"
                        step="1"
                        value={verifyTestAreaSqft}
                        onChange={(e) => setVerifyTestAreaSqft(e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <div style={{ color: D.muted, marginBottom: 4 }}>
                        Measured gallons
                      </div>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        value={verifyCapturedGallons}
                        onChange={(e) =>
                          setVerifyCapturedGallons(e.target.value)
                        }
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <div style={{ color: D.muted, marginBottom: 4 }}>
                        Verification date
                      </div>
                      <input
                        type="date"
                        value={verifyDate}
                        onChange={(e) => setVerifyDate(e.target.value)}
                        style={inputStyle}
                      />
                    </div>
                  </div>
                  <div
                    style={{
                      marginBottom: 10,
                      padding: 10,
                      background: D.bg,
                      borderRadius: 8,
                    }}
                  >
                    <span style={{ color: D.muted }}>Verified carrier:</span>{" "}
                    <span style={{ fontFamily: MONO, fontWeight: 800 }}>
                      {verificationComputedRate != null
                        ? `${verificationComputedRate} gal/1,000 sqft`
                        : "—"}
                    </span>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: D.muted, marginBottom: 4 }}>
                      Verification notes
                    </div>
                    <textarea
                      rows={2}
                      value={verifyNotes}
                      onChange={(e) => setVerifyNotes(e.target.value)}
                      style={{ ...inputStyle, resize: "vertical" }}
                    />
                  </div>
                  <div style={{ color: D.muted, marginBottom: 10 }}>
                    Tech is recorded from the signed-in admin/technician account.
                  </div>
                  <button
                    type="button"
                    onClick={handleVerifyCalibration}
                    disabled={!canVerify}
                    style={{
                      ...btnStyle(D.green),
                      width: "100%",
                      opacity: canVerify ? 1 : 0.5,
                    }}
                  >
                    {verifying ? "Verifying..." : "Mark Field Verified"}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div
              style={{
                marginTop: 12,
                padding: 10,
                background: D.bg,
                borderRadius: 8,
                fontSize: 12,
                color: D.amber,
              }}
            >
              No active calibration. Plan engine cannot use this rig until one
              is recorded.
            </div>
          ))}
      </div>
      {/* Calibration form */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        {" "}
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: D.heading,
            marginBottom: 12,
          }}
        >
          New calibration test
        </div>{" "}
        <div style={{ marginBottom: 12 }}>
          {" "}
          <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
            Test area (sqft)
          </div>{" "}
          <input
            type="number"
            inputMode="decimal"
            step="1"
            placeholder="e.g. 1000"
            value={testAreaSqft}
            onChange={(e) => setTestAreaSqft(e.target.value)}
            style={inputStyle}
          />{" "}
        </div>{" "}
        <div style={{ marginBottom: 12 }}>
          {" "}
          <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
            Captured gallons
          </div>{" "}
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            placeholder="e.g. 2.0"
            value={capturedGallons}
            onChange={(e) => setCapturedGallons(e.target.value)}
            style={inputStyle}
          />{" "}
        </div>
        {/* Computed carrier rate — read-only, recomputes on each input */}
        <div
          style={{
            marginBottom: 12,
            padding: 12,
            background: D.bg,
            borderRadius: 8,
            textAlign: "center",
          }}
        >
          {" "}
          <div style={{ fontSize: 11, color: D.muted, letterSpacing: 0.5 }}>
            COMPUTED CARRIER RATE
          </div>{" "}
          <div
            style={{
              fontFamily: MONO,
              fontSize: 24,
              fontWeight: 800,
              color: computedRate != null ? D.green : D.muted,
            }}
          >
            {computedRate != null ? `${computedRate} gal / 1,000 sqft` : "—"}
          </div>{" "}
        </div>
        {/* Optional context */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            marginBottom: 12,
          }}
        >
          {" "}
          <div>
            {" "}
            <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
              Pressure (PSI, optional)
            </div>{" "}
            <input
              type="number"
              inputMode="decimal"
              step="1"
              value={pressurePsi}
              onChange={(e) => setPressurePsi(e.target.value)}
              style={inputStyle}
            />{" "}
          </div>{" "}
          <div>
            {" "}
            <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
              Engine RPM (optional)
            </div>{" "}
            <input
              type="text"
              value={enginRpm}
              onChange={(e) => setEngineRpm(e.target.value)}
              style={inputStyle}
            />{" "}
          </div>{" "}
        </div>{" "}
        <div style={{ marginBottom: 12 }}>
          {" "}
          <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
            Notes (optional)
          </div>{" "}
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{ ...inputStyle, resize: "vertical" }}
          />{" "}
        </div>{" "}
        <button
          onClick={handleSave}
          disabled={!canSave}
          style={{
            ...btnStyle(D.green),
            width: "100%",
            padding: 14,
            fontSize: 15,
            opacity: canSave ? 1 : 0.5,
          }}
        >
          {saving ? "Saving…" : "Save Calibration (expires in 30 days)"}
        </button>
        {savedAt && (
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              color: D.green,
              textAlign: "center",
            }}
          >
            Calibration saved at {savedAt.toLocaleTimeString()}
          </div>
        )}
      </div>{" "}
      <ReconciliationPanel
        report={reconciliation}
        loading={reconciliationLoading}
        onRefresh={loadReconciliation}
      />
    </div>
  );
}

function assetName(asset) {
  if (!asset) return null;
  return `${asset.asset_tag ? `${asset.asset_tag} - ` : ""}${asset.name}`;
}

function SystemLinkSummary({ system }) {
  const componentAssets = Object.entries(system.component_assets || {})
    .filter(([, asset]) => asset)
    .map(([role, asset]) => ({ role, asset }));
  const suggestions = system.suggested_equipment_matches || [];

  return (
    <div
      style={{
        marginTop: 10,
        padding: "8px 10px",
        background: D.bg,
        borderRadius: 6,
        fontSize: 12,
        color: D.text,
        lineHeight: 1.4,
      }}
    >
      <div style={{ fontWeight: 700, color: D.heading, marginBottom: 4 }}>
        Operational links
      </div>
      {system.primary_equipment ? (
        <div>
          <span style={{ color: D.muted }}>Primary:</span>{" "}
          {assetName(system.primary_equipment)}
        </div>
      ) : (
        <div style={{ color: D.amber }}>No primary equipment linked</div>
      )}
      {componentAssets.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <span style={{ color: D.muted }}>Components:</span>{" "}
          {componentAssets
            .map(({ role, asset }) => `${role}: ${assetName(asset)}`)
            .join("; ")}
        </div>
      )}
      {!system.primary_equipment && suggestions.length > 0 && (
        <div style={{ marginTop: 4, color: D.muted }}>
          Suggested: {suggestions.map((s) => assetName(s)).join(", ")}
        </div>
      )}
    </div>
  );
}

function ReconciliationPanel({ report, loading, onRefresh }) {
  const summary = report?.summary || {};
  const issues = report?.issues || [];
  const unlinkedSystems = (report?.systems || []).filter(
    (s) =>
      s.active !== false &&
      !(s.active_linked_equipment_ids || s.linked_equipment_ids || []).length,
  );
  const missingTaxLinks = (report?.equipment || []).filter(
    (e) => !e.tax_register && Number(e.purchase_price || 0) > 0,
  );

  return (
    <div style={{ ...cardStyle, marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: D.heading }}>
            Equipment reconciliation
          </div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
            Links calibrated systems, operational assets, and tax register rows.
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          style={{
            ...btnStyle(D.teal),
            padding: "8px 12px",
            fontSize: 12,
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {!report && (
        <div style={{ fontSize: 12, color: loading ? D.muted : D.amber }}>
          {loading
            ? "Loading reconciliation report..."
            : "Reconciliation report unavailable."}
        </div>
      )}

      {report && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 8,
              marginBottom: 14,
            }}
          >
            <SummaryTile
              label="Systems linked"
              value={`${summary.systems_with_any_equipment_link ?? 0}/${summary.systems_active ?? 0}`}
            />
            <SummaryTile
              label="No system link"
              value={summary.systems_without_equipment_link ?? 0}
              color={
                summary.systems_without_equipment_link > 0 ? D.amber : D.green
              }
            />
            <SummaryTile
              label="Equipment tax links"
              value={`${summary.equipment_with_tax_link ?? 0}/${summary.equipment_active ?? 0}`}
            />
            <SummaryTile
              label="Tax rows unlinked"
              value={summary.tax_register_unlinked ?? 0}
              color={summary.tax_register_unlinked > 0 ? D.amber : D.green}
            />
          </div>

          {unlinkedSystems.length > 0 && (
            <IssueSection
              title="Systems needing operational links"
              rows={unlinkedSystems.slice(0, 5).map((s) => ({
                id: s.id,
                label: s.name,
                detail: s.suggested_equipment_matches?.length
                  ? `Suggested: ${s.suggested_equipment_matches
                      .map((m) => assetName(m))
                      .join(", ")}`
                  : "No strong match found",
              }))}
            />
          )}

          {missingTaxLinks.length > 0 && (
            <IssueSection
              title="Operational equipment missing tax link"
              rows={missingTaxLinks.slice(0, 5).map((e) => ({
                id: e.id,
                label: assetName(e),
                detail: e.suggested_tax_matches?.length
                  ? `Suggested: ${e.suggested_tax_matches
                      .map((m) => m.name)
                      .join(", ")}`
                  : "No strong tax-register match found",
              }))}
            />
          )}

          {issues.length === 0 && !loading && (
            <div style={{ fontSize: 12, color: D.green }}>
              No reconciliation issues detected.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, color = D.heading }) {
  return (
    <div
      style={{
        border: `1px solid ${D.border}`,
        borderRadius: 8,
        padding: 10,
        minHeight: 64,
      }}
    >
      <div style={{ fontSize: 10, color: D.muted, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function IssueSection({ title, rows }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: D.heading }}>
        {title}
      </div>
      <div style={{ marginTop: 6, display: "grid", gap: 6 }}>
        {rows.map((row) => (
          <div
            key={row.id}
            style={{
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12,
            }}
          >
            <div style={{ color: D.text, fontWeight: 600 }}>{row.label}</div>
            <div style={{ color: D.muted, marginTop: 2 }}>{row.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
