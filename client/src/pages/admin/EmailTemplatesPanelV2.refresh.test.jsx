// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
