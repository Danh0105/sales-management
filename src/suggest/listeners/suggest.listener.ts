// suggest/listeners/suggest.listener.ts
import { OnEvent } from '@nestjs/event-emitter';
import { SuggestCreatedEvent } from '../events/suggest-created.event';
import { Injectable } from '@nestjs/common';
import { SuggestReviewedEvent } from '../events/suggest-reviewed.event';
import { SuggestApprovedEvent } from '../events/suggest-approved.event';
import { SuggestNotificationService } from '../../notifications/services/suggest-notification.service';

@Injectable()
export class SuggestListener {
    constructor(
        private readonly suggestNotificationService: SuggestNotificationService,
    ) { }

    @OnEvent('suggest.created')
    async handleSuggestCreated(event: SuggestCreatedEvent) {
        try {
            await this.suggestNotificationService.handleSuggestCreated(event);
        } catch (err) {
            console.error("❌ suggest.created error", err);
        }
    }
    @OnEvent('suggest.reviewed')
    async handleSuggestReviewed(event: SuggestReviewedEvent) {
        try {
            await this.suggestNotificationService.handleSuggestReviewed(event);
        } catch (err) {
            console.error("❌ suggest.reviewed error", err);
        }
    }
    @OnEvent('suggest.approved')
    async handleSuggestApproved(event: SuggestApprovedEvent) {
        try {
            await this.suggestNotificationService.handleSuggestApproved(event);
        } catch (err) {
            console.error("❌ suggest.approved error", err);
        }
    }
}