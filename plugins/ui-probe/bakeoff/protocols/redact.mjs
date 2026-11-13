// Transcript redaction. A probe transcript is handed to an agent and may be committed as an
// artifact, so no credential may survive into it: the three headers the bake-off names,
// plus the two other common carriers of a bearer token.

export const SECRET_HEADERS = ["cookie", "set-cookie", "authorization", "proxy-authorization", "x-api-key"];

const REDACTED = "<redacted>";

export function isSecretHeader(name) {
  return SECRET_HEADERS.includes(String(name).toLowerCase());
}

export function redactHeader(name, value) {
  return isSecretHeader(name) ? REDACTED : String(value);
}

/** A flat header map (fetch gives us one) with the secret values replaced. */
export function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of headers) out[String(name).toLowerCase()] = redactHeader(name, value);
  return out;
}

/** Belt and braces for a body that carries a token in a shape no header rule sees. */
export function redactText(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  return out;
}
