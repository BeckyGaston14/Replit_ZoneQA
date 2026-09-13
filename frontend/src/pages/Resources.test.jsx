import { act } from "react";
import { createRoot } from "react-dom/client";
import { Projects } from "./Resources";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

var mockUseCollection = jest.fn();

jest.mock("react-router-dom", () => ({
  useNavigate: () => jest.fn(),
}), { virtual: true });

jest.mock("../lib/hooks", () => ({
  useCollection: (...args) => mockUseCollection(...args),
}));

jest.mock("../components/ResourceList", () => ({
  __esModule: true,
  default: (props) => <div>
    <button type="button" data-testid="open-project-create" onClick={props.onNewOpen}>New Testing Project</button>
    {props.renderCreateExtras?.()}
  </div>,
}));

jest.mock("../lib/auth", () => ({ useAuth: () => ({ user: { role: "admin" } }) }));

beforeEach(() => {
  mockUseCollection.mockReset();
  mockUseCollection.mockReturnValue({
    data: [], isLoading: false, isError: false, refetch: jest.fn(),
  });
});

test("defers the creation-only Bassett test-run lookup until a project create modal opens", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Projects />));

  expect(mockUseCollection).toHaveBeenCalledWith("bassett/issues", { enabled: false });

  act(() => container.querySelector('[data-testid="open-project-create"]').click());

  expect(mockUseCollection).toHaveBeenLastCalledWith("bassett/issues", { enabled: true });
  act(() => root.unmount());
  container.remove();
});