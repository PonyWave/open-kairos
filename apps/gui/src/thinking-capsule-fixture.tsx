import { createRouterTransport } from '@connectrpc/connect';
import {
  ContentBlockSchema,
  ContentBlockType,
  create,
  type Message,
  MessageRole,
  MessageSchema,
  ToolCallSchema,
  ToolResultStatus,
} from '@kairos/contracts';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createKairosClients } from './client.js';
import { projectConversationDisplay } from './conversation-display-projection.js';
import { MessageCard } from './message-card.js';
import { type ConversationItem, projectConversation } from './response-projection.js';
import './styles.css';
import './motion.css';
import {
  type ThinkingExpansionChoices,
  thinkingBlockKey,
  withThinkingBlockExpanded,
} from './thinking-expansion.js';
import type { ToolExpansionChoices } from './tool-call-groups.js';
import {
  projectAssociatedToolResultIds,
  projectToolOutcomes,
  withToolExpanded,
} from './tool-group-projection.js';

const threadId = 'fixture-thread';
const groupId = 'group:fixture-first:thinking:0';
const continuationThinkingKey = thinkingBlockKey('fixture-second', 0);
const clients = createKairosClients({ transport: createRouterTransport(() => {}) });

type ConversationInput = Parameters<typeof projectConversation>[0];

function thinkingBlock(text: string) {
  return create(ContentBlockSchema, {
    type: ContentBlockType.THINKING,
    blockIndex: 0,
    text,
  });
}

function toolOperation(messageId: string, seq: bigint, toolName: string, blockIndex = 0): Message {
  return create(MessageSchema, {
    messageId,
    threadId,
    agentId: 'thread',
    runId: 'fixture-run',
    seq,
    role: MessageRole.ASSISTANT,
    toolCalls: [
      create(ToolCallSchema, {
        toolCallId: `${toolName}-${messageId}`,
        toolName,
        argumentsJson: '{}',
        blockIndex,
      }),
    ],
  });
}

const operations: Message[] = [
  create(MessageSchema, {
    ...toolOperation('fixture-first', 1n, 'bash', 1),
    contentBlocks: [thinkingBlock('第一段思考')],
  }),
  create(MessageSchema, {
    messageId: 'fixture-second',
    threadId,
    agentId: 'thread',
    runId: 'fixture-run',
    seq: 2n,
    role: MessageRole.ASSISTANT,
    contentBlocks: [thinkingBlock('后续纯思考')],
  }),
  toolOperation('fixture-third', 3n, 'read'),
  create(MessageSchema, {
    messageId: 'fixture-fourth',
    threadId,
    agentId: 'thread',
    runId: 'fixture-run',
    seq: 4n,
    role: MessageRole.ASSISTANT,
    contentBlocks: [thinkingBlock('第四段思考')],
  }),
];

function transientOperation(operation: Message): ConversationInput['transientResponses'][number] {
  return {
    messageId: operation.messageId,
    runId: operation.runId,
    agentId: operation.agentId,
    deltaSeq: operation.seq,
    contentBlocks: operation.contentBlocks,
  };
}

