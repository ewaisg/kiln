import { createFileRoute } from "@tanstack/react-router";
import { readChatBody, relayChat, sameSite } from "@/lib/relay";

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameSite(request)) {
          return Response.json({ error: "Cross-origin blocked." }, { status: 403 });
        }
        try {
          const payload = readChatBody(await request.text());
          return await relayChat(payload, request.signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Request failed.";
          return Response.json({ error: message.slice(0, 500) }, { status: 400 });
        }
      },
    },
  },
});
