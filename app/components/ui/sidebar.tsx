import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "../../lib/utils";

export function Sidebar({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="sidebar"
      className={cn("rounded-xl border border-white/10 bg-[#18181b]/95 p-1 shadow-2xl shadow-black/50 backdrop-blur", className)}
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-content" className={cn("grid gap-1", className)} {...props} />;
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sidebar-menu" className={cn("grid gap-1", className)} {...props} />;
}

export function SidebarMenuButton({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"a"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "a";
  return (
    <Comp
      data-slot="sidebar-menu-button"
      className={cn("group relative flex h-12 min-w-0 items-center justify-center gap-2 rounded-lg px-2 text-xs font-medium text-zinc-400 transition hover:bg-white/8 hover:text-zinc-50", className)}
      {...props}
    />
  );
}

export function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="sidebar-menu-badge" className={cn("absolute -right-1 -top-1", className)} {...props} />;
}
