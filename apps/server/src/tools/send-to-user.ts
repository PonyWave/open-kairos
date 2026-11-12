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
      'send_to_user is the only way to deliver a reply in this main conversation. Ordinary assistant text is private execution content, not a reply; the full view is diagnostic only. Use send_to_user first for every human message, including a follow-up while working. When no other work is needed, make exactly one call with end_turn true as the first and only action, including identity questions such as "Who are you?" and "你是谁", greetings and short factual answers; do not write the answer as ordinary assistant text. Otherwise acknowledge the request and state your first step before reasoning at length, using execution tools or delegating. A task card is not that reply. Send progress only for a meaningful finding, decision, changed plan or blocker, without command-by-command narration or duplicate updates. Before yielding, deliver the requested result or explain the actual limitation and next action; an acknowledgement or pointer to earlier messages is not final delivery. Verify completion before claiming it. Each call creates its own bubble, so keep related paragraphs together, use real newlines and do not fragment one answer. Omit end_turn or use false while continuing work; use true on the final send, as the only tool call in that response, after other required work and sends are complete. A successful final send saves its tool result and ends this reply without another model request unless new input is waiting. It does not cancel background work or prove that the user has read the message. Background or scheduled wakes need no opening acknowledgement; report useful awaited results and stay silent for unchanged, stale or already delivered updates.',
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
            'One complete user-facing Markdown message with real newlines. Provide the answer, concrete first step, meaningful update or final result as appropriate. Keep related paragraphs together, use supported facts and avoid private reasoning, duplicate updates or sentence fragments.',
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
        thread.threadType !== 'main'
      ) {
        throw new SessionError('permission_denied', 'send_to_user requires the main root Agent.');
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
