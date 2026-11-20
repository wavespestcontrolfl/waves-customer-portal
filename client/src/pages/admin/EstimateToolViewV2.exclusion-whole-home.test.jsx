// @vitest-environment jsdom
// GATE_EXCLUSION_WHOLE_HOME: the rodent exclusion section offers a Seal scope choice (Spot seal /
// Whole home) only while the server says the gate is on (exclusionWholeHome: true on the
// rodent_waveguard row). Whole home shows the point checklist and the included-guarantee note.
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

function stubFetch(waveguardRow) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const path = String(url);
      if (path.includes("/admin/discounts")) return jsonResponse([]);
      if (path.includes("/admin/pricing-config/rodent_waveguard")) return jsonResponse(waveguardRow);
      return jsonResponse({});
    }),
  );
}

async function openExclusion(waveguardRow) {
  stubFetch(waveguardRow);
  const view = render(
    <MemoryRouter>
      <EstimateToolViewV2 />
    </MemoryRouter>,
  );
  fireEvent.click(findCheckboxByLabel(view.container, /Rodent Exclusion Service/));
  return view;
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "test-token");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Whole-home rodent seal choice", () => {
  it("shows the Seal scope choice, defaulting to Spot, while the gate is on", async () => {
    const { container } = await openExclusion({ data: {}, exclusionWholeHome: true });
    await waitFor(() => expect(container.querySelector("#estimate-exclSealScope")).toBeTruthy());
    expect(container.querySelector("#estimate-exclSealScope").value).toBe("spot");
    expect(container.querySelector('[data-testid="exclusion-whole-home"]')).toBeNull();
  });

  it("Whole home shows the point checklist and the included guarantee", async () => {
    const { container, findByTestId } = await openExclusion({ data: {}, exclusionWholeHome: true });
    await waitFor(() => expect(container.querySelector("#estimate-exclSealScope")).toBeTruthy());
    fireEvent.change(container.querySelector("#estimate-exclSealScope"), { target: { value: "whole_home" } });
    expect(await findByTestId("exclusion-guarantee-note")).toHaveTextContent(/1-year re-entry guarantee included/);
    expect(findCheckboxByLabel(container, /Roof returns and joints/)).toBeTruthy();
    expect(findCheckboxByLabel(container, /Other utility penetrations/)).toBeTruthy();
    const eave = findCheckboxByLabel(container, /Eave gaps/);
    fireEvent.click(eave);
    expect(findCheckboxByLabel(container, /Eave gaps/).checked).toBe(true);
  });

  it("hides the choice when the gate is off, the row is missing or the read fails", async () => {
    for (const row of [{ data: {} }, { data: {}, exclusionWholeHome: false }]) {
      cleanup();
      const { container } = await openExclusion(row);
      await waitFor(() => expect(findCheckboxByLabel(container, /Rodent Exclusion Service/)).toBeTruthy());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(container.querySelector("#estimate-exclSealScope")).toBeNull();
    }
  });
});
