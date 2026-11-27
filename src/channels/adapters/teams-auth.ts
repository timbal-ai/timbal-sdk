/**
 * Entra ID credentials the Teams adapter can authenticate token requests
 * with, other than a client secret: a certificate (a signed client
 * assertion) or a federated identity credential (an external token sent as
 * the assertion).
 *
 * Teams file URLs need a token from one of these once Microsoft removes
 * their `tempauth` credential on March 1, 2027: Entra answers 401 to file
 * requests made with a token got from a client secret.
 */
import { readFile } from 'node:fs/promises';

/** A certificate registered on the bot's app registration (Certificates & secrets). */
export interface TeamsCertificate {
  /**
   * The certificate's RSA private key as PEM, unencrypted: PKCS#8
   * (`BEGIN PRIVATE KEY`) or PKCS#1 (`BEGIN RSA PRIVATE KEY`). It may also
   * hold the certificate (`BEGIN CERTIFICATE`), as a combined PEM export
   * does. Escaped `\n` sequences (a PEM kept in an env var) are accepted.
   */
  privateKey: string;
  /**
   * The certificate as PEM. Entra identifies the key by the certificate's
   * SHA-256 thumbprint, computed from this. Not needed when `privateKey`
   * holds the certificate or `thumbprintSha256` is set.
   */
  certificate?: string;
  /**
   * The certificate's SHA-256 thumbprint in hex (colons allowed), in place
   * of `certificate`: `openssl x509 -in cert.pem -noout -fingerprint -sha256`.
   * Not the SHA-1 thumbprint the Azure portal lists.
   */
  thumbprintSha256?: string;
}

/**
 * Returns the token of an external identity provider that the bot's app
 * registration trusts through a federated identity credential (a Kubernetes
 * service account token, a GitHub Actions OIDC token, a managed identity's
 * token for `api://AzureADTokenExchange`, ...). Called for each Entra token
 * request, which happens only when a cached token nears expiry.
 */
export type TeamsFederatedToken = () => string | Promise<string>;

/** The form fields that authenticate a client-credentials request to `tokenUrl`. */
export type ClientAuthentication = (tokenUrl: string) => Promise<Record<string, string>>;

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** How long a signed assertion is valid; Entra asks for 5-10 minutes at most. */
const ASSERTION_LIFETIME_SECONDS = 600;

const bytesToB64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const jsonToB64url = (value: unknown): string =>
  bytesToB64url(new TextEncoder().encode(JSON.stringify(value)));

interface PemBlock {
  label: string;
  der: Uint8Array;
  encrypted: boolean;
}

function pemBlocks(pem: string): PemBlock[] {
  const text = pem.replace(/\\n/g, '\n');
  const blocks: PemBlock[] = [];
  for (const [, label = '', body = ''] of text.matchAll(
    /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g,
  )) {
    // Legacy encrypted PKCS#1 keys carry `Proc-Type: 4,ENCRYPTED` headers.
    const encrypted = label.includes('ENCRYPTED') || /^Proc-Type:.*ENCRYPTED/m.test(body);
    const b64 = body.replace(/^[A-Za-z-]+:.*$/gm, '').replace(/\s+/g, '');
    blocks.push({ label, der: new Uint8Array(Buffer.from(b64, 'base64')), encrypted });
  }
  return blocks;
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return [0x80 | bytes.length, ...bytes];
}

