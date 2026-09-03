import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { formatApiErrorDetail } from "../lib/api";
import { toast } from "sonner";

function safeRedirectPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\\")) return "/";
  try {
    const target = new URL(path, window.location.origin);
    if (target.origin !== window.location.origin) return "/";
    if (target.pathname === "/login" || target.pathname === "/activate") return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

export { safeRedirectPath };

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr("");
    try {
      await login(email, password);
      toast.success("Welcome back");
      nav(safeRedirectPath(location.state?.from), { replace: true });
    } catch (e2) {
      setErr(
        e2.response?.status === 503
          ? "The server is still starting. Please wait a moment and try signing in again."
          : formatApiErrorDetail(e2.response?.data?.detail) || "Sign in failed. Check your email and password."
      );
    }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex flex-col justify-between w-[46%] brand-gradient text-white p-12">
        <div className="flex items-center gap-3">
          <div className="accent-gradient h-11 w-11 rounded-xl flex items-center justify-center font-bold font-display text-lg">Z</div>
          <div className="font-display font-bold text-xl">ZoneQA <span className="text-white/60 font-normal">· Bassett Testing</span></div>
        </div>
        <div>
          <h1 className="font-display font-extrabold text-4xl leading-tight">The system of record for<br /><span className="text-[var(--orange)]">Bassett</span> zoning-AI quality.</h1>
          <p className="mt-4 text-white/70 max-w-md">Systematically test how Bassett answers real-world zoning, land-use and due-diligence questions — benchmarked against ChatGPT and Claude, evaluated against authoritative Gold Standards.</p>
        </div>
        <div className="text-white/40 text-xs">Internal Zoneomics application · Authorized access only</div>
      </div>
      <div className="flex-1 flex items-center justify-center p-8 bg-[var(--paper)]">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5" aria-busy={busy}>
          <div>
            <h2 className="font-display font-bold text-2xl text-[var(--navy)]">Sign in</h2>
            <p className="text-sm text-muted-foreground mt-1">Access the Bassett QA platform</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input id="login-email" data-testid="login-email" value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required aria-required="true" aria-invalid={Boolean(err)} aria-describedby={err ? "login-error" : undefined} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input id="login-password" data-testid="login-password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required aria-required="true" aria-invalid={Boolean(err)} aria-describedby={err ? "login-error" : undefined} />
          </div>
          {err && <div id="login-error" data-testid="login-error" role="alert" aria-live="assertive" className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">{err}</div>}
          <Button data-testid="login-submit" disabled={busy} className="w-full bg-[var(--orange)] hover:bg-[var(--orange-600)] h-11">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
          {busy && <span role="status" aria-live="polite" className="sr-only">Signing in…</span>}
          <a href="/forgot-password" className="block text-center text-sm text-primary underline">Forgot password?</a>
          <p className="text-xs text-muted-foreground text-center">Use your authorized ZoneQA account. Contact an administrator if you need access.</p>
        </form>
      </div>
    </div>
  );
}
