/*
 * PortalUsageTab — Settings → Advanced → Portal Usage.
 *
 * Reads GET /api/admin/usage/summary (first-party page-view log written by
 * AdminLayoutV2; see lib/adminUsage.js) and answers "what do I actually use
 * on a regular recurring basis, and how do I get there" so the owner can
 * arrange the dashboard/nav around real usage instead of guesswork.
 *
 * Styled to match SettingsPage's light token pass (inline styles, zinc-ish
 * D palette) — this file deliberately mirrors that idiom, not components/ui.
 */
import { useEffect, useMemo, useState } from "react";
import { adminFetch, isRateLimitError } from "../../utils/admin-fetch";
import { ADMIN_NAV_ITEMS } from "../../config/adminNavigation";

const D = {
  card: "#FFFFFF",
  border: "#E4E4E7",
  text: "#27272A",
  muted: "#71717A",
  heading: "#09090B",
  hover: "#F4F4F5",
};
const MONO = "'JetBrains Mono', monospace";

const WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const SOURCE_LABELS = {
  sidebar: "Sidebar",
  tabbar: "Tab bar",
  more: "More menu",
  palette: "Palette",
  load: "App open",
  "in-app": "In-app link",
};

// path segment after /admin → human label, derived from the nav registry so
// labels can't drift from the sidebar. Pages reachable outside the nav get
// explicit entries; anything else falls back to a prettified slug.
const EXTRA_LABELS = {
  dispatch: "Dispatch",
  schedule: "Schedule",
  more: "More",
  leads: "Leads",
  estimates: "Estimates",
};

function buildLabelMap() {
  const map = { ...EXTRA_LABELS };
  for (const item of Object.values(ADMIN_NAV_ITEMS)) {
    const segment = String(item.path || "")
      .split("?")[0]
      .split("/")
      .filter(Boolean)[1];
    if (segment) map[segment] = item.label;
  }
  return map;
}

