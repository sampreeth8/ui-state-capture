// top of src/scripts/test_capture.ts
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && (err.stack || err));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason && (reason || reason));
  process.exit(1);
});

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { resolveAppFromInstruction } from "../core/app_resolver.js";
import { captureDomSummary } from "../core/dom_capture.js";
import { callPlanner } from "../core/planner.js";
import { executeCheckpointedPlan } from "../core/executor.js";





const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Minimal AppInfo shape returned by resolveAppFromInstruction.
 * We keep all fields optional because resolver may return different shapes.
 */
type AppInfo = {
  app?: string;
  baseUrl?: string;
  start_url?: string;
  authPath?: string;
  task_id?: string;
  message?: string;
  // allow extras
  [k: string]: any;
};

async function main() {
  const instruction = process.argv.slice(2).join(" ");
  if (!instruction) {
    console.error('Usage: node --loader ts-node/esm src/scripts/test_capture.ts "How do I create a project in Linear"');
    process.exit(1);
  }

  console.log("\n🔎 Instruction:", instruction);

  // Resolve app — treat returned value as a loose AppInfo type
  const appInfo = (await resolveAppFromInstruction(instruction)) as AppInfo | null;
  if (!appInfo) {
    console.log("App resolution cancelled or not found. Exiting.");
    process.exit(0);
  }

  console.log("\n🌐 Resolved app:", appInfo);

  console.log("\n🧭 Opening browser...");
  const browser = await chromium.launch({ headless: false, slowMo: 30 });

  const authPath = appInfo.authPath ? path.resolve(process.cwd(), appInfo.authPath) : null;
  let context;
  if (authPath && fs.existsSync(authPath)) {
    console.log("Found storageState -> using auth to open page:", authPath);
    context = await browser.newContext({ storageState: authPath, viewport: { width: 1920, height: 1080 } });
  } else {
    console.log("No storageState found -> starting without auth.");
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  }

  const page = await context.newPage();

  // normalize start URL
  const startUrl = (appInfo.baseUrl ?? appInfo.start_url ?? "about:blank") as string;
  console.log("\n➡️ Going to:", startUrl);
  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    console.warn("Goto timed out or failed; continuing with current page.url()", (e as Error).message ?? e);
  }

  // app-specific hydration waits (non-fatal)
  try {
    await page.waitForSelector("text=In Progress", { timeout: 15000 });
    await page.waitForSelector("text=Filter", { timeout: 15000 });
    await page.waitForTimeout(1000);
  } catch (e) {
    console.warn("UI did not fully load (hydration selectors missing) — proceeding anyway.", (e as Error).message ?? e);
  }

  // capture DOM summary and screenshot
  const outDir = path.resolve(process.cwd(), "outputs", "capture");
  console.log("\n📸 Capturing DOM snapshot and screenshot...");
  const { snapshot, outFile, shotPath } = await captureDomSummary(page, { outDir });

  console.log("Snapshot written to:", outFile);
  console.log("Screenshot written to:", shotPath);
  console.log("Top visible elements (first 10):");
  console.log(snapshot.visible_elements.slice(0, 10));

  // --- CALL THE LLM PLANNER ---
  console.log("\n🤖 Calling planner LLM...");
  let plannerOutput: any;
  try {
    plannerOutput = await callPlanner(instruction, snapshot);
    console.log("\n✅ Planner returned (preview):");
    console.dir(plannerOutput, { depth: 2 });
  } catch (err) {
    console.error("Planner call failed:", err);
    console.log("Browser left open for inspection. Close manually when done.");
    process.exitCode = 2;
    return;
  }

  // Save planner output to disk for provenance / dataset
  try {
    const planOutPath = path.join(outDir, `plan-${Date.now()}.json`);
    fs.writeFileSync(planOutPath, JSON.stringify(plannerOutput, null, 2), "utf8");
    console.log("Planner output saved to:", planOutPath);
  } catch (e) {
    console.warn("Failed to write planner output to disk:", (e as Error).message ?? e);
  }

  // --- EXECUTE THE PLAN ---
  console.log("\n🏃 Executing planner output (checkpointed plan)...");
  try {
    // plannerOutput.confidence might be undefined or a number
    const plannerConfidence = typeof plannerOutput?.confidence === "number" ? plannerOutput.confidence : undefined;

    const execResult = await executeCheckpointedPlan(page, plannerOutput, {
      taskId: plannerOutput?.task_id ?? appInfo.task_id ?? `${appInfo.app ?? "app"}_task`,
      outDir: path.resolve(process.cwd(), "outputs"),
      plannerConfidence,
      instruction
    });

    console.log("\n🎉 Execution finished:", execResult);
    console.log("Screenshots and meta saved under outputs/<task_id>/*");
  } catch (err) {
    console.error("\n❌ Execution failed:", err);
    console.log("Check outputs/ for failure.json and recovery snapshots.");
    console.log("Browser left open for inspection. Close manually when done.");
    process.exitCode = 3;
    return;
  }

  console.log("\nDone — browser left open for inspection. Close manually when done.");
}

main().catch((err) => {
  console.error("Fatal error in test_capture:", err);
  process.exit(1);
});
