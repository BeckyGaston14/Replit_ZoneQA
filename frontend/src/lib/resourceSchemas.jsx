import { formatTestDate } from "./testDates";

export const MUNICIPALITY_ADD_FIELDS = [
  { key: "name", label: "Municipality" },
  { key: "state", label: "State" },
];

const municipalityRelation = {
  type: "relation",
  collection: "municipalities",
  labelFn: (municipality) => `${municipality.name}, ${municipality.state}`,
  addFields: MUNICIPALITY_ADD_FIELDS,
};

const nameCell = (value) => <span className="font-semibold text-[var(--navy)]">{value}</span>;

export const PROJECT_SCHEMA = {
  title: "Testing Projects",
  singular: "Testing Project",
  subtitle: "Groups of related test cases.",
  collection: "projects",
  dataEndpoint: "/list/projects-enriched",
  dateFilterColumn: "last_tested_date",
  exportFilename: "zoneqa-projects.csv",
  attachable: "project",
  parentLifecycle: true,
  dateRanges: [{ start: "start_date", end: "target_date", startLabel: "Start Date", endLabel: "Target Completion" }],
  initial: { status: "Active", priority: "Medium", completion_mode: "automatic" },
  columns: [
    { key: "name", label: "Project", type: "text", render: (row) => nameCell(row.name) },
    { key: "owner", label: "Owner" },
    { key: "status", label: "Status", type: "status", order: ["Active", "On Hold", "Completed", "Archived"] },
    { key: "priority", label: "Priority", type: "priority" },
    { key: "bassett_version", label: "Bassett Version", type: "version" },
    {
      key: "completion",
      label: "Complete",
      type: "percentage",
      render: (row) => (
        <span title={row.completion_definition}>
          <span className="font-semibold text-[var(--navy)]">{row.completion == null ? "—" : `${row.completion}%`}</span>
          <span className="block text-[10px] text-muted-foreground">{row.completion_source} · {row.completion_status}</span>
        </span>
      ),
      exportValue: (row) => row.completion == null
        ? `${row.completion_source}: ${row.completion_status}`
        : `${row.completion}% · ${row.completion_source} · ${row.completion_status}`,
    },
    {
      key: "last_tested_date",
      label: "Last Tested Date",
      type: "date",
      render: (row) => <time dateTime={row.last_tested_date || undefined} title={row.last_tested_scope}>{row.last_tested_date ? formatTestDate(row.last_tested_date) : "Not Yet Tested"}</time>,
      exportValue: (row) => row.last_tested_date || "Not Yet Tested",
    },
  ],
  fields: [
    { key: "name", label: "Project Name", required: true, col: 2 },
    { key: "description", label: "Description", type: "textarea", col: 2 },
    { key: "owner_id", label: "Owner", type: "relation", collection: "users", labelFn: (user) => user.name },
    { key: "priority", label: "Priority", type: "select", options: ["Low", "Medium", "High", "Critical"] },
    { key: "status", label: "Status", type: "select", options: ["Active", "On Hold", "Completed", "Archived"] },
    { key: "bassett_version", label: "Bassett Version", type: "relation", collection: "versions", labelFn: (version) => version.name },
    { key: "start_date", label: "Start Date", type: "date" },
    { key: "target_date", label: "Target Completion", type: "date" },
    {
      key: "completion_mode",
      label: "Completion Calculation",
      type: "select",
      options: [
        { value: "automatic", label: "Automatic from linked test cases" },
        { value: "manual", label: "Manual override" },
      ],
    },
    { key: "completion_override", label: "Manual Completion %", type: "number", min: 0, max: 100, showWhen: (form) => form.completion_mode === "manual" },
    { key: "notes", label: "Notes", type: "textarea", col: 2 },
  ],
};

export const MUNICIPALITY_SCHEMA = {
  title: "Municipalities",
  singular: "Municipality",
  subtitle: "Reusable jurisdiction records — knowledge hub per municipality.",
  collection: "municipalities",
  parentLifecycle: true,
  dateRanges: [{ start: "code_effective_date", end: "latest_amendment_date", startLabel: "Code Effective Date", endLabel: "Latest Known Amendment Date" }],
  columns: [
    { key: "name", label: "Municipality", type: "text", render: (row) => nameCell(row.name) },
    { key: "state", label: "State" },
    { key: "county", label: "County" },
    { key: "primary_code", label: "Primary Code" },
    { key: "latest_amendment_date", label: "Latest Amendment", type: "date", render: (row) => row.latest_amendment_date || "—" },
    { key: "last_verified", label: "Last Verified", type: "date" },
  ],
  fields: [
    { key: "name", label: "Municipality", required: true },
    { key: "state", label: "State", required: true },
    { key: "county", label: "County" },
    { key: "muni_type", label: "Type", type: "select", options: ["City", "County", "Town", "Village", "Township", "Unincorporated"] },
    { key: "primary_code", label: "Primary Zoning Code", col: 2 },
    { key: "code_url", label: "Code URL", type: "url" },
    { key: "map_url", label: "Zoning Map URL", type: "url" },
    { key: "code_effective_date", label: "Code Effective Date", type: "date" },
    { key: "last_verified", label: "Last Verified Date", type: "date" },
    { key: "latest_amendment_date", label: "Latest Known Amendment Date (drives evidence freshness flags)", type: "date" },
    { key: "notes", label: "Notes", type: "textarea", col: 2 },
  ],
};