function FixtureConversation({ stage }: { stage: number }) {
  const [thinkingChoices, setThinkingChoices] = useState<ThinkingExpansionChoices>({});
  const [toolChoices, setToolChoices] = useState<ToolExpansionChoices>({});
  const persistedCount = stage === 0 ? 1 : stage === 1 || stage === 2 ? 3 : 4;
  const transientResponses =
    stage === 0
      ? operations.slice(1, 2).map(transientOperation)
      : stage === 2
        ? operations.slice(3, 4).map(transientOperation)
        : [];
  const items = projectConversation({
    threadId,
    messages: operations.slice(0, persistedCount),
    transientResponses,
    runs: [],
  });
  const expansionState = {
    group: toolChoices[groupId] ?? null,
    thinking: thinkingChoices[continuationThinkingKey] ?? null,
  };
  return (
    <>
      <output id="fixture-expansion-state" hidden>
        {JSON.stringify(expansionState)}
      </output>
      {items.flatMap((item) =>
        item.kind === 'message' ? (
          <MessageCard
            key={item.key}
            message={item.value.message}
            delegationCall={item.value.delegationCall}
            clients={clients}
            busy={false}
            editing={false}
            streaming={item.value.streaming}
            thinkingExpansionChoices={thinkingChoices}
            toolOutcomes={new Map()}
            toolItems={item.value.toolItems}
            mergedThinkingBlockIndexes={item.value.mergedThinkingBlockIndexes}
            toolExpansionChoices={toolChoices}
            onToolExpansionChange={(operationId, expanded) =>
              setToolChoices((current) => withToolExpanded(current, operationId, expanded))
            }
            onThinkingExpansionChange={(messageId, blockIndex, expanded) =>
              setThinkingChoices((current) =>
                withThinkingBlockExpanded(current, messageId, blockIndex, expanded),
              )
            }
            onStartEditing={() => {}}
            onCancelEditing={() => {}}
            onRevise={async () => {}}
            onRerun={async () => {}}
          />
        ) : (
          []
        ),
      )}
    </>
  );
}

function FixtureMessages({
  items,
  messages,
}: {
  items: readonly ConversationItem[];
  messages: readonly Message[];
}) {
  const [thinkingChoices, setThinkingChoices] = useState<ThinkingExpansionChoices>({});
  const [toolChoices, setToolChoices] = useState<ToolExpansionChoices>({});
  const outcomes = projectToolOutcomes(messages);
  const associated = projectAssociatedToolResultIds(messages, outcomes);
  return (
    <>
      {items.flatMap((item) =>
        item.kind === 'message' ? (
          <MessageCard
            {...item.value}
            key={item.key}
            clients={clients}
            busy={false}
            editing={false}
            thinkingExpansionChoices={thinkingChoices}
            toolOutcomes={outcomes}
            associatedToolResultIds={associated}
            toolExpansionChoices={toolChoices}
            onToolExpansionChange={(operationId, expanded) =>
              setToolChoices((current) => withToolExpanded(current, operationId, expanded))
            }
            onThinkingExpansionChange={(messageId, blockIndex, expanded) =>
              setThinkingChoices((current) =>
                withThinkingBlockExpanded(current, messageId, blockIndex, expanded),
              )
            }
            onStartEditing={() => {}}
            onCancelEditing={() => {}}
            onRevise={async () => {}}
            onRerun={async () => {}}
          />
        ) : (
          []
        ),
      )}
    </>
  );
}

function standaloneItems(message: Message): ConversationItem[] {
  return projectConversation({
    threadId,
    messages: [message],
    transientResponses: [],
    runs: [],
  });
}

