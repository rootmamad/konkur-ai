

/**
 * Dev-only credential (spec section 2). The national code acts as a
 * password stand-in until the real auth method is decided (spec 15.2).
 * Must be replaced before release: unsalted SHA-256 is not a password hash.
 */
import { createHash, timingSafeEqual } from 'crypto';
const DEV_PREFIX = 'konkur-dev:';

export function hashDevCredential(nationalCode: string): string {
  return createHash('sha256')
    .update(`${DEV_PREFIX}${nationalCode.trim()}`)
    .digest('hex');
}

export function verifyDevCredential(
  nationalCode: string,
  storedHash: string | null,
): boolean {
  const candidate = Buffer.from(hashDevCredential(nationalCode), 'hex');
  const stored = Buffer.from(storedHash ?? '', 'hex');
  if (stored.length !== candidate.length) {
    timingSafeEqual(candidate, candidate); // keep timing flat
    return false;
  }
  return timingSafeEqual(candidate, stored);
}
