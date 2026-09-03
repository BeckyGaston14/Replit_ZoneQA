import { formatTestDate, todayInTimeZone } from "./testDates";

describe("test dates", () => {
  test("uses the configured timezone at a UTC date boundary", () => {
    const instant = new Date("2026-09-01T02:00:00Z");
    expect(todayInTimeZone("America/New_York", instant)).toBe("2026-08-31");
    expect(todayInTimeZone("Asia/Tokyo", instant)).toBe("2026-09-01");
  });

  test("formats ISO dates without a timezone shift", () => {
    expect(formatTestDate("2024-02-29")).not.toBe("Not recorded");
  });

  test("does not invent missing or invalid historical dates", () => {
    expect(formatTestDate(null)).toBe("Not recorded");
    expect(formatTestDate("2026-9-1")).toBe("Not recorded");
  });
});