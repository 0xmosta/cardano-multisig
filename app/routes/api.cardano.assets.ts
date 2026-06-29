type KupoValue = { coins?: number | string; assets?: Record<string, number | string> };
type KupoOutput = { transaction_id?: string; output_index?: number; value?: KupoValue; address?: string; spent_at?: unknown };
type AssetSummary = { unit: string; label: string; quantity: string; outputCount: number; decimals: number; subject?: string; fingerprint?: string };
type RegistryMetadata = { name?: { value?: string }; ticker?: { value?: string }; decimals?: { value?: number | string } };
type HandleInfo = { name: string; address: string; holder?: string; holderType?: string; image?: string };
type NativeScriptJson = { type?: string; scripts?: NativeScriptJson[]; keyHash?: string; required?: number; slot?: number; [key: string]: unknown };
type RecoveredScript = { source: "koios"; txHash: string; scriptHash: string; paymentScript: NativeScriptJson };
type KoiosAsset = { decimals?: number | null; quantity?: string; policy_id?: string; asset_name?: string; fingerprint?: string };
type KoiosUtxo = { value?: string; asset_list?: KoiosAsset[] };
type KoiosAddressInfo = { address?: string; balance?: string; utxo_set?: KoiosUtxo[] };
type KoiosAddressTx = { tx_hash?: string };
type KoiosNativeScript = { script_hash?: string; script_json?: NativeScriptJson };
type KoiosTxInfo = { tx_hash?: string; native_scripts?: KoiosNativeScript[] };
type BlockfrostAmount = { unit: string; quantity: string };
type BlockfrostUtxo = { tx_hash?: string; output_index?: number; amount?: BlockfrostAmount[] };
type BlockfrostAsset = { decimals?: number | null; fingerprint?: string };

type CardanoNetwork = "mainnet" | "preprod" | "preview";

function getKupoUrl() { return (process.env.CARDANO_KUPO_URL || process.env.KUPO_URL || "").replace(/\/$/, ""); }
function normalizeNetwork(value: string | null | undefined): CardanoNetwork {
  const normalized = (value || "").trim().toLowerCase();
  return normalized === "mainnet" || normalized === "preview" ? normalized : "preprod";
}
function configuredNetwork() {
  return normalizeNetwork(process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod");
}
function isMainnetNetwork(network: CardanoNetwork) { return network === "mainnet"; }
function addressMatchesNetwork(address: string, network: CardanoNetwork) {
  return isMainnetNetwork(network) ? /^addr1[0-9a-z]+$/i.test(address) : /^addr_test1[0-9a-z]+$/i.test(address);
}
function stakeAddressMatchesNetwork(stakeAddress: string, network: CardanoNetwork) {
  return isMainnetNetwork(network) ? /^stake1[0-9a-z]+$/i.test(stakeAddress) : /^stake_test1[0-9a-z]+$/i.test(stakeAddress);
}
function assertBlockfrostUrlMatchesNetwork(url: string, network: CardanoNetwork) {
  const host = (() => {
    try { return new URL(url).hostname.toLowerCase(); }
    catch { return ""; }
  })();
  if (!host.endsWith("blockfrost.io")) return;
  const expected = `cardano-${network}.blockfrost.io`;
  if (host !== expected) throw new Error(`Configured Cardano network is ${network}, but Blockfrost URL points to ${host}.`);
}
function getBlockfrostConfig() {
  const network = configuredNetwork();
  const defaultUrl = `https://cardano-${network}.blockfrost.io/api/v0`;
  const url = (process.env.BLOCKFROST_URL || process.env.CARDANO_BLOCKFROST_URL || defaultUrl).replace(/\/$/, "");
  const projectId = process.env.BLOCKFROST_PROJECT_ID || process.env.CARDANO_BLOCKFROST_PROJECT_ID || "";
  assertBlockfrostUrlMatchesNetwork(url, network);
  return { network, url, projectId };
}
function hasBlockfrost() { return Boolean(getBlockfrostConfig().projectId.trim()); }
function addQuantity(a: string, b: string) { return (BigInt(a || "0") + BigInt(b || "0")).toString(); }
function subjectFromUnit(unit: string) { if (unit === "lovelace") return undefined; const [policy, nameHex = ""] = unit.split("."); return `${policy}${nameHex}`; }
function unitFromBlockfrost(unit: string) { return unit === "lovelace" ? unit : `${unit.slice(0, 56)}.${unit.slice(56)}`; }
function decodeAssetName(nameHex = "") { try { const text = Buffer.from(nameHex, "hex").toString("utf8"); if (/^[\x20-\x7E]{1,32}$/.test(text)) return text; } catch {} return ""; }
function assetLabel(unit: string) { if (unit === "lovelace") return "ADA"; const [, nameHex = ""] = unit.split("."); const decoded = decodeAssetName(nameHex); if (decoded) return decoded; return nameHex ? nameHex.slice(0, 12) + (nameHex.length > 12 ? "…" : "") : unit.slice(0, 16) + "…"; }

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
  } catch { return { decimals: 0, subject }; }
}

