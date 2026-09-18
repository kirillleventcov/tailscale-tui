const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Terminal display width of a string (wide glyphs count as 2). */
export function width(s: string): number {
  return Bun.stringWidth(s)
}

/** Cut a string to `max` display cells, appending an ellipsis when cut. */
export function truncate(s: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return ""
  if (width(s) <= max) return s
  const ew = width(ellipsis)
  if (max <= ew) return ellipsis
  let out = ""
  let w = 0
  for (const { segment } of graphemes.segment(s)) {
    const sw = width(segment)
    if (w + sw > max - ew) break
    out += segment
    w += sw
  }
  return out + ellipsis
}

export function padEnd(s: string, w: number): string {
  const d = w - width(s)
  return d > 0 ? s + " ".repeat(d) : s
}

export function padStart(s: string, w: number): string {
  const d = w - width(s)
  return d > 0 ? " ".repeat(d) + s : s
}

/** Truncate and pad a string to exactly `w` cells. */
export function fit(s: string, w: number, align: "left" | "right" | "center" = "left"): string {
  const t = truncate(s, w)
  if (align === "right") return padStart(t, w)
  if (align === "center") {
    const d = Math.max(0, w - width(t))
    const l = Math.floor(d / 2)
    return " ".repeat(l) + t + " ".repeat(d - l)
  }
  return padEnd(t, w)
}

/** Greedy word wrap by display width; over-long words are hard-cut. */
export function wrapText(text: string, max: number): string[] {
  if (max <= 0) return [text]
  const lines: string[] = []
  let line = ""
  for (const word of text.split(" ")) {
    let w = word
    while (width(w) > max) {
      if (line) {
        lines.push(line)
        line = ""
      }
      let head = ""
      for (const { segment } of graphemes.segment(w)) {
        if (width(head + segment) > max) break
        head += segment
      }
      lines.push(head)
      w = w.slice(head.length)
    }
    if (!line) line = w
    else if (width(line) + 1 + width(w) <= max) line += " " + w
    else {
      lines.push(line)
      line = w
    }
  }
  if (line || lines.length === 0) lines.push(line)
  return lines
}

export function humanBytes(n: number): string {
  let v = Number.isFinite(n) && n > 0 ? n : 0
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const num = i === 0 ? v.toFixed(0) : v < 10 ? v.toFixed(1) : v.toFixed(0)
  return `${num} ${units[i]}`
}

export function relTime(d: Date | undefined, now = Date.now()): string {
  if (!d) return "never"
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000))
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 60) return `${days}d ago`
  return d.toISOString().slice(0, 10)
}

export type LatencyValue = number | null | undefined | "pending"

export function fmtLatency(v: LatencyValue): string {
  if (v === undefined) return "—"
  if (v === "pending") return "…"
  if (v === null) return "timeout"
  return v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`
}

const OS_LABELS: Record<string, string> = {
  linux: "Linux",
  macos: "macOS",
  darwin: "macOS",
  windows: "Windows",
  ios: "iOS",
  android: "Android",
  tvos: "tvOS",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  illumos: "illumos",
  plan9: "Plan 9",
}

export function osLabel(os: string): string {
  if (!os) return "—"
  return OS_LABELS[os.toLowerCase()] ?? os
}

/** Parse a Go time string; the Go zero time is treated as "unset". */
export function parseTime(v: unknown): Date | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined
  if (v.startsWith("0001-01-01")) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
