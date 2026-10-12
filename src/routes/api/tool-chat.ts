import { createFileRoute } from "@tanstack/react-router";
import { sameSite } from "@/lib/relay";
import { relayToolChat } from "@/lib/tool-chat.server";

export const Route = createFileRoute("/api/tool-chat")({ server: { handlers: { POST: async ({ request }) => {
  if (!sameSite(request)) return Response.json({ error: "Cross-origin blocked." }, { status: 403 });
  try { return await relayToolChat(await request.text(), request.signal); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message.slice(0, 500) : "Tool provider failed." }, { status: 400 }); }
} } } });
