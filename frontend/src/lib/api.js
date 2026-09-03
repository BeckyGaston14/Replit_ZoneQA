import axios from "axios";
import { EVALUATION_RESULT_COLORS } from "./evaluationResults";

// Published traffic is served by the same-origin /api proxy.  Keeping this
// relative also lets the browser retain the HttpOnly session cookie on refresh.
const API = "/api";

export const api = axios.create({ baseURL: API, withCredentials: true });

export function isDefinitiveAuthFailure(error) {
  const status = error?.response?.status;
  const detail = error?.response?.data?.detail;
  return status === 401 || (
    status === 403
    && typeof detail === "string"
    && /inactive/i.test(detail)
  );
}

api.interceptors.request.use((config) => {
  const method = (config.method || "get").toLowerCase();
  if (["post", "put", "patch", "delete"].includes(method)) {
    const csrf = document.cookie
      .split("; ")
      .find((entry) => entry.startsWith("zq_csrf="))
      ?.split("=")
      .slice(1)
      .join("=");
    if (csrf) config.headers["X-CSRF-Token"] = decodeURIComponent(csrf);
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = String(error.config?.url || "");
    // Credential submission failures do not prove that an existing browser
    // session has expired.  All other definitive auth responses do.
    const isCredentialEndpoint = /\/auth\/(login|activate|bootstrap)(?:$|\?)/.test(url);
    if (!isCredentialEndpoint && isDefinitiveAuthFailure(error)) {
      window.dispatchEvent(new Event("zoneqa:auth-expired"));
    }
    return Promise.reject(error);
  },
);

export const CRIT_COLORS = {
  1: "#64748b", 2: "#0ea5e9", 3: "#f59e0b", 4: "#f97316", 5: "#dc2626",
};

export const RESULT_COLORS = {
  ...EVALUATION_RESULT_COLORS,
  "Pass with Notes": EVALUATION_RESULT_COLORS["Pass with Minor Issues"],
  Partial: EVALUATION_RESULT_COLORS["Needs Improvement"],
  Blocked: "#64748b",
  "Not Enough Evidence": EVALUATION_RESULT_COLORS["Not Evaluated"],
};

export function formatApiErrorDetail(detail) {
  if (detail == null) return "Something went wrong.";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((e) => e?.msg || JSON.stringify(e)).join(" ");
  if (detail?.msg) return detail.msg;
  return String(detail);
}

export function withExpectedVersion(record, changes = {}) {
  const body = { ...changes };
  if (record?.expected_updated_at) body.expected_updated_at = record.expected_updated_at;
  else if (record?.updated_at) body.expected_updated_at = record.updated_at;
  else if (record?.expected_revision != null) body.expected_revision = record.expected_revision;
  else if (record?.revision != null) body.expected_revision = record.revision;
  return body;
}

export function staleUpdateMessage(error) {
  return error?.response?.status === 409
    ? "This record changed elsewhere. Your edits are still open; review them against the latest saved version before trying again."
    : "";
}
