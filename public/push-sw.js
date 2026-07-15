self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const title = typeof payload.title === "string" ? payload.title : "Cardano multisig";
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof payload.body === "string" ? payload.body : "Transaction progress changed.",
    icon: "/apple-touch-icon.png",
    badge: "/favicon-32x32.png",
    tag: typeof payload.tag === "string" ? payload.tag : "cardano-multisig",
    data: { url: typeof payload.url === "string" ? payload.url : "/transactions" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const candidate = new URL(event.notification.data?.url || "/transactions", self.location.origin);
  const target = candidate.origin === self.location.origin ? candidate.href : new URL("/transactions", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => client.url.startsWith(self.location.origin));
    return existing ? existing.focus().then(() => existing.navigate(target)) : self.clients.openWindow(target);
  }));
});
