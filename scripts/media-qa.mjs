import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import JSZip from "jszip";

// Frontend integration checks. Every provider response is intercepted; no paid API call.
mkdirSync("screenshots", { recursive: true });
const origin = process.env.KILN_QA_URL || "http://127.0.0.1:8080";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
function pdfFixture() {
  const stream = "BT /F1 16 Tf 40 140 Td (REAL_PDF_BODY_731) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let document = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(document);
}
const zip = new JSZip();
zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>REAL_DOCX_BODY_482</w:t></w:r></w:p></w:body></w:document>');
const docx = await zip.generateAsync({ type: "nodebuffer" });
const wav = Buffer.alloc(44 + 8000 * 2); wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const results = [];
let activePage;
try {
  for (const [viewportName, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    console.log("Media QA:", viewportName);
    const context = await browser.newContext({ viewport, acceptDownloads: true, permissions: ["microphone"] });
    const page = await context.newPage(); activePage = page; const errors = []; const mediaCalls = []; const chats = [];
    page.on("pageerror", error => errors.push(error.message));
    let videoBytes;
    await context.addInitScript(() => {
      const endpoint = { id: "media-qa", name: "Mock media provider", kind: "custom", baseUrl: "https://mock.example/v1", apiKey: "not-a-real-key", model: "mock-chat", apiVersion: "", direct: false, capabilities: ["chat", "vision", "image", "transcription", "speech", "video"] };
      localStorage.setItem("kiln-v1", JSON.stringify({ version: 2, state: { endpoints: [endpoint], activeId: endpoint.id, activeThreadId: "media-thread", threads: [{ id: "media-thread", title: "Media QA", messages: [], updatedAt: Date.now(), mode: "chat" }], mode: "chat", folders: [], mcpServers: [], toolGrants: {}, settings: { theme: "dark", systemPrompt: "You are a test assistant.", chatPrompt: "You are a test assistant.", temperature: 0.2, maxTokens: 300, localCtx: 2048, rememberCredentials: false, mediaDefaults: Object.fromEntries(["vision", "image", "transcription", "speech", "video"].map(capability => [capability, { endpointId: endpoint.id, model: `mock-${capability}` }])) } } }));
    });
    await page.route("https://huggingface.co/**", route => route.fulfill({ json: [] }));
    await page.route("**/api/media", async route => {
      const request = route.request();
      const form = await new Response(request.postDataBuffer(), { headers: { "content-type": request.headers()["content-type"] } }).formData();
      const action = form.get("action"); const options = JSON.parse(form.get("options")); const file = form.get("file");
      const bytes = file ? Buffer.from(await file.arrayBuffer()) : undefined;
      mediaCalls.push({ action, options, fileName: file?.name, bytes });
      if (action === "transcription") await route.fulfill({ json: { text: "Mock audio transcript with actual uploaded content" } });
      else if (action === "image") await route.fulfill({ json: { mime: "image/png", data: png.toString("base64") } });
      else if (action === "speech") await route.fulfill({ contentType: "audio/wav", body: wav });
      else if (action === "video-create") await route.fulfill({ json: { id: "video_qa_123", status: "queued", progress: 0 } });
      else if (action === "video-status") await route.fulfill({ json: { id: "video_qa_123", status: "completed", progress: 100 } });
      else if (action === "video-content") await route.fulfill({ contentType: "video/webm", body: videoBytes });
      else if (action === "video-delete") await route.fulfill({ json: { id: "video_qa_123", deleted: true } });
      else throw new Error(`Unexpected media action ${action}`);
    });
    await page.route("**/api/chat", async route => { const request = route.request().postDataJSON(); chats.push(request); await route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ t: `Mock assistant reply ${chats.length}` })}\n\n` }); });
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.documentElement.dataset.reduceMotion !== undefined);
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    // A real encoded browser video is used both for attachment extraction and mock playback.
    const videoBase64 = await page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180; const ctx = canvas.getContext("2d");
      const stream = canvas.captureStream(12); const recorder = new MediaRecorder(stream, { mimeType: "video/webm" }); const chunks = [];
      const complete = new Promise(resolve => { recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); }; recorder.onstop = async () => { const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer()); let raw = ""; for (const byte of bytes) raw += String.fromCharCode(byte); stream.getTracks().forEach(track => track.stop()); resolve(btoa(raw)); }; });
      recorder.start(); let frame = 0; const draw = setInterval(() => { ctx.fillStyle = frame++ % 2 ? "#d08243" : "#334e5b"; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = "white"; ctx.font = "24px sans-serif"; ctx.fillText(`Actual frame ${frame}`, 20, 90); }, 80);
      await new Promise(resolve => setTimeout(resolve, 1500)); clearInterval(draw); recorder.stop(); return complete;
    });
    videoBytes = Buffer.from(videoBase64, "base64"); assert.ok(videoBytes.length > 500);
    console.log("Browser video fixture bytes", videoBytes.length);
    async function openMedia() { await page.waitForFunction(() => document.documentElement.dataset.reduceMotion !== undefined); await page.getByRole("button", { name: viewportName === "desktop" ? "Settings" : "Workspace settings", exact: true }).click(); await page.getByRole("dialog").waitFor(); await page.getByRole("button", { name: "Media", exact: true }).click(); await page.getByRole("heading", { name: "Media studio", exact: true }).waitFor(); }
    await openMedia();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Image prompt", { exact: true }).fill("Create an actual mocked image");
    await dialog.getByRole("button", { name: "Generate image", exact: true }).click(); await dialog.getByText("Image ready. Saved in this browser.").waitFor();
    const imageDownload = page.waitForEvent("download"); await dialog.getByRole("link", { name: "Download image", exact: true }).click(); assert.match((await imageDownload).suggestedFilename(), /\.png$/);
    await dialog.locator('input[type="file"]').setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: png });
    await dialog.getByRole("button", { name: "Edit reference image", exact: true }).click(); await dialog.getByText("Image ready. Saved in this browser.").waitFor();
    const edit = mediaCalls.find(call => call.action === "image" && call.bytes); assert.deepEqual(edit.bytes, png); assert.equal(edit.options.model, "mock-image");
    await dialog.getByRole("tab", { name: "audio", exact: true }).click();
    await dialog.locator('input[type="file"]').setInputFiles({ name: "speech.wav", mimeType: "audio/wav", buffer: wav });
    await dialog.getByRole("button", { name: "Transcribe audio", exact: true }).click(); await dialog.getByText("Transcript ready. Review and edit before sending.").waitFor();
    assert.equal(await dialog.locator("textarea").inputValue(), "Mock audio transcript with actual uploaded content");
    assert.deepEqual(mediaCalls.find(call => call.action === "transcription").bytes, wav);
    await dialog.locator("textarea").fill("Edited actual speech text"); await dialog.getByLabel("Provider voice ID", { exact: true }).fill("mock-voice");
    await dialog.getByRole("button", { name: "Generate speech", exact: true }).click(); await dialog.getByText("AI-generated speech ready.").waitFor();
    await page.waitForFunction(() => document.querySelector("audio")?.readyState >= 2); assert.equal(mediaCalls.find(call => call.action === "speech").options.input, "Edited actual speech text");
    assert.equal(mediaCalls.find(call => call.action === "speech").options.voice, "mock-voice");
    const audioDownload = page.waitForEvent("download"); await dialog.getByRole("link", { name: "Download audio", exact: true }).click(); assert.ok((await audioDownload).suggestedFilename());
    await dialog.getByRole("button", { name: "Interrupt playback", exact: true }).click(); assert.equal(await dialog.locator("audio").evaluate(audio => audio.paused), true);
    await dialog.getByRole("tab", { name: "video", exact: true }).click(); await dialog.getByLabel("Video prompt", { exact: true }).fill("Actual mocked asynchronous video");
    await dialog.getByLabel("Resolution", { exact: true }).selectOption("720x1280"); await dialog.getByLabel("Duration", { exact: true }).selectOption("8");
    await dialog.getByRole("button", { name: "Submit video job", exact: true }).click(); await dialog.getByText("video_qa_123", { exact: true }).waitFor();
    assert.equal(mediaCalls.find(call => call.action === "video-create").options.size, "720x1280");
    await dialog.getByRole("button", { name: "Refresh status", exact: true }).click(); await dialog.getByText("Video ready. Download a copy before the provider expires it.").waitFor();
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    const videoDownload = page.waitForEvent("download"); await dialog.getByRole("link", { name: "Download video", exact: true }).click(); assert.match((await videoDownload).suggestedFilename(), /\.webm$/);
    await page.screenshot({ path: `screenshots/media-${viewportName}-video.png`, fullPage: true });
    await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("textbox", { name: "Message", exact: true }).waitFor(); await openMedia(); dialog = page.getByRole("dialog");
    await dialog.getByRole("tab", { name: "video", exact: true }).click(); await dialog.getByText("video_qa_123", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Open saved video", exact: true }).click(); await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    assert.equal(mediaCalls.filter(call => call.action === "video-content").length, 1, "restoring saved video should use IndexedDB, not another provider download");
    console.log(viewportName, "media creation, transcript, TTS, video and persistence passed");
    await page.getByRole("button", { name: "Close workspace", exact: true }).click();
    const attachments = [
      { name: "real.pdf", mimeType: "application/pdf", buffer: pdfFixture() },
      { name: "real.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx },
      { name: "real.webm", mimeType: "video/webm", buffer: videoBytes },
      { name: "real.png", mimeType: "image/png", buffer: png },
    ];
    await page.locator('form input[type="file"]').setInputFiles(attachments);
    await page.getByText(/real\.pdf · Document text extracted/).waitFor();
    await page.getByText(/real\.webm · Sampled frames with timestamps included/).waitFor();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Read actual attachments"); await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("Mock assistant reply 1", { exact: true }).waitFor();
    const user = chats[0].messages.find(message => message.role === "user"); assert.match(user.content, /REAL_PDF_BODY_731/); assert.match(user.content, /REAL_DOCX_BODY_482/); assert.match(user.content, /Frame 1: .*seconds/); assert.ok(user.images.length >= 2, "video sampled frames and image bytes reach the processing model"); assert.ok(user.images.every(image => image.data.length > 50));
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Ask a follow-up about those images"); await page.getByRole("button", { name: "Send message", exact: true }).click(); await page.getByText("Mock assistant reply 2", { exact: true }).waitFor();
    assert.equal(chats[1].messages.find(message => message.role === "user").images.length, user.images.length, "follow-up retains actual attachment content");
    await page.screenshot({ path: `screenshots/media-${viewportName}-attachments.png`, fullPage: true });
    await page.getByRole("button", { name: "Voice conversation", exact: true }).click(); const voice = page.getByRole("region", { name: "Voice conversation", exact: true });
    await voice.getByRole("button", { name: "Record next turn", exact: true }).click(); await voice.getByText("Recording. Stop to transcribe, then review your message.").waitFor(); await page.waitForTimeout(350);
    await voice.getByRole("button", { name: "Stop and transcribe", exact: true }).click(); await voice.getByText("Review your transcript, then send.").waitFor();
    assert.ok(mediaCalls.at(-1).bytes.length > 100, "microphone recording sends actual encoded audio");
    await voice.getByRole("textbox", { name: "Review voice transcript", exact: true }).fill("Reviewed voice chat turn"); await voice.getByRole("button", { name: "Send voice message", exact: true }).click(); await page.getByText("Mock assistant reply 3", { exact: true }).waitFor();
    assert.equal(chats[2].messages.at(-1).content, "Reviewed voice chat turn");
    await voice.getByRole("button", { name: "Listen to reply", exact: true }).click(); await voice.getByText("Playing AI speech. Interrupt to speak.").waitFor(); await voice.getByRole("button", { name: "Interrupt", exact: true }).click(); await voice.getByText("Interrupted. You can record your next turn.").waitFor();
    await voice.getByRole("button", { name: "Close voice conversation", exact: true }).click();
    // Seed the next reload's selected provider through the actual persisted workspace.
    // This also works against production, which does not expose source modules.
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open("kiln", 3); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      try {
        const saved = await new Promise((resolve, reject) => { const request = db.transaction("workspace").objectStore("workspace").get("kiln-v1"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        const value = JSON.parse(saved); if (!value.state.endpoints.some(endpoint => endpoint.id === "media-qa")) throw new Error("Workspace fixture was not persisted"); value.state.activeId = "local";
        await new Promise((resolve, reject) => { const tx = db.transaction("workspace", "readwrite"); tx.objectStore("workspace").put(JSON.stringify(value), "kiln-v1"); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      } finally { db.close(); }
    });
    await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForFunction(() => document.documentElement.dataset.reduceMotion !== undefined); await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    await page.getByRole("button", { name: "Draw", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Cloud image while local chat is selected");
    await page.getByRole("button", { name: "Generate image", exact: true }).click();
    const generated = page.getByRole("img", { name: "Cloud image while local chat is selected", exact: true }); await generated.waitFor();
    assert.ok(await generated.evaluate(image => image.complete && image.naturalWidth > 0));
    const inlineDownload = page.waitForEvent("download"); await page.getByRole("link", { name: "Download generated image", exact: true }).click(); assert.match((await inlineDownload).suggestedFilename(), /\.png$/);
    assert.equal(mediaCalls.at(-1).options.model, "mock-image", "local chat still uses its independent configured cloud image provider");
    await page.screenshot({ path: `screenshots/media-${viewportName}-local-image.png`, fullPage: true });
    assert.deepEqual(errors, []); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    results.push({ viewport: viewportName, upstream: "mocked only; real browser file decoding and recording", passed: ["independent media routing", "image generation preview/download", "image edit actual reference bytes", "uploaded audio actual bytes and editable transcript", "TTS selected voice and playable download", "playback interruption", "async video settings/status/content/playback/download", "video job reload and IndexedDB output recovery", "PDF actual text extraction", "DOCX actual text extraction", "browser-encoded WebM frame extraction and timestamps", "attachment/image contents retained on follow-up", "microphone recording/transcription/review/send/reply speech/interruption", "independent cloud image generation+download with local chat selected"], mediaCalls: mediaCalls.map(({ action, fileName, bytes }) => ({ action, fileName, bytes: bytes?.length })), errors });
    await context.close();
  }
} catch (error) { if (activePage && !activePage.isClosed()) { await activePage.screenshot({path:"screenshots/media-qa-failure.png",fullPage:true}); writeFileSync("screenshots/media-qa-failure.txt",await activePage.locator("body").innerText()); } throw error; } finally { await browser.close(); }
writeFileSync("screenshots/media-qa.json", JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2));


