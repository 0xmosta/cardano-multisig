# CIP-30 test harness

Run the deterministic browser-wallet boundary test with:

```bash
npm run smoke:cip30
```

The harness injects a non-custodial mock CIP-30 provider and verifies supported-provider discovery, alias deduplication, connection, network detection, address access, partial transaction signing, data signing, and submission calls. It never contains or generates a seed phrase or private key.

This test protects the application/provider contract in CI. A release that changes authentication or signing UI should additionally be exercised in a real browser with an explicitly selected test-network wallet extension, because extension permission popups cannot be faithfully automated by the in-process harness.
