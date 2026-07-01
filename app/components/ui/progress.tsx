import * as React from "react";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import { cn } from "../../lib/utils";

export function Progress({
  value,
  max = 100,
  tone = "auto",
  className,
}: {
  value: number;
  max?: number;
  tone?: "auto" | "primary" | "success";
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const complete = max > 0 && value >= max;
  const fill = tone === "success" || (tone === "auto" && complete) ? "bg-emerald-400" : "bg-zinc-100";
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-white/10", className)}
      value={pct}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn("h-full w-full flex-1 rounded-full transition-transform duration-500", fill)}
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}
