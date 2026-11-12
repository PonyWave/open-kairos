import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentTool, ToolExecutionResult } from '@kairos/agent-core';
import { describe, expect, it } from 'vitest';
import { createWebTools, WebSearchQuota, type WebToolOptions } from './web.js';

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

interface Fixture {
  port: number;
  requests: CapturedRequest[];
}

async function execute<T>(
  tool: AgentTool<T>,
  argumentsValue: Record<string, unknown>,
  signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  const validated = await tool.validate(argumentsValue);
  const result = await tool.execute(validated, {
    call: { id: 'call-web', name: tool.name, arguments: argumentsValue },
    signal,
  });
  return typeof result === 'string' ? { content: result } : result;
}

function parsed(result: ToolExecutionResult) {
  return JSON.parse(result.content) as Record<string, unknown>;
}

function loopbackLookup(hostname: string) {
  expect(['fixture.test', 'search.test', 'brave.test']).toContain(hostname);
  return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
}

async function withFixture(
  handler: (request: import('node:http').IncomingMessage, response: ServerResponse) => void,
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    await run({ port: address.port, requests });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function fixtureOptions(port: number, overrides: Partial<WebToolOptions> = {}): WebToolOptions {
  void port;
  return {
    lookup: loopbackLookup,
    allowedPrivateAddresses: ['127.0.0.1'],
    ...overrides,
  };
}

const articleHtml = `<!doctype html>
<html><head><title>Example &amp; Title</title></head><body>
<nav>Navigation text</nav>
<article><h1>Example article</h1><p>First&nbsp;paragraph.</p>
<p>Second paragraph with <strong>markup</strong> and enough readable article text.</p>
<script>secretScript()</script></article></body></html>`;

describe('web_fetch', () => {
  it('fetches a static HTML page with GET and no credentials or custom headers', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(articleHtml);
      },
      async (fixture) => {
        const [fetchTool] = createWebTools(fixtureOptions(fixture.port));
        const result = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/article?x=1#fragment`,
        });
        expect(result.status).not.toBe('error');
        expect(parsed(result)).toMatchObject({
          final_url: `http://fixture.test:${fixture.port}/article?x=1`,
          status: 200,
          content_type: 'text/html',
          title: 'Example & Title',
          truncated: false,
        });
        expect(parsed(result).text).toContain('First paragraph.');
        expect(parsed(result).text).toContain('Second paragraph with markup');
        expect(parsed(result).text).not.toContain('secretScript');
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).toMatchObject({ method: 'GET', url: '/article?x=1' });
        expect(fixture.requests[0]?.headers.cookie).toBeUndefined();
        expect(fixture.requests[0]?.headers.authorization).toBeUndefined();
        expect(fixture.requests[0]?.headers['x-custom-header']).toBeUndefined();
      },
    );
  });

  it('rechecks DNS on a successful redirect and returns the final URL', async () => {
    await withFixture(
      (request, response) => {
        if (request.url === '/start') {
          response.writeHead(302, { location: '/article' });
          response.end();
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(articleHtml);
      },
      async (fixture) => {
        const hosts: string[] = [];
        const [fetchTool] = createWebTools(
          fixtureOptions(fixture.port, {
            lookup: (hostname) => {
              hosts.push(hostname);
              return loopbackLookup(hostname);
            },
          }),
        );
        const result = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/start`,
        });
        expect(parsed(result)).toMatchObject({
          final_url: `http://fixture.test:${fixture.port}/article`,
          status: 200,
        });
        expect(hosts).toEqual(['fixture.test', 'fixture.test']);
        expect(fixture.requests.map((request) => request.url)).toEqual(['/start', '/article']);
      },
    );
  });

  it('blocks a redirect to cloud metadata before connecting to the target', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        response.end();
      },
      async (fixture) => {
        const [fetchTool] = createWebTools(fixtureOptions(fixture.port));
        const result = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/start`,
        });
        expect(result.status).toBe('error');
        expect(parsed(result).error).toMatchObject({ code: 'blocked_address' });
        expect(fixture.requests).toHaveLength(1);
      },
    );
  });

  it.each([
    'http://127.0.0.1/resource',
    'http://10.0.0.8/resource',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/resource',
    'http://[::ffff:127.0.0.1]/resource',
    'http://[::127.0.0.1]/resource',
    'http://[::7f00:1]/resource',
    'http://[::a00:1]/resource',
    'http://[::a9fe:a9fe]/resource',
  ])('rejects a non-public initial address without fixture access: %s', async (url) => {
    const [fetchTool] = createWebTools({ fetch: { timeoutMs: 20 } });
    const result = await execute(fetchTool, { url });
    expect(result.status).toBe('error');
    expect(parsed(result).error).toMatchObject({ code: 'blocked_address' });
  });

  it('normalizes an explicitly allowed mapped fixture address before connecting', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('mapped');
      },
      async (fixture) => {
        const [fetchTool] = createWebTools({ allowedPrivateAddresses: ['127.0.0.1'] });
        const result = await execute(fetchTool, {
          url: `http://[::ffff:127.0.0.1]:${fixture.port}/mapped`,
        });
        expect(result.status).not.toBe('error');
        expect(parsed(result).text).toBe('mapped');
        expect(fixture.requests).toHaveLength(1);
      },
    );
  });

  it('rejects a hostname when any DNS answer is non-public', async () => {
    const [fetchTool] = createWebTools({
      lookup: () =>
        Promise.resolve([
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]),
    });
    const result = await execute(fetchTool, { url: 'http://mixed.example/' });
    expect(result.status).toBe('error');
    expect(parsed(result).error).toMatchObject({ code: 'blocked_address' });
  });

  it.each(['::7f00:1', '::a00:1', '::a9fe:a9fe'])(
    'rejects an IPv4-compatible address returned by DNS: %s',
    async (address) => {
      const [fetchTool] = createWebTools({
        fetch: { timeoutMs: 20 },
        lookup: () => Promise.resolve([{ address, family: 6 }]),
      });
      const result = await execute(fetchTool, { url: 'http://compatible-dns.example/' });
      expect(result.status).toBe('error');
      expect(parsed(result).error).toMatchObject({ code: 'blocked_address' });
    },
  );

  it('rejects a redirect to an IPv4-compatible metadata address', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(302, { location: 'http://[::a9fe:a9fe]/latest/meta-data' });
        response.end();
      },
      async (fixture) => {
        const [fetchTool] = createWebTools(
          fixtureOptions(fixture.port, { fetch: { timeoutMs: 20 } }),
        );
        const result = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/start`,
        });
        expect(result.status).toBe('error');
        expect(parsed(result).error).toMatchObject({ code: 'blocked_address' });
        expect(fixture.requests).toHaveLength(1);
      },
    );
  });

  it('preserves a global IPv6 DNS answer while using the explicit local fixture', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('global-ipv6-accepted');
      },
      async (fixture) => {
        const [fetchTool] = createWebTools(
          fixtureOptions(fixture.port, {
            lookup: () =>
              Promise.resolve([
                { address: '127.0.0.1', family: 4 },
                { address: '2001:4860:4860::8888', family: 6 },
              ]),
          }),
        );
        const result = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/`,
        });
        expect(result.status).not.toBe('error');
        expect(parsed(result).text).toBe('global-ipv6-accepted');
      },
    );
  });

  it.each([
    ['not-a-url', 'invalid_url'],
    ['file:///tmp/example', 'unsupported_protocol'],
    ['https://user:password@example.com/', 'credentials_not_allowed'],
  ])('distinguishes invalid URL policy errors', async (url, code) => {
    const [fetchTool] = createWebTools();
    const result = await execute(fetchTool, { url });
    expect(result.status).toBe('error');
    expect(parsed(result).error).toMatchObject({ code });
    expect(result.content).not.toContain('password');
  });

  it('returns a structured timeout error', async () => {
    await withFixture(
      () => undefined,
      async (fixture) => {
        const [fetchTool] = createWebTools(
          fixtureOptions(fixture.port, { fetch: { timeoutMs: 50 } }),
        );
        const result = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/slow`,
        });
        expect(result.status).toBe('error');
        expect(parsed(result).error).toMatchObject({ code: 'timeout' });
      },
    );
  });

  it('enforces the total deadline while DNS is still pending', async () => {
    const [fetchTool] = createWebTools({
      fetch: { timeoutMs: 20 },
      lookup: () => new Promise<never>(() => undefined),
    });
    const result = await execute(fetchTool, { url: 'http://pending-dns.example/' });
    expect(result.status).toBe('error');
    expect(parsed(result).error).toMatchObject({ code: 'timeout' });
  });

  it('aborts an in-flight request when the Run is cancelled', async () => {
    await withFixture(
      () => undefined,
      async (fixture) => {
        const [fetchTool] = createWebTools(fixtureOptions(fixture.port));
        const controller = new AbortController();
        const running = execute(
          fetchTool,
          { url: `http://fixture.test:${fixture.port}/slow` },
          controller.signal,
        );
        controller.abort(new DOMException('Run cancelled.', 'AbortError'));
        await expect(running).rejects.toMatchObject({ name: 'AbortError' });
      },
    );
  });

  it('truncates response bytes and extracted text to independent limits', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('1234567890');
      },
      async (fixture) => {
        const [fetchTool] = createWebTools(
          fixtureOptions(fixture.port, {
            fetch: { maxResponseBytes: 6, maxTextCharacters: 5 },
          }),
        );
        const result = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/large`,
        });
        expect(parsed(result)).toMatchObject({ text: '12345', truncated: true });
      },
    );
  });

  it('extracts available HTML text after reaching the raw byte limit', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          `<html><head><title>Large</title></head><body><article><h1>Large article</h1><p>Beginning readable text ${'x'.repeat(2000)}</p></article></body></html>`,
        );
      },
      async (fixture) => {
        const [fetchTool] = createWebTools(
          fixtureOptions(fixture.port, {
            fetch: { maxResponseBytes: 256, maxTextCharacters: 1000 },
          }),
        );
        const result = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/large-html`,
        });
        expect(result.status).not.toBe('error');
        expect(parsed(result)).toMatchObject({ truncated: true });
        expect(parsed(result).text).toContain('Beginning readable text');
      },
    );
  });

  it('distinguishes HTTP and unsupported content failures', async () => {
    await withFixture(
      (request, response) => {
        if (request.url === '/unauthorized') {
          response.writeHead(401, { 'content-type': 'text/plain' });
          response.end('do not expose this response body');
          return;
        }
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end('not an image');
      },
      async (fixture) => {
        const [fetchTool] = createWebTools(fixtureOptions(fixture.port));
        const unauthorized = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/unauthorized`,
        });
        expect(unauthorized.status).toBe('error');
        expect(parsed(unauthorized).error).toMatchObject({ code: 'http_error', status: 401 });
        expect(unauthorized.content).not.toContain('do not expose');
        const binary = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/binary`,
        });
        expect(parsed(binary).error).toMatchObject({ code: 'unsupported_content_type' });
      },
    );
  });

  it('keeps web_fetch available when search is not configured', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('available');
      },
      async (fixture) => {
        const [fetchTool, searchTool] = createWebTools(fixtureOptions(fixture.port));
        const search = await execute(searchTool, { query: 'anything' });
        expect(search.status).toBe('error');
        expect(parsed(search).error).toMatchObject({ code: 'search_not_configured' });
        const fetched = await execute(fetchTool, {
          url: `http://fixture.test:${fixture.port}/`,
        });
        expect(fetched.status).not.toBe('error');
        expect(parsed(fetched).text).toBe('available');
      },
    );
  });
});

