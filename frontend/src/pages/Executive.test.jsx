import { act } from "react";
import { createRoot } from "react-dom/client";
import { useQuery } from "@tanstack/react-query";
import Executive from "./Executive";
import jsPDF from "jspdf";
import { captureExecutiveChart, renderExecutivePdf } from "../lib/executivePdf";
import { toast } from "sonner";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("@tanstack/react-query", () => ({ useQuery: jest.fn() }));
jest.mock("jspdf", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("html2canvas", () => jest.fn());
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock("../lib/executivePdf", () => ({
  captureExecutiveChart: jest.fn(),
  renderExecutivePdf: jest.fn(),
}));
jest.mock("recharts", () => new Proxy({}, {
  get: () => ({ children }) => <>{children}</>,
}));
jest.mock("../components/shared", () => ({
  PageHeader: ({ title, children }) => <header><h1>{title}</h1>{children}</header>,
  StatCard: ({ label, value }) => <div>{label}: {value}</div>,
  WrapTick: () => null,
  SrTable: () => null,
}));
jest.mock("../components/ui/button", () => ({
  Button: ({ children, ...props }) => <button {...props}>{children}</button>,
}));

const data = {
  scope: "Current release",
  kpis: {
    bassett_avg: 8.1,
    benchmark_avg: 7.2,
    pass_rate: 90,
    total_evaluated: 10,
    wins: 7,
    losses: 2,
    open_critical: 0,
  },
  trend: [],
  failure_modes: [],
  categories: [{ category: "Accuracy", avg_score: 8.1 }],
  stale_gold_tests: [],
};

function renderPage() {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Executive />));
  return { container, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => {
  jest.clearAllMocks();
  useQuery.mockReturnValue({ isLoading: false, isError: false, data });
});

test("labels wins for Bassett and exposes generating and saving states", async () => {
  let finishCapture;
  let finishFrame;
  const capturePromise = new Promise((resolve) => { finishCapture = resolve; });
  captureExecutiveChart.mockReturnValue(capturePromise);
  const pdf = {
    output: jest.fn(() => new ArrayBuffer(10)),
    save: jest.fn(),
  };
  jsPDF.mockImplementation(() => pdf);
  const oldRequestAnimationFrame = global.requestAnimationFrame;
  global.requestAnimationFrame = (callback) => { finishFrame = callback; };
  const view = renderPage();
  const button = view.container.querySelector('[data-testid="download-pdf-btn"]');

  expect(view.container.textContent).toContain("Bassett Wins");
  act(() => button.click());
  expect(button.textContent).toContain("Generating PDF");
  expect(button.disabled).toBe(true);

  await act(async () => {
    finishCapture({ dataUrl: "data:image/png;base64,x", width: 10, height: 10 });
    await Promise.resolve();
  });
  expect(button.textContent).toContain("Saving PDF");
  await act(async () => {
    finishFrame();
    await Promise.resolve();
  });

  expect(renderExecutivePdf).toHaveBeenCalledTimes(1);
  expect(pdf.output).toHaveBeenCalledWith("arraybuffer");
  expect(pdf.save).toHaveBeenCalledTimes(1);
  expect(toast.success).toHaveBeenCalled();
  expect(button.disabled).toBe(false);
  global.requestAnimationFrame = oldRequestAnimationFrame;
  view.unmount();
});

test("shows an inline and toast error when PDF generation fails", async () => {
  captureExecutiveChart.mockRejectedValue(new Error("Chart capture was blocked"));
  jsPDF.mockImplementation(() => ({ output: jest.fn(), save: jest.fn() }));
  const view = renderPage();

  await act(async () => {
    view.container.querySelector('[data-testid="download-pdf-btn"]').click();
    await Promise.resolve();
  });

  const alert = view.container.querySelector('[data-testid="pdf-export-error"]');
  expect(alert).not.toBeNull();
  expect(alert.textContent).toContain("Chart capture was blocked");
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Chart capture was blocked"));
  expect(view.container.querySelector('[data-testid="download-pdf-btn"]').disabled).toBe(false);
  view.unmount();
});

test.each([
  ["the PDF has no bytes", () => ({ output: jest.fn(() => new ArrayBuffer(0)), save: jest.fn() }), "generated PDF was empty"],
  ["saving the PDF throws", () => ({ output: jest.fn(() => new ArrayBuffer(10)), save: jest.fn(() => { throw new Error("Download blocked"); }) }), "Download blocked"],
])("reports an export error when %s", async (_label, createPdf, expectedMessage) => {
  captureExecutiveChart.mockResolvedValue({ dataUrl: "data:image/png;base64,x", width: 10, height: 10 });
  const pdf = createPdf();
  jsPDF.mockImplementation(() => pdf);
  const oldRequestAnimationFrame = global.requestAnimationFrame;
  global.requestAnimationFrame = (callback) => callback();
  const view = renderPage();

  await act(async () => {
    view.container.querySelector('[data-testid="download-pdf-btn"]').click();
    await Promise.resolve();
    await Promise.resolve();
  });

  const alert = view.container.querySelector('[data-testid="pdf-export-error"]');
  expect(alert).not.toBeNull();
  expect(alert.textContent).toContain(expectedMessage);
  expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(expectedMessage));
  expect(toast.success).not.toHaveBeenCalled();
  expect(view.container.querySelector('[data-testid="download-pdf-btn"]').disabled).toBe(false);
  global.requestAnimationFrame = oldRequestAnimationFrame;
  view.unmount();
});