import assert from "node:assert/strict";
import { installedBrowserWallets, type BrowserWalletApi } from "../app/lib/browser-wallets.ts";

const calls: string[] = [];
const api: BrowserWalletApi = {
  async getUsedAddresses() { calls.push("getUsedAddresses"); return ["01".repeat(57)]; },
  async getUnusedAddresses() { calls.push("getUnusedAddresses"); return []; },
  async getChangeAddress() { calls.push("getChangeAddress"); return "01".repeat(57); },
  async getRewardAddresses() { calls.push("getRewardAddresses"); return ["e1".repeat(29)]; },
  async getNetworkId() { calls.push("getNetworkId"); return 0; },
  async signData(addressHex, payloadHex) {
    calls.push(`signData:${addressHex.length}:${payloadHex.length}`);
    return { signature: "a1", key: "a2" };
  },
  async signTx(txCbor, partialSign) {
    calls.push(`signTx:${txCbor}:${String(partialSign)}`);
    return "a100";
  },
  async submitTx(txCbor) { calls.push(`submitTx:${txCbor}`); return "ab".repeat(32); },
};

const eternl = { name: "Eternl", icon: "data:image/svg+xml,test", async enable() { calls.push("enable"); return api; } };
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { cardano: { eternl, Eternl: eternl, unsupported: { name: "Unsupported", enable: async () => api } } },
});

const providers = installedBrowserWallets();
assert.equal(providers.length, 1, "supported aliases should be deduplicated and unknown wallets ignored");
assert.equal(providers[0]?.id.toLowerCase(), "eternl");
const connected = await providers[0]!.enable();
assert.equal(await connected.getNetworkId(), 0);
assert.equal((await connected.getUsedAddresses()).length, 1);
assert.equal(await connected.signTx("84a0", true), "a100");
assert.deepEqual(await connected.signData?.("01", "02"), { signature: "a1", key: "a2" });
assert.equal(await connected.submitTx?.("84a0"), "ab".repeat(32));
assert.deepEqual(calls, ["enable", "getNetworkId", "getUsedAddresses", "signTx:84a0:true", "signData:2:2", "submitTx:84a0"]);
console.log("CIP-30 harness passed: discovery, enable, network, address, partial signing, data signing, and submission boundaries.");
