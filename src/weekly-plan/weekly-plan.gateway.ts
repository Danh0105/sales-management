import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';

@WebSocketGateway({
    cors: {
        origin: '*',
    },
})
export class WeeklyPlanGateway
    implements
    OnGatewayConnection,
    OnGatewayDisconnect {
    @WebSocketServer()
    server!: Server;

    handleConnection(client: Socket) {
        const employeeId =
            client.handshake.query
                .employeeId as string;

        if (employeeId) {
            client.join(
                `user_${employeeId}`,
            );
        }

        console.log(
            'Client connected:',
            client.id,
            'user:',
            employeeId,
        );
    }

    handleDisconnect(client: Socket) {
        console.log(
            'Client disconnected:',
            client.id,
        );
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