// @vitest-environment jsdom
// GATE_EXCLUSION_ROOF_STYLE_PRICING: the rodent exclusion section offers a Roof style choice (the technician's one tap on
// site) only while the server says the gate is on (exclusionRoofStyle: true on the rodent_waveguard row). Barrel tile
// also asks for the eave feet and says when the closure still needs a measurement.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(await findByTestId("exclusion-tile-note")).toHaveTextContent("Settings tile rate");
    expect(container.querySelector("[data-testid=\"exclusion-tile-note\"]").textContent).not.toMatch(/\d\.\d/);
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

  it("the Roof/High label drops its dollar figure while a tile roof is picked", async () => {
    const { container } = await openExclusion({ data: {}, exclusionRoofStyle: true });
    await waitFor(() => expect(container.querySelector("#estimate-exclRoofStyle")).toBeTruthy());
    const label = () => container.querySelector('label[for="estimate-exclAdvancedWireMesh"]').textContent;
    expect(label()).toBe("Roof/High — $150/pt");
    const select = container.querySelector("#estimate-exclRoofStyle");
    for (const value of ["flat_tile", "barrel_tile"]) {
      fireEvent.change(select, { target: { value } });
      expect(label()).toBe("Roof/High — tile rate applies");
    }
    for (const value of ["shingle", "metal", "other", ""]) {
      fireEvent.change(select, { target: { value } });
      expect(label()).toBe("Roof/High — $150/pt");
    }
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

describe("A different customer or lead link clears the roof style, even with the same or no address", () => {
  const ADDRESS = "1 Synthetic Way";
  const customer = { id: "synthetic-customer", firstName: "Jamie", lastName: "Fixture", address: ADDRESS };
  const lead = { id: "synthetic-lead", first_name: "Dana", last_name: "Sample", phone: null, email: null, address: "", service_interest: "Pest Control", customer_id: null };

  async function openWithPick(searchTerm) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const path = String(url);
        if (path.startsWith("/api/admin/customers?")) return jsonResponse({ customers: [customer] });
        if (path.startsWith("/api/admin/leads?")) return jsonResponse({ leads: [lead] });
        if (path.includes("/admin/pricing-config/rodent_waveguard")) return jsonResponse({ data: {}, exclusionRoofStyle: true });
        if (path.includes("/admin/discounts")) return jsonResponse([]);
        return jsonResponse({});
      }),
    );
    const view = render(
      <MemoryRouter>
        <EstimateToolViewV2 />
      </MemoryRouter>,
    );
    fireEvent.click(findCheckboxByLabel(view.container, /Rodent Exclusion Service/));
    await waitFor(() => expect(view.container.querySelector("#estimate-exclRoofStyle")).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox", { name: "Service address" }), { target: { value: ADDRESS } });
    await waitFor(() => expect(view.container.querySelector("#estimate-exclRoofStyle")).toBeTruthy());
    fireEvent.change(view.container.querySelector("#estimate-exclRoofStyle"), { target: { value: "barrel_tile" } });
    fireEvent.change(view.container.querySelector("#estimate-exclBarrelEaveFt"), { target: { value: "40" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Search customers/ }), { target: { value: searchTerm } });
    return view;
  }

  it("a new customer with the same address clears the pick and the feet", async () => {
    const { container } = await openWithPick("Jamie");
    fireEvent.click(await screen.findByRole("button", { name: /Jamie Fixture/ }));
    await waitFor(() => expect(container.querySelector("#estimate-exclRoofStyle").value).toBe(""));
    expect(container.querySelector("#estimate-exclBarrelEaveFt")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Service address" })).toHaveValue(ADDRESS);
  }, 30000);

  it("a new lead with no address clears the pick and the feet", async () => {
    const { container } = await openWithPick("Dana");
    fireEvent.click(await screen.findByRole("button", { name: /Dana Sample.*Lead/ }));
    await waitFor(() => expect(container.querySelector("#estimate-exclRoofStyle").value).toBe(""));
    expect(screen.getByRole("textbox", { name: "Service address" })).toHaveValue(ADDRESS);
  }, 30000);
});

describe("Deep-link prefill and the scope answer", () => {
  const ADDRESS = "1 Synthetic Way";

  async function mountWithPick(props) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const path = String(url);
        if (path.includes("/admin/pricing-config/rodent_waveguard")) return jsonResponse({ data: {}, exclusionRoofStyle: true });
        if (path.includes("/admin/discounts")) return jsonResponse([]);
        return jsonResponse({});
      }),
    );
    const tree = (next) => (
      <MemoryRouter>
        <EstimateToolViewV2 {...next} />
      </MemoryRouter>
    );
    const view = render(tree(props));
    fireEvent.click(findCheckboxByLabel(view.container, /Rodent Exclusion Service/));
    await waitFor(() => expect(view.container.querySelector("#estimate-exclRoofStyle")).toBeTruthy());
    fireEvent.change(view.container.querySelector("#estimate-exclRoofStyle"), { target: { value: "barrel_tile" } });
    fireEvent.change(view.container.querySelector("#estimate-exclBarrelEaveFt"), { target: { value: "40" } });
    return { view, tree };
  }

  it("a new incoming customer id with the same address clears the pick and the feet", async () => {
    const { view, tree } = await mountWithPick({ initialAddress: ADDRESS, initialCustomerId: "customer-a" });
    expect(view.container.querySelector("#estimate-exclBarrelEaveFt").value).toBe("40");
    view.rerender(tree({ initialAddress: ADDRESS, initialCustomerId: "customer-b" }));
    await waitFor(() => expect(view.container.querySelector("#estimate-exclRoofStyle").value).toBe(""));
    expect(view.container.querySelector("#estimate-exclBarrelEaveFt")).toBeNull();
  }, 30000);

  it("a contact-only prefill change keeps the roof style and feet (same customer id and address)", async () => {
    const base = { initialAddress: ADDRESS, initialCustomerId: "customer-a", initialCustomerPhone: "9415550100" };
    const { view, tree } = await mountWithPick(base);
    view.rerender(tree({ ...base, initialCustomerPhone: "9415550199", initialCustomerEmail: "new@example.com", initialCustomerName: "Jamie Fixture" }));
    await waitFor(() => expect(document.getElementById("estimate-customerPhone")).toHaveValue("9415550199"));
    expect(view.container.querySelector("#estimate-exclRoofStyle").value).toBe("barrel_tile");
    expect(view.container.querySelector("#estimate-exclBarrelEaveFt").value).toBe("40");
  }, 30000);

  it("a new incoming lead id with no address clears the pick and the feet", async () => {
    const { view, tree } = await mountWithPick({ initialLeadId: "lead-a" });
    view.rerender(tree({ initialLeadId: "lead-b" }));
    await waitFor(() => expect(view.container.querySelector("#estimate-exclRoofStyle").value).toBe(""));
    expect(view.container.querySelector("#estimate-exclBarrelEaveFt")).toBeNull();
  }, 30000);

  it("the scope answer keeps the roof style but never restores the eave feet", () => {
    const source = fs.readFileSync("src/pages/admin/EstimateToolViewV2.jsx", "utf8");
    const answer = source.slice(source.indexOf("function answerScope("));
    const block = answer.slice(0, answer.indexOf("_homeSqFtEdited: false"));
    expect(block).toContain("...clearedPropertyFields()");
    expect(block).toContain("exclRoofStyle: f.exclRoofStyle");
    expect(block).not.toContain("exclBarrelEaveFt");
    // clearedPropertyFields empties the feet.
    expect(roofStyleReset().exclBarrelEaveFt).toBe("");
  });
});
