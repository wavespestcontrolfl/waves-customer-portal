// @vitest-environment jsdom
// GATE_EXCLUSION_ROOF_STYLE_PRICING: the rodent exclusion section offers a Roof style choice (the technician's one tap on
// site) only while the server says the gate is on (exclusionRoofStyle: true on the rodent_waveguard row). Barrel tile
// also asks for the eave feet and says when the closure still needs a measurement.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import EstimateToolViewV2, { roofStyleRegenerateBlock, roofStyleReset } from "./EstimateToolViewV2";

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

async function openExclusion(waveguardRow) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const path = String(url);
      if (path.includes("/admin/discounts")) return jsonResponse([]);
      if (path.includes("/admin/pricing-config/rodent_waveguard")) return jsonResponse(waveguardRow);
      return jsonResponse({});
    }),
  );
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

describe("Roof style choice", () => {
  it("shows the five choices, defaulting to Not confirmed, while the gate is on", async () => {
    const { container } = await openExclusion({ data: {}, exclusionRoofStyle: true });
    await waitFor(() => expect(container.querySelector("#estimate-exclRoofStyle")).toBeTruthy());
    const select = container.querySelector("#estimate-exclRoofStyle");
    expect(select.value).toBe("");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Not confirmed", "Shingle", "Flat tile", "Barrel tile", "Metal", "Other",
    ]);
    expect(container.querySelector("#estimate-exclBarrelEaveFt")).toBeNull();
  });

  it("is hidden when the gate is off, the row is missing or the flag is not true", async () => {
    for (const row of [{ data: {} }, { data: {}, exclusionRoofStyle: false }]) {
      cleanup();
      const { container } = await openExclusion(row);
      await waitFor(() => expect(findCheckboxByLabel(container, /Rodent Exclusion Service/)).toBeTruthy());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(container.querySelector("#estimate-exclRoofStyle")).toBeNull();
    }
  });

  it("the eave feet input shows only for Barrel tile, with a note until feet are entered", async () => {
    const { container, findByTestId } = await openExclusion({ data: {}, exclusionRoofStyle: true });
    await waitFor(() => expect(container.querySelector("#estimate-exclRoofStyle")).toBeTruthy());
    const select = container.querySelector("#estimate-exclRoofStyle");
    fireEvent.change(select, { target: { value: "flat_tile" } });
    expect(await findByTestId("exclusion-tile-note")).toHaveTextContent("x1.25");
    expect(container.querySelector("#estimate-exclBarrelEaveFt")).toBeNull();
    fireEvent.change(select, { target: { value: "barrel_tile" } });
    expect(container.querySelector("#estimate-exclBarrelEaveFt")).toBeTruthy();
    expect(await findByTestId("exclusion-barrel-needs-measurement")).toHaveTextContent(/needs a measurement/);
    fireEvent.change(container.querySelector("#estimate-exclBarrelEaveFt"), { target: { value: "40" } });
    await waitFor(() => expect(container.querySelector('[data-testid="exclusion-barrel-needs-measurement"]')).toBeNull());
    fireEvent.change(select, { target: { value: "shingle" } });
    expect(container.querySelector("#estimate-exclBarrelEaveFt")).toBeNull();
    expect(container.querySelector('[data-testid="exclusion-tile-note"]')).toBeNull();
  });

  it("changing the service address clears the roof style", async () => {
    const { container, getByLabelText } = await openExclusion({ data: {}, exclusionRoofStyle: true });
    await waitFor(() => expect(container.querySelector("#estimate-exclRoofStyle")).toBeTruthy());
    fireEvent.change(container.querySelector("#estimate-exclRoofStyle"), { target: { value: "barrel_tile" } });
    expect(container.querySelector("#estimate-exclRoofStyle").value).toBe("barrel_tile");
    fireEvent.change(getByLabelText("Service address"), { target: { value: "12 Example Lane, Bradenton FL" } });
    await waitFor(() => expect(container.querySelector("#estimate-exclRoofStyle").value).toBe(""));
  }, 30000);
});

describe("Saved roof style picks and new estimates", () => {
  it("blocks regenerating a saved pick until the gate read confirms it", () => {
    const saved = { svcExclusion: true, exclRoofStyle: "flat_tile" };
    expect(roofStyleRegenerateBlock(saved, false)).toMatch(/Roof style pricing is not confirmed available/);
    expect(roofStyleRegenerateBlock(saved, true)).toBe("");
    expect(roofStyleRegenerateBlock({ ...saved, exclRoofStyle: "" }, false)).toBe("");
    expect(roofStyleRegenerateBlock({ ...saved, svcExclusion: false }, false)).toBe("");
  });

  it("a new estimate, address or customer resets the pick and the feet", () => {
    expect(roofStyleReset()).toEqual({ exclRoofStyle: "", exclBarrelEaveFt: "" });
    // clearedPropertyFields (a new address or customer, and Next estimate through it) applies it.
    const source = fs.readFileSync("src/pages/admin/EstimateToolViewV2.jsx", "utf8");
    const cleared = source.slice(source.indexOf("function clearedPropertyFields()"));
    expect(cleared.slice(0, cleared.indexOf("const [form, setForm]"))).toContain("...roofStyleReset()");
    const nextEstimate = source.slice(source.indexOf("function nextEstimate()"));
    expect(nextEstimate.slice(0, nextEstimate.indexOf("fleaOfferKey"))).toContain("...clearedPropertyFields()");
  });

  it("the request carries the pick only while the gate is on, and the feet only for Barrel tile", () => {
    const source = fs.readFileSync("src/pages/admin/EstimateToolViewV2.jsx", "utf8");
    const at = source.indexOf("...(exclusionRoofStyleAvailable && form.exclRoofStyle");
    expect(at).toBeGreaterThan(0);
    const block = source.slice(at, at + 400);
    expect(block).toContain("exclRoofStyle: form.exclRoofStyle");
    expect(block).toContain('form.exclRoofStyle === "barrel_tile" ? { exclBarrelEaveFt');
  });
});
