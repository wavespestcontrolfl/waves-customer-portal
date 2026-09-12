// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiSurface } from "../../components/ui";
import { DiscountsSection } from "./DiscountsTabs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DiscountsSection", () => {
  it("keeps the complete create payload while using the shared form controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => ({
        ok: true,
        json: async () => (options?.method === "POST" ? { id: 44 } : []),
      })),
    );

    render(
      <UiSurface density="comfortable">
        <DiscountsSection />
      </UiSurface>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "New Discount" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Key" }), {
      target: { value: "summer-25" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Summer 25" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Military" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([, options]) => options?.method === "POST"),
      ).toBe(true),
    );
    const [url, options] = fetch.mock.calls.find(
      ([, request]) => request?.method === "POST",
    );
    expect(url).toBe("/api/admin/discounts");
    expect(JSON.parse(options.body)).toMatchObject({
      discount_key: "summer-25",
      name: "Summer 25",
      discount_type: "percentage",
      amount: 0,
      applies_to: "all",
      requires_military: true,
      is_stackable: true,
      is_active: true,
      show_in_estimates: true,
      show_in_invoices: true,
      show_in_scheduling: false,
    });
  });
});
