import type { AgentTool } from '@kairos/agent-core';
import { z } from 'zod';
import { modelResponseModeEventId } from '../context/output-mode.js';
import { parseJson } from '../context/types.js';
import { SessionError } from '../sessions/errors.js';
import type { RunRecord } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';

const sendToUserInputSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(20_000)
      .refine((value) => value.trim().length > 0),
    end_turn: z.boolean().optional(),
  })
  .strict();

export function createSendToUserTool(options: {
  store: SessionStore;
  source: RunRecord;
}): AgentTool<z.infer<typeof sendToUserInputSchema>> {
  return {
    name: 'send_to_user',
    description:
      'Deliver one user-facing message in this main conversation; ordinary assistant text is private execution content, never a reply. Keep the message as short as the content allows, in plain text without Markdown formatting or filler. Each call creates one message bubble, so keep related paragraphs together and do not fragment one answer. Omit end_turn or set false while work continues; set end_turn true on the final send, as the only tool call in that response, after all work for this reply is complete. A successful final send saves its tool result and ends this reply; a sent message does not imply the user has read it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content'],
      properties: {
        content: {
          type: 'string',
          minLength: 1,
          maxLength: 20_000,
          description:
            'One complete user-facing message in plain text with real newlines, as short as the content allows. Provide the answer, concrete first step, meaningful update or final result as appropriate. Keep related paragraphs together, use supported facts and avoid Markdown formatting, filler, private reasoning, duplicate updates or sentence fragments.',
        },
        end_turn: {
          type: 'boolean',
          description:
            'Set true for a complete direct answer, final result or a question that hands control to the user. Finish other work required for this reply first; this must be the only tool call in the response. A successful send saves its result and ends this reply. Omit or set false for an opening acknowledgement or progress update when work continues.',
        },
      },
    },
    validate: (value) => sendToUserInputSchema.parse(value),
    execute: async (input, { signal, call }) => {
      signal.throwIfAborted();
      const { source, store } = options;
      const thread = store.getThread(source.ownerId, source.threadId);
      const currentRun = store.getRunById(source.runId);
      if (
        source.agentId !== 'thread' ||
        source.parentRunId !== null ||
        (thread.threadType !== 'main' && thread.threadType !== 'workspace_main')
      ) {
        throw new SessionError(
          'permission_denied',
          'send_to_user requires a main conversation root Agent.',
        );
      }
      if (currentRun.generation !== source.generation) {
        throw new SessionError('action_conflict', 'The send_to_user execution changed.');
      }
      const relation = store.context
        .listToolCallRelations(source.threadId, source.agentId, { currentOnly: true })
        .find((candidate) => candidate.callId === call.id);
      const assistant =
        relation === undefined
          ? undefined
          : store.context.get(source.threadId, source.agentId, relation.assistantSeq);
      if (
        relation?.toolName !== 'send_to_user' ||
        relation.callType !== 'complete' ||
        relation.resultSeq !== null ||
        assistant?.runId !== source.runId ||
        assistant.message.role !== 'assistant'
      ) {
        throw new SessionError('failed_precondition', 'The send_to_user intent is not persisted.');
      }
      const responseMode = z
        .object({ payload_json: z.string() })
        .optional()
        .parse(
          store.database
            .prepare('SELECT payload_json FROM context_events WHERE event_id = ?')
            .get(modelResponseModeEventId(assistant.messageId)),
        );
      if (
        responseMode !== undefined &&
        z
          .object({ generation: z.number().int().positive() })
          .parse(parseJson(responseMode.payload_json, 'model_response_mode')).generation !==
          source.generation
      ) {
        throw new SessionError(
          'action_conflict',
          'The send_to_user intent belongs to an earlier execution.',
        );
      }
      const intended = assistant.message.tool_calls?.find((candidate) => candidate.id === call.id);
      const intendedInput = sendToUserInputSchema.parse(intended?.arguments);
      if (
        intended?.name !== 'send_to_user' ||
        intendedInput.content !== input.content ||
        (intendedInput.end_turn ?? false) !== (input.end_turn ?? false)
      ) {
        throw new SessionError('action_conflict', 'The send_to_user parameters changed.');
      }
      if (
        input.end_turn === true &&
        (assistant.message.tool_calls?.length ?? 0) +
          (assistant.message.incomplete_tool_calls?.length ?? 0) !==
          1
      ) {
        throw new SessionError(
          'invalid_argument',
          'A final send_to_user must be the only tool call in its response.',
        );
      }
      return {
        content: JSON.stringify({
          status: 'sent',
          content: input.content,
          end_turn: input.end_turn ?? false,
        }),
        status: 'success',
        endTurn: input.end_turn === true,
      };
    },
  };
}
