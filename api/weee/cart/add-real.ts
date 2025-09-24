import type { VercelRequest, VercelResponse } from "@vercel/node";
import playwright from "playwright-core";

function requireAuth(req: VercelRequest, res: VercelResponse) {
  const rawAuth = req.headers.authorization || "";
  const token = process.env.ACTIONS_BEARER_TOKEN;

  // Remove ALL leading "Bearer " (case-insensitive)
  let auth = rawAuth.trim();
  while (/^Bearer\s+/i.test(auth)) {
    auth = auth.replace(/^Bearer\s+/i, "").trim();
  }

  if (!auth && token) return true;
  if (auth && auth === token) return true;

  res.status(401).json({ error: "Unauthorized" });
  return false;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openBrowser() {
  let ws = process.env.BROWSERLESS_WS || "";
  // Accept old-style URLs and strip '/playwright'
  ws = ws.replace(/\/playwright(\?|$)/, "$1");
  if (!ws) throw new Error("Missing BROWSERLESS_WS");

  const maxAttempts = 3;
  let lastErr: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const browser = await playwright.chromium.connect(ws, { timeout: 30000 });
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
      });
      return { browser, context };
    } catch (e: any) {
      const msg = String(e?.message || e);
      try {
        const browser = await playwright.chromium.connectOverCDP(ws);
        const context = await browser.newContext({
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
        });
        return { browser, context };
      } catch (e2: any) {
        lastErr = e2;
        if (
          /429|Too Many Requests/i.test(msg) ||
          /429|Too Many Requests/i.test(String(e2?.message || e2))
        ) {
          if (attempt < maxAttempts) await sleep(300 * attempt + 200 * attempt);
          continue;
        }
        throw e2;
      }
    }
  }
  throw lastErr;
}

async function applySessionCookie(context: playwright.BrowserContext) {
  const cookieJson = process.env.WEEE_SESSION_COOKIE;
  if (!cookieJson) return false;
  const cookies = JSON.parse(cookieJson);
  if (Array.isArray(cookies) && cookies.length) {
    for (const c of cookies) {
      if (!["Strict", "Lax", "None"].includes(c.sameSite)) {
        c.sameSite = "Lax";
      }
    }
    await context.addCookies(cookies as any);
    return true;
  }
  return false;
}

async function ensureLoggedIn(page: playwright.Page) {
  await page.goto("https://www.sayweee.com/en", { waitUntil: "domcontentloaded" });
  const url = page.url();
  if (/login|signin/i.test(url)) {
    throw new Error(
      "Weee session is not logged in (cookie expired or invalid). Update WEEE_SESSION_COOKIE."
    );
  }
}

async function addItem(page: playwright.Page, query: string, qty = 1) {
  try {
    // Search
    const searchSel = 'input[placeholder*="Search"]';
    await page.waitForSelector(searchSel, { timeout: 15000 });
    await page.fill(searchSel, query);
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded");

    // Find matching product card
    const productCards = page.locator('[data-testid*="product-card"]');
    const count = await productCards.count();

    let targetCard = null;
    for (let i = 0; i < count; i++) {
      const text = (await productCards.nth(i).textContent())?.toLowerCase() || "";
      if (text.includes(query.toLowerCase().split(" ")[0])) {
        targetCard = productCards.nth(i);
        break;
      }
    }

    const cardToClick = targetCard || productCards.first();
    if (!cardToClick) {
      return { added: false, query, reason: "No matching product card" };
    }

    await cardToClick.click();

    // Click add-to-cart
    try {
      const addBtn = page.locator(
        '[data-testid="btn-atc-plus"], [aria-label="add-to-cart"]'
      ).first();
      if (await addBtn.count()) {
        await addBtn.click({ timeout: 5000 });
      }
    } catch (e) {
      console.warn("⚠️ Add button click warning:", e);
      return { added: false, query, error: "Failed to click add button" };
    }

    // Increase quantity if needed
    if (qty > 1) {
      const plusBtn = page.locator('button[aria-label*="increase"]').first();
      for (let i = 1; i < qty; i++) {
        try {
          await plusBtn.click({ timeout: 1000 });
          await page.waitForTimeout(120);
        } catch {
          break;
        }
      }
    }

    // If we reached here, treat as success
    return { added: true, query, title: query, qty };
  } catch (err: any) {
    return { added: false, query, error: String(err?.message || err) };
  }
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
    const page = await context.newPage();

    const hadCookie = await applySessionCookie(context);
    await ensureLoggedIn(page);

    const results = [];
    for (const it of items) {
      const q = [it.name, it.unit].filter(Boolean).join(" ").trim();
      const qty = Number(it.qty || 1);
      try {
        results.push(await addItem(page, q, qty));
      } catch (e: any) {
        results.push({ added: false, query: q, error: String(e?.message || e) });
      }
    }

    res.json({
      status: "ok",
      engine: "playwright",
      cookieApplied: hadCookie,
      items: results,
    });
  } catch (err: any) {
    console.error("Automation error:", err);
    res.status(500).json({
      error: "Automation failed",
      detail: String(err?.message || err),
      stack: err?.stack || null,
    });
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}
