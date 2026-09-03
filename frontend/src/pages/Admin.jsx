import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, staleUpdateMessage, withExpectedVersion } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, StatusBadge } from "../components/shared";
import { ACTIVITY_STATUSES } from "../lib/statusMaps";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { toast } from "sonner";
import { Plus, X, Plug, Pencil, Trash2, UserX, UserCheck, Save, Copy, Check, Mail, RefreshCw } from "lucide-react";
import { USER_ROLES as ROLES, filterUsersByStatus, userRoleLabel, validateNewUser, validateUserEdit } from "../lib/userValidation";
import { SortableTableHeader } from "../components/SortableTableHeader";
import { TableSortControls } from "../components/TableSortControls";
import { nextSort, sortTableRows, usePersistentTableSort } from "../lib/tableSorting";
import { ConfirmActionDialog } from "../components/ConfirmActionDialog";


const LOOKUPS = [
  ["categories", "Test Categories"], ["test_types", "Test Types"], ["failure_modes", "Failure Modes"],
  ["root_causes", "Root Causes"], ["test_statuses", "Test Statuses"], ["finding_statuses", "Finding Statuses"],
  ["pass_results", "Pass / Fail Results"], ["environments", "Environments"], ["demo_statuses", "Demo Statuses"],
  ["finding_types", "Finding Types"], ["version_types", "Bassett Version Types"],
  ["release_channels", "Release Channels"],
];
const DIMENSION_COLUMNS = [{ key: "label", label: "Dimension", type: "text" }, { key: "key", label: "Key", type: "natural" }, { key: "weight", label: "Weight", type: "number" }];
const MODEL_COLUMNS = [{ key: "name", label: "Model", type: "natural" }, { key: "provider", label: "Provider", type: "text" }, { key: "role_type", label: "Type", type: "text" }, { key: "active", label: "Active", type: "active" }];
const VERSION_COLUMNS = [
  { key: "name", label: "Version", type: "version" }, { key: "release_number", label: "Release #", type: "version" },
  { key: "version_type", label: "Type", type: "text" }, { key: "release_channel", label: "Channel", type: "text" },
  { key: "release_date", label: "Date", type: "date" }, { key: "environment", label: "Environment", type: "text" },
  { key: "active", label: "Active", type: "active" },
];
const USER_COLUMNS = [
  { key: "name", label: "Name", type: "natural" }, { key: "email", label: "Email", type: "text" },
  { key: "password_login_ready", label: "Sign-in", type: "active" }, { key: "role", label: "Role", type: "role" },
  { key: "active", label: "Status", type: "active" },
];

