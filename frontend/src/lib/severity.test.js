import { SEVERITY_LABELS, severityLabel, severityNumber } from "./severity";

test("maps numeric criticality to the canonical severity labels", () => {
  expect(SEVERITY_LABELS).toEqual(["Very Low", "Low", "Medium", "High", "Critical"]);
  expect([1, 2, 3, 4, 5].map(severityLabel)).toEqual(SEVERITY_LABELS);
});

test("normalizes legacy severity labels without changing result semantics", () => {
  expect(severityLabel("Informational")).toBe("Very Low");
  expect(severityLabel("Minor")).toBe("Low");
  expect(severityLabel("Moderate")).toBe("Medium");
  expect(severityLabel("Critical Fail")).toBe("Critical");
  expect(severityNumber("High")).toBe(4);
});

test("finding severity takes deterministic precedence over mismatched criticality", () => {
  const { findingSeverityLabel, isHighOrCriticalSeverity } = require("./severity");
  expect(findingSeverityLabel({ severity: "Low", criticality: 5 })).toBe("Low");
  expect(isHighOrCriticalSeverity({ severity: "Low", criticality: 5 })).toBe(false);
  expect(isHighOrCriticalSeverity({ severity: "Critical", criticality: 1 })).toBe(true);
  expect(isHighOrCriticalSeverity({ severity: "Critical Fail", criticality: 1 })).toBe(true);
  expect(isHighOrCriticalSeverity({ severity: "", criticality: 4 })).toBe(true);
  expect(isHighOrCriticalSeverity({ severity: "4.0", criticality: 5 })).toBe(false);
});
