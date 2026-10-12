import { createFileRoute } from "@tanstack/react-router";
import { relayImage } from "@/lib/image-relay";
import { sameSite } from "@/lib/relay";

export const Route = createFileRoute("/api/image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!sameSite(request)) return Response.json({ error: "Cross-origin blocked." }, { status: 403 });
        try {
          return await relayImage(await request.text(), request.signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Image request failed.";
          return Response.json({ error: message.slice(0, 500) }, { status: 400 });
        }
      },
    },
  },
});
