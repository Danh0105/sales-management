// suggest/events/suggest-created.event.ts
export class SuggestCreatedEvent {
    constructor(
        public readonly suggestId: number,
        public readonly message: string,
        public readonly receiverIds: number[],
        public readonly tokens: string[],
        public readonly senderId?: number,
    ) { }
}