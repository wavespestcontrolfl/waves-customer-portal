import { useCallback, useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const D = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  border: "#E4E4E7",
  green: "#15803D",
  amber: "#A16207",
  red: "#991B1B",
  text: "#27272A",
  muted: "#71717A",
  heading: "#09090B",
  teal: "#18181B",
  white: "#FFFFFF",
};
const MONO = "'JetBrains Mono', monospace";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function formatRelative(iso) {
  if (!iso) return "Never checked";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))}s ago`;
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

function statusTone(status) {
  if (status === "connected") return "ok";
  if (status === "degraded") return "warn";
  if (status === "expired" || status === "error") return "bad";
  return "neutral";
}

function pillStyle(tone) {
  if (tone === "ok") return { background: D.green + "22", color: D.green };
  if (tone === "warn") return { background: D.amber + "22", color: D.amber };
  if (tone === "bad") return { background: D.red + "15", color: D.red };
  return { background: D.border + "66", color: D.muted };
}

function groupByCategory(integrations) {
  return integrations.reduce((acc, integration) => {
    if (!acc[integration.category]) acc[integration.category] = [];
    acc[integration.category].push(integration);
    return acc;
  }, {});
}

export default function IntegrationHealthSection({
  intro = "Live credential health and integration configuration. Status reflects cached token-health checks plus config readiness.",
  showRefresh = true,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    return adminFetch("/admin/integrations/health")
      .then((next) => setData(next))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runCheck = async () => {
    setChecking(true);
    try {
      await adminFetch("/admin/token-health/check", { method: "POST" });
      await load();
    } finally {
      setChecking(false);
    }
  };

  if (loading) {
    return <div style={{ color: D.muted, padding: 24 }}>Loading integrations...</div>;
  }
  if (error) {
    return <div style={{ color: D.red, padding: 24 }}>Failed to load integrations: {error}</div>;
  }

  const groups = groupByCategory(data?.integrations || []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.45 }}>
          {intro}
        </div>
        {showRefresh && (
          <button
            onClick={runCheck}
            disabled={checking}
            style={{
              padding: "6px 14px",
              border: "none",
              borderRadius: 6,
              background: D.teal,
              color: D.white,
              fontSize: 12,
              fontWeight: 700,
              cursor: checking ? "default" : "pointer",
              opacity: checking ? 0.6 : 1,
            }}
          >
            {checking ? "Checking..." : "Refresh checks"}
          </button>
        )}
      </div>

      {Object.entries(groups).map(([category, integrations]) => (
        <div key={category}>
          <div
            style={{
              fontSize: 11,
              color: D.muted,
              textTransform: "uppercase",
              letterSpacing: 1,
              fontWeight: 700,
              marginBottom: 10,
            }}
          >
            {category}
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {integrations.map((integration) => (
              <IntegrationCard key={integration.id} integration={integration} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function IntegrationCard({ integration }) {
  const tone = statusTone(integration.health?.status);
  return (
    <div
      style={{
        background: D.card,
        border: `1px solid ${D.border}`,
        borderLeft: `4px solid ${tone === "ok" ? D.green : tone === "warn" ? D.amber : tone === "bad" ? D.red : D.border}`,
        borderRadius: 8,
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
              {integration.name}
            </div>
            {integration.deprecating && (
              <span style={{ ...pillStyle("warn"), borderRadius: 999, padding: "3px 8px", fontSize: 10, fontWeight: 800 }}>
                Deprecating
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: D.muted, marginTop: 3, lineHeight: 1.4 }}>
            {integration.description}
          </div>
        </div>
        <span
          style={{
            ...pillStyle(tone),
            borderRadius: 999,
            padding: "4px 12px",
            fontSize: 11,
            fontWeight: 800,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {integration.health?.label || "Unknown"}
        </span>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: D.text, lineHeight: 1.45 }}>
        {integration.health?.reason}
      </div>

      {(integration.gates || []).length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
          {integration.gates.map((gate) => (
            <span
              key={gate.key}
              style={{
                ...pillStyle(gate.enabled ? "ok" : "neutral"),
                borderRadius: 999,
                padding: "3px 8px",
                fontSize: 10,
                fontWeight: 800,
              }}
            >
              {gate.label}: {gate.enabled ? "On" : "Off"}
            </span>
          ))}
        </div>
      )}

      {(integration.health?.children || []).length > 0 && (
        <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
          {integration.health.children.map((child) => (
            <div
              key={child.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                padding: "6px 8px",
                borderRadius: 6,
                background: D.bg,
                fontSize: 11,
              }}
            >
              <span style={{ color: D.heading, fontWeight: 700 }}>{child.label}</span>
              <span style={{ color: pillStyle(statusTone(child.status)).color, fontWeight: 800 }}>
                {child.statusLabel}
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
        {(integration.env || []).map((env) => {
          const missingOneOfGroup = env.requiredGroup === "one_of" && !env.groupSatisfied;
          const dotColor = env.present ? D.green : env.required || env.readinessImpact || missingOneOfGroup ? D.red : D.muted;
          const typeLabel = env.required
            ? "required"
            : env.requiredGroup === "one_of"
              ? "one of required"
              : env.readinessImpact
                ? "readiness"
                : "supporting";
          return (
            <span
              key={env.key}
              title={`${env.key}: ${env.present ? "present" : "missing"} (${typeLabel})`}
              style={{
                fontSize: 10,
                fontFamily: MONO,
                padding: "2px 8px",
                borderRadius: 4,
                background: D.bg,
                color: env.present ? D.text : D.muted,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  background: dotColor,
                  flexShrink: 0,
                }}
              />
              <span>{env.present ? "present" : "missing"}</span>
              {env.key}
            </span>
          );
        })}
      </div>

      <div style={{ marginTop: 10, color: D.muted, fontSize: 11 }}>
        Last checked {formatRelative(integration.health?.lastCheckedAt)}
      </div>
    </div>
  );
}
