import { MODEL_COLORS, MODEL_ORDER } from "./modelColors";
import { formatEvaluationScore } from "./evaluationScale";
import { fmtPct, fmtScore } from "./format";

export const A4_PAGE = Object.freeze({
  width: 210,
  height: 297,
  marginX: 14,
  top: 22,
  bottom: 283,
  contentWidth: 182,
});

const COLORS = Object.freeze({
  navy: "#16215A",
  ink: "#253047",
  muted: "#64748B",
  line: "#D8DEE8",
  paper: "#F7F5F1",
  white: "#FFFFFF",
  orange: "#C2410C",
  red: "#B91C1C",
});

const CHART_MAX_HEIGHT = 78;
const TABLE_LINE_HEIGHT = 3.5;

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function safeText(value, fallback = "—") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function setColor(doc, method, value) {
  doc[method](value);
}

function wrapped(doc, value, width) {
  return doc.splitTextToSize(safeText(value), width);
}

function drawHeader(doc, generated) {
  setColor(doc, "setTextColor", COLORS.navy);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("ZONEQA", A4_PAGE.marginX, 11);
  setColor(doc, "setTextColor", COLORS.muted);
  doc.setFont("helvetica", "normal");
  doc.text(`EXECUTIVE SUMMARY · ${generated}`, A4_PAGE.width - A4_PAGE.marginX, 11, { align: "right" });
  setColor(doc, "setDrawColor", COLORS.line);
  doc.setLineWidth(0.25);
  doc.line(A4_PAGE.marginX, 15, A4_PAGE.width - A4_PAGE.marginX, 15);
}

function drawFooter(doc, pageNumber, totalPages, generated) {
  setColor(doc, "setDrawColor", COLORS.line);
  doc.setLineWidth(0.25);
  doc.line(A4_PAGE.marginX, 287, A4_PAGE.width - A4_PAGE.marginX, 287);
  setColor(doc, "setTextColor", COLORS.muted);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.text(`Generated ${generated} · QA report`, A4_PAGE.marginX, 292);
  doc.text(`Page ${pageNumber} of ${totalPages}`, A4_PAGE.width - A4_PAGE.marginX, 292, { align: "right" });
}

function drawSectionTitle(doc, title, y, subtitle) {
  setColor(doc, "setTextColor", COLORS.navy);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.text(title, A4_PAGE.marginX, y);
  let next = y + 5.5;
  if (subtitle) {
    setColor(doc, "setTextColor", COLORS.muted);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    const lines = wrapped(doc, subtitle, A4_PAGE.contentWidth);
    doc.text(lines, A4_PAGE.marginX, next);
    next += lines.length * 3.8 + 2;
  }
  return next;
}

function drawKpiCards(doc, kpis, y, boxes) {
  const gap = 3;
  const width = (A4_PAGE.contentWidth - gap * 4) / 5;
  const height = 25;
  const cards = [
    ["Bassett Overall Score", fmtScore(kpis.bassett_avg), `Benchmark avg ${fmtScore(kpis.benchmark_avg)}`, MODEL_COLORS.Bassett],
    ["Pass Rate", fmtPct(kpis.pass_rate), `${safeText(kpis.total_evaluated, "0")} evaluated`, kpis.pass_rate != null && kpis.pass_rate >= 85 ? "#16A34A" : "#D97706"],
    ["Bassett Wins", safeText(kpis.wins, "0"), `${safeText(kpis.losses, "0")} losses`, "#16A34A"],
    ["Open Critical", safeText(kpis.open_critical, "0"), "Findings · criticality 4–5", kpis.open_critical ? COLORS.red : "#16A34A"],
    ["Competitive Edge", number(kpis.bassett_avg) !== null && number(kpis.benchmark_avg) !== null
      ? `${number(kpis.bassett_avg) - number(kpis.benchmark_avg) >= 0 ? "+" : ""}${(number(kpis.bassett_avg) - number(kpis.benchmark_avg)).toFixed(1)}`
      : "—", "Points vs benchmarks", COLORS.navy],
  ];
  cards.forEach(([label, value, sub, accent], index) => {
    const x = A4_PAGE.marginX + index * (width + gap);
    setColor(doc, "setFillColor", COLORS.white);
    setColor(doc, "setDrawColor", COLORS.line);
    doc.roundedRect(x, y, width, height, 2, 2, "FD");
    setColor(doc, "setFillColor", accent);
    doc.roundedRect(x, y, 1.8, height, 0.8, 0.8, "F");
    setColor(doc, "setTextColor", COLORS.muted);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.8);
    doc.text(wrapped(doc, label, width - 5), x + 4.5, y + 5.2);
    setColor(doc, "setTextColor", COLORS.navy);
    doc.setFontSize(11);
    doc.text(value, x + 4.5, y + 12.5);
    setColor(doc, "setTextColor", COLORS.muted);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(6.5);
    doc.text(wrapped(doc, sub, width - 5), x + 4.5, y + 18);
    boxes.push({ page: doc.internal.getCurrentPageInfo().pageNumber, x, y, width, height, name: `KPI ${label}` });
  });
  return y + height;
}

