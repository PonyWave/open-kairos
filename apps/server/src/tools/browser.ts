import { isAbsolute } from 'node:path';
import type { AgentTool, ToolExecutionResult } from '@kairos/agent-core';
import { chromium } from 'playwright';
import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SESSIONS = 2;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_CONTENT_CHARACTERS = 12_000;

const pageIdSchema = z
  .string()
  .max(200)
  .regex(/^page-[1-9]\d*$/);
const timeoutSchema = z.number().int().positive().max(30_000);
const selectorSchema = z.string().trim().min(1).max(1000);
const urlSchema = z
  .string()
  .min(1)
  .max(2048)
  .transform((value, context) => {
    try {
      const url = new URL(value);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        context.addIssue({
          code: 'custom',
          message: 'Only HTTP(S) URLs without embedded credentials are permitted.',
        });
        return z.NEVER;
      }
      return url.toString();
    } catch {
      context.addIssue({ code: 'custom', message: 'A valid absolute HTTP(S) URL is required.' });
      return z.NEVER;
    }
  });

const browserInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('navigate'),
      url: urlSchema,
      page_id: pageIdSchema.optional(),
      timeout_ms: timeoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('read'),
      selector: selectorSchema.optional(),
      max_chars: z.number().int().min(100).max(50_000).optional(),
      page_id: pageIdSchema.optional(),
      timeout_ms: timeoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('click'),
      selector: selectorSchema,
      page_id: pageIdSchema.optional(),
      timeout_ms: timeoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('type'),
      selector: selectorSchema,
      text: z.string().max(4000),
      page_id: pageIdSchema.optional(),
      timeout_ms: timeoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('scroll'),
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().positive().max(10_000).optional(),
      selector: selectorSchema.optional(),
      page_id: pageIdSchema.optional(),
      timeout_ms: timeoutSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('wait'),
      wait_ms: z.number().int().positive().max(10_000).optional(),
      selector: selectorSchema.optional(),
      state: z.enum(['attached', 'visible', 'hidden']).optional(),
      page_id: pageIdSchema.optional(),
      timeout_ms: timeoutSchema.optional(),
    })
    .strict()
    .superRefine((input, context) => {
      if ((input.wait_ms === undefined) === (input.selector === undefined)) {
        context.addIssue({
          code: 'custom',
          message: 'Provide exactly one of wait_ms or selector.',
        });
      }
      if (input.wait_ms !== undefined && input.state !== undefined) {
        context.addIssue({ code: 'custom', message: 'state requires a selector.' });
      }
    }),
  z.object({ action: z.literal('close'), timeout_ms: timeoutSchema.optional() }).strict(),
]);

type BrowserInput = z.infer<typeof browserInputSchema>;
type BrowserErrorCode =
  | 'action_failed'
  | 'browser_unavailable'
  | 'closed'
  | 'page_limit'
  | 'page_not_open'
  | 'timeout';

export interface BrowserDriverLocator {
  ariaSnapshot(options: { timeout: number }): Promise<string>;
  click(options: { timeout: number }): Promise<void>;
  fill(text: string, options: { timeout: number }): Promise<void>;
  scrollIntoViewIfNeeded(options: { timeout: number }): Promise<void>;
  boundingBox(options: { timeout: number }): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  waitFor(options: { state?: 'attached' | 'visible' | 'hidden'; timeout: number }): Promise<void>;
}

