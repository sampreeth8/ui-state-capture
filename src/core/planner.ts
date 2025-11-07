// src/core/planner.ts
import { generateText } from "ai"; // Vercel AI SDK
import { openai } from "@ai-sdk/openai";
import { DomSnapshot } from "./dom_capture.js";

/**
 * Planner / PlanAction types
 * Extended to include fields that executor expects:
 *  - url (for goto)
 *  - expected_dialog, dialogTimeoutMs (modal expectations)
 *  - fallback_to_keyboard (fill fallback)
 */
export type PlanAction = {
  type: "click" | "fill" | "waitForSelector" | "screenshot" | "goto" | "waitForTimeout";
  // selector candidates (Playwright locators)
  selector?: string[];
  // alternative name returned by some LLMs
  selector_candidates?: string[];
  // textual payload for fill, or free text hints
  text?: string;
  // for goto actions: explicit url
  url?: string;
  timeoutMs?: number;
  // screenshot actions require checkpoint_name
  checkpoint_name?: string;
  // executor-aware fields:
  expected_dialog?: string;
  dialogTimeoutMs?: number;
  fallback_to_keyboard?: boolean;
  notes?: string;
};

export type PlannerOutput = {
  plan?: PlanAction[]; // fallback if LLM returns plan as a flat array
  app?: string;
  task_id?: string;
  description?: string;
  start_url?: string;
  checkpoints?: { name: string; notes?: string; action_sequence: PlanAction[] }[]; // preferred checkpointed format
  confidence?: number;
  explain?: string;
};

function safeStringify(v: any) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** Basic validation for a single PlanAction.
 *  - Ensures required fields are present for given action types (e.g., goto needs url; screenshot needs checkpoint_name).
 *  - Normalizes selector_candidates -> selector if needed.
 */
function validateAction(a: any, idx: number, context = "") {
  if (!a || typeof a !== "object") throw new Error(`Plan action[${idx}]${context} is not an object.`);
  if (!a.type || typeof a.type !== "string") throw new Error(`Plan action[${idx}]${context} missing 'type'.`);
  const allowed = ["click","fill","waitForSelector","screenshot","goto","waitForTimeout"];
  if (!allowed.includes(a.type)) throw new Error(`Plan action[${idx}]${context} has invalid type '${a.type}'. Allowed: ${allowed.join(", ")}`);
  // coerce selector_candidates -> selector for validation convenience
  if (!a.selector && Array.isArray(a.selector_candidates)) a.selector = a.selector_candidates;

  if (a.selector && !Array.isArray(a.selector)) throw new Error(`Plan action[${idx}]${context} selector must be an array.`);
  if (a.selector && a.selector.some((s: any) => typeof s !== "string")) throw new Error(`Plan action[${idx}]${context} selector entries must be strings.`);

  if (a.type === "screenshot") {
    if (!a.checkpoint_name || typeof a.checkpoint_name !== "string") {
      throw new Error(`Plan action[${idx}]${context} is a screenshot action and must include a short 'checkpoint_name' (snake_case).`);
    }
  }

  if (a.type === "goto") {
    // require explicit url for goto action (executor prefers action.url)
    if (!a.url || typeof a.url !== "string" || !a.url.startsWith("http")) {
      throw new Error(`Plan action[${idx}]${context} is a goto but is missing a valid 'url' (must start with http/https).`);
    }
  }

  if (a.type === "fill") {
    // fill actions should have at least one selector candidate and a text
    if (!a.text || typeof a.text !== "string") {
      throw new Error(`Plan action[${idx}]${context} is a fill but missing 'text' to enter.`);
    }
    if (!a.selector || !Array.isArray(a.selector) || a.selector.length === 0) {
      throw new Error(`Plan action[${idx}]${context} fill actions must include at least one selector candidate (preferably an input-like locator).`);
    }
  }

  // Optional: ensure waitForSelector has selector
  if (a.type === "waitForSelector") {
    if (!a.selector || !Array.isArray(a.selector) || a.selector.length === 0) {
      throw new Error(`Plan action[${idx}]${context} waitForSelector must include selector array.`);
    }
  }

  // allow extra executor-aware fields (expected_dialog, fallback_to_keyboard, dialogTimeoutMs)
}

