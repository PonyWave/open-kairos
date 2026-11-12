import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ToolExecutionResult } from '@kairos/agent-core';
import { type Browser, chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import {
  type BrowserDriverContext,
  type BrowserDriverLocator,
  type BrowserDriverPage,
  type BrowserDriverProcess,
  type BrowserLaunchOptions,
  BrowserRuntime,
  browserOptionsFromEnvironment,
} from './browser.js';

function deferred() {
  let resolve = () => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakePage implements BrowserDriverPage {
  readonly mouse = {
    move: async (x: number, y: number) => {
      this.moves.push([x, y]);
    },
    wheel: async (deltaX: number, deltaY: number) => {
      this.wheels.push([deltaX, deltaY]);
    },
  };
  readonly values = new Map<string, string>();
  readonly clicks: string[] = [];
  readonly wheels: Array<[number, number]> = [];
  readonly moves: Array<[number, number]> = [];
  readonly waits: number[] = [];
  readonly block = deferred();
  snapshot = '- document';
  titleValue = 'Fake page';
  status = 200;
  closed = false;
  private currentUrl = 'about:blank';
  private readonly closeListeners = new Set<() => void>();

  constructor(readonly context: FakeContext) {
    void this.block.promise.catch(() => {});
  }

  on(event: 'close', listener: () => void): void {
    if (event === 'close') this.closeListeners.add(listener);
  }

  isClosed(): boolean {
    return this.closed;
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.titleValue;
  }

  locator(selector: string): BrowserDriverLocator {
    return new FakeLocator(this, selector.startsWith('css=') ? selector.slice(4) : selector);
  }

  async goto(url: string): Promise<{ status(): number }> {
    if (url.includes('network-error')) throw new Error('net::ERR_CONNECTION_REFUSED');
    if (url.includes('slow')) await this.block.promise;
    this.currentUrl = url;
    this.status = url.includes('/404') ? 404 : 200;
    this.titleValue = this.status === 404 ? 'Missing' : 'Fake page';
    this.snapshot = this.status === 404 ? '- text: Missing test page' : `- document: ${url}`;
    return { status: () => this.status };
  }

  async waitForTimeout(milliseconds: number): Promise<void> {
    this.waits.push(milliseconds);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.block.reject(new Error('Page closed.'));
    for (const listener of this.closeListeners) listener();
  }
}

class FakeLocator implements BrowserDriverLocator {
  constructor(
    readonly page: FakePage,
    readonly selector: string,
  ) {}

  async ariaSnapshot(): Promise<string> {
    if (this.selector === '#missing') throw new Error('Locator was not found.');
    return this.page.snapshot;
  }

  async click(): Promise<void> {
    if (this.selector === '#error') throw new Error('Element is not actionable.');
    this.page.clicks.push(this.selector);
    if (this.selector === '#popup') await this.page.context.newPage();
  }

  async fill(text: string): Promise<void> {
    this.page.values.set(this.selector, text);
  }

  async scrollIntoViewIfNeeded(): Promise<void> {}

  async boundingBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    return { x: 10, y: 20, width: 100, height: 40 };
  }

  async waitFor(): Promise<void> {
    if (this.selector === '#blocked') await this.page.block.promise;
  }
}

class FakeContext implements BrowserDriverContext {
  readonly pages: FakePage[] = [];
  closed = false;
  private readonly pageListeners = new Set<(page: BrowserDriverPage) => void>();

  on(event: 'page', listener: (page: BrowserDriverPage) => void): void {
    if (event === 'page') this.pageListeners.add(listener);
  }

  async newPage(): Promise<FakePage> {
    const page = new FakePage(this);
    this.pages.push(page);
    for (const listener of this.pageListeners) listener(page);
    return page;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.pages.map((page) => page.close()));
  }
}

class FakeBrowser implements BrowserDriverProcess {
  readonly contexts: FakeContext[] = [];
  closed = false;

  version(): string {
    return 'fake-chromium';
  }

  async newContext(): Promise<FakeContext> {
    const context = new FakeContext();
    this.contexts.push(context);
    return context;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.contexts.map((context) => context.close()));
  }
}

function fakeFixture(options: { maxSessions?: number; maxPages?: number } = {}) {
  const browsers: FakeBrowser[] = [];
  const launches: BrowserLaunchOptions[] = [];
  const runtime = new BrowserRuntime({
    ...options,
    launch: async (launchOptions) => {
      launches.push(launchOptions);
      const browser = new FakeBrowser();
      browsers.push(browser);
      return browser;
    },
  });
  return { runtime, browsers, launches };
}

