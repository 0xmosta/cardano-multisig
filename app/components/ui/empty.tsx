import * as React from "react";
import { cn } from "../../lib/utils";

export function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn("flex min-h-40 flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-white/10 bg-black/20 p-8 text-center", className)}
      {...props}
    />
  );
}

export function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-header" className={cn("flex flex-col items-center gap-2", className)} {...props} />;
}

export function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-title" className={cn("text-sm font-medium text-zinc-100", className)} {...props} />;
}

export function EmptyDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-description" className={cn("max-w-sm text-sm text-zinc-400", className)} {...props} />;
}

export function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-content" className={cn("flex flex-wrap items-center justify-center gap-2", className)} {...props} />;
}
