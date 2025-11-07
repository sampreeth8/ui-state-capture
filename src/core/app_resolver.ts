import fs from "fs";
import path from "path";
import readline from "readline";
import { generateText } from "ai"; // Vercel AI SDK core
import { openai } from "@ai-sdk/openai"; // OpenAI provider for ai SDK
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



type AppInfo = { app: string; baseUrl: string; authPath?: string | null };

const APPS_PATH = path.resolve(__dirname, "../config/apps.json");

function askCli(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans.trim()); }));
}

export async function resolveAppFromInstruction(instruction: string): Promise<AppInfo | null> {
  // 1) load registry
  const registry = JSON.parse(fs.readFileSync(APPS_PATH, "utf8"));

  // 2) simple rule-based match
  const lower = instruction.toLowerCase();
  for (const key of Object.keys(registry)) {
    if (lower.includes(key)) {
      return { app: key, baseUrl: registry[key].baseUrl, authPath: registry[key].authPath || null };
    }
  }

  // 3) fallback: use Vercel AI SDK (OpenAI provider) to propose a domain
  const prompt = `
You are an assistant that maps a natural-language app mention to its canonical web entry point.
Input: "${instruction}"
Return ONLY valid JSON: either {"app":"<app_key>","base_url":"https://..."} or {"app":"unknown"}.
Prefer widely-known SaaS domains (not internal hosts). Example: Notion -> https://www.notion.so
Return JSON only with no extra commentary.
`;
  const resp = await generateText({
    model: openai("gpt-4o"), // choose a model available to you
    prompt
  });

  let candidate: any = null;
//   console.log("App resolver LLM response:", resp.text);
  try {
    candidate = JSON.parse(resp.text.trim());
  } catch (e) {
    // malformed LLM output -> treat as unknown
    candidate = { app: "unknown" };
  }

  if (!candidate || candidate.app === "unknown") {
    const userUrl = await askCli("I couldn't detect the app. Please provide the base URL (or press Enter to cancel): ");
    if (!userUrl) return null;
    return { app: "custom", baseUrl: userUrl, authPath: null };
  }

  // 4) Ask the user to confirm before opening any URL
  const confirmed = await askCli(`I think you meant "${candidate.app}" at ${candidate.base_url}. Is that correct? (y/n) `);
  if (confirmed.toLowerCase().startsWith("y")) {
    // pick authPath from registry if present
    const authPath = registry[candidate.app]?.authPath || null;
    return { app: candidate.app, baseUrl: candidate.base_url, authPath };
  }

  const provided = await askCli("Please enter the URL you want me to open (or blank to cancel): ");
  if (!provided) return null;
  return { app: candidate.app, baseUrl: provided, authPath: null };
}
