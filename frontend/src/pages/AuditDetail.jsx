import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { PageHeader } from "../components/shared";
import { QueryState } from "../components/PageState";
import { Button } from "../components/ui/button";

function readableDetail(value) {
  if (value === null || value === undefined || value === "") return "Not recorded";
  if (Array.isArray(value)) return value.map(readableDetail).join(", ");
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key.replaceAll("_", " ")}: ${readableDetail(item)}`).join(" · ");
  return String(value);
}

export default function AuditDetail() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ["audit-detail", id],
    queryFn: async () => (await api.get(`/activities/${id}`, { timeout: 15000 })).data,
    retry: false,
  });
  return <div className="min-w-0">
    <PageHeader title="Audit detail" subtitle="Restricted administrator view. Sensitive email fields are masked." />
    <Button asChild variant="outline" size="sm"><Link to="/">← Back to Dashboard</Link></Button>
    <div className="mt-4">
      {(query.isLoading || query.isError) && <QueryState query={query} resource="audit detail" testId="audit-detail" />}
      {query.data && <dl className="grid min-w-0 grid-cols-1 gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2">
        {[
          ["Action", query.data.action],
          ["Record type", String(query.data.entity_type || "").replaceAll("_", " ")],
          ["Performed by", query.data.user],
          ["Recorded at", query.data.created_at ? new Date(query.data.created_at).toLocaleString() : ""],
          ["Detail", readableDetail(query.data.detail)],
        ].map(([label, value]) => <div key={label} className={label === "Detail" ? "min-w-0 sm:col-span-2" : "min-w-0"}>
          <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
          <dd className="mt-1 break-words text-sm text-[var(--ink)]">{value || "Not recorded"}</dd>
        </div>)}
      </dl>}
    </div>
  </div>;
}