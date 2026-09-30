import {
  api, formatApiErrorDetail, isDefinitiveAuthFailure, RESULT_COLORS, staleUpdateMessage, withExpectedVersion,
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
  await expect(rejected.rejected(interceptorError(401, undefined, "/auth/me"))).rejects.toEqual(expect.any(Object));
  expect(expired).not.toHaveBeenCalled();
  await expect(rejected.rejected(interceptorError(401))).rejects.toEqual(expect.any(Object));
  expect(expired).toHaveBeenCalledTimes(1);
  window.removeEventListener("zoneqa:auth-expired", expired);
});

test("versioned updates prefer the fetched revision and preserve changes", () => {
  expect(withExpectedVersion(
    { revision: 3, updated_at: "stamp" },
    { name: "Edited" },
  )).toEqual({ name: "Edited", expected_revision: 3 });
});

test("versioned updates discard stale copied tokens and send one current token", () => {
  expect(withExpectedVersion(
    { expected_revision: 4, revision: 3, expected_updated_at: "current-stamp", updated_at: "old-stamp" },
    { name: "Edited", expected_revision: 2, expected_updated_at: "stale-stamp" },
  )).toEqual({ name: "Edited", expected_revision: 4 });
});

test("versioned updates fall back to a fetched timestamp when no revision exists", () => {
  expect(withExpectedVersion({ updated_at: "stamp" }, { name: "Edited" }))
    .toEqual({ name: "Edited", expected_updated_at: "stamp" });
});

test("stale update errors retain edits with an actionable message", () => {
  expect(staleUpdateMessage({ response: { status: 409, data: { detail: { code: "stale_update" } } } }))
    .toContain("edits are still open");
  expect(staleUpdateMessage({ response: { status: 409, data: { detail: { code: "other_conflict" } } } })).toBe("");
  expect(staleUpdateMessage({ response: { status: 500 } })).toBe("");
});

test("structured API errors are readable instead of object placeholders", () => {
  expect(formatApiErrorDetail({ message: "Select a Bassett version." }))
    .toBe("Select a Bassett version.");
  expect(formatApiErrorDetail({ general_subtype_ids: "Unknown subtype" }))
    .toBe("general subtype ids: Unknown subtype");
});

test("Bassett result colors use green, yellow, and red status semantics", () => {
  expect(RESULT_COLORS.Pass).toBe("#16a34a");
  expect(RESULT_COLORS["Pass with Notes"]).toBe("#f59e0b");
  expect(RESULT_COLORS["Pass with Minor Issues"]).toBe("#f59e0b");
  expect(RESULT_COLORS["Needs Improvement"]).toBe("#f59e0b");
  expect(RESULT_COLORS.Partial).toBe("#f59e0b");
  expect(RESULT_COLORS.Blocked).toBe("#64748b");
  expect(RESULT_COLORS.Fail).toBe("#dc2626");
  expect(RESULT_COLORS["Critical Fail"]).toBe("#b91c1c");
});
