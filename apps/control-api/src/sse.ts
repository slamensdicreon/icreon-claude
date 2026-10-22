import type { LwEvent } from '@lw/contracts';
import type { EventStore } from '@lw/events';
import type { FastifyReply, FastifyRequest } from 'fastify';

const HEARTBEAT_MS = 15_000;

export interface StreamOptions {
  corsOrigin: string | null;
  withCredentials: boolean;
  /**
   * How often to read the log for new events, besides the store's live tail. The read is what
   * keeps a stream current where the tail can't be relied on (a request-driven instance without
   * LISTEN); where it can, the read only ever finds nothing new.
   */
  pollMs: number;
  /**
   * End the stream after this long with a `bye` event, so it closes cleanly before a platform
   * time limit cuts it. The client reopens at once from the last seq it saw. Null: no limit.
   */
  maxMs: number | null;
}

/**
 * Server-Sent Events for one project. Resumes after `Last-Event-ID` (on reconnect) or `?after=`
 * (after a snapshot), replays the gap from the log, then tails live. Each event's SSE `id` is its
 * seq, so the browser's EventSource reconnects from the right place on its own.
 *
 * Two control events besides `lw`:
 * - `bye`: the server is closing this stream on schedule; reopen from the last seq.
 * - `reset`: the log was reseeded below the client's seq (a demo project restarted); refetch the
 *   snapshots and reopen after `head`.
 */
export async function streamProject(
  store: EventStore,
  projectId: string,
  req: FastifyRequest<{ Querystring: { after?: string } }>,
  reply: FastifyReply,
  opts: StreamOptions,
): Promise<void> {
  const header = req.headers['last-event-id'];
  const after = Number((Array.isArray(header) ? header[0] : header) ?? req.query.after ?? 0) || 0;

  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...(opts.corsOrigin ? { 'access-control-allow-origin': opts.corsOrigin, vary: 'origin' } : {}),
    ...(opts.withCredentials ? { 'access-control-allow-credentials': 'true' } : {}),
  });
  res.write('retry: 3000\n\n');

  let last = after;
  let closed = false;
  const timers: Record<'beat' | 'poll' | 'bye', NodeJS.Timeout | undefined> = {
    beat: undefined,
    poll: undefined,
    bye: undefined,
  };
  let unsubscribe = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const t of Object.values(timers)) clearTimeout(t);
    res.end();
  };
  req.raw.on('close', close);

  const send = (e: LwEvent) => {
    res.write(`id: ${e.seq}\nevent: lw\ndata: ${JSON.stringify(e)}\n\n`);
    last = e.seq;
  };

  // One read at a time; the live tail and the timer both just ask for one.
  let reading: Promise<void> | null = null;
  let again = false;
  const read = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        const head = await store.head(projectId);
        if (closed) return;
        if (head < last) {
          res.write(`event: reset\ndata: ${JSON.stringify({ head })}\n\n`);
          close();
          return;
        }
        if (head > last) {
          for (const e of await store.read(projectId, { after: last })) if (!closed) send(e);
        }
      } while (again && !closed);
    })().finally(() => (reading = null));
    return reading;
  };

  unsubscribe = store.subscribe((e) => {
    if (e.projectId !== projectId || e.seq <= last) return;
    // In order and next: send it. Ahead of a gap: read the gap from the log.
    if (e.seq === last + 1 && !reading) send(e);
    else void read().catch(() => close());
  });

  const heartbeat = () => {
    if (closed) return;
    res.write(': ping\n\n');
    timers.beat = setTimeout(heartbeat, HEARTBEAT_MS);
  };
  timers.beat = setTimeout(heartbeat, HEARTBEAT_MS);

  const poll = () => {
    if (closed) return;
    void read()
      .catch(() => close())
      .finally(() => {
        if (!closed) timers.poll = setTimeout(poll, opts.pollMs);
      });
  };
  poll();

  if (opts.maxMs !== null) {
    timers.bye = setTimeout(() => {
      res.write('event: bye\ndata: {}\n\n');
      close();
    }, opts.maxMs);
  }
}
