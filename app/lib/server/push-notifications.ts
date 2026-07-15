import { createHash } from "node:crypto";
import webpush from "web-push";
import type { Network } from "../multisig";
import { postgresEnabled, withClient } from "./postgres";

export type StoredPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

function vapidConfig() {
  const publicKey = (process.env.CARDANO_MULTISIG_VAPID_PUBLIC_KEY || "").trim();
  const privateKey = (process.env.CARDANO_MULTISIG_VAPID_PRIVATE_KEY || "").trim();
  const subject = (process.env.CARDANO_MULTISIG_VAPID_SUBJECT || process.env.CARDANO_MULTISIG_PUBLIC_ORIGIN || "").trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject: /^(mailto:|https?:)/.test(subject) ? subject : `mailto:${subject}` };
}

export function pushConfiguration() {
  const config = vapidConfig();
  return { enabled: Boolean(config && postgresEnabled()), publicKey: config?.publicKey || "" };
}

function subscriptionId(endpoint: string) {
  return createHash("sha256").update(endpoint).digest("hex");
}

export async function savePushSubscription(network: Network, subject: string, sessionId: string, subscription: StoredPushSubscription) {
  if (!postgresEnabled()) throw new Error("Push subscriptions require PostgreSQL persistence.");
  await withClient((client) => client.query(
    `insert into cm_push_subscriptions (id, network, subject, session_id, endpoint, p256dh, auth, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now(), now())
     on conflict (id)
     do update set network = excluded.network, subject = excluded.subject, session_id = excluded.session_id,
                   p256dh = excluded.p256dh, auth = excluded.auth, updated_at = now()`,
    [subscriptionId(subscription.endpoint), network, subject, sessionId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth],
  ));
}

export async function deletePushSubscription(network: Network, subject: string, endpoint?: string) {
  if (!postgresEnabled()) return;
  await withClient((client) => endpoint
    ? client.query(`delete from cm_push_subscriptions where network = $1 and subject = $2 and endpoint = $3`, [network, subject, endpoint])
    : client.query(`delete from cm_push_subscriptions where network = $1 and subject = $2`, [network, subject]));
}

export async function sendAccountPush(network: Network, subject: string | undefined, payload: { title: string; body: string; url: string; tag: string }) {
  const config = vapidConfig();
  if (!subject || !config || !postgresEnabled()) return { sent: 0 };
  webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  const result = await withClient((client) => client.query<{ endpoint: string; p256dh: string; auth: string }>(
    `select endpoint, p256dh, auth from cm_push_subscriptions where network = $1 and subject = $2`,
    [network, subject],
  ));
  let sent = 0;
  await Promise.all(result.rows.map(async (row) => {
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(payload), { TTL: 3_600, timeout: 5_000 });
      sent += 1;
    } catch (error) {
      const statusCode = typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: unknown }).statusCode) : 0;
      if (statusCode === 404 || statusCode === 410) await deletePushSubscription(network, subject, row.endpoint);
    }
  }));
  return { sent };
}