export interface BrowserDriverPage {
  readonly mouse: {
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  on(event: 'close', listener: () => void): unknown;
  isClosed(): boolean;
  url(): string;
  title(): Promise<string>;
  locator(selector: string): BrowserDriverLocator;
  goto(
    url: string,
    options: { waitUntil: 'domcontentloaded'; timeout: number },
  ): Promise<{ status(): number } | null>;
  waitForTimeout(milliseconds: number): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserDriverContext {
  on(event: 'page', listener: (page: BrowserDriverPage) => void): unknown;
  newPage(): Promise<BrowserDriverPage>;
  close(): Promise<void>;
}

export interface BrowserDriverProcess {
  version(): string;
  newContext(options: {
    viewport: { width: number; height: number };
    acceptDownloads: false;
  }): Promise<BrowserDriverContext>;
  close(): Promise<void>;
}

export interface BrowserLaunchOptions {
  headless: boolean;
  channel: 'chromium';
  timeout: number;
  args: string[];
  executablePath?: string;
}

export type BrowserLauncher = (options: BrowserLaunchOptions) => Promise<BrowserDriverProcess>;

export interface BrowserRuntimeOptions {
  executablePath?: string;
  maxSessions?: number;
  maxPages?: number;
  defaultTimeoutMs?: number;
  launch?: BrowserLauncher;
  onError?: (error: unknown) => void;
}

export function browserOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): BrowserRuntimeOptions {
  const executablePath = environment.KAIROS_BROWSER_EXECUTABLE_PATH;
  if (executablePath === undefined || executablePath.trim() === '') return {};
  if (!isAbsolute(executablePath)) {
    throw new Error('KAIROS_BROWSER_EXECUTABLE_PATH must be an absolute path.');
  }
  return { executablePath };
}

class BrowserToolError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserToolError';
  }
}

