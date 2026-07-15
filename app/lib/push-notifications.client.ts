function base64UrlToBytes(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function enableBackgroundNotifications(csrfToken: string) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Background notifications are not supported in this browser.");
  const configResponse = await fetch("/api/account/notifications");
  const config = await configResponse.json() as { ok?: boolean; enabled?: boolean; publicKey?: string; error?: string };
  if (!configResponse.ok || !config.enabled || !config.publicKey) throw new Error(config.error || "Background notifications are not configured on this server.");
  const registration = await navigator.serviceWorker.register("/push-sw.js", { scope: "/" });
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(config.publicKey) });
  const response = await fetch("/api/account/notifications", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cardano-multisig-csrf": csrfToken },
    body: JSON.stringify({ intent: "subscribe", subscription: subscription.toJSON() }),
  });
  const body = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || !body.ok) {
    if (!existing) await subscription.unsubscribe().catch(() => undefined);
    throw new Error(body.error || "Could not save the notification subscription.");
  }
}

export async function disableBackgroundNotifications(csrfToken: string) {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  const endpoint = subscription?.endpoint || "";
  const response = await fetch("/api/account/notifications", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cardano-multisig-csrf": csrfToken },
    body: JSON.stringify({ intent: "unsubscribe", endpoint }),
  });
  const body = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || !body.ok) throw new Error(body.error || "Could not remove the notification subscription.");
  await subscription?.unsubscribe();
}
