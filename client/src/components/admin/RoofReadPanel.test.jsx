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
    // The count input and the checkboxes are under the same guard, so nothing can be entered that cannot be saved.
    expect(screen.getByLabelText("Entry points the tech counted")).toBeDisabled();
    for (const { label } of ROOF_TYPES) expect(screen.getByRole("checkbox", { name: `Tech saw: ${label}` })).toBeDisabled();
    fireEvent.click(screen.getByTestId("roof-read-save"));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    rerender(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    expect(screen.getByTestId("roof-read-save")).not.toBeDisabled();
    expect(screen.getByLabelText("Entry points the tech counted")).not.toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Tech saw: Gable vents" })).not.toBeDisabled();
    expect(screen.queryByTestId("roof-read-save-first")).toBeNull();
  });

  it("shows what the server returns after a save, not what was typed", async () => {
    render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    fetchMock.mockImplementationOnce(() => reply({ read: READ({ tech_final_count: 9, tech_final_flags: { gable_vents: "yes" } }) }));
    fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Tech saw: Chimney or flue" }));
    fireEvent.click(screen.getByTestId("roof-read-save"));
    await screen.findByText("Saved.");
    expect(screen.getByLabelText("Entry points the tech counted")).toHaveValue(9);
    expect(screen.getByRole("checkbox", { name: "Tech saw: Gable vents" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Tech saw: Chimney or flue" })).not.toBeChecked();
    // The edited markers are clear: the next save of nothing sends nothing.
    fireEvent.click(screen.getByTestId("roof-read-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Change the count or an entry point first/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
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

// ── Technician-confirmed points (owner ruling 2026-11-20, choice 4A) ──────────────────────────────────────────────────

describe("confirmed points", () => {
  const READ_ID = "33333333-3333-4333-8333-333333333333";
  const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  const lastBody = () => JSON.parse(patches().at(-1)[1].body);
  const frame = () => screen.getByTestId("roof-read-image");
  // jsdom has no layout: give the photo a 200 x 100 box at the page origin, so a tap at (50, 25) is x 0.25, y 0.25.
  const loadPhoto = () => fireEvent.load(frame().querySelector("img"));
  const sizeFrame = () => { frame().getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 }); };
  const opened = async (props = {}, read = READ()) => {
    fetchMock.mockImplementationOnce(() => reply({ status: "ok", cached: false, read, image_url: IMAGE }));
    const view = render(<RoofReadPanel spot={SPOT} estimateId={EST} {...props} />);
    tap();
    await screen.findByTestId("roof-read-result");
    sizeFrame();
    loadPhoto();
    return view;
  };
  const SAVED = [
    { x: 0.2, y: 0.3, type: "gable_vents", note: "front left" },
    { x: 0.6, y: 0.4, type: "other", note: null },
  ];

  it("draws the AI's yes pins as faded suggestions with a type letter, and confirmed points as numbered solid pins", async () => {
    await opened({}, READ({ tech_pins: SAVED }));
    const suggestions = screen.getAllByTestId("roof-read-pin");
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toHaveTextContent("P");
    expect(suggestions[0].className).toMatch(/opacity-70/);
    const points = screen.getAllByTestId("roof-read-point");
    expect(points.map((p) => p.textContent)).toEqual(["1", "2"]);
    expect(points[0].style.left).toBe("20%");
    expect(points[0].style.top).toBe("30%");
    expect(points[0]).toHaveAttribute("data-type", "gable_vents");
    expect(screen.getByTestId("roof-read-point-row-1")).toHaveTextContent("1. Gable vents, front left");
    // An "unsure" or "no" type draws no suggestion.
    expect(screen.getByTestId("roof-read-legend")).toHaveTextContent("P Plumbing vent stacks");
    expect(screen.getByTestId("roof-read-legend")).not.toHaveTextContent("Gable");
    expect(screen.getByTestId("roof-read-point-count")).toHaveTextContent("2 of 20 points");
  });

  it("posts nothing on load or while editing, and tapping a suggestion confirms it with the AI type", async () => {
    await opened();
    expect(screen.queryAllByTestId("roof-read-point")).toHaveLength(0);
    fireEvent.click(screen.getAllByTestId("roof-read-pin")[1]);
    const points = screen.getAllByTestId("roof-read-point");
    expect(points).toHaveLength(1);
    expect(points[0]).toHaveAttribute("data-type", "plumbing_vent_stacks");
    expect(points[0].style.left).toBe("75%");
    expect(points[0].style.top).toBe("10%");
    // The confirmed suggestion is no longer a suggestion.
    expect(screen.getAllByTestId("roof-read-pin")).toHaveLength(1);
    expect(screen.getByTestId("roof-read-point-editor")).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(patches()).toHaveLength(0);
  });

  it("adds an 'other' point where the empty photo is tapped, and not when a point is tapped", async () => {
    await opened();
    fireEvent.click(frame(), { clientX: 50, clientY: 25 });
    const points = screen.getAllByTestId("roof-read-point");
    expect(points).toHaveLength(1);
    expect(points[0]).toHaveAttribute("data-type", "other");
    expect(points[0].style.left).toBe("25%");
    expect(points[0].style.top).toBe("25%");
    fireEvent.click(points[0]);
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(1);
  });

  it("edits the selected point: type, a note of at most 40 characters, and Remove", async () => {
    await opened();
    fireEvent.click(frame(), { clientX: 50, clientY: 25 });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "chimney_or_flue" } });
    const note = screen.getByLabelText("Note");
    expect(note).toHaveAttribute("placeholder", "front left");
    expect(note).toHaveAttribute("maxlength", "40");
    fireEvent.change(note, { target: { value: "x".repeat(60) } });
    expect(note).toHaveValue("x".repeat(40));
    fireEvent.change(note, { target: { value: "back right" } });
    const point = screen.getByTestId("roof-read-point");
    expect(point).toHaveAttribute("data-type", "chimney_or_flue");
    expect(screen.getByTestId("roof-read-point-row-1")).toHaveTextContent("1. Chimney or flue, back right");
    fireEvent.click(screen.getByTestId("roof-read-point-remove"));
    expect(screen.queryAllByTestId("roof-read-point")).toHaveLength(0);
    expect(screen.queryByTestId("roof-read-point-editor")).toBeNull();
  });

  it("removing a point that came from a suggestion brings the suggestion back", async () => {
    await opened();
    fireEvent.click(screen.getAllByTestId("roof-read-pin")[0]);
    expect(screen.getAllByTestId("roof-read-pin")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("roof-read-point-remove"));
    expect(screen.getAllByTestId("roof-read-pin")).toHaveLength(2);
  });

  it("works from the keyboard: Add a point, arrow keys nudge by 1%, Delete removes, and the editor shows on select", async () => {
    await opened();
    fireEvent.click(screen.getByTestId("roof-read-add-point"));
    const point = screen.getByTestId("roof-read-point");
    expect(point.style.left).toBe("50%");
    expect(point.style.top).toBe("50%");
    expect(point.tagName).toBe("BUTTON");
    fireEvent.keyDown(point, { key: "ArrowRight" });
    fireEvent.keyDown(point, { key: "ArrowRight" });
    fireEvent.keyDown(point, { key: "ArrowUp" });
    expect(screen.getByTestId("roof-read-point").style.left).toBe("52%");
    expect(screen.getByTestId("roof-read-point").style.top).toBe("49%");
    fireEvent.keyDown(point, { key: "ArrowLeft" });
    fireEvent.keyDown(point, { key: "ArrowDown" });
    expect(screen.getByTestId("roof-read-point").style.left).toBe("51%");
    expect(screen.getByTestId("roof-read-point").style.top).toBe("50%");
    // Done closes the editor; Enter on the pin (a click) selects it again.
    fireEvent.click(screen.getByTestId("roof-read-point-done"));
    expect(screen.queryByTestId("roof-read-point-editor")).toBeNull();
    fireEvent.click(screen.getByTestId("roof-read-point"));
    expect(screen.getByTestId("roof-read-point-editor")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("roof-read-point"), { key: "Delete" });
    expect(screen.queryAllByTestId("roof-read-point")).toHaveLength(0);
  });

  it("keeps a nudged point inside the photo", async () => {
    await opened({}, READ({ tech_pins: [{ x: 1, y: 0, type: "other", note: null }] }));
    const point = screen.getByTestId("roof-read-point");
    fireEvent.keyDown(point, { key: "ArrowRight" });
    fireEvent.keyDown(point, { key: "ArrowUp" });
    expect(point.style.left).toBe("100%");
    expect(point.style.top).toBe("0%");
  });

  it("drags a point with pointer events, and a drag does not toggle the editor", async () => {
    // jsdom has no PointerEvent, so a fired pointer event would lose its coordinates: use a mouse event with a pointer id.
    const hadPointerEvent = "PointerEvent" in window;
    if (!hadPointerEvent) {
      window.PointerEvent = class PointerEvent extends MouseEvent {
        constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId; }
      };
    }
    try {
      await dragCase();
    } finally {
      if (!hadPointerEvent) delete window.PointerEvent;
    }
  });

  async function dragCase() {
    await opened({}, READ({ tech_pins: SAVED }));
    const point = screen.getAllByTestId("roof-read-point")[0];
    fireEvent.pointerDown(point, { clientX: 40, clientY: 30, pointerId: 1, button: 0 });
    fireEvent.pointerMove(point, { clientX: 100, clientY: 50, pointerId: 1 });
    expect(screen.getAllByTestId("roof-read-point")[0].style.left).toBe("50%");
    expect(screen.getAllByTestId("roof-read-point")[0].style.top).toBe("50%");
    fireEvent.pointerMove(point, { clientX: 900, clientY: -40, pointerId: 1 });
    expect(screen.getAllByTestId("roof-read-point")[0].style.left).toBe("100%");
    expect(screen.getAllByTestId("roof-read-point")[0].style.top).toBe("0%");
    fireEvent.pointerUp(point, { pointerId: 1 });
    fireEvent.click(point);
    expect(screen.queryByTestId("roof-read-point-editor")).toBeNull();
    // After the drag has ended, moving the pointer moves nothing.
    fireEvent.pointerMove(point, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(screen.getAllByTestId("roof-read-point")[0].style.left).toBe("100%");
    // A plain tap (no movement) selects it.
    fireEvent.pointerDown(point, { clientX: 5, clientY: 5, pointerId: 1, button: 0 });
    fireEvent.pointerUp(point, { pointerId: 1 });
    fireEvent.click(point);
    expect(screen.getByTestId("roof-read-point-editor")).toBeInTheDocument();
  }

  it("stops adding at 20 points, says so, and adds again after a removal", async () => {
    await opened({}, READ({ tech_pins: Array.from({ length: 19 }, (_, i) => ({ x: i / 40, y: 0.5, type: "other", note: null })) }));
    expect(screen.queryByTestId("roof-read-point-max")).toBeNull();
    fireEvent.click(frame(), { clientX: 100, clientY: 50 });
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(20);
    expect(screen.getByTestId("roof-read-point-max")).toBeInTheDocument();
    expect(screen.getByTestId("roof-read-add-point")).toBeDisabled();
    fireEvent.click(frame(), { clientX: 120, clientY: 60 });
    fireEvent.click(screen.getAllByTestId("roof-read-pin")[0]);
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(20);
    fireEvent.click(screen.getByTestId("roof-read-point-remove"));
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(19);
    expect(screen.queryByTestId("roof-read-point-max")).toBeNull();
  });

  it("shows the hide checkbox checked by default and unchecked when the saved read is hidden", async () => {
    await opened();
    expect(screen.getByRole("checkbox", { name: "Show these points on the customer estimate" })).toBeChecked();
    cleanup();
    await opened({}, READ({ hide_on_estimate: true, tech_pins: SAVED }));
    expect(screen.getByRole("checkbox", { name: "Show these points on the customer estimate" })).not.toBeChecked();
  });

  it("saves the exact payload: the points, the panel's own map point as the crop, and the hide flag", async () => {
    await opened();
    fireEvent.click(screen.getAllByTestId("roof-read-pin")[0]);
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "  front left  " } });
    fireEvent.click(frame(), { clientX: 50, clientY: 25 });
    fireEvent.click(screen.getByRole("checkbox", { name: "Show these points on the customer estimate" }));
    fetchMock.mockImplementationOnce(() => reply({
      read: READ({
        hide_on_estimate: true,
        tech_pins: [{ x: 0.25, y: 0.5, type: "plumbing_vent_stacks", note: "front left", source: "plumbing_vent_stacks:0" }, { x: 0.25, y: 0.25, type: "other", note: null }],
      }),
    }));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    await screen.findByText("Points saved.");
    expect(patches()).toHaveLength(1);
    expect(String(patches()[0][0])).toMatch(new RegExp(`/admin/roof-entry-read/${READ_ID}/tech-count$`));
    expect(lastBody()).toEqual({
      pins: [
        { x: 0.25, y: 0.5, type: "plumbing_vent_stacks", note: "front left", source: "plumbing_vent_stacks:0" },
        { x: 0.25, y: 0.25, type: "other", note: null },
      ],
      crop: { lat: 27.46, lng: -82.57 },
      expected_pins: null,
      hide_on_estimate: true,
    });
    // The count and flags are not part of a points save.
    expect(lastBody()).not.toHaveProperty("count");
    expect(lastBody()).not.toHaveProperty("flags");
    expect(screen.getByRole("checkbox", { name: "Show these points on the customer estimate" })).not.toBeChecked();
  });

  it("takes the server's values after a save, and clears the edited marker", async () => {
    await opened();
    fireEvent.click(frame(), { clientX: 50, clientY: 25 });
    fetchMock.mockImplementationOnce(() => reply({ read: READ({ tech_pins: [{ x: 0.9, y: 0.9, type: "gable_vents", note: "server" }] }) }));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    await screen.findByText("Points saved.");
    const points = screen.getAllByTestId("roof-read-point");
    expect(points).toHaveLength(1);
    expect(points[0].style.left).toBe("90%");
    expect(screen.getByTestId("roof-read-point-row-1")).toHaveTextContent("1. Gable vents, server");
    expect(screen.queryByTestId("roof-read-point-editor")).toBeNull();
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    expect(await screen.findByTestId("roof-read-points-error")).toHaveTextContent(/Change a point or the checkbox first/);
    expect(patches()).toHaveLength(1);
  });

  it("can save an empty list after the last point is removed, and shows the server's refusal", async () => {
    await opened({}, READ({ tech_pins: SAVED }));
    fireEvent.click(screen.getAllByTestId("roof-read-point")[0]);
    fireEvent.click(screen.getByTestId("roof-read-point-remove"));
    fireEvent.click(screen.getAllByTestId("roof-read-point")[0]);
    fireEvent.click(screen.getByTestId("roof-read-point-remove"));
    fetchMock.mockImplementationOnce(() => reply({ error: "These points were not drawn on this roof photo" }, 400));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    expect(await screen.findByTestId("roof-read-points-error")).toHaveTextContent("These points were not drawn on this roof photo");
    expect(lastBody().pins).toEqual([]);
    // The points stay as edited so staff can try again.
    expect(screen.queryAllByTestId("roof-read-point")).toHaveLength(0);
  });

  it("locks the points and Save while a save is pending", async () => {
    await opened();
    fireEvent.click(frame(), { clientX: 50, clientY: 25 });
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { finish = () => r({ ok: true, status: 200, json: async () => ({ read: READ({ tech_pins: [] }) }) }); }));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    await waitFor(() => expect(screen.getByTestId("roof-read-points-save")).toBeDisabled());
    expect(screen.getByTestId("roof-read-add-point")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Show these points on the customer estimate" })).toBeDisabled();
    fireEvent.click(frame(), { clientX: 80, clientY: 40 });
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    expect(patches()).toHaveLength(1);
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(1);
    finish();
    await screen.findByText("Points saved.");
  });

  it("cannot save, add or edit points until the estimate has an id, and says so", async () => {
    await opened({ estimateId: null });
    expect(screen.getByTestId("roof-read-points-save")).toBeDisabled();
    expect(screen.getByTestId("roof-read-points-save-first")).toHaveTextContent("Save the estimate first to record the tech's points.");
    expect(screen.getByTestId("roof-read-add-point")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Show these points on the customer estimate" })).toBeDisabled();
    fireEvent.click(frame(), { clientX: 50, clientY: 25 });
    expect(screen.queryAllByTestId("roof-read-point")).toHaveLength(0);
    for (const s of screen.getAllByTestId("roof-read-pin")) expect(s).toBeDisabled();
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    expect(patches()).toHaveLength(0);
  });

  it("leaves the count and flags save as it was: a count save sends no points", async () => {
    await opened({}, READ({ tech_pins: SAVED }));
    fetchMock.mockImplementationOnce(() => reply({ read: READ({ tech_final_count: 3, tech_pins: SAVED }) }));
    fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("roof-read-save"));
    await screen.findByText("Saved.");
    expect(lastBody()).toEqual({ count: 3 });
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(2);
  });

  it("shows a save that could not reach the server, without losing the points", async () => {
    await opened();
    fireEvent.click(frame(), { clientX: 50, clientY: 25 });
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    expect(await screen.findByTestId("roof-read-points-error")).toHaveTextContent(/Could not reach the server/);
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(1);
  });
});

