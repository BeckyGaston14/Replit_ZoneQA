import { useState } from "react";
import { Link } from "react-router-dom";
import { api, formatApiErrorDetail } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api.post("/auth/forgot-password", { email });
      setSent(true);
    } catch (err) {
      setError(formatApiErrorDetail(err.response?.data?.detail) || "Unable to process that request.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-[var(--paper)]">
      <section className="w-full max-w-md bg-card border rounded-xl p-6">
        {sent ? (
          <div role="status" aria-live="polite" className="space-y-3">
            <h1 className="font-display font-bold text-2xl text-[var(--navy)]">Check your email</h1>
            <p className="text-sm text-muted-foreground">If an account matches that email, a password reset link has been sent. The link expires in one hour.</p>
            <Link className="text-sm text-primary underline" to="/login">Return to sign in</Link>
          </div>
        ) : (
          <form onSubmit={submit} noValidate aria-busy={busy} className="space-y-5">
            <div>
              <h1 className="font-display font-bold text-2xl text-[var(--navy)]">Forgot password?</h1>
              <p className="text-sm text-muted-foreground mt-1">Enter your account email and we’ll send a secure reset link.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="forgot-password-email">Email</Label>
              <Input id="forgot-password-email" data-testid="forgot-password-email" type="email" autoComplete="email"
                value={email} onChange={(event) => setEmail(event.target.value)} required aria-required="true"
                aria-invalid={Boolean(error)} aria-describedby={error ? "forgot-password-error" : undefined} />
            </div>
            {error && <p id="forgot-password-error" role="alert" aria-live="assertive" className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">{error}</p>}
            <Button data-testid="forgot-password-submit" type="submit" disabled={busy} className="w-full bg-[var(--orange)] hover:bg-[var(--orange-600)]">
              {busy ? "Sending…" : "Send reset link"}
            </Button>
            <Link className="block text-center text-sm text-primary underline" to="/login">Return to sign in</Link>
          </form>
        )}
      </section>
    </main>
  );
}