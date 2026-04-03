import { useState, useEffect, useCallback } from "react";

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' });

// ── Status Badge ────────────────────────────────────────────
function StatusBadge({ active, label }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 12px", borderRadius: 20, fontSize: 13, fontWeight: 600,
      background: active ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.10)",
      color: active ? "#16a34a" : "#dc2626",
      border: `1px solid ${active ? "rgba(34,197,94,0.25)" : "rgba(239,68,68,0.2)"}`,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: active ? "#22c55e" : "#ef4444",
        boxShadow: active ? "0 0 8px rgba(34,197,94,0.5)" : "none",
        animation: active ? "pulse 2s infinite" : "none",
      }} />
      {label}
    </span>
  );
}

// ── Toggle Switch ───────────────────────────────────────────
function Toggle({ checked, onChange, label, sublabel }) {
  return (
    <label style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "16px 20px", borderRadius: 12,
      background: "var(--card-bg)", border: "1px solid var(--border)",
      cursor: "pointer", transition: "all 0.2s",
    }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{label}</div>
        {sublabel && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{sublabel}</div>}
      </div>
      <div style={{
        width: 48, height: 26, borderRadius: 13, padding: 2,
        background: checked ? "#0ea5e9" : "var(--toggle-off)",
        transition: "background 0.25s", position: "relative",
      }} onClick={(e) => { e.preventDefault(); onChange(!checked); }}>
        <div style={{
          width: 22, height: 22, borderRadius: "50%", background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          transform: checked ? "translateX(22px)" : "translateX(0)",
          transition: "transform 0.25s",
        }} />
      </div>
    </label>
  );
}

// ── Call Card ────────────────────────────────────────────────
function CallCard({ call }) {
  const categoryColors = {
    termite_wdo: "#dc2626", emergency: "#dc2626",
    general_pest: "#0ea5e9", lawn_care: "#22c55e",
    billing: "#f59e0b", scheduling: "#8b5cf6",
    mosquito: "#06b6d4", tree_shrub: "#10b981",
    other: "#6b7280",
  };
  const cat = call.category || call.classification?.category || "other";
  const outcomeLabels = {
    lead_captured: "Lead Captured", appointment_booked: "Appt Booked",
    billing_deflected: "Billing → Portal", emergency_flagged: "Emergency",
    info_provided: "Info Given", callback_requested: "Callback Req",
    wrong_number: "Wrong #", hangup: "Hangup",
  };

  return (
    <div style={{
      padding: "14px 18px", borderRadius: 10,
      background: "var(--card-bg)", border: "1px solid var(--border)",
      marginBottom: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
            {call.customer_name || call.caller_phone || "Unknown"}
          </span>
          {call.caller_phone && (
            <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 8 }}>{call.caller_phone}</span>
          )}
        </div>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 6,
          background: `${categoryColors[cat]}18`, color: categoryColors[cat],
          textTransform: "uppercase", letterSpacing: "0.5px",
        }}>
          {cat.replace("_", " ")}
        </span>
      </div>
      <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, marginBottom: 6 }}>
        {call.summary || "No summary available"}
      </div>
      <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--text-muted)" }}>
        {call.outcome && <span style={{ fontWeight: 500 }}>{outcomeLabels[call.outcome] || call.outcome}</span>}
        {call.urgency && <span>Urgency: {"⬤".repeat(call.urgency)}{"◯".repeat(5 - call.urgency)}</span>}
        {call.timestamp && <span>{new Date(call.timestamp).toLocaleString()}</span>}
        {call.upsell_attempted && <span style={{ color: "#8b5cf6" }}>Upsell attempted</span>}
      </div>
    </div>
  );
}

// ── Stat Card ───────────────────────────────────────────────
function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      padding: "18px 20px", borderRadius: 12,
      background: "var(--card-bg)", border: "1px solid var(--border)",
      flex: "1 1 140px", minWidth: 140,
    }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 500, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: accent || "var(--text)", lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Main Dashboard ──────────────────────────────────────────