function drawTakeaways(doc, takeaways, y, boxes) {
  const width = A4_PAGE.contentWidth;
  const lines = takeaways.flatMap((takeaway) => wrapped(doc, `›  ${takeaway}`, width - 10));
  const height = 8 + lines.length * 4.1 + 5;
  setColor(doc, "setFillColor", COLORS.navy);
  setColor(doc, "setDrawColor", COLORS.navy);
  doc.roundedRect(A4_PAGE.marginX, y, width, height, 3, 3, "F");
  setColor(doc, "setTextColor", MODEL_COLORS.Bassett);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.text("Executive Takeaways", A4_PAGE.marginX + 6, y + 7);
  setColor(doc, "setTextColor", "#F8FAFC");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.text(lines, A4_PAGE.marginX + 6, y + 13);
  boxes.push({ page: doc.internal.getCurrentPageInfo().pageNumber, x: A4_PAGE.marginX, y, width, height, name: "Executive Takeaways" });
  return y + height;
}

function drawLegend(doc, y) {
  let x = A4_PAGE.marginX;
  MODEL_ORDER.forEach((model) => {
    setColor(doc, "setFillColor", MODEL_COLORS[model]);
    doc.circle(x + 1.5, y - 1.2, 1.5, "F");
    setColor(doc, "setTextColor", COLORS.ink);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(model, x + 4.5, y);
    x += 28;
  });
}

function chartDimensions(image, maxWidth = A4_PAGE.contentWidth, maxHeight = CHART_MAX_HEIGHT) {
  const imageWidth = number(image?.width) || 1;
  const imageHeight = number(image?.height) || 1;
  const ratio = imageWidth / imageHeight;
  let width = maxWidth;
  let height = width / ratio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }
  return { width: Math.max(12, Math.min(width, maxWidth)), height: Math.max(12, Math.min(height, maxHeight)) };
}

function drawChartImage(doc, image, y, boxes, name) {
  const dimensions = chartDimensions(image);
  const width = dimensions.width;
  const height = dimensions.height;
  const x = A4_PAGE.marginX + (A4_PAGE.contentWidth - width) / 2;
  if (image?.dataUrl) {
    doc.addImage(image.dataUrl, "PNG", x, y, width, height, undefined, "FAST");
  } else {
    setColor(doc, "setFillColor", COLORS.paper);
    setColor(doc, "setDrawColor", COLORS.line);
    doc.rect(x, y, width, height, "FD");
    setColor(doc, "setTextColor", COLORS.muted);
    doc.setFontSize(8);
    doc.text("Chart unavailable for export", x + width / 2, y + height / 2, { align: "center" });
  }
  boxes.push({ page: doc.internal.getCurrentPageInfo().pageNumber, x, y, width, height, name });
  return y + height;
}

