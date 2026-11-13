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
    if (!value || typeof value !== 'object') {
      return Array.isArray(value) ? { ...fallback, output: prettyJson(value) } : fallback;
    }
    if (Array.isArray(value)) return { ...fallback, output: prettyJson(value) };
    const status = stringField(value, 'status');
    return {
      output:
        stringField(value, 'output') ??
        stringField(value, 'response') ??
        stringField(value, 'error') ??
        stringField(value, 'text') ??
        stringField(value, 'content') ??
        nestedOutcomeText(value) ??
        prettyJson(value),
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

function nestedOutcomeText(value: object): string | null {
  const outcome = Reflect.get(value, 'outcome');
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return null;
  return (
    stringField(outcome, 'content') ??
    stringField(outcome, 'output') ??
    stringField(outcome, 'text') ??
    stringField(outcome, 'error')
  );
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatToolArguments(argumentsJson: string): string {
  try {
    return prettyJson(JSON.parse(argumentsJson));
  } catch {
    return argumentsJson;
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
