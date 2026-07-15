import { useEffect, useState } from "react";
import { normalizeKeyHash } from "./multisig";

export type SignerHandle = { name: string; stakeAddress: string };
export type SignerHandleMap = Record<string, SignerHandle>;

const signerHandleCache = new Map<string, SignerHandle | null>();

function fromCache(keyHashes: string[]) {
  const handles: SignerHandleMap = {};
  for (const keyHash of keyHashes) {
    const cached = signerHandleCache.get(keyHash);
    if (cached) handles[keyHash] = cached;
  }
  return handles;
}

export function signerHandleLabel(handle?: SignerHandle | null) {
  const name = handle?.name.trim().replace(/^\$/, "");
  return name ? `$${name}` : "";
}

export function useSignerHandles(keyHashes: string[], network?: string | null) {
  const normalizedKeys = Array.from(new Set(keyHashes.map(normalizeKeyHash).filter((keyHash) => /^[0-9a-f]{56}$/.test(keyHash)))).sort();
  const key = normalizedKeys.join(",");
  const [handles, setHandles] = useState<SignerHandleMap>(() => fromCache(normalizedKeys));

  useEffect(() => {
    if (network !== "mainnet" || !normalizedKeys.length) {
      setHandles({});
      return;
    }
    const missing = normalizedKeys.filter((keyHash) => !signerHandleCache.has(keyHash));
    if (!missing.length) {
      setHandles(fromCache(normalizedKeys));
      return;
    }

    const controller = new AbortController();
    const params = new URLSearchParams({ network, keyHashes: missing.join(",") });
    fetch(`/api/cardano/signer-handles?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ ok: boolean; handles?: SignerHandleMap }>;
      })
      .then((body) => {
        if (!body?.ok) return;
        for (const keyHash of missing) signerHandleCache.set(keyHash, body.handles?.[keyHash] || null);
        setHandles(fromCache(normalizedKeys));
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [key, network]);

  return handles;
}
