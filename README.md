# Kiln

A coding chat that runs in the browser. Chat talks things through. Build writes files, scripts, and small apps you can preview.

## Use it

1. Open Kiln. Chat is a conversation. Build is for files and small apps.
2. Local model: open the model chip, search the list, and choose one. The file downloads into browser storage, or into a folder you pick in Chrome or Edge on a computer. Cancel stops the download. Use loads it on the CPU. The GPU stays off because it was corrupting replies.
3. Hosted model: add Grok, OpenAI, Claude, Azure, LM Studio, or Ollama. The key stays in this browser. LM Studio and Ollama are called from the device, so they need CORS and, from a phone, the computer’s LAN address.
4. Attach a document, image, audio, or video. Text is included. Images are sent to cloud models that accept them. Audio and video play here; the model only sees the name.
5. Draw appears only after you select a saved OpenAI or Grok endpoint. It bills that account. Video generation is not available.
6. Tools connects to an MCP server that already speaks HTTP. Kiln does not start one. Allow a tool, then run it. Insert the result into the message if you want the model to see it.
7. Studio holds prompts, temperature, context, theme, export, and install.

On Windows, Studio’s installer downloads Install-Kiln.bat. Double-click it to open Kiln in its own window and add Start menu and desktop shortcuts.

## Limits

- Models stay on this device. A chosen folder works where the browser can pick one.
- Phone inference uses one CPU core and a short reply so the device stays cooler. The first token is still slow.
- MCP, image models, and cloud chat need a server or key you supply. A failed connection shows the real error.
- Kiln does not transcribe audio, watch video, or generate video.
