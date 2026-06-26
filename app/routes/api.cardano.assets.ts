type KupoValue = { coins?: number | string; assets?: Record<string, number | string> };
type KupoOutput = { value?: KupoValue; address?: string; spent_at?: unknown };
type AssetSummary = { unit: string; label: string; quantity: string; outputCount: number };

function getKupoUrl() {
  return (process.env.CARDANO_KUPO_URL || process.env.KUPO_URL || "").replace(/\/$/, "");
}

function addQuantity(a: string, b: string) {
  return (BigInt(a || "0") + BigInt(b || "0")).toString();
}

function assetLabel(unit: string) {
  if (unit === "lovelace") return "ADA";
  const [, nameHex = ""] = unit.split(".");
  if (!nameHex) return unit.slice(0, 16) + "…";
  try {
    const text = Buffer.from(nameHex, "hex").toString("utf8");
    if (/^[\x20-\x7E]{1,32}$/.test(text)) return text;
  } catch {}
  return nameHex.slice(0, 12) + (nameHex.length > 12 ? "…" : "");
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const pattern = (url.searchParams.get("pattern") || "").trim().toLowerCase();
  if (!/^([0-9a-f]{58}|[0-9a-f]{114})(\.\*)?$/.test(pattern)) {
    return Response.json({ ready: false, assets: [], outputs: 0, error: "Missing or invalid Kupo Shelley address pattern." }, { status: 400 });
  }
  const kupoUrl = getKupoUrl();
  if (!kupoUrl) {
    return Response.json({ ready: false, assets: [], outputs: 0, error: "Kupo is not configured on the server." }, { status: 503 });
  }

  const response = await fetch(`${kupoUrl}/matches/${encodeURIComponent(pattern)}?unspent`, { headers: { accept: "application/json" } });
  if (!response.ok) {
    return Response.json({ ready: false, assets: [], outputs: 0, error: `Kupo returned ${response.status}` }, { status: 502 });
  }
  const outputs = await response.json() as KupoOutput[];
  const totals = new Map<string, { quantity: string; outputCount: number }>();
  for (const output of Array.isArray(outputs) ? outputs : []) {
    if (output.spent_at) continue;
    const value = output.value || {};
    const coins = String(value.coins || "0");
    if (coins !== "0") {
      const current = totals.get("lovelace") || { quantity: "0", outputCount: 0 };
      totals.set("lovelace", { quantity: addQuantity(current.quantity, coins), outputCount: current.outputCount + 1 });
    }
    for (const [unit, rawQuantity] of Object.entries(value.assets || {})) {
      const quantity = String(rawQuantity || "0");
      const current = totals.get(unit) || { quantity: "0", outputCount: 0 };
      totals.set(unit, { quantity: addQuantity(current.quantity, quantity), outputCount: current.outputCount + 1 });
    }
  }
  const assets: AssetSummary[] = Array.from(totals, ([unit, info]) => ({ unit, label: assetLabel(unit), ...info }))
    .sort((a, b) => a.unit === "lovelace" ? -1 : b.unit === "lovelace" ? 1 : a.label.localeCompare(b.label));
  return Response.json({ ready: true, pattern, outputs: Array.isArray(outputs) ? outputs.length : 0, assets });
}
