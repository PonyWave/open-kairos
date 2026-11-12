export interface ToolContentView {
  output: string;
  toolCallId: string | null;
  threadId: string | null;
  status: string | null;
  truncated: boolean | null;
  outputComplete: boolean | null;
  resultUnknown: boolean;
  deviceOffline: boolean;
  exitCode: number | null;
}

export function parseToolContent(content: string): ToolContentView {
  const fallback: ToolContentView = {
    output: content,
    toolCallId: null,
    threadId: null,
    status: null,
    truncated: null,
    outputComplete: null,
    resultUnknown: false,
    deviceOffline: false,
    exitCode: null,
  };
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    const status = stringField(value, 'status');
    return {
      output:
        stringField(value, 'output') ??
        stringField(value, 'response') ??
        stringField(value, 'error') ??
        content,
      toolCallId: stringField(value, 'tool_call_id'),
      threadId: stringField(value, 'thread_id'),
      status,
      truncated: booleanField(value, 'truncated'),
      outputComplete: booleanField(value, 'output_complete'),
      resultUnknown: status === 'unknown' || booleanField(value, 'result_unknown') === true,
      deviceOffline:
        status === 'offline' ||
        status === 'device_offline' ||
        booleanField(value, 'device_offline') === true,
      exitCode: numberField(value, 'exit_code'),
    };
  } catch {
    return fallback;
  }
}

function stringField(value: object, key: string): string | null {
  const field = Reflect.get(value, key);
  return typeof field === 'string' ? field : null;
}

function booleanField(value: object, key: string): boolean | null {
  const field = Reflect.get(value, key);
  return typeof field === 'boolean' ? field : null;
}

function numberField(value: object, key: string): number | null {
  const field = Reflect.get(value, key);
  return typeof field === 'number' && Number.isInteger(field) ? field : null;
}
