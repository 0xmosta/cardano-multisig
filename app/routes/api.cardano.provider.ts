type ServiceFlags = {
  blockfrost: boolean;
  kupo: boolean;
  ogmios: boolean;
  submit: boolean;
};

function hasAnyEnv(names: string[]) {
  return names.some((name) => Boolean(process.env[name]?.trim()));
}

function configuredNetwork() {
  const value = (process.env.CARDANO_NETWORK || process.env.VITE_CARDANO_NETWORK || "preprod").trim().toLowerCase();
  return value === "mainnet" || value === "preview" ? value : "preprod";
}

export async function loader() {
  const network = configuredNetwork();
  const blockfrost = hasAnyEnv(["BLOCKFROST_PROJECT_ID", "CARDANO_BLOCKFROST_PROJECT_ID"]);
  const submitEnv = hasAnyEnv(["CARDANO_SUBMIT_URL", "CARDANO_NODE_SUBMIT_URL", "CARDANO_SUBMIT_API_URL"]);
  const services: ServiceFlags = {
    blockfrost,
    kupo: hasAnyEnv(["CARDANO_KUPO_URL", "KUPO_URL"]),
    ogmios: hasAnyEnv(["CARDANO_OGMIOS_URL", "OGMIOS_URL"]),
    submit: network !== "mainnet" && (blockfrost || submitEnv),
  };

  return Response.json({
    mode: "server",
    network,
    ready: services.blockfrost || services.kupo || services.ogmios || services.submit,
    services,
  });
}