function parsePatterns(url: URL) {
  const raw = url.searchParams.getAll("patterns").join(",") || url.searchParams.getAll("pattern").join(",");
  return Array.from(new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)));
}
function normalizeHandle(input: string) { return input.trim().replace(/^\$/, "").toLowerCase(); }
function validAddress(address: string) { return /^addr1[0-9a-z]+$/i.test(address) || /^addr_test1[0-9a-z]+$/i.test(address); }

async function scriptHashFromAddress(address: string): Promise<string | null> {
  try {
    const CSL = await import("@emurgo/cardano-serialization-lib-browser");
    const parsed = CSL.Address.from_bech32(address);
    const base = CSL.BaseAddress.from_address(parsed);
    const enterprise = CSL.EnterpriseAddress.from_address(parsed);
    const credential = base?.payment_cred() ?? enterprise?.payment_cred();
    return credential?.to_scripthash()?.to_hex() || null;
  } catch {
    return null;
  }
}

async function resolveHandle(name: string, network: CardanoNetwork): Promise<HandleInfo | null> {
  if (!isMainnetNetwork(network)) return null;
  const handle = normalizeHandle(name);
  if (!/^[a-z0-9_.-]{1,32}$/.test(handle)) return null;
  const response = await fetch(`https://api.handle.me/handles/${encodeURIComponent(handle)}`, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  const body = await response.json() as { name?: string; holder?: string; holder_type?: string; image?: string; resolved_addresses?: { ada?: string } };
  const address = body.resolved_addresses?.ada;
  if (!address || !validAddress(address) || !addressMatchesNetwork(address, network)) return null;
  return { name: body.name || handle, address, holder: body.holder, holderType: body.holder_type, image: body.image };
}


async function resolveHandleByStakeAddress(stakeAddress: string, network: CardanoNetwork): Promise<HandleInfo | null> {
  if (!isMainnetNetwork(network) || !stakeAddressMatchesNetwork(stakeAddress, network)) return null;
  try {
    const response = await fetch(`https://api.handle.me/holders/${encodeURIComponent(stakeAddress)}`, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const body = await response.json() as { default_handle?: string; handles?: string[] };
    const name = body.default_handle || body.handles?.[0];
    return name ? await resolveHandle(name, network) : null;
  } catch { return null; }
}

async function koiosAddressAssets(address: string): Promise<{ assets: AssetSummary[]; outputs: number } | null> {
  if (!validAddress(address)) return null;
  try {
    const response = await fetch("https://api.koios.rest/api/v1/address_info", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ _addresses: [address] }),
    });
    if (!response.ok) return null;
    const rows = await response.json() as KoiosAddressInfo[];
    const info = rows?.[0];
    if (!info) return null;
    const utxos = Array.isArray(info.utxo_set) ? info.utxo_set : [];
    const native = new Map<string, { quantity: string; outputCount: number; decimals: number; fingerprint?: string }>();
    for (const utxo of utxos) {
      for (const asset of utxo.asset_list || []) {
        if (!asset.policy_id || !asset.asset_name) continue;
        const unit = `${asset.policy_id}.${asset.asset_name}`;
        const current = native.get(unit) || { quantity: "0", outputCount: 0, decimals: Number.isInteger(Number(asset.decimals)) ? Number(asset.decimals) : 0, fingerprint: asset.fingerprint };
        native.set(unit, { ...current, quantity: addQuantity(current.quantity, String(asset.quantity || "0")), outputCount: current.outputCount + 1 });
      }
    }
    const assets: AssetSummary[] = [{ unit: "lovelace", label: "ADA", quantity: String(info.balance || "0"), outputCount: utxos.length, decimals: 6 }];
    for (const [unit, info] of native) {
      const metadata = await registryMetadata(unit);
      assets.push({ unit, label: metadata.label || assetLabel(unit), quantity: info.quantity, outputCount: info.outputCount, decimals: metadata.decimals || info.decimals || 0, subject: metadata.subject, fingerprint: info.fingerprint });
    }
    assets.sort((a, b) => a.unit === "lovelace" ? -1 : b.unit === "lovelace" ? 1 : a.label.localeCompare(b.label));
    return { assets, outputs: utxos.length };
  } catch { return null; }
}

