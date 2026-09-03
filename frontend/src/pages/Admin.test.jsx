import { act } from "react";
import { createRoot } from "react-dom/client";
import Admin from "./Admin";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

var mockApi;
let mockUser = { id: "admin-1", role: "admin", name: "Admin User" };
const users = [
  { id: "admin-1", name: "Admin User", email: "admin@example.com", role: "admin", active: true, revision: 1 },
  { id: "tester-1", name: "Tester User", email: "tester@example.com", role: "tester", active: true, revision: 1 },
  { id: "pending-1", name: "Pending User", email: "pending@example.com", role: "tester", active: true, revision: 1, welcome_email_status: "failed" },
  { id: "activated-1", name: "Activated User", email: "activated@example.com", role: "tester", active: true, revision: 1, password_login_ready: true, welcome_email_status: "activated" },
];

jest.mock("../lib/api", () => ({
  api: {
    get: (...args) => mockApi.get(...args),
    put: (...args) => mockApi.put(...args),
    post: (...args) => mockApi.post(...args),
    delete: (...args) => mockApi.delete(...args),
  },
  withExpectedVersion: (record, changes) => ({ ...changes, expected_revision: record.revision }),
  staleUpdateMessage: () => "",
}));
mockApi = {
  get: jest.fn(),
  put: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
};
jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: mockUser }) }));
jest.mock("../components/shared", () => ({
  PageHeader: ({ title, subtitle }) => <header><h1>{title}</h1><p>{subtitle}</p></header>,
  StatusBadge: ({ value }) => <span>{value}</span>,
}));
jest.mock("../components/ui/tabs", () => ({
  Tabs: ({ children }) => <div>{children}</div>,
  TabsList: ({ children }) => <div>{children}</div>,
  TabsTrigger: ({ children, ...props }) => <button role="tab" {...props}>{children}</button>,
  TabsContent: ({ children }) => <section>{children}</section>,
}));
jest.mock("../components/ui/select", () => ({
  Select: ({ children }) => <div>{children}</div>,
  SelectContent: ({ children }) => <div>{children}</div>,
  SelectItem: ({ children }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }) => <button type="button" {...props}>{children}</button>,
  SelectValue: ({ children }) => <span>{children}</span>,
}));
jest.mock("../components/ui/button", () => ({
  Button: ({ children, asChild, ...props }) => asChild ? children : <button {...props}>{children}</button>,
}));
jest.mock("../components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("../components/ui/label", () => ({ Label: (props) => <label {...props} /> }));
jest.mock("../components/SortableTableHeader", () => ({ SortableTableHeader: ({ column }) => <th>{column.label}</th> }));
jest.mock("../components/TableSortControls", () => ({ TableSortControls: () => null }));
jest.mock("../components/ConfirmActionDialog", () => ({
  ConfirmActionDialog: ({ open, title, description, confirmLabel, onConfirm }) => open ? (
    <div role="dialog">
      <h2>{title}</h2>
      <p>{description}</p>
      <button type="button" onClick={onConfirm}>{confirmLabel}</button>
    </div>
  ) : null,
}));
jest.mock("../lib/tableSorting", () => ({
  nextSort: (sort) => sort,
  sortTableRows: (rows) => rows,
  usePersistentTableSort: (_key, _columns, fallback) => [fallback, jest.fn()],
}));
jest.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }) => ({
    data: queryKey[0] === "users" ? users : queryKey[0] === "config" ? { environments: [], version_types: [], release_channels: [], integrations: {} } : [],
    refetch: jest.fn(),
  }),
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

function renderAdmin() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Admin />));
  return { container, unmount: () => act(() => root.unmount()) };
}

function openUsers(view) {
  const tab = [...view.container.querySelectorAll('[role="tab"]')].find((item) => item.textContent === "Users & Roles");
  act(() => tab.click());
}

function setInput(input, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  mockApi.get.mockReset();
  mockApi.put.mockReset();
  mockApi.post.mockReset();
  mockApi.delete.mockReset();
  mockUser = { id: "admin-1", role: "admin", name: "Admin User" };
  document.body.innerHTML = "";
});

