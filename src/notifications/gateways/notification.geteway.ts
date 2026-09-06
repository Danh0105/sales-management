import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    OnGatewayDisconnect,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';

@WebSocketGateway({
    cors: {
        origin: '*',
    },
})
export class NotificationGateway
    implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server!: Server;

    handleConnection(client: Socket) {
        const employeeId =
            client.handshake.query.employeeId ||
            client.handshake.query.userId ||
            client.handshake.auth?.employeeId ||
            client.handshake.auth?.userId;

        if (employeeId) {
            client.join(`user_${employeeId}`);
        }

        console.log('Notification connected:', {
            socketId: client.id,
            employeeId,
            rooms: Array.from(client.rooms),
        });
    }

    handleDisconnect(client: Socket) {
        console.log('Notification disconnected:', client.id);
    }

    emitToUser(userId: number, event: string, data: any) {
        const room = `user_${userId}`;

        console.log({
            event,
            room,
            data,
        });

        this.server.to(room).emit(event, data);
    }

    emitToUsers(userIds: number[], event: string, data: any) {
        userIds.forEach((id) => {
            this.emitToUser(id, event, data);
        });
    }

    broadcast(event: string, data: any) {
        this.server.emit(event, data);
    }
}