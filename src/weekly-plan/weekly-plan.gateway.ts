import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';
import { RealtimeAuthService } from '../realtime/realtime-auth.service';

@WebSocketGateway({
    cors: {
        origin: '*',
    },
})
export class WeeklyPlanGateway
    implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect {
    constructor(private readonly auth: RealtimeAuthService) {}

    @WebSocketServer()
    server!: Server;

    afterInit(server: Server) {
        this.auth.protect(server);
    }

    handleConnection(client: Socket) {
        this.auth.joinOwnRoom(client);
    }

    handleDisconnect(client: Socket) {
        // Lifecycle timers được RealtimeAuthService dọn ở sự kiện disconnect.
    }

    notifyNewWeeklyPlan(
        weeklyPlanId: number,
        userIds: number[],
        senderName: string,
    ) {
        userIds.forEach((id) => {
            this.server
                .to(`user_${id}`)
                .emit(
                    'notification:new',
                    {
                        weeklyPlanId,

                        type: 'weekly_plan',

                        message: `${senderName} đã gửi báo cáo tuần`,

                        createdAt:
                            new Date(),

                        isRead: false,
                    },
                );
        });
    }
}
