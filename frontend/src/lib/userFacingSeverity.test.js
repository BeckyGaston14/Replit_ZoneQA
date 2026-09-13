const fs = require("fs");
const path = require("path");

const USER_FACING_SOURCES = [
  path.resolve(__dirname, "../components/shared.jsx"),
  path.resolve(__dirname, "../pages/Executive.jsx"),
  path.resolve(__dirname, "../pages/Findings.jsx"),
  path.resolve(__dirname, "../pages/ReleaseReadiness.jsx"),
  path.resolve(__dirname, "./executivePdf.js"),
  path.resolve(__dirname, "./reportExports.js"),
  path.resolve(__dirname, "../pages/Reports.jsx"),
  path.resolve(__dirname, "../../../backend/server.py"),
];

test("user-facing severity sources do not reintroduce numeric criticality wording", () => {
  // Keep this assertion scoped to rendered labels, descriptions, exports, and
  // accessibility text. Numeric criticality remains supported internally for
  // filtering, persistence, and calculations.
  const legacyNumericSeverity = /(?:criticality|crit(?:ical)?)(?:\s+|[-–—])(?:4\s*(?:[-–—]|and|to)\s*5|[45])\b/i;
  const violations = USER_FACING_SOURCES.flatMap((sourcePath) => {
    const source = fs.readFileSync(sourcePath, "utf8");
    return legacyNumericSeverity.test(source) ? [path.relative(process.cwd(), sourcePath)] : [];
  });

  expect(violations).toEqual([]);
});