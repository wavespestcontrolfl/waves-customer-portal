// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CustomerDirectoryTable from "./CustomerDirectoryTable";

afterEach(cleanup);

function directory() {
  const customer = { id: "fixture-a", firstName: "Avery", lastName: "Sample" };
  const onEdit = vi.fn();
  render(
    <main tabIndex={-1}>
      <button type="button">Outside</button>
      <CustomerDirectoryTable customers={[customer]} canEdit onEdit={onEdit} />
    </main>,
  );
  const trigger = screen.getByLabelText("Actions for Avery Sample");
  const menu = trigger.closest("details");
  menu.open = true;
  return { customer, onEdit, trigger, menu };
}

it("keeps a WebKit pointer action available when its containing main receives focus", () => {
  const { customer, onEdit, trigger, menu } = directory();
  const action = screen.getByRole("button", { name: "Edit customer" });
  fireEvent.pointerDown(action);
  screen.getByRole("main").focus();
  expect(menu.open).toBe(true);
  fireEvent.pointerUp(action);
  fireEvent.click(action);
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenCalledWith(customer);
  expect(menu.open).toBe(false);
  expect(trigger).toHaveFocus();
});

it("still dismisses on an outside pointer or keyboard focus change after a pointer action", () => {
  const { menu } = directory();
  const action = screen.getByRole("button", { name: "Edit customer" });
  fireEvent.pointerDown(action);
  fireEvent.pointerCancel(action);
  screen.getByRole("button", { name: "Outside" }).focus();
  expect(menu.open).toBe(false);
  menu.open = true;
  fireEvent.pointerDown(action);
  fireEvent.keyDown(action, { key: "Tab" });
  screen.getByRole("main").focus();
  expect(menu.open).toBe(false);
  menu.open = true;
  fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
  expect(menu.open).toBe(false);
});

it("dismisses with Escape and returns focus to the row actions trigger", () => {
  const { trigger, menu } = directory();
  const action = screen.getByRole("button", { name: "Edit customer" });
  action.focus();
  fireEvent.keyDown(action, { key: "Escape" });
  expect(menu.open).toBe(false);
  expect(trigger).toHaveFocus();
});
