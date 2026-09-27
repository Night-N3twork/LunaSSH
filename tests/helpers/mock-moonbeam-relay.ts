/**
 * MockMoonbeamRelay — minimal relay mock for MoonbeamTransport tests.
 *
 * Simulates MoonbeamRelay.attach() returning a MessagePort that speaks
 * raw Wisp packets. No upstream WispClient — just echoes CONNECT with
 * CONTINUE, and handles DATA/CLOSE locally.
 */

import { encodePacket, decodePacket, encodeContinue, encodeClose, decodeConnect } from '@nightnetwork/moonbeam';
import { PACKET_TYPE, CLOSE_REASON, RESERVED_STREAM_ID } from '@nightnetwork/moonbeam';

export class MockMoonbeamRelay {
  readonly attachments: { port: MessagePort; remotePort: MessagePort; label?: string }[] = [];
  private closed = false;

  attach(metadata: { label?: string } = {}): MessagePort {
    if (this.closed) throw new Error('MockMoonbeamRelay: relay is closed');
    const channel = new MessageChannel();
    const clientPort = channel.port2; // returned to the transport (client side)
    const relayPort = channel.port1;  // held by the relay (server side simulation)

    this.attachments.push({ port: relayPort, remotePort: clientPort, label: metadata.label });

    // Simulate relay handshake: immediate CONTINUE on stream 0 with 0 credit
    const handshakePkt = encodePacket(PACKET_TYPE.CONTINUE, RESERVED_STREAM_ID, encodeContinue(0));
    // Post via the client-visible port's remote end? Actually relayPort is where client messages arrive,
    // and clientPort is what the client receives. MoonbeamRelay does: port.postMessage(handshake.buffer, [handshake.buffer])
    // where port is channel.port1 and returned port is channel.port2. So we simulate via clientPort.
    // But MessageChannel is symmetric: relayPort postMessage -> clientPort onmessage, and vice versa.
    // So we post from relayPort to reach clientPort.
    // However our channel setup above has relayPort=port1, clientPort=port2.
    // Check MoonbeamRelay: state.port = channel.port1 (listens), return channel.port2 (client).
    // And it does state.port.postMessage(handshake) where state.port is port1 -> goes to port2 (client).
    // So we should post from relayPort.

    // Delay a tick to allow client to set onmessage before we send handshake
    setTimeout(() => {
      relayPort.postMessage(handshakePkt.buffer as ArrayBuffer, [handshakePkt.buffer as ArrayBuffer]);
    }, 0);

    // Handle client -> relay messages
    relayPort.onmessage = (ev: MessageEvent) => {
      const buf = ev.data instanceof Uint8Array ? ev.data : new Uint8Array(ev.data as ArrayBuffer);
      const pkt = decodePacket(buf);
      if (!pkt) return;
      switch (pkt.type) {
        case PACKET_TYPE.CONNECT: {
          const conn = decodeConnect(pkt.payload);
          if (!conn) {
            const close = encodePacket(PACKET_TYPE.CLOSE, pkt.streamId, encodeClose(CLOSE_REASON.STREAM_INVALID_INFO));
            relayPort.postMessage(close.buffer as ArrayBuffer, [close.buffer as ArrayBuffer]);
            return;
          }
          // Success: send CONTINUE granting 256 credits for this stream
          const cont = encodePacket(PACKET_TYPE.CONTINUE, pkt.streamId, encodeContinue(256));
          relayPort.postMessage(cont.buffer as ArrayBuffer, [cont.buffer as ArrayBuffer]);
          break;
        }
        case PACKET_TYPE.DATA: {
          // Echo data back prefixed with "echo:" for test verification, or just echo
          const echo = encodePacket(PACKET_TYPE.DATA, pkt.streamId, pkt.payload);
          relayPort.postMessage(echo.buffer as ArrayBuffer, [echo.buffer as ArrayBuffer]);
          // Also send a CONTINUE to replenish credits (simulate relay credit flow)
          // Keep it simple: grant 256 again
          const cont = encodePacket(PACKET_TYPE.CONTINUE, pkt.streamId, encodeContinue(256));
          // small delay to avoid interleaving issues
          setTimeout(() => relayPort.postMessage(cont.buffer as ArrayBuffer, [cont.buffer as ArrayBuffer]), 1);
          break;
        }
        case PACKET_TYPE.CLOSE: {
          const close = encodePacket(PACKET_TYPE.CLOSE, pkt.streamId, encodeClose(pkt.payload[0] ?? CLOSE_REASON.VOLUNTARY));
          relayPort.postMessage(close.buffer as ArrayBuffer, [close.buffer as ArrayBuffer]);
          break;
        }
        default:
          break;
      }
    };
    try { relayPort.start(); } catch {}
    try { clientPort.start(); } catch {}

    return clientPort;
  }

  detach(port: MessagePort) {
    const idx = this.attachments.findIndex(a => a.remotePort === port);
    if (idx >= 0) {
      try { this.attachments[idx].port.close(); } catch {}
      try { this.attachments[idx].remotePort.close(); } catch {}
      this.attachments.splice(idx, 1);
    }
  }

  get clientCount() { return this.attachments.length; }

  async close() {
    this.closed = true;
    for (const a of [...this.attachments]) {
      try { a.port.close(); } catch {}
      try { a.remotePort.close(); } catch {}
    }
    this.attachments.length = 0;
  }
}

/**
 * Totally broken relay for failure tests — attach throws or returns non-MessagePort
 */
export class FailingRelay {
  attach() { throw new Error('attach failed'); }
}
