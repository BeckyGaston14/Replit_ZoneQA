import { act } from "react";
import { createRoot } from "react-dom/client";
import { TableSortControls } from "./TableSortControls";

jest.mock("./ui/button", () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("compact controls expose direction and restore the documented default", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const setSort = jest.fn();
  act(() => root.render(<TableSortControls
    columns={[{ key: "name", label: "Name" }, { key: "date", label: "Date" }]}
    sort={{ key: "date", direction: "desc" }}
    setSort={setSort}
    defaultSort={{ key: "name", direction: "asc" }}
  />));
  expect(container.querySelector('select[aria-label="Sort by column"]').value).toBe("date");
  expect(container.querySelector('button[aria-label="Sort ascending"]')).not.toBeNull();
  const reset = container.querySelector('button[aria-label="Restore default sort"]');
  expect(reset.disabled).toBe(false);
  act(() => reset.click());
  expect(setSort).toHaveBeenCalledWith({ key: "name", direction: "asc" });
  act(() => root.unmount());
});