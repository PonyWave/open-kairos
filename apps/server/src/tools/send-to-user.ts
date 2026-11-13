import type { AgentTool } from '@kairos/agent-core';
import { z } from 'zod';
import type { ChannelStore } from '../channels/store.js';
import { modelResponseModeEventId } from '../context/output-mode.js';
import { parseJson } from '../context/types.js';
import { SessionError } from '../sessions/errors.js';
import type { RunRecord } from '../sessions/records.js';
import type { SessionStore } from '../sessions/store.js';

const channelIdSchema = z.enum(['wechat', 'feishu']);

const sendToUserInputSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(20_000)
      .refine((value) => value.trim().length > 0)
      .optional(),
    end_turn: z.boolean().optional(),
    channels: z.array(channelIdSchema).min(1).max(2).optional(),
    redeliver_of: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.redeliver_of !== undefined || value.content !== undefined, {
    message: 'content is required unless redeliver_of is set.',
  });

export function createSendToUserTool(options: {
  store: SessionStore;
  source: RunRecord;
  channels?: { store: ChannelStore };
}): AgentTool<z.infer<typeof sendToUserInputSchema>> {
  return {
    name: 'send_to_user',
    description:
      'Deliver one user-facing message in this main conversation; ordinary assistant text is private execution content, never a reply, and must not appear in this conversation. Keep the message as short as the content allows, in plain text without Markdown formatting or filler. Each call creates one message bubble, so keep related paragraphs together and do not fragment one answer. Omit end_turn or set false while work continues; set end_turn true on the final send, as the only tool call in that response, after all work for this reply is complete. A successful final send saves its tool result and ends this reply; a sent message does not imply the user has read it. The message always appears in the GUI; set channels to also deliver it to bound IM channels (wechat or feishu). Use redeliver_of with a failed delivery id to retry that channel delivery without creating a new bubble.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        content: {
          type: 'string',
          minLength: 1,
          maxLength: 20_000,
          description:
            'One complete user-facing message in plain text with real newlines, as short as the content allows. Provide the answer, concrete first step, meaningful update or final result as appropriate. Keep related paragraphs together, use supported facts and avoid Markdown formatting, filler, private reasoning, duplicate updates or sentence fragments. Required unless redeliver_of is set.',
        },
        end_turn: {
          type: 'boolean',
          description:
            'Set true for a complete direct answer, final result or a question that hands control to the user. Finish other work required for this reply first; this must be the only tool call in the response. A successful send saves its result and ends this reply. Omit or set false for an opening acknowledgement or progress update when work continues.',
        },
        channels: {
          type: 'array',
          items: { type: 'string', enum: ['wechat', 'feishu'] },
          minItems: 1,
          maxItems: 2,
          description:
            'IM channels that should also receive this message. Only available in the global main conversation. Each channel is delivered asynchronously after the message is saved; a delivery failure produces a channel delivery failure notice with a delivery id.',
        },
        redeliver_of: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'Retry a failed channel delivery by its delivery id from a delivery failure notice. The original stored content is resent to the same channel; no new message bubble is created. Set only when the failure notice says the error is retryable.',
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
        (intendedInput.end_turn ?? false) !== (input.end_turn ?? false) ||
        JSON.stringify(intendedInput.channels ?? null) !== JSON.stringify(input.channels ?? null) ||
        (intendedInput.redeliver_of ?? null) !== (input.redeliver_of ?? null)
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
      if (input.channels !== undefined && thread.threadType !== 'main') {
        throw new SessionError(
          'invalid_argument',
          'channels delivery is only available in the global main conversation.',
        );
      }

      if (input.redeliver_of !== undefined) {
        const channels = options.channels;
        if (channels === undefined) {
          throw new SessionError('failed_precondition', 'Channel delivery is not configured.');
        }
        let delivery: ReturnType<ChannelStore['getDelivery']>;
        try {
          delivery = channels.store.getDelivery(source.ownerId, input.redeliver_of);
        } catch {
          throw new SessionError('not_found', 'The redeliver_of delivery does not exist.');
        }
        if (delivery.status !== 'failed') {
          throw new SessionError(
            'failed_precondition',
            'Only a failed channel delivery can be redelivered.',
          );
        }
        channels.store.requeueDelivery(source.ownerId, delivery.deliveryId);
        return {
          content: JSON.stringify({
            status: 'sent',
            redelivered: true,
            message_seq: assistant.seq,
            delivery: {
              channel: delivery.channel,
              delivery_id: delivery.deliveryId,
              status: 'queued',
            },
            end_turn: input.end_turn ?? false,
          }),
          status: 'success',
          endTurn: input.end_turn === true,
        };
      }

      const deliveries: {
        channel: 'wechat' | 'feishu';
        delivery_id: string;
        status: 'queued' | 'failed';
        error?: string;
      }[] = [];
      if (input.channels !== undefined) {
        const channels = options.channels;
        if (channels === undefined) {
          throw new SessionError('failed_precondition', 'Channel delivery is not configured.');
        }
        for (const channel of new Set(input.channels)) {
          const state = channels.store.getState(source.ownerId, channel);
          const record = channels.store.createDelivery({
            ownerId: source.ownerId,
            channel,
            messageId: assistant.messageId,
            toolCallId: call.id,
            content: input.content ?? '',
          });
          if (state.status !== 'active' || state.externalUserId === null) {
            const failed = channels.store.markAttemptFailed(
              source.ownerId,
              record.deliveryId,
              {
                code: 'channel_not_bound',
                message: `${channel === 'wechat' ? '微信' : '飞书'}渠道未登录或未绑定用户。`,
                retryable: false,
              },
              null,
            );
            deliveries.push({
              channel,
              delivery_id: record.deliveryId,
              status: 'failed',
              error: failed.lastErrorMessage ?? 'channel_not_bound',
            });
            continue;
          }
          deliveries.push({ channel, delivery_id: record.deliveryId, status: 'queued' });
        }
      }
      return {
        content: JSON.stringify({
          status: 'sent',
          content: input.content,
          message_seq: assistant.seq,
          end_turn: input.end_turn ?? false,
          ...(deliveries.length === 0 ? {} : { deliveries }),
        }),
        status: 'success',
        endTurn: input.end_turn === true,
      };
    },
  };
}
