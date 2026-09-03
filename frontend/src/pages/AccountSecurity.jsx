import { useState } from "react";
import { api, formatApiErrorDetail } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

function PasswordField({ id, label, value, onChange, autoComplete, describedBy }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} type={visible ? "text" : "password"} autoComplete={autoComplete}
          value={value} onChange={(event) => onChange(event.target.value)} required
          aria-required="true" aria-describedby={describedBy} />
        <Button type="button" variant="outline" size="icon" onClick={() => setVisible((current) => !current)}
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`} aria-pressed={visible}>
          {visible ? "Hide" : "Show"}
        </Button>
      </div>
    </div>
  );
}

export default function AccountSecurity() {
  const { setSession } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (newPassword.length < 12 || newPassword.length > 128) {
      setError("New password must be between 12 and 128 characters.");
      return;
    }
    if (newPassword !== confirmation) {
      setError("New passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post("/auth/password/change", {
        current_password: currentPassword,
        new_password: newPassword,
        new_password_confirmation: confirmation,
      });
      setSession(data.user);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setSuccess("Password changed. All other sessions were signed out.");
    } catch (err) {
      setError(formatApiErrorDetail(err.response?.data?.detail) || "Unable to change your password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="max-w-xl" aria-labelledby="security-heading">
      <div className="mb-6">
        <h1 id="security-heading" className="font-display font-bold text-2xl text-[var(--navy)]">Security</h1>
        <p className="text-sm text-muted-foreground mt-1">Change your password and sign out other sessions.</p>
      </div>
      <form onSubmit={submit} noValidate aria-busy={busy} className="bg-card border rounded-xl p-5 space-y-4">
        <PasswordField id="current-password" label="Current password" value={currentPassword}
          onChange={setCurrentPassword} autoComplete="current-password" describedBy={error ? "password-error" : undefined} />
        <PasswordField id="new-password" label="New password" value={newPassword}
          onChange={setNewPassword} autoComplete="new-password" describedBy="password-help" />
        <p id="password-help" className="text-xs text-muted-foreground">Use 12–128 characters. Recently used passwords are not accepted.</p>
        <PasswordField id="confirm-new-password" label="Confirm new password" value={confirmation}
          onChange={setConfirmation} autoComplete="new-password" describedBy={error ? "password-error" : undefined} />
        {error && <p id="password-error" role="alert" aria-live="assertive" className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">{error}</p>}
        {success && <p role="status" aria-live="polite" className="text-sm text-green-800 bg-green-50 rounded-lg px-3 py-2">{success}</p>}
        <Button type="submit" disabled={busy} className="bg-[var(--orange)] hover:bg-[var(--orange-600)]">
          {busy ? "Changing password…" : "Change password"}
        </Button>
      </form>
    </section>
  );
}
