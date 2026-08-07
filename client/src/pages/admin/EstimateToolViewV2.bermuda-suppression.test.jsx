// @vitest-environment jsdom
// Bermuda-in-St.-Augustine suppression add-on: the checkbox is a lawn-block
// option that must exist ONLY for the St. Augustine track (the Recognition +
// Fusilade II 2(ee) is a remove-bermuda-FROM-St.-Augustine program — offering
// it on a bermuda/zoysia/bahia lawn would quote killing the customer's turf),
// and checking it must surface the eligibility copy the operator verifies
// before quoting (cultivar gates, 2-app season ceiling, torpedograss caveat).
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

function findGrassTypeSelect(container) {
  return Array.from(container.querySelectorAll("select")).find((sel) =>
    Array.from(sel.options).some((o) => o.value === "st_augustine"),
  );
}

function stubFetch({ gateOn }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const path = String(url);
      if (path.includes("/admin/discounts")) return jsonResponse([]);
      if (path.includes("/admin/pricing-config/lawn_pricing_v2")) {
        return jsonResponse(
          gateOn ? { subFeaturesAvailable: { bermudaSuppression: true } } : {},
        );
      }
      return jsonResponse({});
    }),
  );
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "test-token");
  stubFetch({ gateOn: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("bermudagrass suppression add-on checkbox", () => {
  it("never renders while GATE_BERMUDA_SUPPRESSION is off (server reports unavailable)", async () => {
    stubFetch({ gateOn: false });
    const { container } = render(
      <MemoryRouter>
        <EstimateToolViewV2 />
      </MemoryRouter>,
    );
    // Lawn block renders (svcLawn defaults on)...
    await waitFor(() => {
      expect(findGrassTypeSelect(container)).toBeTruthy();
    });
    // ...but the gated add-on control does not.
    expect(findCheckboxByLabel(container, /Bermudagrass suppression/)).toBeNull();
  });

  it("appears only for the St. Augustine track and shows the eligibility copy when checked", async () => {
    const { container } = render(
      <MemoryRouter>
        <EstimateToolViewV2 />
      </MemoryRouter>,
    );

    // The fresh form preselects Lawn Care (svcLawn: true) on the default
    // St. Augustine track, so the option is available immediately.
    const bsCheckbox = await waitFor(() => {
      const el = findCheckboxByLabel(container, /Bermudagrass suppression/);
      expect(el).toBeTruthy();
      return el;
    });

    // Eligibility copy only surfaces once the operator opts in.
    expect(container.textContent).not.toMatch(/Recognition \+ Fusilade II/);
    fireEvent.click(bsCheckbox);
    await waitFor(() => {
      expect(container.textContent).toMatch(/Recognition \+ Fusilade II/);
      expect(container.textContent).toMatch(/max 2 applications/i);
      expect(container.textContent).toMatch(/ProVista\/Captiva excluded/);
    });

    // Switching off the St. Augustine track removes the option entirely AND
    // clears the confirmation — a track round-trip must never restore a
    // checked add-on without fresh cultivar/season verification.
    const grassSelect = findGrassTypeSelect(container);
    expect(grassSelect).toBeTruthy();
    fireEvent.change(grassSelect, { target: { value: "bermuda" } });
    await waitFor(() => {
      expect(findCheckboxByLabel(container, /Bermudagrass suppression/)).toBeNull();
    });
    fireEvent.change(grassSelect, { target: { value: "st_augustine" } });
    await waitFor(() => {
      const el = findCheckboxByLabel(container, /Bermudagrass suppression/);
      expect(el).toBeTruthy();
      expect(el.checked).toBe(false);
    });
    fireEvent.change(grassSelect, { target: { value: "bermuda" } });
    await waitFor(() => {
      expect(findCheckboxByLabel(container, /Bermudagrass suppression/)).toBeNull();
    });

    // Identity change wipes the confirmation: the add-on's eligibility
    // (cultivar / season / turf stress / %-infestation) is per-lawn, so a
    // checked box must never carry over to a different property.
    fireEvent.change(grassSelect, { target: { value: "st_augustine" } });
    const bsAgain = await waitFor(() => {
      const el = findCheckboxByLabel(container, /Bermudagrass suppression/);
      expect(el).toBeTruthy();
      return el;
    });
    if (!bsAgain.checked) fireEvent.click(bsAgain);
    expect(bsAgain.checked).toBe(true);
    const addressInput = Array.from(container.querySelectorAll("input")).find(
      (el) => /^Start typing an address/.test(el.placeholder || ""),
    );
    expect(addressInput).toBeTruthy();
    fireEvent.change(addressInput, { target: { value: "123 Different Property Ln" } });
    await waitFor(() => {
      const el = findCheckboxByLabel(container, /Bermudagrass suppression/);
      expect(el).toBeTruthy();
      expect(el.checked).toBe(false);
    });

    // And deselecting the lawn service removes it too (back on St. Augustine).
    fireEvent.change(grassSelect, { target: { value: "st_augustine" } });
    await waitFor(() => {
      expect(findCheckboxByLabel(container, /Bermudagrass suppression/)).toBeTruthy();
    });
    const lawnCheckbox = findCheckboxByLabel(container, /^\s*Lawn Care\s*$/);
    expect(lawnCheckbox).toBeTruthy();
    const bsBeforeDeselect = findCheckboxByLabel(container, /Bermudagrass suppression/);
    if (!bsBeforeDeselect.checked) fireEvent.click(bsBeforeDeselect);
    fireEvent.click(lawnCheckbox);
    await waitFor(() => {
      expect(findCheckboxByLabel(container, /Bermudagrass suppression/)).toBeNull();
    });

    // Reselecting Lawn Care must restore the option UNCHECKED — deselecting
    // the service clears the per-job confirmation (no silent carry-back).
    fireEvent.click(lawnCheckbox);
    await waitFor(() => {
      const el = findCheckboxByLabel(container, /Bermudagrass suppression/);
      expect(el).toBeTruthy();
      expect(el.checked).toBe(false);
    });
  });
});
