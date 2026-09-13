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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import LawnAssessmentPanel from "./LawnAssessmentPanel";

const customer = {
  id: "customer-1",
  serviceId: "service-1",
  firstName: "Test",
  lastName: "Customer",
  address: "123 Main St",
  phone: "941-555-0100",
  serviceType: "Lawn care",
};

const response = (data) => ({ ok: true, json: async () => data });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("lawn_guide_seen", "1");
  localStorage.setItem("waves_admin_token", "fixture-token");
  vi.stubGlobal("alert", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("keeps the photo analysis, score adjustment, and confirmation payload intact", async () => {
  class FixtureFileReader {
    readAsDataURL() {
      this.onload({ target: { result: "data:image/jpeg;base64,cGhvdG8=" } });
    }
  }
  class FixtureImage {
    set src(_value) {
      this.width = 800;
      this.height = 600;
      this.onload();
    }
  }
  vi.stubGlobal("FileReader", FixtureFileReader);
  vi.stubGlobal("Image", FixtureImage);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => {
      if (url.endsWith("/admin/lawn-assessment/customers")) {
        return response({ customers: [customer] });
      }
      if (url.endsWith("/admin/lawn-assessment/assess")) {
        return response({
          assessment: { id: "assessment-1" },
          adjustedScores: {
            turf_density: 80,
            weed_suppression: 70,
            color_health: 60,
            fungus_control: 50,
            thatch_level: 40,
            stress_damage: 45,
          },
          observations: "Synthetic lawn observations",
          season: "wet",
          isBaseline: true,
          divergenceFlags: [],
        });
      }
      if (url.endsWith("/admin/lawn-assessment/confirm")) {
        return response({
          assessment: { id: "assessment-1", confirmed: true },
        });
      }
      throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
    }),
  );

  const view = render(<LawnAssessmentPanel embedded />);
  fireEvent.click(await screen.findByText("Test Customer"));
  const fileInput = view.container.querySelector('input[type="file"]');
  const file = new File(["photo"], "lawn.jpg", { type: "image/jpeg" });
  fireEvent.change(fileInput, { target: { files: [file] } });

  const analyze = await screen.findByRole("button", {
    name: "Analyze 1 Photo with AI",
  });
  fireEvent.click(analyze);
  expect(await screen.findByText(/AI Scorecard/)).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Decrease Turf Density" }),
  );
  fireEvent.change(screen.getByLabelText("Inches per week"), {
    target: { value: "1.25" },
  });
  fireEvent.change(screen.getByLabelText("Irrigation notes"), {
    target: { value: "Dry front corner" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm Scores" }));

  await waitFor(() => {
    const confirmCall = fetch.mock.calls.find(([url]) =>
      String(url).endsWith("/admin/lawn-assessment/confirm"),
    );
    expect(confirmCall).toBeTruthy();
    expect(JSON.parse(confirmCall[1].body)).toEqual({
      assessmentId: "assessment-1",
      adjustedScores: {
        turf_density: 75,
        weed_suppression: 70,
        color_health: 60,
        fungus_control: 50,
        thatch_level: 40,
      },
      protocol_field_checks: {
        irrigation_inches_per_week: "1.25",
        protocol_field_notes: "Dry front corner",
      },
    });
  });
  const assessCall = fetch.mock.calls.find(([url]) =>
    String(url).endsWith("/admin/lawn-assessment/assess"),
  );
  expect(JSON.parse(assessCall[1].body)).toEqual({
    customerId: "customer-1",
    serviceId: "service-1",
    photos: [{ data: "cGhvdG8=", mimeType: "image/jpeg" }],
  });
});

it("uses comfortable shared controls for turf profile editing and preserves save data", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options = {}) => {
      if (url.endsWith("/admin/lawn-assessment/customers")) {
        return response({ customers: [customer] });
      }
      if (url.endsWith("/admin/customers/customer-1/turf-profile")) {
        return response({
          irrigation_home_changed_at: "2026-09-01T12:00:00Z",
          profile: {
            grass_type: "bahia",
            county: "Manatee",
            known_chinch_history: false,
          },
        });
      }
      throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
    }),
  );

  const view = render(<LawnAssessmentPanel embedded />);
  fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
  expect(
    await screen.findByRole("heading", { name: /Turf Profile/ }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("County (e.g. Sarasota)"), {
    target: { value: "Sarasota" },
  });
  fireEvent.click(screen.getByLabelText("Chinch bug history"));
  fireEvent.click(screen.getByRole("button", { name: "Save Turf Profile" }));

  await waitFor(() => {
    const saveCall = fetch.mock.calls.find(
      ([url, options]) =>
        String(url).endsWith("/admin/customers/customer-1/turf-profile") &&
        options?.method === "PUT",
    );
    expect(saveCall).toBeTruthy();
    expect(JSON.parse(saveCall[1].body)).toEqual(
      expect.objectContaining({
        grass_type: "bahia",
        county: "Sarasota",
        known_chinch_history: true,
        county_confirmed: true,
        confirmed_as_of: "2026-09-01T12:00:00Z",
      }),
    );
  });
  expect(
    view.container.querySelector('[data-ui-density="comfortable"]'),
  ).toBeInTheDocument();
  expect(
    [...view.container.querySelectorAll("button")].every((button) =>
      button.classList.contains("ui-control"),
    ),
  ).toBe(true);
  expect(
    [
      ...view.container.querySelectorAll(
        "input:not([type='file']):not([type='checkbox']), select",
      ),
    ].every((control) => control.classList.contains("ui-control")),
  ).toBe(true);
});
