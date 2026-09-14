import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, isDefinitiveAuthFailure } from "./api";

const AuthCtx = createContext(null);
export const AUTH_EXPIRED_EVENT = "zoneqa:auth-expired";
export const AUTH_BOOTSTRAP_RETRIES = 2;
export const AUTH_BOOTSTRAP_RETRY_DELAY_MS = 250;
export const useAuth = () => useContext(AuthCtx);
let authBootstrapRequest = null;

function sharedSessionCheck() {
  if (!authBootstrapRequest) {
    authBootstrapRequest = api.get("/auth/me").finally(() => {
      authBootstrapRequest = null;
    });
  }
  return authBootstrapRequest;
}

export function AuthProvider({ children, bootstrapRetries = AUTH_BOOTSTRAP_RETRIES }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const bootstrapRetryLimit = useRef(bootstrapRetries);
  const sessionGeneration = useRef(0);

  useEffect(() => {
    let disposed = false;
    let retryTimer;
    const bootstrapGeneration = sessionGeneration.current;

    const bootstrap = async (attempt = 0) => {
      try {
        const response = await sharedSessionCheck();
        if (!disposed && sessionGeneration.current === bootstrapGeneration) {
          setUser(response.data);
          setRetrying(false);
          setLoading(false);
        }
      } catch (error) {
        if (disposed || sessionGeneration.current !== bootstrapGeneration) return;
        if (isDefinitiveAuthFailure(error)) {
          setUser(null);
          setRetrying(false);
          setLoading(false);
          return;
        }
        if (attempt < bootstrapRetryLimit.current) {
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
      sessionGeneration.current += 1;
      setUser(null);
      setRetrying(false);
      setLoading(false);
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpired);
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post("/auth/login", { email, password });
    sessionGeneration.current += 1;
    setUser(data.user);
    setRetrying(false);
    setLoading(false);
    return data.user;
  };

  const logout = async () => {
    try { await api.post("/auth/logout"); } catch (e) {}
    sessionGeneration.current += 1;
    setUser(null);
  };

  return <AuthCtx.Provider value={{ user, loading, retrying, login, logout, setSession: setUser }}>{children}</AuthCtx.Provider>;
}
