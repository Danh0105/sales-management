import {
    WebSocketGateway,
    WebSocketServer,
    SubscribeMessage,
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnGatewayInit,
} from '@nestjs/websockets';

import { Server, Socket } from 'socket.io';
import { RealtimeAuthService } from '../../realtime/realtime-auth.service';

@WebSocketGateway({
    cors: {
        origin: '*',
    },
})
export class NotificationGateway
    implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
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
        // Không log handshake/token hoặc dữ liệu người dùng.
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
