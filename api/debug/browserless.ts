import type { VercelRequest, VercelResponse } from "@vercel/node";
import playwright from "playwright-core";

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const ws = (process.env.BROWSERLESS_WS || "").replace(/\/playwright(\?|$)/, "$1");
  if (!ws) return res.status(500).json({ ok: false, error: "Missing BROWSERLESS_WS" });

  let browser: playwright.Browser | null = null;
  try {
    // Try CDP first (recommended by Browserless); if it fails, fallback to standard connect.
    try {
      browser = await playwright.chromium.connectOverCDP(ws);
    } catch (e) {
      browser = await playwright.chromium.connect(ws);
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("about:blank");
    res.json({ ok: true, wsHost: new URL(ws).host });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  } finally {
    try { await browser?.close(); } catch {}
  }
}
