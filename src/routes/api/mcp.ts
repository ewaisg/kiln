import { createFileRoute } from "@tanstack/react-router";
import { relayMcp } from "@/lib/mcp-relay";
import { sameSite } from "@/lib/relay";

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameSite(request)) return Response.json({ error: "Cross-origin blocked." }, { status: 403 });
        try {
          return await relayMcp(await request.text(), request.signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : "MCP request failed.";
          return Response.json({ error: message.slice(0, 500) }, { status: 400 });
        }
      },
    },
  },
});
