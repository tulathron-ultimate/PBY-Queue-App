/**
 * SMS launch adapter (S2 tap-to-send). One recipient per tap.
 * iOS uses `sms:+1XXX&body=`, Android uses `sms:+1XXX?body=` (detected by user agent).
 * A Capacitor build can replace `openSms` with a native composer.
 */
export function isIos(
  ua: string = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints,
): boolean {
  return /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1);
}

export function smsUri(to: string, body: string, ios: boolean): string {
  return `sms:${to}${ios ? '&' : '?'}body=${encodeURIComponent(body)}`;
}

export function openSms(to: string, body: string): void {
  window.location.href = smsUri(to, body, isIos());
}