function prettifySlug(slug) {
  return String(slug)
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function relativeTime(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function topSource(sources) {
  const entries = Object.entries(sources || {});
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

function pillStyle(active) {
  return {
    padding: "0 12px",
    height: 32,
    borderRadius: 6,
    border: `1px solid ${active ? D.heading : D.border}`,
    background: active ? D.heading : D.card,
    color: active ? "#FFFFFF" : D.text,
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
  };
}

export default function PortalUsageTab({ canAdmin }) {
  const [days, setDays] = useState(30);
  const [scope, setScope] = useState("me");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const labelMap = useMemo(buildLabelMap, []);
  const labelFor = (pageKey) => labelMap[pageKey] || prettifySlug(pageKey);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    adminFetch(`/admin/usage/summary?days=${days}&scope=${scope}`)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope]);

  const pages = data?.pages || [];

  // The three questions that drive rearranging, computed from the same rows:
  // what's most regular, where the app gets opened, and what's used a lot but
  // only reachable through the More menu / in-page links.
  const insights = useMemo(() => {
    if (!pages.length) return null;
    const regular = pages.slice(0, 3).map((p) => labelFor(p.pageKey));
    const opens = [...pages]
      .filter((p) => (p.sources?.load || 0) > 0)
      .sort((a, b) => (b.sources?.load || 0) - (a.sources?.load || 0))
      .slice(0, 3)
      .map((p) => labelFor(p.pageKey));
    const buried = pages
      .filter((p) => {
        const top = topSource(p.sources);
        return top === "more" || top === "in-app";
      })
      .slice(0, 3)
      .map((p) => labelFor(p.pageKey));
    return { regular, opens, buried };
    // labelFor reads only the mount-stable labelMap memo, so pages is the
    // one real input here.
  }, [pages]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: D.heading, margin: 0 }}>
          Portal Usage
        </h2>
        <p style={{ fontSize: 14, color: D.muted, margin: "6px 0 0", maxWidth: 640 }}>
          Which admin pages actually get used, how regularly, and how you reach
          them — collected privately in your own database (page names only,
          never customer data). Use it to decide what deserves the dashboard
          and the mobile tabs.
        </p>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        {WINDOWS.map((w) => (
          <button
            key={w.days}
            type="button"
            onClick={() => setDays(w.days)}
            style={pillStyle(days === w.days)}
          >
            {w.label}
          </button>
        ))}
        {canAdmin && (
          <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
            <button
              type="button"
              onClick={() => setScope("me")}
              style={pillStyle(scope === "me")}
            >
              Just me
            </button>
            <button
              type="button"
              onClick={() => setScope("all")}
              style={pillStyle(scope === "all")}
            >
              Everyone
            </button>
          </div>
        )}
      </div>

      {loading && (
        <div style={{ color: D.muted, fontSize: 14, padding: "24px 0" }}>
          Loading usage…
        </div>
      )}

      {!loading && error && (
        <div style={{ color: D.muted, fontSize: 14, padding: "24px 0" }}>
          {isRateLimitError(error)
            ? "Too many requests — wait a few seconds and switch the window again."
            : "Couldn't load usage data. Try again in a moment."}
        </div>
      )}

      {!loading && !error && !pages.length && (
        <div
          style={{
            background: D.card,
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            padding: 24,
            fontSize: 14,
            color: D.muted,
          }}
        >
          Nothing recorded in this window yet. Tracking starts the moment this
          feature is live — browse the portal normally for a week or two, then
          come back to see real patterns.
        </div>
      )}

      {!loading && !error && pages.length > 0 && (
        <>
          <div style={{ fontSize: 13, color: D.muted, marginBottom: 12 }}>
            <span style={{ fontFamily: MONO }}>{data.totals.views}</span> page
            views across{" "}
            <span style={{ fontFamily: MONO }}>{data.totals.activeDays}</span>{" "}
            active {data.totals.activeDays === 1 ? "day" : "days"} in the last{" "}
            {data.windowDays} days
            {scope === "all" && data.users?.length ? (
              <>
                {" · "}
                {data.users
                  .map((u) => `${u.name || "Unknown"} (${u.views})`)
                  .join(", ")}
              </>
            ) : null}
          </div>

          {insights && (
            <div
              style={{
                background: D.card,
                border: `1px solid ${D.border}`,
                borderRadius: 8,
                padding: "14px 16px",
                marginBottom: 16,
                display: "grid",
                gap: 6,
              }}
            >
              <div style={{ fontSize: 14, color: D.text }}>
                <strong style={{ fontWeight: 600 }}>Most regular:</strong>{" "}
                {insights.regular.join(", ")}
              </div>
              {insights.opens.length > 0 && (
                <div style={{ fontSize: 14, color: D.text }}>
                  <strong style={{ fontWeight: 600 }}>App opens land on:</strong>{" "}
                  {insights.opens.join(", ")}
                </div>
              )}
              {insights.buried.length > 0 && (
                <div style={{ fontSize: 14, color: D.text }}>
                  <strong style={{ fontWeight: 600 }}>
                    Used often but not in the nav you tap:
                  </strong>{" "}
                  {insights.buried.join(", ")} — candidates for a promotion to
                  the dashboard or tab bar.
                </div>
              )}
            </div>
          )}

          <div
            style={{
              background: D.card,
              border: `1px solid ${D.border}`,
              borderRadius: 8,
              overflowX: "auto",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
              <thead>
                <tr>
                  {[
                    "Page",
                    "Views",
                    "Days used",
                    "Top tab",
                    "Reached via",
                    "Last used",
                  ].map((h, i) => (
                    <th
                      key={h}
                      style={{
                        textAlign: i === 1 || i === 2 ? "right" : "left",
                        fontSize: 12,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        fontWeight: 500,
                        color: D.muted,
                        padding: "10px 14px",
                        borderBottom: `1px solid ${D.border}`,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pages.map((p) => {
                  const top = topSource(p.sources);
                  return (
                    <tr key={p.pageKey}>
                      <td
                        style={{
                          fontSize: 14,
                          color: D.text,
                          fontWeight: 500,
                          padding: "10px 14px",
                          borderBottom: `1px solid ${D.border}`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {labelFor(p.pageKey)}
                      </td>
                      <td
                        style={{
                          fontSize: 14,
                          fontFamily: MONO,
                          color: D.text,
                          textAlign: "right",
                          padding: "10px 14px",
                          borderBottom: `1px solid ${D.border}`,
                        }}
                      >
                        {p.views}
                      </td>
                      <td
                        style={{
                          fontSize: 14,
                          fontFamily: MONO,
                          color: D.text,
                          textAlign: "right",
                          padding: "10px 14px",
                          borderBottom: `1px solid ${D.border}`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.activeDays} of {data.windowDays}
                      </td>
                      <td
                        style={{
                          fontSize: 14,
                          color: D.muted,
                          padding: "10px 14px",
                          borderBottom: `1px solid ${D.border}`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.tabs?.length ? p.tabs[0].tab : "—"}
                      </td>
                      <td
                        style={{
                          fontSize: 14,
                          color: D.muted,
                          padding: "10px 14px",
                          borderBottom: `1px solid ${D.border}`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {top ? SOURCE_LABELS[top] || top : "—"}
                      </td>
                      <td
                        style={{
                          fontSize: 14,
                          color: D.muted,
                          padding: "10px 14px",
                          borderBottom: `1px solid ${D.border}`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {relativeTime(p.lastUsed)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p style={{ fontSize: 13, color: D.muted, marginTop: 12, maxWidth: 640 }}>
            Ranked by days used, then views — regular daily pages float to the
            top even when a one-off deep dive racks up more clicks.
          </p>
        </>
      )}
    </div>
  );
}
