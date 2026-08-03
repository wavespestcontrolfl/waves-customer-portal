// @vitest-environment jsdom
// Regression: picking the hardcoded "Custom…" preset left manualDiscountType
// at its "NONE" default, because that branch (unlike the catalog-row branch)
// had no discount_type to seed from. buildManualDiscountPayload returns null
// for a NONE type, and every validation guard in doGenerate was itself gated
// on type !== "NONE" — so a custom discount regenerated at full price, saved
// clean, and never appeared on the customer estimate, with no error anywhere.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";
import { buildManualDiscountPayload } from "../../lib/discountCatalog";

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

// The Type select is the one offering the manual-discount type options; the
// primitives render no htmlFor, so identify it by its option set rather than
// by label association.
function findDiscountTypeSelect(container) {
  return Array.from(container.querySelectorAll("select")).find((sel) =>
    Array.from(sel.options).some((o) => o.value === "PERCENT"),
  );
}

function findPresetSelect(container) {
  return Array.from(container.querySelectorAll("select")).find((sel) =>
    Array.from(sel.options).some((o) => o.value === "__custom__"),
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

describe('the "Custom…" discount preset produces a usable manual discount', () => {
  it('seeds a PERCENT type so a custom amount is not silently dropped', async () => {
    const { container } = render(
      <MemoryRouter>
        <EstimateToolViewV2 />
      </MemoryRouter>,
    );

    const presetSelect = await waitFor(() => {
      const el = findPresetSelect(container);
      expect(el).toBeTruthy();
      return el;
    });

    const typeSelect = findDiscountTypeSelect(container);
    expect(typeSelect).toBeTruthy();
    // Precondition: a fresh form starts with no discount type.
    expect(typeSelect.value).toBe("NONE");

    fireEvent.change(presetSelect, { target: { value: "__custom__" } });

    // The fix: the type is seeded, so the operator's amount reaches the engine.
    await waitFor(() => {
      expect(findDiscountTypeSelect(container).value).toBe("PERCENT");
    });

    // And that type is one buildManualDiscountPayload actually honors — a
    // "NONE" here is exactly what used to return null and drop the discount.
    expect(
      buildManualDiscountPayload({
        form: {
          manualDiscountType: findDiscountTypeSelect(container).value,
          manualDiscountValue: "5",
          manualDiscountLabel: "Custom",
          manualDiscountInternalReason: "owner approved",
        },
        selectedPreset: null,
      }),
    ).toMatchObject({ type: "PERCENT", value: 5 });
  });

  it("preserves a type the operator already chose", async () => {
    const { container } = render(
      <MemoryRouter>
        <EstimateToolViewV2 />
      </MemoryRouter>,
    );

    const presetSelect = await waitFor(() => {
      const el = findPresetSelect(container);
      expect(el).toBeTruthy();
      return el;
    });

    fireEvent.change(findDiscountTypeSelect(container), {
      target: { value: "FIXED" },
    });
    fireEvent.change(presetSelect, { target: { value: "__custom__" } });

    await waitFor(() => {
      expect(findDiscountTypeSelect(container).value).toBe("FIXED");
    });
  });
});
