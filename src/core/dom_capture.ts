import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Page } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeText(t: string | null | undefined) {
  if (!t) return "";
  return String(t)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/\b\d{9,}\b/g, "[redacted-number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export type VisibleElement = {
  role: string | null;
  name: string | null;
  tag: string;
  text: string | null;
  placeholder?: string;
  aria: string | null;
  data_testid: string | null;
  href: string | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
};

export type DomSnapshot = {
  url: string;
  title: string;
  viewport?: { width: number; height: number } | undefined;
  visible_elements: VisibleElement[];
  top_texts: string[];
  screenshot_base64: string;
  screenshot_path: string;
  timestamp: string;
};

/**
 * Capture a compact DOM summary + screenshot for LLM planning.
 * @param page Playwright Page already navigated to the start URL
 * @param opts optional settings: { outDir, maxElements }
 */
export async function captureDomSummary(
  page: Page,
  opts?: { outDir?: string; maxElements?: number }
): Promise<{ snapshot: DomSnapshot; outFile: string; shotPath: string }> {
  const outDir = opts?.outDir || path.resolve(process.cwd(), "outputs", "capture");
  const maxElements = opts?.maxElements ?? 200;
  ensureDir(outDir);

  // safe screenshot
  let shotBuf: Buffer;
  try {
    shotBuf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
  } catch (e) {
    console.warn("captureDomSummary: screenshot failed, continuing with empty buffer", e);
    shotBuf = Buffer.from("");
  }
  const shotBase64 = shotBuf.toString("base64");
  const shotPath = path.join(outDir, `screenshot-${Date.now()}.jpg`);
  try {
    if (shotBuf.length > 0) fs.writeFileSync(shotPath, shotBuf);
  } catch (e) {
    console.warn("failed to write screenshot to disk", e);
  }

  // page metadata
  const url = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch (e) {
    // ignore
  }

  // gather visible interactive elements (defensive casting to HTMLElement)
  const rawElements = await page.$$eval(
    "a, button, input, textarea, select, [role], [data-testid], h1,h2,h3,h4",
    (els, max) => {
      const out: any[] = [];
      for (const el of els) {
        try {
          const elem = el as HTMLElement;
          const rect = elem.getBoundingClientRect();
          if (rect.width < 4 || rect.height < 4) continue;
          const style = window.getComputedStyle(elem);
          if (style && (style.visibility === "hidden" || style.display === "none")) continue;

          const role = elem.getAttribute?.("role") || (elem.tagName === "A" ? "link" : null);
          const aria = elem.getAttribute?.("aria-label") || null;
          const dataTest = elem.getAttribute?.("data-testid") || null;
          const innerText =
            typeof elem.innerText === "string" && elem.innerText.trim().length > 0
              ? elem.innerText
              : "value" in elem && (elem as any).value
              ? String((elem as any).value)
              : "";
          const name = aria || (innerText ? innerText.split("\n")[0] : null);
          const text = innerText;
          const tag = elem.tagName;
          const href = elem.getAttribute?.("href") || null;

          out.push({
            role,
            name: name || null,
            tag,
            text: text ? String(text).trim().slice(0, 1000) : null,
            aria,
            dataTest,
            href,
            bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
          });
        } catch (err) {
          // ignore per-element errors
        }
        if (out.length >= max) break;
      }
      return out;
    },
    maxElements
  );

  const visible_elements: VisibleElement[] = rawElements.map((el: any) => ({
    role: el.role || null,
    name: sanitizeText(el.name || el.text),
    tag: el.tag,
    text: sanitizeText(el.text),
    aria: sanitizeText(el.aria),
    data_testid: el.dataTest || null,
    href: el.href || null,
    bbox: el.bbox || null
  }));

  // top visible texts (sampling, defensive)
  const top_texts = await page.$$eval(
    "body *",
    (nodes) =>
      nodes
        .filter((n) => n instanceof HTMLElement && (n as HTMLElement).innerText && String((n as HTMLElement).innerText).trim().length > 0 && String((n as HTMLElement).innerText).length < 200)
        .slice(0, 50)
        .map((n) => (n instanceof HTMLElement ? String((n as HTMLElement).innerText).trim().split("\n").join(" ").slice(0, 120) : ""))
  );

  // safest viewport fetch
  let viewport: { width: number; height: number } | undefined = undefined;
  try {
    // Some Playwright versions expose page.viewportSize()
    // @ts-ignore
    if (typeof page.viewportSize === "function") viewport = (page as any).viewportSize();
  } catch {
    // ignore
  }

  const snapshot: DomSnapshot = {
    url,
    title,
    viewport,
    visible_elements,
    top_texts: (top_texts || []).slice(0, 50),
    screenshot_base64: shotBase64,
    screenshot_path: shotPath,
    timestamp: new Date().toISOString()
  };

  // write snapshot to disk
  const outFile = path.join(outDir, `dom-summary-${Date.now()}.json`);
  try {
    fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (e) {
    console.warn("failed to write dom snapshot to disk", e);
  }

  return { snapshot, outFile, shotPath };
}
