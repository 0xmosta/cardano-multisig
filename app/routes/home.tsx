import { useEffect, useMemo, useState } from "react";
import type { Route } from "./+types/home";

type Network = "mainnet" | "preprod" | "preview";

type Signer = {
  id: string;
  label: string;
  keyHash: string;
};

type NativeScript =
  | { type: "sig"; keyHash: string }
  | { type: "all" | "any"; scripts: NativeScript[] }
  | { type: "atLeast"; required: number; scripts: NativeScript[] };

type MultisigWallet = {
  id: string;
  name: string;
  network: Network;
  threshold: number;
  signers: Signer[];
  script: NativeScript;
  createdAt: string;
};

const STORAGE_KEY = "cardano-multisig.wallets.v1";
const NETWORKS: Network[] = ["mainnet", "preprod", "preview"];

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Cardano Multisig" },
    {
      name: "description",
      content: "Minimal Cardano native-script multisig wallet planner",
    },
  ];
}

function createId(prefix = "id") {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}`;
}

function emptySigner(label = "Signer"): Signer {
  return { id: createId("signer"), label, keyHash: "" };
}

function isKeyHash(value: string) {
  return /^[0-9a-fA-F]{56}$/.test(value.trim());
}

function cleanSigner(signer: Signer): Signer {
  return {
    ...signer,
    label: signer.label.trim() || "Unnamed signer",
    keyHash: signer.keyHash.trim().toLowerCase(),
  };
}

function buildNativeScript(signers: Signer[], threshold: number): NativeScript {
  const sigScripts: NativeScript[] = signers.map((signer) => ({
    type: "sig",
    keyHash: signer.keyHash,
  }));

  if (threshold <= 1) {
    return { type: "any", scripts: sigScripts };
  }

  if (threshold >= sigScripts.length) {
    return { type: "all", scripts: sigScripts };
  }

  return { type: "atLeast", required: threshold, scripts: sigScripts };
}

function scriptSummary(wallet: MultisigWallet) {
  if (wallet.threshold <= 1) return `1-of-${wallet.signers.length}`;
  return `${wallet.threshold}-of-${wallet.signers.length}`;
}

function loadWallets(): MultisigWallet[] {
  if (typeof window === "undefined") return [];

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveWallets(wallets: MultisigWallet[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets, null, 2));
}

function downloadJson(name: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [wallets, setWallets] = useState<MultisigWallet[]>([]);
  const [name, setName] = useState("Team treasury");
  const [network, setNetwork] = useState<Network>("mainnet");
  const [threshold, setThreshold] = useState(2);
  const [signers, setSigners] = useState<Signer[]>([
    emptySigner("Signer 1"),
    emptySigner("Signer 2"),
    emptySigner("Signer 3"),
  ]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setWallets(loadWallets());
  }, []);

  useEffect(() => {
    saveWallets(wallets);
  }, [wallets]);

  const cleanedSigners = useMemo(() => signers.map(cleanSigner), [signers]);
  const validSigners = cleanedSigners.filter((signer) => isKeyHash(signer.keyHash));
  const clampedThreshold = Math.max(1, Math.min(threshold, validSigners.length || 1));
  const draftScript = useMemo(
    () => buildNativeScript(validSigners, clampedThreshold),
    [validSigners, clampedThreshold],
  );
  const canSave = name.trim().length > 0 && validSigners.length >= 2 && clampedThreshold <= validSigners.length;
  const scriptJson = JSON.stringify(draftScript, null, 2);

  function updateSigner(id: string, patch: Partial<Signer>) {
    setSigners((current) =>
      current.map((signer) => (signer.id === id ? { ...signer, ...patch } : signer)),
    );
  }

  function addSigner() {
    setSigners((current) => [...current, emptySigner(`Signer ${current.length + 1}`)]);
  }

  function removeSigner(id: string) {
    setSigners((current) => current.filter((signer) => signer.id !== id));
  }

  function saveWallet() {
    if (!canSave) return;

    const wallet: MultisigWallet = {
      id: createId("wallet"),
      name: name.trim(),
      network,
      threshold: clampedThreshold,
      signers: validSigners,
      script: draftScript,
      createdAt: new Date().toISOString(),
    };

    setWallets((current) => [wallet, ...current]);
  }

  async function copyScript() {
    await navigator.clipboard.writeText(scriptJson);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Cardano native scripts</p>
          <h1>Simple multisig workspaces.</h1>
          <p className="hero-copy">
            Create a minimal M-of-N Cardano multisig plan, collect signer key hashes,
            and export the native script JSON your team can verify before funding.
          </p>
        </div>
        <div className="hero-card" aria-label="Current draft summary">
          <span className="metric">{validSigners.length}</span>
          <span className="metric-label">valid signers</span>
          <span className="pill">{clampedThreshold}-of-{Math.max(validSigners.length, 1)}</span>
        </div>
      </section>

      <section className="grid">
        <form className="panel stack" onSubmit={(event) => event.preventDefault()}>
          <div className="panel-heading">
            <div>
              <p className="eyebrow">New wallet</p>
              <h2>Define policy</h2>
            </div>
            <span className="status-dot" aria-hidden />
          </div>

          <label>
            Wallet name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <div className="split">
            <label>
              Network
              <select value={network} onChange={(event) => setNetwork(event.target.value as Network)}>
                {NETWORKS.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              Required signatures
              <input
                min={1}
                max={Math.max(validSigners.length, 1)}
                type="number"
                value={threshold}
                onChange={(event) => setThreshold(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="section-title">
            <h3>Signers</h3>
            <button className="ghost" type="button" onClick={addSigner}>Add signer</button>
          </div>

          <div className="signers">
            {signers.map((signer, index) => {
              const valid = signer.keyHash.length === 0 || isKeyHash(signer.keyHash);
              return (
                <div className="signer" key={signer.id}>
                  <input
                    aria-label={`Signer ${index + 1} label`}
                    value={signer.label}
                    onChange={(event) => updateSigner(signer.id, { label: event.target.value })}
                  />
                  <input
                    aria-label={`Signer ${index + 1} payment key hash`}
                    className={valid ? "" : "invalid"}
                    placeholder="56-char payment key hash"
                    value={signer.keyHash}
                    onChange={(event) => updateSigner(signer.id, { keyHash: event.target.value })}
                  />
                  <button
                    aria-label={`Remove signer ${index + 1}`}
                    className="icon-button"
                    disabled={signers.length <= 2}
                    type="button"
                    onClick={() => removeSigner(signer.id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          <div className="callout">
            <strong>Safety note:</strong> do not fund the resulting address until every signer verifies
            the final script and a small test transaction succeeds.
          </div>

          <div className="actions">
            <button className="primary" disabled={!canSave} type="button" onClick={saveWallet}>
              Save workspace
            </button>
            <button className="secondary" disabled={validSigners.length === 0} type="button" onClick={copyScript}>
              {copied ? "Copied" : "Copy script"}
            </button>
          </div>
        </form>

        <aside className="panel stack">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Native script preview</p>
              <h2>{validSigners.length ? `${clampedThreshold}-of-${validSigners.length}` : "Waiting for signers"}</h2>
            </div>
          </div>
          <pre className="code"><code>{scriptJson}</code></pre>
          <button
            className="secondary full"
            disabled={!canSave}
            type="button"
            onClick={() => downloadJson(`${name.trim().replaceAll(" ", "-").toLowerCase()}-native-script.json`, draftScript)}
          >
            Download native-script JSON
          </button>
        </aside>
      </section>

      <section className="panel stack">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Saved locally</p>
            <h2>Wallet workspaces</h2>
          </div>
          <span className="pill muted">{wallets.length} saved</span>
        </div>

        {wallets.length === 0 ? (
          <p className="empty">No wallets saved yet. Add signer key hashes and save the first workspace.</p>
        ) : (
          <div className="wallet-list">
            {wallets.map((wallet) => (
              <article className="wallet-card" key={wallet.id}>
                <div>
                  <h3>{wallet.name}</h3>
                  <p>{wallet.network} · {scriptSummary(wallet)} · {wallet.signers.length} signers</p>
                </div>
                <div className="wallet-actions">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() => downloadJson(`${wallet.name.replaceAll(" ", "-").toLowerCase()}-wallet.json`, wallet)}
                  >
                    Export
                  </button>
                  <button
                    className="danger"
                    type="button"
                    onClick={() => setWallets((current) => current.filter((item) => item.id !== wallet.id))}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