function tableRow(doc, row, widths) {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.8);
  const cells = row.map((value, index) => wrapped(doc, value, widths[index] - 6));
  return { cells, height: Math.max(7, 3 + Math.max(1, ...cells.map((cell) => cell.length)) * TABLE_LINE_HEIGHT) };
}

function drawTable(doc, headers, rows, y, widths, boxes, name, newPage) {
  const x = A4_PAGE.marginX;
  const headerHeight = 8;
  let cursor = y;
  let segmentPage = doc.internal.getCurrentPageInfo().pageNumber;
  let segmentY = y;
  const segments = [];
  const closeSegment = () => {
    segments.push({
      page: segmentPage,
      x,
      y: segmentY,
      width: A4_PAGE.contentWidth,
      height: cursor - segmentY,
      name,
    });
  };
  const drawHeader = () => {
    setColor(doc, "setFillColor", COLORS.paper);
    setColor(doc, "setDrawColor", COLORS.line);
    doc.rect(x, cursor, A4_PAGE.contentWidth, headerHeight, "FD");
    setColor(doc, "setTextColor", COLORS.navy);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    let left = x + 3;
    headers.forEach((header, index) => {
      doc.text(header, left, cursor + 5.2);
      left += widths[index];
    });
    cursor += headerHeight;
  };
  const measuredRows = rows.map((row) => tableRow(doc, row, widths));
  if (cursor + headerHeight + (measuredRows[0]?.height || 0) > A4_PAGE.bottom) {
    newPage();
    cursor = A4_PAGE.top;
    segmentPage = doc.internal.getCurrentPageInfo().pageNumber;
    segmentY = cursor;
  }
  drawHeader();
  measuredRows.forEach(({ cells, height: rowHeight }) => {
    if (cursor + rowHeight > A4_PAGE.bottom) {
      closeSegment();
      newPage();
      cursor = A4_PAGE.top;
      segmentPage = doc.internal.getCurrentPageInfo().pageNumber;
      segmentY = cursor;
      drawHeader();
    }
    setColor(doc, "setDrawColor", COLORS.line);
    doc.line(x, cursor + rowHeight, x + A4_PAGE.contentWidth, cursor + rowHeight);
    setColor(doc, "setTextColor", COLORS.ink);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.8);
    let left = x + 3;
    cells.forEach((cell, index) => {
      doc.text(cell, left, cursor + 4.7);
      left += widths[index];
    });
    cursor += rowHeight;
  });
  closeSegment();
  boxes.push(...segments);
  return cursor;
}

function sectionLeadHeight(doc, section) {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  const noteLines = section.note ? wrapped(doc, section.note, A4_PAGE.contentWidth).length : 0;
  return 5.5 + (noteLines ? noteLines * 3.8 + 2 : 0) +
    (section.legend ? 6 : 0) + chartDimensions(section.image).height + 4;
}

