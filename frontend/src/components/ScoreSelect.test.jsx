import { act } from "react";
import { createRoot } from "react-dom/client";
import { ScoreSelect } from "./ScoreSelect";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("shows every rubric reason in the score dropdown and returns a number", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const onChange = jest.fn();
  act(() => root.render(<ScoreSelect value="" onChange={onChange} ariaLabel="Accuracy score" />));

  const select = host.querySelector('select[aria-label="Accuracy score"]');
  expect(select.options).toHaveLength(13);
  expect(select.options[0].textContent).toContain("Not scored");
  expect(select.options[1].textContent).toContain("N/A — Not Applicable");
  expect(select.options[2].textContent).toContain("10 — Fully correct");
  expect(select.options[12].textContent).toContain("0 — No usable answer");
  expect(host.querySelector('[aria-live="polite"]')).toBeNull();
  expect(host.textContent).not.toContain("missing evidence");

  act(() => {
    select.value = "7";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith(7);
  act(() => {
    select.value = "N/A";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenLastCalledWith(null);
  act(() => root.unmount());
});

test("keeps the dropdown labels and shared rubric text available without repeated selected-score helper text", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(
    <div>
      <ScoreSelect value={10} onChange={jest.fn()} ariaLabel="Accuracy score" />
      <details open>
        <summary>View the shared 0–10 scoring rubric</summary>
        <p>10 — Fully correct, complete, supported, and professionally usable; no meaningful change needed.</p>
      </details>
    </div>,
  ));

  expect(host.querySelector('select[aria-label="Accuracy score"]').value).toBe("10");
  expect(host.textContent).toContain("10 — Fully correct");
  expect(host.textContent).toContain("View the shared 0–10 scoring rubric");
  expect(host.querySelector('select[aria-label="Accuracy score"]').parentElement.querySelector("p")).toBeNull();
  expect(host.querySelector('[aria-live="polite"]')).toBeNull();

  act(() => root.unmount());
  host.remove();
});

