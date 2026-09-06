import {
    ConnectedSocket,
    MessageBody,
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';

import { Server, Socket }
    from 'socket.io';

@WebSocketGateway({
    namespace: 'report',
    cors: {
        origin: '*',
    },
})
export class ReportGateway
    implements
    OnGatewayConnection,
    OnGatewayDisconnect {

    @WebSocketServer()
    server!: Server;

    // ============================================
    // CONNECT
    // ============================================

    handleConnection(client: Socket) {
        const rawUserId =
            client.handshake.auth?.userId ||
            client.handshake.query?.userId;

        const userId = Number(rawUserId);

        if (!rawUserId || Number.isNaN(userId)) {
            console.log(
                `❌ Socket rejected: ${client.id}, userId invalid:`,
                rawUserId,
            );

            console.log("SOCKET MISSING USER ID", {
                socketId: client.id,
                query: client.handshake.query,
                auth: client.handshake.auth,
            });

            return;
        }

        client.join(`user_${userId}`);

        console.log(
            `✅ Client connected: ${client.id} -> user_${userId}`,
        );
    }

    // ============================================
    // DISCONNECT
    // ============================================

    handleDisconnect(
        client: Socket,
    ) {

        console.log(
            `❌ Client disconnected: ${client.id}`,
        );
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