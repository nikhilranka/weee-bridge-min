// Canary route: proves the path is wired. No auth, no Playwright.
export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, method: req.method, expect: "POST" });
  }
  res.status(200).json({
    ok: true,
    route: "/api/weee/cart/add-real",
    now: new Date().toISOString()
  });
}
