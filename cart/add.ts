import type { VercelRequest, VercelResponse } from "@vercel/node";
import playwright from "playwright-core";

// --- bearer auth guard ---
function requireAuth(req: VercelRequest, res: VercelResponse) {
  const auth = (req.headers.authorization || "").replace("Bearer ", "");
  if (!auth || auth !== process.env.ACTIONS_BEARER_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// --- connect to remote Chromium (browserless or similar) ---
async function openBrowser() {
  const ws = process.env.BROWSERLESS_WS;
  if (!ws) throw new Error("Missing BROWSERLESS_WS env var");
  // Example: wss://chrome.browserless.io/playwright?token=YOUR_TOKEN
  const browser = await playwright.chromium.connectOverCDP(ws);
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
  });
  return { browser, context };
}

// --- inject saved login cookies (JSON array) ---
async function applySessionCookie(context: playwright.BrowserContext) {
  const cookieJson = process.env.WEEE_SESSION_COOKIE;
  if (!cookieJson) return false;
  try {
    const cookies = JSON.parse(cookieJson);
    if (Array.isArray(cookies) && cookies.length) {
      await context.addCookies(cookies as any);
      return true;
    }
  } catch {}
  return false;
}

async function addItem(page: playwright.Page, query: string, qty: number = 1) {
  // 1) Home (ensures domain + auth)
  await page.goto("https://www.sayweee.com/en", { waitUntil: "domcontentloaded" });

  // 2) Search
  const searchSel = 'input[placeholder*="Search"]';
  await page.waitForSelector(searchSel, { timeout: 15000 });
  await page.fill(searchSel, query);
  await page.keyboard.press("Enter");
  await page.waitForLoadState("domcontentloaded");

  // 3) Pick first item (improve later with weight/brand matching)
  const firstCard = page.locator('[data-testid*="product-card"]').first();
  if ((await firstCard.count()) === 0) {
    return { added: false, query, reason: "No results" };
  }
  await firstCard.click();

  // 4) Add to cart
  const addBtn = page.locator('button:has-text("Add")').first();
  await addBtn.click({ timeout: 15000 });

  // 5) Increase quantity if needed
  if (qty > 1) {
    const plusBtn = page.locator('button[aria-label*="increase"]').first();
    for (let i = 1; i < qty; i++) {
      await plusBtn.click();
      await page.waitForTimeout(150);
    }
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
    const { browser: b, context } = await openBrowser();
    browser = b;

    await applySessionCookie(context);
    const page = await context.newPage();

    const results = [];
    for (const it of items) {
      const q = [it.name, it.unit].filter(Boolean).join(" ").trim();
      const qty = Number(it.qty || 1);
      try {
        const r = await addItem(page, q, qty);
        results.push({ ...r });
      } catch (e: any) {
        results.push({ added: false, query: q, error: String(e?.message || e) });
      }
    }

    // optional: peek at cart
    await page.goto("https://www.sayweee.com/en/cart", { waitUntil: "domcontentloaded" });
    const subtotal = await page.locator(':text("Subtotal")').first().textContent().catch(() => null);

    res.json({ status: "ok", items: results, subtotal });
  } catch (err: any) {
    res.status(500).json({ error: "Automation failed", detail: String(err?.message || err) });
  } finally {
    try { await browser?.close(); } catch {}
  }
}
