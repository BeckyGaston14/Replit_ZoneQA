import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, formatApiErrorDetail } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export default function ActivateUser() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (!token) return setError("This activation link is missing its setup token.");
    if (password.length < 12) return setError("Password must be at least 12 characters.");
    if (password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    try {
      const { data } = await api.post("/auth/activate", { token, password });
      setDone(data);
      if (data.activated) setTimeout(() => nav("/"), 900);
    } catch (err) {
      setError(formatApiErrorDetail(err.response?.data?.detail) || "Activation failed.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6 bg-[var(--paper)]">
        <section className="w-full max-w-md bg-card border rounded-xl p-6 space-y-3" role="status" aria-live="polite">
          <h1 className="font-display font-bold text-2xl text-[var(--navy)]">
            Password set successfully
          </h1>
          <p className="text-sm text-muted-foreground">
            {done.activated
              ? "Your account is active. Taking you to ZoneQA…"
              : "Your password is set, but this account is inactive. Ask an administrator to reactivate it before signing in."}
          </p>
          {!done.activated && <Button onClick={() => nav("/login")}>Go to sign in</Button>}
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-[var(--paper)]">
      <form onSubmit={submit} className="w-full max-w-md bg-card border rounded-xl p-6 space-y-5" noValidate aria-busy={busy}>
        <input type="text" name="username" autoComplete="username" value="zoneqa-activation"
          readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
        <div>
          <h1 className="font-display font-bold text-2xl text-[var(--navy)]">Set up your account</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Create a private password to finish activating your ZoneQA account.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="activation-password">Password</Label>
          <Input id="activation-password" type="password" autoComplete="new-password" minLength={12}
            value={password} onChange={(e) => setPassword(e.target.value)} required aria-required="true" aria-invalid={Boolean(error)} aria-describedby={error ? "activation-error" : "activation-password-help"} />
          <p id="activation-password-help" className="text-xs text-muted-foreground">Use at least 12 characters.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="activation-confirm">Confirm password</Label>
          <Input id="activation-confirm" type="password" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} required aria-required="true" aria-invalid={Boolean(error)} aria-describedby={error ? "activation-error" : undefined} />
        </div>
        {error && <p id="activation-error" className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2" role="alert" aria-live="assertive">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full bg-[var(--orange)] hover:bg-[var(--orange-600)]">
          {busy ? "Setting password…" : "Set password"}
        </Button>
        {busy && <span role="status" aria-live="polite" className="sr-only">Setting password…</span>}
      </form>
    </main>
  );
}