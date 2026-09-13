/*
 * PortalUsageTab — Settings → Advanced → Portal Usage.
 * Reads the first-party page-view log written by AdminLayoutV2.
 */
import React, { useEffect, useMemo, useState } from "react";
import { adminFetch, isRateLimitError } from "../../utils/admin-fetch";
import { ADMIN_NAV_ITEMS } from "../../config/adminNavigation";
import {
  ActionFeedback,
  Button,
  Card,
  CardBody,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  UiSurface,
} from "../ui";

const WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const SOURCE_LABELS = {
  sidebar: "Sidebar",
  tabbar: "Tab bar",
  more: "Settings tab",
  palette: "Palette",
  load: "App open",
  "in-app": "In-app link",
};

const EXTRA_LABELS = {
  dispatch: "Dispatch",
  schedule: "Schedule",
  more: "Settings tab",
  leads: "Leads",
  estimates: "Estimates",
};

function buildLabelMap() {
  const map = Object.assign(Object.create(null), EXTRA_LABELS);
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
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function relativeTime(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function topSource(sources) {
  const entries = Object.entries(sources || {});
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
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
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setLoading(false);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope]);

  const pages = data?.pages || [];
  const insights = useMemo(() => {
    if (!pages.length) return null;
    const regular = pages.slice(0, 3).map((page) => labelFor(page.pageKey));
    const opens = [...pages]
      .filter((page) => (page.sources?.load || 0) > 0)
      .sort((a, b) => (b.sources?.load || 0) - (a.sources?.load || 0))
      .slice(0, 3)
      .map((page) => labelFor(page.pageKey));
    const buried = pages
      .filter((page) => {
        const top = topSource(page.sources);
        return top === "more" || top === "in-app";
      })
      .slice(0, 3)
      .map((page) => labelFor(page.pageKey));
    return { regular, opens, buried };
  }, [pages]);

  return (
    <UiSurface className="space-y-5">
      <div>
        <h2 className="text-18 leading-[1.35] font-medium text-zinc-900">Portal usage</h2>
        <p className="mt-1 max-w-2xl text-ui-body text-ink-secondary">
          Which admin pages actually get used, how regularly, and how you reach
          them — collected privately in your own database (page names only,
          never customer data). Use it to decide what deserves the dashboard
          and the mobile tabs.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {WINDOWS.map((window) => (
          <Button
            key={window.days}
            variant={days === window.days ? "primary" : "secondary"}
            aria-pressed={days === window.days}
            onClick={() => setDays(window.days)}
          >
            {window.label}
          </Button>
        ))}
        {canAdmin && (
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Button variant={scope === "me" ? "primary" : "secondary"} aria-pressed={scope === "me"} onClick={() => setScope("me")}>
              Just me
            </Button>
            <Button variant={scope === "all" ? "primary" : "secondary"} aria-pressed={scope === "all"} onClick={() => setScope("all")}>
              Everyone
            </Button>
          </div>
        )}
      </div>

      {loading && <ActionFeedback className="min-h-20">Loading usage…</ActionFeedback>}
      {!loading && error && (
        <ActionFeedback error>
          {isRateLimitError(error)
            ? "Too many requests — wait a few seconds and switch the window again."
            : "Couldn't load usage data. Try again in a moment."}
        </ActionFeedback>
      )}
      {!loading && !error && !pages.length && (
        <Card>
          <CardBody className="py-8 text-center text-ink-secondary">
            Nothing recorded in this window yet. Tracking starts the moment this
            feature is live — browse the portal normally for a week or two, then
            come back to see real patterns.
          </CardBody>
        </Card>
      )}

      {!loading && !error && pages.length > 0 && (
        <>
          <p className="text-ui-body text-ink-secondary u-nums">
            {data.totals.views} page views across {data.totals.activeDays} active{" "}
            {data.totals.activeDays === 1 ? "day" : "days"} in the last {data.windowDays} days
            {scope === "all" && data.users?.length
              ? ` · ${data.users.map((user) => `${user.name || "Unknown"} (${user.views})`).join(", ")}`
              : null}
          </p>

          {insights && (
            <Card>
              <CardBody className="space-y-2">
                <p><span className="font-medium">Most regular:</span> {insights.regular.join(", ")}</p>
                {insights.opens.length > 0 && (
                  <p><span className="font-medium">App opens land on:</span> {insights.opens.join(", ")}</p>
                )}
                {insights.buried.length > 0 && (
                  <p>
                    <span className="font-medium">Used often but not in the nav you tap:</span>{" "}
                    {insights.buried.join(", ")} — candidates for a promotion to the dashboard or tab bar.
                  </p>
                )}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardBody className="p-0">
              <Table className="min-w-[640px]" aria-label="Portal usage">
                <THead>
                  <TR>
                    <TH>Page</TH>
                    <TH align="right">Views</TH>
                    <TH align="right">Days used</TH>
                    <TH>Top tab</TH>
                    <TH>Reached via</TH>
                    <TH>Last used</TH>
                  </TR>
                </THead>
                <TBody>
                  {pages.map((page) => {
                    const top = topSource(page.sources);
                    return (
                      <TR key={page.pageKey}>
                        <TD className="font-medium whitespace-nowrap">{labelFor(page.pageKey)}</TD>
                        <TD align="right" nums>{page.views}</TD>
                        <TD align="right" nums className="whitespace-nowrap">{page.activeDays} of {data.windowDays}</TD>
                        <TD className="whitespace-nowrap text-ink-secondary">{page.tabs?.length ? page.tabs[0].tab : "—"}</TD>
                        <TD className="whitespace-nowrap text-ink-secondary">{top ? SOURCE_LABELS[top] || top : "—"}</TD>
                        <TD className="whitespace-nowrap text-ink-secondary">{relativeTime(page.lastUsed)}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </CardBody>
          </Card>

          <p className="max-w-2xl text-ui-body text-ink-secondary">
            Ranked by days used, then views — regular daily pages float to the
            top even when a one-off deep dive racks up more clicks.
          </p>
        </>
      )}
    </UiSurface>
  );
}
