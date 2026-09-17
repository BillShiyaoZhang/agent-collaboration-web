/* Agent Comm push worker. No page/content caching and no fetch interception. */
const DATABASE = "agent-comm-push-v1", STORE = "state";
let displayTransition = Promise.resolve();
function mutateDisplay(work) {
  const next = displayTransition.then(work, work);
  displayTransition = next.catch(() => {});
  return next;
}
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function read(key) {
  const db = await database();
  try { return await new Promise((resolve, reject) => { const request = db.transaction(STORE).objectStore(STORE).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  finally { db.close(); }
}
async function write(key, value) {
  const db = await database();
  try { await new Promise((resolve, reject) => { const tx = db.transaction(STORE, "readwrite"); value === undefined ? tx.objectStore(STORE).delete(key) : tx.objectStore(STORE).put(value, key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); }); }
  finally { db.close(); }
}
async function claim(delivery, binding) {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite"), store = tx.objectStore(STORE), key = `attempt:${delivery.deliveryId}`;
    let fresh = false;
    const config = store.get("binding");
    config.onsuccess = () => {
      if (config.result?.binding !== binding || config.result?.accountId !== delivery.accountId || delivery.expiresAt <= Date.now()) return;
      const previous = store.get(key);
      previous.onsuccess = () => { if (!previous.result) { fresh = true; store.put({ expiresAt: delivery.expiresAt, status: "attempting" }, key); } };
    };
    const cleanup = store.openCursor();
    cleanup.onsuccess = () => { const cursor = cleanup.result; if (cursor) { if (String(cursor.key).startsWith("attempt:") && (cursor.value.expiresAt || cursor.value) < Date.now()) cursor.delete(); cursor.continue(); } };
    tx.oncomplete = () => resolve(fresh); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
async function api(value) {
  const response = await fetch("/api/notifications/push", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  if (!response.ok) return null;
  return response.json();
}
async function closeNotices() { for (const item of await self.registration.getNotifications()) if (item.tag.startsWith("agent-comm-push:")) item.close(); }
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  const message = event.data;
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin) return;
  event.waitUntil((async () => {
    if (message?.action === "bind" && typeof message.accountId === "string" && /^[A-Za-z0-9_-]{32}$/.test(message.binding)) {
      await mutateDisplay(async () => {
        const previous = await read("binding");
        if (previous?.binding !== message.binding || previous?.accountId !== message.accountId) await closeNotices();
        await write("binding", { accountId: message.accountId, binding: message.binding });
      });
    } else if (message?.action === "clear") { await mutateDisplay(async () => { await write("binding", undefined); await closeNotices(); }); }
    else if (message?.action === "reconcile") {
      const bound = await read("binding");
      for (const notice of await self.registration.getNotifications()) {
        if (!notice.tag.startsWith("agent-comm-push:")) continue;
        const data = notice.data;
        if (!bound || data?.binding !== bound.binding || data?.expiresAt <= Date.now()) { notice.close(); continue; }
        const latest = await api({ action: "resolve", deliveryId: data.deliveryId, binding: data.binding });
        if (latest && !latest.valid) notice.close();
      }
    }
    event.ports[0]?.postMessage({ ok: true });
  })().catch(() => event.ports[0]?.postMessage({ ok: false })));
});
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let payload; try { payload = event.data?.json(); } catch { return; }
    if (payload?.schema !== "agent-comm-push/v1" || !/^[a-f0-9-]{32,36}$/.test(payload.deliveryId) || payload.expiresAt <= Date.now()) return;
    const bound = await read("binding");
    if (!bound || payload.binding !== bound.binding) return;
    const current = await api({ action: "resolve", deliveryId: payload.deliveryId, binding: payload.binding });
    if (payload.action === "reconcile") {
      if (current && current.valid === false) await mutateDisplay(async () => {
        const latest = await read("binding");
        if (latest?.binding !== payload.binding) return;
        for (const notice of await self.registration.getNotifications())
          if (notice.data?.deliveryId === payload.deliveryId && notice.data?.binding === payload.binding) notice.close();
      });
      for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) client.postMessage({ type: "agent-comm-attention-refresh" });
      return;
    }
    if (!current?.valid || current.accountId !== bound.accountId || current.binding !== bound.binding) return;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!current.test && windows.some(client => client.focused && client.visibilityState === "visible")) {
      for (const client of windows) client.postMessage({ type: "agent-comm-attention-refresh" });
      await api({ action: "receipt", deliveryId: payload.deliveryId, binding: payload.binding, status: "deferred" }); return;
    }
    // Keep network requests outside this queue. A clear/bind acknowledgement
    // waits for any already-started OS display and closes it before completing.
    const status = await mutateDisplay(async () => {
      const latest = await read("binding");
      if (latest?.binding !== payload.binding || latest?.accountId !== current.accountId || current.expiresAt <= Date.now()) return null;
      if (!await claim(current, payload.binding)) {
        const previous = await read(`attempt:${payload.deliveryId}`);
        return ["displayed", "display_error", "suppressed"].includes(previous?.status) ? previous.status : null;
      }
      let outcome = "displayed";
      try {
        await self.registration.showNotification(current.title, { body: current.body, tag: current.tag, icon: "/favicon.ico", renotify: false,
          data: { deliveryId: payload.deliveryId, binding: payload.binding, expiresAt: current.expiresAt } });
        if (current.expiresAt <= Date.now()) {
          for (const notice of await self.registration.getNotifications()) if (notice.data?.deliveryId === payload.deliveryId) notice.close();
          outcome = "suppressed";
        }
      } catch { outcome = "display_error"; }
      await write(`attempt:${payload.deliveryId}`, { expiresAt: current.expiresAt, status: outcome });
      return outcome;
    });
    if (status) await api({ action: "receipt", deliveryId: payload.deliveryId, binding: payload.binding, status });
  })());
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const destination = new URL("/dashboard/notifications", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.navigate(destination); await existing.focus(); }
    else await self.clients.openWindow(destination);
  })());
});
self.addEventListener("pushsubscriptionchange", event => event.waitUntil(mutateDisplay(() => write("binding", undefined).then(closeNotices))));