async function call(
  runtime: BrowserRuntime,
  runId: string,
  input: Record<string, unknown>,
  signal = new AbortController().signal,
): Promise<ToolExecutionResult> {
  const tool = runtime.createTool(runId);
  const validated = await tool.validate(input);
  const result = await tool.execute(validated, {
    call: { id: `call-${runId}`, name: 'browser', arguments: input },
    signal,
  });
  return typeof result === 'string' ? { content: result } : result;
}

function json(result: ToolExecutionResult): Record<string, unknown> {
  return JSON.parse(result.content) as Record<string, unknown>;
}

it('validates bounded actions without accepting script or screenshot inputs', async () => {
  const { runtime, launches } = fakeFixture();
  const tool = runtime.createTool('run-validation');
  expect(tool.parameters).not.toHaveProperty('properties.script');
  expect(tool.parameters).not.toHaveProperty('properties.javascript');
  expect(() => tool.validate({ action: 'navigate', url: 'file:///tmp/private' })).toThrow(
    /HTTP\(S\)/,
  );
  expect(() =>
    tool.validate({ action: 'navigate', url: 'https://user:secret@example.com' }),
  ).toThrow('credentials');
  expect(() => tool.validate({ action: 'click', selector: 'body', script: '1 + 1' })).toThrow();
  expect(() => tool.validate({ action: 'wait', wait_ms: 1, selector: 'body' })).toThrow(
    'exactly one',
  );
  expect(() =>
    tool.validate({ action: 'type', selector: 'body', text: 'x'.repeat(4001) }),
  ).toThrow();
  expect(launches).toHaveLength(0);
  await runtime.close();
});

it('bounds page_id input and keeps unknown page errors bounded', async () => {
  const { runtime } = fakeFixture();
  const tool = runtime.createTool('run-page-id');
  expect(tool.parameters).toHaveProperty('properties.page_id.maxLength', 200);
  const oversized = `page-${'1'.repeat(100_000)}`;
  let validationError: unknown;
  try {
    tool.validate({ action: 'read', page_id: oversized });
  } catch (error) {
    validationError = error;
  }
  expect(validationError).toBeInstanceOf(Error);
  const validationMessage =
    validationError instanceof Error ? validationError.message : String(validationError);
  expect(validationMessage.length).toBeLessThan(1000);
  expect(validationMessage).not.toContain(oversized);
  expect(() => tool.validate({ action: 'read', page_id: `page-${'9'.repeat(196)}` })).toThrow();

  await call(runtime, 'run-page-id', { action: 'navigate', url: 'https://example.com' });
  const unknownPageId = `page-${'9'.repeat(195)}`;
  expect(unknownPageId).toHaveLength(200);
  const result = await call(runtime, 'run-page-id', { action: 'read', page_id: unknownPageId });
  expect(json(result)).toEqual({
    status: 'error',
    error: { code: 'page_not_open', message: 'The requested page_id is not open in this Run.' },
  });
  expect(result.content.length).toBeLessThan(500);
  expect(result.content).not.toContain(unknownPageId);
  await runtime.close();
});

it('navigates, reads bounded accessibility content and executes page actions', async () => {
  const { runtime, browsers, launches } = fakeFixture();
  const navigated = await call(runtime, 'run-actions', {
    action: 'navigate',
    url: 'https://example.com/start',
  });
  expect(json(navigated)).toMatchObject({ status: 'ok', page_id: 'page-1', http_status: 200 });
  const browser = browsers[0];
  const page = browser?.contexts[0]?.pages[0];
  if (!browser || !page) throw new Error('Fake page was not created.');
  expect(launches[0]).toMatchObject({ headless: true });
  expect(browser.contexts).toHaveLength(1);

  await call(runtime, 'run-actions', { action: 'type', selector: '#name', text: 'Alice' });
  await call(runtime, 'run-actions', { action: 'click', selector: '#submit' });
  await call(runtime, 'run-actions', {
    action: 'scroll',
    selector: '#container',
    direction: 'down',
    amount: 800,
  });
  await call(runtime, 'run-actions', { action: 'wait', selector: '#result', state: 'visible' });
  await call(runtime, 'run-actions', { action: 'wait', wait_ms: 25 });
  expect(page.values.get('#name')).toBe('Alice');
  expect(page.clicks).toEqual(['#submit']);
  expect(page.wheels).toEqual([[0, 800]]);
  expect(page.waits).toEqual([25]);

  page.snapshot = 'x'.repeat(1000);
  const read = await call(runtime, 'run-actions', { action: 'read', max_chars: 100 });
  expect(json(read)).toMatchObject({
    content: 'x'.repeat(100),
    content_characters: 1000,
    truncated: true,
  });
  const closed = await call(runtime, 'run-actions', { action: 'close' });
  expect(json(closed)).toMatchObject({ status: 'ok', closed: true });
  expect(browser.closed).toBe(true);
  expect(runtime.activeSessionCount).toBe(0);
  expect(json(await call(runtime, 'run-actions', { action: 'read' }))).toMatchObject({
    status: 'error',
    error: { code: 'page_not_open' },
  });
  await runtime.close();
});

