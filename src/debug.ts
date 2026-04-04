const MAX_ENTRIES = 200;
const entries: string[] = [];

export function debugLog(msg: string): void {
  const ts = new Date().toISOString().substring(11, 23);
  const entry = `[${ts}] ${msg}`;
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  console.log(`[SynologySync] ${msg}`);
}

export function getDebugLog(): string {
  return entries.join("\n");
}

export function clearDebugLog(): void {
  entries.length = 0;
}

export function redact(s: string | undefined, showChars: number = 4): string {
  if (!s) return "(empty)";
  if (s.length <= showChars) return "***";
  return s.substring(0, showChars) + "***(" + s.length + " chars)";
}
