import { act } from "react";
import { createRoot } from "react-dom/client";
import { AddEventModal, validateCalendarEvent } from "./CalendarPage";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockPost = jest.fn();
jest.mock("react-router-dom", () => ({ useSearchParams: () => [new URLSearchParams(), jest.fn()] }));
jest.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: jest.fn() }), useQuery: () => ({ data: [], isLoading: false, isError: false }) }));
jest.mock("../lib/api", () => ({
  api: { post: (...args) => mockPost(...args) },
  formatApiErrorDetail: () => "",
}));
jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));
jest.mock("../components/shared", () => ({ PageHeader: ({ children }) => <header>{children}</header>, StatusBadge: ({ value }) => <span>{value}</span> }));
jest.mock("../components/PageState", () => ({ QueryState: () => null }));
jest.mock("../components/ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("../lib/statusMaps", () => ({ CALENDAR_EVENT_STATES: [], CALENDAR_EVENT_STATUSES: [] }));
jest.mock("lucide-react", () => ({
  ChevronLeft: () => null, ChevronRight: () => null, Plus: () => null, X: () => null,
}));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock("../components/forms", () => ({
  FormModal: ({ children, onOpenChange, onSubmit, title, submitLabel }) => (
    <div data-modal-title={title}>
      {children}
      <button type="button" data-testid="cancel" onClick={() => onOpenChange(false)}>Cancel</button>
      <button type="button" data-testid="submit" onClick={onSubmit}>{submitLabel}</button>
    </div>
  ),
  Field: ({ label, children, error }) => <label>{label}{children}{error && <span role="alert">{error}</span>}</label>,
  ListSelect: ({ testid }) => <select data-testid={testid} />,
}));
jest.mock("../components/ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("../components/ui/textarea", () => ({ Textarea: (props) => <textarea {...props} /> }));

function renderModal(data) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const setData = jest.fn();
  const onDone = jest.fn();
  const onError = jest.fn();
  act(() => root.render(<AddEventModal data={data} setData={setData} onDone={onDone} onError={onError} />));
  return { container, root, setData, onDone, onError };
}

afterEach(() => {
  mockPost.mockReset();
  document.body.innerHTML = "";
});

test("calendar validation requires a nonblank title and date but permits optional fields", () => {
  expect(validateCalendarEvent({ title: " ", date: "" })).toEqual({
    title: "Event Title is required.",
    date: "Date is required.",
  });
  expect(validateCalendarEvent({ title: "Release", date: "" })).toEqual({
    date: "Date is required.",
  });
  expect(validateCalendarEvent({ title: "", date: "2026-09-10" })).toEqual({
    title: "Event Title is required.",
  });
  expect(validateCalendarEvent({ title: "Release", date: "2026-09-10", event_type: "", notes: "" })).toEqual({});
});

test("calendar modal reports blank required fields without posting", async () => {
  const view = renderModal({ title: " ", date: "", event_type: "", notes: "" });
  await act(async () => view.container.querySelector('[data-testid="submit"]').click());
  expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(2);
  expect(mockPost).not.toHaveBeenCalled();
  expect(view.container.querySelector("[data-modal-title]").getAttribute("data-modal-title")).toBe("Schedule Event");
  act(() => view.root.unmount());
});

test("calendar modal posts valid data and cancel safely closes without posting", async () => {
  mockPost.mockResolvedValueOnce({ data: { id: "event-1" } });
  const view = renderModal({ title: "Release", date: "2026-09-10", event_type: "release", notes: "Ship it" });
  expect(view.container.querySelector('[data-testid="submit"]').textContent).toBe("Schedule Event");
  await act(async () => view.container.querySelector('[data-testid="submit"]').click());
  expect(mockPost).toHaveBeenCalledWith("/calendar_events", {
    title: "Release", date: "2026-09-10", event_type: "release", notes: "Ship it",
  });
  expect(view.setData).toHaveBeenCalledWith(null);
  expect(view.onDone).toHaveBeenCalledTimes(1);
  act(() => view.container.querySelector('[data-testid="cancel"]').click());
  expect(view.setData).toHaveBeenLastCalledWith(null);
  act(() => view.root.unmount());
});