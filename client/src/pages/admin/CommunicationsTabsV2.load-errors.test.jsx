// @vitest-environment jsdom
// Communications Templates + CSR Coach: a failed load or action says so
// instead of rendering zeros, an empty queue or an unchanged switch.
// Synthetic data only; fetch is stubbed, nothing is sent anywhere.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CSRCoachTabV2, SmsTemplatesTabV2 } from "./CommunicationsTabsV2";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const pathOf = (url) => new URL(String(url), "http://localhost").pathname;

function stubFetch(handler) {
  const calls = [];
  global.fetch = vi.fn((url, options = {}) => {
    const entry = { path: pathOf(url), method: options.method || "GET", body: options.body };
    calls.push(entry);
    return Promise.resolve(handler(entry));
  });
  return calls;
}

const countCalls = (calls, path, method = "GET") =>
  calls.filter((c) => c.path === path && c.method === method).length;

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "synthetic-token");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.restoreAllMocks();
});

const template = {
  id: 7,
  template_key: "synthetic_reminder",
  name: "Synthetic reminder",
  category: "reminders",
  body: "Hello {first_name}",
  is_active: true,
  can_delete: false,
};

describe("SMS templates load failures", () => {
  it("shows an error with retry instead of a zero count, then lists templates on retry", async () => {
    let listUp = false;
    const calls = stubFetch(({ path }) => {
      if (path === "/api/admin/sms-templates") {
        return listUp ? json({ templates: [template] }) : json({ error: "synthetic outage" }, 503);
      }
      return json({ issues: [] });
    });

    render(<SmsTemplatesTabV2 />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("SMS templates could not load");
    expect(screen.queryByText("SMS Templates")).not.toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();

    listUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Synthetic reminder")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(countCalls(calls, "/api/admin/sms-templates")).toBe(2);
  });

  it("keeps known templates when a retry fails again", async () => {
    let attempt = 0;
    stubFetch(({ path }) => {
      if (path === "/api/admin/sms-templates") {
        attempt += 1;
        if (attempt === 1) return json({ error: "down" }, 503);
        if (attempt === 2) return json({ templates: [template] });
        return json({ error: "down again" }, 503);
      }
      return json({ issues: [] });
    });

    render(<SmsTemplatesTabV2 />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Synthetic reminder");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the server error and leaves the switch alone when a toggle fails", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = stubFetch(({ path, method }) => {
      if (path === "/api/admin/sms-templates" && method === "GET") return json({ templates: [template] });
      if (path === "/api/admin/sms-templates/7" && method === "PUT") {
        return gate.then(() => json({ error: "Template is locked" }, 409));
      }
      return json({ issues: [] });
    });

    render(<SmsTemplatesTabV2 />);
    const toggle = await screen.findByRole("switch", { name: "Disable Synthetic reminder" });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(countCalls(calls, "/api/admin/sms-templates/7", "PUT")).toBe(1);

    await act(async () => { release(); });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not update Synthetic reminder: Template is locked");
    expect(toggle).toBeEnabled();
    expect(toggle).toBeChecked();
  });

  it("says issues are unavailable when the issues read fails", async () => {
    stubFetch(({ path }) => {
      if (path === "/api/admin/sms-templates") return json({ templates: [template] });
      return json({ error: "issues down" }, 500);
    });

    render(<SmsTemplatesTabV2 />);
    await screen.findByText("Synthetic reminder");
    expect(await screen.findByRole("alert")).toHaveTextContent("Recent template issues are unavailable");
  });

  it("shows a variants error and retries when the template is opened again", async () => {
    let variantsUp = false;
    const calls = stubFetch(({ path }) => {
      if (path === "/api/admin/sms-templates") return json({ templates: [template] });
      if (path === "/api/admin/sms-templates/synthetic_reminder/variants") {
        return variantsUp
          ? json({ variants: [{ id: 1, variant_key: "b", name: "Variant B", body: "B body", status: "active", weight: 1 }] })
          : json({ error: "variants down" }, 500);
      }
      return json({ issues: [] });
    });

    render(<SmsTemplatesTabV2 />);
    await screen.findByText("Synthetic reminder");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByText(/Variants could not load: variants down/)).toBeInTheDocument();
    expect(screen.queryByText(/No active SMS variants/)).not.toBeInTheDocument();

    // Close and open again: the failure was not cached as an empty list.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    variantsUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Variant B")).toBeInTheDocument();
    expect(screen.queryByText(/Variants could not load/)).not.toBeInTheDocument();
    expect(countCalls(calls, "/api/admin/sms-templates/synthetic_reminder/variants")).toBe(2);
  });
});

const futureIso = new Date(Date.now() + 86400000).toISOString();
const pastIso = new Date(Date.now() - 86400000).toISOString();
const taskRow = (id, extra = {}) => ({
  id,
  status: "pending",
  deadline: futureIso,
  assigned_to: "Synthetic CSR",
  task_type: "call_back",
  recommended_action: `Action ${id}`,
  first_name: `First${id}`,
  last_name: `Last${id}`,
  ...extra,
});

const coachBodies = {
  "/api/admin/csr/overview": { csrStats: [], teamTotals: { calls: 4, bookingRate: 50, avgScore: 10 } },
  "/api/admin/csr/weekly-recommendation": { recommendation: "Synthetic focus" },
  "/api/admin/csr/leaderboard": { categories: [], periodLabel: "synthetic period" },
  "/api/admin/csr/lead-quality": { lossReasons: [] },
};

function coachFetch({ tasks, failing = [], put, onTasksGet } = {}) {
  const down = new Set(failing);
  return stubFetch(({ path, method, body }) => {
    if (down.has(path)) return json({ error: "synthetic outage" }, 503);
    if (path === "/api/admin/csr/follow-up-tasks" && method === "GET") {
      return onTasksGet ? onTasksGet() : json(tasks);
    }
    if (path.startsWith("/api/admin/csr/follow-up-tasks/") && method === "PUT") return put(path, body);
    return json(coachBodies[path] || {});
  });
}

describe("CSR Coach load failures", () => {
  it("shows a tasks error with retry and no zero counts or empty-queue text", async () => {
    let tasksUp = false;
    const calls = coachFetch({
      onTasksGet: () => (tasksUp ? json({ tasks: [taskRow(1)], pending: 1, overdue: 0 }) : json({ error: "x" }, 503)),
    });

    render(<CSRCoachTabV2 />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Follow-up tasks could not load");
    expect(screen.queryByText("No pending follow-up tasks")).not.toBeInTheDocument();
    expect(screen.queryByText(/Pending:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Overdue:/)).not.toBeInTheDocument();

    tasksUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Action 1/)).toBeInTheDocument();
    expect(screen.getByText(/Pending:/)).toHaveTextContent("Pending: 1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Only the failed section is requested again.
    expect(countCalls(calls, "/api/admin/csr/follow-up-tasks")).toBe(2);
    expect(countCalls(calls, "/api/admin/csr/overview")).toBe(1);
  });

  it("shows a notice for each other failed section instead of dropping it, and keeps loaded ones", async () => {
    coachFetch({
      tasks: { tasks: [], pending: 0, overdue: 0 },
      failing: [
        "/api/admin/csr/overview",
        "/api/admin/csr/weekly-recommendation",
        "/api/admin/csr/leaderboard",
        "/api/admin/csr/lead-quality",
      ],
    });

    render(<CSRCoachTabV2 />);
    expect(await screen.findByText("No pending follow-up tasks")).toBeInTheDocument();
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent);
    expect(alerts).toHaveLength(4);
    expect(alerts.join(" ")).toMatch(/Team overview could not load/);
    expect(alerts.join(" ")).toMatch(/team focus could not load/);
    expect(alerts.join(" ")).toMatch(/Lead quality could not load/);
    expect(alerts.join(" ")).toMatch(/bonus leaderboard could not load/);
    expect(screen.queryByText("Team Overview (Last 30 Days)")).not.toBeInTheDocument();
  });
});