const orderedMessage = create(MessageSchema, {
  messageId: 'ordered-fixture',
  threadId,
  agentId: 'thread',
  role: MessageRole.ASSISTANT,
  content: '正文之前正文之后',
  contentBlocks: [
    create(ContentBlockSchema, { type: ContentBlockType.TEXT, blockIndex: 0, text: '正文之前' }),
    create(ContentBlockSchema, {
      type: ContentBlockType.THINKING,
      blockIndex: 1,
      text: '第一段有序思考',
    }),
    create(ContentBlockSchema, {
      type: ContentBlockType.THINKING,
      blockIndex: 2,
      text: '第二段有序思考',
    }),
    create(ContentBlockSchema, { type: ContentBlockType.TEXT, blockIndex: 3, text: '正文之后' }),
  ],
  toolCalls: [
    create(ToolCallSchema, {
      toolCallId: 'read-ordered',
      toolName: 'read',
      argumentsJson: '{"marker":"read-ordered"}',
      blockIndex: 2,
    }),
    create(ToolCallSchema, {
      toolCallId: 'bash-ordered',
      toolName: 'bash',
      argumentsJson: '{"marker":"bash-ordered"}',
      blockIndex: 3,
    }),
  ],
});
const singleToolMessage = create(MessageSchema, {
  messageId: 'single-tool-fixture',
  threadId,
  agentId: 'thread',
  role: MessageRole.ASSISTANT,
  toolCalls: [
    create(ToolCallSchema, {
      toolCallId: 'single-tool-call',
      toolName: 'read',
      argumentsJson: '{}',
      blockIndex: 0,
    }),
  ],
});
const singleThinkingMessage = create(MessageSchema, {
  messageId: 'single-thinking-fixture',
  threadId,
  agentId: 'thread',
  role: MessageRole.ASSISTANT,
  content: '后续正文',
  contentBlocks: [
    create(ContentBlockSchema, {
      type: ContentBlockType.THINKING,
      blockIndex: 0,
      text: '唯一思考',
    }),
    create(ContentBlockSchema, {
      type: ContentBlockType.TEXT,
      blockIndex: 1,
      text: '后续正文',
    }),
  ],
});
const twoThinkingMessage = create(MessageSchema, {
  messageId: 'two-thinking-fixture',
  threadId,
  agentId: 'thread',
  role: MessageRole.ASSISTANT,
  contentBlocks: [
    create(ContentBlockSchema, {
      type: ContentBlockType.THINKING,
      blockIndex: 0,
      text: '第一段独立思考',
    }),
    create(ContentBlockSchema, {
      type: ContentBlockType.THINKING,
      blockIndex: 1,
      text: '第二段独立思考',
    }),
  ],
});
const sendMessages = [
  create(MessageSchema, {
    messageId: 'send-source',
    threadId,
    agentId: 'thread',
    role: MessageRole.ASSISTANT,
    sendToUserEnabled: true,
    toolCalls: [
      create(ToolCallSchema, {
        toolCallId: 'send-1',
        toolName: 'send_to_user',
        argumentsJson: '{"content":"正式回复","end_turn":false}',
        blockIndex: 0,
      }),
    ],
  }),
  create(MessageSchema, {
    messageId: 'send-result',
    threadId,
    agentId: 'thread',
    role: MessageRole.TOOL,
    toolCallId: 'send-1',
    toolName: 'send_to_user',
    toolStatus: ToolResultStatus.SUCCESS,
    sendToUserEnabled: true,
    content: '{"status":"sent","content":"正式回复","end_turn":false}',
  }),
];
const sendProjection = projectConversation({
  threadId,
  messages: sendMessages,
  transientResponses: [],
  runs: [],
});

function AdditionalFixtures() {
  return (
    <>
      <section id="ordered-fixture">
        <FixtureMessages items={standaloneItems(orderedMessage)} messages={[orderedMessage]} />
      </section>
      <section id="single-tool-fixture">
        <FixtureMessages
          items={standaloneItems(singleToolMessage)}
          messages={[singleToolMessage]}
        />
      </section>
      <section id="single-thinking-fixture">
        <FixtureMessages
          items={standaloneItems(singleThinkingMessage)}
          messages={[singleThinkingMessage]}
        />
      </section>
      <section id="two-thinking-fixture">
        <FixtureMessages
          items={standaloneItems(twoThinkingMessage)}
          messages={[twoThinkingMessage]}
        />
      </section>
      <section id="full-send-fixture">
        <FixtureMessages
          items={projectConversationDisplay(sendProjection, [], 'full')}
          messages={sendMessages}
        />
      </section>
      <section id="compact-send-fixture">
        <FixtureMessages
          items={projectConversationDisplay(sendProjection, [], 'compact')}
          messages={sendMessages}
        />
      </section>
    </>
  );
}

function FixtureApp() {
  const [stage, setStage] = useState(0);
  return (
    <main>
      <div>
        <button id="append-third" type="button" disabled={stage !== 0} onClick={() => setStage(1)}>
          追加第三条操作
        </button>
        <button id="append-fourth" type="button" disabled={stage !== 1} onClick={() => setStage(2)}>
          追加第四条操作
        </button>
        <button id="persist" type="button" disabled={stage !== 2} onClick={() => setStage(3)}>
          持久化全部操作
        </button>
      </div>
      <div id="capsule-fixture">
        <div id="fixture-conversation" data-stage={stage}>
          <FixtureConversation stage={stage} />
        </div>
      </div>
      <AdditionalFixtures />
    </main>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing fixture root.');
createRoot(container).render(<FixtureApp />);
