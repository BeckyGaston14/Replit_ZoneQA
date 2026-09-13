import { act } from "react";
import { createRoot } from "react-dom/client";
import { FindingsCrossNavigation } from "./FindingsCrossNavigation";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
}), { virtual: true });

jest.mock("./ui/button", () => ({
  Button: ({ asChild, children, ...props }) => asChild ? children : <button {...props}>{children}</button>,
}));

test("renders both findings destinations as consistently named semantic links", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<FindingsCrossNavigation />));

  const navigation = container.querySelector('[data-testid="findings-cross-navigation"]');
  const links = [...navigation.querySelectorAll("a")];
  expect(navigation.getAttribute("aria-label")).toBe("Findings navigation");
  expect(navigation.className).toContain("flex-wrap");
  expect(links.map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("aria-label")])).toEqual([
    ["Bassett Findings", "/bassett/findings", "Bassett Findings"],
    ["Model Comparison Findings", "/findings", "Model Comparison Findings"],
  ]);

  act(() => root.unmount());
  container.remove();
});