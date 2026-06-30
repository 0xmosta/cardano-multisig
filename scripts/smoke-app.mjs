const baseUrl = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const checks = [
  { path: "/", expect: ["Cardano multisig"] },
  { path: "/wallets", expect: ["Wallets"] },
  { path: "/transactions", expect: ["Transactions"] },
  { path: "/favicon.svg", contentType: "image/svg+xml" },
  { path: "/api/cardano/provider", json: true, expectJson: ["ready", "network"] },
];

let failed = false;

for (const check of checks) {
  const url = `${baseUrl}${check.path}`;
  try {
    const response = await fetch(url);
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
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
