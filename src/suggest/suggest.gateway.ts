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
    namespace: 'suggest',
    cors: {
        origin: '*',
    },
})
export class SuggestGateway
    implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {

    constructor(private readonly auth: RealtimeAuthService) {}

    @WebSocketServer()
    server!: Server;

    afterInit(server: Server) {
        this.auth.protect(server);
    }

    // ================= CONNECT =================
    handleConnection(client: Socket) {
        this.auth.joinOwnRoom(client, 'suggest_user_');
    }
    // ================= DISCONNECT =================
    handleDisconnect(client: Socket) {
        // Lifecycle timers được RealtimeAuthService dọn ở sự kiện disconnect.
    }
}
