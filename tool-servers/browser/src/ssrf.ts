import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * The browser fetches whatever a source site links to, so it must never become a way into our
 * own network. Two rules: navigation only to the project's declared source hosts, and nothing,
 * not even an image, from loopback, private, link-local or metadata addresses.
 */

const PRIVATE_V4: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 carrier-grade NAT
  [0x7f000000, 8], // 127/8
  [0xa9fe0000, 16], // 169.254/16 link-local, cloud metadata
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
];

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
    return PRIVATE_V4.some(([net, bits]) => (n & (~0 << (32 - bits))) >>> 0 === net);
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (
      v.startsWith('fc') ||
      v.startsWith('fd') ||
      v.startsWith('fe8') ||
      v.startsWith('fe9') ||
      v.startsWith('fea') ||
      v.startsWith('feb')
    )
      return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  return false;
}

export class BlockedUrlError extends Error {}

export interface UrlPolicy {
  /** Hostnames the project declared as its source site (and its asset CDNs). */
  allowedHosts: string[];
  /** Tests run a fixture site on 127.0.0.1; production never sets this. */
  allowPrivateNetworks?: boolean;
}

/** Checks a URL the agent asked for: scheme, declared host, and every address it resolves to. */
export async function assertNavigable(raw: string, policy: UrlPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new BlockedUrlError(`scheme ${url.protocol} is not allowed`);
  if (url.username || url.password)
    throw new BlockedUrlError('URLs with credentials are not allowed');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!policy.allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw new BlockedUrlError(
      `${host} is not one of this project's source hosts (the source site, and hosts its Blueprint and inventories point media at)`,
    );
  }
  if (!policy.allowPrivateNetworks) {
    const addresses = isIP(host)
      ? [host]
      : (await lookup(host, { all: true })).map((a) => a.address);
    if (addresses.some(isPrivateAddress))
      throw new BlockedUrlError(`${host} resolves to a private address`);
  }
  return url;
}

/** Cheap per-request check inside the browser: literal private IPs and localhost names. */
export function isBlockedSubresource(raw: string, policy: UrlPolicy): boolean {
  if (policy.allowPrivateNetworks) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.internal') ||
      isPrivateAddress(host)
    );
  } catch {
    return true;
  }
}
