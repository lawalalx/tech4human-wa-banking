/**
 * Canonical E.164 phone normalizer (+2349038433047)
 * Handles: local 11-digit, 10-digit without 0, 234 prefix, and pre-formatted E.164 numbers.
 */
export function normalizePhone(raw: string): string {
  if (!raw) return "";

  let cleaned = raw.trim().replace(/[^\d+]/g, "");

  if (cleaned.startsWith("+")) {
    cleaned = cleaned.slice(1);
  }

  // Local format with leading 0 (09038433047 -> 11 digits)
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    return `+234${cleaned.slice(1)}`;
  }

  // 10-digit format without leading 0 (9038433047)
  if (!cleaned.startsWith("0") && cleaned.length === 10) {
    return `+234${cleaned}`;
  }

  // International format starting with country code 234
  if (cleaned.startsWith("234")) {
    return `+${cleaned}`;
  }

  return cleaned ? `+${cleaned}` : "";
}

/** Alias formatPhoneNumber to normalizePhone for backwards compatibility */
export const formatPhoneNumber = normalizePhone;

/**
 * Strips country code prefix for local display ("09038433047")
 */
export function toLocalFormat(phone: string): string {
  const e164 = normalizePhone(phone);
  if (e164.startsWith("+234")) {
    return `0${e164.slice(4)}`;
  }
  return phone;
}

/**
 * Mask phone number for logs: +23490***3047
 */
export function maskPhone(phone: string): string {
  const e164 = normalizePhone(phone);
  if (e164.length < 8) return "***";
  return `${e164.slice(0, 6)}***${e164.slice(-4)}`;
}
