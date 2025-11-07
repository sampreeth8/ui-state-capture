// src/core/executor.ts--ff
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Page } from "playwright";
import { captureDomSummary } from "./dom_capture.js";
import { callPlanner } from "./planner.js";
import type { PlanAction } from "./planner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function nowIso() { return new Date().toISOString(); }

/** Try selectors quickly and return the first that appears visible */
async function trySelectorsSimple(page: Page, selectors: string[] = [], perSelectorMs = 1200): Promise<string | null> {
  if (!selectors || selectors.length === 0) return null;

  const startTime = Date.now();

  for (const s of selectors) {
    if (!s || typeof s !== "string") continue;
    try {
      const deadline = Date.now() + perSelectorMs;

      while (Date.now() < deadline) {
        const loc = page.locator(s).first();

        // Check if element exists
        const count = await loc.count().catch(() => 0);
        if (count === 0) {
          await page.waitForTimeout(100);
          continue;
        }

        // Check visibility and position
        const visible = await loc.isVisible().catch(() => false);
        const box = visible ? await loc.boundingBox().catch(() => null) : null;

        if (visible && box) {
          console.log(`[executor:trySelectorsSimple] MATCHED selector='${s}' (count=${count})`);
          return s;
        }

        // short pause before retry
        await page.waitForTimeout(100);
      }
    } catch (err) {
      console.log(`[executor:trySelectorsSimple] selector '${s}' threw, skipping. err=${String(err)}`);
    }
  }

  console.log(`[executor:trySelectorsSimple] no selectors matched among ${selectors.length} candidates after ${(Date.now() - startTime)}ms`);
  return null;
}