async function koiosRecoverNativeScript(address: string): Promise<RecoveredScript | null> {
  if (!validAddress(address)) return null;
  const paymentScriptHash = await scriptHashFromAddress(address);
  if (!paymentScriptHash) return null;

  try {
    const txResponse = await fetch("https://api.koios.rest/api/v1/address_txs", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ _addresses: [address] }),
    });
    if (!txResponse.ok) return null;
    const addressTxs = await txResponse.json() as KoiosAddressTx[];
    const hashes = Array.from(new Set(addressTxs.map((tx) => tx.tx_hash).filter((hash): hash is string => Boolean(hash)))).slice(0, 100);

    for (let index = 0; index < hashes.length; index += 10) {
      const chunk = hashes.slice(index, index + 10);
      const infoResponse = await fetch("https://api.koios.rest/api/v1/tx_info", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ _tx_hashes: chunk, _scripts: true, _bytecode: true }),
      });
      if (!infoResponse.ok) continue;
      const txInfos = await infoResponse.json() as KoiosTxInfo[];
      for (const tx of txInfos) {
        const match = (tx.native_scripts || []).find(
          (script) => script.script_hash === paymentScriptHash && script.script_json?.type,
        );
        if (match?.script_json && tx.tx_hash) {
          return { source: "koios", txHash: tx.tx_hash, scriptHash: paymentScriptHash, paymentScript: match.script_json };
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function blockfrostGet<T>(path: string): Promise<T> {
  const config = getBlockfrostConfig();
  const response = await fetch(`${config.url}${path}`, {
    headers: { accept: "application/json", project_id: config.projectId },
  });
  if (!response.ok) throw new Error(`Blockfrost returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function blockfrostAssetInfo(unit: string): Promise<BlockfrostAsset | null> {
  if (unit === "lovelace") return null;
  try {
    return await blockfrostGet<BlockfrostAsset>(`/assets/${unit.replace(".", "")}`);
  } catch {
    return null;
  }
}

async function blockfrostAddressAssets(address: string): Promise<{ assets: AssetSummary[]; outputs: number } | null> {
  if (!validAddress(address) || !hasBlockfrost()) return null;
  const pages: BlockfrostUtxo[][] = [];
  for (let page = 1; page <= 10; page += 1) {
    const rows = await blockfrostGet<BlockfrostUtxo[]>(`/addresses/${encodeURIComponent(address)}/utxos?order=asc&page=${page}&count=100`);
    pages.push(rows);
    if (rows.length < 100) break;
  }
  const utxos = pages.flat();
  const totals = new Map<string, { quantity: string; outputCount: number; decimals: number; fingerprint?: string }>();
  for (const utxo of utxos) {
    for (const amount of utxo.amount || []) {
      const unit = unitFromBlockfrost(amount.unit);
      const current = totals.get(unit) || { quantity: "0", outputCount: 0, decimals: unit === "lovelace" ? 6 : 0 };
      totals.set(unit, { ...current, quantity: addQuantity(current.quantity, String(amount.quantity || "0")), outputCount: current.outputCount + 1 });
    }
  }
  const assets = await Promise.all(Array.from(totals, async ([unit, info]) => {
    const [metadata, chainInfo] = await Promise.all([registryMetadata(unit), blockfrostAssetInfo(unit)]);
    const decimals = metadata.decimals || (Number.isInteger(Number(chainInfo?.decimals)) ? Number(chainInfo?.decimals) : info.decimals);
    return { unit, label: metadata.label || assetLabel(unit), quantity: info.quantity, outputCount: info.outputCount, decimals, subject: metadata.subject, fingerprint: chainInfo?.fingerprint || info.fingerprint } satisfies AssetSummary;
  }));
  assets.sort((a, b) => a.unit === "lovelace" ? -1 : b.unit === "lovelace" ? 1 : a.label.localeCompare(b.label));
  return { outputs: utxos.length, assets };
}

async function kupoPatternAssets(patterns: string[], kupoUrl: string) {
  const uniqueOutputs = new Map<string, KupoOutput>();
  for (const pattern of patterns) {
    const response = await fetch(`${kupoUrl}/matches/${encodeURIComponent(pattern)}?unspent`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Kupo returned ${response.status}`);
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
    if (coins !== "0") { const current = totals.get("lovelace") || { quantity: "0", outputCount: 0 }; totals.set("lovelace", { quantity: addQuantity(current.quantity, coins), outputCount: current.outputCount + 1 }); }
    for (const [unit, rawQuantity] of Object.entries(value.assets || {})) { const current = totals.get(unit) || { quantity: "0", outputCount: 0 }; totals.set(unit, { quantity: addQuantity(current.quantity, String(rawQuantity || "0")), outputCount: current.outputCount + 1 }); }
  }
  const assets = await Promise.all(Array.from(totals, async ([unit, info]) => { const metadata = await registryMetadata(unit); return { unit, label: metadata.label || assetLabel(unit), decimals: metadata.decimals, subject: metadata.subject, ...info } satisfies AssetSummary; }));
  assets.sort((a, b) => a.unit === "lovelace" ? -1 : b.unit === "lovelace" ? 1 : a.label.localeCompare(b.label));
  return { outputs: uniqueOutputs.size, assets };
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const requestNetwork = normalizeNetwork(url.searchParams.get("network") || undefined);
  const network = configuredNetwork();
  if (requestNetwork !== network) {
    return Response.json({ ready: false, assets: [], outputs: 0, error: `Wallet network ${requestNetwork} does not match configured provider network ${network}.` }, { status: 409 });
  }
  const patterns = parsePatterns(url);
  const handleName = normalizeHandle(url.searchParams.get("handle") || "");
  const requestedAddress = (url.searchParams.get("address") || "").trim();
  const stakeAddress = (url.searchParams.get("stakeAddress") || "").trim();
  let handle: HandleInfo | null = null;
  let address = requestedAddress;
  if (handleName) {
    handle = await resolveHandle(handleName, network);
    if (handle) address = handle.address;
  }
  if (!handle && stakeAddress) {
    handle = await resolveHandleByStakeAddress(stakeAddress, network);
    if (handle) address = handle.address;
  }
  if (address) {
    const recoveredScript = configuredNetwork() === "mainnet" ? await koiosRecoverNativeScript(address) : null;
    const blockfrost = await blockfrostAddressAssets(address);
    if (blockfrost) return Response.json({ ready: true, source: "blockfrost", handle, address, patterns, outputs: blockfrost.outputs, assets: blockfrost.assets, recoveredScript });
    const exact = configuredNetwork() === "mainnet" ? await koiosAddressAssets(address) : null;
    if (exact) return Response.json({ ready: true, source: "koios", handle, address, patterns, outputs: exact.outputs, assets: exact.assets, recoveredScript });
  }

  if (!patterns.length || patterns.some((pattern) => !/^([0-9a-f]{58}|[0-9a-f]{114})(\.\*)?$/.test(pattern))) {
    return Response.json({ ready: false, assets: [], outputs: 0, handle, address, patterns, error: address ? "Could not fetch resolved handle address and no valid Kupo pattern was provided." : "Missing or invalid Kupo Shelley address pattern." }, { status: 400 });
  }
  const kupoUrl = getKupoUrl();
  if (!kupoUrl) return Response.json({ ready: false, assets: [], outputs: 0, handle, address, patterns, error: "Kupo is not configured on the server." }, { status: 503 });
  try {
    const fetched = await kupoPatternAssets(patterns, kupoUrl);
    return Response.json({ ready: true, source: "kupo", handle, address, patterns, pattern: patterns[0], outputs: fetched.outputs, assets: fetched.assets });
  } catch (error) {
    return Response.json({ ready: false, assets: [], outputs: 0, handle, address, patterns, error: error instanceof Error ? error.message : "Could not fetch assets." }, { status: 502 });
  }
}
