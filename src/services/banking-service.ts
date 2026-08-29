export interface VerifiedCustomerParams {
  flowId: string;
  flowToken: string;
  accountDetails: {
    firstname: string;
    lastname: string;
    account: string;
    bankCode: string;
  };
  bankToken: string;
  phoneNumber?: string;
}

export const bankingService = {
  /**
   * Saves or updates a verified customer's banking details into PostgreSQL.
   */
  async saveVerifiedCustomer(db: any, params: VerifiedCustomerParams): Promise<void> {
    const { firstname, lastname, account, bankCode } = params.accountDetails;
    
    // Standard upsert logic: If the account already exists, update tokens, phone, and timestamp.
    const query = `
      INSERT INTO verified_customers (
        flow_id, 
        flow_token,
        first_name, 
        last_name, 
        account_number, 
        bank_code, 
        bank_token,
        phone_number, 
        verified_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (account_number) 
      DO UPDATE SET 
        flow_id = EXCLUDED.flow_id,
        flow_token = EXCLUDED.flow_token,
        bank_token = EXCLUDED.bank_token,
        phone_number = EXCLUDED.phone_number,
        verified_at = EXCLUDED.verified_at;
    `;
    
    const values = [
      params.flowId,
      params.flowToken,
      firstname,
      lastname,
      account,
      bankCode,
      params.bankToken,
      params.phoneNumber ?? null
    ];

    try {
      await db.query(query, values);
      console.log(`✅ Successfully stored verified customer token for account: ${account}`);
    } catch (error) {
      console.error(`❌ DB Error while saving verified customer:`, error);
      throw error; 
    }
  }
};
