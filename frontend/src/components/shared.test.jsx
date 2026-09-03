import { act } from "react";
import { createRoot } from "react-dom/client";
import { ResultBadge, ScorePill } from "./shared";

jest.mock("react-router-dom", () => ({
  Link: ({ children, ...props }) => <a {...props}>{children}</a>,
}), { virtual: true });

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test.each([
  "Pass",
  "Pass with Minor Issues",
  "Needs Improvement",
  "Fail",
  "Critical Fail",
])("score and result use the same semantic color for %s", (status) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => root.render(<><ResultBadge value={status} /><ScorePill score={7.2} status={status} /></>));

  const [result, score] = container.querySelectorAll("span");
  expect(score.style.background).toBe(result.style.background);

  act(() => root.unmount());
  container.remove();
});