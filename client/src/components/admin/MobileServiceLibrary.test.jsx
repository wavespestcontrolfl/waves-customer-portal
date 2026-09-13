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
import MobileServiceLibrary from "./MobileServiceLibrary";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MobileServiceLibrary", () => {
  it.each([false, true])(
    "saves only intentionally changed durations (edited: %s)",
    async (editDuration) => {
      const service = {
        id: "fixture-service",
        name: "Fixture Pest Service",
        category: "pest_control",
        is_active: true,
        default_duration_minutes: 30,
        base_price: "89.00",
        pricing_type: "variable",
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ services: [service] }),
        })),
      );
      render(<MobileServiceLibrary initialView="services" />);
      fireEvent.click(
        await screen.findByRole("button", { name: /Fixture Pest Service/ }),
      );
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "Renamed Service" },
      });
      if (editDuration)
        fireEvent.change(
          screen.getByRole("spinbutton", { name: "Duration (min)" }),
          { target: { value: "40" } },
        );
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(
          fetch.mock.calls.some(([, options]) => options?.method === "PUT"),
        ).toBe(true),
      );
      const [url, options] = fetch.mock.calls.find(
        ([, options]) => options?.method === "PUT",
      );
      expect(url).toBe("/api/admin/services/fixture-service");
      const payload = JSON.parse(options.body);
      expect(payload).toMatchObject({
        name: "Renamed Service",
        base_price: "89.00",
      });
      if (editDuration) expect(payload.default_duration_minutes).toBe(40);
      else expect(payload).not.toHaveProperty("default_duration_minutes");
    },
  );

  it("exposes Treatment Plans from the mobile Services menu", () => {
    const onOpenProtocols = vi.fn();
    render(<MobileServiceLibrary onOpenProtocols={onOpenProtocols} />);

    fireEvent.click(screen.getByRole("button", { name: /Treatment Plans/i }));

    expect(onOpenProtocols).toHaveBeenCalledTimes(1);
  });

  it("does not expose custom category creation for the fixed taxonomy", async () => {
    const service = {
      id: "fixture-service",
      name: "Fixture Pest Service",
      category: "pest_control",
      is_active: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ services: [service] }),
      })),
    );
    render(<MobileServiceLibrary />);

    fireEvent.click(screen.getByRole("button", { name: /Categories/i }));

    expect(
      await screen.findByRole("heading", { name: "Categories" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Search Categories" }),
    ).toHaveAttribute("placeholder", "Search Categories");
    expect(screen.queryByText("Search Categories")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole("button", { name: /Pest Control/i }),
    );
    expect(screen.getByText("All Services").parentElement).toHaveTextContent(
      "Categories are set per service. Edit a service from All Services to move it.",
    );
  });

  it("distinguishes category read failures from empty results and retries", async () => {
    let resolveRetry;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          json: async () => ({}),
        })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveRetry = resolve;
            }),
        ),
    );
    render(<MobileServiceLibrary />);
    fireEvent.click(screen.getByRole("button", { name: /Categories/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load categories.",
    );
    expect(screen.queryByText("No categories")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Loading…")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    resolveRetry({ ok: true, json: async () => ({ services: [] }) });
    expect(await screen.findByText("No categories")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(
        ([, options]) => !options.method || options.method === "GET",
      ),
    ).toBe(true);
  });

  it.each([
    ["discounts", "Add"],
    ["services", "Create Service"],
  ])("shows the existing saving label in the %s editor", async (view, openName) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options) => {
        if (options?.method === "POST") return new Promise(() => {});
        const data = String(url).includes("/admin/services")
          ? { services: [] }
          : [];
        return Promise.resolve({ ok: true, json: async () => data });
      }),
    );
    render(<MobileServiceLibrary initialView={view} />);

    fireEvent.click(screen.getByRole("button", { name: openName }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Pending fixture" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByRole("button", { name: "Saving…" }),
    ).toBeDisabled();
  });
});
