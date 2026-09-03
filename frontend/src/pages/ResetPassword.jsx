import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, formatApiErrorDetail } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

function PasswordField({ id, label, value, onChange }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} type={visible ? "text" : "password"} autoComplete="new-password"
          value={value} onChange={(event) => onChange(event.target.value)} required aria-required="true" />
        <Button type="button" variant="outline" size="icon" onClick={() => setVisible((current) => !current)}
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`} aria-pressed={visible}>
          {visible ? "Hide" : "Show"}
        </Button>
      </div>
    </div>
  );
}

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (!token) return setError("This password reset link is missing its token.");
    if (password.length < 12 || password.length > 128) {
      return setError("Password must be between 12 and 128 characters.");
    }
    if (password !== confirmation) return setError("New passwords do not match.");
    setBusy(true);
    try {
      await api.post("/auth/reset-password", {
        token,
        new_password: password,
        new_password_confirmation: confirmation,
      });
      setDone(true);
      setPassword("");
      setConfirmation("");
    } catch (err) {
      setError(formatApiErrorDetail(err.response?.data?.detail) || "This password reset link is invalid, expired, or already used.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-[var(--paper)]">
      <section className="w-full max-w-md bg-card border rounded-xl p-6">
        {done ? (
          <div role="status" aria-live="polite" className="space-y-3">
            <h1 className="font-display font-bold text-2xl text-[var(--navy)]">Password reset</h1>
            <p className="text-sm text-muted-foreground">Your password was reset. You can now sign in. Other sessions were signed out.</p>
            <Link className="text-sm text-primary underline" to="/login">Go to sign in</Link>
          </div>
        ) : (
          <form onSubmit={submit} noValidate aria-busy={busy} className="space-y-5">
            <div>
              <h1 className="font-display font-bold text-2xl text-[var(--navy)]">Create a new password</h1>
              <p className="text-sm text-muted-foreground mt-1">This secure link works once and expires after one hour.</p>
            </div>
            <PasswordField id="reset-password" label="New password" value={password} onChange={setPassword} />
            <p className="text-xs text-muted-foreground">Use 12–128 characters.</p>
            <PasswordField id="reset-password-confirmation" label="Confirm new password" value={confirmation} onChange={setConfirmation} />
            {error && <p id="reset-password-error" role="alert" aria-live="assertive" className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">{error}</p>}
            <Button data-testid="reset-password-submit" type="submit" disabled={busy} className="w-full bg-[var(--orange)] hover:bg-[var(--orange-600)]">
              {busy ? "Resetting password…" : "Reset password"}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}