export class BrowserRuntime {
  readonly #maxSessions: number;
  readonly #maxPages: number;
  readonly #defaultTimeoutMs: number;
  readonly #launch: BrowserLauncher;
  readonly #executablePath: string | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #closingRuns = new Map<string, Promise<void>>();
  readonly #waiters: Array<{
    signal: AbortSignal;
    start: () => void;
    reject: (error: unknown) => void;
  }> = [];
  #activeSessions = 0;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: BrowserRuntimeOptions = {}) {
    this.#maxSessions = positiveInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 'maxSessions');
    this.#maxPages = positiveInteger(options.maxPages ?? DEFAULT_MAX_PAGES, 'maxPages');
    this.#defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      'defaultTimeoutMs',
    );
    this.#launch = options.launch ?? ((launchOptions) => chromium.launch(launchOptions));
    this.#executablePath = options.executablePath;
    this.#onError = options.onError;
  }

  get activeSessionCount(): number {
    return this.#activeSessions;
  }

  createTool(runId: string): AgentTool<BrowserInput> {
    return {
      name: 'browser',
      description:
        'Control a fresh headless Chromium session isolated to this Run. Actions: navigate an HTTP(S) URL; read a bounded ARIA accessibility tree; click or fill a CSS selector; scroll with the mouse wheel; wait for bounded time or selector state; close the whole Run session. page_id selects a page returned by a prior result; omitted page_id uses the active page. type replaces the input value. close removes all pages and browser storage for this Run. HTTP error pages still open and return http_status. No JavaScript, screenshots, downloads, persistent profile, cookies from other Runs, or desktop control.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['navigate', 'read', 'click', 'type', 'scroll', 'wait', 'close'],
          },
          url: { type: 'string', maxLength: 2048 },
          selector: { type: 'string', minLength: 1, maxLength: 1000 },
          text: { type: 'string', maxLength: 4000 },
          page_id: { type: 'string', maxLength: 200, pattern: '^page-[1-9]\\d*$' },
          max_chars: { type: 'integer', minimum: 100, maximum: 50_000 },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'integer', minimum: 1, maximum: 10_000 },
          wait_ms: { type: 'integer', minimum: 1, maximum: 10_000 },
          state: { type: 'string', enum: ['attached', 'visible', 'hidden'] },
          timeout_ms: { type: 'integer', minimum: 1, maximum: 30_000 },
        },
      },
      validate: (value) => {
        try {
          return browserInputSchema.parse(value);
        } catch (error) {
          throw new Error(safeErrorMessage(error));
        }
      },
      execute: (input, { signal }) => this.#execute(runId, input, signal),
    };
  }

  async closeRun(runId: string): Promise<void> {
    const pending = this.#closingRuns.get(runId);
    if (pending) return pending;
    const session = this.#sessions.get(runId);
    if (!session) return;
    const closing = (async () => {
      this.#sessions.delete(runId);
      try {
        await session.close();
      } finally {
        this.#releaseSession();
      }
    })();
    this.#closingRuns.set(runId, closing);
    try {
      await closing;
    } finally {
      this.#closingRuns.delete(runId);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    const error = new BrowserToolError('closed', 'The browser runtime is closing.');
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    this.#closePromise = (async () => {
      await Promise.all([...this.#closingRuns.values()]);
      await Promise.all([...this.#sessions.keys()].map((runId) => this.closeRun(runId)));
    })();
    return this.#closePromise;
  }

  async #execute(
    runId: string,
    input: BrowserInput,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    const timeoutMs = input.timeout_ms ?? this.#defaultTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort(signal.reason);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new BrowserToolError('timeout', `Browser action exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });

    const operation = this.#perform(runId, input, controller.signal);
    try {
      return await raceWithAbort(operation, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || isPlaywrightTimeout(error)) {
        await this.closeRun(runId);
        await operation.catch(() => undefined);
        if (signal.aborted) throw signal.reason;
        const message =
          timedOut || isPlaywrightTimeout(error)
            ? `Browser action exceeded ${timeoutMs} ms; the Run browser session was closed.`
            : 'Browser action was cancelled; the Run browser session was closed.';
        return browserErrorResult('timeout', message);
      }
      if (error instanceof BrowserToolError) {
        if (error.code === 'browser_unavailable' || error.code === 'page_limit') {
          await this.closeRun(runId);
        }
        return browserErrorResult(error.code, error.message);
      }
      return browserErrorResult(
        'action_failed',
        `Browser ${input.action} failed: ${safeErrorMessage(error)}`,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  async #perform(
    runId: string,
    input: BrowserInput,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    if (input.action === 'close') {
      await this.closeRun(runId);
      return { content: JSON.stringify({ status: 'ok', action: 'close', closed: true }) };
    }
    let session = this.#sessions.get(runId);
    if (!session && input.action !== 'navigate') {
      throw new BrowserToolError(
        'page_not_open',
        'No browser page is open for this Run; use navigate first.',
      );
    }
    if (!session) session = await this.#createSession(runId, signal);
    const timeoutMs = input.timeout_ms ?? this.#defaultTimeoutMs;
    const page = await session.selectPage(input.page_id, input.action === 'navigate');
    signal.throwIfAborted();
    switch (input.action) {
      case 'navigate': {
        const response = await page.goto(input.url, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        return session.result(page, input.action, {
          http_status: response?.status() ?? null,
        });
      }
      case 'read': {
        const snapshot = await cssLocator(page, input.selector ?? 'body').ariaSnapshot({
          timeout: timeoutMs,
        });
        const maximum = input.max_chars ?? DEFAULT_MAX_CONTENT_CHARACTERS;
        return session.result(page, input.action, {
          content: snapshot.slice(0, maximum),
          content_characters: snapshot.length,
          truncated: snapshot.length > maximum,
        });
      }
      case 'click':
        await cssLocator(page, input.selector).click({ timeout: timeoutMs });
        return session.result(page, input.action);
      case 'type':
        await cssLocator(page, input.selector).fill(input.text, { timeout: timeoutMs });
        return session.result(page, input.action);
      case 'scroll': {
        if (input.selector) {
          const locator = cssLocator(page, input.selector);
          await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
          const bounds = await locator.boundingBox({ timeout: timeoutMs });
          if (bounds) {
            await page.mouse.move(
              bounds.x + Math.min(bounds.width, 1) / 2,
              bounds.y + Math.min(bounds.height, 1) / 2,
            );
          }
        }
        const amount = input.amount ?? 600;
        const deltaX =
          input.direction === 'left' ? -amount : input.direction === 'right' ? amount : 0;
        const deltaY = input.direction === 'up' ? -amount : input.direction === 'down' ? amount : 0;
        await page.mouse.wheel(deltaX, deltaY);
        return session.result(page, input.action);
      }
      case 'wait':
        if (input.selector) {
          await cssLocator(page, input.selector).waitFor({
            state: input.state ?? 'visible',
            timeout: timeoutMs,
          });
        } else if (input.wait_ms !== undefined) {
          await page.waitForTimeout(input.wait_ms);
        }
        return session.result(page, input.action);
    }
  }

  async #createSession(runId: string, signal: AbortSignal): Promise<BrowserSession> {
    if (this.#closing) throw new BrowserToolError('closed', 'The browser runtime is closing.');
    await this.#acquireSession(signal);
    try {
      signal.throwIfAborted();
      if (this.#closing) {
        throw new BrowserToolError('closed', 'The browser runtime is closing.');
      }
      const existing = this.#sessions.get(runId);
      if (existing) {
        this.#releaseSession();
        return existing;
      }
      const session = new BrowserSession({
        maxPages: this.#maxPages,
        launch: this.#launch,
        defaultTimeoutMs: this.#defaultTimeoutMs,
        ...(this.#executablePath ? { executablePath: this.#executablePath } : {}),
        ...(this.#onError ? { onError: this.#onError } : {}),
      });
      this.#sessions.set(runId, session);
      return session;
    } catch (error) {
      this.#releaseSession();
      throw error;
    }
  }

  async #acquireSession(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#activeSessions < this.#maxSessions) {
      this.#activeSessions += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        start: () => {
          signal.removeEventListener('abort', abort);
          resolve();
        },
        reject: (error: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      };
      const abort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        waiter.reject(signal.reason);
      };
      this.#waiters.push(waiter);
      signal.addEventListener('abort', abort, { once: true });
    });
    if (this.#closing) {
      this.#releaseSession();
      throw new BrowserToolError('closed', 'The browser runtime is closing.');
    }
  }

  #releaseSession(): void {
    const next = this.#waiters.shift();
    if (next) {
      next.start();
      return;
    }
    this.#activeSessions = Math.max(0, this.#activeSessions - 1);
  }
}

