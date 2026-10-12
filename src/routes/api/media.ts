import { createFileRoute } from "@tanstack/react-router";
import { sameSite } from "@/lib/relay";
import { relayMedia } from "@/lib/media-relay";
export const Route = createFileRoute("/api/media")({ server: { handlers: { POST: async ({ request }) => {
  if (!sameSite(request)) return Response.json({ error: "Cross-origin blocked." }, { status: 403 });
  try { return await relayMedia(request); } catch (error) { return Response.json({ error: error instanceof Error ? error.message.slice(0, 500) : "Media request failed." }, { status: 400 }); }
} } } });
