// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscountsSection } from "./DiscountsTabs";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

    render(<DiscountsSection />);
    const createButton = await screen.findByRole("button", {
      name: "+ New Discount",
    });
    expect(createButton).toHaveClass("ui-action");
    expect(
      screen.getByText("+ New Discount", { selector: "strong" }).parentElement,
    ).toHaveTextContent(
      "No discounts yet. Click + New Discount to add your first one.",
    );
    fireEvent.click(createButton);
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

  it("keeps the existing blank statistics state when loading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/admin/discounts/stats")) {
          throw new Error("down");
        }
        return { ok: true, json: async () => [] };
      }),
    );

    render(<DiscountsSection />);
    fireEvent.click(screen.getByRole("tab", { name: "Stats" }));

    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) =>
          String(url).endsWith("/admin/discounts/stats"),
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Loading discount statistics…"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the existing catalog retry label and request", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("down"))
        .mockResolvedValue({ ok: true, json: async () => [] }),
    );

    render(<DiscountsSection />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("keeps the first feedback timer when a second message is shown", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).endsWith("/admin/discounts/calculate")) {
          throw new Error("down");
        }
        return { ok: true, json: async () => [] };
      }),
    );

    await act(async () => render(<DiscountsSection />));
    fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Calculate" })),
    );
    expect(screen.getByText("Preview failed")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Calculate" })),
    );
    act(() => vi.advanceTimersByTime(2000));

    expect(screen.queryByText("Preview failed")).not.toBeInTheDocument();
  });
});
