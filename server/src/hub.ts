/**
 * Real-time: every mutation broadcasts the event snapshot to connected host devices and a
 * privacy-filtered snapshot to each connected guest status page.
 */
import type { WsMessage } from '@pby/shared';
import type { WebSocket } from 'ws';
import type { QueueService } from './service.js';

const PING_MS = 25_000;

/**
 * SEC-7 connection limits. A status link is one family (a few phones and tabs), a host session is
 * one device; past these the oldest socket is closed (4408), so a reload never locks anyone out.
 * An address gets at most `perIp` sockets in all (refused with 4429): venues share one Wi-Fi or
 * carrier address, so this is generous and only stops one client from exhausting memory.
 */
export const WS_LIMITS = { perParty: 10, perSession: 5, perIp: 1000 };

export class Hub {
  /** Host sockets per event, with the session token each one was opened with. */
  private hosts = new Map<string, Map<WebSocket, string>>();
  private guests = new Map<string, Map<WebSocket, string>>();
  /** G5 lobby displays per event, with the lobby token each one was opened with. */
  private lobbies = new Map<string, Map<WebSocket, string>>();
  private scheduled = new Set<string>();
  private timer: NodeJS.Timeout;
  /** Open sockets per status link / host session, oldest first (SEC-7). */
  private byOwner = new Map<string, Set<WebSocket>>();
  private perIp = new Map<string, number>();

  constructor(private readonly service: QueueService) {
    service.onChange = (eventId) => this.schedule(eventId);
    // Keeps proxies such as Cloudflare Tunnel from closing idle sockets.
    this.timer = setInterval(() => this.pingAll(), PING_MS);
    this.timer.unref();
  }

  private static send(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /**
   * Counts a new socket against its address and its owner (a party or a host session). Returns
   * false, having closed the socket, when the address is over its limit.
   */
  private admit(ws: WebSocket, owner: string, max: number, ip: string): boolean {
    const n = this.perIp.get(ip) ?? 0;
    if (n >= WS_LIMITS.perIp) {
      ws.close(4429, 'too_many_connections');
      return false;
    }
    this.perIp.set(ip, n + 1);
    const set = this.byOwner.get(owner) ?? new Set<WebSocket>();
    set.add(ws);
    this.byOwner.set(owner, set);
    ws.on('close', () => {
      const left = (this.perIp.get(ip) ?? 1) - 1;
      if (left > 0) this.perIp.set(ip, left);
      else this.perIp.delete(ip);
      set.delete(ws);
      if (!set.size && this.byOwner.get(owner) === set) this.byOwner.delete(owner);
    });
    for (const old of set) {
      if (set.size <= max) break;
      set.delete(old);
      old.close(4408, 'replaced');
    }
    return true;
  }

  addHost(eventId: string, ws: WebSocket, sessionToken: string, ip: string): void {
    if (!this.admit(ws, `h ${eventId} ${sessionToken}`, WS_LIMITS.perSession, ip)) return;
    const map = this.hosts.get(eventId) ?? new Map<WebSocket, string>();
    map.set(ws, sessionToken);
    this.hosts.set(eventId, map);
    ws.on('close', () => {
      map.delete(ws);
      if (!map.size) this.hosts.delete(eventId);
    });
    try {
      Hub.send(ws, { type: 'host', data: this.service.hostSnapshot(eventId) });
    } catch {
      ws.close(4404, 'not_found');
    }
  }

  addGuest(eventId: string, partyId: string, ws: WebSocket, ip: string): void {
    if (!this.admit(ws, `g ${partyId}`, WS_LIMITS.perParty, ip)) return;
    const map = this.guests.get(eventId) ?? new Map<WebSocket, string>();
    map.set(ws, partyId);
    this.guests.set(eventId, map);
    ws.on('close', () => {
      map.delete(ws);
      if (!map.size) this.guests.delete(eventId);
    });
    const snap = this.service.guestSnapshots(eventId, [partyId]).get(partyId);
    if (snap) Hub.send(ws, { type: 'guest', data: snap });
  }

  addLobby(eventId: string, ws: WebSocket, token: string): void {
    const map = this.lobbies.get(eventId) ?? new Map<WebSocket, string>();
    map.set(ws, token);
    this.lobbies.set(eventId, map);
    ws.on('close', () => {
      map.delete(ws);
      if (!map.size) this.lobbies.delete(eventId);
    });
    const lobby = this.service.lobbyForEvent(eventId);
    if (lobby && lobby.token === token) Hub.send(ws, { type: 'lobby', data: lobby.snapshot });
    else ws.close(4404, 'not_found');
  }

  /**
   * Sends the lobby payload to displays on the current link and disconnects any on a link that
   * was revoked or replaced. Runs right away (not on the next tick) after a revoke.
   */
  broadcastLobbies(eventId: string): void {
    const lobbies = this.lobbies.get(eventId);
    if (!lobbies?.size) return;
    const lobby = this.service.lobbyForEvent(eventId);
    for (const [ws, token] of lobbies) {
      if (lobby && lobby.token === token) Hub.send(ws, { type: 'lobby', data: lobby.snapshot });
      else ws.close(4404, 'not_found');
    }
  }

  /** Coalesces several changes in the same tick into one broadcast. */
  schedule(eventId: string): void {
    if (this.scheduled.has(eventId)) return;
    this.scheduled.add(eventId);
    setImmediate(() => {
      this.scheduled.delete(eventId);
      this.broadcast(eventId);
    });
  }

  broadcast(eventId: string): void {
    const hosts = this.hosts.get(eventId);
    if (hosts?.size) {
      let msg: WsMessage | null = null;
      try {
        msg = { type: 'host', data: this.service.hostSnapshot(eventId) };
      } catch {
        msg = null;
      }
      for (const [ws, token] of hosts) {
        // A device that was signed out (Sign out other devices, Sign out, expiry, or closing
        // the event) must stop receiving guest names and phone numbers right away.
        const signedIn = this.service.sessions.valid(eventId, token);
        if (msg && signedIn) Hub.send(ws, msg);
        if (!msg || !signedIn || msg.data.event.status === 'closed') ws.close(4401, 'signed_out');
      }
    }
    const guests = this.guests.get(eventId);
    if (guests?.size) {
      const snaps = this.service.guestSnapshots(eventId, new Set(guests.values()));
      for (const [ws, partyId] of guests) {
        const snap = snaps.get(partyId);
        if (snap) Hub.send(ws, { type: 'guest', data: snap });
        else ws.close(4404, 'not_found');
      }
    }
    this.broadcastLobbies(eventId);
  }

  private pingAll(): void {
    for (const [eventId, map] of this.hosts) {
      for (const [ws, token] of map) {
        if (this.service.sessions.valid(eventId, token)) Hub.send(ws, { type: 'ping' });
        else ws.close(4401, 'signed_out'); // the 12 h session expired
      }
    }
    for (const map of [...this.guests.values(), ...this.lobbies.values()])
      for (const ws of map.keys()) Hub.send(ws, { type: 'ping' });
  }

  close(): void {
    clearInterval(this.timer);
    for (const map of [...this.hosts.values(), ...this.guests.values()]) {
      for (const ws of map.keys()) ws.close(1001, 'server_shutdown');
    }
    this.hosts.clear();
    this.guests.clear();
  }
}
