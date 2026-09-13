import { Button, Field, Input, Select, Textarea, Card, ActionFeedback } from "../../components/ui";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { etDateString, etDatetimeLocalToISO, formatETDate, formatETTime } from "../../lib/timezone";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
// Match LawnAssessmentPanel's V2 token pass for visual consistency.

// Match LawnAssessmentPanel's V2 token pass for visual consistency.

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json"
    },
    ...options
  }).then(async r => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });
}
// Pure: gal/1,000 sqft = captured_gallons / (test_area_sqft / 1000).
// Returns null when inputs aren't both finite + positive.

// Pure: gal/1,000 sqft = captured_gallons / (test_area_sqft / 1000).
// Returns null when inputs aren't both finite + positive.
export function computeCarrierRate(testAreaSqft, capturedGallons) {
  const a = Number(testAreaSqft);
  const g = Number(capturedGallons);
  if (!Number.isFinite(a) || !Number.isFinite(g) || a <= 0 || g <= 0) return null;
  // Round to 3 decimals so display doesn't suggest false precision.
  return Math.round(g / (a / 1000) * 1000) / 1000;
}
function calibrationStatusLabel(status) {
  if (status === "field_verified") return "Field verified";
  if (status === "estimated_not_field_verified") {
    return "Estimated, not field verified";
  }
  return status || "Unspecified";
}
export default function EquipmentCalibrationPanel() {
  const actionRef = useRef(false);
  const [actionError, setActionError] = useState("");
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
  const [verifyDate, setVerifyDate] = useState(etDateString);
  const [verifyNotes, setVerifyNotes] = useState("");
  const [verifying, setVerifying] = useState(false);
  const busy = saving || verifying;
  const [reconciliation, setReconciliation] = useState(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [systemsLoading, setSystemsLoading] = useState(true);
  const [systemsError, setSystemsError] = useState("");
  const [reconciliationError, setReconciliationError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [detailAttempt, setDetailAttempt] = useState(0);
  const loadReconciliation = useCallback(async () => {
    setReconciliationLoading(true);
    setReconciliationError("");
    try {
      const d = await adminFetch("/admin/equipment-systems/reconciliation");
      setReconciliation(d);
    } catch (error) {
      setReconciliation(null);
      setReconciliationError(error.message);
    } finally {
      setReconciliationLoading(false);
    }
  }, []);
  const loadSystems = useCallback(async () => {
    setSystemsLoading(true);
    setSystemsError("");
    try {
      const d = await adminFetch("/admin/equipment-systems");
      setSystems(d.systems || []);
    } catch (error) {
      setSystemsError(error.message);
    } finally {
      setSystemsLoading(false);
    }
  }, []);
  useEffect(() => {
    loadSystems();
    loadReconciliation();
  }, [loadSystems, loadReconciliation]);
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
      setLoading(false);
      setDetailError("");
      setVerifyOpen(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setDetailError("");
    setActiveCalibration(null);
    setVerifyOpen(false);
    adminFetch(`/admin/equipment-systems/${selectedSystemId}`).then(d => {
      if (!cancelled) setActiveCalibration(d.calibration || null);
    }).catch(error => {
      if (!cancelled) setDetailError(error.message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSystemId, detailAttempt]);
  const computedRate = useMemo(() => computeCarrierRate(testAreaSqft, capturedGallons), [testAreaSqft, capturedGallons]);
  const verificationComputedRate = useMemo(() => computeCarrierRate(verifyTestAreaSqft, verifyCapturedGallons), [verifyTestAreaSqft, verifyCapturedGallons]);
  const selectedSystem = systems.find(s => s.id === selectedSystemId);
  const selectedReconciliationSystem = reconciliation?.systems?.find(s => s.id === selectedSystemId);
  const canSave = !!selectedSystemId && computedRate != null && !busy && !loading && !detailError && !systemsError;
  const canVerify = !!activeCalibration && verificationComputedRate != null && !!verifyDate && !busy && !loading && !detailError;
  const handleSave = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActionError("");
    try {
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
          captured_gallons: Number(capturedGallons)
        };
        if (pressurePsi !== "") payload.pressure_psi = Number(pressurePsi);
        if (enginRpm !== "") payload.engine_rpm_setting = String(enginRpm);
        if (notes !== "") payload.notes = notes;
        const d = await adminFetch(`/admin/equipment-systems/${systemAtSave}/calibrations`, {
          method: "POST",
          body: JSON.stringify(payload)
        });
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
        setActionError("Save failed: " + e.message);
      } finally {
        setSaving(false);
      }
    } finally {
      actionRef.current = false;
    }
  };
  const handleVerifyCalibration = async () => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActionError("");
    try {
      if (!canVerify) return;
      setVerifying(true);
      try {
        const d = await adminFetch(`/admin/equipment-systems/calibrations/${activeCalibration.id}/verify`, {
          method: "POST",
          body: JSON.stringify({
            verified_test_area_sqft: Number(verifyTestAreaSqft),
            verified_captured_gallons: Number(verifyCapturedGallons),
            verified_at: etDatetimeLocalToISO(`${verifyDate}T12:00`),
            verification_notes: verifyNotes || null
          })
        });
        setActiveCalibration(d.calibration);
        setVerifyOpen(false);
        setVerifyTestAreaSqft("");
        setVerifyCapturedGallons("");
        setVerifyDate(etDateString());
        setVerifyNotes("");
        loadReconciliation();
      } catch (e) {
        setActionError("Verification failed: " + e.message);
      } finally {
        setVerifying(false);
      }
    } finally {
      actionRef.current = false;
    }
  };
  const fmtExpiry = iso => {
    if (!iso) return "—";
    return formatETDate(iso);
  };
  return <div style={{
    maxWidth: 900,
    margin: "0 auto"
  }}>
      {actionError && <ActionFeedback error className="mb-4">
          {actionError}
        </ActionFeedback>}{" "}
      {systemsError && <ActionFeedback error onRetry={loadSystems} className="mb-4">
          Could not load equipment systems: {systemsError}
        </ActionFeedback>}
      {systemsLoading && <div className="min-h-24 text-zinc-500">Loading equipment systems…</div>}
      {!systemsLoading && !systemsError && systems.length === 0 && <Card className="p-4 mb-4 text-zinc-500">
          No equipment systems are available for calibration.
        </Card>}
      {reconciliationError && <ActionFeedback error onRetry={loadReconciliation} className="mb-4">
          Could not load equipment reconciliation: {reconciliationError}
        </ActionFeedback>}
      <h2 style={{
      fontSize: 18,
      fontWeight: 500,
      color: "#09090B",
      marginBottom: 16
    }}>
        Equipment Calibration
      </h2>{" "}
      <Card style={{
      marginBottom: 16
    }} className="p-4 mb-3">
        {" "}
        <Field label="Equipment system" className="min-w-0">
          <Select value={selectedSystemId} onChange={e => setSelectedSystemId(e.target.value)} style={{
          marginBottom: 0
        }} disabled={busy}>
            {" "}
            <option value="">— select a spray rig —</option>
            {systems.map(s => <option key={s.id} value={s.id}>
                {s.name} ({s.system_type}
                {s.tank_capacity_gal ? `, ${s.tank_capacity_gal} gal` : ""})
              </option>)}
          </Select>
        </Field>
        {selectedSystem?.notes && <div style={{
        marginTop: 10,
        padding: "8px 10px",
        background: "#F4F4F5",
        borderRadius: 6,
        fontSize: 14,
        color: "#71717A",
        lineHeight: 1.4
      }}>
            {selectedSystem.notes}
          </div>}
        {selectedReconciliationSystem && <SystemLinkSummary system={selectedReconciliationSystem} />}
        {/* Current active calibration — what we'll supersede on save */}
        {selectedSystemId && (loading ? <div style={{
        marginTop: 12,
        color: "#71717A",
        fontSize: 14
      }}>
              Loading current calibration…
            </div> : detailError ? <ActionFeedback error onRetry={() => setDetailAttempt(v => v + 1)} className="mt-4">
              Could not load current calibration: {detailError}
            </ActionFeedback> : activeCalibration ? <div style={{
        marginTop: 12,
        padding: 10,
        background: "#F4F4F5",
        borderRadius: 8,
        fontSize: 14,
        color: "#27272A"
      }}>
              {" "}
              <div style={{
          fontWeight: 500,
          color: "#09090B",
          marginBottom: 4
        }}>
                Current active calibration
              </div>{" "}
              <div style={{
          display: "flex",
          gap: 16,
          alignItems: "baseline",
          flexWrap: "wrap"
        }}>
                {" "}
                <div>
                  {" "}
                  <span style={{
              color: "#71717A"
            }}>
                    status:
                  </span>{" "}
                  <span style={{
              fontWeight: 500,
              color: activeCalibration.calibration_status === "field_verified" ? "#18181B" : "#52525B"
            }}>
                    {calibrationStatusLabel(activeCalibration.calibration_status)}
                  </span>{" "}
                </div>{" "}
                <div>
                  {" "}
                  <span style={{
              color: "#71717A"
            }}>
                    carrier:
                  </span>{" "}
                  <span style={{
              fontWeight: 500
            }}>
                    {activeCalibration.carrier_gal_per_1000}
                  </span>{" "}
                  <span style={{
              color: "#71717A"
            }}>
                    gal/1,000 sqft
                  </span>{" "}
                </div>{" "}
                <div>
                  {" "}
                  <span style={{
              color: "#71717A"
            }}>
                    expires:
                  </span>{" "}
                  <span>{fmtExpiry(activeCalibration.expires_at)}</span>{" "}
                </div>{" "}
              </div>{" "}
              {activeCalibration.verified_at && <div style={{
          marginTop: 6,
          color: "#71717A"
        }}>
                  Verified{" "}
                  {formatETDate(activeCalibration.verified_at)}
                  {activeCalibration.verified_test_area_sqft ? ` over ${activeCalibration.verified_test_area_sqft} sqft` : ""}
                  {activeCalibration.verified_captured_gallons ? ` using ${activeCalibration.verified_captured_gallons} gal` : ""}
                </div>}
              {activeCalibration.calibration_status !== "field_verified" && <div style={{
          marginTop: 10
        }}>
                  <Button type="button" onClick={() => setVerifyOpen(v => !v)} variant="primary" className="min-w-11" disabled={busy}>
                    {verifyOpen ? "Close verification" : "Verify Calibration"}
                  </Button>
                </div>}
              {verifyOpen && <Card style={{
          marginTop: 10,
          padding: 10
        }}>
                  <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 10,
            marginBottom: 10
          }}>
                    <div>
                      <Field label="Measured sqft" className="min-w-0">
                        <Input type="number" inputMode="numeric" step="1" value={verifyTestAreaSqft} onChange={e => setVerifyTestAreaSqft(e.target.value)} disabled={busy} />
                      </Field>
                    </div>
                    <div>
                      <Field label="Measured gallons" className="min-w-0">
                        <Input type="number" inputMode="decimal" step="0.01" value={verifyCapturedGallons} onChange={e => setVerifyCapturedGallons(e.target.value)} disabled={busy} />
                      </Field>
                    </div>
                    <div>
                      <Field label="Verification date" className="min-w-0">
                        <Input type="date" value={verifyDate} onChange={e => setVerifyDate(e.target.value)} disabled={busy} />
                      </Field>
                    </div>
                  </div>
                  <div style={{
            marginBottom: 10,
            padding: 10,
            background: "#F4F4F5",
            borderRadius: 8
          }}>
                    <span style={{
              color: "#71717A"
            }}>
                      Verified carrier:
                    </span>{" "}
                    <span style={{
              fontWeight: 500
            }}>
                      {verificationComputedRate != null ? `${verificationComputedRate} gal/1,000 sqft` : "—"}
                    </span>
                  </div>
                  <div style={{
            marginBottom: 10
          }}>
                    <Field label="Verification notes" className="min-w-0">
                      <Textarea rows={2} value={verifyNotes} onChange={e => setVerifyNotes(e.target.value)} style={{
                resize: "vertical"
              }} disabled={busy} />
                    </Field>
                  </div>
                  <div style={{
            color: "#71717A",
            marginBottom: 10
          }}>
                    Tech is recorded from the signed-in admin/technician
                    account.
                  </div>
                  <Button type="button" onClick={handleVerifyCalibration} disabled={!canVerify} style={{
            width: "100%"
          }} variant="primary" loading={verifying} className="min-w-11">
                    {"Mark Field Verified"}
                  </Button>
                </Card>}
            </div> : <div style={{
        marginTop: 12,
        padding: 10,
        background: "#F4F4F5",
        borderRadius: 8,
        fontSize: 14,
        color: "#52525B"
      }}>
              No active calibration. Plan engine cannot use this rig until one
              is recorded.
            </div>)}
      </Card>
      {/* Calibration form */}
      <Card style={{
      marginBottom: 16
    }} className="p-4 mb-3">
        {" "}
        <div style={{
        fontSize: 14,
        fontWeight: 500,
        color: "#09090B",
        marginBottom: 12
      }}>
          New calibration test
        </div>{" "}
        <div style={{
        marginBottom: 12
      }}>
          {" "}
          <Field label="Test area (sqft)" className="min-w-0">
            <Input type="number" inputMode="decimal" step="1" placeholder="e.g. 1000" value={testAreaSqft} onChange={e => setTestAreaSqft(e.target.value)} disabled={busy} />
          </Field>{" "}
        </div>{" "}
        <div style={{
        marginBottom: 12
      }}>
          {" "}
          <Field label="Captured gallons" className="min-w-0">
            <Input type="number" inputMode="decimal" step="0.01" placeholder="e.g. 2.0" value={capturedGallons} onChange={e => setCapturedGallons(e.target.value)} disabled={busy} />
          </Field>{" "}
        </div>
        {/* Computed carrier rate — read-only, recomputes on each input */}
        <div style={{
        marginBottom: 12,
        padding: 12,
        background: "#F4F4F5",
        borderRadius: 8,
        textAlign: "center"
      }}>
          {" "}
          <div style={{
          fontSize: 14,
          color: "#71717A"
        }}>
            COMPUTED CARRIER RATE
          </div>{" "}
          <div style={{
          fontSize: 24,
          fontWeight: 500,
          color: computedRate != null ? "#18181B" : "#71717A"
        }}>
            {computedRate != null ? `${computedRate} gal / 1,000 sqft` : "—"}
          </div>{" "}
        </div>
        {/* Optional context */}
        <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
        marginBottom: 12
      }}>
          {" "}
          <div>
            {" "}
            <Field label="Pressure (PSI, optional)" className="min-w-0">
              <Input type="number" inputMode="decimal" step="1" value={pressurePsi} onChange={e => setPressurePsi(e.target.value)} disabled={busy} />
            </Field>{" "}
          </div>{" "}
          <div>
            {" "}
            <Field label="Engine RPM (optional)" className="min-w-0">
              <Input type="text" value={enginRpm} onChange={e => setEngineRpm(e.target.value)} disabled={busy} />
            </Field>{" "}
          </div>{" "}
        </div>{" "}
        <div style={{
        marginBottom: 12
      }}>
          {" "}
          <Field label="Notes (optional)" className="min-w-0">
            <Textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} style={{
            resize: "vertical"
          }} disabled={busy} />
          </Field>{" "}
        </div>{" "}
        <Button onClick={handleSave} disabled={!canSave} style={{
        width: "100%"
      }} type="button" variant="primary" className="min-w-11" loading={saving}>
          Save Calibration (expires in 30 days)
        </Button>
        {savedAt && <div style={{
        marginTop: 10,
        fontSize: 14,
        color: "#18181B",
        textAlign: "center"
      }}>
            Calibration saved at {formatETTime(savedAt, {
          second: "2-digit"
        })}
          </div>}
      </Card>{" "}
      <ReconciliationPanel report={reconciliation} loading={reconciliationLoading} onRefresh={loadReconciliation} />
    </div>;
}
function assetName(asset) {
  if (!asset) return null;
  return `${asset.asset_tag ? `${asset.asset_tag} - ` : ""}${asset.name}`;
}
function SystemLinkSummary({
  system
}) {
  const componentAssets = Object.entries(system.component_assets || {}).filter(([, asset]) => asset).map(([role, asset]) => ({
    role,
    asset
  }));
  const suggestions = system.suggested_equipment_matches || [];
  return <div style={{
    marginTop: 10,
    padding: "8px 10px",
    background: "#F4F4F5",
    borderRadius: 6,
    fontSize: 14,
    color: "#27272A",
    lineHeight: 1.4
  }}>
      <div style={{
      fontWeight: 500,
      color: "#09090B",
      marginBottom: 4
    }}>
        Operational links
      </div>
      {system.primary_equipment ? <div>
          <span style={{
        color: "#71717A"
      }}>
            Primary:
          </span>{" "}
          {assetName(system.primary_equipment)}
        </div> : <div style={{
      color: "#52525B"
    }}>
          No primary equipment linked
        </div>}
      {componentAssets.length > 0 && <div style={{
      marginTop: 4
    }}>
          <span style={{
        color: "#71717A"
      }}>
            Components:
          </span>{" "}
          {componentAssets.map(({
        role,
        asset
      }) => `${role}: ${assetName(asset)}`).join("; ")}
        </div>}
      {!system.primary_equipment && suggestions.length > 0 && <div style={{
      marginTop: 4,
      color: "#71717A"
    }}>
          Suggested: {suggestions.map(s => assetName(s)).join(", ")}
        </div>}
    </div>;
}
function ReconciliationPanel({
  report,
  loading,
  onRefresh
}) {
  const summary = report?.summary || {};
  const issues = report?.issues || [];
  const unlinkedSystems = (report?.systems || []).filter(s => s.active !== false && !(s.active_linked_equipment_ids || s.linked_equipment_ids || []).length);
  const missingTaxLinks = (report?.equipment || []).filter(e => !e.tax_register && Number(e.purchase_price || 0) > 0);
  return <Card style={{
    marginBottom: 16
  }} className="p-4 mb-3">
      <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      marginBottom: 12
    }}>
        <div>
          <div style={{
          fontSize: 14,
          fontWeight: 500,
          color: "#09090B"
        }}>
            Equipment reconciliation
          </div>
          <div style={{
          fontSize: 14,
          color: "#71717A",
          marginTop: 2
        }}>
            Links calibrated systems, operational assets, and tax register rows.
          </div>
        </div>
        <Button type="button" onClick={onRefresh} disabled={loading} variant="primary" loading={loading} className="min-w-11">
          {"Refresh"}
        </Button>
      </div>

      {!report && <div style={{
      fontSize: 14,
      color: loading ? "#71717A" : "#52525B"
    }}>
          {loading ? "Loading reconciliation report..." : "Reconciliation report unavailable."}
        </div>}

      {report && <>
          <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        gap: 8,
        marginBottom: 14
      }}>
            <SummaryTile label="Systems linked" value={`${summary.systems_with_any_equipment_link ?? 0}/${summary.systems_active ?? 0}`} />
            <SummaryTile label="No system link" value={summary.systems_without_equipment_link ?? 0} color={summary.systems_without_equipment_link > 0 ? "#52525B" : "#18181B"} />
            <SummaryTile label="Equipment tax links" value={`${summary.equipment_with_tax_link ?? 0}/${summary.equipment_active ?? 0}`} />
            <SummaryTile label="Tax rows unlinked" value={summary.tax_register_unlinked ?? 0} color={summary.tax_register_unlinked > 0 ? "#52525B" : "#18181B"} />
          </div>

          {unlinkedSystems.length > 0 && <IssueSection title="Systems needing operational links" rows={unlinkedSystems.slice(0, 5).map(s => ({
        id: s.id,
        label: s.name,
        detail: s.suggested_equipment_matches?.length ? `Suggested: ${s.suggested_equipment_matches.map(m => assetName(m)).join(", ")}` : "No strong match found"
      }))} />}

          {missingTaxLinks.length > 0 && <IssueSection title="Operational equipment missing tax link" rows={missingTaxLinks.slice(0, 5).map(e => ({
        id: e.id,
        label: assetName(e),
        detail: e.suggested_tax_matches?.length ? `Suggested: ${e.suggested_tax_matches.map(m => m.name).join(", ")}` : "No strong tax-register match found"
      }))} />}

          {issues.length === 0 && !loading && <div style={{
        fontSize: 14,
        color: "#18181B"
      }}>
              No reconciliation issues detected.
            </div>}
        </>}
    </Card>;
}
function SummaryTile({
  label,
  value,
  color = "#09090B"
}) {
  return <div style={{
    border: `1px solid ${"#E4E4E7"}`,
    borderRadius: 8,
    padding: 10,
    minHeight: 64
  }}>
      <div style={{
      fontSize: 14,
      color: "#71717A",
      marginBottom: 4
    }}>
        {label}
      </div>
      <div style={{
      fontSize: 20,
      fontWeight: 500,
      color
    }}>
        {value}
      </div>
    </div>;
}
function IssueSection({
  title,
  rows
}) {
  return <div style={{
    marginTop: 12
  }}>
      <div style={{
      fontSize: 14,
      fontWeight: 500,
      color: "#09090B"
    }}>
        {title}
      </div>
      <div style={{
      marginTop: 6,
      display: "grid",
      gap: 6
    }}>
        {rows.map(row => <div key={row.id} style={{
        border: `1px solid ${"#E4E4E7"}`,
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: 14
      }}>
            <div style={{
          color: "#27272A",
          fontWeight: 500
        }}>
              {row.label}
            </div>
            <div style={{
          color: "#71717A",
          marginTop: 2
        }}>
              {row.detail}
            </div>
          </div>)}
      </div>
    </div>;
}
