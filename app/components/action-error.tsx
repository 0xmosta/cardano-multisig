import { AlertTriangle, ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { cn } from "../lib/utils";

export function ActionError({
  title = "This action needs attention",
  message,
  details,
  onRetry,
  retryAfterSeconds = 0,
  className,
}: {
  title?: string;
  message: string;
  details?: string;
  onRetry?: () => void | Promise<void>;
  retryAfterSeconds?: number;
  className?: string;
}) {
  const [remaining, setRemaining] = useState(Math.max(0, retryAfterSeconds));
  useEffect(() => {
    setRemaining(Math.max(0, retryAfterSeconds));
  }, [retryAfterSeconds]);
  useEffect(() => {
    if (!remaining) return;
    const timer = window.setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [remaining]);

  return (
    <div className={cn("rounded-xl border border-rose-400/25 bg-rose-400/[0.06] p-4", className)} role="alert">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-200" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-rose-100">{title}</div>
            <p className="mt-1 text-sm leading-6 text-rose-100/75">{message}</p>
          </div>
        </div>
        {onRetry ? (
          <Button type="button" variant="secondary" size="sm" disabled={remaining > 0} onClick={() => void onRetry()}>
            <RefreshCw className="size-4" /> {remaining ? `Try again in ${remaining}s` : "Try again"}
          </Button>
        ) : null}
      </div>
      {details && details !== message ? (
        <Collapsible className="mt-3">
          <CollapsibleTrigger className="inline-flex items-center gap-1 text-xs text-rose-100/60 hover:text-rose-100">
            Technical details <ChevronDown className="size-3" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 break-all rounded-md bg-black/25 p-3 font-mono text-xs text-rose-100/60">{details}</CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