/** Fallback tries based on text hints or common patterns */
async function fallbackSelectors(page: Page, originalSelectors: string[] = [], textHint?: string): Promise<string | null> {
  const candidates: string[] = [];
  // debug log what we're given
  console.log(`[executor:fallbackSelectors] textHint='${textHint ?? ""}' originalSelectors=[${(originalSelectors || []).slice(0,5).join(", ")}] -> generating fuzzy candidates`);

  if (textHint && typeof textHint === "string" && textHint.trim().length > 0) {
    const clean = textHint.trim().replace(/["']/g, "");
    // don't allow single-character or too-short fallbacks to avoid noise
    if (clean.length > 2) {
      candidates.push(`:has-text("${clean}")`);
      candidates.push(`button:has-text("${clean}")`);
    }
    // partial words, require >2 chars (existing behavior) but add a safety filter
    const parts = textHint.split(/\s+/).slice(0, 3);
    for (const p of parts) if (p.length > 2) candidates.push(`:has-text("${p}")`);
  }
  // common fallbacks
  candidates.push("button:has-text('Create')");
  candidates.push("button:has-text('+')");

  // try the visible original selectors as soft fallback (append original selectors)
  for (const s of originalSelectors) if (s && s.length > 0) candidates.push(s);

  console.log(`[executor:fallbackSelectors] candidates preview: ${candidates.slice(0, 10).join(" | ")}`);
  const found = await trySelectorsSimple(page, candidates, 800);
  return found;
}

/** Save screenshot + meta for a checkpoint
 *  NOTE: signature kept same as before so calling code doesn't change.
 *  Behavior: prefer element-level screenshots, wait for selectors/expected dialog, fallback to full-page.
 */
// Replace the existing saveCheckpoint with this version (always full-page)
async function saveCheckpoint(page: Page, outDir: string, taskId: string, checkpointName: string, actionIndex: number, action: any, selectorUsed: string | null, plannerConfidence?: number) {
  const ckptDir = path.join(outDir, taskId, checkpointName);
  ensureDir(ckptDir);

  // descriptive unique filename to avoid overwriting
  const shotFilename = `${String(actionIndex).padStart(2, "0")}_${checkpointName.replace(/\s+/g,'_')}_${Date.now()}.png`;
  const shotPath = path.join(ckptDir, shotFilename);

  const writeMeta = (selector: string | null) => {
    const meta = {
      task_id: taskId,
      checkpoint: checkpointName,
      action_index: actionIndex,
      action_type: action?.type ?? null,
      selector_used: selector,
      notes: action?.notes ?? null,
      url: page.url(),
      timestamp: nowIso(),
      planner_confidence: plannerConfidence ?? null
    };
    fs.writeFileSync(path.join(ckptDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    return { shotPath, metaPath: path.join(ckptDir, "meta.json") };
  };

  // If an expected dialog or verification selectors are provided, wait for them first (best-effort)
  const verificationCandidates: string[] = [];
  // prefer explicit recently-used selector (e.g., lastSelectorUsed passed in)
  if (selectorUsed) verificationCandidates.push(selectorUsed);
  if (action?.expected_dialog) verificationCandidates.push(action.expected_dialog);
  if (Array.isArray(action?.wait_for)) verificationCandidates.push(...action.wait_for);

  let waitedFor = null;
  for (const v of verificationCandidates) {
    try {
      console.log(`[executor] saveCheckpoint: waiting for verification selector '${v}' (timeout ${action?.dialogTimeoutMs ?? 2500})`);
      await page.waitForSelector(v, { timeout: action?.dialogTimeoutMs ?? 2500 });
      waitedFor = v;
      break;
    } catch {
      // try next verification candidate
      continue;
    }
  }

  // Always take a full-page screenshot (user requested)
  try {
    await page.screenshot({ path: shotPath, fullPage: true });
    // If we waited for a selector, prefer that in meta, otherwise pass selectorUsed param
    writeMeta(waitedFor ?? selectorUsed);
    console.log(`[executor] saved full-page screenshot -> ${shotPath} (waited_for=${String(waitedFor ?? selectorUsed)})`);
    return { shotPath, metaPath: path.join(ckptDir, "meta.json") };
  } catch (err) {
    console.warn("[executor] full-page screenshot failed:", err);
    writeMeta(waitedFor ?? selectorUsed);
    return { shotPath: null, metaPath: path.join(ckptDir, "meta.json") };
  }
}


/** Robust fill helper: tries fill, then focuses + keyboard.type if allowed */
async function tryFillWithFallback(page: Page, selectors: string[], text: string, timeoutMs = 5000, fallbackToKeyboard = false): Promise<{ success: boolean; tried: string[]; errors: any[] }> {
  const tried: string[] = [];
  const errors: any[] = [];

  // try to find input-like selectors first
  for (const s of selectors) {
    if (!s || typeof s !== "string") continue;
    tried.push(s);
    try {
      const loc = page.locator(s).first();
      const count = await loc.count().catch(() => 0);
      if (count === 0) continue;
      // If locator resolves to an input-like element, attempt fill
      try {
        await loc.fill(text, { timeout: timeoutMs });
        return { success: true, tried, errors };
      } catch (e) {
        // If fill fails because element is not input, try focus+type if allowed
        if (fallbackToKeyboard) {
          try {
            await loc.focus({ timeout: timeoutMs });
            await page.keyboard.type(text, { delay: 40 });
            return { success: true, tried, errors };
          } catch (e2) { errors.push(e2); }
        } else {
          errors.push(e);
        }
      }
    } catch (e) {
      errors.push(e);
    }
  }

  // If no inputs matched and fallbackToKeyboard true, try focusing body and typing
  if (fallbackToKeyboard) {
    try {
      await page.keyboard.type(text, { delay: 40 });
      return { success: true, tried, errors };
    } catch (e) {
      errors.push(e);
    }
  }

  return { success: false, tried, errors };
}

/** Robust clickable check: combines heuristics + on-screen and enabled checks */
async function isSelectorClickable(page: Page, selector: string): Promise<boolean> {
  if (!selector) return false;
  try {
    const loc = page.locator(selector).first();
    const count = await loc.count().catch(() => 0);
    if (count === 0) return false;

    const visible = await loc.isVisible().catch(() => false);
    if (!visible) return false;

    // boundingBox helps ensure it's rendered and (roughly) interactable
    const box = await loc.boundingBox().catch(() => null);
    if (!box) return false;

    const enabled = await loc.isEnabled().catch(() => false);

    // gather DOM hints
    const details = await loc.evaluate((el: Element) => {
      return {
        tag: (el.tagName || "").toLowerCase(),
        role: el.getAttribute ? (el.getAttribute("role") || "") : "",
        hasOnClick: !!((el as any).onclick || (el.getAttribute && el.getAttribute("onclick"))),
        hasTabIndex: el.hasAttribute ? el.hasAttribute("tabindex") : false
      };
    }).catch(() => ({ tag: "", role: "", hasOnClick: false, hasTabIndex: false }));

    const { tag = "", role = "", hasOnClick = false, hasTabIndex = false } = details as any;

    // Basic pass if element is an inherently interactive tag and enabled
    if (["button", "a", "input"].includes(tag) && enabled) return true;

    // Role-based interactive elements
    if (/button|link|menuitem|option|tab|checkbox|radio/i.test(role) && enabled) return true;

    // If element has onclick or tabindex and is enabled OR hasOnClick + boundingBox, consider clickable
    if (hasOnClick && (enabled || box)) return true;

    if (hasTabIndex && enabled) return true;

    return false;
  } catch {
    return false;
  }
}


/** Check whether a selector resolves to a fillable control (input/textarea/contenteditable) */
async function isSelectorFillable(page: Page, selector: string): Promise<boolean> {
  if (!selector) return false;
  try {
    const loc = page.locator(selector).first();
    const count = await loc.count().catch(() => 0);
    if (count === 0) return false;
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) return false;
    // evaluate tag / attributes on the element to detect input-like or contenteditable
    const tag = await loc.evaluate((el: any) => el && el.tagName && el.tagName.toLowerCase());
    if (!tag) return false;
    if (tag === "input" || tag === "textarea") return true;
    // detect contenteditable or role=textbox
    const ce = await loc.evaluate((el: any) => el && (el.getAttribute && el.getAttribute("contenteditable") === "true"));
    if (ce) return true;
    // role attribute check
    const role = await loc.evaluate((el: any) => el && el.getAttribute && el.getAttribute("role"));
    if (role && role.toLowerCase().includes("textbox")) return true;
    return false;
  } catch {
    return false;
  }
}

/** Ask LLM for recovery selectors for a failing action (single attempt)
 *  Be tolerant: planner might return string, object, or text — try to parse selectors robustly.
 */
async function askPlannerForRecovery(instruction: string, domSnapshot: any, failingAction: any): Promise<string[] | null> {
  const recoveryInstruction = `Recovery request: The following action failed: ${JSON.stringify(failingAction)}. Based on the DOM snapshot, return JSON with a top-level "plan" array where actions include "selector" arrays offering alternative selectors that could match this control. Keep response concise.`;
  try {
    const plannerOut = await callPlanner(recoveryInstruction, domSnapshot);

    // plannerOut may be string or already parsed
    let parsed: any = plannerOut;
    if (typeof plannerOut === "string") {
      try { parsed = JSON.parse(plannerOut); } catch { parsed = plannerOut; }
    }

    const selectors: string[] = [];

    const collectFrom = (obj: any) => {
      if (!obj) return;
      if (Array.isArray(obj)) {
        for (const item of obj) collectFrom(item);
      } else if (typeof obj === "object") {
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (k === "selector" || k === "selector_candidates" || k === "selectors") {
            if (Array.isArray(v)) selectors.push(...v.filter((x: any) => typeof x === "string" && x.trim().length > 0));
          } else {
            collectFrom(v);
          }
        }
      }
    };

    collectFrom(parsed);

    const uniq = Array.from(new Set(selectors)).map(s => s.trim()).filter(Boolean).slice(0, 12);
    return uniq.length ? uniq : null;
  } catch (err) {
    console.warn("Recovery planner call failed:", err);
    return null;
  }
}


/**
* Helper: filter a list of selectors using a predicate (isSelectorClickable/isSelectorFillable)
* This implements the change: only accept selectors that pass the appropriate check for click/fill.
*/
async function filterSelectorsByCheck(page: Page, selectors: string[] = [], checkFn?: (p: Page, s: string) => Promise<boolean>): Promise<string[]> {
  if (!checkFn) return selectors.filter(Boolean);
  const out: string[] = [];
  for (const s of selectors) {
    if (!s || typeof s !== "string") continue;
    try {
      const ok = await checkFn(page, s).catch(() => false);
      if (ok) out.push(s);
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * Main executor: execute checkpointed plan structure (checkpoints -> action_sequence)
 * - writes screenshot + meta.json per checkpoint
 * - single LLM recovery attempt per failing action
 */
export async function executeCheckpointedPlan(page: Page, checkpointedPlan: any, opts?: { taskId?: string; outDir?: string; plannerConfidence?: number; instruction?: string }) {
  const taskId = opts?.taskId || checkpointedPlan?.task_id || "task";
  const outDir = opts?.outDir || path.resolve(process.cwd(), "outputs");
  ensureDir(outDir);
  const plannerConfidence = opts?.plannerConfidence;
  const instruction = opts?.instruction ?? "";

  const checkpoints = checkpointedPlan?.checkpoints || (checkpointedPlan?.plan ? [{ name: "plan", action_sequence: checkpointedPlan.plan }] : []);
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) throw new Error("No checkpoints in plan");

  for (let ck = 0; ck < checkpoints.length; ++ck) {
    const checkpoint = checkpoints[ck];
    // const name = checkpoint.name || `checkpoint_${ck}`;
    let name = checkpoint.name + "_checkpoint" || `checkpoint_${ck}`;
    const actions: PlanAction[] = Array.isArray(checkpoint.action_sequence) ? checkpoint.action_sequence : [];
    console.log(`\n=== Executing checkpoint [${ck}] ${name} (${actions.length} actions) ===`);

    // lastSelectorUsed is set when a waitForSelector succeeded (or recovery succeeded).
    // We'll reuse it one-shot for the immediate next click/fill that logically depends on it.
    let lastSelectorUsed: string | null = null;

    for (let ai = 0; ai < actions.length; ++ai) {
      const action = actions[ai];
      if (!action) {
        console.warn(`Skipping undefined action at index ${ai}`);
        continue;
      }
      try {
        // Determine if we should allow one-shot reuse of remembered selector.
        // Condition: previous action was waitForSelector and current action is click or fill.
        const prevAction = ai > 0 ? actions[ai - 1] : null;
        const shouldUseLastSelectorOneShot = !!(prevAction && prevAction.type === "waitForSelector" && (action.type === "click" || action.type === "fill") && lastSelectorUsed);

        // chosenSelector is the actual selector we used for this action (for logging)
        let chosenSelector: string | null = null;

        if (action.type === "waitForSelector") {
          const selectors = action.selector || action.selector_candidates || [];
          const chosen = await trySelectorsSimple(page, selectors, 1200);
          if (chosen) {
          // Only *remember* as a one-shot if the matched selector is the top-priority candidate.
            // This avoids unrelated visible elements (e.g., "New page") being remembered and
            // reused by the next click when the intent was to interact with a different control.
            // const topCandidate = Array.isArray(action.selector) && action.selector.length ? action.selector[0] : null;
            // if (topCandidate && chosen === topCandidate) {
            //   lastSelectorUsed = chosen;
            //   console.log(`[executor] remembered selector from waitForSelector (top candidate): ${chosen}`);
            // } else {
            //   // keep useful metadata but do NOT set for one-shot reuse
            //   lastSelectorUsed = null;
            //   console.log(`[executor] matched waitForSelector candidate='${chosen}' but did NOT set one-shot (topCandidate='${topCandidate}')`);
            // }
            // chosenSelector = chosen;
            // await page.waitForSelector(chosen, { timeout: action.timeoutMs ?? 5000 }).catch(() => {});

          lastSelectorUsed = chosen;
          chosenSelector = chosen;
          console.log(`[executor] remembered selector from waitForSelector: ${chosen}`);
          await page.waitForSelector(chosen, { timeout: action.timeoutMs ?? 5000 }).catch(() => {});
          } else {
            console.log("[executor] waitForSelector: no selector matched — throwing to allow recovery");
            throw new Error("waitForSelector: no selector matched");
          }
        } else if (action.type === "click") {
          // If one-shot is available, verify it's actually clickable before attempting to use it.
          if (shouldUseLastSelectorOneShot && lastSelectorUsed) {
            const ok = await isSelectorClickable(page, lastSelectorUsed).catch(() => false);
            if (!ok) {
              console.log(`[executor] remembered selector is NOT clickable, discarding one-shot: ${lastSelectorUsed}`);
              // Clear it so it's not reused; (this is the single-line clearing option)
              lastSelectorUsed = null;
            } else {
              console.log(`[executor] one-shot selector available for next action (click): ${lastSelectorUsed}`);
            }
          }

          // build candidate list; if shouldUseLastSelectorOneShot and it's still present, put lastSelectorUsed first
          const selectorsOrig = action.selector || action.selector_candidates || [];
          const mergedSelectors: string[] = [];
          if (shouldUseLastSelectorOneShot && lastSelectorUsed) {
            mergedSelectors.push(lastSelectorUsed);
          }
          for (const s of selectorsOrig) if (s && !mergedSelectors.includes(s)) mergedSelectors.push(s);
          const filteredCandidates = await filterSelectorsByCheck(
            page,
            mergedSelectors.length ? mergedSelectors : selectorsOrig,
            isSelectorClickable
          );

          if (!filteredCandidates || filteredCandidates.length === 0) {
            console.log("[executor] No clickable candidates after filtering — skipping direct click (will trigger recovery).");
            throw new Error("click: no clickable selector matched");
          }

          let chosen = await trySelectorsSimple(
            page,
            filteredCandidates.length ? filteredCandidates : selectorsOrig,
            1200
          );

          if (!chosen) {
            // final heuristic: try clicking by visible text if action.text is present
            if (action.text && typeof action.text === "string" && action.text.trim().length > 0) {
              const textLoc = `:has-text("${action.text.trim().replace(/["']/g, "")}")`;
              try {
                await page.click(textLoc, { timeout: action.timeoutMs ?? 4000 });
                lastSelectorUsed = textLoc;
                chosen = textLoc;
              } catch { /* continue to error below */ }
            }
          }
          if (!chosen) throw new Error("click: no selector matched");

          // If we used the remembered selector one-shot, clear it now (don't reuse later)
          if (shouldUseLastSelectorOneShot && lastSelectorUsed && chosen === lastSelectorUsed) {
            console.log(`[executor] one-shot selector USED for click, clearing remembered selector: ${chosen}`);
            lastSelectorUsed = null;
          } else {
            // update lastSelectorUsed to the chosen selector for potential recovery/helpful metadata,
            // but do NOT treat this as a preserved remembered selector for later actions
            lastSelectorUsed = chosen;
          }

          chosenSelector = chosen;
          // perform click
          await page.click(chosen, { timeout: action.timeoutMs ?? 5000 });
          // if a dialog is expected, enforce that it appears; otherwise throw so recovery can attempt
          if (action.expected_dialog) {
            const appeared = await page.waitForSelector(action.expected_dialog, { timeout: action.dialogTimeoutMs ?? 3000 }).then(() => true).catch(() => false);
            if (!appeared) {
              throw new Error(`click: expected dialog '${action.expected_dialog}' did not appear after click`);
            }
          }
        } else if (action.type === "fill") {
          // If one-shot is available, verify it's actually fillable before attempting to use it.
          if (shouldUseLastSelectorOneShot && lastSelectorUsed) {
            const ok = await isSelectorFillable(page, lastSelectorUsed).catch(() => false);
            if (!ok) {
              console.log(`[executor] remembered selector is NOT fillable, discarding one-shot: ${lastSelectorUsed}`);
              // Clear it so it's not reused; (single-line clearing option)
              lastSelectorUsed = null;
            } else {
              console.log(`[executor] one-shot selector available for next action (fill): ${lastSelectorUsed}`);
            }
          }

          // build candidate list; reuse lastSelectorUsed one-shot if appropriate
          const selectorsOrig = action.selector || action.selector_candidates || [];
          const mergedSelectors: string[] = [];
          if (shouldUseLastSelectorOneShot && lastSelectorUsed) {
            mergedSelectors.push(lastSelectorUsed);
          }
          for (const s of selectorsOrig) if (s && !mergedSelectors.includes(s)) mergedSelectors.push(s);

          const filteredFillCandidates = await filterSelectorsByCheck(page, mergedSelectors.length ? mergedSelectors : selectorsOrig, isSelectorFillable);

          // Strict enforcement: require at least one fillable candidate
          if (!filteredFillCandidates || filteredFillCandidates.length === 0) {
            console.log("[executor] No fillable candidates after filtering — skipping direct fill (will trigger recovery).");
            throw new Error("fill: no fillable selector matched");
          }

          const fallbackToKeyboard = !!action.fallback_to_keyboard;
          const { success, tried, errors } = await tryFillWithFallback(
            page,
            filteredFillCandidates.length ? filteredFillCandidates : selectorsOrig,
            String(action.text ?? ""),
            action.timeoutMs ?? 5000,
            fallbackToKeyboard
          );
          if (!success) {
            // try additional fallback heuristics: wait for a dialog or input to appear then try again
            if (action.expected_dialog) {
              await page.waitForSelector(action.expected_dialog, { timeout: action.dialogTimeoutMs ?? 2500 }).catch(() => {});
              const retry = await trySelectorsSimple(page, mergedSelectors.length ? mergedSelectors : selectorsOrig, 1000);
              if (retry) {
                const res = await tryFillWithFallback(page, [retry], String(action.text ?? ""), action.timeoutMs ?? 5000, fallbackToKeyboard);
                if (res.success) {
                  // if we used the remembered selector one-shot, clear it now
                  if (shouldUseLastSelectorOneShot && lastSelectorUsed === retry) lastSelectorUsed = null;
                  else lastSelectorUsed = retry;
                  chosenSelector = retry;
                  continue;
                }
              }
            }
            throw new Error(`tryFillWithFallback: failed to fill value. Tried selectors: ${JSON.stringify(tried)}; errors: ${JSON.stringify(errors)}`);
          } else {
            // if we used the remembered selector one-shot and it was used, clear it
            if (shouldUseLastSelectorOneShot && lastSelectorUsed && mergedSelectors[0] === lastSelectorUsed) {
              console.log(`[executor] one-shot selector USED for fill, clearing remembered selector: ${lastSelectorUsed}`);
              chosenSelector = lastSelectorUsed;
              lastSelectorUsed = null;
            } else {
              // set chosenSelector to the first tried selector if available
              chosenSelector = (action.selector && action.selector[0]) || lastSelectorUsed;
              lastSelectorUsed = chosenSelector;
            }
          }
        } else if (action.type === "waitForTimeout") {
          await page.waitForTimeout(action.timeoutMs ?? 500);
        } else if (action.type === "goto") {
          // Support both new plan key "url" and legacy "text" or selector[0]
          const url = (action as any).url || action.text || (Array.isArray(action.selector) && action.selector[0]) || null;
          if (!url) throw new Error("goto action missing url in 'url' or 'text' or selector[0]");
          await page.goto(String(url), { waitUntil: "domcontentloaded", timeout: action.timeoutMs ?? 30000 });
          // clearing remembered selector because navigation typically invalidates it
          lastSelectorUsed = null;
          chosenSelector = url;
        } else if (action.type === "screenshot") {
          await saveCheckpoint(page, outDir, taskId, action.checkpoint_name || name, ai, action, lastSelectorUsed, plannerConfidence);
        } else {
          console.warn("Unknown action type:", action.type);
        }

        // Per-action completion log: show the selector (or url) that was actually used/remembered
        console.log(
          `[executor] ✅ Completed actionIndex=${ai} (${action.type}) at checkpoint='${name}' ` +
          (chosenSelector ? `used='${chosenSelector}' ` : (lastSelectorUsed ? `remembered='${lastSelectorUsed}' ` : "")) +
          ((action as any).url ? `url='${(action as any).url}'` : "")
        );
      } catch (err) {
        console.warn(`Action failed at checkpoint=${name} actionIndex=${ai} type=${action.type}:`, err);

        // Recovery attempt (single)
        console.log("Attempting LLM-based recovery for this action...");
        await page.waitForTimeout(800);
        const recoverySnapObj = await captureDomSummary(page, { outDir: path.join(outDir, taskId, "recovery") }).catch((e) => {
          console.warn("captureDomSummary failed:", e);
          return { snapshot: null };
        });
        const recoverySnap = recoverySnapObj?.snapshot ?? null;
        const recoverySelectors = await askPlannerForRecovery(instruction || "Perform task", recoverySnap, action);

        let recovered = false;
        if (recoverySelectors && recoverySelectors.length > 0) {
          console.log("Recovery selectors:", recoverySelectors);
          const filteredRecoveryCandidates = (action.type === 'click') ? await filterSelectorsByCheck(page, recoverySelectors, isSelectorClickable)
            : (action.type === 'fill') ? await filterSelectorsByCheck(page, recoverySelectors, isSelectorFillable)
            : recoverySelectors;

          if ((action.type === 'click' || action.type === 'fill') && (!filteredRecoveryCandidates || filteredRecoveryCandidates.length === 0)) {
            console.log("[executor] Recovery returned no candidates that satisfy click/fill checks.");
          } else {
            // Order candidates to prefer ones that mention action.text
            let orderedCandidates = (filteredRecoveryCandidates || []).slice();
            const textHint = action?.text ? String(action.text).trim().toLowerCase() : null;
            if (textHint) {
              orderedCandidates.sort((a, b) => {
                const score = (s: string) => {
                  const low = (s || "").toLowerCase();
                  if (low.includes(`:has-text("${textHint}")`) || low.includes(textHint)) return -1;
                  return 0;
                };
                return score(a) - score(b);
              });
            }

            // Try candidates sequentially and verify expected result for each
            for (const candidate of orderedCandidates) {
              try {
                console.log(`[executor] recovery trying candidate: ${candidate}`);
                if (action.type === "click") {
                  await page.click(candidate, { timeout: action.timeoutMs ?? 5000 }).catch((e) => { throw e; });
                  if (action.expected_dialog) {
                    const ok = await page.waitForSelector(action.expected_dialog, { timeout: action.dialogTimeoutMs ?? 2500 }).then(() => true).catch(() => false);
                    if (!ok) {
                      console.log(`[executor] recovery candidate ${candidate} clicked but expected dialog did not appear; trying next candidate`);
                      continue;
                    }
                  }
                  recovered = true;
                  lastSelectorUsed = candidate;
                  break;
                } else if (action.type === "fill") {
                  const res = await tryFillWithFallback(page, [candidate], String(action.text ?? ""), action.timeoutMs ?? 5000, !!action.fallback_to_keyboard);
                  if (!res.success) {
                    console.log(`[executor] recovery fill failed for ${candidate}; errors: ${JSON.stringify(res.errors || []).slice(0,200)}`);
                    continue;
                  }
                  if (action.expected_dialog) {
                    const ok = await page.waitForSelector(action.expected_dialog, { timeout: action.dialogTimeoutMs ?? 2500 }).then(() => true).catch(() => false);
                    if (!ok) {
                      console.log(`[executor] recovery fill ${candidate} succeeded but expected dialog didn't appear; trying next candidate`);
                      continue;
                    }
                  }
                  recovered = true;
                  lastSelectorUsed = candidate;
                  break;
                } else if (action.type === "waitForSelector") {
                  await page.waitForSelector(candidate, { timeout: action.timeoutMs ?? 5000 }).then(() => { recovered = true; lastSelectorUsed = candidate; }).catch(() => {});
                  if (recovered) break;
                } else {
                  // Generic fallback: try click and assume success if no expected_dialog is required
                  try {
                    await page.click(candidate, { timeout: action.timeoutMs ?? 5000 });
                    recovered = true;
                    lastSelectorUsed = candidate;
                    break;
                  } catch {
                    continue;
                  }
                }
              } catch (eCandidate) {
                console.warn(`[executor] recovery attempt with candidate ${candidate} threw:`, eCandidate);
                // continue to next candidate
                continue;
              }
            } // end for each candidate
          } // end else: had candidates
        } // end if recoverySelectors

        if (!recovered) {
          // Save failure and abort
          const ckptDir = path.join(outDir, taskId, name);
          ensureDir(ckptDir);
          fs.writeFileSync(path.join(ckptDir, "failure.json"), JSON.stringify({
            task_id: taskId,
            checkpoint: name,
            action_index: ai,
            action,
            error: String(err),
            url: page.url(),
            timestamp: nowIso()
          }, null, 2), "utf8");
          throw new Error(`Executor aborted: unrecoverable action at checkpoint ${name}, actionIndex ${ai}: ${err}`);
        } else {
          console.log("Recovery succeeded, continuing execution of checkpoint.");
        }
      }
    } // end actions loop

    // Ensure checkpoint screenshot exists; if not, save one implicitly
    // const ckptDir = path.join(outDir, taskId, name);
    // const metaPath = path.join(ckptDir, "meta.json");
    // if (!fs.existsSync(metaPath)) {
    //   const lastAction = actions.length ? actions[actions.length - 1] : {};
    //   // await saveCheckpoint(page, outDir, taskId, name, Math.max(0, actions.length - 1), lastAction, null, plannerConfidence);
    //   await saveCheckpoint(page, outDir, taskId, name, Math.max(0, actions.length - 1), lastAction, lastSelectorUsed, plannerConfidence);
    //   console.log("Saved implicit checkpoint screenshot for", name);
    // }

    // Ensure checkpoint screenshot exists; if not, save one implicitly
      const ckptDir = path.join(outDir, taskId, name);
      ensureDir(ckptDir);
      const metaPath = path.join(ckptDir, "meta.json");
      const markerPath = path.join(ckptDir, ".screenshot_saved");

      // if any of: meta.json exists OR any png exists OR a marker exists => skip implicit save
      const pngExists = fs.readdirSync(ckptDir).some(f => /\.png$/i.test(f));
      if (!fs.existsSync(metaPath) && !fs.existsSync(markerPath) && !pngExists) {
        const lastAction = actions.length ? actions[actions.length - 1] : {};
        await saveCheckpoint(page, outDir, taskId, name, Math.max(0, actions.length - 1), lastAction, lastSelectorUsed, plannerConfidence);
        // create marker so future implicit saves won't duplicate
        try { fs.writeFileSync(markerPath, `${nowIso()}\n`); } catch (e) { /* ignore */ }
        console.log("Saved implicit checkpoint screenshot for", name);
      } else {
        console.log(`Skipping implicit screenshot for '${name}' (meta/png/marker present).`);
      }

  } // end checkpoints loop

  return { status: "success", task_id: taskId, checkpoints_executed: checkpoints.length, timestamp: nowIso() };
}