describe("saving only what changed", () => {
  const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  const lastBody = () => JSON.parse(patches().at(-1)[1].body);
  const frame = () => screen.getByTestId("roof-read-image");
  const SHOW = { name: "Show these points on the customer estimate" };
  const SAVED = [{ x: 0.2, y: 0.3, type: "gable_vents", note: "front left", source: null }];
  const opened = async (read = READ({ tech_pins: SAVED })) => {
    fetchMock.mockImplementationOnce(() => reply({ status: "ok", cached: false, read, image_url: IMAGE }));
    render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    frame().getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
    fireEvent.load(frame().querySelector("img"));
  };

  it("sends only hide_on_estimate when only the checkbox changed, with no points and no crop", async () => {
    await opened();
    fireEvent.click(screen.getByRole("checkbox", SHOW));
    fetchMock.mockImplementationOnce(() => reply({ read: READ({ hide_on_estimate: true, tech_pins: SAVED }) }));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    await screen.findByText("Points saved.");
    expect(lastBody()).toEqual({ hide_on_estimate: true });
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(1);
  });

  it("sends only the points and crop when only the points changed", async () => {
    await opened();
    fireEvent.click(frame(), { clientX: 100, clientY: 50 });
    fetchMock.mockImplementationOnce(() => reply({ read: READ({ tech_pins: [...SAVED, { x: 0.5, y: 0.5, type: "other", note: null }] }) }));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    await screen.findByText("Points saved.");
    const body = lastBody();
    expect(Object.keys(body).sort()).toEqual(["crop", "expected_pins", "pins"]);
    expect(body.pins).toHaveLength(2);
  });

  it("sends nothing and says so when the checkbox is toggled back to what the server holds", async () => {
    await opened();
    fireEvent.click(screen.getByRole("checkbox", SHOW));
    fireEvent.click(screen.getByRole("checkbox", SHOW));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    expect(await screen.findByTestId("roof-read-points-error")).toHaveTextContent("Change a point or the checkbox first.");
    expect(patches()).toHaveLength(0);
  });

  it("names the list the points were loaded with, not one a count answer carried from another window", async () => {
    await opened();
    fetchMock.mockImplementationOnce(() => reply({
      read: READ({ tech_final_count: 1, tech_pins: [{ x: 0.9, y: 0.9, type: "other", note: null }] }),
    }));
    fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("roof-read-save"));
    await screen.findByText("Saved.");
    // The panel still shows (and edits) the list it loaded, so the server must compare against that list.
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(1);
    fireEvent.click(frame(), { clientX: 100, clientY: 50 });
    fetchMock.mockImplementationOnce(() => reply({ error: "These points were changed in another window. Read the roof again to load them." }, 409));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    await screen.findByTestId("roof-read-points-error");
    expect(lastBody().expected_pins).toEqual(SAVED);
  });

  it("does not let a late points answer roll back flags a count save stored meanwhile", async () => {
    await opened(READ({ tech_pins: SAVED, tech_final_flags: null }));
    let finishPoints;
    fireEvent.click(frame(), { clientX: 100, clientY: 50 });
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finishPoints = resolve; }));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    fetchMock.mockImplementationOnce((url, init) => reply({ read: READ({ tech_pins: SAVED, tech_final_flags: JSON.parse(init.body).flags }) }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tech saw: Plumbing vent stacks" }));
    fireEvent.click(screen.getByTestId("roof-read-save"));
    await screen.findByText("Saved.");
    expect(screen.getByTestId("roof-read-saved-plumbing_vent_stacks")).not.toHaveTextContent("None");
    finishPoints(await reply({ read: READ({ tech_pins: [...SAVED, { x: 0.5, y: 0.5, type: "other", note: null }], tech_final_flags: null }) }));
    await screen.findByText("Points saved.");
    // The "Tech saved" column still shows the flag the count save stored.
    expect(screen.getByTestId("roof-read-saved-plumbing_vent_stacks")).not.toHaveTextContent("None");
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(2);
  });

  it("sends the list the edits started from, and on a 409 keeps the edits and offers to read again", async () => {
    await opened();
    fireEvent.click(frame(), { clientX: 100, clientY: 50 });
    fetchMock.mockImplementationOnce(() => reply({ error: "These points were changed in another window. Read the roof again to load them." }, 409));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    expect(await screen.findByTestId("roof-read-points-error")).toHaveTextContent("changed in another window");
    expect(lastBody().expected_pins).toEqual(SAVED);
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(2);
    // "Read the roof again" re-posts the read (a free reuse of this estimate's read) and loads the saved points.
    fetchMock.mockImplementationOnce(() => reply({ status: "ok", cached: true, read: READ({ tech_pins: [...SAVED, ...SAVED] }), image_url: IMAGE }));
    fireEvent.click(screen.getByTestId("roof-read-again"));
    await waitFor(() => expect(screen.queryByTestId("roof-read-points-error")).toBeNull());
  });

  it("does not let a count answer that started before a checkbox save undo it", async () => {
    await opened();
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("roof-read-save"));
    // While the count save is in flight, staff hide the points and that save lands first.
    fireEvent.click(screen.getByRole("checkbox", SHOW));
    fetchMock.mockImplementationOnce(() => reply({ read: READ({ hide_on_estimate: true, tech_pins: SAVED }) }));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    await screen.findByText("Points saved.");
    finish(await reply({ read: READ({ tech_final_count: 2, hide_on_estimate: false, tech_pins: SAVED }) }));
    await screen.findByText("Saved.");
    expect(screen.getByRole("checkbox", SHOW)).not.toBeChecked();
  });

  it("locks the points editor on a read whose AI answer did not work, and says to read again", async () => {
    await opened(READ({ tier: "unknown", flags: {}, tech_pins: null }));
    expect(screen.getByTestId("roof-read-points-unusable")).toHaveTextContent("This roof read did not work. Read the roof again before adding points.");
    expect(screen.getByTestId("roof-read-add-point")).toBeDisabled();
    fireEvent.click(frame(), { clientX: 100, clientY: 50 });
    expect(screen.queryAllByTestId("roof-read-point")).toHaveLength(0);
    expect(screen.getByTestId("roof-read-again")).toBeInTheDocument();
  });

  it("applies a checkbox click made while a count save is in flight (the late answer does not undo it)", async () => {
    await opened();
    let finish;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("roof-read-save"));
    fireEvent.click(screen.getByRole("checkbox", SHOW));
    finish(await reply({ read: READ({ tech_final_count: 2, hide_on_estimate: false, tech_pins: SAVED }) }));
    await screen.findByText("Saved.");
    expect(screen.getByRole("checkbox", SHOW)).not.toBeChecked();
  });

  it("never sends an untouched checkbox, even after a count answer shows another tab's hide choice", async () => {
    await opened();
    expect(screen.getByRole("checkbox", SHOW)).toBeChecked();
    // A count save comes back with the points hidden by another tab; a count answer changes only the count and flags.
    fetchMock.mockImplementationOnce(() => reply({ read: READ({ tech_final_count: 2, hide_on_estimate: true, tech_pins: SAVED }) }));
    fireEvent.change(screen.getByLabelText("Entry points the tech counted"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("roof-read-save"));
    await screen.findByText("Saved.");
    // A later points save sends the points only, not a hide_on_estimate the staff member never chose.
    fireEvent.click(frame(), { clientX: 100, clientY: 50 });
    fetchMock.mockImplementationOnce(() => reply({ read: READ({ hide_on_estimate: true, tech_pins: [...SAVED, { x: 0.5, y: 0.5, type: "other", note: null }] }) }));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    await screen.findByText("Points saved.");
    expect(Object.keys(lastBody()).sort()).toEqual(["crop", "expected_pins", "pins"]);
  });

  it("needs the map point to save edited points", async () => {
    fetchMock.mockImplementationOnce(() => reply({ status: "ok", cached: false, read: READ({ tech_pins: SAVED }), image_url: IMAGE }));
    const { rerender } = render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    frame().getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
    fireEvent.load(frame().querySelector("img"));
    rerender(<RoofReadPanel spot={null} estimateId={EST} />);
    fireEvent.click(frame(), { clientX: 100, clientY: 50 });
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    expect(await screen.findByTestId("roof-read-points-error")).toHaveTextContent(/map point is missing/);
    expect(patches()).toHaveLength(0);
  });
});

