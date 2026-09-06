import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
    namespace: 'suggest',
    cors: {
        origin: '*',
    },
})
export class SuggestGateway
    implements OnGatewayConnection, OnGatewayDisconnect {

    @WebSocketServer()
    server!: Server;

    // ================= CONNECT =================
    handleConnection(client: Socket) {
        const rawEmployeeId =
            client.handshake.query.employeeId as string;

        const employeeId = Number(rawEmployeeId);

        if (!rawEmployeeId || Number.isNaN(employeeId)) {
            console.log(
                `❌ Suggest socket rejected: ${client.id}, employeeId invalid:`,
                rawEmployeeId,
            );

            console.log("SOCKET MISSING USER ID", {
                socketId: client.id,
                query: client.handshake.query,
                auth: client.handshake.auth,
            });

            return;
        }

        client.join(`suggest_user_${employeeId}`);

        console.log(
            `✅ User ${employeeId} connected → joined suggest_user_${employeeId}`,
        );
    }
    // ================= DISCONNECT =================
    handleDisconnect(client: Socket) {
        const employeeId = client.handshake.query.employeeId;
        console.log(`❌ User ${employeeId} disconnected`);
    }
}