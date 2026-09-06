export class SuggestReviewedEvent {
    constructor(
        public readonly suggestId: number,

        public readonly message: string,

        public readonly receiverIds: number[],

        public readonly tokens: string[],

        public readonly reviewerId: number,

        public readonly status:
            'APPROVED' | 'REJECTED',

        public readonly comment?: string,
    ) {}
}