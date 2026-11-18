// policy.gateway.ts
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
export class PolicyGateway
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
    // Lifecycle timers được RealtimeAuthService dọn ở sự kiện disconnect.
  }

  notifyNewPolicy(
    policyId: number,
    userIds: number[],
    senderName: string,
  ) {
    userIds.forEach(id => {
      this.server.to(`user_${id}`).emit('notification:new', {
        policyId,
        message: `${senderName} đã gửi yêu cầu duyệt chính sách`,
        createdAt: new Date(),
        isRead: false,
      });
    });
  }
}
