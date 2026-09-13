import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/index.css";
import App from "@/App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Mutable records and analytical responses are stale immediately.
      // Individual shared lookup hooks opt into bounded reuse.
      staleTime: 0,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnMount: true,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
