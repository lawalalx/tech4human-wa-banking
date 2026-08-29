/**
 * Authorization Service
 * 
 * Manages PIN and OTP verification with:
 * - Timeout enforcement (2 min PIN, 5 min OTP)
 * - Attempt tracking
 * - State management
 * - No hardcoding - all values configurable
 * - Conversational flow support
 */

import { AgentState } from "../core/agent-state.js";

type AuthorizationState = NonNullable<AgentState["session"]["authorizationState"]>;

const DEFAULT_AUTH_STATE: AuthorizationState = {
  pinVerified: false,
  pinAttempts: 0,
  otpVerified: false,
  otpAttempts: 0,
};

function getAuthState(state: AgentState): AuthorizationState {
  return {
    ...DEFAULT_AUTH_STATE,
    ...(state.session?.authorizationState ?? {}),
  };
}

export interface AuthorizationConfig {
  pinTimeoutMs: number;      // 2 minutes
  otpTimeoutMs: number;      // 5 minutes
  maxPinAttempts: number;    // 3 attempts
  maxOtpAttempts: number;    // 3 attempts
}

const DEFAULT_CONFIG: AuthorizationConfig = {
  pinTimeoutMs: 2 * 60 * 1000,      // 2 minutes
  otpTimeoutMs: 5 * 60 * 1000,      // 5 minutes
  maxPinAttempts: 3,
  maxOtpAttempts: 3,
};

/**
 * Check if PIN verification has expired
 */
export function isPinExpired(state: AgentState, config: AuthorizationConfig = DEFAULT_CONFIG): boolean {
  const auth = state.session?.authorizationState;
  if (!auth?.pinVerifiedAt) return false;

  const verifiedAt = new Date(auth.pinVerifiedAt).getTime();
  const now = Date.now();
  const elapsed = now - verifiedAt;

  return elapsed > config.pinTimeoutMs;
}

/**
 * Check if OTP verification has expired
 */
export function isOtpExpired(state: AgentState, config: AuthorizationConfig = DEFAULT_CONFIG): boolean {
  const auth = state.session?.authorizationState;
  if (!auth?.otpSentAt) return false;

  const sentAt = new Date(auth.otpSentAt).getTime();
  const now = Date.now();
  const elapsed = now - sentAt;

  return elapsed > config.otpTimeoutMs;
}

/**
 * Get remaining time for PIN (in seconds)
 */
export function getPinRemainingSeconds(state: AgentState, config: AuthorizationConfig = DEFAULT_CONFIG): number {
  const auth = state.session?.authorizationState;
  if (!auth?.pinVerifiedAt) return 0;

  const verifiedAt = new Date(auth.pinVerifiedAt).getTime();
  const now = Date.now();
  const elapsed = now - verifiedAt;
  const remaining = Math.max(0, config.pinTimeoutMs - elapsed);

  return Math.ceil(remaining / 1000);
}

/**
 * Get remaining time for OTP (in seconds)
 */
export function getOtpRemainingSeconds(state: AgentState, config: AuthorizationConfig = DEFAULT_CONFIG): number {
  const auth = state.session?.authorizationState;
  if (!auth?.otpSentAt) return 0;

  const sentAt = new Date(auth.otpSentAt).getTime();
  const now = Date.now();
  const elapsed = now - sentAt;
  const remaining = Math.max(0, config.otpTimeoutMs - elapsed);

  return Math.ceil(remaining / 1000);
}

/**
 * Check if PIN is still valid (not expired and verified)
 */
export function isPinValid(state: AgentState, config: AuthorizationConfig = DEFAULT_CONFIG): boolean {
  const auth = state.session?.authorizationState;
  return auth?.pinVerified === true && !isPinExpired(state, config);
}

/**
 * Check if OTP is still valid (not expired and verified)
 */
export function isOtpValid(state: AgentState, config: AuthorizationConfig = DEFAULT_CONFIG): boolean {
  const auth = state.session?.authorizationState;
  return auth?.otpVerified === true && !isOtpExpired(state, config);
}

