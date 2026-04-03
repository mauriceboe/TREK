/**
 * WebSocket test client helper.
 *
 * Usage:
 *   import http from 'http';
 *   import { setupWebSocket } from '../../src/websocket';
 *   import { WsTestClient, getWsToken } from '../helpers/ws-client';
 *
 *   let server: http.Server;
 *   let client: WsTestClient;
 *
 *   beforeAll(async () => {
 *     const app = createApp();
 *     server = http.createServer(app);
 *     setupWebSocket(server);
 *     await new Promise<void>(res => server.listen(0, res));
 *   });
 *
 *   afterAll(() => server.close());
 *
 *   it('connects', async () => {
 *     const addr = server.address() as AddressInfo;
 *     const token = await getWsToken(addr.port, userId);
 *     client = new WsTestClient(`ws://localhost:${addr.port}/ws?token=${token}`);
 *     const msg = await client.waitForMessage('welcome');
 *     expect(msg.type).toBe('welcome');
 *   });
 */

import WebSocket from 'ws';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export class WsTestClient {
  private ws: WebSocket;
  private messageQueue: WsMessage[] = [];
  private waiters: Array<{ type: string; resolve: (msg: WsMessage) => void; reject: (err: Error) => void }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage;
        const waiterIdx = this.waiters.findIndex(w => w.type === msg.type || w.type === '*');
        if (waiterIdx >= 0) {
          const waiter = this.waiters.splice(waiterIdx, 1)[0];
          waiter.resolve(msg);
        } else {
          this.messageQueue.push(msg);
        }
      } catch { /* ignore malformed messages */ }
    });
  }

  /** Wait for a message of the given type (or '*' for any). */
  waitForMessage(type: string, timeoutMs = 5000): Promise<WsMessage> {
    // Check if already in queue
    const idx = this.messageQueue.findIndex(m => type === '*' || m.type === type);
    if (idx >= 0) {
      return Promise.resolve(this.messageQueue.splice(idx, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIdx = this.waiters.findIndex(w => w.resolve === resolve);
        if (waiterIdx >= 0) this.waiters.splice(waiterIdx, 1);
        reject(new Error(`Timed out waiting for WS message type="${type}" after ${timeoutMs}ms`));
      }, timeoutMs);

      this.waiters.push({
        type,
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject,
      });
    });
  }

  /** Send a JSON message. */
  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Close the connection. */
  close(): void {
    this.ws.close();
  }

  /** Wait for the connection to be open. */
  waitForOpen(timeoutMs = 3000): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS open timed out')), timeoutMs);
      this.ws.once('open', () => { clearTimeout(timer); resolve(); });
      this.ws.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  /** Wait for the connection to close. */
  waitForClose(timeoutMs = 3000): Promise<number> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve(1000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS close timed out')), timeoutMs);
      this.ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
    });
  }
}
