import type { VercelRequest, VercelResponse } from "@vercel/node";
import playwright from "playwright-core";

function requireAuth(req: VercelRequest, res: VercelResponse) {
  const rawAuth = req.headers.authorization || "";
  const token = process.env.ACTIONS_BEARER_TOKEN;
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
  ws = ws.replace(/\/playwright(\?|$)/, "$1");
  if (!ws) throw new Error("Missing BROWSERLESS_WS");

  const maxAttempts = 3;
  let lastErr: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[openBrowser] Connecting to browserless at: ${ws}`);

try {
  const browser = await playwright.chromium.connect(ws, { timeout: 120000 });
  console.log("[openBrowser] ✅ Connected to browserless");
  
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
  });
  console.log("[openBrowser] ✅ Context created");

  return { browser, context };
} catch (err: any) {
  console.error("[openBrowser] ❌ Failed to connect:", err.message || err);
  throw err;
}

      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
      });
      return { browser, context };
    } catch (e: any) {
      lastErr = e;
      if (/429|Too Many Requests/i.test(String(e?.message || e))) {
        if (attempt < maxAttempts) await sleep(300 * attempt + 200 * attempt);
        continue;
      }
      throw e;
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
    throw new Error("Weee session is not logged in (cookie expired or invalid). Update WEEE_SESSION_COOKIE.");
  }
}

async function addItem(page: playwright.Page, query: string, qty = 1) {
  try {
    const searchSel = 'input[placeholder*="Search"]';
    await page.waitForSelector(searchSel, { timeout: 120000 });
    await page.fill(searchSel, query);
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded");

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

    const addBtn = page.locator('[data-testid="btn-atc-plus"], [aria-label="add-to-cart"]').first();
    if (await addBtn.count()) {
      await addBtn.click({ timeout: 120000 });
    }

    if (qty > 1) {
      const plusBtn = page.locator('button[aria-label*="increase"]').first();
      for (let i = 1; i < qty; i++) {
        try {
          await plusBtn.click({ timeout: 120000 });
          await page.waitForTimeout(120);
        } catch {
          break;
        }
      }
    }

    return { added: true, query, title: query, qty };
  } catch (err: any) {
    if (/429|Too Many Requests/i.test(String(err?.message || err))) {
      throw new Error("429");
    }
    return { added: false, query, error: String(err?.message || err) };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  if (!requireAuth(req, res)) return;

  const items = Array.isArray((req.body as any)?.items) ? (req.body as any).items : [];
  if (!items.length) return res.status(400).json({ error: "items[] required" });

  let browser: playwright.Browser | null = null;

  // Enable streaming
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Transfer-Encoding", "chunked");
  res.flushHeaders?.();

  try {
    const { browser: b, context } = await openBrowser();
    browser = b;
    const page = await context.newPage();

    const hadCookie = await applySessionCookie(context);
    await ensureLoggedIn(page);

    let processed = 0;
    const total = items.length;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const q = [it.name, it.unit].filter(Boolean).join(" ").trim();
      const qty = Number(it.qty || 1);

      let result;
      try {
        result = await addItem(page, q, qty);
        processed++;
      } catch (err: any) {
        if (String(err).includes("429")) {
          console.warn("⚠️ 429 Too Many Requests → backing off 30s...");
          await sleep(30000);
          try {
            result = await addItem(page, q, qty);
            processed++;
          } catch (err2: any) {
            result = { added: false, query: q, error: String(err2) };
          }
        } else {
          result = { added: false, query: q, error: String(err) };
        }
      }

      // Stream progress update
      const progressUpdate = {
        progress: `${processed}/${total}`,
        item: q,
        result,
      };
      res.write(JSON.stringify(progressUpdate) + "\n");

      // Delay between items
      await sleep(2500);
      if ((i + 1) % 3 === 0 && i + 1 < items.length) {
        res.write(JSON.stringify({ event: "batch_pause", message: "Waiting 10s between batches" }) + "\n");
        await sleep(10000);
      }
    }

    res.write(JSON.stringify({ status: "done", total }) + "\n");
    res.end();
  } catch (err: any) {
    console.error("Automation error:", err);
    res.write(JSON.stringify({ error: "Automation failed", detail: String(err?.message || err) }) + "\n");
    res.end();
  } finally {
    try {
      await browser?.close();
    } catch {}
  }
}
