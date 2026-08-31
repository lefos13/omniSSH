/*
 * OSC 7 working-directory parser (iTerm2 shell integration specification).
 * Format: file://<host><abs-path> with percent-encoded path segments.
 *
 * Rules:
 * - Scheme must be "file://" (case-insensitive); other schemes return null.
 * - Host may be empty (e.g. file:///path).
 * - Path must be absolute (starting with '/') and at most 4096 characters.
 * - Any ?query or #fragment suffix is conservatively ignored.
 * - %XX hex sequences are percent-decoded, while malformed sequences are kept as-is.
 * - Trailing slashes are stripped unless the path is exactly "/".
 */

/**
 * Safely percent-decode a string, leaving malformed or incomplete byte sequences intact.
 */
function safePercentDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    // If standard decodeURIComponent fails due to malformed sequences,
    // process contiguous %XX hex sequences chunk-by-chunk.
  }

  return str.replace(/(?:%[0-9a-fA-F]{2})+/g, (match) => {
    try {
      return decodeURIComponent(match);
    } catch {
      let result = "";
      let i = 0;
      while (i < match.length) {
        let decoded = false;
        // Try the longest valid UTF-8 sequence starting at index i (up to 4 bytes = 12 chars).
        for (let len = Math.min(12, match.length - i); len >= 3; len -= 3) {
          const sub = match.slice(i, i + len);
          try {
            result += decodeURIComponent(sub);
            i += len;
            decoded = true;
            break;
          } catch {
            // Sequence not decodable at this length, try shorter.
          }
        }
        if (!decoded) {
          result += match.slice(i, i + 3);
          i += 3;
        }
      }
      return result;
    }
  });
}

/**
 * Parse an OSC 7 payload into host and absolute path.
 *
 * Returns null if the payload is invalid, does not use the file:// scheme,
 * has a relative path, or exceeds the maximum path length (4096 characters).
 */
export function parseOsc7Cwd(payload: string): { host: string; path: string } | null {
  if (typeof payload !== "string") {
    return null;
  }

  // Scheme must be file:// (case-insensitive)
  if (!payload.toLowerCase().startsWith("file://")) {
    return null;
  }

  let rest = payload.slice(7);

  // Conservatively ignore any ?query or #fragment suffix
  const suffixIdx = rest.search(/[?#]/);
  if (suffixIdx >= 0) {
    rest = rest.slice(0, suffixIdx);
  }

  // Split host and abs-path by the first '/'
  const firstSlash = rest.indexOf("/");
  if (firstSlash === -1) {
    return null;
  }

  const host = rest.slice(0, firstSlash);
  const rawPath = rest.slice(firstSlash);

  // Path must be absolute and at most 4096 characters
  if (!rawPath.startsWith("/") || rawPath.length > 4096) {
    return null;
  }

  const decodedPath = safePercentDecode(rawPath);
  if (!decodedPath.startsWith("/") || decodedPath.length > 4096) {
    return null;
  }

  // Strip trailing slashes unless path is exactly "/"
  const finalPath =
    decodedPath.length > 1 ? decodedPath.replace(/\/+$/, "") || "/" : decodedPath;

  return { host, path: finalPath };
}
