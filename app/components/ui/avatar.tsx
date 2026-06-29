import { cn } from "../../lib/utils";

export function initials(value: string) {
  const cleaned = (value || "").replace(/^\$/, "").trim();
  const parts = cleaned.split(/[\s._-]+/).filter(Boolean);
  const numberedLabel = parts.length >= 2 ? parts[parts.length - 1].match(/^\d+$/) : null;
  if (numberedLabel) return `${parts[0][0]}${numberedLabel[0]}`.toUpperCase();
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase() || "?";
}

const tones = {
  muted: "bg-zinc-800 text-zinc-300 ring-1 ring-white/5",
  success: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40",
  primary: "bg-white/10 text-zinc-100 ring-1 ring-white/15",
} as const;

export function Avatar({
  label,
  tone = "muted",
  className,
}: {
  label: string;
  tone?: keyof typeof tones;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex size-10 shrink-0 select-none items-center justify-center rounded-full text-xs font-semibold tracking-wide",
        tones[tone],
        className,
      )}
      title={label}
    >
      {initials(label)}
    </span>
  );
}
