const DEFAULT_DESTINATION = "/dashboard";

// A login query parameter is untrusted navigation input. Keep it as a local
// absolute path; NextAuth's own callback validation must not be bypassed by UI.
export function safeLoginDestination(candidate: string | null | undefined): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(candidate)) {
    return DEFAULT_DESTINATION;
  }
  try {
    const url = new URL(candidate, "https://internal.invalid");
    if (url.origin !== "https://internal.invalid") return DEFAULT_DESTINATION;
    const destination = url.pathname + url.search + url.hash;
    // Dot-segment normalization can turn /..//host into a protocol-relative path.
    return destination.startsWith("//") ? DEFAULT_DESTINATION : destination;
  } catch {
    return DEFAULT_DESTINATION;
  }
}
