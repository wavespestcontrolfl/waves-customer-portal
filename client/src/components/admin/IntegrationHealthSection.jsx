import React, { useCallback, useEffect, useState } from "react";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  UiSurface,
} from "../ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
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
  if (status === "connected") return "strong";
  if (status === "expired" || status === "error") return "alert";
  return "neutral";
}

function groupByCategory(integrations) {
  return integrations.reduce((groups, integration) => {
    if (!groups[integration.category]) groups[integration.category] = [];
    groups[integration.category].push(integration);
    return groups;
  }, {});
}

export default function IntegrationHealthSection() {
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
    return (
      <UiSurface>
        <ActionFeedback className="min-h-20">Loading integrations...</ActionFeedback>
      </UiSurface>
    );
  }
  if (error) {
    return (
      <UiSurface>
        <ActionFeedback error className="min-h-20">
          Failed to load integrations: {error}
        </ActionFeedback>
      </UiSurface>
    );
  }

  const groups = groupByCategory(data?.integrations || []);

  return (
    <UiSurface className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-ui-body text-ink-secondary">
          Live credential health and integration configuration. Status reflects cached token-health checks plus config readiness.
        </p>
        <Button onClick={runCheck} loading={checking}>
          {checking ? "Checking..." : "Refresh checks"}
        </Button>
      </div>

      {Object.entries(groups).map(([category, integrations]) => {
        const categoryId = `integration-category-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

        return (
          <section key={category} aria-labelledby={categoryId}>
            <h2 id={categoryId} className="mb-3 text-18 leading-[1.35] font-medium text-zinc-900">
              {category}
            </h2>
            <div className="grid gap-3">
              {integrations.map((integration) => (
                <IntegrationCard key={integration.id} integration={integration} />
              ))}
            </div>
          </section>
        );
      })}
    </UiSurface>
  );
}

function IntegrationCard({ integration }) {
  const healthTone = statusTone(integration.health?.status);
  return (
    <Card className={healthTone === "alert" ? "border-alert-fg" : undefined}>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{integration.name}</CardTitle>
            {integration.deprecating && <Badge tone="neutral">Deprecating</Badge>}
          </div>
          <p className="mt-1 text-ui-body text-ink-secondary">{integration.description}</p>
        </div>
        <Badge tone={healthTone} dot className="shrink-0">
          {integration.health?.label || "Unknown"}
        </Badge>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-ui-body text-zinc-700">{integration.health?.reason}</p>

        {(integration.gates || []).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {integration.gates.map((gate) => (
              <Badge key={gate.key} tone={gate.enabled ? "strong" : "neutral"}>
                {gate.label}: {gate.enabled ? "On" : "Off"}
              </Badge>
            ))}
          </div>
        )}

        {(integration.health?.children || []).length > 0 && (
          <div className="grid gap-2">
            {integration.health.children.map((child) => (
              <div key={child.id} className="flex flex-wrap justify-between gap-2 rounded-md bg-zinc-50 px-3 py-2">
                <span className="font-medium text-zinc-900">{child.label}</span>
                <Badge tone={statusTone(child.status)}>{child.statusLabel}</Badge>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {(integration.env || []).map((env) => {
            const missingOneOfGroup = env.requiredGroup === "one_of" && !env.groupSatisfied;
            const requiredMissing = !env.present && (env.required || env.readinessImpact || missingOneOfGroup);
            const typeLabel = env.required
              ? "required"
              : env.requiredGroup === "one_of"
                ? "one of required"
                : env.readinessImpact
                  ? "readiness"
                  : "supporting";
            return (
              <Badge
                key={env.key}
                tone={requiredMissing ? "alert" : env.present ? "strong" : "neutral"}
                dot
                title={`${env.key}: ${env.present ? "present" : "missing"} (${typeLabel})`}
                className="max-w-full break-all"
              >
                {env.present ? "Present" : "Missing"} · {env.key}
              </Badge>
            );
          })}
        </div>

        <p className="text-ui-caption text-ink-secondary">
          Last checked {formatRelative(integration.health?.lastCheckedAt)}
        </p>
      </CardBody>
    </Card>
  );
}
