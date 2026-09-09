import { coverageStatusForCount } from "./Coverage";

jest.mock("react-router-dom", () => ({
  Link: ({ children }) => children,
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
}), { virtual: true });

test.each([
  [0, 0, "not_represented"],
  [4, 0, "defined_not_evaluated"],
  [4, 1, "partially_evaluated"],
  [4, 3, "partially_evaluated"],
  [4, 4, "fully_evaluated"],
])("coverage status distinguishes %s definitions with %s evaluated", (tests, evaluated, expected) => {
  expect(coverageStatusForCount(tests, evaluated)).toBe(expected);
});