describe("a suggestion's link to its confirmed point", () => {
  const patches = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  const frame = () => screen.getByTestId("roof-read-image");
  const opened = async (read = READ()) => {
    fetchMock.mockImplementationOnce(() => reply({ status: "ok", cached: false, read, image_url: IMAGE }));
    render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    frame().getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
    fireEvent.load(frame().querySelector("img"));
  };

  it("sends the source of a confirmed suggestion, keeps it through a move and a retype, and keeps the suggestion hidden after the save", async () => {
    await opened();
    expect(screen.getAllByTestId("roof-read-pin")).toHaveLength(2);
    // The second AI pin (index 1) is confirmed, then moved and retyped.
    fireEvent.click(screen.getAllByTestId("roof-read-pin")[1]);
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "chimney_or_flue" } });
    fireEvent.keyDown(screen.getByTestId("roof-read-point"), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByTestId("roof-read-point"), { key: "ArrowDown" });
    expect(screen.getAllByTestId("roof-read-pin")).toHaveLength(1);
    // The point added by tapping the photo has no source.
    fireEvent.click(frame(), { clientX: 20, clientY: 20 });
    // The server answers with its own normalized values, source included.
    fetchMock.mockImplementationOnce((url, init) => reply({
      read: READ({ tech_pins: JSON.parse(init.body).pins.map((p) => ({ source: null, ...p })) }),
    }));
    fireEvent.click(screen.getByTestId("roof-read-points-save"));
    await screen.findByText("Points saved.");
    const body = JSON.parse(patches()[0][1].body);
    expect(body.pins).toEqual([
      { x: 0.74, y: 0.11, type: "chimney_or_flue", note: null, source: "plumbing_vent_stacks:1" },
      { x: 0.1, y: 0.2, type: "other", note: null },
    ]);
    // After the reload from the server's values, the moved and retyped point still hides its suggestion.
    const suggestions = screen.getAllByTestId("roof-read-pin");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].style.left).toBe("25%");
    fireEvent.click(suggestions[0]);
    expect(screen.queryAllByTestId("roof-read-pin")).toHaveLength(0);
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(3);
  });

  it("hides every suggestion named by a saved point's source, and brings it back when that point is removed", async () => {
    await opened(READ({ tech_pins: [{ x: 0.9, y: 0.9, type: "other", note: null, source: "plumbing_vent_stacks:0" }] }));
    const suggestions = screen.getAllByTestId("roof-read-pin");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].style.left).toBe("75%");
    fireEvent.click(screen.getByTestId("roof-read-point"));
    fireEvent.click(screen.getByTestId("roof-read-point-remove"));
    expect(screen.getAllByTestId("roof-read-pin")).toHaveLength(2);
  });
});

