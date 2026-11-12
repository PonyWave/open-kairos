import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { parseJson } from './types.js';

export function modelResponseModeEventId(messageId: string): string {
  return `model_response_mode:${messageId}`;
}

export function modelExecutionModeEventId(runId: string, generation: number): string {
  return `model_output_mode:${runId}:${generation}`;
}

export function readSendToUserMode(
  database: DatabaseSync,
  eventId: string,
  threadId: string,
  agentId: string,
): boolean | undefined {
  const row = z
    .object({ payload_json: z.string() })
    .optional()
    .parse(
      database
        .prepare(
          'SELECT payload_json FROM context_events WHERE event_id = ? AND thread_id = ? AND agent_id = ?',
        )
        .get(eventId, threadId, agentId),
    );
  return row === undefined
    ? undefined
    : z
        .object({ send_to_user_enabled: z.boolean() })
        .parse(parseJson(row.payload_json, 'output_mode')).send_to_user_enabled;
}

export function requestUsesSendToUser(database: DatabaseSync, requestId: string): boolean {
  const row = z
    .object({ request_json: z.string() })
    .parse(
      database
        .prepare('SELECT request_json FROM model_request_records WHERE request_id = ?')
        .get(requestId),
    );
  const request = z
    .object({ tools: z.array(z.object({ name: z.string() })) })
    .parse(parseJson(row.request_json, 'model_request'));
  return request.tools.some((tool) => tool.name === 'send_to_user');
}
