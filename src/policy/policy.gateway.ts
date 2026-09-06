// policy.gateway.ts
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
export class PolicyGateway
  implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket) {
    const employeeId = client.handshake.query.employeeId as string;

    if (employeeId) {
      client.join(`user_${employeeId}`);
    }

    console.log('Client connected:', client.id, 'user:', employeeId);
  }

  handleDisconnect(client: Socket) {
    console.log('Client disconnected:', client.id);
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