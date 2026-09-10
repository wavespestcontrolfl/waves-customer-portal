// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import MobileCardOnFileSheet from "./MobileCardOnFileSheet";
import { UiSurface } from "../ui";

const cards = [
  { id: "pm-1", method_type: "card", brand: "visa", last_four: "1111" },
  { id: "pm-2", method_type: "card", brand: "mastercard", last_four: "2222" },
];

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, json: async () => body });
}

describe.each(["legacy", "comfortable"])(
  "MobileCardOnFileSheet (%s)",
  (density) => {
    beforeEach(() => {
      vi.stubGlobal("localStorage", { getItem: vi.fn(() => "test-token") });
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      cleanup();
      vi.unstubAllGlobals();
    });

    async function renderLoaded() {
      fetch.mockReturnValueOnce(jsonResponse({ cards }));
      render(
        <UiSurface density={density}>
          <MobileCardOnFileSheet
            presentation={density === "comfortable" ? "admin" : "legacy"}
            desktopVisible
            invoiceId="inv-1"
            customerId="cust-1"
            customerName="Test Customer"
          />
        </UiSurface>,
      );
      await screen.findByText("Visa 1111");
    }

    it.each([
      [{ orphan: true, error: "Charge succeeded. DO NOT charge again." }],
      [
        {
          ambiguous: true,
          error: "Charge may have succeeded. DO NOT charge again.",
        },
      ],
      [
        {
          in_progress: true,
          error: "Charge is already in progress. DO NOT charge again.",
        },
      ],
    ])(
      "locks every charge action after a terminal charge response",
      async (body) => {
        await renderLoaded();
        fetch.mockReturnValueOnce(
          jsonResponse(body, { ok: false, status: 409 }),
        );

        fireEvent.click(
          screen.getAllByRole("button", { name: /^Charge(?: |$)/ })[0],
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(body.error);
        await waitFor(() => {
          const blocked = screen.getAllByRole("button", {
            name: /^Do not retry/,
          });
          expect(blocked).toHaveLength(2);
          blocked.forEach((button) => expect(button).toBeDisabled());
        });
        expect(fetch).toHaveBeenCalledTimes(2);
      },
    );

    it("re-enables charge after a deterministic decline", async () => {
      await renderLoaded();
      fetch.mockReturnValueOnce(
        jsonResponse({ error: "Card declined" }, { ok: false, status: 400 }),
      );

      fireEvent.click(
        screen.getAllByRole("button", { name: /^Charge(?: |$)/ })[0],
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Card declined",
      );
      await waitFor(() => {
        screen
          .getAllByRole("button", { name: /^Charge(?: |$)/ })
          .forEach((button) => expect(button).toBeEnabled());
      });
    });
  },
);

describe("saved-card presentation scope", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("preserves the existing sheet inside a comfortable parent without opt-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => jsonResponse({ cards })),
    );
    vi.stubGlobal("localStorage", { getItem: () => "test-token" });
    render(
      <UiSurface density="comfortable">
        <MobileCardOnFileSheet
          desktopVisible
          customerId="cust-1"
          invoiceId="inv-1"
        />
      </UiSurface>,
    );
    await screen.findByText("Visa 1111");
    expect(document.querySelector(".ui-dialog")).toBeNull();
  });
  it("shows a failed card read and retries without charging", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(
          jsonResponse(
            { error: "Read unavailable" },
            { ok: false, status: 503 },
          ),
        )
        .mockReturnValueOnce(jsonResponse({ cards })),
    );
    vi.stubGlobal("localStorage", { getItem: () => "test-token" });
    render(
      <UiSurface density="comfortable">
        <MobileCardOnFileSheet
          presentation="admin"
          desktopVisible
          customerId="cust-1"
          invoiceId="inv-1"
        />
      </UiSurface>,
    );
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await screen.findByText("Visa 1111");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(([url]) =>
        url.endsWith("/customers/cust-1/cards"),
      ),
    ).toBe(true);
  });
});
