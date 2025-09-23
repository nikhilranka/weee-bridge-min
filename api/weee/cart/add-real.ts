import type { VercelRequest, VercelResponse } from "@vercel/node";
import playwright from "playwright-core";

function requireAuth(req: VercelRequest, res: VercelResponse) {
  const auth = (req.headers.authorization || "").replace("Bearer ", "");
  if (!auth || auth !== process.env.ACTIONS_BEARER_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function openBrowser() {
  let ws = process.env.BROWSERLESS_WS || "";
  ws = ws.replace(/\/playwright(\?|$)/, "$1"); // normalize legacy URL
  if (!ws) throw new Error("Missing BROWSERLESS_WS");
  // Try CDP then fallback
  try { return await playwright.chromium.connectOverCDP(ws); }
  catch { return await playwright.chromium.connect(ws); }
}

async function applySessionCookie(context: playwright.BrowserContext) {
  const cookieJson = process.env.WEEE_SESSION_COOKIE;
  if (!cookieJson) return false;
  const cookies = JSON.parse(cookieJson);
  if (Array.isArray(cookies) && cookies.length) { await context.addCookies(cookies as any); return true; }
  return false;
}

async function ensureLoggedIn(page: playwright.Page) {
  await page.goto("https://www.sayweee.com/en", { waitUntil: "domcontentloaded" });
  const url = page.url();
  if (/login|signin/i.test(url)) {
    throw new Error("Weee session is not logged in (cookie expired or invalid). Update WEEE_SESSION_COOKIE.");
  }
}

async function addItem(page: playwright.Page, query: string, qty = 1) {
  // Search
  const searchSel = 'input[placeholder*="Search"]';
  await page.waitForSelector(searchSel, { timeout: 15000 });
  await page.fill(searchSel, query);
  await page.keyboard.press("Enter");
  await page.waitForLoadState("domcontentloaded");

  // Pick first result
  const firstCard = page.locator('[data-testid*="product-card"]').first();
  if ((await firstCard.count()) === 0) return { added: false, query, reason: "No results" };
  await firstCard.click();

  // Add to cart
  const addBtn = page.locator('button:has-text("Add")').first();
  await addBtn.click({ timeout: 15000 });

  // Increase quantity
  if (qty > 1) {
    const plusBtn = page.locator('button[aria-label*="increase"]').first();
    for (let i = 1; i < qty; i++) { await plusBtn.click(); await page.waitForTimeout(120); }
  }

  const title = (await page.locator("h1, h2").first().textContent().catch(() => null))?.trim();
  return { added: true, query, title: title || query, qty };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  if (!requireAuth(req, res)) return;

  const items = Array.isArray((req.body as any)?.items) ? (req.body as any).items : [];
  if (!items.length) return res.status(400).json({ error: "items[] required" });

  let browser: playwright.Browser | null = null;
  try {
    browser = await openBrowser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
    });
    const page = await context.newPage();

    const hadCookie = await applySessionCookie(context);
    await ensureLoggedIn(page); // throws if cookie invalid

    const results = [];
    for (const it of items) {
      const q = [it.name, it.unit].filter(Boolean).join(" ").trim();
      const qty = Number(it.qty || 1);
      try { results.push(await addItem(page, q, qty)); }
      catch (e: any) { results.push({ added: false, query: q, error: String(e?.message || e) }); }
    }

    await page.goto("https://www.sayweee.com/en/cart", { waitUntil: "domcontentloaded" });
    res.json({ status: "ok", engine: "playwright", cookieApplied: hadCookie, items: results });
  } catch (err: any) {
    // You’ll see this in Vercel function logs
    res.status(500).json({ error: "Automation failed", detail: String(err?.message || err) });
  } finally {
    try { await browser?.close(); } catch {}
  }
}
