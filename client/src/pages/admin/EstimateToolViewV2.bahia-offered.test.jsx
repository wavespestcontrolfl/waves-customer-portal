// @vitest-environment jsdom
// GATE_LAWN_V13 has no bahia lawn program, so the estimator stops offering Bahia as a NEW lawn
// plan (the server reports subFeaturesAvailable.bahiaOffered = false). An older server, or a
// failed read, keeps the option; the server still parks any bahia quote for review either way.
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

function grassOptions(container) {
  const select = Array.from(container.querySelectorAll("select")).find((sel) =>
    Array.from(sel.options).some((o) => o.value === "st_augustine"),
  );
  return select ? Array.from(select.options).map((o) => o.value) : null;
}

function stubFetch(pricingConfig) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const path = String(url);
      if (path.includes("/admin/discounts")) return jsonResponse([]);
      if (path.includes("/admin/pricing-config/lawn_pricing_v2")) return jsonResponse(pricingConfig);
      return jsonResponse({});
    }),
  );
}

async function lawnGrassOptions(pricingConfig, expectBahia) {
  stubFetch(pricingConfig);
  const { container } = render(
    <MemoryRouter>
      <EstimateToolViewV2 />
    </MemoryRouter>,
  );
  fireEvent.click(findCheckboxByLabel(container, /^\s*Lawn Care\s*$/));
  await waitFor(() => {
    const options = grassOptions(container);
    expect(options).toBeTruthy();
    expect(options.includes("bahia")).toBe(expectBahia);
  });
  return grassOptions(container);
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "test-token");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Bahia as a new lawn plan", () => {
  it("is not offered when the server says GATE_LAWN_V13 has no bahia program", async () => {
    const options = await lawnGrassOptions({ subFeaturesAvailable: { bahiaOffered: false } }, false);
    expect(options).toEqual(["st_augustine", "bermuda", "zoysia"]);
  });

  it("is offered while the old program is live", async () => {
    await lawnGrassOptions({ subFeaturesAvailable: { bahiaOffered: true } }, true);
  });

  it("stays offered when the server does not say (older server or failed read)", async () => {
    await lawnGrassOptions({}, true);
  });
});
