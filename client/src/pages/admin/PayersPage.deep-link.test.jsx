// @vitest-environment jsdom
// /admin/payers?payer=<id> (from an invoice row) opens that payer's sheet once
// and drops the param so a refresh or Back does not reopen it.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PayersPage from "./PayersPage";

const payer = { id: 42, display_name: "Example Payer HOA", name: "Example Payer HOA", active: true };
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
let calls;

function Probe() {
  const location = useLocation();
  return <div data-testid="search">{location.search}</div>;
}

beforeEach(() => {
  calls = [];
  localStorage.setItem("waves_admin_token", "test-token");
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/admin/payers/42")) return ok({ payer, statements: [] });
    if (u.includes("/admin/payers?")) return ok({ payers: [] });
    return ok({});
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("PayersPage ?payer= deep link", () => {
  it("opens the payer detail sheet and removes the param", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/payers?payer=42&keep=1"]}>
        <PayersPage />
        <Probe />
      </MemoryRouter>,
    );
    await waitFor(() => expect(calls.some((u) => u.includes("/admin/payers/42"))).toBe(true));
    expect(await screen.findAllByText(/Example Payer HOA/)).not.toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent("?keep=1"));
    expect(calls.filter((u) => u.endsWith("/admin/payers/42"))).toHaveLength(1);
  });

  it("does nothing without the param", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/payers"]}>
        <PayersPage />
        <Probe />
      </MemoryRouter>,
    );
    await waitFor(() => expect(calls.some((u) => u.includes("/admin/payers?"))).toBe(true));
    expect(calls.some((u) => u.includes("/admin/payers/42"))).toBe(false);
  });
});
