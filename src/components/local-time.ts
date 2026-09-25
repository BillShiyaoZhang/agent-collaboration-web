"use client";

import { useSyncExternalStore } from "react";

type TimeOptions = { unit?: "seconds" | "milliseconds"; style?: "compact" | "full" | "time" };

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
const pending = "本地时间加载中…";

// The server cannot know the reader's time zone. Keep SSR and the first
// hydration render identical, then use the browser's local zone.
export function useHydrated() {
  return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
}

export function useLocalTime() {
  const hydrated = useHydrated();
  return (value: unknown, options: TimeOptions = {}): string => {
    const date = typeof value === "number"
      ? new Date(value * (options.unit === "milliseconds" ? 1 : 1000))
      : typeof value === "string" ? new Date(value) : null;
    if (!date || !Number.isFinite(date.getTime())) return "";
    if (!hydrated) return pending;
    if (options.style === "full") return date.toLocaleString();
    if (options.style === "time") return date.toLocaleTimeString();
    return date.toLocaleString("zh-CN", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    });
  };
}
