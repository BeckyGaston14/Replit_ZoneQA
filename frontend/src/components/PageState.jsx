import { Button } from "./ui/button";
import { RefreshCw } from "lucide-react";

export function classifyRequestError(error) {
  const status = error?.response?.status;
  const detail = error?.response?.data?.detail;
  if (status === 401 || (status === 403 && typeof detail === "string" && /inactive|session|auth/i.test(detail))) return "session";
  if (status === 403) return "permission";
  if (status === 404) return "not-found";
  return "recoverable";
}

export function QueryState({ query, resource, onRetry, notFoundAction, testId = "query-state" }) {
  if (!query?.isLoading && !query?.isError) return null;
  if (query.isLoading) {
    return <div role="status" aria-live="polite" data-testid={`${testId}-loading`} className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">Loading {resource.toLowerCase()}…</div>;
  }

  const kind = classifyRequestError(query.error);
  if (kind === "session") {
    return (
      <div role="alert" data-testid={`${testId}-session`} className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="font-semibold">Your session has expired.</p>
        <p className="mt-1">Sign in again to return to this page.</p>
        <Button asChild size="sm" className="mt-3"><a href="/login">Sign in</a></Button>
      </div>
    );
  }
  if (kind === "permission") {
    return (
      <div role="alert" data-testid={`${testId}-permission`} className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="font-semibold">Permission denied.</p>
        <p className="mt-1">You do not have permission to view {resource.toLowerCase()}.</p>
      </div>
    );
  }
  if (kind === "not-found" && notFoundAction) {
    return (
      <div role="alert" data-testid={`${testId}-not-found`} className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="font-semibold">{resource} was not found or is no longer available.</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={notFoundAction}>Return safely</Button>
      </div>
    );
  }
  return (
    <div role="alert" data-testid={`${testId}-error`} className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p className="font-semibold">Unable to load {resource.toLowerCase()}.</p>
      <Button type="button" size="sm" variant="outline" className="mt-3" onClick={onRetry || query.refetch}>
        <RefreshCw size={14} className="mr-1" /> Retry
      </Button>
    </div>
  );
}