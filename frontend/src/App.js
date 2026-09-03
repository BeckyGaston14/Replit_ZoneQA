import "@/App.css";
import "@/index.css";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";
import Layout from "@/components/Layout";
import Login from "@/pages/Login";
import ActivateUser from "@/pages/ActivateUser";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import { APP_ROUTES } from "@/lib/routeConfig";

export function Protected({ children, roles }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground" role="status" aria-live="polite">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}${location.hash}` }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
}

export function ConfiguredRoute({ route }) {
  const location = useLocation();
  if (!route.forceSearch) {
    const Component = route.component;
    return <Component />;
  }
  const params = new URLSearchParams(location.search);
  const missing = Object.entries(route.forceSearch).some(([key, value]) => params.get(key) !== value);
  if (missing) {
    Object.entries(route.forceSearch).forEach(([key, value]) => params.set(key, value));
    return <Navigate to={{ pathname: location.pathname, search: `?${params.toString()}`, hash: location.hash }} replace />;
  }
  const Component = route.component;
  return <Component />;
}

function FallbackRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: "/", search: location.search, hash: location.hash }} replace />;
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/activate" element={<ActivateUser />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      {APP_ROUTES.map((route) => (
        <Route key={route.path} path={route.path} element={<Protected roles={route.roles}><ConfiguredRoute route={route} /></Protected>} />
      ))}
      <Route path="*" element={<FallbackRedirect />} />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster position="top-right" richColors />
        <AppRouter />
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
