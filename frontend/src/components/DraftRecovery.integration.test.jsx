import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import UnifiedTestEntryForm, { createBassettTestRunDraft } from "./UnifiedTestEntryForm";
import { LocalDrafts } from "./LocalDrafts";
jest.mock("@/lib/utils", () => require("../lib/utils"), { virtual: true });
jest.mock("../lib/api", () => ({ api: { post: jest.fn() } }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const scenario = { id: "scenario-1", stable_id: "R-01", workflow_stage: "Research", test_scenario: "Research the property" };

test("real dialogs recover a draft and remain navigable without a blocking overlay", () => {
  localStorage.setItem("zoneqa:bassett-workflow-draft", JSON.stringify({ scenario_id: scenario.id, test_date: "2026-09-17", question_asked: "Recovered prompt" }));
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  function Harness() {
    const [form, setForm] = useState(null);
    return <><LocalDrafts mode="bassett" onRecover={(saved) => setForm(createBassettTestRunDraft(saved))} /><button onClick={() => setForm(createBassettTestRunDraft())}>New Test</button>{form && <UnifiedTestEntryForm form={form} setForm={setForm} scenarios={[scenario]} onCancel={() => setForm(null)} onSubmit={() => {}} />}</>;
  }
  act(() => root.render(<Harness />));
  const click = (text) => act(() => [...document.body.querySelectorAll("button")].find((button) => button.textContent === text).click());
  click("New Test"); click("Recover draft");
  expect(document.body.textContent).not.toContain("A saved Bassett draft is available");
  click("Next");
  expect(document.body.textContent).toContain("Section 2 of 6");
  expect([...document.body.querySelectorAll("textarea")].some((field) => field.value === "Recovered prompt")).toBe(true);
  click("Cancel");
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe("none");
  click("Drafts"); click("Recover Draft"); click("Next");
  expect(document.body.textContent).toContain("Section 2 of 6");
  expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  act(() => root.unmount()); container.remove(); localStorage.clear();
});
