import * as CSL from "@emurgo/cardano-serialization-lib-browser";
import type { SignatureRecord, TxDraft } from "./multisig";
import { normalizeKeyHash } from "./multisig";

export function verifiedWitnessKeyHashes(unsignedTxCbor: string, witnessCbor: string) {
  const txHashBytes = CSL.FixedTransaction.from_hex(unsignedTxCbor.trim().toLowerCase()).transaction_hash().to_bytes();
  const witnessSet = CSL.TransactionWitnessSet.from_hex(witnessCbor.trim().toLowerCase());
  const keyHashes = new Set<string>();

  const vkeys = witnessSet.vkeys();
  if (vkeys) {
    for (let index = 0; index < vkeys.len(); index += 1) {
      const witness = vkeys.get(index);
      const publicKey = witness.vkey().public_key();
      if (publicKey.verify(txHashBytes, witness.signature())) {
        keyHashes.add(publicKey.hash().to_hex().toLowerCase());
      }
    }
  }

  const bootstraps = witnessSet.bootstraps();
  if (bootstraps) {
    for (let index = 0; index < bootstraps.len(); index += 1) {
      const witness = bootstraps.get(index);
      const publicKey = witness.vkey().public_key();
      if (publicKey.verify(txHashBytes, witness.signature())) {
        keyHashes.add(publicKey.hash().to_hex().toLowerCase());
      }
    }
  }

  if (!keyHashes.size) {
    throw new Error("Witness CBOR does not contain a valid signature for this transaction body.");
  }

  return [...keyHashes];
}

export function verifySignatureRecordsForDraft(
  draft: Pick<TxDraft, "unsignedTxCbor" | "signerKeyHashes">,
  signatures: SignatureRecord[],
) {
  const expected = new Set(draft.signerKeyHashes.map(normalizeKeyHash));
  return signatures.map((signature) => {
    const verifiedKeyHashes = verifiedWitnessKeyHashes(draft.unsignedTxCbor, signature.witnessCbor);
    const matchedSignerKeyHash = verifiedKeyHashes.find((keyHash) => expected.has(keyHash));
    const signerKeyHash = matchedSignerKeyHash || verifiedKeyHashes[0] || normalizeKeyHash(signature.signerKeyHash);
    return {
      ...signature,
      signerKeyHash,
      matchedSignerKeyHash,
      matchStatus: matchedSignerKeyHash ? ("matched" as const) : ("unmatched" as const),
    };
  });
}
