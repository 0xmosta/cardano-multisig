import { cn } from "../../lib/utils";

export function Progress({
  value,
  max,
  tone = "auto",
  className,
}: {
  value: number;
  max: number;
  tone?: "auto" | "primary" | "success";
  className?: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const complete = max > 0 && value >= max;
  const fill = tone === "success" || (tone === "auto" && complete) ? "bg-emerald-400" : "bg-zinc-100";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-white/10", className)}>
      <div className={cn("h-full rounded-full transition-all duration-500", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}
