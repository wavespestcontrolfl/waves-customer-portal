// @vitest-environment jsdom
// Staff roof read panel (GATE_ROOF_ENTRY_READ): the Read the roof tap is the only thing that posts, each status
// reads plainly, pins are drawn from the read, and the tech's count saves with the PATCH.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RoofReadPanel, { ROOF_TYPES, roofSpotFrom, roofAddressDoubtful } from "./RoofReadPanel";

const SPOT = { lat: 27.46, lng: -82.57, county: "Manatee" };
const EST = "11111111-1111-4111-8111-111111111111";
const CUST = "22222222-2222-4222-8222-222222222222";
const IMAGE = "https://example.test/export?bbox=1,2,3,4";

const flagsOf = (over = {}) => Object.fromEntries(ROOF_TYPES.map(({ key }) => [key, { likely: "no", pins: [], ...(over[key] || {}) }]));
const READ = (over = {}) => ({
  id: "33333333-3333-4333-8333-333333333333", county: "manatee", image_source: "manatee_2025_rgb", image_year: 2025,
  tier: "high", tech_final_count: null, tech_final_flags: null,
  flags: flagsOf({
    plumbing_vent_stacks: { likely: "yes", pins: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.1 }] },
    gable_vents: { likely: "unsure" },
  }),
  ...over,
});

function reply(body, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body });
}