test("Admin edit-user fields are associated with stable IDs and lifecycle controls remain visible", () => {
  const view = renderAdmin();
  openUsers(view);
  act(() => view.container.querySelector('[aria-label="Edit Tester User"]').click());

  for (const id of ["edit-user-name", "edit-user-email", "edit-user-role"]) {
    expect(view.container.querySelector(`#${id}`)).not.toBeNull();
    expect(view.container.querySelector(`label[for="${id}"]`)).not.toBeNull();
  }
  expect(view.container.querySelector("#edit-user-password")).toBeNull();
  expect(view.container.querySelector("#edit-user-password-confirmation")).toBeNull();
  expect(view.container.querySelector("form[aria-labelledby=\"edit-user-heading\"]")).not.toBeNull();
  expect(view.container.querySelector('button[type="submit"]')).not.toBeNull();
  expect(view.container.querySelector('[aria-label="Deactivate Tester User"]')).not.toBeNull();
  view.unmount();
});

test("new-user form defaults to sending a welcome email and allows opting out", () => {
  const view = renderAdmin();
  openUsers(view);
  act(() => view.container.querySelector('[data-testid="add-user-btn"]').click());

  const checkbox = view.container.querySelector("#new-user-welcome-email");
  expect(checkbox.checked).toBe(true);
  expect(view.container.textContent).toContain("Send welcome email with secure setup link");
  expect(view.container.textContent).toContain("single-use link valid for 24 hours");
  expect(checkbox.closest("div.md\\:col-span-4")).not.toBeNull();
  act(() => checkbox.click());
  expect(checkbox.checked).toBe(false);
  view.unmount();
});

