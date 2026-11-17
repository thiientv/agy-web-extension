const EXACT_SENSITIVE_KEYS = new Set([
  "code", "auth", "key", "sig", "hash", "hmac", "mac", "salt", "otp", "pin",
  "pass", "pwd", "pw", "totp", "sid", "assertion", "nonce", "magic", "jwt",
  "bearer", "ssn", "cvv", "cvc", "cc"
]);

const SUBSTRING_SENSITIVE_KEYS = [
  "token", "secret", "passw", "passcode", "passphrase", "credential", "apikey",
  "api_key", "authcode", "authkey", "authoriz", "oauth", "otpcode", "saml",
  "signature", "session", "sessid", "cookie", "csrf", "xsrf", "privatekey",
  "accesskey", "oobcode"
];

function isSensitiveParamName(name: string): boolean {
  const lower = name.toLowerCase();
  if (EXACT_SENSITIVE_KEYS.has(lower)) {
    return true;
  }
  return SUBSTRING_SENSITIVE_KEYS.some((sub) => lower.includes(sub));
}

export function normalizeNavigationUrl(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "back" || lower === "forward") {
    return lower;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || lower.startsWith("about:")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export function redactSensitiveUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const keys = [...new Set([...parsed.searchParams.keys()])];
    let changed = false;
    for (const key of keys) {
      if (isSensitiveParamName(key)) {
        parsed.searchParams.set(key, "REDACTED");
        changed = true;
      }
    }
    if (!changed) {
      return rawUrl;
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}
