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

it("discards a stale template detail response when switching templates quickly", async () => {
  let resolveFirst;
  const tplA = { id: "t-a", template_key: "tpl_a", name: "Template A", mode: "service", status: "active" };
  const tplB = { id: "t-b", template_key: "tpl_b", name: "Template B", mode: "service", status: "active" };
  vi.stubGlobal("fetch", vi.fn((url) => {
    const u = String(url);
    if (u.endsWith("/admin/email-templates")) {
      return Promise.resolve({ ok: true, json: async () => ({ templates: [tplA, tplB] }) });
    }
    if (u.endsWith("/preference-groups")) {
      return Promise.resolve({ ok: true, json: async () => ({ groups: [] }) });
    }
    if (u.endsWith("/admin/email-templates/tpl_a")) {
      return new Promise((resolve) => { resolveFirst = resolve; });
    }
    if (u.endsWith("/admin/email-templates/tpl_b")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          template: tplB,
          versions: [{ id: "v-b", version_number: 1, status: "draft", subject: "Subject B", blocks: [] }],
          fixtures: [],
        }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  }));

  render(<EmailTemplatesPanelV2 />);
  fireEvent.click(await screen.findByText("Template B"));
  expect(await screen.findByDisplayValue("Subject B")).toBeInTheDocument();

  await act(async () => resolveFirst({
    ok: true,
    json: async () => ({
      template: tplA,
      versions: [{ id: "v-a", version_number: 1, status: "draft", subject: "Subject A", blocks: [] }],
      fixtures: [],
    }),
  }));

  expect(screen.getByDisplayValue("Subject B")).toBeInTheDocument();
  expect(screen.queryByDisplayValue("Subject A")).not.toBeInTheDocument();
});

it("clears previous template settings and disables writes while switching templates or after a detail load failure", async () => {
  const tplA = { id: "t-a", template_key: "tpl_a", name: "Template A", mode: "service", status: "active" };
  const tplB = { id: "t-b", template_key: "tpl_b", name: "Template B", mode: "service", status: "active" };
  let rejectB;
  const fetchMock = vi.fn((url, opts) => {
    const u = String(url);
    if (u.endsWith("/admin/email-templates")) {
      return Promise.resolve({ ok: true, json: async () => ({ templates: [tplA, tplB] }) });
    }
    if (u.endsWith("/preference-groups")) {
      return Promise.resolve({ ok: true, json: async () => ({ groups: [] }) });
    }
    if (u.endsWith("/admin/email-templates/tpl_a") && (!opts || !opts.method || opts.method === "GET")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          template: tplA,
          versions: [{ id: "v-a", version_number: 1, status: "draft", subject: "Subject A", blocks: [] }],
          fixtures: [{ id: "f-a", name: "Fixture A", payload: { first_name: "Ada" }, is_default: true }],
        }),
      });
    }
    if (u.endsWith("/admin/email-templates/tpl_b") && (!opts || !opts.method || opts.method === "GET")) {
      return new Promise((_, reject) => { rejectB = reject; });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(<EmailTemplatesPanelV2 />);
  expect(await screen.findByDisplayValue("Subject A")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();

  fireEvent.click(screen.getByText("Template B"));

  // Immediately after selecting B, A's settings and draft are cleared and write buttons are disabled.
  expect(screen.queryByDisplayValue("Subject A")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New draft" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Send test" })).toBeDisabled();

  await act(async () => rejectB(new Error("Detail load failed")));
  expect(await screen.findByText(/Template load failed: Detail load failed/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save settings" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New draft" })).toBeDisabled();
  expect(fetchMock.mock.calls.some(([u, o]) => String(u).includes("/tpl_b") && o?.method === "PUT")).toBe(false);
});
