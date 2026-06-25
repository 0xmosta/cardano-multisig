type ServiceFlags = {
  kupo: boolean;
  ogmios: boolean;
  submit: boolean;
};

function hasAnyEnv(names: string[]) {
  return names.some((name) => Boolean(process.env[name]?.trim()));
}

export async function loader() {
  const services: ServiceFlags = {
    kupo: hasAnyEnv(["CARDANO_KUPO_URL", "KUPO_URL"]),
    ogmios: hasAnyEnv(["CARDANO_OGMIOS_URL", "OGMIOS_URL"]),
    submit: hasAnyEnv(["CARDANO_SUBMIT_URL", "CARDANO_NODE_SUBMIT_URL", "CARDANO_SUBMIT_API_URL"]),
  };

  return Response.json({
    mode: "server",
    ready: services.kupo || services.ogmios || services.submit,
    services,
  });
}
