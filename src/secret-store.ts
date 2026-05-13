// At-rest obfuscation for credentials stored in data.json.
//
// This is *obfuscation*, not encryption: anyone with read access to data.json
// AND this source file can recover the plaintext. The goal is to prevent
// casual disclosure — opening data.json in an editor, posting the file in a
// bug report, or syncing it through a service that snapshots in plain view
// (which is exactly how this plugin's own remote shard works) should not
// reveal the DSM password in clear text.
//
// True at-rest encryption would require a user-supplied passphrase or a
// platform keychain. Obsidian's plugin API exposes neither uniformly across
// desktop and mobile, so we settle for a versioned obfuscation scheme that
// can be rotated in the future without breaking existing installs.

const SECRET_KEY = "obsidian-synology-sync/secret/v1";
const PREFIX_V1 = "o1:";

function xorBytes(input: Uint8Array, key: string): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i] ^ key.charCodeAt(i % key.length);
  }
  return out;
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function binaryStringToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Wraps a plaintext secret with the current obfuscation scheme. Empty in -> empty out. */
export function obfuscate(plain: string): string {
  if (!plain) return "";
  const bytes = new TextEncoder().encode(plain);
  const xored = xorBytes(bytes, SECRET_KEY);
  return PREFIX_V1 + btoa(bytesToBinaryString(xored));
}

/**
 * Recovers plaintext from a stored value. Accepts:
 *   - "o1:<b64>"  → deobfuscate
 *   - ""          → ""
 *   - anything else → treat as legacy plaintext and return as-is (so existing
 *     installs keep working until the next save promotes the value).
 */
export function deobfuscate(stored: string): string {
  if (!stored) return "";
  if (!stored.startsWith(PREFIX_V1)) return stored;
  try {
    const xored = binaryStringToBytes(atob(stored.slice(PREFIX_V1.length)));
    return new TextDecoder().decode(xorBytes(xored, SECRET_KEY));
  } catch {
    // Corrupted ciphertext: drop the value rather than crash. The user will
    // see an empty password field and re-enter; the save path will obfuscate
    // the new value.
    return "";
  }
}

/** True if `s` is a value produced by `obfuscate()` (any version). */
export function isObfuscated(s: string): boolean {
  return typeof s === "string" && s.startsWith(PREFIX_V1);
}