export default function Admin() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === "admin";
  const { data: config, refetch } = useQuery({ queryKey: ["config"], queryFn: async () => (await api.get("/config")).data, enabled: isAdmin });
  const { data: users = [], refetch: refetchUsers } = useQuery({ queryKey: ["users"], queryFn: async () => (await api.get("/users")).data, enabled: isAdmin });
  const { data: emailStatus } = useQuery({ queryKey: ["admin-email-status"], queryFn: async () => (await api.get("/admin/email/status")).data, enabled: isAdmin });
  const { data: models = [] } = useQuery({ queryKey: ["models"], queryFn: async () => (await api.get("/models")).data, enabled: isAdmin });
  const { data: versions = [], refetch: refetchVersions } = useQuery({ queryKey: ["versions"], queryFn: async () => (await api.get("/versions")).data, enabled: isAdmin });
  const [newItem, setNewItem] = useState({});
  const [integ, setInteg] = useState(null);
  const [editingUser, setEditingUser] = useState(null);
  const [userConflict, setUserConflict] = useState(null);
  const [userSaving, setUserSaving] = useState(false);
  const [userSaveError, setUserSaveError] = useState("");
  const [userSaveSuccess, setUserSaveSuccess] = useState("");
  const [addingUser, setAddingUser] = useState(false);
  const [newUser, setNewUser] = useState({ name: "", email: "", role: "tester", active: true, send_welcome_email: true });
  const [activationPath, setActivationPath] = useState("");
  const [welcomeEmailResult, setWelcomeEmailResult] = useState(null);
  const [copiedActivation, setCopiedActivation] = useState(false);
  const [editingVersion, setEditingVersion] = useState(null);
  const [confirmingAction, setConfirmingAction] = useState(null);
  const [userStatusFilter, setUserStatusFilter] = useState("active");
  const [userActionBusy, setUserActionBusy] = useState(false);
  const [welcomeEmailBusy, setWelcomeEmailBusy] = useState(null);
  const [passwordResetBusy, setPasswordResetBusy] = useState(null);
  const [passwordResetResult, setPasswordResetResult] = useState(null);
  const [copiedReset, setCopiedReset] = useState(false);
  const emptyVersion = { name: "", release_number: "", release_date: "", environment: "Staging", version_type: "", release_channel: "", active: true };
  const [newVersion, setNewVersion] = useState(emptyVersion);
  const [dimensionSort, setDimensionSort] = usePersistentTableSort("admin-dimensions", DIMENSION_COLUMNS, { key: "label", direction: "asc" });
  const [modelSort, setModelSort] = usePersistentTableSort("admin-models", MODEL_COLUMNS, { key: "name", direction: "asc" });
  const [versionSort, setVersionSort] = usePersistentTableSort("admin-versions", VERSION_COLUMNS, { key: "name", direction: "desc" });
  const [userSort, setUserSort] = usePersistentTableSort("admin-users", USER_COLUMNS, { key: "name", direction: "asc" });
  const welcomeEmailReady = emailStatus?.status === "connected" && emailStatus?.published_url_configured !== false;

  const saveList = async (key, list) => { await api.put("/config", { [key]: list }); toast.success("Saved"); refetch(); };
  const addItem = (key) => { const v = (newItem[key] || "").trim(); if (!v) return; saveList(key, [...(config[key] || []), v]); setNewItem({ ...newItem, [key]: "" }); };
  const rmItem = (key, v) => saveList(key, config[key].filter((x) => x !== v));

  const changeRole = async (id, role) => {
    try { await api.put(`/users/${id}/role`, { role }); toast.success("Role updated"); refetchUsers(); }
    catch (e) { toast.error(e.response?.data?.detail || "Failed to update role"); }
  };

  const saveUser = async (event) => {
    event.preventDefault();
    setUserSaveError("");
    setUserSaveSuccess("");
    const { payload, error } = validateUserEdit(editingUser);
    if (error) {
      setUserSaveError(error);
      return;
    }
    setUserSaving(true);
    try {
      const { data } = await api.put(`/users/${editingUser.id}`, withExpectedVersion(editingUser, payload));
      await refetchUsers();
      const savedUser = data.user || data;
      const success = "User updated successfully.";
      setEditingUser(savedUser);
      setUserConflict(null);
      setUserSaveSuccess(success);
      toast.success(success);
    } catch (e) {
      const detail = e.response?.data?.detail;
      const stale = e.response?.status === 409 && detail?.code === "stale_update";
      if (stale) {
        const refreshed = await refetchUsers();
        const latestUsers = refreshed?.data || users;
        const latest = latestUsers.find((user) => user.id === editingUser.id);
        setUserConflict(latest || { revision: e.response?.data?.detail?.current_revision });
        const message = "This user changed elsewhere. The latest saved values were reloaded; review your edits and reapply them.";
        setUserSaveError(message);
        toast.error(staleUpdateMessage(e) || message);
      } else {
        const message = typeof detail === "string" ? detail : detail?.message || "Failed to update user";
        setUserSaveError(message);
        toast.error(message);
      }
    } finally {
      setUserSaving(false);
    }
  };

  const performToggleUser = async (u) => {
    const action = u.active === false ? "reactivate" : "deactivate";
    setUserActionBusy(true);
    try {
      await api.post(`/users/${u.id}/${action}`);
      await refetchUsers();
      if (editingUser?.id === u.id) setEditingUser((current) => ({ ...current, active: action === "reactivate" }));
      toast.success(action === "deactivate"
        ? `${u.name} was deactivated and signed out. Historical records were preserved.`
        : `${u.name} was reactivated and can sign in again.`);
    } catch (e) { toast.error(e.response?.data?.detail || `Failed to ${action} ${u.name}`); }
    finally { setUserActionBusy(false); setConfirmingAction(null); }
  };

  const toggleUser = async (u) => {
    if (u.active !== false) {
      setConfirmingAction({ type: "deactivate", user: u });
      return;
    }
    setConfirmingAction({ type: "reactivate", user: u });
  };

  const createUser = async (event) => {
    event.preventDefault();
    const { payload, error } = validateNewUser(newUser, users);
    if (error) return toast.error(error);
    try {
      const { data } = await api.post("/users", { ...payload, send_welcome_email: welcomeEmailReady && payload.send_welcome_email !== false });
      setActivationPath(data.activation_path);
      setWelcomeEmailResult(data.welcome_email || null);
      setCopiedActivation(false);
      setNewUser({ name: "", email: "", role: "tester", active: true, send_welcome_email: true });
      setAddingUser(false);
      await refetchUsers();
      toast.success(data.welcome_email?.sent
        ? "User created and welcome email sent."
        : data.welcome_email?.requested
          ? (data.welcome_email.message || "User created, but the welcome email could not be sent.")
          : "User created. Share the one-time setup link securely.");
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to create user"); }
  };

  const resendWelcomeEmail = (u) => {
    setConfirmingAction({ type: "resend-welcome", user: u });
  };

  const performResendWelcomeEmail = async (u) => {
    setWelcomeEmailBusy(u.id);
    try {
      const { data } = await api.post(`/users/${u.id}/welcome-email`);
      await refetchUsers();
      if (data.welcome_email?.sent) toast.success(`Welcome email resent to ${u.email}.`);
      else toast.error(data.welcome_email?.message || "Welcome email was not sent.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to resend welcome email");
    } finally {
      setWelcomeEmailBusy(null);
    }
  };

  const sendPasswordReset = (u) => {
    setPasswordResetResult(null);
    setCopiedReset(false);
    setConfirmingAction({ type: "password-reset", user: u });
  };

  const performPasswordReset = async (u) => {
    setPasswordResetBusy(u.id);
    try {
      const { data } = await api.post(`/users/${u.id}/password-reset`, { confirm: true });
      const path = data.reset_path;
      setPasswordResetResult({ user: u, path, email: data.email });
      toast.success(data.email?.sent ? `Password reset link sent to ${u.email}.` : "Reset link created, but email delivery failed.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to send password reset link");
    } finally {
      setPasswordResetBusy(null);
      setConfirmingAction(null);
    }
  };

  const deleteUser = async (u) => {
    try {
      const { data: impact } = await api.get(`/users/${u.id}/impact`);
      const msg = impact.total_references
        ? `Delete ${u.name}? Their login will be removed, but ${impact.total_references} linked historical record(s) will be preserved.`
        : `Delete ${u.name}? Their login will be permanently removed.`;
      setConfirmingAction({ type: "delete-user", user: u, message: msg });
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to delete user"); }
  };

  const saveVersion = async (version, isNew = false) => {
    try {
      if (!version.name.trim() || !version.release_number.trim()) {
        toast.error("Version name and release number are required"); return;
      }
      if (isNew) await api.post("/versions", version);
      else await api.put(`/versions/${version.id}`, withExpectedVersion(version, version));
      toast.success(isNew ? "Bassett version created" : "Bassett version updated");
      if (isNew) setNewVersion(emptyVersion); else setEditingVersion(null);
      refetchVersions();
    } catch (e) {
      toast.error(staleUpdateMessage(e) || e.response?.data?.detail || "Failed to save Bassett version");
      if (e.response?.status === 409) refetchVersions();
    }
  };

  const deleteVersion = async (v) => {
    setConfirmingAction({ type: "delete-version", version: v });
  };

  const performDeleteUser = async (u) => {
    setUserActionBusy(true);
    try {
      await api.delete(`/users/${u.id}?confirm=true`);
      await refetchUsers();
      if (editingUser?.id === u.id) setEditingUser(null);
      toast.success(`${u.name} was permanently deleted; historical records were preserved.`);
    } catch (e) { toast.error(e.response?.data?.detail || "Failed to delete user"); }
    finally { setUserActionBusy(false); setConfirmingAction(null); }
  };

  const performDeleteVersion = async (v) => {
    try { await api.delete(`/versions/${v.id}`); toast.success("Bassett version deleted"); refetchVersions(); }
    catch (e) { toast.error(e.response?.data?.detail || "Failed to delete Bassett version"); }
    finally { setConfirmingAction(null); }
  };

  const saveIntegrations = async () => {
    const { bassett_api_key: bassettKey, bassett_api_key_set: _keySet, ...safeIntegrations } = integ;
    await api.put("/config", { integrations: safeIntegrations });
    if (bassettKey?.trim()) {
      await api.put("/config/bassett-key", null, { headers: { "X-Bassett-API-Key": bassettKey.trim() } });
    }
    toast.success("Integration settings saved");
    setInteg(null); refetch();
  };

  if (!isAdmin) return (
    <div>
      <PageHeader title="Administration" subtitle="Administration access is restricted to administrators." />
      <div className="bg-card border rounded-xl p-5 text-sm" role="alert">
        <h2 className="font-display font-semibold text-[var(--navy)]">Access denied</h2>
        <p className="text-muted-foreground mt-1">You do not have permission to manage administration settings.</p>
      </div>
    </div>
  );
  if (!config) return <div className="text-muted-foreground">Loading…</div>;
  const cfgInteg = integ || config.integrations || {};
  const confirmation = confirmingAction;
  const activeAdminCount = users.filter((user) => user.role === "admin" && user.active !== false && !user.deleted_at).length;
  const userActionBlock = (user, action) => {
    if (user.id === me?.id) return `You cannot ${action} your own current account. Ask another active administrator to do this.`;
    if (user.role === "admin" && user.active !== false && activeAdminCount <= 1) return `You cannot ${action} the last active administrator.`;
    return "";
  };
  const shownUsers = filterUsersByStatus(users, userStatusFilter);

  return (
    <div>
      <PageHeader title="Administration" subtitle="Configurable lookups, scoring, users, models & Bassett versions." />
      <Tabs defaultValue="lookups">
        <TabsList className="max-w-full justify-start overflow-x-auto"><TabsTrigger value="lookups">Lookups</TabsTrigger><TabsTrigger value="dimensions">Scoring Dimensions</TabsTrigger><TabsTrigger value="models">Models</TabsTrigger><TabsTrigger value="versions">Bassett Versions</TabsTrigger><TabsTrigger value="users">Users & Roles</TabsTrigger><TabsTrigger value="integrations" data-testid="tab-integrations">Integrations</TabsTrigger></TabsList>

        <TabsContent value="lookups">
          <div className="grid md:grid-cols-2 gap-4">
            {LOOKUPS.map(([key, label]) => (
              <div key={key} className="bg-card border rounded-xl p-4">
                <h3 className="font-semibold font-display text-[var(--navy)] mb-2 text-sm">{label}</h3>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {(config[key] || []).map((v) => (
                   <span key={v} className="text-xs bg-[var(--paper)] border rounded-full pl-2.5 pr-1 py-0.5 flex items-center gap-1">{v}<button type="button" onClick={() => rmItem(key, v)} aria-label={`Remove ${v} from ${label}`} className="icon-action h-9 w-9 inline-flex items-center justify-center rounded-full hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--orange)]"><X size={12} aria-hidden="true" /></button></span>
                  ))}
                </div>
                <div className="flex gap-2"><Input className="h-8 text-sm" placeholder="Add…" aria-label={`Add ${label}`} value={newItem[key] || ""} onChange={(e) => setNewItem({ ...newItem, [key]: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addItem(key)} /><Button type="button" size="icon" className="icon-action" onClick={() => addItem(key)} aria-label={`Add ${label}`}><Plus size={14} aria-hidden="true" /></Button></div>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="dimensions">
          <div className="bg-card border rounded-xl p-5">
            <h3 className="font-semibold font-display text-[var(--navy)] mb-3">Evaluation Dimensions & Weights</h3>
            <TableSortControls columns={DIMENSION_COLUMNS} sort={dimensionSort} setSort={setDimensionSort} defaultSort={{ key: "label", direction: "asc" }} className="mb-2" />
            <div className="max-w-full overflow-x-auto overscroll-x-contain"><table className="w-full min-w-[420px] text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground"><tr>{DIMENSION_COLUMNS.map((column) => <SortableTableHeader key={column.key} column={column} sort={dimensionSort} onSort={(key) => setDimensionSort((current) => nextSort(current, key))} />)}</tr></thead>
              <tbody>{sortTableRows(config.eval_dimensions || [], DIMENSION_COLUMNS, dimensionSort, ["label"]).map((d) => (
                <tr key={d.key} className="border-t"><td className="py-2">{d.label}</td><td className="text-muted-foreground">{d.key}</td>
                  <td><Input type="number" className="h-8 w-20" value={d.weight} onChange={(e) => { const dims = [...config.eval_dimensions]; const index = dims.findIndex((item) => item.key === d.key); dims[index] = { ...d, weight: Number(e.target.value) }; api.put("/config", { eval_dimensions: dims }).then(() => refetch()); }} /></td></tr>
              ))}</tbody>
            </table></div>
            <p className="text-xs text-muted-foreground mt-3">Weights feed the Weighted Reward Score; raw component scores are always preserved.</p>
          </div>
        </TabsContent>

        <TabsContent value="models">
          <TableSortControls columns={MODEL_COLUMNS} sort={modelSort} setSort={setModelSort} defaultSort={{ key: "name", direction: "asc" }} className="mb-3" />
          <div className="bg-card border rounded-xl max-w-full overflow-x-auto overscroll-x-contain"><table className="w-full min-w-[560px] text-sm">
            <thead className="bg-[var(--paper)] text-left"><tr>{MODEL_COLUMNS.map((column) => <SortableTableHeader key={column.key} column={column} sort={modelSort} onSort={(key) => setModelSort((current) => nextSort(current, key))} />)}</tr></thead>
            <tbody>{sortTableRows(models, MODEL_COLUMNS, modelSort, ["name"]).map((m) => <tr key={m.id} className="border-t"><td className="px-4 py-2 font-semibold text-[var(--navy)]">{m.name}</td><td className="px-4 py-2">{m.provider}</td><td className="px-4 py-2">{m.role_type}</td><td className="px-4 py-2">{m.active ? "Yes" : "No"}</td></tr>)}</tbody>
          </table></div>
        </TabsContent>

        <TabsContent value="versions">
          <div className="bg-card border rounded-xl p-4 mb-4">
            <h3 className="font-semibold text-[var(--navy)] mb-3">{editingVersion ? "Edit Bassett Version" : "Add Bassett Version"}</h3>
            {(() => {
              const v = editingVersion || newVersion;
              const setV = editingVersion ? setEditingVersion : setNewVersion;
              return <div className="grid md:grid-cols-4 gap-3">
                <div><Label>Name</Label><Input value={v.name || ""} onChange={(e) => setV({...v, name:e.target.value})} placeholder="Bassett v2.1" /></div>
                <div><Label>Release number</Label><Input value={v.release_number || ""} onChange={(e) => setV({...v, release_number:e.target.value})} placeholder="2.1.0" /></div>
                <div><Label>Release date</Label><Input type="date" value={v.release_date || ""} onChange={(e) => setV({...v, release_date:e.target.value})} /></div>
                <div><Label>Environment</Label><Select value={v.environment || "Staging"} onValueChange={(x) => setV({...v, environment:x})}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(config.environments || []).map(x=><SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent></Select></div>
                <div><Label>Version type</Label><Select value={v.version_type || ""} onValueChange={(x) => setV({...v, version_type:x})}><SelectTrigger><SelectValue placeholder="Select version type" /></SelectTrigger><SelectContent>{(config.version_types || []).map(x=><SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent></Select></div>
                <div><Label>Release channel</Label><Select value={v.release_channel || ""} onValueChange={(x) => setV({...v, release_channel:x})}><SelectTrigger><SelectValue placeholder="Select release channel" /></SelectTrigger><SelectContent>{(config.release_channels || []).map(x=><SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent></Select></div>
                <div className="flex items-end gap-2"><Button onClick={() => saveVersion(v, !editingVersion)}><Save size={14} className="mr-1"/>Save</Button>{editingVersion && <Button variant="outline" onClick={()=>setEditingVersion(null)}>Cancel</Button>}</div>
              </div>;
            })()}
          </div>
          <TableSortControls columns={VERSION_COLUMNS} sort={versionSort} setSort={setVersionSort} defaultSort={{ key: "name", direction: "desc" }} className="mb-3" />
          <div className="bg-card border rounded-xl max-w-full overflow-x-auto overscroll-x-contain"><table className="w-full min-w-[820px] text-sm">
            <thead className="bg-[var(--paper)] text-left"><tr>{VERSION_COLUMNS.map((column) => <SortableTableHeader key={column.key} column={column} sort={versionSort} onSort={(key) => setVersionSort((current) => nextSort(current, key))} />)}<th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{sortTableRows(versions, VERSION_COLUMNS, versionSort, ["release_number", "name"]).map((v) => <tr key={v.id} className="border-t"><td className="px-4 py-2 font-semibold text-[var(--navy)]">{v.name}</td><td className="px-4 py-2">{v.release_number}</td><td className="px-4 py-2">{v.version_type || "—"}</td><td className="px-4 py-2">{v.release_channel || "—"}</td><td className="px-4 py-2">{v.release_date || "—"}</td><td className="px-4 py-2">{v.environment}</td><td className="px-4 py-2">{v.active ? "Yes" : "No"}</td><td className="px-4 py-2"><div className="flex gap-1"><Button size="sm" variant="outline" onClick={()=>setEditingVersion({...v})} aria-label={`Edit ${v.name}`}><Pencil size={14}/></Button><Button size="sm" variant="outline" onClick={()=>deleteVersion(v)} aria-label={`Delete ${v.name}`}><Trash2 size={14}/></Button></div></td></tr>)}</tbody>
          </table></div>
        </TabsContent>

        <TabsContent value="users">
          {me?.role === "admin" && <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="font-display font-semibold text-[var(--navy)]">Users & Roles</h2>
              <p className="text-xs text-muted-foreground">Create accounts with a one-time password setup link.</p>
            </div>
            <Button onClick={() => { setAddingUser(true); setActivationPath(""); setWelcomeEmailResult(null); }} data-testid="add-user-btn" aria-label="Add user">
              <Plus size={15} /> Add User
            </Button>
          </div>}
          {activationPath && <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4" role="status" aria-live="polite">
            <h3 className="font-semibold text-amber-900">One-time setup link — copy it now</h3>
            <p className="text-xs text-amber-800 mt-1">This link is shown only once. It expires in 24 hours and cannot be recovered after leaving this page.</p>
            <div className="flex gap-2 items-center mt-3">
              <code className="text-xs bg-white border rounded px-2 py-2 break-all flex-1">{window.location.origin}{activationPath}</code>
              <Button type="button" size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}${activationPath}`); setCopiedActivation(true); }} aria-label="Copy one-time setup link">
                {copiedActivation ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>
          </div>}
          {welcomeEmailResult && <div className={`rounded-xl border p-3 mb-4 text-sm ${welcomeEmailResult.sent ? "border-green-200 bg-green-50 text-green-900" : welcomeEmailResult.requested ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-700"}`} role={welcomeEmailResult.sent ? "status" : "alert"} aria-live="polite">
            <strong>{welcomeEmailResult.sent ? "Welcome email sent." : welcomeEmailResult.requested ? "Account created, but the welcome email was not sent." : "Account created without sending a welcome email."}</strong>
            {!welcomeEmailResult.sent && welcomeEmailResult.message && <span> {welcomeEmailResult.message}</span>}
          </div>}
          {addingUser && <form onSubmit={createUser} className="bg-card border rounded-xl p-4 mb-4 space-y-3" aria-labelledby="add-user-heading">
            <div className="flex items-center justify-between">
              <h3 id="add-user-heading" className="font-semibold text-[var(--navy)]">Add User</h3>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAddingUser(false)} aria-label="Cancel add user"><X size={16} /></Button>
            </div>
             <div className="grid md:grid-cols-4 gap-3">
              <div><Label htmlFor="new-user-name">Name</Label><Input id="new-user-name" value={newUser.name} onChange={(e) => setNewUser({...newUser, name: e.target.value})} required /></div>
              <div><Label htmlFor="new-user-email">Email</Label><Input id="new-user-email" type="email" autoComplete="email" value={newUser.email} onChange={(e) => setNewUser({...newUser, email: e.target.value})} required /></div>
              <div><Label htmlFor="new-user-role">Role</Label><select id="new-user-role" value={newUser.role} onChange={(e) => setNewUser({...newUser, role: e.target.value})} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" required>{ROLES.map((role) => <option key={role} value={role}>{userRoleLabel(role)}</option>)}</select></div>
              <label htmlFor="new-user-active" className="flex items-center gap-2 pt-6 text-sm"><input id="new-user-active" type="checkbox" checked={newUser.active} onChange={(e) => setNewUser({...newUser, active: e.target.checked})} /> Active now</label>
               <div className="md:col-span-4 rounded-lg border border-[var(--orange)]/30 bg-[var(--paper)]/60 p-3">
                 <label htmlFor="new-user-welcome-email" aria-describedby="new-user-welcome-email-help" className="flex items-start gap-2 text-sm font-semibold text-[var(--navy)]">
                   <input id="new-user-welcome-email" type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={welcomeEmailReady && newUser.send_welcome_email !== false} disabled={!welcomeEmailReady} onChange={(e) => setNewUser({...newUser, send_welcome_email: e.target.checked})} />
                   <span>Send welcome email with secure setup link</span>
                 </label>
                 <p id="new-user-welcome-email-help" className="ml-6 mt-1 text-xs text-muted-foreground">{welcomeEmailReady ? "The recipient will receive a single-use link valid for 24 hours and will create their own password." : "Email delivery is unavailable. Create the user, then copy and share the one-time setup link securely."}</p>
               </div>
            </div>
            <div className="flex gap-2"><Button type="submit"><Plus size={14} /> Create user</Button><Button type="button" variant="outline" onClick={() => setAddingUser(false)}>Cancel</Button></div>
          </form>}
          {editingUser && <form onSubmit={saveUser} noValidate className="bg-card border rounded-xl p-4 mb-4" aria-labelledby="edit-user-heading">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 id="edit-user-heading" className="font-semibold text-[var(--navy)]">Edit User: {editingUser.name}</h3>
              <StatusBadge value={editingUser.active === false ? "Inactive" : "Active"} definitions={ACTIVITY_STATUSES} />
            </div>
            {userSaveError && <div id="edit-user-error" role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{userSaveError}</div>}
            {userSaveSuccess && <div role="status" className="mb-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{userSaveSuccess}</div>}
             {userConflict && <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <p className="font-semibold">Someone else saved this user first. Your entries are still open for review.</p>
               <div className="mt-2 flex gap-2"><Button type="button" size="sm" variant="outline" onClick={() => { setEditingUser(userConflict); setUserConflict(null); }}>Load latest values</Button><Button type="button" size="sm" onClick={() => { setEditingUser((draft) => ({ ...draft, expected_revision: userConflict.revision, expected_updated_at: userConflict.updated_at })); setUserConflict(null); }}>Keep my entries and reapply</Button></div>
            </div>}
            <div className="grid md:grid-cols-4 gap-3">
              <div><Label htmlFor="edit-user-name">Name</Label><Input id="edit-user-name" autoComplete="name" required disabled={userSaving} value={editingUser.name} onChange={e=>setEditingUser({...editingUser,name:e.target.value})}/></div>
              <div><Label htmlFor="edit-user-email">Email</Label><Input id="edit-user-email" type="email" autoComplete="email" required disabled={userSaving} aria-describedby={userSaveError ? "edit-user-error" : undefined} value={editingUser.email} onChange={e=>setEditingUser({...editingUser,email:e.target.value})}/></div>
              <div><Label htmlFor="edit-user-role">Role</Label><Select value={editingUser.role} onValueChange={role=>setEditingUser({...editingUser,role})} disabled={userSaving}><SelectTrigger id="edit-user-role" aria-label="Edit user role"><SelectValue>{userRoleLabel(editingUser.role)}</SelectValue></SelectTrigger><SelectContent>{ROLES.map(r=><SelectItem key={r} value={r}>{userRoleLabel(r)}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              <Button type="submit" disabled={userSaving}><Save size={14} className="mr-1"/>{userSaving ? "Saving…" : "Save"}</Button>
              <Button type="button" variant="outline" disabled={userSaving} onClick={()=>{ setUserConflict(null); setUserSaveError(""); setUserSaveSuccess(""); setEditingUser(null); }}>Cancel</Button>
              {editingUser.active === false
                ? <Button type="button" variant="outline" disabled={userSaving} onClick={() => toggleUser(editingUser)}><UserCheck size={14} /> Reactivate user</Button>
                : <Button type="button" variant="outline" disabled={userSaving || !!userActionBlock(editingUser, "deactivate")} title={userActionBlock(editingUser, "deactivate")} onClick={() => toggleUser(editingUser)}><UserX size={14} /> Deactivate user</Button>}
              {editingUser.active === false && <Button type="button" variant="destructive" disabled={userSaving || editingUser.id === me?.id} title={editingUser.id === me?.id ? userActionBlock(editingUser, "delete") : undefined} onClick={() => deleteUser(editingUser)}><Trash2 size={14} /> Delete permanently</Button>}
            </div>
          </form>}
          <div className="flex flex-wrap items-center gap-2 mb-3" aria-label="Filter users by status">
            <span className="text-sm font-medium">Show:</span>
            {[["active", "Active"], ["inactive", "Inactive"], ["all", "All"]].map(([value, label]) => (
              <Button key={value} size="sm" variant={userStatusFilter === value ? "default" : "outline"} aria-pressed={userStatusFilter === value} onClick={() => setUserStatusFilter(value)}>{label}</Button>
            ))}
          </div>
          <TableSortControls columns={USER_COLUMNS} sort={userSort} setSort={setUserSort} defaultSort={{ key: "name", direction: "asc" }} className="mb-3" />
          <div className="bg-card border rounded-xl max-w-full overflow-x-auto overscroll-x-contain"><table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[var(--paper)] text-left"><tr>{USER_COLUMNS.map((column) => <SortableTableHeader key={column.key} column={column} sort={userSort} onSort={(key) => setUserSort((current) => nextSort(current, key))} />)}<th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{sortTableRows(shownUsers, USER_COLUMNS, userSort, ["name", "email"]).map((u) => (
              <tr key={u.id} className="border-t">
                <td className="px-4 py-2 font-semibold text-[var(--navy)]">{u.name}</td>
                <td className="px-4 py-2">{u.email}</td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{u.password_login_ready ? "Password set — send reset link" : u.welcome_email_status === "sent" ? "Invite sent" : u.welcome_email_status === "failed" ? "Invite failed" : u.welcome_email_status === "blocked" ? "Invite blocked" : "Password setup required"}</td>
                <td className="px-4 py-2">{userRoleLabel(u.role)}</td>
                <td className="px-4 py-2"><StatusBadge value={u.active === false ? "Inactive" : "Active"} definitions={ACTIVITY_STATUSES} compact /></td>
                <td className="px-4 py-2"><div className="flex flex-wrap gap-1">
                   <Button type="button" size="sm" variant="outline" onClick={()=>{ setUserConflict(null); setUserSaveError(""); setUserSaveSuccess(""); setEditingUser({...u}); }} aria-label={`Edit ${u.name}`}><Pencil size={14}/> Edit</Button>
                   {u.active !== false && !u.deleted_at && <Button size="sm" variant="outline" disabled={passwordResetBusy === u.id} onClick={()=>sendPasswordReset(u)} aria-label={`Send password reset link to ${u.name}`} title="Email a one-hour, single-use password reset link"><Mail size={14}/> {passwordResetBusy === u.id ? "Sending…" : "Send reset link"}</Button>}
                  {u.active === false
                    ? <Button size="sm" variant="outline" onClick={()=>toggleUser(u)} aria-label={`Reactivate ${u.name}`}><UserCheck size={14}/> Reactivate</Button>
                    : <Button size="sm" variant="outline" disabled={!!userActionBlock(u, "deactivate")} title={userActionBlock(u, "deactivate")} onClick={()=>toggleUser(u)} aria-label={`Deactivate ${u.name}`}><UserX size={14}/> Deactivate</Button>}
                  {!u.password_login_ready && u.active !== false && !u.deleted_at && <Button size="sm" variant="outline" disabled={welcomeEmailBusy === u.id} onClick={()=>resendWelcomeEmail(u)} aria-label={`Resend welcome email to ${u.name}`} title="Resend the 24-hour setup link"><RefreshCw size={14}/> {welcomeEmailBusy === u.id ? "Sending…" : "Resend invite"}</Button>}
                  {u.active === false && <Button size="sm" variant="destructive" disabled={u.id === me?.id} title={u.id === me?.id ? userActionBlock(u, "delete") : undefined} onClick={()=>deleteUser(u)} aria-label={`Delete ${u.name} permanently`}><Trash2 size={14}/> Delete permanently</Button>}
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="text-xs text-muted-foreground mt-2">Deactivate users before deletion. Deletion removes login access while preserving linked QA history and audit records.</p>
           {passwordResetResult && <div className={`rounded-xl border p-3 mb-3 text-sm ${passwordResetResult.email?.sent ? "border-green-200 bg-green-50 text-green-900" : "border-amber-200 bg-amber-50 text-amber-900"}`} role={passwordResetResult.email?.sent ? "status" : "alert"} aria-live="polite">
             <strong>{passwordResetResult.email?.sent ? "Password reset email sent." : "Reset link created, but the email was not sent."}</strong>
             <p className="mt-1 text-xs">This one-hour link is shown only once. Share it securely with {passwordResetResult.user.email}.</p>
             <div className="flex gap-2 items-center mt-2">
               <code className="text-xs bg-white border rounded px-2 py-2 break-all flex-1">{window.location.origin}{passwordResetResult.path}</code>
               <Button type="button" size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}${passwordResetResult.path}`); setCopiedReset(true); }} aria-label="Copy one-time password reset link">
                 {copiedReset ? <Check size={14} /> : <Copy size={14} />}
               </Button>
             </div>
             {passwordResetResult.email?.message && <p className="mt-1 text-xs">{passwordResetResult.email.message}</p>}
           </div>}
          <div className="mt-3 flex items-start gap-2 rounded-lg border bg-card p-3 text-xs" role="status" aria-live="polite">
            <Mail size={14} className="mt-0.5 shrink-0 text-[var(--orange)]" />
            <span>Welcome email delivery: <strong>{emailStatus?.status === "connected" ? "Connected" : emailStatus?.status === "disconnected" ? "Unavailable" : "Checking…"}</strong>.{emailStatus && !emailStatus.published_url_configured && " Configure the published app URL before sending invites."}</span>
          </div>
        </TabsContent>

        <TabsContent value="integrations">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-card border rounded-xl p-5 space-y-4">
              <h3 className="font-semibold font-display text-[var(--navy)] flex items-center gap-2"><Plug size={16} /> Bassett API (live runs)</h3>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground">API Endpoint URL</Label>
                <Input data-testid="bassett-url-input" value={cfgInteg.bassett_api_url || ""} onChange={(e) => setInteg({ ...cfgInteg, bassett_api_url: e.target.value })} placeholder="https://api.zoneomics.com/v2/ask" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground">API Key {config.integrations?.bassett_api_key_set && <span className="text-green-700">· configured</span>}</Label>
                <Input data-testid="bassett-key-input" type="password" value={cfgInteg.bassett_api_key || ""} onChange={(e) => setInteg({ ...cfgInteg, bassett_api_key: e.target.value })} placeholder={config.integrations?.bassett_api_key_set ? "•••••••• (leave blank to keep)" : "Paste Bassett API key"} />
              </div>
            </div>
            <div className="bg-card border rounded-xl p-5 space-y-4">
              <h3 className="font-semibold font-display text-[var(--navy)]">Benchmark Models</h3>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground">ChatGPT model</Label>
                <Input data-testid="chatgpt-model-input" value={cfgInteg.chatgpt_model || ""} onChange={(e) => setInteg({ ...cfgInteg, chatgpt_model: e.target.value })} placeholder="gpt-5.4" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground">Claude model</Label>
                <Input data-testid="claude-model-input" value={cfgInteg.claude_model || ""} onChange={(e) => setInteg({ ...cfgInteg, claude_model: e.target.value })} placeholder="claude-sonnet-4-6" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold text-muted-foreground">AI assist model (pre-scoring & claim extraction)</Label>
                <Input data-testid="ai-assist-model-input" value={cfgInteg.ai_assist_model || ""} onChange={(e) => setInteg({ ...cfgInteg, ai_assist_model: e.target.value })} placeholder="gpt-5.4" />
              </div>
              <p className="text-xs text-muted-foreground">AI benchmark runs, pre-scoring, and claim extraction remain unavailable until a supported provider is configured.</p>
            </div>
          </div>
          <div className="mt-4">
            <Button data-testid="save-integrations-btn" disabled={!integ} onClick={saveIntegrations} className="bg-[var(--orange)] hover:bg-[var(--orange-600)]">Save Integration Settings</Button>
          </div>
        </TabsContent>
      </Tabs>
      <ConfirmActionDialog
        open={!!confirmation}
        onOpenChange={(open) => !open && setConfirmingAction(null)}
         title={confirmation?.type === "deactivate" ? `Deactivate ${confirmation.user.name}?` : confirmation?.type === "reactivate" ? `Reactivate ${confirmation.user.name}?` : confirmation?.type === "delete-user" ? `Delete ${confirmation.user.name}?` : confirmation?.type === "resend-welcome" ? `Resend welcome email to ${confirmation.user.name}?` : confirmation?.type === "password-reset" ? `Send password reset link to ${confirmation.user.name}?` : `Delete ${confirmation?.version?.name || "Bassett version"}?`}
        description={confirmation?.type === "deactivate"
          ? "Deactivation prevents future sign-ins and revokes this user’s active sessions. Historical ownership, assignments, evaluations, findings, and audit records will be preserved."
          : confirmation?.type === "reactivate"
            ? "This user will be able to sign in and receive new assignments again. Their historical records have remained unchanged."
          : confirmation?.type === "delete-user"
            ? confirmation.message
          : confirmation?.type === "resend-welcome"
            ? "This invalidates the previous setup link and emails a new single-use link that expires in 24 hours."
           : confirmation?.type === "password-reset"
             ? "This emails a single-use password reset link that expires in one hour. The user creates their own password; administrators never see it."
            : "This is allowed only when the Bassett version is not referenced by historical evaluations or regression runs."}
         confirmLabel={confirmation?.type === "deactivate" ? "Deactivate user" : confirmation?.type === "reactivate" ? "Reactivate user" : confirmation?.type === "resend-welcome" ? "Resend welcome email" : confirmation?.type === "password-reset" ? "Send reset link" : "Delete permanently"}
         destructive={confirmation?.type !== "reactivate" && confirmation?.type !== "resend-welcome" && confirmation?.type !== "password-reset"}
         busy={userActionBusy || welcomeEmailBusy === confirmation?.user?.id || passwordResetBusy === confirmation?.user?.id}
        onConfirm={() => {
          if (confirmation?.type === "deactivate" || confirmation?.type === "reactivate") performToggleUser(confirmation.user);
          else if (confirmation?.type === "delete-user") performDeleteUser(confirmation.user);
          else if (confirmation?.type === "resend-welcome") performResendWelcomeEmail(confirmation.user);
          else if (confirmation?.type === "password-reset") performPasswordReset(confirmation.user);
          else if (confirmation?.type === "delete-version") performDeleteVersion(confirmation.version);
        }}
      />
    </div>
  );
}

