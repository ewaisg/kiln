import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "log" && message.text().startsWith("[local-qa]")) console.log(message.text()); });
  await page.goto("http://127.0.0.1:8080", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const result = await page.evaluate(async () => {
    const { downloadIntoStorage, saveModel, deleteStoredModel } = await import("/src/lib/library.ts");
    const { ensureLocal, completeLocal, unloadLocal, localDiagnostics } = await import("/src/lib/local-engine.ts");
    const { useKiln } = await import("/src/lib/store.ts");
    const url = "https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/resolve/main/SmolLM2-135M-Instruct-Q4_K_M.gguf";
    const controller = new AbortController();
    let cancelled = false;
    console.log("[local-qa] testing download cancellation");
    try { await downloadIntoStorage(url, "qa-smollm.gguf", controller.signal, ratio => { if (ratio !== null && ratio > 0.025) controller.abort(); }); }
    catch (error) { if (error.name !== "AbortError") throw error; cancelled = true; }
    if (!cancelled) throw new Error("Download cancellation did not happen.");
    console.log("[local-qa] resuming actual GGUF download");
    const placed = await downloadIntoStorage(url, "qa-smollm.gguf", new AbortController().signal, () => {});
    const model = { id: crypto.randomUUID(), name: "QA SmolLM2 135M Q4_K_M", kind: "file", repo: "", file: "qa-smollm.gguf", url: "", createdAt: Date.now(), ...placed };
    await saveModel(model);
    try {
      useKiln.getState().updateSettings({ performanceProfile: "saver" });
      console.log("[local-qa] loading and generating on CPU");
      await ensureLocal(model, 1024, () => {}, "saver");
      const cpu = await completeLocal([{ role: "system", content: "You are a helpful assistant. Give brief answers." }, { role: "user", content: "What is 2 + 2? Answer with just the number." }], 0, 64, new AbortController().signal, () => {});
      if (!cpu.trim() || /(\S{2,16})\1{5}/.test(cpu)) throw new Error("CPU output empty or repeated.");
      const cpuDiagnostics = localDiagnostics();
      if (cpuDiagnostics.backend !== "cpu") throw new Error("CPU verification did not select CPU-only mode.");
      const abort = new AbortController(); let stopped = false;
      try { await completeLocal([{ role: "user", content: "Count from one to one hundred with explanations." }], 0, 512, abort.signal, value => { if (value.length > 4) abort.abort(); }); } catch (error) { if (!/Abort/i.test(error.name)) throw error; stopped = true; }
      if (!stopped) throw new Error("Local generation cancellation did not stop.");
      const recovered = await completeLocal([{ role: "user", content: "Say hello." }], 0, 32, new AbortController().signal, () => {});
      if (!recovered.trim()) throw new Error("Runtime did not recover after interruption.");
      await unloadLocal(); useKiln.getState().updateSettings({ performanceProfile: "balanced" });
      console.log("[local-qa] testing automatic acceleration / CPU fallback");
      await ensureLocal(model, 1024, () => {}, "balanced");
      const accelerated = await completeLocal([{ role: "user", content: "What is 2 + 2? Answer briefly." }], 0, 64, new AbortController().signal, () => {});
      if (!accelerated.trim() || /(\S{2,16})\1{5}/.test(accelerated)) throw new Error("Accelerated output empty or repeated.");
      return { live: true, model: model.name, bytes: placed.bytes, downloadCancelled: cancelled, cpu, cpuDiagnostics, generationStopped: stopped, recovered, accelerated, acceleratedDiagnostics: localDiagnostics() };
    } finally { await unloadLocal(); await deleteStoredModel(model); }
  });
  mkdirSync("screenshots", { recursive: true });
  writeFileSync("screenshots/local-runtime-qa.json", JSON.stringify({ ...result, errors }, null, 2));
  console.log(JSON.stringify({ ...result, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); }