let fetchMock;
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
beforeEach(() => {
  localStorage.setItem("waves_admin_token", "qa-token");
  fetchMock = vi.fn(() => reply({ status: "ok", cached: false, read: READ(), image_url: IMAGE }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const tap = () => fireEvent.click(screen.getByTestId("roof-read-button"));

describe("the Read the roof tap", () => {
  it("posts nothing until staff tap, then sends the lookup's point, county and the ids", async () => {
    render(<RoofReadPanel spot={SPOT} estimateId={EST} customerId={CUST} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    tap();
    await screen.findByTestId("roof-read-result");
    expect(posts()).toHaveLength(1);
    const [url, init] = posts()[0];
    expect(String(url)).toMatch(/\/admin\/roof-entry-read$/);
    expect(JSON.parse(init.body)).toEqual({ lat: 27.46, lng: -82.57, county: "Manatee", estimate_id: EST, customer_id: CUST });
  });

  it("leaves the ids out when the tool has none, and offers no button without a looked-up point", async () => {
    const { rerender } = render(<RoofReadPanel spot={SPOT} />);
    tap();
    await screen.findByTestId("roof-read-result");
    expect(JSON.parse(posts()[0][1].body)).toEqual({ lat: 27.46, lng: -82.57, county: "Manatee" });
    rerender(<RoofReadPanel spot={null} />);
    expect(screen.getByTestId("roof-read-no-spot")).toBeInTheDocument();
  });

  it("cannot be double-tapped while a read is running", async () => {
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { finish = () => r({ ok: true, status: 200, json: async () => ({ status: "ok", cached: false, read: READ(), image_url: IMAGE }) }); }));
    render(<RoofReadPanel spot={SPOT} />);
    tap();
    expect(screen.getByTestId("roof-read-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("roof-read-button"));
    expect(posts()).toHaveLength(1);
    finish();
    await screen.findByTestId("roof-read-result");
  });
});

describe("statuses", () => {
  it.each([
    ["in_progress", 202, /still running/],
    ["no_image", 200, /No county photo/],
    ["model_failed", 200, /read failed/],
  ])("shows %s plainly with a retry button", async (status, code, copy) => {
    fetchMock.mockImplementationOnce(() => reply({ status, cached: false, read: null }, code));
    render(<RoofReadPanel spot={SPOT} />);
    tap();
    expect(await screen.findByTestId(`roof-read-${status}`)).toHaveTextContent(copy);
    expect(screen.queryByTestId("roof-read-result")).toBeNull();
    fireEvent.click(screen.getByTestId("roof-read-button"));
    await screen.findByTestId("roof-read-result");
    expect(posts()).toHaveLength(2);
  });

  it("says so when the server refuses, and when the gate is off", async () => {
    fetchMock.mockImplementationOnce(() => reply({ error: "reference_mismatch" }, 400));
    render(<RoofReadPanel spot={SPOT} />);
    tap();
    expect(await screen.findByTestId("roof-read-error")).toHaveTextContent(/different customer/);
    fetchMock.mockImplementationOnce(() => reply({ enabled: false }, 404));
    tap();
    await waitFor(() => expect(screen.getByTestId("roof-read-error")).toHaveTextContent(/switched off/));
  });
});

describe("an ok read", () => {
  it("shows the county crop, a pin for each point, the tier, and the AI answer for every type", async () => {
    render(<RoofReadPanel spot={SPOT} />);
    tap();
    const image = await screen.findByTestId("roof-read-image");
    expect(image.querySelector("img")).toHaveAttribute("src", IMAGE);
    const pins = screen.getAllByTestId("roof-read-pin");
    expect(pins).toHaveLength(2);
    expect(pins[0].style.left).toBe("25%");
    expect(pins[0].style.top).toBe("50%");
    expect(pins[1].style.left).toBe("75%");
    expect(pins[0]).toHaveAttribute("data-type", "plumbing_vent_stacks");
    expect(screen.getByTestId("roof-read-tier")).toHaveTextContent("High");
    expect(screen.getByTestId("roof-read-ai-plumbing_vent_stacks")).toHaveTextContent("Yes");
    expect(screen.getByTestId("roof-read-ai-gable_vents")).toHaveTextContent("Unsure");
    expect(screen.getByTestId("roof-read-ai-chimney_or_flue")).toHaveTextContent("No");
    expect(screen.queryByTestId("roof-read-button")).toBeNull();
  });

  it("saves the tech's count and flags with the PATCH and shows the saved values beside the AI read", async () => {
    render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    fetchMock.mockImplementationOnce((url, init) => reply({ read: READ({ tech_final_count: 4, tech_final_flags: JSON.parse(init.body).flags }) }));
    fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Tech saw: Plumbing vent stacks" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tech saw: Chimney or flue" }));
    fireEvent.click(screen.getByTestId("roof-read-save"));
    await screen.findByText("Saved.");
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(String(patch[0])).toMatch(/\/admin\/roof-entry-read\/33333333-3333-4333-8333-333333333333\/tech-count$/);
    const body = JSON.parse(patch[1].body);
    expect(body.count).toBe(4);
    // Only the two types the tech touched are sent.
    expect(body.flags).toEqual({ plumbing_vent_stacks: "yes", chimney_or_flue: "yes" });
    expect(screen.getByTestId("roof-read-saved")).toHaveTextContent("Saved tech count: 4.");
  });

  it("sends no flags on a count-only save, and shows untouched saved values as they are", async () => {
    fetchMock.mockImplementationOnce(() => reply({
      status: "ok", cached: true, image_url: IMAGE,
      read: READ({ tech_final_count: 1, tech_final_flags: { gable_vents: "unsure", chimney_or_flue: "no", plumbing_vent_stacks: "yes" } }),
    }));
    render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    expect(screen.getByTestId("roof-read-saved-gable_vents")).toHaveTextContent("Unsure");
    expect(screen.getByTestId("roof-read-saved-chimney_or_flue")).toHaveTextContent("No");
    expect(screen.getByTestId("roof-read-saved-soffit_or_fascia_gaps")).toHaveTextContent("None");
    fetchMock.mockImplementationOnce(() => reply({ read: READ({ tech_final_count: 6, tech_final_flags: { gable_vents: "unsure" } }) }));
    fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: "6" } });
    fireEvent.click(screen.getByTestId("roof-read-save"));
    await screen.findByText("Saved.");
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(patch[1].body)).toEqual({ count: 6 });
  });

  it("sends only the touched flag, and no count when the count was not edited", async () => {
    fetchMock.mockImplementationOnce(() => reply({
      status: "ok", cached: true, image_url: IMAGE,
      read: READ({ tech_final_count: 1, tech_final_flags: { gable_vents: "unsure" } }),
    }));
    render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    expect(screen.getByLabelText("Entry points the tech counted")).toHaveValue(1);
    fetchMock.mockImplementationOnce(() => reply({ read: READ({ tech_final_count: 1, tech_final_flags: { gable_vents: "unsure", chimney_or_flue: "yes" } }) }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tech saw: Chimney or flue" }));
    fireEvent.click(screen.getByTestId("roof-read-save"));
    await screen.findByText("Saved.");
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    // The untouched saved unsure and the unedited count stay out of the body: the server merges the rest.
    expect(JSON.parse(patch[1].body)).toEqual({ flags: { chimney_or_flue: "yes" } });
    expect(screen.getByTestId("roof-read-saved-gable_vents")).toHaveTextContent("Unsure");
    expect(screen.getByTestId("roof-read-saved-chimney_or_flue")).toHaveTextContent("Yes");
  });

  it("cannot save until the estimate has an id, and says so", async () => {
    const { rerender } = render(<RoofReadPanel spot={SPOT} />);
    tap();
    await screen.findByTestId("roof-read-result");
    expect(screen.getByTestId("roof-read-save")).toBeDisabled();
    expect(screen.getByTestId("roof-read-save-first")).toHaveTextContent("Save the estimate first to record the tech's count.");
    fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("roof-read-save"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    rerender(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    expect(screen.getByTestId("roof-read-save")).not.toBeDisabled();
    expect(screen.queryByTestId("roof-read-save-first")).toBeNull();
  });

  it("locks the count, the checkboxes and Save while a save is pending", async () => {
    render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { finish = () => r({ ok: true, status: 200, json: async () => ({ read: READ({ tech_final_count: 2 }) }) }); }));
    fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("roof-read-save"));
    await waitFor(() => expect(screen.getByTestId("roof-read-save")).toBeDisabled());
    expect(screen.getByLabelText("Entry points the tech counted")).toBeDisabled();
    for (const { label } of ROOF_TYPES) expect(screen.getByRole("checkbox", { name: `Tech saw: ${label}` })).toBeDisabled();
    fireEvent.click(screen.getByTestId("roof-read-save"));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    finish();
    await screen.findByText("Saved.");
    expect(screen.getByLabelText("Entry points the tech counted")).not.toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Tech saw: Gable vents" })).not.toBeDisabled();
  });

  it("sends nothing when there is no count and no touched entry point", async () => {
    render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    fireEvent.click(screen.getByTestId("roof-read-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Change the count or an entry point first/);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("refuses a count that is not a whole number from 0 to 500 without sending it", async () => {
    render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    for (const bad of ["-1", "2.5", "501"]) {
      fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: bad } });
      fireEvent.click(screen.getByTestId("roof-read-save"));
      expect(await screen.findByRole("alert")).toHaveTextContent(/whole number/);
    }
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("starts from the tech values already saved on a reused read", async () => {
    fetchMock.mockImplementationOnce(() => reply({
      status: "ok", cached: true, image_url: IMAGE,
      read: READ({ tech_final_count: 2, tech_final_flags: { gable_vents: "yes" } }),
    }));
    render(<RoofReadPanel spot={SPOT} />);
    tap();
    await screen.findByTestId("roof-read-result");
    expect(screen.getByLabelText("Entry points the tech counted")).toHaveValue(2);
    expect(screen.getByRole("checkbox", { name: "Tech saw: Gable vents" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Tech saw: Plumbing vent stacks" })).not.toBeChecked();
    expect(screen.getByText(/Reused from an earlier read/)).toBeInTheDocument();
  });
});

describe("a snapped neighbour", () => {
  it("offers no read and says to fix the address", async () => {
    render(<RoofReadPanel spot={null} addressDoubt />);
    expect(screen.getByTestId("roof-read-snapped")).toHaveTextContent("The map point may be a neighbour's house. Fix the address first.");
    expect(screen.queryByTestId("roof-read-button")).toBeNull();
    expect(screen.queryByTestId("roof-read-no-spot")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is read from the lookup's snappedRecord marker, on the audit or on the record", () => {
    const good = { propertyRecord: { latitude: 27.5, longitude: -82.5, county: "Manatee" } };
    expect(roofAddressDoubtful(good)).toBe(false);
    for (const data of [
      { ...good, addressAudit: { snappedRecord: { typed: "10", record: "12" } } },
      { propertyRecord: { ...good.propertyRecord, _addressAudit: { snappedRecord: { typed: "10", record: "12" } } } },
    ]) {
      expect(roofAddressDoubtful(data)).toBe(true);
      expect(roofSpotFrom(data)).toBeNull();
    }
    expect(roofSpotFrom({ ...good, addressAudit: { hasExactMatch: true } })).not.toBeNull();
    // An address verify flag on the lookup's profile blocks it too; other flags do not.
    const flagged = { ...good, enriched: { fieldVerifyFlags: [{ field: "homeSqFt", reason: "x" }, { field: "address", reason: "Verify the address" }] } };
    expect(roofAddressDoubtful(flagged)).toBe(true);
    expect(roofSpotFrom(flagged)).toBeNull();
    expect(roofAddressDoubtful({ ...good, enriched: { fieldVerifyFlags: [{ field: "homeSqFt" }] } })).toBe(false);
  });
});

describe("roofSpotFrom", () => {
  it("takes the lookup's map point and county, and is null without either", () => {
    expect(roofSpotFrom({ satellite: { lat: 27.5, lng: -82.5 }, propertyRecord: { _parcel: { county: "Sarasota" } } })).toEqual({ lat: 27.5, lng: -82.5, county: "Sarasota" });
    expect(roofSpotFrom({ propertyRecord: { latitude: 27.5, longitude: -82.5, county: "Charlotte" } })).toEqual({ lat: 27.5, lng: -82.5, county: "Charlotte" });
    expect(roofSpotFrom({ propertyRecord: { latitude: 27.5, longitude: -82.5 } })).toBeNull();
    expect(roofSpotFrom({ propertyRecord: { county: "Manatee" } })).toBeNull();
    expect(roofSpotFrom({ propertyRecord: { latitude: null, longitude: "", county: "Manatee" } })).toBeNull();
    expect(roofSpotFrom(null)).toBeNull();
  });
});
