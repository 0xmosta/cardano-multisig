import { Check, Download, FileJson, Import, Plus, ShieldCheck, Trash2, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Route } from "./+types/home";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";

type Network = "mainnet" | "preprod" | "preview";
type Mode = "create" | "import";

type Signer = {
  id: string;
  label: string;
  keyHash: string;
  source?: "payment" | "stake" | "manual";
};

type NativeScript = {
  type: "sig" | "all" | "any" | "atLeast" | "before" | "after" | string;
  keyHash?: string;
  scripts?: NativeScript[];
  required?: number;
  slot?: number;
  [key: string]: unknown;
};

type MultisigWallet = {
  id: string;
  name: string;
  network: Network;
  threshold: number;
  signers: Signer[];
  paymentScript: NativeScript;
  stakeScript?: NativeScript | null;
  script: NativeScript;
  createdAt: string;
  imported: boolean;
};

type ParsedScript = {
  script: NativeScript | null;
  error: string | null;
};

const STORAGE_KEY = "cardano-multisig.wallets.v2";
const LEGACY_STORAGE_KEY = "cardano-multisig.wallets.v1";
const NETWORKS: Network[] = ["mainnet", "preprod", "preview"];
const SAMPLE_PAYMENT_SCRIPT = `{
  "type": "atLeast",
  "required": 2,
  "scripts": [
    { "type": "sig", "keyHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { "type": "sig", "keyHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    { "type": "sig", "keyHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }
  ]
}`;
const SAMPLE_STAKE_SCRIPT = `{
  "type": "all",
  "scripts": [
    { "type": "sig", "keyHash": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }
  ]
}`;

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Cardano Multisig" },
    {
      name: "description",
      content: "Dark Cardano native-script multisig wallet planner and importer",
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
  return { id: createId("signer"), label, keyHash: "", source: "manual" };
}

function isKeyHash(value: string) {
  return /^[0-9a-fA-F]{56}$/.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanSigner(signer: Signer): Signer {
  return {
    ...signer,
    label: signer.label.trim() || "Unnamed signer",
    keyHash: signer.keyHash.trim().toLowerCase(),
  };
}

function parseScript(value: string, required: boolean): ParsedScript {
  const trimmed = value.trim();
  if (!trimmed) {
    return required ? { script: null, error: "Script JSON is required." } : { script: null, error: null };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return { script: null, error: "Script must be a JSON object with a type field." };
    }
    return { script: parsed as NativeScript, error: null };
  } catch (error) {
    return { script: null, error: error instanceof Error ? error.message : "Invalid JSON." };
  }
}

function buildNativeScript(signers: Signer[], threshold: number): NativeScript {
  const sigScripts: NativeScript[] = signers.map((signer) => ({
    type: "sig",
    keyHash: signer.keyHash,
  }));

  if (threshold <= 1) return { type: "any", scripts: sigScripts };
  if (threshold >= sigScripts.length) return { type: "all", scripts: sigScripts };
  return { type: "atLeast", required: threshold, scripts: sigScripts };
}

function countLeafScripts(script: NativeScript | null): number {
  if (!script) return 0;
  if (script.type === "sig") return 1;
  return Array.isArray(script.scripts) ? script.scripts.reduce((total, child) => total + countLeafScripts(child), 0) : 0;
}

function requiredSignatures(script: NativeScript | null): number {
  if (!script) return 0;
  const children = Array.isArray(script.scripts) ? script.scripts : [];
  if (script.type === "sig") return 1;
  if (script.type === "any") return children.length ? 1 : 0;
  if (script.type === "all") return children.reduce((total, child) => total + requiredSignatures(child), 0);
  if (script.type === "atLeast") return Number(script.required || 0);
  return children.reduce((total, child) => Math.max(total, requiredSignatures(child)), 0);
}

