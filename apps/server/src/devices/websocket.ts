import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import type { DeviceChannel } from './channel.js';

export function registerDeviceWebSocket(
  server: FastifyInstance,
  channel: DeviceChannel,
  path = '/devices/wss',
): WebSocketServer {
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: channel.maxMessageBytes + 1024,
  });
  const onUpgrade: Parameters<typeof server.server.on>[1] = (request, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== path) return;
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request);
      channel.handleConnection(webSocket);
    });
  };
  server.server.on('upgrade', onUpgrade);
  server.addHook('preClose', async () => {
    server.server.off('upgrade', onUpgrade);
    channel.close();
    for (const client of webSockets.clients) client.terminate();
  });
  server.addHook('onClose', async () => {
    await new Promise<void>((resolve, reject) => {
      webSockets.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  return webSockets;
}
