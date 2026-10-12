/** Decode SSE across arbitrary byte boundaries, including a final unterminated event. */
export async function* sseData(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error("The provider returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    data: string[] = [],
    total = 0;
  const line = (value: string): string | undefined => {
    const cleaned = value.replace(/\r$/, "");
    if (cleaned === "") {
      if (!data.length) return;
      const event = data.join("\n");
      data = [];
      return event;
    }
    if (cleaned.startsWith("data:")) data.push(cleaned.slice(5).replace(/^ /, ""));
  };
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      total += chunk.value.byteLength;
      if (total > 20_000_000) throw new Error("The response exceeded the 20 MB streaming limit.");
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const event = line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (event !== undefined) {
          if (event.trim() === "[DONE]") return;
          yield event;
        }
      }
    }
    if (buffer) line(buffer);
    const event = line("");
    if (event !== undefined && event.trim() !== "[DONE]") yield event;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
