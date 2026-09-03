// @vitest-environment jsdom
// Tree & Shrub program + access selects (estimator pricing audit INP-004):
// the builder used to hardcode the 6x program with easy access, so the 9x
// program was unsellable from the admin path and access minutes never
// priced. Both selects exist ONLY while Tree & Shrub is selected, default to
// the mandated standard/easy, and the program names are application counts
// (owner directive 2026-08-04 — no Standard/Enhanced/Premium names).
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

function jsonResponse(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    clone() {
      return this;
    },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function findCheckboxByLabel(container, re) {
  const label = Array.from(container.querySelectorAll("label")).find((el) =>
    re.test(el.textContent || ""),
  );
  return label ? label.querySelector('input[type="checkbox"]') : null;
}

function findSelectWithOption(container, value) {
  return Array.from(container.querySelectorAll("select")).find((sel) =>
    Array.from(sel.options).some((o) => o.value === value),
  );
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const path = String(url);
      if (path.includes("/admin/discounts")) return jsonResponse([]);
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("tree & shrub program and access selects", () => {
  it("render only while Tree & Shrub is selected, default standard/easy, and offer the 9x program", async () => {
    const { container } = render(
      <MemoryRouter>
        <EstimateToolViewV2 />
      </MemoryRouter>,
    );

    let tsBox;
    await waitFor(() => {
      tsBox = findCheckboxByLabel(container, /^\s*Tree & Shrub\s*$/);
      expect(tsBox).toBeTruthy();
    });
    expect(tsBox.checked).toBe(false);
    expect(findSelectWithOption(container, "enhanced")).toBeUndefined();
    expect(findSelectWithOption(container, "difficult")).toBeUndefined();

    fireEvent.click(tsBox);

    let program;
    let access;
    await waitFor(() => {
      program = findSelectWithOption(container, "enhanced");
      access = findSelectWithOption(container, "difficult");
      expect(program).toBeTruthy();
      expect(access).toBeTruthy();
    });

    expect(Array.from(program.options).map((o) => o.value)).toEqual([
      "light",
      "standard",
      "enhanced",
    ]);
    expect(Array.from(program.options).map((o) => o.textContent)).toEqual([
      "4x applications/yr",
      "6x applications/yr",
      "9x applications/yr",
    ]);
    expect(program.value).toBe("standard");
    expect(Array.from(access.options).map((o) => o.value)).toEqual([
      "easy",
      "moderate",
      "difficult",
    ]);
    expect(access.value).toBe("easy");

    fireEvent.change(program, { target: { value: "enhanced" } });
    fireEvent.change(access, { target: { value: "moderate" } });
    expect(program.value).toBe("enhanced");
    expect(access.value).toBe("moderate");

    // Commercial estimates price through the commercial ornamental pricer
    // (fixed cadence, no access term) — the controls must not render there.
    const commercial = findSelectWithOption(container, "YES");
    expect(commercial).toBeTruthy();
    fireEvent.change(commercial, { target: { value: "YES" } });
    await waitFor(() => {
      expect(findSelectWithOption(container, "enhanced")).toBeUndefined();
    });
    fireEvent.change(commercial, { target: { value: "NO" } });
    await waitFor(() => {
      expect(findSelectWithOption(container, "enhanced")).toBeTruthy();
    });

    // Deselecting the service hides the controls again.
    fireEvent.click(tsBox);
    await waitFor(() => {
      expect(findSelectWithOption(container, "enhanced")).toBeUndefined();
    });
  });
});
