import { Injectable } from "@nestjs/common";
import { NotificationService } from "./notification.service";
import { NotificationType } from "../enums/notification-type.enum";

@Injectable()
export class SystemNotificationService {
    constructor(
        private notificationService: NotificationService,
    ) { }

    async maintenance(receiverId: number) {
        return this.notificationService.create({
            receiverId,

            type: NotificationType.SYSTEM,

            message: "Hệ thống sẽ bảo trì lúc 22h",
        });
    }
}