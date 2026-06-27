import * as CSL from "@emurgo/cardano-serialization-lib-browser";

type NativeScriptJson = { type: string; keyHash?: string; scripts?: NativeScriptJson[]; required?: number; slot?: number; [key: string]: unknown };
type WalletInput = { name?: string; handle?: string; network?: string; paymentScript: NativeScriptJson; stakeScript?: NativeScriptJson | null };
type AssetLine = { unit: string; quantity: string; decimals?: number };
type BuildRequest = { wallet: WalletInput; recipient: string; assets: AssetLine[] };
type KoiosUtxoAsset = { policy_id?: string; asset_name?: string; quantity?: string };
type KoiosUtxo = { tx_hash: string; tx_index: number; address: string; value: string; asset_list?: KoiosUtxoAsset[] | null };
type BlockfrostAmount = { unit: string; quantity: string };
type BlockfrostUtxo = { tx_hash: string; output_index: number; address: string; amount: BlockfrostAmount[] };

type HandleInfo = { name: string; address: string; holder?: string; holderType?: string; image?: string };

function validAddress(address: string) { return /^addr1[0-9a-z]+$/i.test(address) || /^addr_test1[0-9a-z]+$/i.test(address); }
function errorMessage(error: unknown) { if (error instanceof Error) return error.message; if (typeof error === "string") return error; try { return JSON.stringify(error); } catch { return "Could not build transaction."; } }
function normalizeHandle(input = "") { return input.trim().replace(/^\$/, "").toLowerCase(); }
function configuredNetwork() {
  const value = (process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod").trim().toLowerCase();
  return value === "mainnet" || value === "preview" ? value : "preprod";
}
function getBlockfrostConfig() {
  const network = configuredNetwork();
  const defaultUrl = `https://cardano-${network}.blockfrost.io/api/v0`;
  const url = (process.env.BLOCKFROST_URL || process.env.CARDANO_BLOCKFROST_URL || defaultUrl).replace(/\/$/, "");
  const projectId = process.env.BLOCKFROST_PROJECT_ID || process.env.CARDANO_BLOCKFROST_PROJECT_ID || "";
  return { network, url, projectId };
}
function hasBlockfrost() { return Boolean(getBlockfrostConfig().projectId.trim()); }
function handleCandidate(wallet: { name?: string; handle?: string }) {
  const candidate = normalizeHandle(wallet.handle || wallet.name || "");
  return /^[a-z0-9][a-z0-9_.-]{1,31}$/.test(candidate) ? candidate : "";
}
function hexToBytes(hex: string) { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
function unitFromBlockfrost(unit: string) { return unit === "lovelace" ? unit : `${unit.slice(0, 56)}.${unit.slice(56)}`; }

async function resolveHandle(name: string): Promise<HandleInfo | null> {
  const handle = normalizeHandle(name);
  if (!/^[a-z0-9_.-]{1,32}$/.test(handle)) return null;
  const response = await fetch(`https://api.handle.me/handles/${encodeURIComponent(handle)}`, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  const body = await response.json() as { name?: string; holder?: string; holder_type?: string; image?: string; resolved_addresses?: { ada?: string } };
  const address = body.resolved_addresses?.ada;
  if (!address || !validAddress(address)) return null;
  return { name: body.name || handle, address, holder: body.holder, holderType: body.holder_type, image: body.image };
}
async function resolveHandleByStakeAddress(stakeAddress: string): Promise<HandleInfo | null> {
  if (!/^stake(_test)?1[0-9a-z]+$/i.test(stakeAddress)) return null;
  try {
    const response = await fetch(`https://api.handle.me/holders/${encodeURIComponent(stakeAddress)}`, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const body = await response.json() as { default_handle?: string; handles?: string[] };
    const name = body.default_handle || body.handles?.[0];
    return name ? await resolveHandle(name) : null;
  } catch { return null; }
}
function scriptToCsl(script: NativeScriptJson): any {
  if (script.type === "sig" && script.keyHash) return CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(script.keyHash)));
  const children = CSL.NativeScripts.new();
  for (const child of script.scripts || []) children.add(scriptToCsl(child));
  if (script.type === "all") return CSL.NativeScript.new_script_all(CSL.ScriptAll.new(children));
  if (script.type === "any") return CSL.NativeScript.new_script_any(CSL.ScriptAny.new(children));
  if (script.type === "atLeast") return CSL.NativeScript.new_script_n_of_k(CSL.ScriptNOfK.new(Number(script.required || 1), children));
  throw new Error(`Unsupported native script type: ${script.type}`);
}
function assertAddressMatchesPaymentScript(address: string, paymentScript: any) {
  const expected = paymentScript.hash().to_hex();
  const credential = CSL.Address.from_bech32(address).payment_cred();
  const actual = credential?.to_scripthash()?.to_hex();
  if (actual && actual !== expected) throw new Error("Resolved ADA Handle address does not match the imported payment script. Re-check the handle or script before building a transaction.");
}
async function resolveSource(wallet: WalletInput) {
  const paymentScript = scriptToCsl(wallet.paymentScript);
  const networkId = wallet.network === "mainnet" ? 1 : 0;
  const handle = handleCandidate(wallet);
  if (handle) {
    const resolved = await resolveHandle(handle);
    if (resolved) { assertAddressMatchesPaymentScript(resolved.address, paymentScript); return { address: resolved.address, handle: resolved }; }
  }
  if (wallet.stakeScript) {
    const stakeHash = scriptToCsl(wallet.stakeScript).hash().to_hex();
    const stakeAddress = CSL.RewardAddress.new(networkId, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(stakeHash))).to_address().to_bech32();
    const resolved = await resolveHandleByStakeAddress(stakeAddress);
    if (resolved) { assertAddressMatchesPaymentScript(resolved.address, paymentScript); return { address: resolved.address, handle: resolved }; }
    const paymentHash = paymentScript.hash().to_hex();
    return { address: CSL.BaseAddress.new(networkId, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(paymentHash)), CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(stakeHash))).to_address().to_bech32(), handle: null };
  }
  const paymentHash = paymentScript.hash().to_hex();
  return { address: CSL.EnterpriseAddress.new(networkId, CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(paymentHash))).to_address().to_bech32(), handle: null };
}
async function addressUtxos(address: string): Promise<KoiosUtxo[]> {
  if (hasBlockfrost()) {
    const pages: BlockfrostUtxo[][] = [];
    for (let page = 1; page <= 10; page += 1) {
      const rows = await blockfrostGet<BlockfrostUtxo[]>(`/addresses/${encodeURIComponent(address)}/utxos?order=asc&page=${page}&count=100`);
      pages.push(rows);
      if (rows.length < 100) break;
    }
    return pages.flat().map((utxo) => ({
      tx_hash: utxo.tx_hash,
      tx_index: utxo.output_index,
      address: utxo.address,
      value: String(utxo.amount.find((amount) => amount.unit === "lovelace")?.quantity || "0"),
      asset_list: utxo.amount.filter((amount) => amount.unit !== "lovelace").map((amount) => {
        const unit = unitFromBlockfrost(amount.unit);
        const [policy_id, asset_name = ""] = unit.split(".");
        return { policy_id, asset_name, quantity: amount.quantity };
      }),
    }));
  }
  if (configuredNetwork() !== "mainnet") throw new Error("Blockfrost is required for non-mainnet transaction building.");
  const response = await fetch("https://api.koios.rest/api/v1/address_utxos", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ _addresses: [address], _extended: true }),
  });
  if (!response.ok) throw new Error(`Koios UTxO lookup failed (${response.status}).`);
  const body = await response.json();
  return Array.isArray(body) ? body.filter((row) => !row.is_spent) as KoiosUtxo[] : [];
}
async function blockfrostGet<T>(path: string): Promise<T> {
  const config = getBlockfrostConfig();
  const response = await fetch(`${config.url}${path}`, {
    headers: { accept: "application/json", project_id: config.projectId },
  });
  if (!response.ok) throw new Error(`Blockfrost returned ${response.status}`);
  return response.json() as Promise<T>;
}
async function epochParams() {
  if (hasBlockfrost()) {
    const params = await blockfrostGet<Record<string, unknown>>("/epochs/latest/parameters");
    return {
      min_fee_a: params.min_fee_a,
      min_fee_b: params.min_fee_b,
      coins_per_utxo_size: params.coins_per_utxo_size || params.coins_per_utxo_word,
      pool_deposit: params.pool_deposit,
      key_deposit: params.key_deposit,
      max_val_size: params.max_val_size,
      max_tx_size: params.max_tx_size,
    };
  }
  if (configuredNetwork() !== "mainnet") throw new Error("Blockfrost is required for non-mainnet protocol parameters.");
  const response = await fetch("https://api.koios.rest/api/v1/epoch_params", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Koios protocol params failed (${response.status}).`);
  const rows = await response.json() as Array<Record<string, unknown>>;
  return rows[0] || {};
}
function unitToMultiasset(unit: string, quantity: string, target: any) {
  const [policy, assetName = ""] = unit.split(".");
  if (!policy || !assetName) throw new Error(`Invalid asset unit: ${unit}`);
  target.set_asset(CSL.ScriptHash.from_hex(policy), CSL.AssetName.new(hexToBytes(assetName)), CSL.BigNum.from_str(quantity));
}
function valueFromAssets(assets: AssetLine[]) {
  let coin = "0";
  const ma = CSL.MultiAsset.new();
  for (const asset of assets) {
    const quantity = String(asset.quantity || "0");
    if (asset.unit === "lovelace") coin = (BigInt(coin) + BigInt(quantity)).toString();
    else unitToMultiasset(asset.unit, quantity, ma);
  }
  return ma.len() ? CSL.Value.new_with_assets(CSL.BigNum.from_str(coin), ma) : CSL.Value.new(CSL.BigNum.from_str(coin));
}
function adjustOutputForMinAda(address: any, value: any, params: Record<string, unknown>) {
  const output = CSL.TransactionOutput.new(address, value);
  if (!value.multiasset()) return { output, value, adjustedCoin: value.coin().to_str(), minCoin: value.coin().to_str(), adjusted: false };
  const coinsPerUtxo = String(params.coins_per_utxo_size || params.coins_per_utxo_byte || "4310");
  const minCoin = CSL.min_ada_for_output(output, CSL.DataCost.new_coins_per_byte(CSL.BigNum.from_str(coinsPerUtxo)));
  if (value.coin().compare(minCoin) >= 0) return { output, value, adjustedCoin: value.coin().to_str(), minCoin: minCoin.to_str(), adjusted: false };
  value.set_coin(minCoin);
  return { output: CSL.TransactionOutput.new(address, value), value, adjustedCoin: minCoin.to_str(), minCoin: minCoin.to_str(), adjusted: true };
}
function withAdjustedAda(assets: AssetLine[], adjustedCoin: string) {
  let found = false;
  const next = assets.map((asset) => {
    if (asset.unit !== "lovelace") return asset;
    found = true;
    return { ...asset, quantity: adjustedCoin, decimals: 6 };
  });
  if (!found) next.unshift({ unit: "lovelace", quantity: adjustedCoin, decimals: 6 });
  return next;
}
function valueFromUtxo(utxo: KoiosUtxo) {
  const ma = CSL.MultiAsset.new();
  for (const asset of utxo.asset_list || []) {
    if (asset.policy_id && asset.asset_name && asset.quantity) unitToMultiasset(`${asset.policy_id}.${asset.asset_name}`, String(asset.quantity), ma);
  }
  return ma.len() ? CSL.Value.new_with_assets(CSL.BigNum.from_str(String(utxo.value || "0")), ma) : CSL.Value.new(CSL.BigNum.from_str(String(utxo.value || "0")));
}
function configFromParams(params: Record<string, unknown>) {
  const minFeeA = String(params.min_fee_a || "44");
  const minFeeB = String(params.min_fee_b || "155381");
  const coinsPerUtxo = String(params.coins_per_utxo_size || params.coins_per_utxo_byte || "4310");
  return CSL.TransactionBuilderConfigBuilder.new()
    .fee_algo(CSL.LinearFee.new(CSL.BigNum.from_str(minFeeA), CSL.BigNum.from_str(minFeeB)))
    .coins_per_utxo_byte(CSL.BigNum.from_str(coinsPerUtxo))
    .pool_deposit(CSL.BigNum.from_str(String(params.pool_deposit || "500000000")))
    .key_deposit(CSL.BigNum.from_str(String(params.key_deposit || "2000000")))
    .max_value_size(Number(params.max_val_size || 5000))
    .max_tx_size(Number(params.max_tx_size || 16384))
    .build();
}
function assertBuildRequest(body: unknown): BuildRequest {
  const input = body as BuildRequest;
  if (!input?.wallet?.paymentScript) throw new Error("Missing payment script.");
  if (!input.recipient || !validAddress(input.recipient)) throw new Error("Enter a valid recipient address.");
  if (!Array.isArray(input.assets) || !input.assets.length) throw new Error("Select at least one asset.");
  return input;
}

export async function action({ request }: { request: Request }) {
  try {
    const input = assertBuildRequest(await request.json());
    const source = await resolveSource(input.wallet);
    const utxos = await addressUtxos(source.address);
    if (!utxos.length) throw new Error("No spendable UTxOs found for this multisig address.");
    const params = await epochParams();
    const builder = CSL.TransactionBuilder.new(configFromParams(params));
    const paymentScript = scriptToCsl(input.wallet.paymentScript);
    for (const utxo of utxos) {
      const txInput = CSL.TransactionInput.new(CSL.TransactionHash.from_hex(utxo.tx_hash), Number(utxo.tx_index));
      builder.add_native_script_input(paymentScript, txInput, valueFromUtxo(utxo));
    }
    const recipient = CSL.Address.from_bech32(input.recipient);
    const adjustedOutput = adjustOutputForMinAda(recipient, valueFromAssets(input.assets), params);
    builder.add_output(adjustedOutput.output);
    builder.add_change_if_needed(CSL.Address.from_bech32(source.address));
    const tx = builder.build_tx_unsafe();
    return Response.json({ ok: true, unsignedTxCbor: tx.to_hex(), fee: tx.body().fee().to_str(), sourceAddress: source.address, handle: source.handle, inputCount: utxos.length, adjustedMinAda: adjustedOutput.adjusted, minAda: adjustedOutput.minCoin, assets: withAdjustedAda(input.assets, adjustedOutput.adjustedCoin) });
  } catch (error) {
    console.error("build-tx failed", errorMessage(error));
    return Response.json({ ok: false, error: errorMessage(error) }, { status: 400 });
  }
}
