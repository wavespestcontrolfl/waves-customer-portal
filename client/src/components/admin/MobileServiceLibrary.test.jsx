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

  it("retains the existing category creation coming-soon action", async () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ services: [] }),
      })),
    );
    render(<MobileServiceLibrary />);

    fireEvent.click(screen.getByRole("button", { name: /Categories/i }));

    expect(
      await screen.findByRole("heading", { name: "Categories" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(alert).toHaveBeenCalledWith("Create category — coming soon");
  });
});
