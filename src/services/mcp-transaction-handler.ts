/**
 * MCP Transaction Handler
 * 
 * Properly aligned with actual MCP server capabilities:
 * - lookup_customer_by_account (returns bank_name directly)
 * - send_verification_otp (returns otp_code)
 * - verify_pin (returns is_valid, not success)
 * - No non-existent tools like resolve_bank_from_account
 * 
 * Handles:
 * - OTP code storage in state
 * - Bank resolution from account lookup
 * - PIN/OTP verification sequencing
 * - Timeout management
 */

import { AgentState } from "../core/agent-state.js";
import { getBankingMcpToolsets, callBankingTool } from "../mastra/core/mcp/banking-mcp-client.js";

type AuthorizationState = NonNullable<AgentState["session"]["authorizationState"]>;

const DEFAULT_AUTH_STATE: AuthorizationState = {
  pinVerified: false,
  pinAttempts: 0,
  otpVerified: false,
  otpAttempts: 0,
};

type LookupByAccountResult = {
  success: boolean;
  message?: string;
  bank_name?: string;
  customer_name?: string;
  account_number_masked?: string;
};

type SendOtpResult = {
  success: boolean;
  message?: string;
  otp_code?: string;
};

type VerifyPinResult = {
  is_valid?: boolean;
  attempts_remaining?: number;
  error_code?: string;
  message?: string;
};

type BalanceResult = {
  success?: boolean;
  balance?: number;
  available_balance?: number;
  pin_required?: boolean;
  pin_verified?: boolean;
  message?: string;
};

type TransferResult = {
  success?: boolean;
  transaction_ref?: string;
  status?: string;
  message?: string;
};

type MiniStatementResult = {
  success?: boolean;
  transactions?: Array<{
    date: string;
    description: string;
    amount: number;
    type: "debit" | "credit";
    balance: number;
  }>;
  message?: string;
};

export interface TransactionHandlerConfig {
  maxRetries: number;
  retryDelayMs: number;
}

const DEFAULT_CONFIG: TransactionHandlerConfig = {
  maxRetries: 2,
  retryDelayMs: 500,
};

/**
 * Resolve recipient bank from account number
 * FIXED: Uses lookup_customer_by_account directly (no resolve_bank_from_account)
 */
export async function resolveRecipientBank(
  accountNumber: string,
  config: TransactionHandlerConfig = DEFAULT_CONFIG
): Promise<{
  success: boolean;
  bank_name?: string;
  customer_name?: string;
  account_number_masked?: string;
  error?: string;
}> {
  try {
    // Call MCP tool with only account_number parameter
    const result = await callBankingTool<LookupByAccountResult>("lookup_customer_by_account", {
      account_number: accountNumber,
    });

    if (!result?.success) {
      return {
        success: false,
        error: result?.message || "Account lookup failed",
      };
    }

    return {
      success: true,
      bank_name: result.bank_name,
      customer_name: result.customer_name,
      account_number_masked: result.account_number_masked,
    };
  } catch (error) {
    console.error("[MCP] Bank resolution error:", error);
    return {
      success: false,
      error: "Failed to resolve recipient bank",
    };
  }
}

/**
 * Send OTP and store code in state
 * FIXED: Extracts and returns OTP code from response
 */
export async function sendOtpToPhone(
  phone: string,
  config: TransactionHandlerConfig = DEFAULT_CONFIG
): Promise<{
  success: boolean;
  otp_code?: string;
  message?: string;
  error?: string;
}> {
  try {
    const result = await callBankingTool<SendOtpResult>("send_verification_otp", {
      phone_number: phone,
    });

    if (!result?.success) {
      return {
        success: false,
        error: result?.message || "OTP sending failed",
      };
    }

    // CRITICAL: Extract OTP code from response
    const otpCode = result.otp_code;
    if (!otpCode) {
      return {
        success: false,
        error: "OTP code not returned from server",
      };
    }

    return {
      success: true,
      otp_code: otpCode,
      message: `OTP sent to ${phone}`,
    };
  } catch (error) {
    console.error("[MCP] OTP sending error:", error);
    return {
      success: false,
      error: "Failed to send OTP",
    };
  }
}

/**
 * Verify PIN via MCP
 * FIXED: Checks is_valid field (not success)
 */
export async function verifyPinViaMcp(
  customerId: string,
  pin: string,
  config: TransactionHandlerConfig = DEFAULT_CONFIG
): Promise<{
  is_valid: boolean;
  attempts_remaining?: number;
  error_code?: string;
  message?: string;
}> {
  try {
    const result = await callBankingTool<VerifyPinResult>("verify_pin", {
      customer_id: customerId,
      pin: pin,
    });

    return {
      is_valid: result?.is_valid || false,
      attempts_remaining: result?.attempts_remaining,
      error_code: result?.error_code,
      message: result?.message,
    };
  } catch (error) {
    console.error("[MCP] PIN verification error:", error);
    return {
      is_valid: false,
      message: "PIN verification failed",
    };
  }
}

/**
 * Get customer balance with PIN gating
 */
