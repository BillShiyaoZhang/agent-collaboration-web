import { z } from "zod";

// Endpoints are supplied by browsers, but remain untrusted network destinations.
// The sender never follows redirects or permits arbitrary/private origins.
export function allowedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.port || url.port === "443") &&
      (host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com" || host === "web.push.apple.com" ||
        /^[a-z0-9-]+\.notify\.windows\.com$/.test(host)) && url.pathname.length > 1;
  } catch { return false; }
}
const key = (bytes: number) => z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/).refine(value => Buffer.from(value, "base64url").length === bytes);
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048).refine(allowedPushEndpoint),
  expirationTime: z.number().positive().nullable().optional(),
  keys: z.object({ p256dh: key(65).refine(value => Buffer.from(value, "base64url")[0] === 4), auth: key(16) }).strict(),
}).strict();
export type BrowserPushSubscription = z.infer<typeof pushSubscriptionSchema>;
export const PUSH_LEASE_MS = 30 * 24 * 60 * 60 * 1000;
export const PUSH_TTL_MS = 15 * 60 * 1000;
export const PUSH_FRESH_MS = 120000;
export const pushRetryDelay = (attempt: number) => Math.min(300000, 5000 * 2 ** Math.max(0, attempt - 1));
export const isGonePushStatus = (status?: number) => status === 404 || status === 410;
export function pushSubject(): string | null {
  if (process.env.WEB_PUSH_DISABLED === "1") return null;
  const value = process.env.WEB_PUSH_SUBJECT || process.env.NEXTAUTH_URL;
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "mailto:" ? value : null; } catch { return null; }
}
