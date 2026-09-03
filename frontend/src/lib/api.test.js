import {
  api, isDefinitiveAuthFailure, RESULT_COLORS, staleUpdateMessage, withExpectedVersion,
} from "./api";

function interceptorError(status, detail, url = "/projects") {
  return {
    response: status == null ? undefined : { status, data: { detail } },
    config: { url },
  };
}

test("API uses the same-origin relative proxy", () => {
  expect(api.defaults.baseURL).toBe("/api");
});

test("only definitive session failures expire auth", () => {
  expect(isDefinitiveAuthFailure(interceptorError(401))).toBe(true);
  expect(isDefinitiveAuthFailure(interceptorError(403, "This account is inactive"))).toBe(true);
  expect(isDefinitiveAuthFailure(interceptorError(403, "Insufficient permissions"))).toBe(false);
  expect(isDefinitiveAuthFailure(interceptorError(503))).toBe(false);
  expect(isDefinitiveAuthFailure(interceptorError())).toBe(false);
});

test("API interceptor ignores transient errors and dispatches definitive expiry", async () => {
  const expired = jest.fn();
  window.addEventListener("zoneqa:auth-expired", expired);
  const rejected = api.interceptors.response.handlers.find((handler) => handler.rejected);
  await expect(rejected.rejected(interceptorError(503))).rejects.toEqual(expect.any(Object));
  expect(expired).not.toHaveBeenCalled();
  await expect(rejected.rejected(interceptorError(401))).rejects.toEqual(expect.any(Object));
  expect(expired).toHaveBeenCalledTimes(1);
  window.removeEventListener("zoneqa:auth-expired", expired);
});

test("versioned updates prefer the fetched timestamp and preserve changes", () => {
  expect(withExpectedVersion(
    { revision: 3, updated_at: "stamp" },
    { name: "Edited" },
  )).toEqual({ name: "Edited", expected_updated_at: "stamp" });
});

test("versioned updates fall back to a fetched revision", () => {
  expect(withExpectedVersion({ revision: 3 }, { name: "Edited" }))
    .toEqual({ name: "Edited", expected_revision: 3 });
});

test("stale update errors retain edits with an actionable message", () => {
  expect(staleUpdateMessage({ response: { status: 409 } }))
    .toContain("edits are still open");
  expect(staleUpdateMessage({ response: { status: 500 } })).toBe("");
});

test("Bassett result colors use green, yellow, and red status semantics", () => {
  expect(RESULT_COLORS.Pass).toBe("#16a34a");
  expect(RESULT_COLORS["Pass with Notes"]).toBe("#f59e0b");
  expect(RESULT_COLORS["Pass with Minor Issues"]).toBe("#f59e0b");
  expect(RESULT_COLORS["Needs Improvement"]).toBe("#f59e0b");
  expect(RESULT_COLORS.Partial).toBe("#f59e0b");
  expect(RESULT_COLORS.Blocked).toBe("#f59e0b");
  expect(RESULT_COLORS.Fail).toBe("#dc2626");
  expect(RESULT_COLORS["Critical Fail"]).toBe("#b91c1c");
});