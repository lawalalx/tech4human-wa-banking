/**
 * Normalizes various Nigerian phone number formats to E.164 (+2348012345678)
 */
export function formatPhoneNumber(raw: string): string {
  // Remove all non-digit characters except leading +
  let cleaned = raw.replace(/[^\d+]/g, "");

  // Remove leading + for processing
  if (cleaned.startsWith("+")) {
    cleaned = cleaned.slice(1);
  }

  // Already international format (234...)
  if (cleaned.startsWith("234") && cleaned.length === 13) {
    return `+${cleaned}`;
  }

  // Local format: 0XXXXXXXXXX (11 digits)
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    return `+234${cleaned.slice(1)}`;
  }

  // 10 digits without leading 0 (e.g., 8012345678)
  if (!cleaned.startsWith("0") && cleaned.length === 10) {
    return `+234${cleaned}`;
  }

  // Return with + prefix if none of the above matched (best-effort)
  return `+${cleaned}`;
}

/**
 * Strips the country code prefix for local display ("08012345678")
 */
export function toLocalFormat(phone: string): string {
  const e164 = formatPhoneNumber(phone);
  if (e164.startsWith("+234")) {
    return `0${e164.slice(4)}`;
  }
  return phone;
}

/**
 * Mask phone number for logs: +23480***5678
 */
export function maskPhone(phone: string): string {
  const e164 = formatPhoneNumber(phone);
  if (e164.length < 8) return "***";
  return `${e164.slice(0, 6)}***${e164.slice(-4)}`;
}
