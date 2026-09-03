import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { PageHeader, ResultBadge, ScorePill } from "../components/shared";
import { Button } from "../components/ui/button";
import { formatTestDate } from "../lib/testDates";
import { TABLE_CLASS, TABLE_FRAME_CLASS, TABLE_HEAD_CLASS } from "../lib/tableStyles";
import { QueryState } from "../components/PageState";

export default function DashboardRecords() {
  const { metric } = useParams();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["dashboard-records", metric],
    queryFn: async () => (await api.get(`/dashboard/records/${metric}`, { timeout: 15000 })).data,
    retry: false,
  });

  const back = <Button asChild variant="outline" size="sm"><Link to="/">← Back to Dashboard</Link></Button>;
  if (query.isLoading) return <div><PageHeader title="Dashboard records" subtitle="Loading the exact records behind this metric." />{back}<div className="mt-3"><QueryState query={query} resource="metric records" testId="dashboard-records" /></div></div>;
  if (query.isError) return <div><PageHeader title="Dashboard records" subtitle="The exact records behind this metric." />{back}<div className="mt-3"><QueryState query={query} resource="Dashboard metric" onRetry={query.refetch} notFoundAction={() => navigate("/")} testId="dashboard-records" /></div></div>;

  const data = query.data;
  return <div>
    <PageHeader title={data.title} subtitle={`${data.definition} Active version: ${data.active_version || "No active version"}.`} />
    <div className="flex items-center justify-between mb-3">
      {back}
      <span className="text-sm text-muted-foreground">{data.count} canonical record{data.count === 1 ? "" : "s"}</span>
    </div>
    <div className={TABLE_FRAME_CLASS} data-testid="dashboard-records-table-scroll" role="region" aria-label={`${data.title} records table`} tabIndex="0">
      <table className={TABLE_CLASS}>
        <thead className={TABLE_HEAD_CLASS}><tr>
          <th className="px-4 py-3">Record</th><th className="px-4 py-3">Type</th>
          <th className="px-4 py-3">Status / Result</th><th className="px-4 py-3">Value</th>
          <th className="px-4 py-3">Date</th><th className="px-4 py-3">Context</th>
        </tr></thead>
        <tbody>
          {data.records.map((record) => <tr key={`${record.type}-${record.id}`} className="border-t">
            <td className="px-4 py-3 font-semibold text-[var(--navy)]"><Link className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]" to={record.to}>{record.name}</Link></td>
            <td className="px-4 py-3">{record.type || "—"}</td>
            <td className="px-4 py-3">{data.metric === "bassett-score" ? <ResultBadge value={record.status} /> : (record.status || "—")}</td>
            <td className="px-4 py-3">{data.metric === "bassett-score" && record.value != null
              ? <ScorePill score={record.value} status={record.status} />
              : (record.value ?? "—")}</td>
            <td className="px-4 py-3"><time dateTime={record.date || undefined}>{record.date ? formatTestDate(record.date) : "—"}</time></td>
            <td className="px-4 py-3 text-muted-foreground">{record.secondary || "—"}</td>
          </tr>)}
          {data.records.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No records are included in this metric’s current scope.</td></tr>}
        </tbody>
      </table>
    </div>
  </div>;
}