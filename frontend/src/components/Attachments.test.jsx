import { act } from "react";
import { createRoot } from "react-dom/client";
import { Attachments } from "./Attachments";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let mockQueryState;
jest.mock("@tanstack/react-query", () => ({ useQuery: () => mockQueryState, useQueryClient: () => ({ invalidateQueries: jest.fn() }) }));
jest.mock("../lib/api", () => ({ api: { post: jest.fn(() => Promise.resolve({})), delete: jest.fn(), get: jest.fn() }, formatApiErrorDetail: () => "attachments unavailable" }));
jest.mock("./ui/button", () => ({ Button: ({ children, ...props }) => <button {...props}>{children}</button> }));
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

function render() {
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<Attachments entityType="testcase" entityId="tc-1" canWrite />));
  return { container, root };
}
test("attachment error is announced and deleted attachment exposes restore during retention", async () => {
  mockQueryState = { data: [], isError: true, error: { response: { data: { detail: "x" } } } };
  let view = render();
  expect(view.container.querySelector("[role=alert]").textContent).toContain("Unable to load attachments");
  act(() => view.root.unmount());
  mockQueryState = { data: [{ id: "a1", original_filename: "proof.pdf", is_deleted: true, status: "deleted", restore_expires_at: "2030-01-01T00:00:00+00:00", size: 1 }], isError: false };
  view = render();
  const restore = view.container.querySelector('[aria-label="Restore proof.pdf"]');
  expect(restore).not.toBeNull();
  await act(async () => { restore.click(); await Promise.resolve(); });
  expect(require("../lib/api").api.post).toHaveBeenCalledWith("/attachments/a1/restore");
  act(() => view.root.unmount());
});

test.each([320, 375])("long attachment names wrap and icon actions stay named and touchable at %ipx", (width) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const filename = `${"ordinance-evidence-".repeat(12)}.pdf`;
  mockQueryState = { data: [{ id: "a2", original_filename: filename, size: 1200 }], isError: false };
  const view = render();
  const item = view.container.querySelector("[data-testid='attachment-item']");
  const name = item.querySelector("[title]");
  const download = item.querySelector(`[aria-label="Download ${filename}"]`);
  const remove = item.querySelector(`[aria-label="Remove ${filename}"]`);
  expect(item.className).toContain("min-w-0");
  expect(name.className).toContain("break-words");
  expect(name.className).not.toContain("truncate");
  expect(download.className).toContain("icon-action");
  expect(remove.className).toContain("icon-action");
  act(() => view.root.unmount());
});