/**
 * Verify OTP input against stored code
 * Returns: { valid: boolean, message: string, attemptsRemaining: number }
 */
export function verifyOtpCode(
  state: AgentState,
  otpInput: string,
  config: AuthorizationConfig = DEFAULT_CONFIG
): { valid: boolean; message: string; attemptsRemaining: number } {
  const auth = getAuthState(state);
  const storedOtp = auth.otpCode;

  // Validate OTP format
  if (!otpInput || !/^\d{4,6}$/.test(otpInput.trim())) {
    return {
      valid: false,
      message: "🔐 OTP must be 4-6 digits",
      attemptsRemaining: config.maxOtpAttempts - (auth.otpAttempts || 0),
    };
  }

  // Check if already exceeded max attempts
  if ((auth.otpAttempts || 0) >= config.maxOtpAttempts) {
    return {
      valid: false,
      message: "🔒 OTP verification locked due to too many failed attempts. Please request a new OTP.",
      attemptsRemaining: 0,
    };
  }

  // Check if OTP has expired
  if (isOtpExpired(state, config)) {
    return {
      valid: false,
      message: "⏱️ OTP has expired. Please request a new one.",
      attemptsRemaining: config.maxOtpAttempts - (auth.otpAttempts || 0),
    };
  }

  // Compare OTP codes
  if (otpInput.trim() !== storedOtp) {
    const remaining = config.maxOtpAttempts - ((auth.otpAttempts || 0) + 1);
    return {
      valid: false,
      message: `❌ Incorrect OTP. You have ${remaining} attempt(s) remaining.`,
      attemptsRemaining: remaining,
    };
  }

  return {
    valid: true,
    message: "✅ OTP verified successfully",
    attemptsRemaining: config.maxOtpAttempts,
  };
}

/**
 * Reset authorization state for new transaction
 */
export function resetAuthorizationState(state: AgentState): AgentState {
  if (!state.session) return state;

  return {
    ...state,
    session: {
      ...state.session,
      authorizationState: {
        pinVerified: false,
        pinAttempts: 0,
        otpVerified: false,
        otpAttempts: 0,
        otpCode: undefined,
      },
      transactionContext: undefined,
    },
  };
}

/**
 * Clear authorization state between sessions
 */
export function clearAuthorizationState(state: AgentState): AgentState {
  if (!state.session) return state;

  return {
    ...state,
    session: {
      ...state.session,
      authorizationState: {
        pinVerified: false,
        pinAttempts: 0,
        otpVerified: false,
        otpAttempts: 0,
      },
    },
  };
}

/**
 * Get authorization status summary for context
 */
export function getAuthorizationStatus(
  state: AgentState,
  config: AuthorizationConfig = DEFAULT_CONFIG
): {
  pinStatus: "verified" | "expired" | "pending" | "locked";
  otpStatus: "verified" | "expired" | "pending" | "locked";
  pinRemainingSeconds: number;
  otpRemainingSeconds: number;
} {
  const auth = getAuthState(state);

  let pinStatus: "verified" | "expired" | "pending" | "locked" = "pending";
  if (auth.pinVerified && !isPinExpired(state, config)) {
    pinStatus = "verified";
  } else if (auth.pinVerified && isPinExpired(state, config)) {
    pinStatus = "expired";
  } else if ((auth.pinAttempts || 0) >= config.maxPinAttempts) {
    pinStatus = "locked";
  }

  let otpStatus: "verified" | "expired" | "pending" | "locked" = "pending";
  if (auth.otpVerified && !isOtpExpired(state, config)) {
    otpStatus = "verified";
  } else if (auth.otpVerified && isOtpExpired(state, config)) {
    otpStatus = "expired";
  } else if ((auth.otpAttempts || 0) >= config.maxOtpAttempts) {
    otpStatus = "locked";
  }

  return {
    pinStatus,
    otpStatus,
    pinRemainingSeconds: getPinRemainingSeconds(state, config),
    otpRemainingSeconds: getOtpRemainingSeconds(state, config),
  };
}