describe("the county photo", () => {
  const frame = () => screen.getByTestId("roof-read-image");
  const render_ = async () => {
    render(<RoofReadPanel spot={SPOT} estimateId={EST} />);
    tap();
    await screen.findByTestId("roof-read-result");
    frame().getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
  };
  const SHOW = { name: "Show these points on the customer estimate" };

  it("disables the suggestions, adding a point and the photo until it loads, and says so", async () => {
    await render_();
    expect(screen.getByTestId("roof-read-image-loading")).toHaveTextContent("Loading the roof photo…");
    expect(screen.getByTestId("roof-read-add-point")).toBeDisabled();
    for (const s of screen.getAllByTestId("roof-read-pin")) expect(s).toBeDisabled();
    fireEvent.click(frame(), { clientX: 50, clientY: 25 });
    expect(screen.queryAllByTestId("roof-read-point")).toHaveLength(0);
    // The checkbox is about visibility, not the photo, so it stays usable.
    expect(screen.getByRole("checkbox", SHOW)).not.toBeDisabled();
    fireEvent.load(frame().querySelector("img"));
    expect(screen.queryByTestId("roof-read-image-loading")).toBeNull();
    expect(screen.getByTestId("roof-read-add-point")).not.toBeDisabled();
    for (const s of screen.getAllByTestId("roof-read-pin")) expect(s).not.toBeDisabled();
    fireEvent.click(frame(), { clientX: 50, clientY: 25 });
    expect(screen.getAllByTestId("roof-read-point")).toHaveLength(1);
  });

  it("says the photo did not load, keeps points off it, and Try again remounts the same image", async () => {
    await render_();
    const first = frame().querySelector("img");
    fireEvent.error(first);
    expect(screen.getByTestId("roof-read-image-error")).toHaveTextContent("The roof photo did not load.");
    expect(screen.queryByTestId("roof-read-image-loading")).toBeNull();
    expect(screen.getByTestId("roof-read-add-point")).toBeDisabled();
    fireEvent.click(frame(), { clientX: 50, clientY: 25 });
    expect(screen.queryAllByTestId("roof-read-point")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("roof-read-image-retry"));
    const second = frame().querySelector("img");
    expect(second).not.toBe(first);
    expect(second).toHaveAttribute("src", IMAGE);
    expect(screen.getByTestId("roof-read-image-loading")).toBeInTheDocument();
    fireEvent.load(second);
    expect(screen.getByTestId("roof-read-add-point")).not.toBeDisabled();
    // Retrying posts nothing: the read is not paid for again.
    expect(posts()).toHaveLength(1);
  });
});
