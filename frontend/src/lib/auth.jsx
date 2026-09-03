import { createContext, useContext, useEffect, useState } from "react";
import { api, isDefinitiveAuthFailure } from "./api";

const AuthCtx = createContext(null);
export const AUTH_EXPIRED_EVENT = "zoneqa:auth-expired";
export const AUTH_BOOTSTRAP_RETRIES = 2;
export const AUTH_BOOTSTRAP_RETRY_DELAY_MS = 250;
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let disposed = false;
    let retryTimer;

    const bootstrap = async (attempt = 0) => {
      try {
        const response = await api.get("/auth/me");
        if (!disposed) {
          setUser(response.data);
          setRetrying(false);
          setLoading(false);
        }
      } catch (error) {
        if (disposed) return;
        if (isDefinitiveAuthFailure(error)) {
          setUser(null);
          setRetrying(false);
          setLoading(false);
          return;
        }
        if (attempt < AUTH_BOOTSTRAP_RETRIES) {
          setRetrying(true);
          retryTimer = window.setTimeout(
            () => bootstrap(attempt + 1),
            AUTH_BOOTSTRAP_RETRY_DELAY_MS * (attempt + 1),
          );
          return;
        }
        // An unavailable API does not prove the opaque cookie is invalid.
        // Preserve an already established user, and clear retry bookkeeping.
        setRetrying(false);
        setLoading(false);
      }
    };

    bootstrap();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    const handleExpired = () => {
      setUser(null);
      setRetrying(false);
      setLoading(false);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpired);
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post("/auth/login", { email, password });
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    try { await api.post("/auth/logout"); } catch (e) {}
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, loading, retrying, login, logout, setSession: setUser }}>{children}</AuthCtx.Provider>;
}