interface BrowserSessionOptions {
  maxPages: number;
  launch: BrowserLauncher;
  defaultTimeoutMs: number;
  executablePath?: string;
  onError?: (error: unknown) => void;
}

class BrowserSession {
  readonly #maxPages: number;
  readonly #launch: BrowserLauncher;
  readonly #defaultTimeoutMs: number;
  readonly #executablePath: string | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #pages = new Map<string, BrowserDriverPage>();
  readonly #pageIds = new WeakMap<BrowserDriverPage, string>();
  #browserPromise: Promise<BrowserDriverProcess> | undefined;
  #contextPromise: Promise<BrowserDriverContext> | undefined;
  #activePageId: string | undefined;
  #nextPageId = 1;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #pageFault: BrowserToolError | undefined;

  constructor(options: BrowserSessionOptions) {
    this.#maxPages = options.maxPages;
    this.#launch = options.launch;
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
    this.#executablePath = options.executablePath;
    this.#onError = options.onError;
  }

  async selectPage(pageId: string | undefined, create: boolean): Promise<BrowserDriverPage> {
    if (this.#closed) throw new BrowserToolError('closed', 'The Run browser session is closed.');
    await this.#ensureContext();
    this.#throwPageFault();
    if (pageId !== undefined) {
      const selected = this.#pages.get(pageId);
      if (!selected || selected.isClosed()) {
        throw new BrowserToolError(
          'page_not_open',
          'The requested page_id is not open in this Run.',
        );
      }
      this.#activePageId = pageId;
      return selected;
    }
    const active =
      this.#activePageId === undefined ? undefined : this.#pages.get(this.#activePageId);
    if (active && !active.isClosed()) return active;
    if (!create) {
      throw new BrowserToolError(
        'page_not_open',
        'No browser page is open for this Run; use navigate first.',
      );
    }
    if (this.#pages.size >= this.#maxPages) {
      throw new BrowserToolError(
        'page_limit',
        `The Run browser page limit of ${this.#maxPages} was reached.`,
      );
    }
    const context = await this.#ensureContext();
    const page = await context.newPage();
    const id = this.#registerPage(page);
    this.#activePageId = id;
    return page;
  }

  async result(
    page: BrowserDriverPage,
    action: BrowserInput['action'],
    extra: Record<string, unknown> = {},
  ): Promise<ToolExecutionResult> {
    this.#throwPageFault();
    const pageId = this.#pageIds.get(page);
    if (!pageId)
      throw new BrowserToolError('page_not_open', 'The selected page is not registered.');
    const title = await page.title();
    this.#throwPageFault();
    return {
      content: JSON.stringify({
        status: 'ok',
        action,
        page_id: pageId,
        url: page.url().slice(0, 2048),
        title: title.slice(0, 500),
        pages: [...this.#pages].map(([id, candidate]) => ({
          page_id: id,
          url: candidate.url().slice(0, 2048),
          active: id === this.#activePageId,
        })),
        ...extra,
      }),
    };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#closeResources();
    return this.#closePromise;
  }

  async #ensureContext(): Promise<BrowserDriverContext> {
    if (!this.#browserPromise) {
      this.#browserPromise = this.#launch({
        headless: true,
        channel: 'chromium',
        timeout: this.#defaultTimeoutMs,
        args: ['--no-first-run', '--disable-default-apps'],
        ...(this.#executablePath ? { executablePath: this.#executablePath } : {}),
      }).catch((error: unknown) => {
        throw new BrowserToolError(
          'browser_unavailable',
          `Chromium could not start. Install Playwright Chromium and its system libraries, or set KAIROS_BROWSER_EXECUTABLE_PATH to a compatible browser. Headless mode does not require a display server. ${safeErrorMessage(error)}`,
        );
      });
    }
    const browser = await this.#browserPromise;
    if (!this.#contextPromise) {
      this.#contextPromise = browser
        .newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: false })
        .then((context) => {
          context.on('page', (page) => this.#onPage(page));
          return context;
        })
        .catch((error: unknown) => {
          throw new BrowserToolError(
            'browser_unavailable',
            `A fresh Chromium context could not be created: ${safeErrorMessage(error)}`,
          );
        });
    }
    return this.#contextPromise;
  }

  async #closeResources(): Promise<void> {
    const browserPromise = this.#browserPromise;
    if (!browserPromise) return;
    let browser: BrowserDriverProcess;
    try {
      browser = await browserPromise;
    } catch {
      return;
    }
    const errors: unknown[] = [];
    if (this.#contextPromise) {
      try {
        const context = await this.#contextPromise;
        await context.close();
      } catch (error) {
        if (!(error instanceof BrowserToolError && error.code === 'browser_unavailable')) {
          errors.push(error);
        }
      }
    }
    try {
      await browser.close();
    } catch (error) {
      errors.push(error);
    }
    this.#pages.clear();
    this.#activePageId = undefined;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, 'Browser resources did not close cleanly.');
  }

  #onPage(page: BrowserDriverPage): void {
    if (this.#closed || this.#pages.size >= this.#maxPages) {
      this.#pageFault ??= new BrowserToolError(
        'page_limit',
        `A new page exceeded the Run browser page limit of ${this.#maxPages}; the page was closed.`,
      );
      void page.close().catch((error: unknown) => this.#onError?.(error));
      return;
    }
    const id = this.#registerPage(page);
    this.#activePageId = id;
  }

  #registerPage(page: BrowserDriverPage): string {
    const existing = this.#pageIds.get(page);
    if (existing) return existing;
    const id = `page-${this.#nextPageId}`;
    this.#nextPageId += 1;
    this.#pageIds.set(page, id);
    this.#pages.set(id, page);
    page.on('close', () => {
      this.#pages.delete(id);
      if (this.#activePageId === id) this.#activePageId = [...this.#pages.keys()].at(-1);
    });
    return id;
  }

  #throwPageFault(): void {
    if (this.#pageFault) throw this.#pageFault;
  }
}

function browserErrorResult(code: BrowserErrorCode, message: string): ToolExecutionResult {
  return {
    content: JSON.stringify({ status: 'error', error: { code, message } }),
    status: 'error',
  };
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function isPlaywrightTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function cssLocator(page: BrowserDriverPage, selector: string): BrowserDriverLocator {
  return page.locator(`css=${selector}`);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\s*\n\s*/g, ' ').slice(0, 1000);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
  return value;
}
