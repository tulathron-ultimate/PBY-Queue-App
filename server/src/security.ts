import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** base32 without ambiguous characters (no 0/O, 1/I). */
const JOIN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Unbiased random string from a CSPRNG (rejection sampling). */
export function randomString(length: number, alphabet: string = BASE62): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Status link token: 12 chars base62 (~71 bits). */
export const newStatusToken = () => randomString(12);
/** Event join code: 6 chars of unambiguous base32. */
export const newJoinCode = () => randomString(6, JOIN_ALPHABET);
export const newId = () => randomString(14);
export const newSessionToken = () => randomBytes(32).toString('base64url');

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pin, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, saltB64, hashB64] = stored.split('$');
  if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(pin, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Rate-limit key for a client address (SEC-5). An IPv6 client usually holds a whole /64 and
 * can pick a new address for every request, so IPv6 addresses are keyed by their /64 prefix.
 * IPv4 (and IPv4-mapped IPv6) addresses are keyed as-is.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Sliding-window counter keyed by IP, event, etc. In memory: fine for a single container. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private blockedUntil = new Map<string, number>();
  private lastPrune = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly blockMs = 0,
    /**
     * SEC-6: most keys tracked at once. Past it, expired keys are dropped, then the oldest,
     * so a flood of new addresses can't exhaust memory between the 15-minute sweeps.
     */
    private readonly maxKeys = 50_000,
  ) {}

  /** Makes room for one more key in `map`. */
  private makeRoom(map: Map<string, unknown>, now: number): void {
    if (map.size < this.maxKeys) return;
    // A full scan at most once a second, so a flood can't make every request O(keys).
    if (now - this.lastPrune >= 1000) this.prune(now);
    for (const key of map.keys()) {
      if (map.size < this.maxKeys) break;
      map.delete(key); // Maps iterate in insertion order: the oldest go first.
    }
  }

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds until the key may try again, or 0 if it is not blocked. */
  retryAfter(key: string, now = Date.now()): number {
    const until = this.blockedUntil.get(key);
    if (until && until > now) return Math.ceil((until - now) / 1000);
    if (until) this.blockedUntil.delete(key);
    if (!this.blockMs && this.recent(key, now).length >= this.limit) {
      const oldest = this.recent(key, now)[0];
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    }
    return 0;
  }

  /** Records a hit. Returns false when the limit is exceeded. */
  hit(key: string, now = Date.now()): boolean {
    if (this.retryAfter(key, now) > 0) return false;
    const list = this.recent(key, now);
    list.push(now);
    if (!this.hits.has(key)) this.makeRoom(this.hits, now);
    this.hits.set(key, list);
    if (list.length >= this.limit && this.blockMs) {
      this.makeRoom(this.blockedUntil, now);
      this.blockedUntil.set(key, now + this.blockMs);
      this.hits.delete(key);
    }
    return list.length <= this.limit;
  }

  remaining(key: string, now = Date.now()): number {
    return Math.max(0, this.limit - this.recent(key, now).length);
  }

  reset(key: string): void {
    this.hits.delete(key);
    this.blockedUntil.delete(key);
  }

  prune(now = Date.now()): void {
    this.lastPrune = now;
    for (const key of this.hits.keys()) this.recent(key, now);
    for (const [key, until] of this.blockedUntil) if (until <= now) this.blockedUntil.delete(key);
  }
}