function derElement(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const header = [tag, ...derLength(length)];
  const out = new Uint8Array(header.length + length);
  out.set(header, 0);
  let offset = header.length;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** `AlgorithmIdentifier { rsaEncryption, NULL }`. */
const RSA_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/** Wraps a PKCS#1 `RSAPrivateKey` in the PKCS#8 `PrivateKeyInfo` WebCrypto imports. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  return derElement(
    0x30,
    new Uint8Array([0x02, 0x01, 0x00]),
    RSA_ALGORITHM_IDENTIFIER,
    derElement(0x04, pkcs1),
  );
}

function privateKeyInfo(pem: string): Uint8Array {
  const blocks = pemBlocks(pem);
  const key = blocks.find((b) => b.label.endsWith('PRIVATE KEY'));
  if (!key) {
    throw new Error('Teams certificate privateKey has no PEM private key (BEGIN PRIVATE KEY)');
  }
  if (key.encrypted) {
    throw new Error(
      'Teams certificate privateKey is encrypted; decrypt it first (openssl pkcs8 -topk8 -nocrypt)',
    );
  }
  if (key.label === 'PRIVATE KEY') return key.der;
  if (key.label === 'RSA PRIVATE KEY') return pkcs1ToPkcs8(key.der);
  throw new Error(`Teams certificate privateKey must be an RSA key, not ${key.label}`);
}

async function thumbprintSha256(cert: TeamsCertificate): Promise<string> {
  if (cert.thumbprintSha256) {
    const hex = cert.thumbprintSha256.replace(/[\s:]/g, '');
    if (/^[0-9a-f]{40}$/i.test(hex)) {
      throw new Error(
        'Teams certificate thumbprintSha256 is a SHA-1 thumbprint; pass the SHA-256 one, or the certificate PEM',
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error('Teams certificate thumbprintSha256 must be 64 hex characters');
    }
    return bytesToB64url(new Uint8Array(Buffer.from(hex, 'hex')));
  }
  const block = pemBlocks(`${cert.certificate ?? ''}\n${cert.privateKey}`).find(
    (b) => b.label === 'CERTIFICATE',
  );
  if (!block) {
    throw new Error(
      'Teams certificate needs the certificate PEM (certificate) or its SHA-256 thumbprint (thumbprintSha256)',
    );
  }
  return bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', block.der)));
}

/**
 * Authenticates with a client assertion signed by the certificate's key:
 * a PS256 JWT whose `x5t#S256` header names the certificate, per Entra's
 * certificate credentials format. A fresh assertion is signed per request.
 */
export function certificateAuthentication(
  clientId: string,
  cert: TeamsCertificate,
  now: () => number,
): ClientAuthentication {
  const prepare = async () => ({
    key: await crypto.subtle.importKey(
      'pkcs8',
      privateKeyInfo(cert.privateKey),
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['sign'],
    ),
    x5t: await thumbprintSha256(cert),
  });
  // Parsed on first use, so a bad certificate fails the token request that
  // needs it rather than the whole binding set.
  let prepared: ReturnType<typeof prepare> | undefined;

  return async (tokenUrl) => {
    prepared ??= prepare().catch((error: unknown) => {
      prepared = undefined;
      throw error;
    });
    const { key, x5t } = await prepared;
    const issuedAt = Math.floor(now() / 1000);
    const header = jsonToB64url({ alg: 'PS256', typ: 'JWT', 'x5t#S256': x5t });
    const payload = jsonToB64url({
      aud: tokenUrl,
      iss: clientId,
      sub: clientId,
      jti: crypto.randomUUID(),
      nbf: issuedAt,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    });
    const signature = await crypto.subtle.sign(
      { name: 'RSA-PSS', saltLength: 32 },
      key,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return {
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: `${header}.${payload}.${bytesToB64url(new Uint8Array(signature))}`,
    };
  };
}

/** Authenticates with an external token, trusted through a federated identity credential. */
export function federatedAuthentication(getToken: TeamsFederatedToken): ClientAuthentication {
  return async () => {
    const token = (await getToken())?.trim();
    if (!token) throw new Error('Teams federatedToken returned no token');
    return { client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: token };
  };
}

/**
 * A {@link TeamsFederatedToken} that reads the token from a file on each
 * call, as Azure Workload Identity projects it (`AZURE_FEDERATED_TOKEN_FILE`)
 * and rotates it in place.
 */
export function federatedTokenFile(path: string): TeamsFederatedToken {
  return async () => (await readFile(path, 'utf8')).trim();
}

/** String settings (platform credentials or env) for the non-secret credentials. */
export interface TeamsCredentialSettings {
  certificatePrivateKey?: string;
  certificate?: string;
  certificateThumbprintSha256?: string;
  federatedTokenFile?: string;
}

/** The adapter's `certificate` / `federatedToken` options from string settings. */
export function teamsCredentialOptions(settings: TeamsCredentialSettings): {
  certificate?: TeamsCertificate;
  federatedToken?: TeamsFederatedToken;
} {
  return {
    ...(settings.certificatePrivateKey
      ? {
          certificate: {
            privateKey: settings.certificatePrivateKey,
            certificate: settings.certificate || undefined,
            thumbprintSha256: settings.certificateThumbprintSha256 || undefined,
          },
        }
      : {}),
    ...(settings.federatedTokenFile
      ? { federatedToken: federatedTokenFile(settings.federatedTokenFile) }
      : {}),
  };
}
