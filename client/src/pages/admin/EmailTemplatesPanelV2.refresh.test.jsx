// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import EmailTemplatesPanelV2 from "./EmailTemplatesPanelV2";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("refreshes send history without hiding it, and offers Retry after a failed background read", async () => {
  let finish;
  let reads = 0;
  const message = { id: "fixture-message", subject_snapshot: "Synthetic delivery", status: "delivered" };
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).includes("send-history")) {
      reads += 1;
      if (reads === 2) return new Promise((resolve) => { finish = resolve; });
      return { ok: true, json: async () => ({ messages: [message] }) };
    }
    return { ok: true, json: async () => ({ templates: [], groups: [] }) };
  }));
  render(<EmailTemplatesPanelV2 />);
  fireEvent.click(await screen.findByRole("button", { name: "Send History" }));
  await screen.findByText("Synthetic delivery");
  expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(screen.getByText("Synthetic delivery")).toBeInTheDocument();
  await act(async () => finish({ ok: false, status: 503, json: async () => ({ error: "History unavailable" }) }));
  expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
  expect(screen.getByText("Synthetic delivery")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await act(async () => {});
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(reads).toBe(3);
});

it.each([
  {
    button: "Send History",
    endpoint: "send-history",
    oldPayload: { messages: [{ id: "old-message", subject_snapshot: "Older history" }] },
    newPayload: { messages: [{ id: "new-message", subject_snapshot: "Newer history" }] },
    oldText: "Older history",
    newText: "Newer history",
  },
  {
    button: "Issues",
    endpoint: "/issues?",
    oldPayload: { issues: [{ id: "old-issue", reason: "Older issue" }] },
    newPayload: { issues: [{ id: "new-issue", reason: "Newer issue" }] },
    oldText: "Older issue",
    newText: "Newer issue",
  },
  {
    button: "Deliverability",
    endpoint: "/deliverability",
    oldPayload: { health: { total_messages: 111 } },
    newPayload: { health: { total_messages: 222 } },
    oldText: "111",
    newText: "222",
  },
])("keeps the newer $button read when an older background response resolves last", async ({ button, endpoint, oldPayload, newPayload, oldText, newText }) => {
  let finishOlder;
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).includes(endpoint)) {
      reads += 1;
      if (reads === 1) return { ok: true, json: async () => oldPayload };
      if (reads === 2) return new Promise((resolve) => { finishOlder = resolve; });
      return { ok: true, json: async () => newPayload };
    }
    return { ok: true, json: async () => ({ templates: [], groups: [] }) };
  }));

  render(<EmailTemplatesPanelV2 />);
  fireEvent.click(await screen.findByRole("button", { name: button }));
  expect(await screen.findByText(oldText)).toBeInTheDocument();
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(reads).toBe(2));
  fireEvent.click(screen.getByRole("button", { name: "Templates" }));
  fireEvent.click(screen.getByRole("button", { name: button }));
  expect(await screen.findByText(newText)).toBeInTheDocument();

  await act(async () => finishOlder({ ok: true, json: async () => oldPayload }));
  expect(screen.getByText(newText)).toBeInTheDocument();
  expect(screen.queryByText(oldText)).not.toBeInTheDocument();
});

it.each([false, true])("finishes a foreground automation read superseded by focus (failure=%s)", async (fails) => {
  const pending = [];
  let racing = false;
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).includes("/runs?")) {
      if (racing) return new Promise((resolve) => pending.push(resolve));
      return { ok: true, json: async () => ({ runs: [] }) };
    }
    return { ok: true, json: async () => ({ templates: [], groups: [], automations: [{ automation_key: "fixture", name: "Fixture automation" }] }) };
  }));
  render(<EmailTemplatesPanelV2 />);
  fireEvent.click(await screen.findByRole("button", { name: "Automations", exact: true }));
  const runs = await screen.findByRole("button", { name: "Runs", exact: true });
  fireEvent.click(runs);
  await screen.findByText("Automation runs");
  await waitFor(() => expect(screen.queryByText("Loading automation runs...")).not.toBeInTheDocument());
  racing = true;
  act(() => { runs.click(); window.dispatchEvent(new Event("focus")); });
  expect(pending).toHaveLength(2);
  await act(async () => pending[0]({ ok: true, json: async () => ({ runs: [] }) }));
  expect(screen.getByText("Loading automation runs...")).toBeInTheDocument();
  await act(async () => pending[1](fails
    ? { ok: false, status: 503, json: async () => ({ error: "Runs unavailable" }) }
    : { ok: true, json: async () => ({ runs: [] }) }));
  expect(screen.queryByText("Loading automation runs...")).not.toBeInTheDocument();
  if (fails) expect(screen.getByRole("alert")).toHaveTextContent("Runs unavailable");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(pending).toHaveLength(3);
  await act(async () => pending[2]({ ok: true, json: async () => ({ runs: [] }) }));
});
