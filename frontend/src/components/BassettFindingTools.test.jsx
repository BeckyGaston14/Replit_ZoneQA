import { act } from "react";
import { createRoot } from "react-dom/client";
import { BassettFindingTools, findingCsv } from "./BassettFindingTools";
import { parseCsv } from "../lib/csv";
import { DRAFT_KEYS } from "../lib/localDrafts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
jest.mock("react-router-dom", () => ({ Link: ({ children, to }) => <a href={to}>{children}</a> }), { virtual: true });
jest.mock("./ui/input", () => ({ Input: (props) => <input {...props} /> }));
jest.mock("./ui/textarea", () => ({ Textarea: (props) => <textarea {...props} /> }));
jest.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [] }) }));
jest.mock("../lib/api", () => ({ api: { post: jest.fn() }, formatApiErrorDetail: String }));
jest.mock("./ui/button", () => ({ Button: ({ children, asChild, ...props }) => asChild ? children : <button {...props}>{children}</button> }));
jest.mock("./LocalDrafts", () => ({ LocalDrafts: ({ mode }) => <button data-mode={mode}>Drafts</button> }));
jest.mock("./forms", () => ({ FormModal: ({ children, title }) => <section><h2>{title}</h2>{children}</section>, Field: ({ children }) => children }));
jest.mock("./ConfirmActionDialog", () => ({ ConfirmActionDialog: () => null }));

test("finding toolbar follows test-run action order without comparison navigation", () => {
  const container = document.createElement("div"); const root = createRoot(container);
  act(() => root.render(<BassettFindingTools records={[]} canWrite canManage onChanged={() => {}} />));
  expect([...container.querySelectorAll('button,a')].map((el) => el.textContent.trim())).toEqual(["Import CSV", "Export CSV", "Drafts", "Bassett Test Runs", "Archived Findings", "New Bassett Finding"]);
  expect(container.querySelector('[data-mode="finding"]')).not.toBeNull();
  act(() => root.unmount());
});
test("finding CSV preserves multiline text and multiple linked IDs", () => {
  const rows = parseCsv(findingCsv([{ title: 'Use "table"', description: 'line 1\nline 2', linked_test_run_ids: ['a', 'b'] }]));
  expect(rows[0].title).toBe('Use "table"');
  expect(rows[0].description).toBe('line 1\nline 2');
  expect(rows[0].linked_test_run_ids).toBe('a;b');
});
test("finding CSV protects spreadsheet formula cells and drafts have a separate key", () => {
  expect(parseCsv(findingCsv([{ title: '=1+1' }]))[0].title).toBe("'=1+1");
  expect(DRAFT_KEYS.finding).not.toBe(DRAFT_KEYS.bassett);
});
