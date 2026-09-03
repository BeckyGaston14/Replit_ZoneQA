export const DEFAULT_APPLICATION_TIMEZONE = "America/New_York";

export function todayInTimeZone(timeZone = DEFAULT_APPLICATION_TIMEZONE, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatTestDate(value, style = "medium") {
  if (!value) return "Not recorded";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return "Not recorded";
  const instant = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(undefined, { dateStyle: style, timeZone: "UTC" }).format(instant);
}
