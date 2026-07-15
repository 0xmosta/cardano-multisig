import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function stableJsonStringify(value: unknown) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  });
}

export function userFacingError(error: unknown, fallback = "Something went wrong. Please try again.") {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  const normalized = message.toLowerCase();
  if (normalized.includes("too many requests") || normalized.includes("rate limit")) {
    return "Too many refresh attempts. Wait a moment; the app will try again automatically.";
  }
  if (normalized.includes("failed to fetch") || normalized.includes("networkerror") || normalized.includes("connection")) {
    return "The connection was interrupted. Check your network and try again.";
  }
  if (normalized.includes("witnesscbor") || normalized.includes("ciphertext")) {
    return "A saved signature could not be read. Refresh the page; your transaction has not been changed.";
  }
  if (normalized.includes("relay")) {
    return "Signature progress could not be refreshed. Try again in a moment.";
  }
  return message || fallback;
}
