import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import type { Route } from "./+types/index";

export function meta({}: Route.MetaArgs) {
  return [{ title: "Cardano Multisig" }];
}

export default function IndexRoute() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
    const hasSigningPayload = hashParams.has("r") || hashParams.has("relay") || hashParams.has("invite");
    const legacyWalletWorkspace = new URLSearchParams(location.search).get("wallet") === "1";
    const target = hasSigningPayload
      ? `/sign${location.hash}`
      : legacyWalletWorkspace
        ? "/wallets/import"
        : "/wallets";
    navigate(target, { replace: true });
  }, [location.hash, location.search, navigate]);

  return <div className="sr-only" aria-live="polite">Opening Cardano multisig…</div>;
}