export default function WavesVoiceAgentAdmin() {
  const [status, setStatus] = useState(null);
  const [calls, setCalls] = useState([]);
  const [activeCalls, setActiveCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Demo data for display
  const [demoMode] = useState(true);
  const demoStatus = {
    agent_enabled: true,
    after_hours_only: false,
    is_business_hours: true,
    agent_currently_active: true,
    active_calls: 0,
    config: {
      enabled: true, afterHoursOnly: false,
      model: "claude-sonnet-4-20250514",
      ttsProvider: "ElevenLabs", ttsVoice: "Rachel",
      sttProvider: "Deepgram",
      businessHours: { start: 8, end: 18 },
    },
  };
  const demoCalls = [
    { customer_name: "Maria Santos", caller_phone: "+19415559012", category: "termite_wdo", outcome: "lead_captured", urgency: 4, summary: "Noticed mud tubes along foundation wall. Wants WDO inspection ASAP — closing on a property next week. Lead captured, estimate pipeline fired.", timestamp: "2026-04-03T14:22:00Z", upsell_attempted: false },
    { customer_name: "Dave Richardson", caller_phone: "+19415553847", category: "general_pest", outcome: "lead_captured", urgency: 2, summary: "Seeing large roaches in garage, some inside kitchen. New to area. Collected address — 4821 Antigua Way, Bradenton. Estimate sent.", timestamp: "2026-04-03T11:45:00Z", upsell_attempted: false },
    { customer_name: "Jennifer Walsh", caller_phone: "+19415557291", category: "emergency", outcome: "emergency_flagged", urgency: 5, summary: "Wasp nest in swing set frame — kids playing nearby. Emergency alert sent to owner + Adam. Callback within 30 min.", timestamp: "2026-04-02T18:33:00Z", upsell_attempted: false },
    { customer_name: "Tom Perez", caller_phone: "+19415551188", category: "lawn_care", outcome: "lead_captured", urgency: 2, summary: "Patchy St. Augustine, thinks chinch bugs. Currently no lawn service. Mentioned WaveGuard Gold. Interested — wants estimate.", timestamp: "2026-04-02T16:10:00Z", upsell_attempted: true, upsell_interest: true },
    { customer_name: "Linda Chen", caller_phone: "+19415554420", category: "billing", outcome: "billing_deflected", urgency: 1, summary: "Asked about last invoice amount. Sent portal link via SMS. No further issues.", timestamp: "2026-04-02T10:05:00Z", upsell_attempted: false },
    { customer_name: "Robert Niles", caller_phone: "+19415558833", category: "scheduling", outcome: "appointment_booked", urgency: 2, summary: "Existing Gold member, wanted to reschedule quarterly pest treatment. Moved to Thursday AM window. SMS confirmation sent.", timestamp: "2026-04-01T15:48:00Z", upsell_attempted: false },
  ];

  const [agentEnabled, setAgentEnabled] = useState(true);
  const [afterHoursOnly, setAfterHoursOnly] = useState(false);

  const fetchStatus = useCallback(async () => {
    if (demoMode) {
      setStatus(demoStatus);
      setCalls(demoCalls);
      setLoading(false);
      return;
    }
    try {
      const [statusRes, callsRes, activeRes] = await Promise.all([
        fetch(`${API_BASE}/admin/voice-agent/status`, { headers: authHeaders() }),
        fetch(`${API_BASE}/admin/voice-agent/calls`, { headers: authHeaders() }),
        fetch(`${API_BASE}/admin/voice-agent/active`, { headers: authHeaders() }),
      ]);
      setStatus(await statusRes.json());
      const callData = await callsRes.json();
      setCalls(callData.calls || []);
      const activeData = await activeRes.json();
      setActiveCalls(activeData.calls || []);
      setError(null);
    } catch (err) {
      setError("Cannot reach voice agent server");
    } finally {
      setLoading(false);
    }
  }, [demoMode]);

  useEffect(() => { fetchStatus(); const iv = setInterval(fetchStatus, 10000); return () => clearInterval(iv); }, [fetchStatus]);

  const handleToggle = async (field, value) => {
    if (field === "enabled") setAgentEnabled(value);
    if (field === "afterHoursOnly") setAfterHoursOnly(value);
    if (!demoMode) {
      await fetch(`${API_BASE}/admin/voice-agent/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      fetchStatus();
    }
  };

  // Stats
  const totalCalls = (demoMode ? demoCalls : calls).length;
  const leadsCapt = (demoMode ? demoCalls : calls).filter(c => c.outcome === "lead_captured").length;
  const emergencies = (demoMode ? demoCalls : calls).filter(c => c.category === "emergency").length;
  const termiteLeads = (demoMode ? demoCalls : calls).filter(c => c.category === "termite_wdo").length;
  const upsells = (demoMode ? demoCalls : calls).filter(c => c.upsell_attempted).length;
  const displayCalls = demoMode ? demoCalls : calls;

  return (
    <div style={{
      "--bg": "#0c1117", "--card-bg": "#151c25", "--border": "#1e293b",
      "--text": "#e2e8f0", "--text-secondary": "#94a3b8", "--text-muted": "#64748b",
      "--accent": "#0ea5e9", "--toggle-off": "#334155",
      fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      background: "var(--bg)", color: "var(--text)",
      minHeight: "100vh", padding: "24px 20px",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        * { box-sizing: border-box; margin: 0; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.3px" }}>
              <span style={{ color: "#0ea5e9" }}>Waves</span> Voice Agent
            </span>
            <StatusBadge active={agentEnabled} label={agentEnabled ? "Active" : "Off"} />
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Twilio ConversationRelay + Claude API • {afterHoursOnly ? "After-hours only" : "Always on"} • {
              new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
            } ET
          </div>
        </div>
        {demoMode && (
          <span style={{
            fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6,
            background: "rgba(251,191,36,0.12)", color: "#f59e0b", border: "1px solid rgba(251,191,36,0.2)",
          }}>
            DEMO MODE — Connect server to go live
          </span>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 280px" }}>
          <Toggle
            checked={agentEnabled}
            onChange={(v) => handleToggle("enabled", v)}
            label="Voice Agent"
            sublabel="Toggle between AI agent and voicemail"
          />
        </div>
        <div style={{ flex: "1 1 280px" }}>
          <Toggle
            checked={afterHoursOnly}
            onChange={(v) => handleToggle("afterHoursOnly", v)}
            label="After-Hours Only"
            sublabel="Agent active only outside 8am–6pm ET"
          />
        </div>
      </div>

      {/* Stats Row */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard label="Total Calls" value={totalCalls} sub="Last 7 days" />
        <StatCard label="Leads Captured" value={leadsCapt} accent="#22c55e" sub="→ Auto-estimate" />
        <StatCard label="Termite/WDO" value={termiteLeads} accent="#dc2626" sub="High-value" />
        <StatCard label="Emergencies" value={emergencies} accent="#f59e0b" sub="Flagged & alerted" />
        <StatCard label="Upsell Attempts" value={upsells} accent="#8b5cf6" sub={`${upsells > 0 ? Math.round((demoCalls.filter(c=>c.upsell_interest).length / upsells)*100) : 0}% interest`} />
      </div>

      {/* Active Calls */}
      {(activeCalls.length > 0 || (demoMode && false)) && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", animation: "pulse 1.5s infinite" }} />
            Live Calls ({activeCalls.length})
          </div>
          {activeCalls.map((call, i) => (
            <div key={i} style={{
              padding: "12px 16px", borderRadius: 10, marginBottom: 6,
              background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.15)",
            }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{call.customer?.name || call.phone || "Unknown"}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {call.classification?.category || "Classifying..."} • {call.message_count} messages • Started {new Date(call.start_time).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pipeline Overview */}
      <div style={{
        padding: "16px 20px", borderRadius: 12, marginBottom: 24,
        background: "var(--card-bg)", border: "1px solid var(--border)",
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Call → Estimate Pipeline</div>
        <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap", fontSize: 12 }}>
          {["Missed Call", "AI Agent", "Lead Capture", "RentCast + Satellite", "Pricing Engine", "SMS Estimate"].map((step, i, arr) => (
            <div key={step} style={{ display: "flex", alignItems: "center" }}>
              <div style={{
                padding: "8px 14px", borderRadius: 8,
                background: i === 1 ? "rgba(14,165,233,0.12)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${i === 1 ? "rgba(14,165,233,0.3)" : "var(--border)"}`,
                color: i === 1 ? "#0ea5e9" : "var(--text-secondary)",
                fontWeight: 500, whiteSpace: "nowrap",
              }}>
                {step}
              </div>
              {i < arr.length - 1 && (
                <span style={{ margin: "0 4px", color: "var(--text-muted)", fontSize: 16 }}>→</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Call Log */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Recent Calls</div>
        {displayCalls.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            No calls yet. Agent is standing by.
          </div>
        ) : (
          displayCalls.map((call, i) => <CallCard key={i} call={call} />)
        )}
      </div>

      {/* Config Panel */}
      <div style={{
        marginTop: 24, padding: "16px 20px", borderRadius: 12,
        background: "var(--card-bg)", border: "1px solid var(--border)",
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>Agent Config</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, fontSize: 13 }}>
          <div>
            <span style={{ color: "var(--text-muted)" }}>Model: </span>
            <span style={{ fontWeight: 500 }}>claude-sonnet-4</span>
          </div>
          <div>
            <span style={{ color: "var(--text-muted)" }}>TTS: </span>
            <span style={{ fontWeight: 500 }}>ElevenLabs (Rachel)</span>
          </div>
          <div>
            <span style={{ color: "var(--text-muted)" }}>STT: </span>
            <span style={{ fontWeight: 500 }}>Deepgram</span>
          </div>
          <div>
            <span style={{ color: "var(--text-muted)" }}>Ring Timeout: </span>
            <span style={{ fontWeight: 500 }}>25 seconds</span>
          </div>
          <div>
            <span style={{ color: "var(--text-muted)" }}>Hours: </span>
            <span style={{ fontWeight: 500 }}>8am – 6pm ET</span>
          </div>
          <div>
            <span style={{ color: "var(--text-muted)" }}>Estimator Sheet: </span>
            <span style={{ fontWeight: 500, fontSize: 11, fontFamily: "monospace" }}>...SymP4</span>
          </div>
        </div>
      </div>
    </div>
  );
}
