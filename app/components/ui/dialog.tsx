import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-50 bg-black/70 backdrop-blur-sm", className)}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  onClose,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { onClose?: () => void }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <div className="fixed inset-0 z-50 flex min-h-screen items-start justify-center overflow-y-auto px-2 py-2 sm:px-4 sm:py-10">
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className={cn(
            "glass-panel relative z-10 flex max-h-[calc(100dvh-1rem)] w-full max-w-4xl flex-col overflow-hidden text-zinc-100 outline-none sm:max-h-[calc(100dvh-5rem)]",
            "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
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
          ) : (
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-3 top-3 z-10 size-8 text-zinc-400 hover:text-zinc-100"
                aria-label="Close dialog"
              >
                <X className="size-4" />
              </Button>
            </DialogPrimitive.Close>
          )}
          {children}
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("shrink-0 border-b border-border px-4 py-4 pr-12 sm:px-5", className)} {...props} />;
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-xl font-semibold text-zinc-50", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("mt-1 text-sm leading-6 text-zinc-400", className)}
      {...props}
    />
  );
}

export function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-body" className={cn("min-h-0 flex-1 overflow-y-auto p-4 sm:p-5", className)} {...props} />;
}
