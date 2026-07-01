import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "./card";

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
    <Card
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-white/8 bg-[#121214] shadow-[0_18px_50px_-34px_rgba(0,0,0,0.95)]",
        className,
      )}
    >
      <CardHeader className="flex items-center justify-between gap-3 border-b border-white/7 bg-white/[0.015] px-4 py-3">
        <CardTitle className="truncate text-xs font-semibold uppercase leading-none text-zinc-500">{title}</CardTitle>
      </CardHeader>
      <CardContent className={cn("min-w-0 p-4", contentClassName)}>{children}</CardContent>
    </Card>
  );
}
