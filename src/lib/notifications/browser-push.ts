export type PushSettings = { available: boolean; publicKey: string | null; accountId?: string;
  subscription: { id: string; binding: string; accountId: string; expiresAt: number } | null;
  lastDelivery: { kind: string; status: string; updatedAt: number; lastError: string | null } | null; lastError: string | null };
export const PUSH_OWNER_KEY = "agent-push-owner:v1";
export const browserIsAway = (hidden: boolean, focused: boolean) => hidden || !focused;
export const supportsBackgroundPush = () => typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window;
let transition: Promise<unknown> = Promise.resolve();
// Complete an older subscribe/bind before a later opt-out clears it. Callers
// recheck their current intent inside this queue and after awaited work.
export function browserPushTransition<T>(work: () => Promise<T>): Promise<T> {
  const next = transition.then(work, work);
  transition = next.catch(() => {});
  return next;
}
function timeout<T>(promise: Promise<T>, milliseconds = 10000): Promise<T> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("浏览器后台提醒暂时没有响应。")), milliseconds); promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });
}
export async function pushRegistration(create = false): Promise<ServiceWorkerRegistration | undefined> {
  if (!supportsBackgroundPush()) return undefined;
  if (create) { await navigator.serviceWorker.register("/agent-comm-sw.js", { scope: "/", updateViaCache: "none" }); return timeout(navigator.serviceWorker.ready); }
  return navigator.serviceWorker.getRegistration("/");
}
export async function pushWorkerMessage(message: Record<string, unknown>, registration?: ServiceWorkerRegistration) {
  const worker = (registration || await pushRegistration())?.active; if (!worker) return;
  await timeout(new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => { channel.port1.close(); event.data?.ok ? resolve() : reject(new Error("无法保存浏览器推送设置。")); };
    worker.postMessage(message, [channel.port2]);
  }));
}
export async function clearBrowserPush() {
  const registration = await pushRegistration();
  try { if (registration) await pushWorkerMessage({ action: "clear" }, registration); }
  finally { const subscription = await registration?.pushManager.getSubscription(); if (subscription) await subscription.unsubscribe(); localStorage.removeItem(PUSH_OWNER_KEY); }
}
export async function bindBrowserPush(settings: PushSettings, accountId: string) {
  if (!settings.subscription || settings.subscription.accountId !== accountId) throw new Error("登录账号已变化，请刷新页面。");
  const registration = await pushRegistration(true);
  if (!registration) throw new Error("此浏览器不支持关闭页面后的推送。");
  await pushWorkerMessage({ action: "bind", accountId, binding: settings.subscription.binding }, registration);
  localStorage.setItem(PUSH_OWNER_KEY, accountId);
}
export function applicationServerKey(value: string): Uint8Array {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