describe("CSR Coach task actions", () => {
  it("disables the task buttons during the PUT and keeps the task with the error when it fails", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = coachFetch({
      tasks: { tasks: [taskRow(1), taskRow(2)], pending: 2, overdue: 0 },
      put: () => gate.then(() => json({ error: "Task is locked" }, 409)),
    });

    render(<CSRCoachTabV2 />);
    await screen.findByText(/Action 1/);
    const [done1, done2] = screen.getAllByRole("button", { name: "Mark Done" });
    const [reassign1] = screen.getAllByRole("button", { name: "Reassign" });

    fireEvent.click(done1);
    await waitFor(() => expect(done1).toBeDisabled());
    expect(reassign1).toBeDisabled();
    expect(done2).toBeEnabled();

    await act(async () => { release(); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not update the task: Task is locked");
    expect(done1).toBeEnabled();
    expect(screen.getByText(/Action 1/)).toBeInTheDocument();
    expect(countCalls(calls, "/api/admin/csr/follow-up-tasks")).toBe(1);
  });

  it("applies the saved task locally when the refresh fails, recomputes counts, and recovers on retry", async () => {
    let refreshUp = false;
    const open = [taskRow(1), taskRow(2, { deadline: pastIso })];
    const calls = coachFetch({
      onTasksGet: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return json({ tasks: open, pending: 1, overdue: 1 });
          }
          return refreshUp ? json({ tasks: [open[1]], pending: 0, overdue: 1 }) : json({ error: "x" }, 503);
        };
      })(),
      // The PUT answers the bare row, without the joined customer names.
      put: (path) => json({ task: { id: 1, status: "completed", assigned_to: "Synthetic CSR" } }),
    });

    render(<CSRCoachTabV2 />);
    await screen.findByText(/Action 1/);
    expect(screen.getByText(/Pending:/)).toHaveTextContent("Pending: 1");

    fireEvent.click(screen.getAllByRole("button", { name: "Mark Done" })[0]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The task list could not refresh");
    expect(screen.queryByText(/Action 1/)).not.toBeInTheDocument();
    expect(screen.getByText(/Action 2/)).toBeInTheDocument();
    expect(screen.getByText(/Pending:/)).toHaveTextContent("Pending: 0");
    expect(screen.getByText(/Overdue:/)).toHaveTextContent("Overdue: 1");

    refreshUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(countCalls(calls, "/api/admin/csr/follow-up-tasks")).toBe(3);
  });

  it("merges the returned task over the old row so the customer name stays, before the refresh lands", async () => {
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    let first = true;
    coachFetch({
      onTasksGet: () => {
        if (first) {
          first = false;
          return json({ tasks: [taskRow(1)], pending: 1, overdue: 0 });
        }
        return refreshGate.then(() => json({ tasks: [taskRow(1, { status: "in_progress" })], pending: 0, overdue: 0 }));
      },
      put: () => json({ task: { id: 1, status: "in_progress", assigned_to: "Synthetic Tech" } }),
    });

    render(<CSRCoachTabV2 />);
    await screen.findByText(/Action 1/);
    fireEvent.click(screen.getByRole("button", { name: "Reassign" }));

    // PUT is done, refresh still pending: the row already shows the saved
    // assignee and keeps the customer name that the PUT response lacks.
    const row = await screen.findByText(/Synthetic Tech/);
    expect(row).toHaveTextContent("First1 Last1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => { releaseRefresh(); });
    await waitFor(() => expect(screen.getByRole("button", { name: "Reassign" })).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
