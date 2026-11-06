// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscountsSection } from "./DiscountsTabs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubDiscounts(rows) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => ({
      ok: true,
      json: async () => (options?.method === "PUT" ? { id: rows[0].id } : rows),
    })),
  );
}

async function openEdit() {
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  return screen.findByRole("textbox", { name: "Code" });
}

async function savedPut() {
  await waitFor(() =>
    expect(fetch.mock.calls.some(([, o]) => o?.method === "PUT")).toBe(true),
  );
  const [url, options] = fetch.mock.calls.find(([, o]) => o?.method === "PUT");
  return { url, body: JSON.parse(options.body) };
}

describe("DiscountsSection promo code", () => {
  it("sends promo_code null when an existing code is cleared", async () => {
    stubDiscounts([
      { id: 7, discount_key: "summer", name: "Summer", discount_type: "percentage", amount: 10, promo_code: "SUMMER25", is_active: true },
    ]);
    render(<DiscountsSection />);
    const code = await openEdit();
    expect(code).toHaveValue("SUMMER25");
    fireEvent.change(code, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    const { url, body } = await savedPut();
    expect(url).toBe("/api/admin/discounts/7");
    expect(body).toHaveProperty("promo_code", null);
  });

  it("sends the code unchanged when it is kept", async () => {
    stubDiscounts([
      { id: 7, discount_key: "summer", name: "Summer", discount_type: "percentage", amount: 10, promo_code: "SUMMER25", is_active: true },
    ]);
    render(<DiscountsSection />);
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    expect((await savedPut()).body.promo_code).toBe("SUMMER25");
  });
});
