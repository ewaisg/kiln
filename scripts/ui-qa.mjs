import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
mkdirSync("screenshots", { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const results = [];
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport });
    console.log("Start", name);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("https://huggingface.co/**", (route) => route.fulfill({ json: [] }));
    await page.route("**/api/models", (route) =>
      route.fulfill({ json: { ids: ["kiln-mock-chat"] } }),
    );
    await page.route("**/api/chat", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify({ t: "A verified mock response.\n\n| Item | Status |\n| --- | --- |\n| Streaming | Passed |" })}\n\n`,
      }),
    );
    await page.goto("http://127.0.0.1:8080", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `screenshots/ux-${name}.png`, fullPage: true });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    if (name === "desktop")
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    else await page.getByRole("button", { name: "Workspace settings" }).click();
    await page.getByRole("dialog").waitFor();
    for (const tab of ["Models", "Providers", "Media", "Tools", "Settings"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      await page.waitForTimeout(200);
      await page.screenshot({
        path: `screenshots/ux-${name}-${tab.toLowerCase()}.png`,
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `${name} ${tab} overflow`,
      );
    }
    await page.getByLabel("Prompt name", { exact: true }).fill("QA reusable prompt");
    await page.getByLabel("Prompt text", { exact: true }).fill("Saved prompt content");
    await page.getByRole("button", { name: "Save reusable prompt", exact: true }).click();
    await page.getByRole("button", { name: "Providers", exact: true }).click();
    await page.getByRole("button", { name: "Custom", exact: true }).click();
    const form = page.getByRole("dialog").locator("form");
    await form.getByLabel("Name", { exact: true }).fill("QA mock provider");
    await form.getByLabel("Base URL", { exact: true }).fill("https://mock.example/v1");
    await form.getByLabel("Model", { exact: true }).fill("kiln-mock-chat");
    await form.getByLabel(/API key/).fill("mock-key-not-real");
    await form.getByRole("button", { name: "Test & discover models", exact: true }).click();
    await form.getByText("1 models", { exact: true }).waitFor();
    await form.getByRole("button", { name: "kiln-mock-chat", exact: true }).click();
    assert.equal(await form.getByLabel("Model", { exact: true }).inputValue(), "kiln-mock-chat");
    await form.getByRole("button", { name: "Save and use", exact: true }).click();
    await page.getByRole("button", { name: "Close workspace" }).click();
    await page
      .getByRole("combobox", { name: "Insert reusable prompt", exact: true })
      .selectOption({ label: "QA reusable prompt" });
    assert.equal(
      await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(),
      "Saved prompt content",
    );
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Test streaming and markdown");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await page.getByText("A verified mock response.", { exact: true }).waitFor({ timeout: 15000 });
    await page.locator("table").waitFor();
    await page.getByRole("button", { name: "Branch", exact: true }).click();
    await page.getByText(/branched conversation/).waitFor();
    await page.screenshot({ path: `screenshots/ux-${name}-chat.png`, fullPage: true });
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    await page.getByText("A verified mock response.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.locator("article form");
    await editor.locator("textarea").fill("Edited prompt");
    await editor.getByRole("button", { name: "Save and send", exact: true }).click();
    await page.getByText("Edited prompt", { exact: true }).waitFor();
    await page.getByText("A verified mock response.", { exact: true }).waitFor();
    if (name === "mobile")
      await page.getByRole("button", { name: "Open conversations", exact: true }).click();
    await page.getByRole("button", { name: "Rename", exact: true }).first().click();
    await page
      .getByRole("textbox", { name: "Conversation title", exact: true })
      .fill("QA preserved branch");
    await page.getByRole("button", { name: "Save title", exact: true }).click();
    await page.getByRole("button", { name: "Archive", exact: true }).first().click();
    await page.getByRole("button", { name: "View archived conversations", exact: true }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).first().click();
    assert.deepEqual(errors, []);
    results.push({
      viewport: name,
      passed: [
        "render",
        "responsive panels",
        "provider configuration and mocked discovery",
        "mock streaming",
        "markdown table",
        "conversation branch",
        "regenerate preserving branch",
        "edit and resend",
        "rename",
        "archive and restore",
        "save and insert reusable prompt",
      ],
      errors,
    });
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync("screenshots/ui-qa.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
