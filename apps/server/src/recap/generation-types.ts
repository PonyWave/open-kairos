import type { ModelMessage, ModelRequest } from '@kairos/agent-core';

export interface RecapSourceMessage {
  seq: number;
  createdAt: string;
  message: ModelMessage;
}

export interface RecapSourceMessageIndex {
  seq: number;
  messageIndex: number;
}

export interface RecapGenerationInput {
  threadId: string;
  agentId: string;
  sourceMessageSeqs: readonly number[];
  sourceMessageIndexes: readonly RecapSourceMessageIndex[];
  messages: readonly RecapSourceMessage[];
  request: ModelRequest;
  viewVersion: number;
  trigger: 'hard_cut' | 'periodic';
}

export type RecapGenerator = (
  input: RecapGenerationInput,
  signal: AbortSignal,
) => Promise<{ content: string }>;
