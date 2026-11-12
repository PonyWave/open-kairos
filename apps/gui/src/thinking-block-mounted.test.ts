/// <reference lib="dom" />

import { createRouterTransport } from '@connectrpc/connect';
import {
  ContentBlockSchema,
  ContentBlockType,
  create,
  type Message,
  MessageRole,
  MessageSchema,
  ToolCallSchema,
} from '@kairos/contracts';
import { act, createElement, Fragment, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKairosClients } from './client.js';
import { MessageCard } from './message-card.js';
import { projectConversation } from './response-projection.js';
import { MessageContent } from './thinking-block.js';
import {
  isThinkingBlockExpanded,
  type ThinkingExpansionChoices,
  thinkingBlockKey,
  withThinkingBlockExpanded,
} from './thinking-expansion.js';
import { type ToolExpansionChoices, ToolOperationGroup } from './tool-call-groups.js';
import { projectToolItems, withToolExpanded } from './tool-group-projection.js';

vi.mock('./icon.js', () => ({ Icon: () => null }));
vi.mock('./message-avatar.js', () => ({ MessageAvatar: () => null }));
vi.mock('./safe-markdown.js', async () => {
  const { createElement: markdownElement } = await import('react');
  return {
    SafeMarkdown: ({ children }: { children?: ReactNode }) =>
      markdownElement('span', null, children),
  };
});

function noop() {}

type MountedNode = MountedElement | MountedText;

class MountedText {
  parentNode: MountedElement | null = null;

  constructor(
    public nodeValue: string,
    readonly ownerDocument: MountedDocument,
    readonly nodeType = 3,
  ) {}
}

class MountedElement {
  readonly nodeType = 1;
  readonly nodeName: string;
  readonly tagName: string;
  readonly childNodes: MountedNode[] = [];
  readonly style: Record<string, unknown> = {};
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  parentNode: MountedElement | null = null;
  textContent = '';

  constructor(
    tagName: string,
    readonly ownerDocument: MountedDocument,
    readonly namespaceURI = 'http://www.w3.org/1999/xhtml',
  ) {
    this.nodeName = tagName;
    this.tagName = tagName;
  }

  get firstChild(): MountedNode | null {
    return this.childNodes[0] ?? null;
  }

  get open(): boolean {
    return this.attributes.has('open');
  }

  set open(expanded: boolean) {
    if (expanded) this.setAttribute('open', '');
    else this.removeAttribute('open');
  }

  addEventListener = noop;
  removeEventListener = noop;

  appendChild<T extends MountedNode>(child: T): T {
    return this.insertBefore(child, null);
  }