it('returns HTTP error pages and recoverable action errors', async () => {
  const { runtime, browsers } = fakeFixture();
  const response = await call(runtime, 'run-errors', {
    action: 'navigate',
    url: 'https://example.com/404',
  });
  expect(response.status).toBeUndefined();
  expect(json(response)).toMatchObject({ status: 'ok', http_status: 404, title: 'Missing' });
  expect(json(await call(runtime, 'run-errors', { action: 'read' }))).toMatchObject({
    content: '- text: Missing test page',
  });
  const failed = await call(runtime, 'run-errors', { action: 'click', selector: '#error' });
  expect(failed.status).toBe('error');
  expect(json(failed)).toMatchObject({ error: { code: 'action_failed' } });
  expect(runtime.activeSessionCount).toBe(1);
  await call(runtime, 'run-errors', { action: 'close' });
  expect(browsers[0]?.closed).toBe(true);
  await runtime.close();
});

it('reports missing Chromium and keeps headless launches independent of DISPLAY', async () => {
  const missing = new BrowserRuntime({
    launch: async () => {
      throw new Error("Executable doesn't exist");
    },
  });
  const unavailable = await call(missing, 'run-missing', {
    action: 'navigate',
    url: 'https://example.com',
  });
  expect(json(unavailable)).toMatchObject({ error: { code: 'browser_unavailable' } });
  expect(unavailable.content).toContain('KAIROS_BROWSER_EXECUTABLE_PATH');
  expect(unavailable.content).toContain('does not require a display server');
  expect(missing.activeSessionCount).toBe(0);
  await missing.close();

  vi.stubEnv('DISPLAY', '');
  try {
    const { runtime, launches } = fakeFixture();
    await call(runtime, 'run-headless', { action: 'navigate', url: 'https://example.com' });
    expect(launches[0]?.headless).toBe(true);
    await runtime.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('closes the browser on action timeout', async () => {
  const { runtime, browsers } = fakeFixture();
  const navigating = call(runtime, 'run-timeout', {
    action: 'navigate',
    url: 'https://example.com/slow',
    timeout_ms: 20,
  });
  await vi.waitFor(() => expect(browsers).toHaveLength(1));
  const result = await navigating;
  expect(result.status).toBe('error');
  expect(json(result)).toMatchObject({ error: { code: 'timeout' } });
  expect(browsers[0]?.closed).toBe(true);
  expect(runtime.activeSessionCount).toBe(0);
  await runtime.close();
});

it('propagates AbortSignal and releases the interrupted Run resources', async () => {
  const { runtime, browsers } = fakeFixture();
  const controller = new AbortController();
  const navigating = call(
    runtime,
    'run-cancel',
    { action: 'navigate', url: 'https://example.com/slow', timeout_ms: 5000 },
    controller.signal,
  );
  await vi.waitFor(() => expect(browsers[0]?.contexts[0]?.pages).toHaveLength(1));
  controller.abort(new DOMException('Stop browser.', 'AbortError'));
  await expect(navigating).rejects.toMatchObject({ name: 'AbortError' });
  expect(browsers[0]?.closed).toBe(true);
  expect(runtime.activeSessionCount).toBe(0);
  await runtime.close();
});

it('closes a browser that finishes launching after cancellation', async () => {
  const browser = new FakeBrowser();
  let launchStarted = false;
  let resolveLaunch = (_value: FakeBrowser) => {};
  const launched = new Promise<FakeBrowser>((resolve) => {
    resolveLaunch = resolve;
  });
  const runtime = new BrowserRuntime({
    launch: async () => {
      launchStarted = true;
      return launched;
    },
  });
  const controller = new AbortController();
  const navigating = call(
    runtime,
    'run-launch-cancel',
    { action: 'navigate', url: 'https://example.com', timeout_ms: 5000 },
    controller.signal,
  );
  await vi.waitFor(() => expect(launchStarted).toBe(true));
  controller.abort(new DOMException('Stop launch.', 'AbortError'));
  resolveLaunch(browser);
  await expect(navigating).rejects.toMatchObject({ name: 'AbortError' });
  expect(browser.closed).toBe(true);
  expect(runtime.activeSessionCount).toBe(0);
  await runtime.close();
});

it('isolates Run contexts and queues sessions above the concurrency limit', async () => {
  const { runtime, browsers } = fakeFixture({ maxSessions: 1 });
  await call(runtime, 'run-one', { action: 'navigate', url: 'https://example.com/one' });
  await call(runtime, 'run-one', { action: 'type', selector: '#private', text: 'run one only' });
  const second = call(runtime, 'run-two', {
    action: 'navigate',
    url: 'https://example.com/two',
    timeout_ms: 1000,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(browsers).toHaveLength(1);
  expect(runtime.activeSessionCount).toBe(1);
  await call(runtime, 'run-one', { action: 'close' });
  expect(json(await second)).toMatchObject({ status: 'ok', http_status: 200 });
  expect(browsers).toHaveLength(2);
  expect(browsers[0]).not.toBe(browsers[1]);
  expect(browsers[0]?.contexts[0]).not.toBe(browsers[1]?.contexts[0]);
  expect(browsers[1]?.contexts[0]?.pages[0]?.values.size).toBe(0);
  await call(runtime, 'run-two', { action: 'close' });
  expect(runtime.activeSessionCount).toBe(0);
  await runtime.close();
});

it('cancels a queued session without consuming another Run slot', async () => {
  const { runtime, browsers } = fakeFixture({ maxSessions: 1 });
  await call(runtime, 'run-owner', { action: 'navigate', url: 'https://example.com' });
  const controller = new AbortController();
  const waiting = call(
    runtime,
    'run-waiting',
    { action: 'navigate', url: 'https://example.com/queued' },
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new DOMException('Stop waiting.', 'AbortError'));
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  expect(runtime.activeSessionCount).toBe(1);
  await call(runtime, 'run-owner', { action: 'close' });
  expect(browsers).toHaveLength(1);
  expect(runtime.activeSessionCount).toBe(0);
  await runtime.close();
});

it('closes pages above the per-Run limit and reports the fault', async () => {
  const { runtime, browsers } = fakeFixture({ maxPages: 1 });
  await call(runtime, 'run-pages', { action: 'navigate', url: 'https://example.com' });
  const result = await call(runtime, 'run-pages', { action: 'click', selector: '#popup' });
  expect(json(result)).toMatchObject({ error: { code: 'page_limit' } });
  const context = browsers[0]?.contexts[0];
  expect(context?.pages).toHaveLength(2);
  expect(context?.pages[1]?.closed).toBe(true);
  expect(browsers[0]?.closed).toBe(true);
  expect(runtime.activeSessionCount).toBe(0);
  await runtime.close();
});

it('closes all active resources with the runtime and rejects later launches', async () => {
  const { runtime, browsers } = fakeFixture();
  await call(runtime, 'run-close', { action: 'navigate', url: 'https://example.com' });
  await runtime.close();
  expect(browsers[0]?.closed).toBe(true);
  expect(runtime.activeSessionCount).toBe(0);
  expect(
    json(await call(runtime, 'run-later', { action: 'navigate', url: 'https://example.com' })),
  ).toMatchObject({ error: { code: 'closed' } });
});

it('validates the optional Chromium executable path', () => {
  expect(browserOptionsFromEnvironment({})).toEqual({});
  expect(
    browserOptionsFromEnvironment({ KAIROS_BROWSER_EXECUTABLE_PATH: '/opt/chromium' }),
  ).toEqual({
    executablePath: '/opt/chromium',
  });
  expect(() =>
    browserOptionsFromEnvironment({ KAIROS_BROWSER_EXECUTABLE_PATH: 'relative/chromium' }),
  ).toThrow('absolute path');
});

const browserSmoke = process.env.KAIROS_RUN_BROWSER_SMOKE === '1' ? it : it.skip;

browserSmoke(
  'runs real Chromium actions and isolates simultaneous Runs',
  { timeout: 60_000 },
  async () => {
    const cookies: string[] = [];
    let scrollRequests = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/scrolled') {
        scrollRequests += 1;
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === '/start') {
        response.setHeader('Set-Cookie', 'kairos_smoke=run-one; Path=/; SameSite=Lax');
      }
      if (url.pathname === '/echo') {
        cookies.push(request.headers.cookie ?? 'none');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(`<html><body><p>cookie=${request.headers.cookie ?? 'none'}</p></body></html>`);
        return;
      }
      if (url.pathname === '/404') {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          '<html><head><title>Missing</title></head><body>Missing test page</body></html>',
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
      <html><head><title>M147 smoke</title></head><body>
        <h1>Browser smoke</h1>
        <label for="name">Name</label><input id="name" name="name">
        <button id="submit" onclick="const result=document.querySelector('#result'); result.textContent=document.querySelector('#name').value; result.hidden=false">Submit</button>
        <p id="result" hidden>waiting</p>
        <div style="height:2000px">Scroll area</div>
        <script>window.addEventListener('scroll', () => { void fetch('/scrolled'); });</script>
      </body></html>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const versions: string[] = [];
    const browsers: Browser[] = [];
    let disconnected = 0;
    const runtime = new BrowserRuntime({
      launch: async (options) => {
        const browser = await chromium.launch(options);
        versions.push(browser.version());
        browsers.push(browser);
        browser.on('disconnected', () => {
          disconnected += 1;
        });
        return browser;
      },
    });
    try {
      const started = await call(runtime, 'smoke-one', {
        action: 'navigate',
        url: `${origin}/start`,
      });
      expect(json(started)).toMatchObject({ status: 'ok', http_status: 200 });
      const typed = await call(runtime, 'smoke-one', {
        action: 'type',
        selector: '#name',
        text: 'Alice',
      });
      expect(json(typed)).toMatchObject({ status: 'ok' });
      const clicked = await call(runtime, 'smoke-one', { action: 'click', selector: '#submit' });
      expect(clicked.content).toContain('"status":"ok"');
      const waited = await call(runtime, 'smoke-one', {
        action: 'wait',
        selector: '#result',
        state: 'visible',
      });
      expect(json(waited)).toMatchObject({ status: 'ok' });
      const actionRead = await call(runtime, 'smoke-one', { action: 'read', max_chars: 10_000 });
      expect(actionRead.content).toContain('Alice');
      await call(runtime, 'smoke-one', {
        action: 'scroll',
        selector: 'body',
        direction: 'down',
        amount: 800,
      });
      await call(runtime, 'smoke-one', { action: 'wait', wait_ms: 20 });
      await vi.waitFor(() => expect(scrollRequests).toBeGreaterThan(0));

      const second = await call(runtime, 'smoke-two', {
        action: 'navigate',
        url: `${origin}/echo`,
      });
      expect(json(second)).toMatchObject({ status: 'ok', page_id: 'page-1' });
      const isolatedRead = await call(runtime, 'smoke-two', { action: 'read' });
      expect(isolatedRead.content).toContain('cookie=none');
      expect(cookies).toEqual(['none']);
      expect(browsers).toHaveLength(2);
      expect(browsers[0]).not.toBe(browsers[1]);

      const missing = await call(runtime, 'smoke-one', {
        action: 'navigate',
        url: `${origin}/404`,
      });
      expect(json(missing)).toMatchObject({ status: 'ok', http_status: 404 });
      expect((await call(runtime, 'smoke-one', { action: 'read' })).content).toContain(
        'Missing test page',
      );
      await call(runtime, 'smoke-one', { action: 'close' });
      expect((await call(runtime, 'smoke-two', { action: 'read' })).content).toContain(
        'cookie=none',
      );
      await call(runtime, 'smoke-two', { action: 'close' });
      expect(runtime.activeSessionCount).toBe(0);
      await runtime.close();
      expect(disconnected).toBe(2);
      expect(new Set(versions).size).toBe(1);
      console.info(`M147 real Chromium version: ${versions[0] ?? 'unknown'}`);
    } finally {
      await runtime.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
