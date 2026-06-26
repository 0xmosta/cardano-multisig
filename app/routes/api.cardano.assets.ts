type KupoValue = { coins?: number | string; assets?: Record<string, number | string> };
type KupoOutput = { transaction_id?: string; output_index?: number; value?: KupoValue; address?: string; spent_at?: unknown };
type AssetSummary = { unit: string; label: string; quantity: string; outputCount: number; decimals: number; subject?: string };

type RegistryMetadata = { name?: { value?: string }; ticker?: { value?: string }; decimals?: { value?: number | string } };

function getKupoUrl() {
  return (process.env.CARDANO_KUPO_URL || process.env.KUPO_URL || "").replace(/\/$/, "");
}

function addQuantity(a: string, b: string) {
  return (BigInt(a || "0") + BigInt(b || "0")).toString();
}

function subjectFromUnit(unit: string) {
  if (unit === "lovelace") return undefined;
  const [policy, nameHex = ""] = unit.split(".");
  return `${policy}${nameHex}`;
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

async function registryMetadata(unit: string): Promise<{ label?: string; decimals: number; subject?: string }> {
  if (unit === "lovelace") return { label: "ADA", decimals: 6 };
  const subject = subjectFromUnit(unit);
  if (!subject) return { decimals: 0 };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(`https://tokens.cardano.org/metadata/${subject}`, { signal: controller.signal, headers: { accept: "application/json" } });
    clearTimeout(timer);
    if (!response.ok) return { decimals: 0, subject };
    const metadata = await response.json() as RegistryMetadata;
    const rawDecimals = metadata.decimals?.value;
    const decimals = Number.isInteger(Number(rawDecimals)) ? Math.max(0, Math.min(30, Number(rawDecimals))) : 0;
    const label = metadata.ticker?.value || metadata.name?.value;
    return { label, decimals, subject };
  } catch {
    return { decimals: 0, subject };
  }
}

function parsePatterns(url: URL) {
  const raw = url.searchParams.getAll("patterns").join(",") || url.searchParams.getAll("pattern").join(",");
  return Array.from(new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)));
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const patterns = parsePatterns(url);
  if (!patterns.length || patterns.some((pattern) => !/^([0-9a-f]{58}|[0-9a-f]{114})(\.\*)?$/.test(pattern))) {
    return Response.json({ ready: false, assets: [], outputs: 0, patterns, error: "Missing or invalid Kupo Shelley address pattern." }, { status: 400 });
  }
  const kupoUrl = getKupoUrl();
  if (!kupoUrl) {
    return Response.json({ ready: false, assets: [], outputs: 0, patterns, error: "Kupo is not configured on the server." }, { status: 503 });
  }

  const uniqueOutputs = new Map<string, KupoOutput>();
  for (const pattern of patterns) {
    const response = await fetch(`${kupoUrl}/matches/${encodeURIComponent(pattern)}?unspent`, { headers: { accept: "application/json" } });
    if (!response.ok) {
      return Response.json({ ready: false, assets: [], outputs: 0, patterns, error: `Kupo returned ${response.status}` }, { status: 502 });
    }
    const outputs = await response.json() as KupoOutput[];
    for (const output of Array.isArray(outputs) ? outputs : []) {
      if (output.spent_at) continue;
      const key = `${output.transaction_id || "unknown"}#${output.output_index ?? uniqueOutputs.size}`;
      uniqueOutputs.set(key, output);
    }
  }

  const totals = new Map<string, { quantity: string; outputCount: number }>();
  for (const output of uniqueOutputs.values()) {
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

  const assets = await Promise.all(Array.from(totals, async ([unit, info]) => {
    const metadata = await registryMetadata(unit);
    return { unit, label: metadata.label || assetLabel(unit), decimals: metadata.decimals, subject: metadata.subject, ...info } satisfies AssetSummary;
  }));
  assets.sort((a, b) => a.unit === "lovelace" ? -1 : b.unit === "lovelace" ? 1 : a.label.localeCompare(b.label));
  return Response.json({ ready: true, patterns, pattern: patterns[0], outputs: uniqueOutputs.size, assets });
}
