/** Nguồn tiền dùng để chi khi kế toán công nợ lên lệnh chi. */
export enum FundSource {
    /** Tiền mặt sẵn có tại công ty (quỹ tiền mặt) */
    COMPANY_CASH = 'COMPANY_CASH',
    /** Tiền trong tài khoản ngân hàng của công ty */
    BANK_ACCOUNT = 'BANK_ACCOUNT',
}

export const FUND_SOURCE_LABEL: Record<FundSource, string> = {
    [FundSource.COMPANY_CASH]: 'tiền sẵn có ở công ty',
    [FundSource.BANK_ACCOUNT]: 'tài khoản ngân hàng',
};
