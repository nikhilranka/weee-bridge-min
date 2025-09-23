import type { VercelRequest, VercelResponse } from "@vercel/node";

function requireAuth(req: VercelRequest, res: VercelResponse) {
  const auth = (req.headers.authorization || "").replace("Bearer ", "");
  if (!auth || auth !== process.env.ACTIONS_BEARER_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  if (!requireAuth(req, res)) return;

  const { when, message } = (req.body as any) || {};
  if (!when || !message) return res.status(400).json({ error: "when & message required" });

  // TODO: integrate Slack/Email/Calendar here
  return res.json({ scheduled: true, when, message });
}