export async function getCustomerBalance(
  customerId: string,
  requirePin: boolean = true,
  config: TransactionHandlerConfig = DEFAULT_CONFIG
): Promise<{
  success: boolean;
  balance?: number;
  available_balance?: number;
  pin_required?: boolean;
  pin_verified?: boolean;
  error?: string;
}> {
  try {
    const result = await callBankingTool<BalanceResult>("balance_enquiry", {
      customer_id: customerId,
      require_pin: requirePin,
    });

    return {
      success: result?.success || false,
      balance: result?.balance,
      available_balance: result?.available_balance,
      pin_required: result?.pin_required,
      pin_verified: result?.pin_verified,
      error: result?.message,
    };
  } catch (error) {
    console.error("[MCP] Balance enquiry error:", error);
    return {
      success: false,
      error: "Failed to fetch balance",
    };
  }
}

/**
 * Initiate transfer with full validation
 */
export async function initiateTransfer(
  customerId: string,
  recipientAccount: string,
  amount: number,
  narration: string,
  config: TransactionHandlerConfig = DEFAULT_CONFIG
): Promise<{
  success: boolean;
  transaction_ref?: string;
  status?: string;
  error?: string;
}> {
  try {
    const result = await callBankingTool<TransferResult>("intra_transfer", {
      customer_id: customerId,
      recipient_account: recipientAccount,
      amount: amount,
      narration: narration,
    });

    return {
      success: result?.success || false,
      transaction_ref: result?.transaction_ref,
      status: result?.status,
      error: result?.message,
    };
  } catch (error) {
    console.error("[MCP] Transfer initiation error:", error);
    return {
      success: false,
      error: "Failed to initiate transfer",
    };
  }
}

/**
 * Get mini statement
 */
export async function getMiniStatement(
  customerId: string,
  limit: number = 10,
  config: TransactionHandlerConfig = DEFAULT_CONFIG
): Promise<{
  success: boolean;
  transactions?: Array<{
    date: string;
    description: string;
    amount: number;
    type: "debit" | "credit";
    balance: number;
  }>;
  error?: string;
}> {
  try {
    const result = await callBankingTool<MiniStatementResult>("mini_statement", {
      customer_id: customerId,
      limit: limit,
    });

    return {
      success: result?.success || false,
      transactions: result?.transactions,
      error: result?.message,
    };
  } catch (error) {
    console.error("[MCP] Mini statement error:", error);
    return {
      success: false,
      error: "Failed to fetch statement",
    };
  }
}

/**
 * Update state with transaction context
 */
export function updateTransactionContext(
  state: AgentState,
  context: {
    recipientName?: string;
    recipientBank?: string;
    recipientAccount?: string;
    amount?: number;
    narration?: string;
  }
): AgentState {
  if (!state.session) return state;

  return {
    ...state,
    session: {
      ...state.session,
      transactionContext: {
        ...state.session.transactionContext,
        ...context,
      },
    },
  };
}

/**
 * Update state with OTP code
 */
export function updateOtpCode(
  state: AgentState,
  otpCode: string
): AgentState {
  if (!state.session) return state;

  const now = new Date().toISOString();
  const authState: AuthorizationState = {
    ...DEFAULT_AUTH_STATE,
    ...(state.session.authorizationState ?? {}),
  };
  return {
    ...state,
    session: {
      ...state.session,
      authorizationState: {
        ...authState,
        otpCode: otpCode,
        otpSentAt: now,
        otpAttempts: 0,
      },
    },
  };
}

/**
 * Update state with PIN verification
 */
export function updatePinVerified(
  state: AgentState,
  verified: boolean
): AgentState {
  if (!state.session) return state;

  const now = new Date().toISOString();
  const authState: AuthorizationState = {
    ...DEFAULT_AUTH_STATE,
    ...(state.session.authorizationState ?? {}),
  };
  return {
    ...state,
    session: {
      ...state.session,
      authorizationState: {
        ...authState,
        pinVerified: verified,
        pinVerifiedAt: verified ? now : undefined,
        pinAttempts: verified ? 0 : (authState.pinAttempts || 0) + 1,
      },
    },
  };
}

/**
 * Update state with OTP verification
 */
export function updateOtpVerified(
  state: AgentState,
  verified: boolean
): AgentState {
  if (!state.session) return state;

  const now = new Date().toISOString();
  const authState: AuthorizationState = {
    ...DEFAULT_AUTH_STATE,
    ...(state.session.authorizationState ?? {}),
  };
  return {
    ...state,
    session: {
      ...state.session,
      authorizationState: {
        ...authState,
        otpVerified: verified,
        otpVerifiedAt: verified ? now : undefined,
        otpAttempts: verified ? 0 : (authState.otpAttempts || 0) + 1,
      },
    },
  };
}

/**
 * Increment PIN attempt counter
 */
export function incrementPinAttempts(state: AgentState): AgentState {
  if (!state.session?.authorizationState) return state;

  return {
    ...state,
    session: {
      ...state.session,
      authorizationState: {
        ...state.session.authorizationState,
        pinAttempts: (state.session.authorizationState.pinAttempts || 0) + 1,
      },
    },
  };
}

/**
 * Increment OTP attempt counter
 */
export function incrementOtpAttempts(state: AgentState): AgentState {
  if (!state.session?.authorizationState) return state;

  return {
    ...state,
    session: {
      ...state.session,
      authorizationState: {
        ...state.session.authorizationState,
        otpAttempts: (state.session.authorizationState.otpAttempts || 0) + 1,
      },
    },
  };
}
