// ─────────────────────────────────────────────────────────────────────────────
// EXTERNAL BANKING API INTEGRATIONS — Ruby Mock Bank
// Base URL: https://ruby.tech4human.io
//   - POST /mock-bank/validate-account  → resolve name + generate OTP
//   - POST /mock-bank/verify-otp        → verify OTP, return user token
//   - POST /mock-bank/transfer          → execute a transfer (deducts + credits)
//   - POST /mock-bank/bill              → bill payment (deducts balance)
//   - GET  /mock-bank/balance/:acct     → live balance from MongoDB
//   - GET  /mock-bank/statement/:acct   → paginated transaction history
//   - GET  /mock-bank/transfer-status/:ref → query status by reference
//   - GET  /api/banks                   → supported bank list
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_BANK_BASE =
  process.env.MOCK_BANK_BASE_URL || "https://ruby.tech4human.io";

/** Small fetch wrapper that parses JSON and normalises failures. */
async function mockRequest<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${MOCK_BANK_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) {
      console.error(`[MockBank] ${init?.method || "GET"} ${path} failed: ${res.status}`);
      const text = await res.text().catch(() => "");
      console.error(`[MockBank] body: ${text.slice(0, 300)}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    console.error(`[MockBank] network/parse error on ${path}:`, error);
    return null;
  }
}

interface BankValidationResponse {
  success: boolean;
  data?: {
    accountName: string;
    accountType: string;
    bankCode: string;
    bankName: string;
    otpFlag: boolean;
    otpReference: string;
    maskedPhone: string;
  };
  error?: string;
  message?: string;
  timestamp?: string;
}
export async function validateBankAccount(accountNumber: string, bankCode: string): Promise<BankValidationResponse> {
  const maskedAccount = accountNumber.length > 4 ? `****${accountNumber.slice(-4)}` : "****";
  console.log(`[validateBankAccount] Validating account ${maskedAccount} for bank code: ${bankCode}`);

  try {
    const result = await mockRequest<BankValidationResponse>("/mock-bank/validate-account", {
      method: "POST",
      body: JSON.stringify({ accountNumber, bankCode }),
    });
    
    console.log(`[validateBankAccount] Validation response received for ${maskedAccount}:`, result);
    return result ?? { success: false };
  } catch (err) {
    console.error(`[validateBankAccount] Failed to validate account ${maskedAccount}:`, err);
    return { success: false };
  }
}

export interface OtpVerificationResponse {
  success?: boolean;
  data?: {
    userToken?: string;
    tokenType?: string;
    tokenExpiresAt?: string;
  };
  timestamp?: string;
}



export async function verifyOtp(accountNumber: string, otp: string, otpReference: string): Promise<OtpVerificationResponse | null> {
  const maskedAccount = accountNumber.length > 4 ? `****${accountNumber.slice(-4)}` : "****";
  console.log(`[verifyOtp] Attempting OTP verification for account: ${maskedAccount}, reference: ${otpReference}`);
  
  try {
    const result = await mockRequest<OtpVerificationResponse>("/mock-bank/verify-otp", {
      method: "POST",
      body: JSON.stringify({ accountNumber, otp, otpReference }),
    });

    console.log(`[verifyOtp] OTP verification response received:`, JSON.stringify(result, null, 2));
    console.log(`[verifyOtp] OTP verification response received for reference ${otpReference}:`, result ? "Success" : "Null response");
    return result;
  } catch (err) {
    console.error(`[verifyOtp] Failed to verify OTP for reference ${otpReference}:`, err);
    return null;
  }
}




// ─── Transfer ─────────────────────────────────────────────────────────────────

export interface MockTransferParams {
  reference: string;
  sourceAccount: string;
  sourceBankCode: string;       // NIBSS code e.g. "044"
  destinationAccount: string;
  destinationBankCode: string;  // NIBSS code e.g. "058"
  amountKobo: number;           // amount in KOBO (N × 100)
  narration?: string;
}

export interface MockTransferResult {
  success: boolean;
  reference?: string;       // our Ruby reference
  bankReference?: string;   // e.g. "ACC-1787812647516-ZMTET"
  status?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export async function executeMockTransfer(params: MockTransferParams): Promise<MockTransferResult> {
  const result = await mockRequest<any>("/mock-bank/transfer", {
    method: "POST",
    body: JSON.stringify({
      // Real spec keys (Ruby playground): rubyReference, sourceAccount,
      // sourceBank, recipientAccount, recipientBank, amount(kobo), narration.
      rubyReference: params.reference,
      reference: params.reference,          // alias kept for safety
      sourceAccount: params.sourceAccount,
      sourceBank: params.sourceBankCode,
      sourceBankCode: params.sourceBankCode,
      recipientAccount: params.destinationAccount,
      recipientBank: params.destinationBankCode,
      destinationAccount: params.destinationAccount, // alias
      destinationBankCode: params.destinationBankCode,// alias
      amount: params.amountKobo,            // KOBO per API docs
      amountKobo: params.amountKobo,        // alias
      narration: params.narration ?? "",
    }),
  });

  if (!result) return { success: false, message: "Transfer request failed (network / server error)." };

  // Actual API response: { bankReference, responseCode: "00", responseMessage }
  const data = result.data || result;
  const responseCode = String(data.responseCode ?? data.response_code ?? "");
  const status = String(data.status ?? "").toLowerCase();
  const success =
    result.success === true || responseCode === "00" || status === "success";

  return {
    success,
    status: success ? "success" : status || "failed",
    // Echo our Ruby reference; the bank reference comes back separately
    reference: params.reference,
    bankReference:
      (data.bankReference ?? data.bank_reference ?? undefined) as string | undefined,
    message:
      data.responseMessage ?? data.response_message ?? result.message ??
      (success ? "Transaction Successful" : "Transfer failed"),
    data,
  };
}

// ─── Balance ──────────────────────────────────────────────────────────────────

export interface MockBalanceResult {
  success: boolean;
  accountNumber?: string;
  maskedAccount?: string;
  balance?: number;       // in Naira
  currency?: string;
  accountType?: string;
  accountName?: string;
  message?: string;
}

export async function getMockBankBalance(accountNumber: string, bankCode?: string): Promise<MockBalanceResult> {
  const qsParts = [bankCode ? `bankCode=${encodeURIComponent(bankCode)}` : ""].filter(Boolean);
  const qs = qsParts.length ? `?${qsParts.join("&")}` : "";
  const result = await mockRequest<any>(`/mock-bank/balance/${encodeURIComponent(accountNumber)}${qs}`);

  if (!result) return { success: false, message: "Balance unavailable (network / server error)." };

  // Actual API response: { "balance": 35000000, "currency": "NGN" } — balance is ALWAYS kobo.
  const data = result.data || result;
  const rawBalance = Number(data.balance ?? data.availableBalance ?? data.available_balance ?? data.balanceKobo);
  const balance = Number.isFinite(rawBalance) ? rawBalance / 100 : NaN;

  const rawAccount = String(data.accountNumber ?? data.account_number ?? accountNumber);
  return {
    success: true,
    accountNumber: rawAccount,
    maskedAccount: maskAccount(rawAccount),
    balance: Number.isFinite(balance) ? Math.round(balance * 100) / 100 : undefined,
    currency: String(data.currency ?? result.currency ?? "NGN"),
    accountType: data.accountType ?? data.account_type ?? undefined,
    accountName: data.accountName ?? data.account_name ?? undefined,
    message: result.message,
  };
}

// ─── Account Details ──────────────────────────────────────────────────────────

export interface MockAccountDetails {
  success: boolean;
  accountNumber?: string;
  accountName?: string;
  accountType?: string;   // 'savings' | 'current' | ...
  bankCode?: string;
  bankName?: string;
  currency?: string;
  bvnMask?: string;       // e.g. "2234****890"
  tier?: string;          // e.g. "tier3"
  kycStatus?: string;     // e.g. "verified"
  email?: string;
  phone?: string;         // masked e.g. "070****5678"
  isSandbox?: boolean;
  message?: string;
}

/** GET /mock-bank/account-details/:accountNumber — full profile, BVN mask, tier, KYC. */
export async function getMockAccountDetails(
  accountNumber: string,
  bankCode?: string
): Promise<MockAccountDetails> {
  const qsParts = [bankCode ? `bankCode=${encodeURIComponent(bankCode)}` : ""].filter(Boolean);
  const qs = qsParts.length ? `?${qsParts.join("&")}` : "";
  const result = await mockRequest<any>(
    `/mock-bank/account-details/${encodeURIComponent(accountNumber)}${qs}`
  );

  if (!result) return { success: false, message: "Account details unavailable (network / server error)." };

  const data = result.data || result;
  return {
    success: true,
    accountNumber: data.accountNumber ?? accountNumber,
    accountName: data.accountName,
    accountType: data.accountType,
    bankCode: data.bankCode ?? bankCode,
    bankName: data.bankName,
    currency: data.currency ?? "NGN",
    bvnMask: data.bvnMask,
    tier: data.tier,
    kycStatus: data.kycStatus,
    email: data.email,
    phone: data.phone,
    isSandbox: Boolean(data.isSandbox),
    message: result.message,
  };
}

function maskAccount(account: string): string {
  return account && account.length > 4
    ? `${account.slice(0, 3)}****${account.slice(-4)}`
    : account;
}

// ─── Bill Payment ─────────────────────────────────────────────────────────────

export interface MockBillParams {
  reference: string;        // unique ruby reference e.g. "RUBY-<acct>-<rand>"
  sourceAccount: string;
  sourceBankCode: string;   // NIBSS code of the debit account e.g. "044"
  billerCode: string;       // e.g. "DSTV", "EKEDC", "LAWMA"
  billerName?: string;      // friendly name e.g. "DSTV Subscription"
  customerReference: string;// smart-card / meter number
  amountKobo: number;       // amount in KOBO (N × 100)
}

export interface MockBillResult {
  success: boolean;
  reference?: string;       // our Ruby reference
  bankReference?: string;   // e.g. "ACC-1787812799505-ARFOU"
  message?: string;
  data?: Record<string, unknown>;
}

export async function payMockBill(params: MockBillParams): Promise<MockBillResult> {
  const result = await mockRequest<any>("/mock-bank/bill", {
    method: "POST",
    body: JSON.stringify({
      rubyReference: params.reference,
      reference: params.reference,
      sourceAccountNumber: params.sourceAccount,
      sourceBankCode: params.sourceBankCode,
      billerCode: params.billerCode,
      billerName: params.billerName ?? params.billerCode,
      customerReference: params.customerReference,
      amount: params.amountKobo, // KOBO per API docs
    }),
  });

  if (!result) return { success: false, message: "Bill payment request failed (network / server error)." };

  const statusStr = String(result.status ?? "").toLowerCase();
  const responseCode = String(result.responseCode ?? result.response_code ?? "");
  // API returns { bankReference, responseCode: "00", responseMessage } on success
  const success =
    result.success === true || statusStr === "success" || responseCode === "00";
  return {
    success,
    reference: params.reference,
    bankReference: result.bankReference ?? result.bank_reference ?? undefined,
    message: result.responseMessage ?? result.message ??
      (success ? "Bill payment successful" : "Bill payment failed"),
    data: result.data ?? result,
  };
}

// ─── Account Statement ────────────────────────────────────────────────────────

export interface MockStatementTxn {
  date: string;
  type: string;
  amount: number;
  currency?: string;
  reference?: string;
  description?: string;
  status?: string;
  balanceAfter?: number;
}

export interface MockStatementResult {
  success: boolean;
  accountNumber?: string;
  page?: number;
  limit?: number;
  total?: number;
  transactions: MockStatementTxn[];
  message?: string;
}

/** GET /mock-bank/statement/:accountNumber — paginated transaction history. */
export async function getMockStatement(
  accountNumber: string,
  bankCode?: string,
  page = 1,
  limit = 20
): Promise<MockStatementResult> {
  const qsParts = [
    bankCode ? `bankCode=${encodeURIComponent(bankCode)}` : "",
    `page=${page}`,
    `limit=${limit}`,
  ].filter(Boolean);
  const result = await mockRequest<any>(
    `/mock-bank/statement/${encodeURIComponent(accountNumber)}?${qsParts.join("&")}`
  );

  if (!result) {
    return { success: false, transactions: [], message: "Statement unavailable (network / server error)." };
  }

  const data = result.data || result;
  const rawList: any[] = Array.isArray(data) ? data : data.transactions ?? data.statement ?? [];
  const transactions: MockStatementTxn[] = rawList.map((txn) => {
    const type = String(txn?.type ?? txn?.transactionType ?? "transaction").toLowerCase();
    // Ledger amounts are ALWAYS stored in kobo (see transfer-status docs) → convert to Naira.
    const n = Number(txn?.amountKobo ?? txn?.amount_kobo ?? txn?.amount ?? txn?.value ?? 0);
    const amountNaira = Number.isFinite(n) ? Math.round((Math.abs(n) / 100) * 100) / 100 : 0;
    const signed = type === "debit" ? -amountNaira : amountNaira;
    const counterparty = txn?.counterparty
      ? `${txn.counterparty.account ?? ""}${txn.counterparty.bank ? ` (${txn.counterparty.bank})` : ""}`.trim()
      : undefined;
    return {
      date: String(txn?.date ?? txn?.createdAt ?? txn?.timestamp ?? new Date().toISOString()),
      type,
      amount: signed,
      currency: String(txn?.currency ?? "NGN"),
      reference:
        txn?.rubyReference ?? txn?.bankReference ?? txn?.reference ?? undefined,
      description:
        txn?.description ?? txn?.narration ?? txn?.remarks ??
        (counterparty ? `${type === "credit" ? "From" : "To"} ${counterparty}` : undefined),
      status: txn?.status ?? txn?.responseMessage ?? undefined,
      balanceAfter: txn?.balanceAfter ?? txn?.balance_after ?? undefined,
    };
  });

  return {
    success: true,
    accountNumber: String(data.accountNumber ?? data.account_number ?? accountNumber),
    page: Number(data.page ?? page),
    limit: Number(data.limit ?? limit),
    total: Number(data.total ?? data.count ?? transactions.length),
    transactions,
  };
}

// ─── Transfer Status ──────────────────────────────────────────────────────────

export interface MockTransferStatusResult {
  success: boolean;
  status?: string;           // 'success' | 'pending' | 'failed' | ...
  responseCode?: string;     // "00" = successful
  rubyReference?: string;
  bankReference?: string;
  type?: string;             // 'credit' | 'debit' — leg this record belongs to
  amount?: number;           // Naira (converted from amountKobo)
  // Side resolved from type+counterparty: 'credit' ⇒ accountNumber is the receiver
  recipientAccount?: string;
  sourceAccount?: string;
  counterpartyBank?: string;
  narration?: string;
  timestamp?: string;
  message?: string;
  data?: Record<string, unknown>;
}

/** GET /mock-bank/transfer-status/:reference — query by Ruby or bank reference. */
export async function getTransferStatus(reference: string): Promise<MockTransferStatusResult> {
  const result = await mockRequest<any>(
    `/mock-bank/transfer-status/${encodeURIComponent(reference.trim())}`
  );

  if (!result) return { success: false, message: "Status lookup failed (network / server error)." };

  // Actual response shape:
  // { bankReference, rubyReference, status, responseCode, type, accountNumber,
  //   amountKobo, narration, timestamp, counterparty: { account, bank } }
  const data = result.data || result;
  const amountKobo = Number(data.amountKobo ?? data.amount);
  const amount = Number.isFinite(amountKobo) ? Math.round((amountKobo / 100) * 100) / 100 : undefined;
  const legAccount = String(data.accountNumber ?? data.account_number ?? "");
  const counterparty = data.counterparty || {};
  const type = String(data.type ?? "").toLowerCase();

  return {
    success: true,
    status: String(data.status ?? "unknown").toLowerCase(),
    responseCode: data.responseCode ?? data.response_code ?? undefined,
    rubyReference: data.rubyReference ?? data.ruby_reference ?? data.reference ?? undefined,
    bankReference: data.bankReference ?? data.bank_reference ?? undefined,
    type: type || undefined,
    amount,
    // If the ledger leg is a credit, accountNumber is the recipient and the
    // counterparty is the sender — and vice-versa for a debit leg.
    recipientAccount: type === "debit" ? String(counterparty.account ?? "") : legAccount,
    sourceAccount: type === "credit" ? String(counterparty.account ?? "") : legAccount,
    counterpartyBank: counterparty.bank ?? counterparty.bankCode ?? undefined,
    narration: data.narration ?? undefined,
    timestamp: data.timestamp ?? data.createdAt ?? data.created_at ?? undefined,
    message: result.message,
    data,
  };
}

// ─── Airtime Purchase ─────────────────────────────────────────────────────────

export interface MockAirtimeParams {
  reference: string;        // unique ruby reference
  sourceAccount: string;
  sourceBankCode: string;   // NIBSS code of the debit account
  phoneNumber: string;      // top-up target e.g. "09047747474"
  network: string;          // MTN | AIRTEL | GLO | 9MOBILE
  amountKobo: number;       // amount in KOBO (N × 100)
}

export interface MockAirtimeResult {
  success: boolean;
  bankReference?: string;
  network?: string;
  phoneNumber?: string;
  message?: string;
}

/**
 * POST /mock-bank/airtime — deducts airtime top-up from account balance.
 * Response: { bankReference, responseCode: "00", network, phoneNumber, responseMessage }
 */
export async function purchaseMockAirtime(params: MockAirtimeParams): Promise<MockAirtimeResult> {
  const result = await mockRequest<any>("/mock-bank/airtime", {
    method: "POST",
    body: JSON.stringify({
      rubyReference: params.reference,
      reference: params.reference,
      sourceAccountNumber: params.sourceAccount,
      sourceBankCode: params.sourceBankCode,
      phoneNumber: params.phoneNumber,
      network: params.network.toUpperCase(),
      amount: params.amountKobo,
    }),
  });

  if (!result) return { success: false, message: "Airtime request failed (network / server error)." };

  const responseCode = String(result.responseCode ?? result.response_code ?? "");
  const success = result.success === true || responseCode === "00";
  return {
    success,
    bankReference: result.bankReference ?? result.bank_reference ?? undefined,
    network: result.network ?? params.network.toUpperCase(),
    phoneNumber: result.phoneNumber ?? params.phoneNumber,
    message: result.responseMessage ?? result.message ?? (success ? "Airtime purchase successful" : "Airtime purchase failed"),
  };
}

// ─── Supported Banks List ─────────────────────────────────────────────────────

export interface MockBank {
  bankCode: string;
  bankName: string;
  shortName?: string;
  nipCode?: string;
  ussdCode?: string;
  isActive?: boolean;
}

export interface MockBanksResult {
  success: boolean;
  banks: MockBank[];
  message?: string;
}

/** GET /api/banks — list of supported NIBSS banks for dropdowns/lookups. */
export async function getSupportedBanks(): Promise<MockBanksResult> {
  const result = await mockRequest<{ success: boolean; data: any[] }>("/api/banks");

  if (!result || !Array.isArray(result.data)) {
    return { success: false, banks: [], message: "Bank list unavailable." };
  }

  const banks: MockBank[] = result.data
    .map((b) => ({
      bankCode: String(b.bankCode ?? b.bank_code ?? ""),
      bankName: String(b.bankName ?? b.bank_name ?? ""),
      shortName: b.shortName ?? b.short_name ?? undefined,
      nipCode: b.nipCode ?? b.nip_code ?? undefined,
      ussdCode: b.ussdCode ?? b.ussd_code ?? undefined,
      isActive: Boolean(b.isActive ?? true),
    }))
    .filter((b) => b.bankCode && b.bankName);

  return { success: true, banks };
}
