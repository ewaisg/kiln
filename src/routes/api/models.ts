import { createFileRoute } from "@tanstack/react-router";
import { relayModels, sameSite } from "@/lib/relay";

export const Route = createFileRoute("/api/models")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameSite(request)) {
          return Response.json({ error: "Cross-origin blocked." }, { status: 403 });
        }
        try {
          return await relayModels(await request.text(), request.signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not list models.";
          return Response.json({ error: message.slice(0, 500) }, { status: 400 });
        }
      },
    },
  },
});