  insertBefore<T extends MountedNode>(child: T, reference: MountedNode | null): T {
    child.parentNode?.removeChild(child);
    const index = reference === null ? -1 : this.childNodes.indexOf(reference);
    if (reference !== null && index < 0) throw new Error('Reference node is not a child.');
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild<T extends MountedNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error('Removed node is not a child.');
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  setAttributeNS(_namespace: string, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  removeAttributeNS(_namespace: string, name: string): void {
    this.removeAttribute(name);
  }
}

class MountedDocument {
  readonly nodeType = 9;
  readonly activeElement = null;
  addEventListener = noop;
  removeEventListener = noop;

  createElement(nodeName: string): MountedElement {
    return new MountedElement(nodeName, this);
  }

  createElementNS(namespaceURI: string, nodeName: string): MountedElement {
    return new MountedElement(nodeName, this, namespaceURI);
  }

  createTextNode(nodeValue: string): MountedText {
    return new MountedText(nodeValue, this);
  }

  createComment(nodeValue: string): MountedText {
    return new MountedText(nodeValue, this, 8);
  }
}

function installReactDomContainer(): HTMLElement {
  const document = new MountedDocument();
  const window = {
    document,
    addEventListener: noop,
    removeEventListener: noop,
    getSelection: () => null,
    HTMLIFrameElement: class {},
    HTMLElement: class {},
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('navigator', { userAgent: 'node' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return document.createElement('div') as unknown as HTMLElement;
}

const message = create(MessageSchema, {
  messageId: 'mounted-message',
  threadId: 'thread-1',
  agentId: 'thread',
  role: MessageRole.ASSISTANT,
  contentBlocks: [{ type: ContentBlockType.THINKING, blockIndex: 0, text: '挂载思考' }],
  toolCalls: [
    create(ToolCallSchema, {
      toolCallId: 'bash-1',
      toolName: 'bash',
      argumentsJson: '{"command":"pwd"}',
    }),
  ],
});
const clients = createKairosClients({ transport: createRouterTransport(() => {}) });
const expansionKey = thinkingBlockKey(message.messageId, 0);

interface MountedSnapshot {
  choices: ThinkingExpansionChoices;
  expanded: boolean;
}

function MountedThinking({
  active,
  variant,
  snapshot,
}: {
  active: boolean;
  variant: 'content' | 'group';
  snapshot: MountedSnapshot;
}) {
  const [choices, setChoices] = useState<ThinkingExpansionChoices>({});
  snapshot.choices = choices;
  snapshot.expanded = isThinkingBlockExpanded(choices, message.messageId, 0);
  const onThinkingExpansionChange = (_messageId: string, blockIndex: number, expanded: boolean) =>
    setChoices((current) =>
      withThinkingBlockExpanded(current, message.messageId, blockIndex, expanded),
    );
  if (variant === 'content') {
    return createElement(MessageContent, {
      message,
      streaming: active,
      choices,
      onThinkingExpansionChange,
    });
  }
  const group = projectToolItems(message.toolCalls, {
    contentBlocks: message.contentBlocks,
    messageId: message.messageId,
    streaming: active,
  })[0];
  if (group?.kind !== 'ordinary') throw new Error('Missing mounted mixed group.');
  return createElement(ToolOperationGroup, {
    message,
    calls: group.calls,
    operations: group.operations,
    outcomes: new Map(),
    streaming: active,
    clients,
    choices: { 'group:mounted-message:thinking:0': true },
    onExpandedChange: () => {},
    thinkingExpansionChoices: choices,
    onThinkingExpansionChange,
  });
}

function thinkingButton(node: MountedNode): MountedElement {
  if (node instanceof MountedElement) {
    if (node.tagName.toUpperCase() === 'BUTTON') return node;
    for (const child of node.childNodes) {
      try {
        return thinkingButton(child);
      } catch {
        // Continue with the next mounted sibling.
      }
    }
  }
  throw new Error('Mounted Thinking button was not found.');
}

function clickButton(button: MountedElement): void {
  const propsKey = Object.keys(button).find((key) => key.startsWith('__reactProps$'));
  if (!propsKey) throw new Error('Mounted button props were not found.');
  const props: unknown = Reflect.get(button, propsKey);
  if (!props || typeof props !== 'object') throw new Error('Mounted button props are invalid.');
  const onClick: unknown = Reflect.get(props, 'onClick');
  if (typeof onClick !== 'function') throw new Error('Mounted button has no click handler.');
  onClick();
}

const roots = new Set<Root>();

afterEach(async () => {
  for (const root of roots) {
    await act(async () => root.unmount());
  }
  roots.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountThinking(variant: 'content' | 'group') {
  const container = installReactDomContainer();
  const root = createRoot(container);
  roots.add(root);
  const snapshot: MountedSnapshot = { choices: {}, expanded: false };
  async function render(active: boolean) {
    await act(async () => {
      root.render(createElement(MountedThinking, { active, variant, snapshot }));
    });
  }
  await render(true);
  return {
    snapshot,
    render,
    click: async () => {
      await act(async () => clickButton(thinkingButton(container as unknown as MountedElement)));
    },
  };
}

for (const variant of ['content', 'group'] as const) {
  describe(`mounted Thinking expansion (${variant})`, () => {
    it('preserves explicit collapse and expansion choices after activity ends', async () => {
      const mounted = await mountThinking(variant);
      expect(mounted.snapshot.expanded).toBe(false);
      expect(mounted.snapshot.choices[expansionKey]).toBeUndefined();

      await mounted.click();
      expect(mounted.snapshot.expanded).toBe(true);
      expect(mounted.snapshot.choices[expansionKey]).toBe(true);
      await mounted.click();
      expect(mounted.snapshot.expanded).toBe(false);
      expect(mounted.snapshot.choices[expansionKey]).toBe(false);
      await mounted.click();
      expect(mounted.snapshot.expanded).toBe(true);
      expect(mounted.snapshot.choices[expansionKey]).toBe(true);

      await mounted.render(false);
      expect(mounted.snapshot.choices[expansionKey]).toBe(true);
      expect(mounted.snapshot.expanded).toBe(true);
    });

    it('keeps an unselected block collapsed when activity ends', async () => {
      const mounted = await mountThinking(variant);
      expect(mounted.snapshot.expanded).toBe(false);
      expect(mounted.snapshot.choices[expansionKey]).toBeUndefined();

      await mounted.render(false);
      expect(mounted.snapshot.choices[expansionKey]).toBeUndefined();
      expect(mounted.snapshot.expanded).toBe(false);
    });
  });
}

type ConversationInput = Parameters<typeof projectConversation>[0];

function MountedConversation({
  messages,
  transientResponses = [],
}: {
  messages: ConversationInput['messages'];
  transientResponses?: ConversationInput['transientResponses'];
}) {
  const [thinkingChoices, setThinkingChoices] = useState<ThinkingExpansionChoices>({});
  const [toolChoices, setToolChoices] = useState<ToolExpansionChoices>({});
  const items = projectConversation({
    threadId: 'thread-1',
    messages,
    transientResponses,
    runs: [],
  });
  return createElement(
    Fragment,
    null,
    ...items.flatMap((item) =>
      item.kind === 'message'
        ? [
            createElement(MessageCard, {
              key: item.key,
              message: item.value.message,
              delegationCall: item.value.delegationCall,
              clients,
              busy: false,
              editing: false,
              streaming: item.value.streaming,
              thinkingExpansionChoices: thinkingChoices,
              toolOutcomes: new Map(),
              toolItems: item.value.toolItems,
              mergedThinkingBlockIndexes: item.value.mergedThinkingBlockIndexes,
              toolExpansionChoices: toolChoices,
              onToolExpansionChange: (operationId, expanded) =>
                setToolChoices((current) => withToolExpanded(current, operationId, expanded)),
              onThinkingExpansionChange: (messageId, blockIndex, expanded) =>
                setThinkingChoices((current) =>
                  withThinkingBlockExpanded(current, messageId, blockIndex, expanded),
                ),
              onStartEditing: noop,
              onCancelEditing: noop,
              onRevise: async () => {},
              onRerun: async () => {},
            }),
          ]
        : [],
    ),
  );
}

function findMountedElements(
  node: MountedNode,
  predicate: (element: MountedElement) => boolean,
  found: MountedElement[] = [],
): MountedElement[] {
  if (node instanceof MountedElement) {
    if (predicate(node)) found.push(node);
    for (const child of node.childNodes) findMountedElements(child, predicate, found);
  }
  return found;
}

function mountedGroups(container: HTMLElement): MountedElement[] {
  return findMountedElements(
    container as unknown as MountedElement,
    (element) =>
      element.tagName.toUpperCase() === 'DETAILS' &&
      (element.attributes.get('data-operation') ?? '').startsWith('group:'),
  );
}

function mountedText(node: MountedNode): string {
  if (node instanceof MountedText) return node.nodeValue;
  return `${node.textContent}${node.childNodes.map(mountedText).join('')}`;
}

async function triggerMountedDetailsToggle(details: MountedElement): Promise<void> {
  await act(async () => {
    details.open = !details.open;
    const propsKey = Object.keys(details).find((key) => key.startsWith('__reactProps$'));
    if (!propsKey) throw new Error('Mounted details props were not found.');
    const props: unknown = Reflect.get(details, propsKey);
    if (!props || typeof props !== 'object') throw new Error('Mounted details props are invalid.');
    const onToggle: unknown = Reflect.get(props, 'onToggle');
    if (typeof onToggle !== 'function') throw new Error('Mounted details have no toggle handler.');
    onToggle({ currentTarget: details });
  });
}

async function mountConversation() {
  const container = installReactDomContainer();
  const root = createRoot(container);
  roots.add(root);
  return {
    container,
    render: async (
      messages: ConversationInput['messages'],
      transientResponses: ConversationInput['transientResponses'] = [],
    ) => {
      await act(async () => {
        root.render(createElement(MountedConversation, { messages, transientResponses }));
      });
    },
  };
}

function plainOperation(messageId: string, seq: bigint, toolName: string, text = ''): Message {
  return create(MessageSchema, {
    messageId,
    threadId: 'thread-1',
    agentId: 'thread',
    seq,
    role: MessageRole.ASSISTANT,
    content: text,
    contentBlocks: text ? [{ type: ContentBlockType.TEXT, blockIndex: 0, text }] : [],
    toolCalls: [
      create(ToolCallSchema, {
        toolCallId: `${toolName}-${messageId}`,
        toolName,
        argumentsJson: '{}',
      }),
    ],
  });
}

describe('mounted operation capsule interactions with direct React handlers', () => {
  it('directly triggers React onToggle and preserves choices across persisted recovery', async () => {
    const mounted = await mountConversation();
    const first = create(MessageSchema, { ...message, seq: 1n });
    const continuation = create(MessageSchema, {
      ...message,
      messageId: 'mounted-continuation',
      seq: 2n,
      content: '',
      contentBlocks: [
        create(ContentBlockSchema, {
          type: ContentBlockType.THINKING,
          blockIndex: 0,
          text: '后续纯思考',
        }),
      ],
      toolCalls: [],
    });
    await mounted.render(
      [first],
      [
        {
          messageId: continuation.messageId,
          runId: 'run-1',
          agentId: 'thread',
          deltaSeq: 1n,
          contentBlocks: continuation.contentBlocks,
        },
      ],
    );

    let groups = mountedGroups(mounted.container);
    expect(groups).toHaveLength(1);
    const groupId = groups[0]?.attributes.get('data-operation');
    expect(groupId).toBe('group:mounted-message:thinking:0');
    expect(groups[0]?.open).toBe(false);
    expect(mountedText(mounted.container as unknown as MountedElement)).not.toContain('后续纯思考');
    expect(
      findMountedElements(
        mounted.container as unknown as MountedElement,
        (element) => element.attributes.get('data-message-id') === continuation.messageId,
      ),
    ).toHaveLength(0);

    const initialGroup = groups[0];
    if (!initialGroup) throw new Error('Missing initial operation capsule.');
    await triggerMountedDetailsToggle(initialGroup);
    expect(mountedGroups(mounted.container)[0]?.open).toBe(true);
    await triggerMountedDetailsToggle(mountedGroups(mounted.container)[0] as MountedElement);
    expect(mountedGroups(mounted.container)[0]?.open).toBe(false);
    await triggerMountedDetailsToggle(mountedGroups(mounted.container)[0] as MountedElement);
    expect(mountedGroups(mounted.container)[0]?.open).toBe(true);
    expect(mountedText(mounted.container as unknown as MountedElement)).not.toContain('后续纯思考');

    const thinkingButtons = findMountedElements(
      mounted.container as unknown as MountedElement,
      (element) =>
        element.tagName.toUpperCase() === 'BUTTON' &&
        (element.attributes.get('class') ?? '').includes('thinking-toggle'),
    );
    expect(thinkingButtons).toHaveLength(2);
    const continuationButton = thinkingButtons[1];
    if (!continuationButton) throw new Error('Missing continuation Thinking button.');
    await act(async () => clickButton(continuationButton));
    expect(
      mountedText(mounted.container as unknown as MountedElement).split('后续纯思考'),
    ).toHaveLength(2);

    await mounted.render([first, continuation]);
    groups = mountedGroups(mounted.container);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.attributes.get('data-operation')).toBe(groupId);
    expect(groups[0]?.open).toBe(true);
    expect(
      mountedText(mounted.container as unknown as MountedElement).split('后续纯思考'),
    ).toHaveLength(2);
    expect(mountedText(mounted.container as unknown as MountedElement)).not.toContain('思考中');

    const persistedGroup = groups[0];
    if (!persistedGroup) throw new Error('Missing persisted operation capsule.');
    await triggerMountedDetailsToggle(persistedGroup);
    await mounted.render([first, continuation]);
    expect(mountedGroups(mounted.container)[0]?.open).toBe(false);
    await triggerMountedDetailsToggle(mountedGroups(mounted.container)[0] as MountedElement);
    expect(
      mountedText(mounted.container as unknown as MountedElement).split('后续纯思考'),
    ).toHaveLength(2);
  });

  it('renders ordinary calls between response text boundaries as separate capsules', async () => {
    const mounted = await mountConversation();
    await mounted.render([
      plainOperation('plain-first', 1n, 'bash'),
      plainOperation('plain-second', 2n, 'read'),
      plainOperation('text-boundary', 3n, 'write', '正文分段'),
      plainOperation('after-text', 4n, 'recall'),
    ]);

    const groups = mountedGroups(mounted.container);
    expect(groups.map((group) => group.attributes.get('data-operation'))).toEqual([
      'group:plain-first:bash-plain-first',
      'group:text-boundary:write-text-boundary',
    ]);
    expect(groups.every((group) => !group.open)).toBe(true);
    expect(mountedText(mounted.container as unknown as MountedElement)).not.toContain('Thinking');
    expect(
      mountedText(mounted.container as unknown as MountedElement).split('正文分段'),
    ).toHaveLength(2);
    for (const mergedMessageId of ['plain-second', 'after-text']) {
      expect(
        findMountedElements(
          mounted.container as unknown as MountedElement,
          (element) => element.attributes.get('data-message-id') === mergedMessageId,
        ),
      ).toHaveLength(0);
    }
  });
});
