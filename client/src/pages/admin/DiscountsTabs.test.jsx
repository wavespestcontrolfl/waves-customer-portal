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

  it("shows a statistics failure and retries to genuine zero results", async () => {
    let attempts = 0;
    let resolveRetry;
    vi.stubGlobal(
      "fetch",
      vi.fn((url) => {
        if (String(url).endsWith("/admin/discounts/stats")) {
          attempts += 1;
          if (attempts === 1)
            return Promise.resolve({ ok: false, status: 503 });
          return new Promise((resolve) => {
            resolveRetry = resolve;
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      }),
    );
    render(<DiscountsSection />);
    fireEvent.click(screen.getByRole("tab", { name: "Stats" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load discount statistics.",
    );
    expect(screen.queryByText("Total Applications")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("Loading discount statistics…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    resolveRetry({
      ok: true,
      json: async () => ({ totalApplied: 0, totalGiven: 0, discounts: [] }),
    });
    expect(await screen.findByText("$0.00")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("ignores an older statistics response after leaving and reopening the tab", async () => {
    const pending = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url) =>
        String(url).endsWith("/admin/discounts/stats")
          ? new Promise((resolve) => pending.push(resolve))
          : Promise.resolve({ ok: true, json: async () => [] }),
      ),
    );
    render(<DiscountsSection />);
    fireEvent.click(screen.getByRole("tab", { name: "Stats" }));
    fireEvent.click(screen.getByRole("tab", { name: "Discount Catalog" }));
    fireEvent.click(screen.getByRole("tab", { name: "Stats" }));
    await act(async () =>
      pending[1]({
        ok: true,
        json: async () => ({ totalApplied: 2, totalGiven: 20, discounts: [] }),
      }),
    );
    expect(await screen.findByText("$20.00")).toBeInTheDocument();
    await act(async () =>
      pending[0]({
        ok: true,
        json: async () => ({ totalApplied: 1, totalGiven: 10, discounts: [] }),
      }),
    );
    expect(screen.queryByText("$10.00")).not.toBeInTheDocument();
    expect(screen.getByText("$20.00")).toBeInTheDocument();
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