/** Helper: extract the first JSON-like substring from LLM output */
function extractJsonLike(text: string): string | null {
  if (!text || typeof text !== "string") return null;
  // Try to find the first "{" that starts a JSON document and last matching "}".
  const first = text.indexOf("{");
  if (first === -1) return null;
  // Attempt incremental parse: grow to next '}' until parse succeeds or run out
  for (let i = text.length - 1; i >= first; --i) {
    const candidate = text.slice(first, i + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // continue shrinking i
    }
  }
  return null;
}

/** Normalize common variations LLMs produce:
 *  - If top-level is an array, treat as plan array.
 *  - Accept fields 'plan' or 'checkpoints' or even 'actions' inside checkpoints.
 *  - Normalize selector_candidates -> selector.
 */
function normalizeParsedPlanner(parsed: any): PlannerOutput {
  if (!parsed || typeof parsed !== "object") return {};

  // Case: raw array -> wrap as plan
  if (Array.isArray(parsed)) {
    return { plan: parsed };
  }

  // If parsed has top-level 'plan' or 'checkpoints' already, just return as-is (we'll validate later)
  if (parsed.plan || parsed.checkpoints) {
    // normalize each plan action's selector fields
    if (Array.isArray(parsed.plan)) {
      parsed.plan = parsed.plan.map((a: any) => {
        if (!a) return a;
        if (!a.selector && a.selector_candidates) a.selector = a.selector_candidates;
        return a;
      });
    }
    if (Array.isArray(parsed.checkpoints)) {
      parsed.checkpoints = parsed.checkpoints.map((cp: any) => {
        if (!cp) return cp;
        // support 'actions' as alternative name
        const action_sequence = cp.action_sequence || cp.actions || cp.plan || [];
        cp.action_sequence = Array.isArray(action_sequence) ? action_sequence.map((a: any) => {
          if (a && !a.selector && a.selector_candidates) a.selector = a.selector_candidates;
          return a;
        }) : [];
        return cp;
      });
    }
    return parsed;
  }

  // Some LLM responses might return { plan: [...] } under a nested "plan" or "result" - attempt to find arrays inside
  const keys = Object.keys(parsed);
  for (const k of keys) {
    const v = parsed[k];
    if (Array.isArray(v)) {
      // heuristically assume this array is the plan
      return { plan: v, app: parsed.app, description: parsed.description, start_url: parsed.start_url, confidence: parsed.confidence, explain: parsed.explain };
    }
  }

  // fallback - return parsed as much as possible
  return parsed;
}

