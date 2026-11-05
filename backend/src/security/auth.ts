import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface TokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: string }
  | { ok: false; reason: 'not-configured' | 'invalid-password' };

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length, { N: SCRYPT_COST });
  try {
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export class AuthService {
  private tokenSecret: string;
  private passwordHash: string | null;

  constructor(
    secrets: { tokenSecret: string; passwordHash: string | null },
    private readonly ttlMs: number = TOKEN_TTL_MS,
  ) {
    this.tokenSecret = secrets.tokenSecret;
    this.passwordHash = secrets.passwordHash;
  }

  updateSecrets(secrets: { tokenSecret: string; passwordHash: string | null }): void {
    this.tokenSecret = secrets.tokenSecret;
    this.passwordHash = secrets.passwordHash;
  }

  login(password: string): LoginResult {
    if (!this.passwordHash || this.tokenSecret === '') {
      return { ok: false, reason: 'not-configured' };
    }
    if (!verifyPassword(password, this.passwordHash)) {
      // Atraso pequeno para tornar brute-force local menos prático.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 180);
      return { ok: false, reason: 'invalid-password' };
    }
    const iat = Date.now();
    const exp = iat + this.ttlMs;
    const token = this.issueToken({ sub: 'dashboard', iat, exp });
    return { ok: true, token, expiresAt: new Date(exp).toISOString() };
  }

  verifyToken(token: string): TokenPayload | null {
    if (this.tokenSecret === '') return null;
    const dotIndex = token.indexOf('.');
    if (dotIndex < 0) return null;
    const payloadB64 = token.slice(0, dotIndex);
    const signature = token.slice(dotIndex + 1);
    let expected: Buffer;
    let json: string;
    try {
      expected = this.sign(payloadB64);
      json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    } catch {
      return null;
    }
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
      return null;
    }
    let payload: TokenPayload;
    try {
      payload = JSON.parse(json) as TokenPayload;
    } catch {
      return null;
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      payload.sub !== 'dashboard' ||
      typeof payload.exp !== 'number' ||
      typeof payload.iat !== 'number'
    ) {
      return null;
    }
    if (payload.exp <= Date.now()) return null;
    return payload;
  }

  private issueToken(payload: TokenPayload): string {
    const payloadB64 = b64url(JSON.stringify(payload));
    const signature = this.sign(payloadB64);
    return `${payloadB64}.${signature.toString('base64url')}`;
  }

  private sign(payloadB64: string): Buffer {
    return createHmac('sha256', this.tokenSecret).update(payloadB64).digest();
  }
}

/** Gera um segredo novo (primeiro boot ou rotação manual). */
export function generateTokenSecret(): string {
  return randomBytes(32).toString('hex');
}