function summarizeScript(script: NativeScript | null) {
  if (!script) return "Not provided";
  const leaves = countLeafScripts(script);
  if (script.type === "sig") return "1-of-1";
  if (script.type === "any") return `1-of-${leaves}`;
  if (script.type === "all") return `${leaves}-of-${leaves}`;
  if (script.type === "atLeast") return `${script.required ?? 0}-of-${leaves}`;
  return `${script.type} script`;
}

function collectSigners(script: NativeScript | null, source: "payment" | "stake") {
  const signers: Signer[] = [];

  function visit(node: NativeScript | null) {
    if (!node) return;
    if (node.type === "sig" && typeof node.keyHash === "string" && isKeyHash(node.keyHash)) {
      signers.push({
        id: createId(source),
        label: `${source === "payment" ? "Payment" : "Stake"} signer ${signers.length + 1}`,
        keyHash: node.keyHash.toLowerCase(),
        source,
      });
    }
    if (Array.isArray(node.scripts)) node.scripts.forEach(visit);
  }

  visit(script);
  return signers;
}

function uniqueSigners(signers: Signer[]) {
  const seen = new Map<string, Signer>();
  for (const signer of signers) {
    if (!seen.has(signer.keyHash)) seen.set(signer.keyHash, signer);
  }
  return [...seen.values()];
}

function migrateWallet(raw: unknown): MultisigWallet | null {
  if (!isRecord(raw) || typeof raw.name !== "string" || !isRecord(raw.script)) return null;
  const script = raw.script as NativeScript;
  const signers = Array.isArray(raw.signers) ? (raw.signers as Signer[]).filter((signer) => isKeyHash(signer.keyHash)) : collectSigners(script, "payment");
  return {
    id: typeof raw.id === "string" ? raw.id : createId("wallet"),
    name: raw.name,
    network: NETWORKS.includes(raw.network as Network) ? (raw.network as Network) : "mainnet",
    threshold: typeof raw.threshold === "number" ? raw.threshold : requiredSignatures(script),
    signers,
    paymentScript: isRecord(raw.paymentScript) ? (raw.paymentScript as NativeScript) : script,
    stakeScript: isRecord(raw.stakeScript) ? (raw.stakeScript as NativeScript) : null,
    script,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    imported: Boolean(raw.imported),
  };
}

function loadWallets(): MultisigWallet[] {
  if (typeof window === "undefined") return [];

  for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    try {
      const stored = window.localStorage.getItem(key);
      if (!stored) continue;
      const parsed = JSON.parse(stored) as unknown;
      if (!Array.isArray(parsed)) continue;
      return parsed.map(migrateWallet).filter((wallet): wallet is MultisigWallet => Boolean(wallet));
    } catch {
      return [];
    }
  }
  return [];
}

function saveWallets(wallets: MultisigWallet[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets, null, 2));
}

