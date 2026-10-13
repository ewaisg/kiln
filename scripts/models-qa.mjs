import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

// Real UI/storage with intercepted public catalog and tiny non-inference GGUF fixtures.
// This never represents fixture imports as a successful inference/provider live test.
const header = Buffer.alloc(24);
header.write("GGUF");
header.writeUInt32LE(3, 4);
const fixture = (name) => ({ name, mimeType: "application/octet-stream", buffer: header });
const baseUrl =
  process.argv.find((value) => /^https?:\/\//.test(value)) ||
  process.env.KILN_QA_URL ||
  "http://127.0.0.1:8080";
const built = process.argv.includes("--built") || new URL(baseUrl).port === "8081";
const screenshotPrefix = built ? "models-built" : "models";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const results = [];
mkdirSync("screenshots", { recursive: true });
try {
  for (const [viewportName, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    let failedDownloads = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("https://huggingface.co/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/models") {
        const search = url.searchParams.get("search");
        if (search === "failure") return route.fulfill({ status: 429, body: "Rate limited" });
        if (search === "missing") return route.fulfill({ json: [] });
        if (url.searchParams.has("cursor"))
          return route.fulfill({
            json: [
              { id: "qa/repo-a", downloads: 50 },
              { id: "qa/repo-b", downloads: 20 },
            ],
          });
        return route.fulfill({
          json: [{ id: "qa/repo-a", downloads: 50 }],
          headers: {
            link: '<https://huggingface.co/api/models?cursor=qa-next>; rel="next"',
            "access-control-expose-headers": "Link",
          },
        });
      }
      return route.fulfill({
        json: {
          siblings: [
            { rfilename: "alpha-Q4_K_M.gguf", size: 700000000 },
            { rfilename: "beta-Q8_0.gguf", size: 2000000000 },
            { rfilename: "mmproj-F16.gguf", size: 100000000 },
          ],
        },
      });
    });
    await page.route("https://models.qa/**", (route) => {
      if (route.request().url().includes("failure") && failedDownloads++ === 0)
        return route.fulfill({ status: 503, body: "Unavailable" });
      return route.fulfill({ body: header, contentType: "application/octet-stream" });
    });
    await page.goto(baseUrl, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1500);
    await page
      .getByRole("button", {
        name: viewportName === "desktop" ? "Settings" : "Workspace settings",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    const manager = page.locator(".model-manager");
    await page.getByRole("heading", { name: "Your model workspace" }).waitFor();
    const imported = manager.locator('input[type="file"]');
    assert.equal(await imported.getAttribute("multiple"), "");
    const buttonBox = await page
      .getByRole("button", { name: "Import files", exact: true })
      .boundingBox();
    assert.ok(
      buttonBox.y >= 0 && buttonBox.y + buttonBox.height <= viewport.height,
      "import action visible without scrolling",
    );
    await imported.setInputFiles([
      fixture("QA Alpha-Q4_K_M.gguf"),
      fixture("QA Beta-Q8_0.gguf"),
      {
        name: "invalid.gguf",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("invalid"),
      },
    ]);
    const library = page.getByRole("region", { name: "Installed model library" });
    await library.getByRole("heading", { name: "QA Alpha-Q4_K_M", exact: true }).waitFor();
    await library.getByRole("heading", { name: "QA Beta-Q8_0", exact: true }).waitFor();
    await page.getByRole("button", { name: "Transfers & storage", exact: true }).click();
    await page.getByText(/not a valid GGUF|not a GGUF/i).waitFor();
    assert.equal(
      await library.locator(".mm-badge").filter({ hasText: "Running" }).count(),
      0,
      "imports do not auto-load",
    );
    assert.equal(await page.getByRole("button", { name: "Load now", exact: true }).count(), 2);
    await page.getByRole("button", { name: /Installed \(/ }).click();
    await page.screenshot({
      path: `screenshots/${screenshotPrefix}-${viewportName}-import-success.png`,
      fullPage: true,
    });
    await page.getByLabel("Search installed models", { exact: true }).fill("Beta");
    assert.equal(await library.locator("article").count(), 1);
    await page.getByLabel("Search installed models", { exact: true }).fill("");
    const alpha = library
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: "QA Alpha-Q4_K_M", exact: true }) });
    await alpha.getByRole("button", { name: "Settings", exact: true }).click();
    const config = page.getByRole("region", { name: "Settings for QA Alpha-Q4_K_M", exact: true });
    await config.getByLabel("Context length", { exact: true }).fill("4096");
    await config.getByRole("combobox", { name: /^Performance profile/ }).selectOption("saver");
    await config.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText(/Settings saved for QA Alpha/).waitFor();
    const savedConfig = await page.evaluate(async () => {
      const models = await new Promise((resolve, reject) => {
        const request = indexedDB.open("kiln");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const rows = db.transaction("models").objectStore("models").getAll();
          rows.onerror = () => {
            db.close();
            reject(rows.error);
          };
          rows.onsuccess = () => {
            db.close();
            resolve(rows.result);
          };
        };
      });
      return {
        alpha: models.find((model) => model.name === "QA Alpha-Q4_K_M")?.config,
        beta: models.find((model) => model.name === "QA Beta-Q8_0")?.config,
      };
    });
    assert.equal(savedConfig.alpha.context, 4096);
    assert.equal(savedConfig.alpha.profile, "saver");
    assert.equal(savedConfig.beta, undefined, "configuration stays per-model");
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    const discover = page.getByRole("region", { name: "Discover models", exact: true });
    await discover.getByRole("button", { name: "Load more models", exact: true }).click();
    await discover.getByRole("heading", { name: "repo-b", exact: true }).waitFor();
    assert.equal(
      await discover.getByRole("heading", { name: "repo-a", exact: true }).count(),
      1,
      "pagination deduplicates",
    );
    await discover.getByRole("button", { name: /repo-a/ }).click();
    await discover.getByRole("combobox", { name: /^Quantization/ }).selectOption("Q4_K_M");
    assert.equal(await discover.locator("article").count(), 1);
    await discover.getByRole("combobox", { name: /^Quantization/ }).selectOption("all");
    await discover.getByRole("combobox", { name: /^Maximum file size/ }).selectOption("1000000000");
    assert.equal(await discover.locator("article").count(), 2);
    assert.ok(
      await discover.getByRole("button", { name: "Download", exact: true }).last().isEnabled(),
    );
    await discover.getByRole("button", { name: "Back to catalog", exact: true }).click();
    await discover.getByLabel("Search model catalog", { exact: true }).fill("failure");
    await discover.getByRole("alert").filter({ hasText: "429" }).waitFor();
    await discover.getByLabel("Search model catalog", { exact: true }).fill("missing");
    await discover.getByText("No repositories found. Try a different search or task.").waitFor();
    await page.getByRole("button", { name: /Installed \(/ }).click();
    await page.getByRole("button", { name: "Download URL", exact: true }).click();
    await page
      .getByLabel("Direct GGUF download link", { exact: true })
      .fill("https://user:secret@models.qa/model.gguf");
    await page.getByRole("button", { name: "Download to library", exact: true }).click();
    await manager
      .getByRole("alert")
      .filter({ hasText: /credentials/i })
      .waitFor();
    await page
      .getByLabel("Direct GGUF download link", { exact: true })
      .fill("https://models.qa/remote.gguf");
    await page.getByRole("button", { name: "Download to library", exact: true }).click();
    await page.getByRole("button", { name: "Transfers & storage", exact: true }).click();
    await page.getByText(/Saved in .*Ready to load/).waitFor();
    await page.getByRole("button", { name: /Installed \(/ }).click();
    await library.getByRole("heading", { name: "remote", exact: true }).waitFor();
    assert.equal(await library.locator("article").count(), 3);
    await page.getByRole("button", { name: "Download URL", exact: true }).click();
    await page
      .getByLabel("Direct GGUF download link", { exact: true })
      .fill("https://models.qa/failure.gguf");
    await page.getByRole("button", { name: "Download to library", exact: true }).click();
    await page.getByRole("button", { name: "Transfers & storage", exact: true }).click();
    await page.getByText(/503/).waitFor();
    await page.getByRole("button", { name: "Retry / resume", exact: true }).click();
    await page.getByRole("button", { name: /Installed \(/ }).click();
    await library.getByRole("heading", { name: "failure", exact: true }).waitFor();
    await page.evaluate(() => {
      const original = FileSystemWritableFileStream.prototype.write;
      window.__qaOriginalWrite = original;
      FileSystemWritableFileStream.prototype.write = async function (data) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return original.call(this, data);
      };
    });
    const cancelFixture = Buffer.alloc(2 * 1024 * 1024);
    header.copy(cancelFixture);
    await imported.setInputFiles([
      { name: "QA Cancel.gguf", mimeType: "application/octet-stream", buffer: cancelFixture },
    ]);
    await page.getByRole("button", { name: "Transfers & storage", exact: true }).click();
    await page.getByRole("button", { name: "Cancel import", exact: true }).click();
    await page
      .getByText(/Import canceled|Import cancelled|Canceled|Cancelled/i)
      .first()
      .waitFor();
    assert.equal(await library.getByRole("heading", { name: "QA Cancel", exact: true }).count(), 0);
    await page.evaluate(() => {
      FileSystemWritableFileStream.prototype.write = window.__qaOriginalWrite;
    });
    await page.getByRole("button", { name: /Installed \(/ }).click();
    await page.screenshot({
      path: `screenshots/${screenshotPrefix}-${viewportName}-installed.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Transfers & storage", exact: true }).click();
    await page.screenshot({
      path: `screenshots/${screenshotPrefix}-${viewportName}-storage.png`,
      fullPage: true,
    });
    const storageChecks = built
      ? []
      : await page.evaluate(async (bytes) => {
          const lib = await import("/src/lib/library.ts");
          const root = await navigator.storage.getDirectory();
          const a = await root.getDirectoryHandle("QA folder A", { create: true });
          const b = await root.getDirectoryHandle("QA folder B", { create: true });
          const write = async (folder, name, contents) => {
            const handle = await folder.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            await writable.write(new Uint8Array(contents));
            await writable.close();
          };
          await write(a, "existing.gguf", bytes);
          await write(b, "existing.gguf", [...bytes, 0, 0, 0, 0]);
          const previousQuery = FileSystemDirectoryHandle.prototype.queryPermission;
          const previousRequest = FileSystemDirectoryHandle.prototype.requestPermission;
          FileSystemDirectoryHandle.prototype.queryPermission = async () => "granted";
          FileSystemDirectoryHandle.prototype.requestPermission = async () => "granted";
          try {
            window.showDirectoryPicker = async () => a;
            await lib.rememberFolder();
            const locationA = (await lib.storageLocations()).find((item) => item.name === a.name);
            const importedA = await lib.scanModelFolder(locationA.id);
            if (importedA.length !== 1 || !importedA[0].linked)
              throw new Error("Folder A was not indexed as an original reference");
            if ((await lib.scanModelFolder(locationA.id)).length)
              throw new Error("Repeated folder scan duplicated a model");
            window.showDirectoryPicker = async () => b;
            await lib.rememberFolder();
            const locationB = (await lib.storageLocations()).find((item) => item.name === b.name);
            const importedB = await lib.scanModelFolder(locationB.id);
            if (importedB.length !== 1)
              throw new Error("Same filename across different folders was conflated");
            await lib.useBrowserStorage();
            if (
              (await lib.fileForModel(importedA[0])).size !== bytes.length ||
              (await lib.fileForModel(importedB[0])).size !== bytes.length + 4
            )
              throw new Error("Changing default changed original file resolution");
            await lib.deleteModelRecord(importedA[0].id);
            if ((await (await a.getFileHandle("existing.gguf")).getFile()).size !== bytes.length)
              throw new Error("Unregister deleted original file");
            FileSystemDirectoryHandle.prototype.queryPermission = async () => "denied";
            FileSystemDirectoryHandle.prototype.requestPermission = async () => "denied";
            let denied = false;
            try {
              await lib.scanModelFolder(locationB.id);
            } catch (error) {
              denied = /Allow access/.test(error.message);
            }
            if (!denied) throw new Error("Permission denial did not produce an actionable error");
            FileSystemDirectoryHandle.prototype.queryPermission = async () => "granted";
            await b.removeEntry("existing.gguf");
            let missing = false;
            try {
              await lib.fileForModel(importedB[0]);
            } catch {
              missing = true;
            }
            if (!missing || !(await lib.listModels()).some((model) => model.id === importedB[0].id))
              throw new Error("Missing original did not preserve its recoverable record");
            const nested = await root.getDirectoryHandle("QA nested", { create: true });
            await write(nested, "nested.gguf", bytes);
            const scanned = await lib.scanModelFolder("browser");
            const nestedModel = scanned.find((model) => model.opfsName === "QA nested/nested.gguf");
            if (!nestedModel || (await lib.fileForModel(nestedModel)).size !== bytes.length)
              throw new Error("Nested browser GGUF did not resolve");
            await lib.deleteStoredModel(nestedModel);
            let deleted = false;
            try {
              await nested.getFileHandle("nested.gguf");
            } catch {
              deleted = true;
            }
            if (!deleted) throw new Error("Nested browser model deletion left its file");
            const abort = new AbortController();
            abort.abort();
            let cancelled = false;
            try {
              await lib.scanModelFolder("browser", undefined, abort.signal);
            } catch (error) {
              cancelled = error.name === "AbortError";
            }
            if (!cancelled) throw new Error("Folder cancellation ignored abort");
            return [
              "real OPFS folder handle indexing with mocked picker/permissions",
              "rescan deduplication",
              "same filename in multiple folders",
              "default change preserves old files",
              "unregister preserves original",
              "permission denial",
              "missing file retains record",
              "nested OPFS read/delete",
              "folder scan cancellation",
            ];
          } finally {
            FileSystemDirectoryHandle.prototype.queryPermission = previousQuery;
            FileSystemDirectoryHandle.prototype.requestPermission = previousRequest;
          }
        }, Array.from(header));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.deepEqual(errors, []);
    results.push({
      viewport: viewportName,
      target: built ? "built output" : "development",
      live: false,
      skipped: built
        ? [
            "Nine source-module storage API checks run against development only; built output covers rendered controls and real UI storage.",
          ]
        : [],
      passed: [
        "top-level import controls",
        "multi-file import and invalid file",
        "auto-refresh and explicit load",
        "installed search",
        "per-model settings",
        "pagination and deduplication",
        "quantization and size filters",
        "rate-limit and empty result states",
        "credential URL rejection",
        "URL download without automatic inference",
        "failed download retry",
        "import cancellation without library record",
        "responsive library/storage",
        ...storageChecks,
      ],
      errors,
    });
    await context.close();
  }
} finally {
  await browser.close();
  writeFileSync(
    `screenshots/${built ? "models-built" : "models"}-qa.json`,
    JSON.stringify(results, null, 2),
  );
}
console.log(JSON.stringify(results, null, 2));
