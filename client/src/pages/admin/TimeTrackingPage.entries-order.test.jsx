// @vitest-environment jsdom
// A slow entries response for an earlier filter must not replace the rows for
// the filter the operator selected last.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntriesTab } from "./TimeTrackingPage";

const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const row = (id, tech_name) => ({ id, tech_name, entry_type: "shift", status: "completed", duration_minutes: 480 });

beforeEach(() => {
  vi.stubGlobal("React", React);
  localStorage.setItem("waves_admin_token", "synthetic-token");
  localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

describe("entries load order", () => {
  it("keeps the newer technician's rows when an older response lands late", async () => {
    let finishA;
    const delayedA = new Promise((resolve) => { finishA = resolve; });
    const toast = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const parsed = new URL(String(url), "http://localhost");
      if (parsed.pathname.endsWith("/entries")) {
        const tech = parsed.searchParams.get("technicianId");
        if (tech === "tech-a") return delayedA;
        return response({ entries: tech === "tech-b" ? [row("entry-b", "B entry")] : [], total: tech ? 1 : 0 });
      }
      return response({ allTechs: [{ id: "tech-a", name: "Tech A" }, { id: "tech-b", name: "Tech B" }] });
    }));
    render(<EntriesTab showToast={toast} />);
    await screen.findByRole("option", { name: "Tech A" });
    await screen.findByText("No entries found");
    const filter = screen.getAllByRole("combobox")[0];
    fireEvent.change(filter, { target: { value: "tech-a" } });
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes("technicianId=tech-a"))).toBe(true));
    fireEvent.change(filter, { target: { value: "tech-b" } });
    await screen.findByText("B entry");
    await act(async () => { finishA(response({ entries: [row("entry-a", "A entry")], total: 1 })); });
    expect(filter).toHaveValue("tech-b");
    expect(screen.getByText("B entry")).toBeInTheDocument();
    expect(screen.queryByText("A entry")).not.toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not toast a failure from an older request", async () => {
    let failA;
    const delayedA = new Promise((_, reject) => { failA = reject; });
    const toast = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const parsed = new URL(String(url), "http://localhost");
      if (parsed.pathname.endsWith("/entries")) {
        const tech = parsed.searchParams.get("technicianId");
        if (tech === "tech-a") return delayedA;
        return response({ entries: tech === "tech-b" ? [row("entry-b", "B entry")] : [], total: tech ? 1 : 0 });
      }
      return response({ allTechs: [{ id: "tech-a", name: "Tech A" }, { id: "tech-b", name: "Tech B" }] });
    }));
    render(<EntriesTab showToast={toast} />);
    await screen.findByRole("option", { name: "Tech A" });
    await screen.findByText("No entries found");
    const filter = screen.getAllByRole("combobox")[0];
    fireEvent.change(filter, { target: { value: "tech-a" } });
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes("technicianId=tech-a"))).toBe(true));
    fireEvent.change(filter, { target: { value: "tech-b" } });
    await screen.findByText("B entry");
    await act(async () => { failA(new Error("older request failed")); });
    expect(toast).not.toHaveBeenCalled();
    expect(screen.getByText("B entry")).toBeInTheDocument();
  });
});