export function renderExecutivePdf({ doc, data, chartImages = {}, generated = new Date().toLocaleDateString() }) {
  const kpis = data?.kpis || {};
  const categories = data?.categories || [];
  const failureModes = data?.failure_modes || [];
  const takeaways = [
    number(kpis.bassett_avg) !== null && number(kpis.benchmark_avg) !== null
      ? `Bassett ${number(kpis.bassett_avg) >= number(kpis.benchmark_avg) ? "outscores" : "trails"} benchmark models by ${Math.abs(number(kpis.bassett_avg) - number(kpis.benchmark_avg)).toFixed(1)} points on average (${fmtScore(kpis.bassett_avg)} vs ${fmtScore(kpis.benchmark_avg)} / 10).`
      : "Competitive score comparison is unavailable until both sides have scored tests in the same scope.",
    kpis.pass_rate == null
      ? "Pass rate is unavailable because no evaluated tests are in scope."
      : `Pass rate is ${fmtPct(kpis.pass_rate)} across ${safeText(kpis.total_evaluated, "0")} evaluated tests.`,
    `Head-to-head: Bassett won ${safeText(kpis.wins, "0")} tests outright against ChatGPT and Claude and lost ${safeText(kpis.losses, "0")}.`,
    categories.length > 1
      ? `Strongest category: ${categories[0].category} (${fmtScore(categories[0].avg_score)}/10). Weakest: ${categories[categories.length - 1].category} (${fmtScore(categories[categories.length - 1].avg_score)}/10).`
      : null,
    kpis.open_critical > 0
      ? `${kpis.open_critical} open critical finding${kpis.open_critical === 1 ? "" : "s"} require resolution before the next release.`
      : "No open critical findings — quality risk is currently low.",
    (data?.stale_gold_tests || []).length
      ? `Reverification required for ${(data.stale_gold_tests || []).length} evaluated test${data.stale_gold_tests.length === 1 ? "" : "s"} with stale Gold Standard evidence.`
      : null,
  ].filter(Boolean);

  const boxes = [];
  const newPage = () => {
    doc.addPage();
    drawHeader(doc, generated);
    return A4_PAGE.top;
  };
  drawHeader(doc, generated);
  let y = drawSectionTitle(doc, "Executive Summary", A4_PAGE.top, data?.scope || "Scope unavailable");
  y += 2;
  y = drawKpiCards(doc, kpis, y, boxes) + 7;
  y = drawTakeaways(doc, takeaways, y, boxes);

  const sections = [
    {
      name: "Quarterly Accuracy Trend",
      title: "Quarterly Accuracy Trend — Bassett vs Benchmarks",
      note: "Scale: 0–10. Missing values appear as gaps.",
      image: chartImages.trend,
      table: null,
      legend: true,
    },
    {
      name: "Top Failure Modes",
      title: "Top Failure Modes (all findings)",
      note: "Each count is the number of findings tagged with that failure mode.",
      image: chartImages.failureModes,
      table: { headers: ["Failure mode", "Count"], widths: [145, 37], rows: failureModes.map((item) => [item.mode, item.count]) },
    },
    {
      name: "Bassett Category Performance",
      title: "Bassett Category Performance",
      note: "Scale: 0–10. Averages use scored Bassett evaluations in the report scope.",
      image: chartImages.categories,
      table: { headers: ["Category", "Average score out of 10"], widths: [145, 37], rows: categories.map((item) => [item.category, formatEvaluationScore(item.avg_score)]) },
    },
  ];

  sections.forEach((section) => {
    const width = A4_PAGE.contentWidth;
    const leadHeight = sectionLeadHeight(doc, section);
    if (y + leadHeight > A4_PAGE.bottom) y = newPage();
    const start = y;
    const startPage = doc.internal.getCurrentPageInfo().pageNumber;
    y = drawSectionTitle(doc, section.title, y, section.note);
    if (section.legend) {
      drawLegend(doc, y);
      y += 6;
    }
    boxes.push({ page: startPage, x: A4_PAGE.marginX, y: start, width, height: y - start, name: section.name });
    y = drawChartImage(doc, section.image, y, boxes, `${section.name} chart`) + 4;
    if (section.table) {
      y = drawTable(doc, section.table.headers, section.table.rows, y, section.table.widths, boxes, `${section.name} table`, newPage);
    }
    y += 8;
  });

  const totalPages = doc.getNumberOfPages();
  for (let page = 1; page <= totalPages; page += 1) {
    doc.setPage(page);
    drawFooter(doc, page, totalPages, generated);
  }
  return { pageCount: totalPages, boxes };
}

export async function captureExecutiveChart(element, html2canvas) {
  if (!element) return Promise.resolve(null);
  const rect = element.getBoundingClientRect();
  const scale = Math.max(1, Math.min(3, 2400 / Math.max(rect.width, 1), 1800 / Math.max(rect.height, 1)));
  const canvas = await html2canvas(element, {
    scale,
    backgroundColor: "#FFFFFF",
    useCORS: true,
    logging: false,
  });
  if (!canvas?.width || !canvas?.height) throw new Error("A chart could not be captured.");
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}
