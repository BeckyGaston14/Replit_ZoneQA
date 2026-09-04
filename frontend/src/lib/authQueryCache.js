import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./auth";

export function AuthQueryCacheBoundary({ children }) {
  const { user } = useAuth() || {};
  const queryClient = useQueryClient();
  const userId = user?.id || null;
  const [preparedUserId, setPreparedUserId] = useState(undefined);

  useEffect(() => {
    if (preparedUserId === userId) return;
    if (preparedUserId !== undefined) queryClient.clear();
    setPreparedUserId(userId);
  }, [preparedUserId, queryClient, userId]);

  if (preparedUserId !== userId) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground" role="status" aria-live="polite">Preparing secure session…</div>;
  }
  return children;
}