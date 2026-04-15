import { useState, useEffect, useCallback } from "react";

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' });

// ── Status Badge ────────────────────────────────────────────
function StatusBadge({ active, label }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "4px 12px", borderRadius: 20, fontSize: 13, fontWeight: 600,
      background: active ? "rgba(22,163,74,0.10)" : "rgba(192,57,43,0.08)",
      color: active ? "#16A34A" : "#C0392B",
      border: `1px solid ${active ? "rgba(22,163,74,0.20)" : "rgba(192,57,43,0.15)"}`,
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: active ? "#16A34A" : "#C0392B",
        boxShadow: active ? "0 0 8px rgba(22,163,74,0.5)" : "none",
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
      background: "#FFFFFF", border: "1px solid #E2E8F0",
      cursor: "pointer", transition: "all 0.2s",
    }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "#334155" }}>{label}</div>
        {sublabel && <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>{sublabel}</div>}
      </div>
      <div style={{
        width: 48, height: 26, borderRadius: 13, padding: 2,
        background: checked ? "#0A7EC2" : "#CBD5E1",
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
function AnalyticsSection({ demoMode }) {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (demoMode) {
      setAnalytics({
        totalCalls: 47, aiHandled: 23, humanAnswered: 18, missed: 6,
        avgDuration: 185, leadConversionRate: 39,
        topCategories: [{ category: 'general_pest', count: 12 }, { category: 'lawn_care', count: 8 }, { category: 'termite_wdo', count: 5 }, { category: 'scheduling', count: 4 }],
        byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: h >= 8 && h <= 18 ? Math.floor(Math.random() * 5) : h >= 18 ? Math.floor(Math.random() * 3) : 0 })),
        resolutions: { lead_captured: 15, appointment_booked: 4, billing_deflected: 3, emergency_flagged: 1 },
      });
      setLoading(false);
      return;
    }
    fetch(`${API_BASE}/admin/voice-agent/analytics`, { headers: authHeaders() })
      .then(r => r.json()).then(setAnalytics).catch(() => {}).finally(() => setLoading(false));
  }, [demoMode]);

  if (loading || !analytics) return null;

  return (
    <div style={{ marginBottom: 24, padding: "16px 20px", borderRadius: 12, background: "#FFFFFF", border: "1px solid #E2E8F0" }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>Call Analytics</div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          { label: 'AI Handled', value: analytics.aiHandled, color: '#0A7EC2' },
          { label: 'Human Answered', value: analytics.humanAnswered, color: '#16A34A' },
          { label: 'Missed', value: analytics.missed, color: '#C0392B' },
          { label: 'Avg Duration', value: `${Math.round((analytics.avgDuration || 0) / 60)}m`, color: '#64748B' },
          { label: 'Lead Conv.', value: `${analytics.leadConversionRate || 0}%`, color: '#8b5cf6' },
        ].map(s => (
          <div key={s.label} style={{ flex: '1 1 100px', textAlign: 'center', padding: '10px 0' }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 9, color: '#64748B', textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Top Categories */}
      {analytics.topCategories?.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 11, color: '#64748B', marginRight: 4 }}>Top inquiries:</span>
          {analytics.topCategories.map(c => (
            <span key={c.category} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: 'rgba(10,126,194,0.08)', color: '#0A7EC2' }}>
              {c.category.replace(/_/g, ' ')} ({c.count})
            </span>
          ))}
        </div>
      )}

      {/* Calls by Hour mini chart */}
      {analytics.byHour && (
        <div>
          <div style={{ fontSize: 11, color: '#64748B', marginBottom: 6 }}>Calls by hour</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 40 }}>
            {analytics.byHour.map((h, i) => {
              const max = Math.max(...analytics.byHour.map(x => x.count), 1);
              const ht = Math.max(2, (h.count / max) * 36);
              const isBusinessHour = i >= 8 && i < 18;
              return (
                <div key={i} style={{ flex: 1, height: ht, background: h.count > 0 ? (isBusinessHour ? '#0A7EC2' : '#F0A500') : '#E2E8F0', borderRadius: 2 }} title={`${i}:00 — ${h.count} calls`} />
              );
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#64748B', marginTop: 2 }}>
            <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>12am</span>
          </div>
        </div>
      )}
    </div>
  );
}

