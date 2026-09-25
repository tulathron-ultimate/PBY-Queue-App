import { renderPartyText, type HostSnapshot, type PendingText } from '@pby/shared';

/**
 * The body of a tap-to-send text, rendered on this device from the snapshot with the same
 * shared template code the server uses for Twilio. Snapshots never carry rendered bodies.
 */
export function trayBody(snap: HostSnapshot, text: PendingText): string {
  const party = snap.parties.find((p) => p.id === text.partyId);
  return party ? renderPartyText(snap.event, snap.parties, party, text.template) : '';
}
