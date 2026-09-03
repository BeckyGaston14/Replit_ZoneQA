import { act } from "react";
import { createRoot } from "react-dom/client";
import { FormModal, Field, SelectOrAdd } from "./forms";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
jest.mock("./ui/dialog", () => ({
  Dialog: ({ children, open }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children, className }) => <div data-testid="dialog-content" className={className}>{children}</div>,
  DialogHeader: ({ children }) => <div>{children}</div>,
  DialogTitle: ({ children }) => <h1>{children}</h1>,
  DialogDescription: ({ children }) => <p>{children}</p>,
  DialogFooter: ({ children }) => <div>{children}</div>,
}));
jest.mock("./ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("./ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("./ui/label", () => ({ Label: ({ children, ...props }) => <label {...props}>{children}</label> }));
jest.mock("./ui/textarea", () => ({ Textarea: (props) => <textarea {...props} /> }));
jest.mock("./ui/select", () => ({ Select: ({ children }) => <div>{children}</div>, SelectContent: ({ children }) => <div>{children}</div>, SelectItem: ({ children }) => <div>{children}</div>, SelectTrigger: ({ children }) => <button>{children}</button>, SelectValue: () => null }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ setQueryData: jest.fn(), invalidateQueries: jest.fn() }) }));
jest.mock("../lib/hooks", () => ({ useCollection: () => ({ data: [] }) }));
jest.mock("../lib/api", () => ({
  api: { post: jest.fn() },
  formatApiErrorDetail: (detail) => typeof detail === "string" ? detail : detail?.message || "",
}));

test("FormModal submits on Enter and Field associates its label with the input", () => {
  const submit = jest.fn();
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<FormModal open onOpenChange={jest.fn()} title="Edit" onSubmit={submit}><Field label="Name"><input /></Field></FormModal>));
  const input = container.querySelector("input");
  expect(container.querySelector("label").htmlFor).toBe(input.id);
  expect(container.querySelector('[data-testid="modal-submit-btn"]').textContent).toBe("Save");
  act(() => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(submit).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

test("required fields expose visible and programmatic required state", () => {
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<Field label="Project name" required error="Project name is required."><input /></Field>));
  const input = container.querySelector("input");
  expect(container.querySelector("label").textContent).toContain("*");
  expect(container.querySelector("label").textContent).toContain("(required)");
  expect(input.required).toBe(true);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toContain("-error");
  act(() => root.unmount());
});

test("FormModal prevents duplicate same-tick submission and supports keyboard-native submit", async () => {
  const submit = jest.fn();
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<FormModal open onOpenChange={jest.fn()} title="Edit" onSubmit={submit}><input /></FormModal>));
  const form = container.querySelector("form");
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(submit).toHaveBeenCalledTimes(1);
  await act(async () => {});
  act(() => root.unmount());
});

test("Cancel closes clean forms immediately and confirms only when entries are dirty", () => {
  const cleanClose = jest.fn();
  const dirtyClose = jest.fn();
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<FormModal open onOpenChange={cleanClose} title="New" onSubmit={jest.fn()}><input value="" readOnly /></FormModal>));
  act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Cancel").click());
  expect(cleanClose).toHaveBeenCalledWith(false);

  act(() => root.render(<FormModal open dirty onOpenChange={dirtyClose} title="New" onSubmit={jest.fn()}><input value="Draft" readOnly /></FormModal>));
  act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Cancel").click());
  expect(dirtyClose).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alertdialog"]').textContent).toContain("unsaved changes");
  act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Discard changes").click());
  expect(dirtyClose).toHaveBeenCalledWith(false);
  act(() => root.unmount());
});

test("error summary links to field focus without clearing draft values", () => {
  const focus = jest.fn();
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<FormModal open onOpenChange={jest.fn()} title="Edit" onSubmit={jest.fn()} errors={{ name: "Name is required." }} onFocusFirstError={focus}><input value="Other draft" readOnly /></FormModal>));
  expect(container.querySelector('[aria-label="Form errors"]').textContent).toContain("Name is required.");
  act(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Name is required.").click());
  expect(focus).toHaveBeenCalledWith("name");
  expect(container.querySelector("input").value).toBe("Other draft");
  act(() => root.unmount());
});

test("inline relation creation failure preserves entered values and parent selection", async () => {
  const { api } = require("../lib/api");
  api.post.mockRejectedValueOnce({ response: { data: { detail: "Municipality already exists." } } });
  const onChange = jest.fn();
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<SelectOrAdd collection="municipalities" value="" onChange={onChange} labelFn={(item) => item.name} addFields={[{ key: "name", label: "Municipality" }, { key: "state", label: "State" }]} />));
  act(() => container.querySelector('[aria-label="Add new municipality"]').click());
  const inputs = container.querySelectorAll("input");
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(inputs[0], "Springfield"); inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    setter.call(inputs[1], "IL"); inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Add").click());
  expect(container.textContent).toContain("Municipality already exists.");
  expect(inputs[0].value).toBe("Springfield");
  expect(inputs[1].value).toBe("IL");
  expect(onChange).not.toHaveBeenCalled();
  act(() => root.unmount());
});

test("inline Property creation requires known Municipality context before posting", async () => {
  const { api } = require("../lib/api");
  api.post.mockClear();
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<SelectOrAdd
    collection="properties"
    value=""
    onChange={jest.fn()}
    labelFn={(item) => item.name}
    addFields={[{ key: "name", label: "Property Name" }]}
    addDefaults={{ municipality_id: "" }}
    requiredContext={[{ key: "municipality_id", message: "Select a Municipality before adding a Property." }]}
  />));
  act(() => container.querySelector('[aria-label="Add new property"]').click());
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Add").click());
  expect(container.textContent).toContain("Select a Municipality before adding a Property.");
  expect(api.post).not.toHaveBeenCalled();
  act(() => root.unmount());
});

test("wide forms retain a one-column mobile-width modal shell", () => {
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<FormModal open wide onOpenChange={jest.fn()} title="Edit" onSubmit={jest.fn()}><div className="grid grid-cols-1 sm:grid-cols-2">Fields</div></FormModal>));
  expect(container.querySelector('[data-testid="dialog-content"]').className).toContain("w-[calc(100%_-_1rem)]");
  expect(container.querySelector(".grid").className).toContain("grid-cols-1");
  act(() => root.unmount());
});