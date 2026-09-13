// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReviewVelocityEngine from "./ReviewVelocityEngine";

const response = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const customer = {
  id: "customer-17",
  name: "Taylor Example",
  firstName: "Taylor",
  phone: "+19415550117",
  city: "Sarasota",
  locationId: "sarasota",
  lastService: "General Pest Control",
  lastServiceDate: "2026-09-10T12:00:00.000Z",
  lifetimeRevenue: 840,
  askCount: 0,
  sendable: true,
  cadenceable: true,
  eligibilityReasons: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Review outreach interactions", () => {
  it("opens the shared customer sheet and preserves the edited template payload", async () => {
    const fetch = vi.fn(async (url, options = {}) => {
      const path = String(url);
      if (
        options.method === "POST" &&
        path.endsWith("/admin/reviews/send-request")
      ) {
        return response({ success: true });
      }
      if (path.includes("outreach-candidates")) {
        return response({
          customers: [customer],
          reviewSequencesEnabled: true,
        });
      }
      if (path.includes("outreach-analytics")) {
        return response({
          funnel: {},
          googleByLocation: [],
          byChannel: [],
          byTemplate: [],
        });
      }
      return response({ items: [] });
    });
    vi.stubGlobal("fetch", fetch);

    render(<ReviewVelocityEngine />);
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) =>
          String(url).includes("outreach-candidates"),
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: /Pipeline/ }));
    const row = (await screen.findByText("Taylor Example")).closest("tr");
    fireEvent.click(within(row).getByRole("button", { name: "Edit" }));

    const sheet = await screen.findByRole("dialog", {
      name: "Review outreach for Taylor Example",
    });
    fireEvent.change(within(sheet).getByRole("combobox"), {
      target: { value: "resolution_check" },
    });
    fireEvent.change(
      within(sheet).getByPlaceholderText("Compose review request..."),
      {
        target: { value: "Hi Taylor, checking that everything is resolved." },
      },
    );
    fireEvent.click(
      within(sheet).getByRole("button", { name: "Send Check-In" }),
    );

    await waitFor(() => {
      const write = fetch.mock.calls.find(
        ([url, options]) =>
          String(url).endsWith("/admin/reviews/send-request") &&
          options?.method === "POST",
      );
      expect(write).toBeTruthy();
      expect(JSON.parse(write[1].body)).toEqual({
        customerId: "customer-17",
        serviceType: "General Pest Control",
        techName: null,
        templateId: "resolution_check",
        body: "Hi Taylor, checking that everything is resolved.",
      });
    });
  });
});
