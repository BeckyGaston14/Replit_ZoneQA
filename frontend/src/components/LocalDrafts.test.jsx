import { act } from "react";
import { createRoot } from "react-dom/client";
import { LocalDrafts } from "./LocalDrafts";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
jest.mock("./forms", () => ({ FormModal: ({ children }) => <div>{children}</div> }));
jest.mock("./ui/button", () => ({ Button: ({ children, variant, ...props }) => <button {...props}>{children}</button> }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
afterEach(() => localStorage.clear());

function view() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onRecover = jest.fn();
  act(() => root.render(<LocalDrafts mode="bassett" onRecover={onRecover} />));
  const click = (text) => act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === text).click());
  return { container, root, onRecover, click };
}
test("Drafts lists the saved content and recovers it without retaining an overlay", () => {
  localStorage.setItem("zoneqa:bassett-workflow-draft", JSON.stringify({ title: "My draft", question_asked: "My prompt" }));
  const v = view(); v.click("Drafts");
  expect(v.container.textContent).toContain("My prompt");
  v.click("Recover Draft");
  expect(v.onRecover).toHaveBeenCalledWith(expect.objectContaining({ title: "My draft", _draftRecovered: true, attachments: [] }));
  expect(v.container.textContent).not.toContain("My prompt");
  act(() => v.root.unmount());
});
test("Drafts deletes only the selected testing section's draft", () => {
  localStorage.setItem("zoneqa:bassett-workflow-draft", JSON.stringify({ title: "Delete me" }));
  localStorage.setItem("zoneqa:comparison-workflow-draft", JSON.stringify({ name: "Keep me" }));
  const v = view(); v.click("Drafts"); v.click("Delete Draft");
  expect(localStorage.getItem("zoneqa:bassett-workflow-draft")).toBeNull();
  expect(localStorage.getItem("zoneqa:comparison-workflow-draft")).not.toBeNull();
  expect(v.container.textContent).toContain("No saved drafts");
  act(() => v.root.unmount());
});
