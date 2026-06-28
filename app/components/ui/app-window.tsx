import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

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
      <div className="flex items-center border-b border-white/7 px-4 py-3">
        <div className="truncate text-xs font-semibold text-zinc-400">{title}</div>
      </div>
      <div className={cn("p-4", contentClassName)}>{children}</div>
    </section>
  );
}
