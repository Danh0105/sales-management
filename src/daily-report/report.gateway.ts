import {
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    OnGatewayInit,
} from '@nestjs/websockets';

import { Server, Socket }
    from 'socket.io';
import { RealtimeAuthService } from '../realtime/realtime-auth.service';

@WebSocketGateway({
    namespace: 'report',
    cors: {
        origin: '*',
    },
})
export class ReportGateway
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

    // ============================================
    // CONNECT
    // ============================================

    handleConnection(client: Socket) {
        this.auth.joinOwnRoom(client);
    }

    // ============================================
    // DISCONNECT
    // ============================================

    handleDisconnect(
        client: Socket,
    ) {

        // Lifecycle timers được RealtimeAuthService dọn ở sự kiện disconnect.
    }

    // ============================================
    // CLIENT TEST
    // ============================================

    @SubscribeMessage(
        'report:test',
    )
    handleTest(

        @MessageBody()
        body: any,

        @ConnectedSocket()
        client: Socket,
    ) {

        console.log(
            'report:test',
            body,
        );

        client.emit(
            'report:test:response',
            {
                success: true,
                body,
            },
        );
    }

    // ============================================
    // SEND REPORT TO USER
    // ============================================

    emitNewReport(
        userId: number,
        payload: any,
    ) {

        this.server
            .to(`user_${userId}`)
            .emit(
                'report:new',
                payload,
            );
    }

    // ============================================
    // SEND NOTIFICATION
    // ============================================

    emitNotification(
        userId: number,
        payload: any,
    ) {

        this.server
            .to(`user_${userId}`)
            .emit(
                'notification:new',
                payload,
            );
    }
}
