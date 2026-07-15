const baseUrl = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const checks = [
  {
    path: "/",
    expect: ["Cardano multisig"],
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "frame-ancestors 'none'",
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  },
  { path: "/wallets", expect: ["Wallets"] },
  { path: "/wallets/import", expect: ["Cardano multisig"] },
  { path: "/transactions", expect: ["Transactions"] },
  { path: "/transactions/tx-smoke", expect: ["Transaction not found"] },
  { path: "/sign", expect: ["Cardano multisig"] },
  { path: "/favicon.svg", contentType: "image/svg+xml" },
  { path: "/api/cardano/provider", json: true, expectJson: ["ready", "network"] },
  { path: "/api/health", json: true, expectJson: ["ok", "network", "persistence"] },
  { path: "/api/account/sessions", status: 401, json: true, expectJson: ["error"] },
  { path: "/api/cardano/signer-handles", json: true, expectJson: ["ok", "handles"] },
  { path: "/api/cardano/build-tx", method: "POST", body: {}, status: 401, json: true, expectJson: ["error"] },
  { path: "/api/cardano/submit", method: "POST", body: {}, status: 401, json: true, expectJson: ["error"] },
  { path: "/api/cardano/relay-room", method: "POST", body: { intent: "create" }, status: 401, json: true, expectJson: ["error"] },
];

let failed = false;

for (const check of checks) {
  const url = `${baseUrl}${check.path}`;
  try {
    const response = await fetch(url, check.method
      ? {
          method: check.method,
          headers: { "content-type": "application/json", origin: baseUrl },
          body: JSON.stringify(check.body || {}),
        }
      : undefined);
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();

    const expectedStatus = check.status || 200;
    if (response.status !== expectedStatus) {
      throw new Error(`expected HTTP ${expectedStatus}, got ${response.status}`);
    }

    if (check.contentType && !contentType.includes(check.contentType)) {
      throw new Error(`expected content-type ${check.contentType}, got ${contentType || "none"}`);
    }

    if (check.json) {
      const parsed = JSON.parse(body);
      for (const key of check.expectJson || []) {
        if (!(key in parsed)) throw new Error(`missing JSON key ${key}`);
      }
    }

    for (const [name, expected] of Object.entries(check.headers || {})) {
      const actual = response.headers.get(name) || "";
      if (!actual.includes(expected)) throw new Error(`expected header ${name} to include "${expected}", got "${actual || "none"}"`);
    }

    for (const text of check.expect || []) {
      if (!body.includes(text)) throw new Error(`missing text "${text}"`);
    }

    console.log(`ok ${check.path}`);
  } catch (error) {
    failed = true;
    console.error(`fail ${check.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) process.exit(1);