describe('web_search', () => {
  it('assembles a real SearXNG request with only the query and returns bounded results', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(
          JSON.stringify({
            results: [
              {
                title: 'First result',
                url: 'https://example.com/first#fragment',
                content: 'First snippet',
                publishedDate: '2026-11-01',
              },
              {
                title: 'Second result',
                url: 'https://example.org/second',
                content: 'Second snippet',
              },
              {
                title: 'Third result outside the requested limit',
                url: 'https://example.net/third',
              },
            ],
          }),
        );
      },
      async (fixture) => {
        const [, searchTool] = createWebTools({
          lookup: loopbackLookup,
          search: {
            provider: 'searxng',
            baseUrl: `http://search.test:${fixture.port}/search`,
          },
        });
        const result = await execute(searchTool, { query: 'kairos private query', limit: 2 });
        expect(result.status).not.toBe('error');
        expect(parsed(result)).toMatchObject({
          query: 'kairos private query',
          results: [
            {
              title: 'First result',
              url: 'https://example.com/first',
              snippet: 'First snippet',
              site: 'example.com',
              date: '2026-11-01',
            },
            {
              title: 'Second result',
              url: 'https://example.org/second',
              snippet: 'Second snippet',
              site: 'example.org',
              date: null,
            },
          ],
        });
        expect(parsed(result).results).toHaveLength(2);
        const request = fixture.requests[0];
        expect(request?.method).toBe('GET');
        const url = new URL(request?.url ?? '', 'http://search.test');
        expect(Object.fromEntries(url.searchParams)).toEqual({
          q: 'kairos private query',
          format: 'json',
        });
        expect(request?.headers.authorization).toBeUndefined();
        expect(request?.headers.cookie).toBeUndefined();
        expect(request?.headers['x-subscription-token']).toBeUndefined();
        expect(JSON.stringify(request)).not.toContain('Thread');
        expect(JSON.stringify(request)).not.toContain('Context');
      },
    );
  });

  it('assembles Brave authentication without returning or forwarding unrelated data', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            web: {
              results: [
                {
                  title: 'Brave result',
                  url: 'https://example.com/brave',
                  description: 'Brave snippet',
                  page_age: '2026-11-06',
                },
              ],
            },
          }),
        );
      },
      async (fixture) => {
        const [, searchTool] = createWebTools({
          lookup: loopbackLookup,
          search: {
            provider: 'brave',
            baseUrl: `http://brave.test:${fixture.port}/res/v1/web/search`,
            apiKey: 'secret-brave-key',
          },
        });
        const result = await execute(searchTool, { query: 'needle', limit: 1 });
        expect(parsed(result).results).toEqual([
          {
            title: 'Brave result',
            url: 'https://example.com/brave',
            snippet: 'Brave snippet',
            site: 'example.com',
            date: '2026-11-06',
          },
        ]);
        expect(result.content).not.toContain('secret-brave-key');
        const request = fixture.requests[0];
        expect(request?.headers['x-subscription-token']).toBe('secret-brave-key');
        expect(request?.headers.authorization).toBeUndefined();
        expect(request?.headers.cookie).toBeUndefined();
        const url = new URL(request?.url ?? '', 'http://brave.test');
        expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'needle', count: '1' });
      },
    );
  });

  it.each([
    [401, 'search_unauthorized'],
    [429, 'search_rate_limited'],
  ])('distinguishes provider HTTP %i failures', async (status, code) => {
    await withFixture(
      (_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ secret: 'provider response must not be returned' }));
      },
      async (fixture) => {
        const [, searchTool] = createWebTools({
          lookup: loopbackLookup,
          search: {
            provider: 'searxng',
            baseUrl: `http://search.test:${fixture.port}/search`,
          },
        });
        const result = await execute(searchTool, { query: 'failure' });
        expect(result.status).toBe('error');
        expect(parsed(result).error).toMatchObject({ code, status });
        expect(result.content).not.toContain('provider response');
      },
    );
  });

  it('returns an empty result list without treating it as an error', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"results":[]}');
      },
      async (fixture) => {
        const [, searchTool] = createWebTools({
          lookup: loopbackLookup,
          search: {
            provider: 'searxng',
            baseUrl: `http://search.test:${fixture.port}/search`,
          },
        });
        const result = await execute(searchTool, { query: 'empty' });
        expect(result.status).not.toBe('error');
        expect(parsed(result)).toEqual({ query: 'empty', results: [] });
      },
    );
  });

  it('applies the shared local quota before sending another provider request', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"results":[]}');
      },
      async (fixture) => {
        let now = 100_000;
        const [, searchTool] = createWebTools({
          lookup: loopbackLookup,
          now: () => now,
          searchLimits: { maxRequestsPerMinute: 1 },
          search: {
            provider: 'searxng',
            baseUrl: `http://search.test:${fixture.port}/search`,
          },
        });
        expect((await execute(searchTool, { query: 'first' })).status).not.toBe('error');
        const limited = await execute(searchTool, { query: 'second' });
        expect(limited.status).toBe('error');
        expect(parsed(limited).error).toMatchObject({ code: 'search_quota_exceeded' });
        expect(fixture.requests).toHaveLength(1);
        now += 60_000;
        expect((await execute(searchTool, { query: 'third' })).status).not.toBe('error');
        expect(fixture.requests).toHaveLength(2);
      },
    );
  });

  it('isolates shared search quota by owner scope', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"results":[]}');
      },
      async (fixture) => {
        const searchQuota = new WebSearchQuota(1, () => 100_000);
        const search = {
          provider: 'searxng' as const,
          baseUrl: `http://search.test:${fixture.port}/search`,
        };
        const [, ownerA] = createWebTools({
          lookup: loopbackLookup,
          search,
          searchQuota,
          quotaKey: 'owner-a',
        });
        const [, ownerB] = createWebTools({
          lookup: loopbackLookup,
          search,
          searchQuota,
          quotaKey: 'owner-b',
        });
        expect((await execute(ownerA, { query: 'a-first' })).status).not.toBe('error');
        expect((await execute(ownerB, { query: 'b-first' })).status).not.toBe('error');
        const limited = await execute(ownerA, { query: 'a-second' });
        expect(limited.status).toBe('error');
        expect(parsed(limited).error).toMatchObject({ code: 'search_quota_exceeded' });
        expect(fixture.requests).toHaveLength(2);
      },
    );
  });

  it('enforces the provider response byte limit', async () => {
    await withFixture(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ results: [], padding: 'x'.repeat(100) }));
      },
      async (fixture) => {
        const [, searchTool] = createWebTools({
          lookup: loopbackLookup,
          searchLimits: { maxResponseBytes: 16 },
          search: {
            provider: 'searxng',
            baseUrl: `http://search.test:${fixture.port}/search`,
          },
        });
        const result = await execute(searchTool, { query: 'large' });
        expect(result.status).toBe('error');
        expect(parsed(result).error).toMatchObject({ code: 'response_too_large' });
      },
    );
  });

  it('returns a provider timeout error', async () => {
    await withFixture(
      () => undefined,
      async (fixture) => {
        const [, searchTool] = createWebTools({
          lookup: loopbackLookup,
          searchLimits: { timeoutMs: 50 },
          search: {
            provider: 'searxng',
            baseUrl: `http://search.test:${fixture.port}/search`,
          },
        });
        const result = await execute(searchTool, { query: 'timeout' });
        expect(result.status).toBe('error');
        expect(parsed(result).error).toMatchObject({ code: 'timeout' });
      },
    );
  });

  it('cancels an in-flight provider request', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    await withFixture(
      () => markStarted(),
      async (fixture) => {
        const [, searchTool] = createWebTools({
          lookup: loopbackLookup,
          search: {
            provider: 'searxng',
            baseUrl: `http://search.test:${fixture.port}/search`,
          },
        });
        const controller = new AbortController();
        const running = execute(searchTool, { query: 'cancel' }, controller.signal);
        await started;
        controller.abort(new DOMException('Run cancelled.', 'AbortError'));
        await expect(running).rejects.toMatchObject({ name: 'AbortError' });
      },
    );
  });
});
