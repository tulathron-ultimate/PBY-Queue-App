/**
 * G5 lobby display links. The token is 144 random bits (base64url). The database keeps the
 * token, so any host device can show the link again, plus its SHA-256, which is what lookups
 * use; the found token is then compared in constant time.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const newLobbyToken = (): string => randomBytes(18).toString('base64url');

export const LOBBY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{24}$/;

export function hashLobbyToken(token: string): string {
  return createHash('sha256').update(`lobby:${token}`).digest('hex');
}

export function sameLobbyToken(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function lobbyUrl(publicUrl: string, token: string): string {
  return `${publicUrl}/d/${token}`;
}
