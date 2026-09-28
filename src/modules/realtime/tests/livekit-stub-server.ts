// The local LiveKit Twirp stub (MODULE TEST HELPER, W109) — the
// deterministic double of LiveKit Cloud for transport and
// provider-failure tests: a real HTTP server speaking the Twirp JSON
// wire protocol with recordable answers and a KILL SWITCH (failMode)
// that turns every subsequent call into a provider failure. No external
// network is ever touched.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCall {
  /** The Twirp method (e.g. 'livekit.RoomService/CreateRoom'). */
  method: string;
  body: Record<string, unknown>;
  token: string;
}

export class LivekitStubServer {
  readonly calls: RecordedCall[] = [];
  /** When set, every subsequent call answers with this HTTP failure. */
  failMode: { status: number; body: string } | null = null;
  /** What StartRoomCompositeEgress answers. */
  egressStart: Record<string, unknown> = { egress_id: 'EG_stub_1', status: 'EGRESS_STARTING' };
  /** What StopEgress answers. */
  egressStop: Record<string, unknown> = { egress_id: 'EG_stub_1', status: 'EGRESS_COMPLETE' };
  /** Whether CreateSIPParticipant succeeds. */
  sipParticipant: Record<string, unknown> | { status: number; body: string } = {
    participant_id: 'PA_sip_1',
  };
  /** When set, CreateRoom answers without a usable room handle. */
  breakCreateRoom = false;

  private server: Server | null = null;
  private base: string = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const method = (req.url ?? '').replace(/^\/twirp\//, '');
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = rawBody === '' ? {} : (JSON.parse(rawBody) as Record<string, unknown>);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'invalid_argument', msg: 'bad json' }));
          return;
        }
        this.calls.push({ method, body, token: req.headers.authorization ?? '' });

        if (this.failMode !== null) {
          res.writeHead(this.failMode.status, { 'content-type': 'application/json' });
          res.end(this.failMode.body);
          return;
        }

        const json = (payload: unknown) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        switch (method) {
          case 'livekit.RoomService/CreateRoom':
            if (this.breakCreateRoom) {
              json({ sid: '', name: '' });
              return;
            }
            json({ sid: 'RM_stub_sid', name: String(body.name ?? ''), creation_time: '1790000000' });
            return;
          case 'livekit.RoomService/DeleteRoom':
            json({});
            return;
          case 'livekit.RoomService/SendData':
            json({});
            return;
          case 'livekit.Egress/StartRoomCompositeEgress':
            json(this.egressStart);
            return;
          case 'livekit.Egress/StopEgress':
            json(this.egressStop);
            return;
          case 'livekit.Egress/ListEgress':
            json({ items: [{ egress_id: 'EG_stub_recovered', status: 'EGRESS_ACTIVE' }] });
            return;
          case 'livekit.SIP/CreateSIPParticipant':
            if ('status' in this.sipParticipant) {
              const failure = this.sipParticipant as { status: number; body: string };
              res.writeHead(failure.status, { 'content-type': 'application/json' });
              res.end(failure.body);
              return;
            }
            json(this.sipParticipant);
            return;
          default:
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ code: 'bad_route', msg: `no handler for ${method}` }));
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server!.address() as AddressInfo;
    this.base = `http://127.0.0.1:${address.port}`;
  }

  /** The project URL the transport derives its Twirp base from. */
  get url(): string {
    return this.base;
  }

  async close(): Promise<void> {
    if (this.server !== null) await new Promise((resolve) => this.server!.close(resolve));
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  last(method: string): RecordedCall {
    const call = this.callsOf(method).at(-1);
    if (call === undefined) throw new Error(`no stub call recorded for ${method}`);
    return call;
  }

  /** The provider dies: every subsequent call fails with this shape. */
  kill(status = 500, body = JSON.stringify({ code: 'internal', msg: 'provider died' })): void {
    this.failMode = { status, body };
  }

  revive(): void {
    this.failMode = null;
  }
}

export async function startLivekitStub(): Promise<LivekitStubServer> {
  const stub = new LivekitStubServer();
  await stub.start();
  return stub;
}
