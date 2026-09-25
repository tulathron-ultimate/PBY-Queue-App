/**
 * S1: the pluggable SMS provider interface. The mode is chosen per event.
 *
 * - `tapToSend` does not send anything itself. The message goes into the host's
 *   "Texts to send" tray and the host's phone opens Messages via an `sms:` link.
 * - `twilio` sends through Twilio's REST API with plain fetch.
 */
export type SmsSendResult =
  | { status: 'pending' }
  | { status: 'sent'; providerId: string }
  | { status: 'failed'; code: number | null; message: string };

export interface SmsProvider {
  readonly name: 'tap' | 'twilio';
  send(to: string, body: string): Promise<SmsSendResult>;
}

export const tapToSend: SmsProvider = {
  name: 'tap',
  async send() {
    return { status: 'pending' };
  },
};

/** Twilio "unsubscribed recipient" error. */
export const TWILIO_UNSUBSCRIBED = 21610;
