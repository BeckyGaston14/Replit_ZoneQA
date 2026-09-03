const { TextEncoder, TextDecoder } = require("util");
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
const fs = require("fs");
const path = require("path");
const jsPDF = require("jspdf").default;
const { A4_PAGE, renderExecutivePdf } = require("./executivePdf");

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAE0lEQVR4nGP48esPHsQwKo0NAQBsLSUIb0XLBgAAAABJRU5ErkJggg==";

function chart(width, height) {
  return { dataUrl: ONE_PIXEL_PNG, width, height };
}

function reportData(categoryCount = 6, longLabels = false) {
  return {
    scope: "Scope: latest evaluation per test case per model · Bassett version: v1.9 · retests excluded",
    kpis: {
      bassett_avg: 8.1,
      benchmark_avg: 7.2,
      pass_rate: 84.6,
      total_evaluated: 13,
      wins: 7,
      losses: 3,
      open_critical: 2,
    },
    failure_modes: [
      { mode: longLabels ? "Citation mismatch caused by an unusually long supporting source name that must wrap cleanly onto another line" : "Citation mismatch", count: 5 },
      { mode: "Missed context", count: 3 },
      { mode: "Calculation error", count: 2 },
    ],
    categories: Array.from({ length: categoryCount }, (_, index) => ({
      category: longLabels ? `Category ${index + 1} with a deliberately long descriptive label that wraps within its table cell` : `Category ${index + 1}`,
      avg_score: 6.5 + index / 10,
    })),
  };
}

function assertNoIntersectingTopLevelBoxes(boxes) {
  const topLevel = boxes.filter((box) => !box.name.includes(" chart") && !box.name.includes(" table"));
  topLevel.forEach((left, index) => {
    topLevel.slice(index + 1).forEach((right) => {
      if (left.page !== right.page) return;
      const horizontal = left.x < right.x + right.width && right.x < left.x + left.width;
      const vertical = left.y < right.y + right.height && right.y < left.y + left.height;
      expect(horizontal && vertical).toBe(false);
    });
  });
}

function assertNoIntersectingLayoutBoxes(boxes) {
  boxes.forEach((left, index) => {
    boxes.slice(index + 1).forEach((right) => {
      if (left.page !== right.page) return;
      const horizontal = left.x < right.x + right.width && right.x < left.x + left.width;
      const vertical = left.y < right.y + right.height && right.y < left.y + left.height;
      expect(horizontal && vertical).toBe(false);
    });
  });
}

test("renders a multi-section report into bounded, non-overlapping A4 pages", () => {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const result = renderExecutivePdf({
    doc,
    data: reportData(),
    chartImages: {
      trend: chart(900, 300),
      failureModes: chart(900, 280),
      categories: chart(1000, 520),
    },
    generated: "9/2/2026",
  });

  expect(result.pageCount).toBeGreaterThanOrEqual(2);
  expect(result.boxes.some((box) => box.name === "Executive Takeaways")).toBe(true);
  expect(result.boxes.some((box) => box.name === "Top Failure Modes")).toBe(true);
  expect(result.boxes.some((box) => box.name === "Bassett Category Performance")).toBe(true);
  result.boxes.forEach((box) => {
    expect(Number.isFinite(box.x)).toBe(true);
    expect(Number.isFinite(box.y)).toBe(true);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x).toBeGreaterThanOrEqual(A4_PAGE.marginX);
    expect(box.y).toBeGreaterThanOrEqual(A4_PAGE.top);
    expect(box.x + box.width).toBeLessThanOrEqual(A4_PAGE.width - A4_PAGE.marginX);
    expect(box.y + box.height).toBeLessThanOrEqual(A4_PAGE.bottom);
  });
  assertNoIntersectingTopLevelBoxes(result.boxes);
  assertNoIntersectingLayoutBoxes(result.boxes);
  for (let page = 1; page <= result.pageCount; page += 1) {
    const commands = doc.internal.pages[page].join(" ");
    expect(commands).toContain("Generated");
    expect(commands).toContain(`Page ${page} of ${result.pageCount}`);
    expect(result.boxes.some((box) => box.page === page)).toBe(true);
  }
  result.boxes.filter((box) => box.name.endsWith(" chart")).forEach((box) => {
    expect(box.height).toBeLessThanOrEqual(78);
    expect(box.width).toBeLessThanOrEqual(A4_PAGE.contentWidth);
  });
  ["Quarterly Accuracy Trend", "Top Failure Modes", "Bassett Category Performance"].forEach((name) => {
    const section = result.boxes.find((box) => box.name === name);
    const chartBox = result.boxes.find((box) => box.name === `${name} chart`);
    expect(chartBox.page).toBe(section.page);
    expect(chartBox.y).toBeGreaterThanOrEqual(section.y + section.height);
  });
  expect(doc.internal.pages[1].join(" ")).toContain("Bassett Wins");
  if (process.env.WRITE_PDF_ARTIFACT === "1") {
    const outputDir = path.resolve(process.cwd(), "../.agents/outputs");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "executive-summary-regression.pdf"), Buffer.from(doc.output("arraybuffer")));
  }
});

test("repeats a table header when category rows continue onto another page", () => {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const result = renderExecutivePdf({
    doc,
    data: reportData(40),
    chartImages: {
      trend: chart(900, 300),
      failureModes: chart(900, 280),
      categories: chart(1000, 520),
    },
    generated: "9/2/2026",
  });

  expect(result.pageCount).toBeGreaterThanOrEqual(3);
  const categoryHeaderPages = [];
  for (let page = 1; page <= result.pageCount; page += 1) {
    if (doc.internal.pages[page].join(" ").includes("Average score out of 10")) categoryHeaderPages.push(page);
  }
  expect(categoryHeaderPages.length).toBeGreaterThanOrEqual(2);
});

test("uses wrapped row heights and keeps every continuation segment page-local", () => {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const result = renderExecutivePdf({
    doc,
    data: reportData(45, true),
    chartImages: {
      trend: chart(400, 1600),
      failureModes: chart(3000, 200),
      categories: chart(500, 1800),
    },
    generated: "9/2/2026",
  });

  const categorySegments = result.boxes.filter((box) => box.name === "Bassett Category Performance table");
  expect(categorySegments.length).toBeGreaterThan(1);
  expect(categorySegments.some((box) => box.height > 8 + 7 * 10)).toBe(true);
  categorySegments.forEach((box) => {
    expect(box.y).toBeGreaterThanOrEqual(A4_PAGE.top);
    expect(box.y + box.height).toBeLessThanOrEqual(A4_PAGE.bottom);
  });
  result.boxes.filter((box) => box.name.endsWith(" table")).forEach((box) => {
    expect(box.x).toBeGreaterThanOrEqual(A4_PAGE.marginX);
    expect(box.x + box.width).toBeLessThanOrEqual(A4_PAGE.width - A4_PAGE.marginX);
    expect(box.y).toBeGreaterThanOrEqual(A4_PAGE.top);
    expect(box.y + box.height).toBeLessThanOrEqual(A4_PAGE.bottom);
  });
  for (let page = 1; page <= result.pageCount; page += 1) {
    const commands = doc.internal.pages[page].join(" ");
    expect(commands).toContain("ZONEQA");
    expect(commands).toContain(`Page ${page} of ${result.pageCount}`);
    expect(result.boxes.some((box) => box.page === page)).toBe(true);
  }
});