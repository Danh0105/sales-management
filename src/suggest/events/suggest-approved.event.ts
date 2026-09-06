export class SuggestApprovedEvent {
    constructor(
        public readonly data: {
            suggestId: number;

            message: string;

            receiverIds: number[];

            tokens: string[];

            actorId?: number;
        },
    ) {}
}