import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function WindowDots() {
  return (
    <div className="flex items-center gap-1.5">
      <span className="size-2.5 rounded-full bg-rose-400/80" />
      <span className="size-2.5 rounded-full bg-amber-400/80" />
      <span className="size-2.5 rounded-full bg-emerald-400/80" />
    </div>
  );
}

export function AppWindow({
  title,
  children,
  className,
  contentClassName,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-white/8 bg-[#121214] shadow-[0_18px_50px_-34px_rgba(0,0,0,0.95)]",
        className,
      )}
    >
      <div className="flex items-center gap-4 border-b border-white/7 px-4 py-3">
        <WindowDots />
        <div className="truncate text-xs font-semibold text-zinc-400">{title}</div>
      </div>
      <div className={cn("p-4", contentClassName)}>{children}</div>
    </section>
  );
}