test("submits the welcome-email choice and shows an inline sent result", async () => {
  mockApi.post.mockResolvedValueOnce({
    data: {
      activation_path: "/activate/setup-token",
      welcome_email: { requested: true, sent: true, status: "sent" },
    },
  });
  const view = renderAdmin();
  openUsers(view);
  act(() => view.container.querySelector('[data-testid="add-user-btn"]').click());
  setInput(view.container.querySelector("#new-user-name"), "New Tester");
  setInput(view.container.querySelector("#new-user-email"), "new@example.com");

  await act(async () => view.container.querySelector("form[aria-labelledby=\"add-user-heading\"]").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

  expect(mockApi.post).toHaveBeenCalledWith("/users", {
    name: "New Tester",
    email: "new@example.com",
    role: "tester",
    active: true,
    send_welcome_email: true,
  });
  expect(view.container.textContent).toContain("Welcome email sent.");
  expect(view.container.textContent).toContain("One-time setup link");
  view.unmount();
});

test("keeps the created account and setup link visible when delivery fails", async () => {
  mockApi.post.mockResolvedValueOnce({
    data: {
      activation_path: "/activate/setup-token",
      welcome_email: { requested: true, sent: false, status: "failed", message: "Gmail delivery is unavailable" },
    },
  });
  const view = renderAdmin();
  openUsers(view);
  act(() => view.container.querySelector('[data-testid="add-user-btn"]').click());
  setInput(view.container.querySelector("#new-user-name"), "Delivery Failure");
  setInput(view.container.querySelector("#new-user-email"), "failure@example.com");

  await act(async () => view.container.querySelector("form[aria-labelledby=\"add-user-heading\"]").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

  expect(mockApi.post).toHaveBeenCalledWith("/users", expect.objectContaining({ send_welcome_email: true }));
  expect(view.container.textContent).toContain("Account created, but the welcome email was not sent.");
  expect(view.container.textContent).toContain("Gmail delivery is unavailable");
  expect(view.container.textContent).toContain("/activate/setup-token");
  view.unmount();
});

test("resend invite requires confirmation and posts to the welcome-email endpoint", async () => {
  mockApi.post.mockResolvedValueOnce({ data: { welcome_email: { sent: true } } });
  const view = renderAdmin();
  openUsers(view);
  const resend = view.container.querySelector('[aria-label="Resend welcome email to Pending User"]');
  expect(resend).not.toBeNull();

  act(() => resend.click());
  expect(view.container.querySelector('[role="dialog"]').textContent).toContain("expires in 24 hours");
  act(() => [...view.container.querySelectorAll('[role="dialog"] button')][0].click());
  await act(async () => {});

  expect(mockApi.post).toHaveBeenCalledWith("/users/pending-1/welcome-email");
  view.unmount();
});

test("activated users do not show a resend invite action", () => {
  const view = renderAdmin();
  openUsers(view);
  expect(view.container.querySelector('[aria-label="Resend welcome email to Activated User"]')).toBeNull();
  expect(view.container.querySelector('[aria-label="Resend welcome email to Pending User"]')).not.toBeNull();
  view.unmount();
});

test("submits profile changes without accepting administrator password values", async () => {
  const savedUser = { ...users[1], name: "Updated Tester", email: "updated@example.com", revision: 2, updated_at: "after" };
  mockApi.put.mockResolvedValueOnce({
    data: { user: savedUser },
  });
  const view = renderAdmin();
  openUsers(view);
  act(() => view.container.querySelector('[aria-label="Edit Tester User"]').click());
  setInput(view.container.querySelector("#edit-user-name"), "Updated Tester");
  setInput(view.container.querySelector("#edit-user-email"), "updated@example.com");
  await act(async () => view.container.querySelector("form[aria-labelledby=\"edit-user-heading\"]").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

  expect(mockApi.put).toHaveBeenCalledTimes(1);
  expect(mockApi.put.mock.calls[0][0]).toBe("/users/tester-1");
  expect(mockApi.put.mock.calls[0][1]).toMatchObject({
    name: "Updated Tester",
    email: "updated@example.com",
    expected_revision: 1,
  });
  expect(mockApi.put.mock.calls[0][1]).not.toHaveProperty("new_password");
  expect(view.container.textContent).toContain("User updated successfully");
  view.unmount();
});

test("password reset action requires confirmation and posts only the target ID", async () => {
  mockApi.post.mockResolvedValueOnce({
    data: { reset_path: "/reset-password?token=one-time", email: { sent: true } },
  });
  const view = renderAdmin();
  openUsers(view);
  const reset = view.container.querySelector('[aria-label="Send password reset link to Tester User"]');
  expect(reset).not.toBeNull();
  act(() => reset.click());
  expect(view.container.querySelector('[role="dialog"]').textContent).toContain("one hour");
  act(() => [...view.container.querySelectorAll('[role="dialog"] button')][0].click());
  await act(async () => {});
  expect(mockApi.post).toHaveBeenCalledWith("/users/tester-1/password-reset", { confirm: true });
  expect(view.container.textContent).toContain("Password reset email sent.");
  expect(view.container.textContent).toContain("/reset-password?token=one-time");
  view.unmount();
});

test("keeps duplicate-email errors inline in the edit form", async () => {
  mockApi.put.mockRejectedValueOnce({ response: { status: 409, data: { detail: "Another active user already uses this email" } } });
  const view = renderAdmin();
  openUsers(view);
  act(() => view.container.querySelector('[aria-label="Edit Tester User"]').click());
  setInput(view.container.querySelector("#edit-user-email"), "other@example.com");
  await act(async () => view.container.querySelector("form[aria-labelledby=\"edit-user-heading\"]").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

  expect(view.container.querySelector('[role="alert"]').textContent).toContain("Another active user already uses this email");
  expect(mockApi.put).toHaveBeenCalledTimes(1);
  view.unmount();
});

test.each([
  ["viewer", "Viewer"],
  ["qa_manager", "QA Manager"],
])("%s users see no Administration mutations", (role, name) => {
  mockUser = { id: `${role}-1`, role, name };
  const view = renderAdmin();
  expect(view.container.textContent).toContain("Access denied");
  expect(view.container.querySelector('[data-testid="add-user-btn"]')).toBeNull();
  expect(view.container.querySelector('[aria-label^="Deactivate"]')).toBeNull();
  view.unmount();
});

test("the current last active administrator cannot deactivate itself", () => {
  const view = renderAdmin();
  openUsers(view);
  const button = view.container.querySelector('[aria-label="Deactivate Admin User"]');
  expect(button).not.toBeNull();
  expect(button.disabled).toBe(true);
  act(() => button.click());
  expect(mockApi.post).not.toHaveBeenCalled();
  view.unmount();
});