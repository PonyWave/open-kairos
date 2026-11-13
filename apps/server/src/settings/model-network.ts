import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { SessionError } from '../sessions/errors.js';

export function validateModelUrl(value: string, allowedOrigins: readonly string[] = []): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SessionError('invalid_argument', '基础 URL 格式无效。');
  }
  if (
    url.username ||
    url.password ||
    url.href.includes('?') ||
    url.href.includes('#') ||
    value.length > 2048 ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && allowedOrigins.includes(url.origin)))
  ) {
    throw new SessionError(
      'invalid_argument',
      '基础 URL 须使用 HTTPS，不能包含凭据、查询参数或片段；内网 HTTP 须由部署者放行。',
    );
  }
  for (const path of ['/chat/completions', '/responses', '/v1/messages']) {
    if (url.pathname.endsWith(path))
      throw new SessionError('invalid_argument', `请填写基础 URL，移除末尾的 ${path}。`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function modelAddressAllowed(address: string, privateOrigin: boolean): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && ipaddr.IPv6.isValid(address)) {
    const ipv6 = ipaddr.IPv6.parse(address);
    if (ipv6.isIPv4MappedAddress())
      return modelAddressAllowed(ipv6.toIPv4Address().toString(), privateOrigin);
    if (
      ipv6
        .toByteArray()
        .slice(0, 12)
        .every((byte) => byte === 0)
    )
      return false;
  }
  const range = parsed.range();
  return (
    range === 'unicast' || (privateOrigin && ['private', 'loopback', 'uniqueLocal'].includes(range))
  );
}

// DNS is checked for every request and the socket is pinned to the checked address.
// Redirects are refused so credentials cannot be forwarded to a different service.
export function modelFetch(allowedOrigins: readonly string[] = []): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const privateOrigin = allowedOrigins.includes(url.origin);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateOrigin))
      throw new SessionError('permission_denied', '模型连接协议未获允许。');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await resolveAddresses(hostname, init?.signal ?? undefined);
    init?.signal?.throwIfAborted();
    if (
      !addresses.length ||
      addresses.some(({ address }) => !modelAddressAllowed(address, privateOrigin))
    )
      throw new SessionError('permission_denied', '模型地址包含未获允许的网络目标。');
    const address = addresses[0];
    if (!address) throw new SessionError('failed_precondition', '模型地址无法解析。');
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    if (init?.body !== undefined && typeof init.body !== 'string')
      throw new SessionError('invalid_argument', '模型请求正文无效。');
    const method = init?.body === undefined ? 'GET' : 'POST';
    const body = init?.body;
    return new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(
        url,
        {
          method,
          headers,
          signal: init?.signal ?? undefined,
          lookup: (_hostname, options, callback) => {
            if (options.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
          ...(url.protocol === 'https:' ? { servername: hostname } : {}),
        },
        (incoming) => {
          const status = incoming.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            incoming.destroy();
            reject(
              new SessionError(
                'failed_precondition',
                '模型服务返回重定向，请直接填写最终基础 URL。',
              ),
            );
            return;
          }
          if (status < 200 || status > 599) {
            incoming.destroy();
            reject(new SessionError('failed_precondition', '模型服务返回无效 HTTP 状态。'));
            return;
          }
          if (status === 204 || status === 205) {
            incoming.resume();
            resolve(new Response(null, { status }));
            return;
          }
          let size = 0;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              incoming.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > 32 * 1024 * 1024) incoming.destroy(new Error('模型响应超过大小限制。'));
                else controller.enqueue(new Uint8Array(chunk));
              });
              incoming.once('end', () => controller.close());
              incoming.once('error', (error: Error) => controller.error(error));
            },
            cancel() {
              incoming.destroy();
            },
          });
          resolve(
            new Response(stream, {
              status,
              headers: { 'content-type': String(incoming.headers['content-type'] ?? '') },
            }),
          );
        },
      );
      request.once('error', () =>
        reject(new SessionError('failed_precondition', '模型服务连接失败，请核对地址或稍后重试。')),
      );
      request.end(body ?? undefined);
    });
  };
}

async function resolveAddresses(hostname: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return lookup(hostname, { all: true, verbatim: true });
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([lookup(hostname, { all: true, verbatim: true }), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
