import * as React from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

export function Dialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex min-h-screen items-start justify-center overflow-y-auto bg-black/70 px-4 py-6 backdrop-blur-sm sm:py-10">
      <button
        type="button"
        aria-label="Close dialog"
        className="fixed inset-0 cursor-default"
        onClick={() => onOpenChange(false)}
      />
      {children}
    </div>
  );
}

export function DialogContent({
  className,
  children,
  onClose,
  ...props
}: React.ComponentProps<"section"> & { onClose?: () => void }) {
  return (
    <section
      role="dialog"
      aria-modal="true"
      className={cn(
        "glass-panel relative z-10 w-full max-w-4xl overflow-hidden text-zinc-100",
        className,
      )}
      {...props}
    >
      {onClose ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute right-3 top-3 z-10 size-8 text-zinc-400 hover:text-zinc-100"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X className="size-4" />
        </Button>
      ) : null}
      {children}
    </section>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("border-b border-border px-5 py-4 pr-12", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-xl font-semibold text-zinc-50", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("mt-1 text-sm leading-6 text-zinc-400", className)} {...props} />;
}

export function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("max-h-[min(76vh,920px)] overflow-y-auto p-5", className)} {...props} />;
}
