import type { DatabaseSync } from 'node:sqlite';
import { BashStatus, OutputStream } from '@kairos/contracts/device';

const recordedAt = '2026-01-01T00:00:00.000Z';

export function seedHistoricalDevice(
  database: DatabaseSync,
  ownerId: string,
  deviceId = 'historical-device',
): string {
  database
    .prepare(
      `INSERT INTO devices(
        device_id, owner_id, device_name, account_description, bash_enabled,
        credential_hash, status, created_at, updated_at, paired_at
      ) VALUES (?, ?, 'Historical device', 'Audit fixture', 0, NULL, 'active', ?, ?, ?)`,
    )
    .run(deviceId, ownerId, recordedAt, recordedAt, recordedAt);
  return deviceId;
}

export function seedHistoricalBashOperation(
  database: DatabaseSync,
  input: {
    operationId: string;
    ownerId: string;
    deviceId: string;
    runId: string;
    status?: BashStatus;
    exitCode?: number;
    outputComplete?: boolean;
    endOffset?: bigint;
    chunks?: Array<{ offset: bigint; data: Uint8Array; stream?: OutputStream }>;
  },
): void {
  const chunks = [...(input.chunks ?? [])].sort((left, right) =>
    left.offset < right.offset ? -1 : left.offset > right.offset ? 1 : 0,
  );
  let contiguous = 0n;
  for (const chunk of chunks) {
    if (chunk.offset === contiguous) contiguous += BigInt(chunk.data.length);
  }
  const end = input.endOffset ?? contiguous;
  const status = input.status ?? BashStatus.COMPLETED;
  const complete = input.outputComplete ?? true;
  database
    .prepare(
      `INSERT INTO device_bash_operations(
        operation_id, owner_id, device_id, run_id, command, cwd, expires_at,
        timeout_seconds, target_instance_id, delivery_state, status, cancel_requested,
        next_offset, result_status, exit_code, device_output_complete, result_end_offset,
        output_complete, output_gap, result_source, result_recorded_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'historical command', '/tmp', ?, 60, 'historical-instance',
        'sent', ?, 0, ?, ?, ?, ?, ?, ?, ?, 'device', ?, ?, ?)`,
    )
    .run(
      input.operationId,
      input.ownerId,
      input.deviceId,
      input.runId,
      recordedAt,
      status,
      contiguous.toString().padStart(20, '0'),
      status,
      input.exitCode ?? null,
      complete ? 1 : 0,
      end.toString().padStart(20, '0'),
      complete && end === contiguous ? 1 : 0,
      end > contiguous ? 1 : 0,
      recordedAt,
      recordedAt,
      recordedAt,
    );
  for (const chunk of chunks) {
    database
      .prepare(
        `INSERT INTO device_bash_output_chunks(operation_id, offset, end_offset, stream, data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.operationId,
        chunk.offset.toString().padStart(20, '0'),
        (chunk.offset + BigInt(chunk.data.length)).toString().padStart(20, '0'),
        chunk.stream ?? OutputStream.STDOUT,
        chunk.data,
      );
  }
}
