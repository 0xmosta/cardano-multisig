import { Toaster as Sonner, type ToasterProps } from "sonner";

export function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "border border-white/10 bg-[#18181b] text-zinc-100 shadow-2xl shadow-black/40",
          title: "text-zinc-50",
          description: "text-zinc-400",
          actionButton: "bg-zinc-50 text-zinc-950",
          cancelButton: "bg-zinc-800 text-zinc-100",
        },
      }}
      {...props}
    />
  );
}