export const PROPERTY_SCHEMA = {
  title: "Properties",
  singular: "Property",
  subtitle: "Property-specific testing records.",
  collection: "properties",
  parentLifecycle: true,
  columns: [
    { key: "name", label: "Property", render: (row) => nameCell(row.name) },
    { key: "address", label: "Address" },
    { key: "zoning_district", label: "District" },
    { key: "property_type", label: "Type" },
  ],
  fields: [
    { key: "name", label: "Property Name", required: true, col: 2 },
    { key: "address", label: "Address", required: true, col: 2 },
    { key: "municipality_id", label: "Municipality", required: true, ...municipalityRelation },
    { key: "property_type", label: "Property Type", type: "select", options: ["Commercial", "Residential", "Industrial", "Mixed-Use", "Vacant Land", "Agricultural"] },
    { key: "apn", label: "Parcel / APN" },
    { key: "zoning_district", label: "Zoning District" },
    { key: "overlay", label: "Overlay" },
    { key: "special_district", label: "Special District" },
    { key: "notes", label: "Notes", type: "textarea", col: 2 },
  ],
};

const VERIFICATION_STYLES = {
  Unverified: { bg: "#fff7ed", color: "#c2410c" },
  "Verification in Progress": { bg: "#eff6ff", color: "#1d4ed8" },
  Verified: { bg: "#dcfce7", color: "#166534" },
  Superseded: { bg: "#f1f5f9", color: "#475569" },
  Conflicting: { bg: "#fef3c7", color: "#92400e" },
  Rejected: { bg: "#fee2e2", color: "#991b1b" },
};

export function VerificationBadge({ value }) {
  const style = VERIFICATION_STYLES[value] || VERIFICATION_STYLES.Unverified;
  return <span className="text-xs font-semibold rounded-full px-2 py-0.5" style={{ background: style.bg, color: style.color }}>{value || "Unverified"}</span>;
}

export function createEvidenceSchema(municipalities = []) {
  const municipalityMap = Object.fromEntries(municipalities.map((municipality) => [municipality.id, municipality]));
  const staleOf = (row) => {
    if (row.superseded_date) return `Superseded ${row.superseded_date}`;
    const latestAmendment = municipalityMap[row.municipality_id]?.latest_amendment_date;
    if (latestAmendment && row.effective_date && row.effective_date < latestAmendment) {
      return `Predates ${municipalityMap[row.municipality_id]?.name} amendment ${latestAmendment}`;
    }
    return null;
  };

  return {
    title: "Ordinance Evidence",
    subtitle: "Authoritative zoning sources & Gold Standard evidence base — full provenance per record.",
    collection: "evidence",
    attachable: "evidence",
    columns: [
      { key: "document_name", label: "Document", render: (row) => nameCell(row.document_name) },
      { key: "doc_type", label: "Type" },
      { key: "issuing_authority", label: "Issuing Authority", render: (row) => row.issuing_authority || "—" },
      { key: "citation", label: "Citation" },
      {
        key: "verification_status",
        label: "Verification",
        render: (row) => (
          <span>
            <VerificationBadge value={row.verification_status} />
            {row.verified_by && <span className="text-[10px] text-muted-foreground block mt-0.5">{row.verified_by}{row.verified_date ? ` · ${row.verified_date}` : ""}</span>}
          </span>
        ),
      },
      {
        key: "effective_date",
        label: "Effective / Freshness",
        type: "date",
        render: (row) => {
          const stale = staleOf(row);
          return (
            <span>{row.effective_date || "—"}
              {stale && <span className="block mt-0.5 text-[10px] font-bold text-red-700 bg-red-50 border border-red-200 rounded-full px-1.5 py-0.5 w-fit" data-testid="evidence-stale-flag">⚠ STALE — {stale}</span>}
            </span>
          );
        },
      },
      { key: "conflicts_with", label: "Conflicts", render: (row) => row.conflicts_with ? <span className="text-amber-700 font-semibold text-xs">⚠ linked</span> : "—" },
    ],
    fields: [
      { key: "document_name", label: "Document Name", required: true, col: 2 },
      { key: "municipality_id", label: "Municipality", required: true, ...municipalityRelation },
      { key: "doc_type", label: "Document Type / Source Type", type: "select", options: ["Ordinance Section", "Municipal Code", "Zoning Map", "Planned Development Ordinance", "Overlay", "Official Interpretation", "Municipal Correspondence", "Approval", "Property Document", "Other"] },
      { key: "jurisdiction", label: "Jurisdiction (e.g. City of New York, State of MI)" },
      { key: "issuing_authority", label: "Issuing Authority (e.g. Dept. of City Planning)" },
      { key: "document_version", label: "Ordinance / Document Version" },
      { key: "section", label: "Exact Section" },
      { key: "page_number", label: "Page Number" },
      { key: "citation", label: "Citation" },
      { key: "effective_date", label: "Effective Date", type: "date" },
      { key: "superseded_date", label: "Superseded Date (if replaced)", type: "date" },
      { key: "source_url", label: "Source URL", type: "url" },
      { key: "verification_status", label: "Verification Status", type: "select", options: ["Unverified", "Verification in Progress", "Verified", "Superseded", "Conflicting", "Rejected"] },
      { key: "verified_by", label: "Verified By" },
      { key: "verified_date", label: "Verified Date", type: "date" },
      { key: "conflicts_with", label: "Conflicting Evidence (link)", type: "relation", collection: "evidence", labelFn: (evidence) => evidence.document_name },
      { key: "relevant_text", label: "Extracted Source Text", type: "textarea", col: 2 },
      { key: "notes", label: "Notes", type: "textarea", col: 2 },
    ],
    dateRanges: [{ start: "effective_date", end: "superseded_date", startLabel: "Effective Date", endLabel: "Superseded Date" }],
  };
}
