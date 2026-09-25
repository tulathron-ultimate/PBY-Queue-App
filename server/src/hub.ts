/**
 * Real-time: every mutation broadcasts the event snapshot to connected host devices and a
 * privacy-filtered snapshot to each connected guest status page.
 */
import type { WsMessage } from '@pby/shared';
import type { WebSocket } from 'ws';
import type { QueueService } from './service.js';

const PING_MS = 25_000;

export class Hub {
  /** Host sockets per event, with the session token each one was opened with. */
  private hosts = new Map<string, Map<WebSocket, string>>();
  private guests = new Map<string, Map<WebSocket, string>>();
  private scheduled = new Set<string>();
  private timer: NodeJS.Timeout;

  constructor(private readonly service: QueueService) {
    service.onChange = (eventId) => this.schedule(eventId);
    // Keeps proxies such as Cloudflare Tunnel from closing idle sockets.
    this.timer = setInterval(() => this.pingAll(), PING_MS);
    this.timer.unref();
  }

  private static send(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  addHost(eventId: string, ws: WebSocket, sessionToken: string): void {
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

  addGuest(eventId: string, partyId: string, ws: WebSocket): void {
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
  }

  private pingAll(): void {
    for (const [eventId, map] of this.hosts) {
      for (const [ws, token] of map) {
        if (this.service.sessions.valid(eventId, token)) Hub.send(ws, { type: 'ping' });
        else ws.close(4401, 'signed_out'); // the 12 h session expired
      }
    }
    for (const map of this.guests.values())
      for (const ws of map.keys()) Hub.send(ws, { type: 'ping' });
  }

  close(): void {
    clearInterval(this.timer);
  }
}
