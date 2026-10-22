import type { LwEvent } from '@lw/contracts';
import type { EventStore } from '@lw/events';
import type { FastifyReply, FastifyRequest } from 'fastify';

const HEARTBEAT_MS = 15_000;

/**
 * Server-Sent Events for one project. Resumes after `Last-Event-ID` (on reconnect) or `?after=`
 * (after a snapshot), replays the gap from the log, then tails live. Each event's SSE `id` is its
 * seq, so the browser's EventSource reconnects from the right place on its own.
 */
export async function streamProject(
  store: EventStore,
  projectId: string,
  req: FastifyRequest<{ Querystring: { after?: string } }>,
  reply: FastifyReply,
  corsOrigin: string | null,
  withCredentials = false,
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
    ...(corsOrigin ? { 'access-control-allow-origin': corsOrigin, vary: 'origin' } : {}),
    ...(withCredentials ? { 'access-control-allow-credentials': 'true' } : {}),
  });
  res.write('retry: 3000\n\n');

  let last = after;
  const send = (e: LwEvent) => {
    if (e.seq <= last) return;
    res.write(`id: ${e.seq}\nevent: lw\ndata: ${JSON.stringify(e)}\n\n`);
    last = e.seq;
  };

  // Subscribe before replaying so nothing appended during the replay is missed.
  let replaying = true;
  const buffered: LwEvent[] = [];
  const unsubscribe = store.subscribe((e) => {
    if (e.projectId !== projectId) return;
    if (replaying) buffered.push(e);
    else send(e);
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.raw.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });

  for (const e of await store.read(projectId, { after })) send(e);
  replaying = false;
  for (const e of buffered) send(e);
}
