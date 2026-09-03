import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { UserCircle2 } from "lucide-react";
import { toast } from "sonner";
import { activeAssignableUsers } from "../lib/userValidation";

const NONE = "__none";

export function AssigneePicker({ entityType, entityId, assigneeId, assigneeName, canWrite, onChanged }) {
  const qc = useQueryClient();
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: async () => (await api.get("/users")).data });

  const assign = async (val) => {
    const id = val === NONE ? null : val;
    const { data } = await api.post("/assign", { entity_type: entityType, entity_id: entityId, assignee_id: id });
    toast.success(id ? `Assigned to ${data.assignee_name}` : "Unassigned");
    qc.invalidateQueries();
    onChanged?.(data);
  };

  if (!canWrite) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="assignee-readonly">
        <UserCircle2 size={14} /> {assigneeName || "Unassigned"}
      </span>
    );
  }

  return (
    <label className="inline-flex items-center gap-1.5 text-xs" data-testid="assignee-picker">
      <UserCircle2 size={15} className={assigneeId ? "text-[var(--orange)]" : "text-muted-foreground"} />
      <select
        value={assigneeId || NONE}
        onChange={(e) => assign(e.target.value)}
        data-testid="assignee-select"
        className={`h-7 text-xs border rounded-lg px-1.5 bg-card max-w-[160px] ${assigneeId ? "text-[var(--navy)] font-semibold border-[var(--orange)]/40" : "text-muted-foreground"}`}>
        <option value={NONE}>Unassigned</option>
        {activeAssignableUsers(users).map((u) => (
          <option key={u.id} value={u.id}>{u.name}</option>
        ))}
      </select>
    </label>
  );
}
