// @vitest-environment jsdom
// The V2 estimator's sidebar counts rodent bait toward the WaveGuard tier
// through rodentBaitWaveguardFlags() and prices the bracket through
// rodentBaitBracketForFootprint() — module state the LEGACY estimator's
// loader mutates from the live pricing_config rows. V2 never loaded them
// (codex #3591 r34 P1), so a disabled tier_qualifier row left the preview
// advertising Silver while the server priced Bronze. The view must load the
// three rodent rows through the same appliers, honoring an authoritative
// 404 as "reset to the in-code default".
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as engine from "../../lib/estimateEngine";
import EstimateToolViewV2 from "./EstimateToolViewV2";

vi.mock("../../lib/estimateEngine", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    applyServerRodentBaitBracketsPricingConfig: vi.fn(actual.applyServerRodentBaitBracketsPricingConfig),
    applyServerRodentSetupFeePricingConfig: vi.fn(actual.applyServerRodentSetupFeePricingConfig),
    applyServerRodentWaveguardPricingConfig: vi.fn(actual.applyServerRodentWaveguardPricingConfig),
  };
});

function jsonResponse(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    clone() {
      return this;
    },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const WAVEGUARD_ROW = { tier_qualifier: false, exclude_from_pct_discount: true };
const BRACKETS_ROW = { brackets: [{ maxSqFt: 2000, stations: 4, perVisit: 79 }] };

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url) => {
      const path = String(url);
      if (path.includes("/admin/discounts")) return jsonResponse([]);
      if (path.includes("/admin/pricing-config/rodent_waveguard")) return jsonResponse({ data: WAVEGUARD_ROW });
      if (path.includes("/admin/pricing-config/rodent_bait_brackets")) return jsonResponse({ data: BRACKETS_ROW });
      // Authoritative 404: the row was removed ⇒ reset to the in-code default.
      if (path.includes("/admin/pricing-config/rodent_setup_fee")) return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({});
    }),
  );
}

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "test-token");
  stubFetch();
  engine.applyServerRodentBaitBracketsPricingConfig.mockClear();
  engine.applyServerRodentSetupFeePricingConfig.mockClear();
  engine.applyServerRodentWaveguardPricingConfig.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  // Leave module state as the in-code defaults for the next file.
  engine.applyServerRodentBaitBracketsPricingConfig(null);
  engine.applyServerRodentSetupFeePricingConfig(null);
  engine.applyServerRodentWaveguardPricingConfig(null);
});

describe("V2 estimator loads the live rodent pricing rows", () => {
  it("fetches the three rows and applies them through the shared appliers (404 ⇒ null reset)", async () => {
    render(
      <MemoryRouter>
        <EstimateToolViewV2 />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(engine.applyServerRodentWaveguardPricingConfig).toHaveBeenCalledWith(WAVEGUARD_ROW);
    });
    expect(engine.applyServerRodentBaitBracketsPricingConfig).toHaveBeenCalledWith(BRACKETS_ROW);
    expect(engine.applyServerRodentSetupFeePricingConfig).toHaveBeenCalledWith(null);
    // The live posture the sidebar's tier count reads is now the row's.
    expect(engine.rodentBaitWaveguardFlags()).toEqual({ tierQualifier: false, excludeFromPctDiscount: true });
    const fetched = fetch.mock.calls.map((c) => String(c[0]));
    for (const key of ["rodent_bait_brackets", "rodent_setup_fee", "rodent_waveguard"]) {
      expect(fetched.some((u) => u.endsWith(`/admin/pricing-config/${key}`))).toBe(true);
    }
  });

  it("a transport failure leaves the last applied posture in place (never a silent default)", async () => {
    engine.applyServerRodentWaveguardPricingConfig(WAVEGUARD_ROW);
    engine.applyServerRodentWaveguardPricingConfig.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        const path = String(url);
        if (path.includes("/admin/pricing-config/rodent_")) return jsonResponse({ error: "boom" }, 500);
        if (path.includes("/admin/discounts")) return jsonResponse([]);
        return jsonResponse({});
      }),
    );
    render(
      <MemoryRouter>
        <EstimateToolViewV2 />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(fetch.mock.calls.some((c) => String(c[0]).endsWith("/admin/pricing-config/rodent_waveguard"))).toBe(true);
    });
    expect(engine.applyServerRodentWaveguardPricingConfig).not.toHaveBeenCalled();
    expect(engine.rodentBaitWaveguardFlags()).toEqual({ tierQualifier: false, excludeFromPctDiscount: true });
  });
});
