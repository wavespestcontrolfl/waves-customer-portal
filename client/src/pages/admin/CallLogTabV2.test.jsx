// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CallLogTabV2, { renderTranscriptWithHighlight } from "./CallLogTabV2";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

describe("CallLogTabV2 standalone navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url) => ({
      ok: true,
      json: async () => String(url).includes("route-calibration")
        ? {}
        : {
            calls: [{
              id: "call-1",
              direction: "inbound",
              from_phone: "+19415550123",
              caller_city: "Lakewood Ranch",
              caller_state: "FL",
              answered_by: "missed",
              created_at: new Date().toISOString(),
            }],
          },
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps customer creation inside the admin app", async () => {
    const openSpy = vi.spyOn(window, "open");

    render(
      <MemoryRouter initialEntries={["/admin/communications"]}>
        <Routes>
          <Route path="/admin/communications" element={<CallLogTabV2 />} />
          <Route path="/admin/customers/new" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Create Lead" }));

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/admin/customers/new?phone=%2B19415550123&city=Lakewood+Ranch&state=FL",
      );
    });
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("renderTranscriptWithHighlight", () => {
  afterEach(() => cleanup());

  it("marks a quote the server grounded through punctuation- and case-insensitive matching", () => {
    const text = "Agent: We'll call you back Tuesday, first thing. Caller: Thanks.";
    const { container } = render(<p>{renderTranscriptWithHighlight(text, "we\u2019ll call you back tuesday first thing", "c1")}</p>);
    const mark = container.querySelector("mark#call-transcript-mark-c1");
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe("We'll call you back Tuesday, first thing");
    expect(container.textContent).toBe(text);
  });

  it("returns the plain text when the quote is not in the transcript", () => {
    const { container } = render(<p>{renderTranscriptWithHighlight("Agent: fixture line.", "not here", "c1")}</p>);
    expect(container.querySelector("mark")).toBeNull();
    expect(container.textContent).toBe("Agent: fixture line.");
  });
});
