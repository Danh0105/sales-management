import { Injectable } from "@nestjs/common";
import { NotificationService } from "./notification.service";
import { NotificationType } from "../enums/notification-type.enum";

@Injectable()
export class PolicyNotificationService {
    constructor(
        private notificationService: NotificationService,
    ) { }

    async createdPolicy(data: {
        receiverId: number;
        senderId: number;
        policyId: number;
        policyTitle: string;
    }) {
        return this.notificationService.create({
            receiverId: data.receiverId,

            senderId: data.senderId,

            type: NotificationType.POLICY,

            entityId: data.policyId,

            message: `Bạn có chính sách mới: ${data.policyTitle}`,

            meta: {
                policyTitle: data.policyTitle,
            },
        });
    }

    async updatedPolicy(data: {
        receiverId: number;
        senderId: number;
        policyId: number;
        policyTitle: string;
    }) {
        return this.notificationService.create({
            receiverId: data.receiverId,

            senderId: data.senderId,

            type: NotificationType.POLICY,

            entityId: data.policyId,

            message: `Chính sách đã được cập nhật: ${data.policyTitle}`,
        });
    }
}