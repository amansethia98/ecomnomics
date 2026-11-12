/** Where a redacted payout file is kept. The logged sha256 is the uploaded file, not these bytes. */
export interface PayoutFileRetention {
  put(input: { sha256: string; parserVersion: string; body: Uint8Array }): Promise<void>;
}

export const noopPayoutFileRetention: PayoutFileRetention = {
  async put() {},
};
