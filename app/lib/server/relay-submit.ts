import * as CSL from "@emurgo/cardano-serialization-lib-browser";
import type { NativeScript } from "../multisig";
import type { RelayRoomRecord } from "./relay-room-store";

function scriptToCsl(script: NativeScript): any {
  if (script.type === "sig" && script.keyHash) {
    return CSL.NativeScript.new_script_pubkey(CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(script.keyHash)));
  }
  const children = CSL.NativeScripts.new();
  for (const child of script.scripts || []) children.add(scriptToCsl(child));
  if (script.type === "all") return CSL.NativeScript.new_script_all(CSL.ScriptAll.new(children));
  if (script.type === "any") return CSL.NativeScript.new_script_any(CSL.ScriptAny.new(children));
  if (script.type === "atLeast") return CSL.NativeScript.new_script_n_of_k(CSL.ScriptNOfK.new(Number(script.required || 1), children));
  throw new Error(`Unsupported native script type: ${script.type}`);
}

function mergeVkeyWitnesses(current: any, incoming: any) {
  const merged = CSL.Vkeywitnesses.new();
  const seen = new Set<string>();
  const pushAll = (collection: any) => {
    if (!collection) return;
    for (let index = 0; index < collection.len(); index += 1) {
      const witness = collection.get(index);
      const key = witness.vkey().public_key().to_hex();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.add(witness);
    }
  };
  pushAll(current);
  pushAll(incoming);
  return merged.len() ? merged : undefined;
}

function mergeBootstrapWitnesses(current: any, incoming: any) {
  const merged = CSL.BootstrapWitnesses.new();
  const seen = new Set<string>();
  const pushAll = (collection: any) => {
    if (!collection) return;
    for (let index = 0; index < collection.len(); index += 1) {
      const witness = collection.get(index);
      const key = witness.vkey().public_key().to_hex();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.add(witness);
    }
  };
  pushAll(current);
  pushAll(incoming);
  return merged.len() ? merged : undefined;
}

function mergeNativeScripts(current: any, incoming: any) {
  const merged = CSL.NativeScripts.new();
  const seen = new Set<string>();
  const pushScript = (script: any) => {
    const key = script.hash().to_hex();
    if (seen.has(key)) return;
    seen.add(key);
    merged.add(script);
  };
  const pushAll = (collection: any) => {
    if (!collection) return;
    for (let index = 0; index < collection.len(); index += 1) {
      pushScript(collection.get(index));
    }
  };
  pushAll(current);
  pushAll(incoming);
  return merged.len() ? merged : undefined;
}

function nativeScriptsFromRoom(room: RelayRoomRecord) {
  const scripts = CSL.NativeScripts.new();
  if (room.tx.paymentScript) scripts.add(scriptToCsl(room.tx.paymentScript));
  if (room.tx.stakeScript) scripts.add(scriptToCsl(room.tx.stakeScript));
  return scripts.len() ? scripts : undefined;
}

export function buildSignedRelayTransactionCbor(room: RelayRoomRecord) {
  const unsigned = CSL.Transaction.from_hex(room.tx.unsignedTxCbor.trim());
  const witnessSet = CSL.TransactionWitnessSet.new();
  const unsignedWitnessSet = unsigned.witness_set();

  let vkeys = mergeVkeyWitnesses(undefined, unsignedWitnessSet.vkeys());
  let bootstraps = mergeBootstrapWitnesses(undefined, unsignedWitnessSet.bootstraps());
  let nativeScripts = mergeNativeScripts(nativeScriptsFromRoom(room), unsignedWitnessSet.native_scripts());

  for (const witness of room.witnesses) {
    if (witness.matchStatus !== "matched" || !witness.matchedSignerKeyHash) continue;
    const incoming = CSL.TransactionWitnessSet.from_hex(witness.witnessCbor);
    vkeys = mergeVkeyWitnesses(vkeys, incoming.vkeys());
    bootstraps = mergeBootstrapWitnesses(bootstraps, incoming.bootstraps());
    nativeScripts = mergeNativeScripts(nativeScripts, incoming.native_scripts());
  }

  if (vkeys?.len()) witnessSet.set_vkeys(vkeys);
  if (bootstraps?.len()) witnessSet.set_bootstraps(bootstraps);
  if (nativeScripts?.len()) witnessSet.set_native_scripts(nativeScripts);

  return CSL.Transaction.new(unsigned.body(), witnessSet, unsigned.auxiliary_data()).to_hex();
}
