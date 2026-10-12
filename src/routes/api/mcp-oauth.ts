import { createFileRoute } from "@tanstack/react-router";
import { sameSite } from "@/lib/relay";
import { relayMcpOAuth } from "@/lib/mcp-oauth.server";
export const Route = createFileRoute("/api/mcp-oauth")({ server: { handlers: { POST: async ({ request }) => {
  if (!sameSite(request)) return Response.json({ error: "Cross-origin blocked." }, { status: 403 });
  try { return await relayMcpOAuth(await request.text(), request.signal); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message.slice(0, 500) : "OAuth failed." }, { status: 400, headers: { "cache-control": "no-store" } }); }
} } } });
