export enum SuggestType {
    /** Luồng đề xuất thường (cũ): PENDING → REVIEWED → APPROVED */
    SUGGESTION = 'SUGGESTION',

    /** Luồng đề xuất chi tiền: DRAFT → PENDING_APPROVAL → ... → SPENT/FUND_RETURNED */
    EXPENSE_REQUEST = 'EXPENSE_REQUEST',
}