export async function callPlanner(
  instruction: string,
  domSummary: DomSnapshot,
  opts?: { model?: string; maxTokens?: number }
): Promise<PlannerOutput> {
  const model = opts?.model ?? openai("gpt-5");
  // Build a compact "visible" hint for the LLM from domSummary
  // const visible = (domSummary?.visible_elements || []).slice(0, 120).map((e: any) => {
  //   const role = e.role || "";
  //   const name = e.name || "";
  //   const dataTest = e.data_testid || e.data_testid || "";
  //   const placeholder = e.placeholder ? ` placeholder=${e.placeholder}` : "";
  //   return `${role ? `${role}:` : ""}${name}${dataTest ? ` [data-testid=${dataTest}]` : ""}${placeholder}`;
  // }).join("; ");

  const visible = Array.from(
  new Set(
    (domSummary?.visible_elements || [])
      .map(e => {
        const role = e.role || "";
        const name = e.name || "";
        const dataTest = e.data_testid || "";
        const placeholder = e.placeholder ? ` placeholder=${e.placeholder}` : "";
        const text = `${role ? `${role}:` : ""}${name}${dataTest ? ` [data-testid=${dataTest}]` : ""}${placeholder}`;
        return text.trim();
      })
      .filter(text => text && !text.startsWith("img") && text !== "on")
  )
)
.slice(0, 120)
.join("; ");

// const topTextSnippet = (domSummary?.top_texts || []).slice(0, 40).join(" | ");
  const topTextSnippet = Array.from(new Set((domSummary?.top_texts || []).map(t => t.trim()).filter(Boolean))).slice(0, 40).join(" | ");

  // Planner prompt (improved to ask for 'url' and executor-aware fields)
// Updated planner prompt: enforces screenshot after dialog-opening clicks and provides screenshot_selector
// Updated planner prompt: enforces screenshot after dialog-opening clicks and provides screenshot_selector
const prompt = `
You are a precise browser-planner. RETURN ONLY valid JSON matching the schema described below.

Preferred schema (checkpointed format):
{
  "app":"<optional app>",
  "task_id":"<short_snake_case_id>",
  "description":"<short description>",
  "start_url":"<URL to open to start the flow>",
  "checkpoints":[
    {
      "name":"<checkpoint_name_snake_case>",
      "notes?":"<short note>",
      "action_sequence":[
        {
          "type":"goto" | "waitForSelector" | "click" | "fill" | "waitForTimeout" | "screenshot",
          "url?":"<for goto actions only, exact URL string>",
          "selector?":["..."],               // prioritized Playwright-style locator candidates (MUST be non-empty for interactive actions)
          "selector_candidates?":["..."],    // accepted alternative name
          "screenshot_selector?":"...",      // optional: a specific locator target for screenshot actions (prefer dialog/popover/chip)
          "text?":"...",                     // for fill actions (text to enter)
          "timeoutMs?":5000,
          "checkpoint_name?":"...",          // required for screenshot actions
          "expected_dialog?":"role=dialog or other selector", // required when click opens modal/popover
          "dialogTimeoutMs?":3000,
          "fallback_to_keyboard?": true,
          "notes?":"<optional>"
        }
      ],
      "retry_strategy?": { "retries": 1, "backoffMs": 1000 },
      "success_criteria?":"<REQUIRED on final checkpoint>"
    }
  ],
  "confidence": 0.0,
  "explain":"short explanation"
}

MANDATES (follow exactly):
1. ALWAYS return valid JSON ONLY that matches the schema above. If you cannot produce a plan, return {"error":"<short reason>"}.
2. The top-level "start_url" MUST be present.
3. The FIRST interactive navigation SHOULD be a "goto" action inside the first checkpoint. When using goto, the action MUST include "url": "<exact url>".
4. For any interactive action (click/fill/waitForSelector) provide **at least 5 prioritized selector candidates** in the "selector" array. Prefer accessibility locators (role=..., role=button[name='...']), then :has-text("..."), then data-* attributes, then label→input patterns. Do NOT invent impossible CSS classes/IDs — ground selectors in the DOM snapshot.
5. **If a click is expected to open a modal/popover/menu**, the click action **MUST** include an expected_dialog value (a selector for the dialog or a heading inside it) and dialogTimeoutMs where appropriate, and you **MUST** place an immediate screenshot action as the next step in the checkpoint action_sequence. Example:
   {
     "type":"click",
     "selector":["role=button[name='Filter']", "button:has-text('Filter')", ...],
     "expected_dialog":"role=dialog",
     "dialogTimeoutMs":4000
   },
   { "type":"screenshot", "screenshot_selector":"role=dialog", "checkpoint_name":"filter_dialog_open" }
6. For screenshot actions:
   - Provide screenshot_selector that targets the dialog/popover/chip to capture the transient UI state. If no specific selector can be reliably produced, use "body" as a last-resort fallback.
   - The screenshot action must include checkpoint_name.
7. For fill actions ensure at least one selector targets a real form control (input/textarea/role=textbox or label:has-text('...') >> input). If only a custom editor exists, set "fallback_to_keyboard": true.
8. The plan must include a final screenshot action at the end of each checkpoint (so each checkpoint produces a saved screenshot). The executor may also save an implicit screenshot if needed.
9. The final checkpoint MUST include a precise success_criteria string that describes what to assert (exact text or DOM indicator).
10. Keep plans concise (ideally 3–8 checkpoints, 4–12 actions total). Use notes to explain tricky UI shapes or slow rendering.
11. JSON only. No markdown or commentary.

DOM SUMMARY (top visible elements): ${safeStringify(visible)}
Top visible text snippet: ${safeStringify(topTextSnippet)}

USER INSTRUCTION (exact):
${instruction}
`;
  let respText: string;
  try {
    const resp = await generateText({ model, prompt, max_tokens: opts?.maxTokens ?? 1200 } as any);
    respText = resp.text?.trim() ?? "";
  } catch (err) {
    throw new Error(`Planner LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Try to extract JSON substring from respText
  let parsed: any = null;
  const jsonLike = extractJsonLike(respText);
  if (!jsonLike) {
    // As a last resort, try to JSON.parse whole text
    try { parsed = JSON.parse(respText); } catch (e) {
      throw new Error(`Planner response did not contain valid JSON.\nRaw response: ${respText}`);
    }
  } else {
    try { parsed = JSON.parse(jsonLike); } catch (e) {
      // If parsing fails, include raw respText in error to help debugging
      throw new Error(`Failed to parse JSON extracted from planner response.\nExtracted text: ${jsonLike}\nFull response: ${respText}`);
    }
  }

  // Normalize common LLM variations into PlannerOutput shape
  const normalized = normalizeParsedPlanner(parsed);

  // Validate presence of checkpoints or plan
  const hasCheckpoints = Array.isArray(normalized.checkpoints) && normalized.checkpoints.length > 0;
  const hasPlan = Array.isArray(normalized.plan) && normalized.plan.length > 0;
  if (!hasCheckpoints && !hasPlan) {
    // If the LLM returned a top-level array as parsed, normalizeParsedPlanner would have wrapped it, so this should be rare.
    throw new Error(`Planner response missing 'checkpoints' or 'plan' array.\nRaw response: ${respText}`);
  }

  // Validate actions inside checkpoints or plan
  try {
    if (hasCheckpoints) {
      normalized.checkpoints!.forEach((cp: any, cpIdx: number) => {
        if (!cp.name || typeof cp.name !== "string") throw new Error(`Checkpoint[${cpIdx}] missing 'name'`);
        const seq = cp.action_sequence || [];
        if (!Array.isArray(seq)) throw new Error(`Checkpoint[${cpIdx}] action_sequence must be an array`);
        seq.forEach((a: any, idx: number) => validateAction(a, idx, ` in checkpoint[${cpIdx} - ${cp.name}]`));
      });
    }
    if (hasPlan) {
      normalized.plan!.forEach((a: any, idx: number) => validateAction(a, idx));
    }
  } catch (err) {
    throw new Error(`Failed to parse/validate planner JSON.\nRaw response: ${respText}\nError: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Final normalization: ensure selectors are in 'selector' fields for executor convenience
  if (hasPlan) {
    normalized.plan = normalized.plan!.map((a: any) => {
      if (!a.selector && a.selector_candidates) a.selector = a.selector_candidates;
      return a;
    });
  }
  if (hasCheckpoints) {
    normalized.checkpoints = normalized.checkpoints!.map((cp: any) => {
      cp.action_sequence = cp.action_sequence!.map((a: any) => {
        if (!a.selector && a.selector_candidates) a.selector = a.selector_candidates;
        return a;
      });
      return cp;
    });
  }

  return normalized as PlannerOutput;
}
