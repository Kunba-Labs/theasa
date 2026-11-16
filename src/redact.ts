// Mask secrets before anything leaves the machine or reaches the summariser.
// ponytail: regex list, not a secret scanner. Add patterns when one slips through.
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-[masked]"],
  [/\bsk-(?:proj-|live_|test_)?[A-Za-z0-9_-]{16,}/g, "sk-[masked]"],
  [/\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, "[stripe key masked]"],
  [/\bwhsec_[A-Za-z0-9]{10,}/g, "whsec_[masked]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh_[masked]"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, "xox-[masked]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[masked]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza[masked]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt masked]"],
  [/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[masked]"],
  [/(\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*)["']?[^\s"'`]{4,}["']?/g, "$1[masked]"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]{3,}(@)/gi, "$1[masked]$2"],
];

export function redact(s: string): string {
  if (!s) return s;
  for (const [re, to] of PATTERNS) s = s.replace(re, to);
  return s;
}