function downloadJson(name: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function slugify(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "cardano-multisig";
}

function ScriptPreview({ title, script }: { title: string; script: NativeScript | null }) {
  return (
    <div className="rounded-lg border border-border bg-slate-950/80">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-medium text-slate-200">{title}</span>
        <Badge variant="outline">{summarizeScript(script)}</Badge>
      </div>
      <pre className="code-scroll max-h-80 overflow-auto p-4 text-xs leading-5 text-slate-300">
        <code>{script ? JSON.stringify(script, null, 2) : "// Paste script JSON to preview"}</code>
      </pre>
    </div>
  );
}

export default function Home() {
  const [wallets, setWallets] = useState<MultisigWallet[]>([]);
  const [mode, setMode] = useState<Mode>("import");
  const [name, setName] = useState("Team treasury");
  const [network, setNetwork] = useState<Network>("mainnet");
  const [threshold, setThreshold] = useState(2);
  const [signers, setSigners] = useState<Signer[]>([emptySigner("Signer 1"), emptySigner("Signer 2"), emptySigner("Signer 3")]);
  const [importName, setImportName] = useState("Existing treasury");
  const [importNetwork, setImportNetwork] = useState<Network>("mainnet");
  const [paymentScriptText, setPaymentScriptText] = useState("");
  const [stakeScriptText, setStakeScriptText] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => setWallets(loadWallets()), []);
  useEffect(() => saveWallets(wallets), [wallets]);

  const cleanedSigners = useMemo(() => signers.map(cleanSigner), [signers]);
  const validSigners = cleanedSigners.filter((signer) => isKeyHash(signer.keyHash));
  const clampedThreshold = Math.max(1, Math.min(threshold, validSigners.length || 1));
  const draftScript = useMemo(() => buildNativeScript(validSigners, clampedThreshold), [validSigners, clampedThreshold]);
  const canSave = name.trim().length > 0 && validSigners.length >= 2 && clampedThreshold <= validSigners.length;
  const scriptJson = JSON.stringify(draftScript, null, 2);

  const parsedPayment = useMemo(() => parseScript(paymentScriptText, true), [paymentScriptText]);
  const parsedStake = useMemo(() => parseScript(stakeScriptText, false), [stakeScriptText]);
  const importedSigners = useMemo(
    () => uniqueSigners([...collectSigners(parsedPayment.script, "payment"), ...collectSigners(parsedStake.script, "stake")]),
    [parsedPayment.script, parsedStake.script],
  );
  const importThreshold = requiredSignatures(parsedPayment.script);
  const canImport = importName.trim().length > 0 && Boolean(parsedPayment.script) && !parsedPayment.error && !parsedStake.error;

  function updateSigner(id: string, patch: Partial<Signer>) {
    setSigners((current) => current.map((signer) => (signer.id === id ? { ...signer, ...patch } : signer)));
  }

  function saveCreatedWallet() {
    if (!canSave) return;
    const wallet: MultisigWallet = {
      id: createId("wallet"),
      name: name.trim(),
      network,
      threshold: clampedThreshold,
      signers: validSigners,
      paymentScript: draftScript,
      stakeScript: null,
      script: draftScript,
      createdAt: new Date().toISOString(),
      imported: false,
    };
    setWallets((current) => [wallet, ...current]);
  }

  function importWallet() {
    if (!canImport || !parsedPayment.script) return;
    const wallet: MultisigWallet = {
      id: createId("wallet"),
      name: importName.trim(),
      network: importNetwork,
      threshold: importThreshold,
      signers: importedSigners,
      paymentScript: parsedPayment.script,
      stakeScript: parsedStake.script,
      script: parsedPayment.script,
      createdAt: new Date().toISOString(),
      imported: true,
    };
    setWallets((current) => [wallet, ...current]);
  }

  async function copyScript() {
    await navigator.clipboard.writeText(scriptJson);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 text-slate-100 sm:px-6 lg:px-8">
      <section className="grid gap-6 lg:grid-cols-[1fr_360px] lg:items-end">
        <div className="space-y-5">
          <Badge variant="outline" className="border-sky-400/30 bg-sky-400/10 text-sky-200">Cardano native scripts</Badge>
          <div className="space-y-4">
            <h1 className="max-w-4xl text-5xl font-semibold tracking-[-0.08em] text-slate-50 sm:text-7xl lg:text-8xl">
              Multisig control room.
            </h1>
            <p className="max-w-2xl text-base leading-7 text-slate-400 sm:text-lg">
              Import an existing Cardano wallet from payment and stake native scripts, or draft a new M-of-N policy. Everything stays local in your browser.
            </p>
          </div>
        </div>
        <Card className="glass-panel overflow-hidden">
          <CardContent className="grid grid-cols-3 gap-3 p-5">
            <div className="rounded-lg border border-border bg-slate-950/60 p-3">
              <div className="text-2xl font-semibold text-sky-200">{wallets.length}</div>
              <div className="text-xs text-slate-400">wallets</div>
            </div>
            <div className="rounded-lg border border-border bg-slate-950/60 p-3">
              <div className="text-2xl font-semibold text-sky-200">{mode === "import" ? importedSigners.length : validSigners.length}</div>
              <div className="text-xs text-slate-400">signers</div>
            </div>
            <div className="rounded-lg border border-border bg-slate-950/60 p-3">
              <div className="text-2xl font-semibold text-sky-200">{mode === "import" ? importThreshold || "—" : clampedThreshold}</div>
              <div className="text-xs text-slate-400">required</div>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.95fr)]">
        <Card className="glass-panel">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2"><WalletCards className="size-5 text-sky-300" /> Wallet workspace</CardTitle>
                <CardDescription>Use the importer for existing treasury scripts, or create a clean policy.</CardDescription>
              </div>
              <div className="grid grid-cols-2 rounded-lg border border-border bg-slate-950/70 p-1">
                {(["import", "create"] as Mode[]).map((item) => (
                  <Button key={item} variant={mode === item ? "default" : "ghost"} size="sm" onClick={() => setMode(item)}>
                    {item === "import" ? <Import className="size-4" /> : <Plus className="size-4" />}
                    {item}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>

          {mode === "import" ? (
            <CardContent className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
                <div className="space-y-2">
                  <Label htmlFor="import-name">Wallet name</Label>
                  <Input id="import-name" value={importName} onChange={(event) => setImportName(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="import-network">Network</Label>
                  <select
                    id="import-network"
                    value={importNetwork}
                    onChange={(event) => setImportNetwork(event.target.value as Network)}
                    className="h-10 w-full rounded-md border border-input bg-slate-950/60 px-3 text-sm text-slate-100 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-sky-400/40"
                  >
                    {NETWORKS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="payment-script">Payment script JSON</Label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPaymentScriptText(SAMPLE_PAYMENT_SCRIPT)}>Load sample</Button>
                </div>
                <Textarea
                  id="payment-script"
                  value={paymentScriptText}
                  onChange={(event) => setPaymentScriptText(event.target.value)}
                  placeholder="Paste the existing payment native script JSON"
                  className="min-h-52 font-mono text-xs"
                  aria-invalid={Boolean(parsedPayment.error)}
                />
                {parsedPayment.error ? <p className="text-sm text-red-300">{parsedPayment.error}</p> : null}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="stake-script">Stake script JSON</Label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setStakeScriptText(SAMPLE_STAKE_SCRIPT)}>Load sample</Button>
                </div>
                <Textarea
                  id="stake-script"
                  value={stakeScriptText}
                  onChange={(event) => setStakeScriptText(event.target.value)}
                  placeholder="Paste stake native script JSON if the existing wallet has one"
                  className="min-h-40 font-mono text-xs"
                  aria-invalid={Boolean(parsedStake.error)}
                />
                {parsedStake.error ? <p className="text-sm text-red-300">{parsedStake.error}</p> : null}
              </div>

              <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-4 text-sm leading-6 text-sky-100">
                <div className="mb-1 flex items-center gap-2 font-medium"><ShieldCheck className="size-4" /> Import safety</div>
                Importing preserves the script JSON for verification. It does not prove control of funds; verify the final address and run a dust transaction before moving value.
              </div>

              <Button disabled={!canImport} onClick={importWallet} className="w-full">
                <Import className="size-4" /> Import existing wallet
              </Button>
            </CardContent>
          ) : (
            <CardContent className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
                <div className="space-y-2">
                  <Label htmlFor="wallet-name">Wallet name</Label>
                  <Input id="wallet-name" value={name} onChange={(event) => setName(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="network">Network</Label>
                  <select id="network" value={network} onChange={(event) => setNetwork(event.target.value as Network)} className="h-10 w-full rounded-md border border-input bg-slate-950/60 px-3 text-sm text-slate-100 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-sky-400/40">
                    {NETWORKS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="threshold">Required signatures</Label>
                <Input id="threshold" min={1} max={Math.max(validSigners.length, 1)} type="number" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Signers</Label>
                  <Button variant="secondary" size="sm" onClick={() => setSigners((current) => [...current, emptySigner(`Signer ${current.length + 1}`)])}>
                    <Plus className="size-4" /> Add signer
                  </Button>
                </div>
                {signers.map((signer, index) => {
                  const valid = signer.keyHash.length === 0 || isKeyHash(signer.keyHash);
                  return (
                    <div className="grid gap-2 sm:grid-cols-[160px_1fr_40px]" key={signer.id}>
                      <Input aria-label={`Signer ${index + 1} label`} value={signer.label} onChange={(event) => updateSigner(signer.id, { label: event.target.value })} />
                      <Input aria-label={`Signer ${index + 1} payment key hash`} aria-invalid={!valid} placeholder="56-char payment key hash" value={signer.keyHash} onChange={(event) => updateSigner(signer.id, { keyHash: event.target.value })} />
                      <Button aria-label={`Remove signer ${index + 1}`} variant="secondary" size="icon" disabled={signers.length <= 2} onClick={() => setSigners((current) => current.filter((item) => item.id !== signer.id))}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Button disabled={!canSave} onClick={saveCreatedWallet}><Check className="size-4" /> Save workspace</Button>
                <Button variant="secondary" disabled={validSigners.length === 0} onClick={copyScript}>{copied ? "Copied" : "Copy script"}</Button>
              </div>
            </CardContent>
          )}
        </Card>

        <div className="space-y-6">
          {mode === "import" ? (
            <Card className="glass-panel">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><FileJson className="size-5 text-sky-300" /> Import preview</CardTitle>
                <CardDescription>{importedSigners.length} unique signer key hashes discovered.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-border bg-slate-950/60 p-3"><div className="text-xs text-slate-400">Payment</div><div className="font-semibold text-slate-100">{summarizeScript(parsedPayment.script)}</div></div>
                  <div className="rounded-lg border border-border bg-slate-950/60 p-3"><div className="text-xs text-slate-400">Stake</div><div className="font-semibold text-slate-100">{summarizeScript(parsedStake.script)}</div></div>
                </div>
                <ScriptPreview title="Payment script" script={parsedPayment.script} />
                <ScriptPreview title="Stake script" script={parsedStake.script} />
              </CardContent>
            </Card>
          ) : (
            <Card className="glass-panel">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><FileJson className="size-5 text-sky-300" /> Native script preview</CardTitle>
                <CardDescription>{validSigners.length ? `${clampedThreshold}-of-${validSigners.length}` : "Waiting for valid signers"}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <ScriptPreview title="Payment script" script={draftScript} />
                <Button variant="secondary" disabled={!canSave} className="w-full" onClick={() => downloadJson(`${slugify(name)}-payment-script.json`, draftScript)}>
                  <Download className="size-4" /> Download native-script JSON
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <Card className="glass-panel">
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div>
              <CardTitle>Saved wallets</CardTitle>
              <CardDescription>Stored only in this browser. Export before switching machines.</CardDescription>
            </div>
            <Badge variant="secondary">{wallets.length} saved</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {wallets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-slate-950/40 p-8 text-center text-slate-400">No wallets saved yet. Import scripts or create a new policy to start.</div>
          ) : (
            <div className="grid gap-3">
              {wallets.map((wallet) => (
                <article className="grid gap-4 rounded-lg border border-border bg-slate-950/55 p-4 sm:grid-cols-[1fr_auto] sm:items-center" key={wallet.id}>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold text-slate-100">{wallet.name}</h3>
                      <Badge variant={wallet.imported ? "default" : "secondary"}>{wallet.imported ? "imported" : "created"}</Badge>
                    </div>
                    <p className="text-sm text-slate-400">
                      {wallet.network} · payment {summarizeScript(wallet.paymentScript)} · stake {summarizeScript(wallet.stakeScript ?? null)} · {wallet.signers.length} signers
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => downloadJson(`${slugify(wallet.name)}-wallet.json`, wallet)}><Download className="size-4" /> Export</Button>
                    <Button variant="destructive" onClick={() => setWallets((current) => current.filter((item) => item.id !== wallet.id))}><Trash2 className="size-4" /> Delete</Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
