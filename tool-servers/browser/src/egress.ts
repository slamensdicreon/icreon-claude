import { lookup } from 'node:dns/promises';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, isIP, type AddressInfo, type Socket } from 'node:net';
import { isPrivateAddress } from './ssrf';

export interface EgressOptions {
  /** Tests serve fixture sites on 127.0.0.1; production never sets this. */
  allowPrivateNetworks?: boolean;
  /** DNS, replaceable in tests. */
  lookup?: (host: string) => Promise<string[]>;
}

const resolveAll = async (host: string) =>
  (await lookup(host, { all: true })).map((a) => a.address);

/**
 * The one way out for browsers we launch. Chromium and Lighthouse are pointed at this proxy, which
 * resolves every host itself, refuses loopback, private, link-local and metadata addresses, and
 * connects to the address it checked, so a DNS answer can't change between the check and the
 * connection. That covers what in-page routing can't see: subresources on hostnames that resolve
 * privately, and Lighthouse, which drives Chrome over its own protocol.
 */
export class EgressProxy {
  private readonly server = createServer();
  private readonly sockets = new Set<Socket>();
  /** Hosts refused so far, newest last (diagnostics and tests). */
  readonly refused: string[] = [];
  url = '';

  private constructor(private readonly opts: EgressOptions) {
    this.server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) =>
      this.tunnel(req, client, head),
    );
    this.server.on('request', (req, res) => this.forward(req, res));
  }

  static async start(opts: EgressOptions = {}): Promise<EgressProxy> {
    const proxy = new EgressProxy(opts);
    await new Promise<void>((r) => proxy.server.listen(0, '127.0.0.1', r));
    proxy.url = `http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}`;
    return proxy;
  }

  /** Chromium flags that send all traffic, loopback included, through this proxy. */
  chromeFlags(): string[] {
    return [`--proxy-server=${this.url}`, '--proxy-bypass-list=<-loopback>'];
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
  }

  /** The address to connect to, or a refusal if any address the host resolves to is private. */
  private async resolve(host: string): Promise<string> {
    const bare = host.replace(/^\[|\]$/g, '');
    const addresses = isIP(bare) ? [bare] : await (this.opts.lookup ?? resolveAll)(bare);
    if (!addresses.length) throw new Error(`${host} does not resolve`);
    if (!this.opts.allowPrivateNetworks && addresses.some(isPrivateAddress)) {
      this.refused.push(host);
      throw new Error(`${host} resolves to a private address`);
    }
    return addresses[0]!;
  }

  private track(s: Socket) {
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
  }

  /** HTTPS and anything else tunnelled: check the host, then splice the sockets. */
  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer) {
    this.track(client);
    client.on('error', () => client.destroy());
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(req.url ?? '');
    try {
      if (!m) throw new Error('bad authority');
      const ip = await this.resolve(m[1]!);
      const upstream = connect(Number(m[2] ?? 443), ip, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      this.track(upstream);
      upstream.on('error', () => client.destroy());
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  }

  /** Plain HTTP: the request line carries the absolute URL. */
  private async forward(req: IncomingMessage, res: ServerResponse) {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
      if (target.protocol !== 'http:') throw new Error('not http');
    } catch {
      return res.writeHead(400).end();
    }
    try {
      const ip = await this.resolve(target.hostname);
      const upstream = request(
        {
          host: ip,
          port: target.port || 80,
          method: req.method,
          path: target.pathname + target.search,
          headers: { ...req.headers, host: target.host },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
      req.pipe(upstream);
    } catch {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Blocked by egress policy');
    }
  }
}
