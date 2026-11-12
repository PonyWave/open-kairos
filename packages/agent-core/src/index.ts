export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  block_index?: number | undefined;
}

export interface IncompleteToolCall {
  id?: string;
  name?: string;
  arguments_text: string;
  error: string;
}

export type ToolErrorCode =
  | 'incomplete_call'
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'execution_failed'
  | 'cancelled';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
}

export interface ContentBlock {
  type: 'text' | 'thinking';
  block_index: number;
  text: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  content_blocks?: readonly ContentBlock[];
  tool_calls?: readonly ToolCall[];
  incomplete_tool_calls?: readonly IncompleteToolCall[];
}

export interface ToolMessage {
  role: 'tool';
  content: string;
  content_parts?: readonly UserContentBlock[];
  tool_call_id: string;
  tool_name: string;
  status?: 'success' | 'error';
  error?: ToolError;
}

export interface UserTextContentBlock {
  type: 'text';
  text: string;
}

export interface UserImageUrlContentBlock {
  type: 'image_url';
  image_url: { url: string; detail: 'low' };
}

export interface AttachmentContentBlock {
  type: 'attachment';
  attachment_id: string;
  workspace_required?: boolean | undefined;
  path?: string | undefined;
}

export type UserContentBlock =
  | UserTextContentBlock
  | UserImageUrlContentBlock
  | AttachmentContentBlock;

export interface UserMessage {
  role: 'user';
  content: string;
  content_parts?: readonly UserContentBlock[] | undefined;
}

export type ModelMessage =
  | { role: 'system'; content: string }
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export interface ModelRequest {
  messages: readonly ModelMessage[];
  tools: readonly {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[];
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
}

export interface DetailedModelUsage extends ModelUsage {
  prompt_tokens_details?: {
    cached_tokens: number;
  };
}

export interface ModelStreamError {
  code: 'stream_interrupted';
  message: string;
}

export type ModelEvent =
  | { type: 'text_delta'; text: string; block_index?: number }
  | { type: 'thinking_delta'; text: string; block_index: number }
  | {
      type: 'response';
      message: AssistantMessage;
      usage: DetailedModelUsage;
    }
  | {
      type: 'stream_interrupted';
      error: ModelStreamError;
      usage?: DetailedModelUsage;
    };

export interface ModelMessageSource {
  messageIndex?: number;
  inputItemIndexes?: readonly number[];
  contentBlockIndexes?: readonly number[];
}

export interface ModelProvider {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  mapMessageIndex?(request: ModelRequest, messageIndex: number): number;
  mapMessageSource?(request: ModelRequest, messageIndex: number): ModelMessageSource;
}

export * from './agent-loop.js';