function CallCard({ call }) {
  const categoryColors = {
    termite_wdo: "#C0392B", emergency: "#C0392B",
    general_pest: "#0A7EC2", lawn_care: "#16A34A",
    billing: "#F0A500", scheduling: "#8b5cf6",
    mosquito: "#06b6d4", tree_shrub: "#16A34A",
    other: "#64748B",
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
      background: "#FFFFFF", border: "1px solid #E2E8F0",
      marginBottom: 8,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#0F172A" }}>
            {call.customer_name || call.caller_phone || "Unknown"}
          </span>
          {call.caller_phone && (
            <span style={{ fontSize: 12, color: "#64748B", marginLeft: 8 }}>{call.caller_phone}</span>
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
      <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.5, marginBottom: 6 }}>
        {call.summary || "No summary available"}
      </div>
      <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#64748B" }}>
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
      background: "#FFFFFF", border: "1px solid #E2E8F0",
      flex: "1 1 140px", minWidth: 140,
    }}>
      <div style={{ fontSize: 12, color: "#64748B", fontWeight: 500, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: accent || "#0F172A", lineHeight: 1.2 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#64748B", marginTop: 2 }}>{sub}</div>}
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

  // Demo mode — auto-detect by checking if server responds
  const [demoMode, setDemoMode] = useState(false);
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
    try {
      const [statusRes, callsRes, activeRes] = await Promise.all([
        fetch(`${API_BASE}/admin/voice-agent/status`, { headers: authHeaders() }),
        fetch(`${API_BASE}/admin/voice-agent/calls`, { headers: authHeaders() }),
        fetch(`${API_BASE}/admin/voice-agent/active`, { headers: authHeaders() }),
      ]);
      if (!statusRes.ok) throw new Error('Server unavailable');
      const statusData = await statusRes.json();
      setStatus(statusData);
      setAgentEnabled(statusData.agent_enabled || statusData.config?.enabled || false);
      setAfterHoursOnly(statusData.after_hours_only || statusData.config?.afterHoursOnly || false);
      const callData = await callsRes.json();
      setCalls(callData.calls || []);
      const activeData = await activeRes.json();
      setActiveCalls(activeData.calls || []);
      setDemoMode(false);
      setError(null);
    } catch (err) {
      // Server not reachable — fall back to demo mode
      setDemoMode(true);
      setStatus(demoStatus);
      setCalls(demoCalls);
      setError("Server not reachable — showing demo data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); const iv = setInterval(fetchStatus, 10000); return () => clearInterval(iv); }, [fetchStatus]);

  const handleToggle = async (field, value) => {
    if (field === "enabled") setAgentEnabled(value);
    if (field === "afterHoursOnly") setAfterHoursOnly(value);
    try {
      await fetch(`${API_BASE}/admin/voice-agent/toggle`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      fetchStatus();
    } catch { /* ignore in demo mode */ }
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
      "--bg": "#F1F5F9", "--card-bg": "#FFFFFF", "--border": "#E2E8F0",
      "--text": "#0F172A", "--text-secondary": "#64748B", "--text-muted": "#64748b",
      "--accent": "#0A7EC2", "--toggle-off": "#CBD5E1",
      fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif",
      background: "#F1F5F9", color: "#0F172A",
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
              <span style={{ color: "#0A7EC2" }}>Waves</span> Voice Agent
            </span>
            <StatusBadge active={agentEnabled} label={agentEnabled ? "Active" : "Off"} />
          </div>
          <div style={{ fontSize: 12, color: "#64748B" }}>
            {afterHoursOnly ? "After-hours only" : "Always on"} • {
              new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })
            } ET
          </div>
        </div>
        {demoMode ? (
          <span style={{
            fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6,
            background: "rgba(240,165,0,0.10)", color: "#F0A500", border: "1px solid rgba(240,165,0,0.20)",
          }}>
            DEMO MODE — Set GATE_VOICE_AGENT=true in Railway to go live
          </span>
        ) : (
          <span style={{
            fontSize: 11, fontWeight: 600, padding: "4px 10px", borderRadius: 6,
            background: "rgba(22,163,74,0.10)", color: "#16A34A", border: "1px solid rgba(22,163,74,0.20)",
          }}>
            ● LIVE — Handling {afterHoursOnly ? 'after-hours' : 'all'} calls
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
        <StatCard label="Leads Captured" value={leadsCapt} accent="#16A34A" sub="→ Auto-estimate" />
        <StatCard label="Termite/WDO" value={termiteLeads} accent="#C0392B" sub="High-value" />
        <StatCard label="Emergencies" value={emergencies} accent="#F0A500" sub="Flagged & alerted" />
        <StatCard label="Upsell Attempts" value={upsells} accent="#8b5cf6" sub={`${upsells > 0 ? Math.round((demoCalls.filter(c=>c.upsell_interest).length / upsells)*100) : 0}% interest`} />
      </div>

      {/* Active Calls */}
      {(activeCalls.length > 0 || (demoMode && false)) && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#16A34A", animation: "pulse 1.5s infinite" }} />
            Live Calls ({activeCalls.length})
          </div>
          {activeCalls.map((call, i) => (
            <div key={i} style={{
              padding: "12px 16px", borderRadius: 10, marginBottom: 6,
              background: "rgba(22,163,74,0.06)", border: "1px solid rgba(22,163,74,0.15)",
            }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{call.customer?.name || call.phone || "Unknown"}</div>
              <div style={{ fontSize: 12, color: "#64748B" }}>
                {call.classification?.category || "Classifying..."} • {call.message_count} messages • Started {new Date(call.start_time).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pipeline Overview */}
      <div style={{
        padding: "16px 20px", borderRadius: 12, marginBottom: 24,
        background: "#FFFFFF", border: "1px solid #E2E8F0",
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>Call → Estimate Pipeline</div>
        <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap", fontSize: 12 }}>
          {["Missed Call", "AI Agent", "Lead Capture", "RentCast + Satellite", "Pricing Engine", "SMS Estimate"].map((step, i, arr) => (
            <div key={step} style={{ display: "flex", alignItems: "center" }}>
              <div style={{
                padding: "8px 14px", borderRadius: 8,
                background: i === 1 ? "rgba(10,126,194,0.08)" : "#F1F5F9",
                border: `1px solid ${i === 1 ? "rgba(10,126,194,0.3)" : "#E2E8F0"}`,
                color: i === 1 ? "#0A7EC2" : "#334155",
                fontWeight: 500, whiteSpace: "nowrap",
              }}>
                {step}
              </div>
              {i < arr.length - 1 && (
                <span style={{ margin: "0 4px", color: "#64748B", fontSize: 16 }}>→</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Call Log */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Recent Calls</div>
        {displayCalls.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "#64748B", fontSize: 13 }}>
            No calls yet. Agent is standing by.
          </div>
        ) : (
          displayCalls.map((call, i) => <CallCard key={i} call={call} />)
        )}
      </div>

      {/* Analytics */}
      <AnalyticsSection demoMode={demoMode} />

      {/* Config Panel */}
      <div style={{
        marginTop: 24, padding: "16px 20px", borderRadius: 12,
        background: "#FFFFFF", border: "1px solid #E2E8F0",
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>Agent Config</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, fontSize: 13 }}>
          {[
            ['Model', status?.config?.model || 'claude-sonnet-4'],
            ['TTS', `${status?.config?.ttsProvider || 'ElevenLabs'} (${status?.config?.ttsVoice || 'Rachel'})`],
            ['STT', status?.config?.sttProvider || 'Deepgram'],
            ['Ring Timeout', `${status?.config?.maxRingSeconds || 25} seconds`],
            ['Hours', `${status?.config?.businessHours?.start || 8}am – ${status?.config?.businessHours?.end || 18 > 12 ? (status?.config?.businessHours?.end || 18) - 12 : status?.config?.businessHours?.end || 18}pm ET`],
            ['Language', 'English + Spanish auto-detect'],
            ['Post-Call Survey', 'SMS 5min after call'],
            ['Knowledge Base', 'Auto-synced with services'],
          ].map(([label, value]) => (
            <div key={label}>
              <span style={{ color: "#64748B" }}>{label}: </span>
              <span style={{ fontWeight: 500 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
