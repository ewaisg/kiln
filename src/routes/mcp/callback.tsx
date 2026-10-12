import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { completeMcpOAuth } from "@/lib/mcp-oauth";
export const Route = createFileRoute("/mcp/callback")({ component: Callback });
function Callback() {
  const [error, setError] = useState(""); const started = useRef(false); const navigate = useNavigate();
  useEffect(() => {
    if (started.current) return; started.current = true;
    const search = window.location.search;
    window.history.replaceState(null, "", window.location.pathname);
    void completeMcpOAuth(search).then(() => navigate({ to: "/" })).catch(error => setError(error instanceof Error ? error.message : "Authorization failed."));
  }, [navigate]);
  return <main className="flex min-h-screen items-center justify-center bg-canvas p-6 text-ink"><section className="max-w-lg rounded-xl border border-line p-6">
    <h1 className="text-xl font-medium">{error ? "Connection authorization failed" : "Completing secure authorization…"}</h1>
    <p className="mt-3 text-sm text-muted">{error || "Your authorization code is being exchanged using PKCE."}</p>
    {error ? <button type="button" className="mt-4 h-11 rounded-md bg-accent px-4 text-accent-ink" onClick={() => void navigate({ to: "/" })}>Return to Kiln</button> : null}
  </section></main>;
}
