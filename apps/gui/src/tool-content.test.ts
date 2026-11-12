import { describe, expect, it } from 'vitest';
import { parseToolContent } from './tool-content.js';

describe('parseToolContent', () => {
  it('preserves execution facts and distinguishes missing exit codes', () => {
    const result = parseToolContent(
      JSON.stringify({
        output: 'preview',
        output_complete: false,
        truncated: true,
      }),
    );
    expect(result.outputComplete).toBe(false);
    expect(result.exitCode).toBeNull();
  });

  it('keeps zero as a known successful exit code', () => {
    expect(parseToolContent('{"exit_code":0,"output":"ok"}').exitCode).toBe(0);
  });

  it('reports unknown results without executing embedded content', () => {
    const result = parseToolContent('{"status":"unknown","output":"<script>alert(1)</script>"}');
    expect(result.resultUnknown).toBe(true);
    expect(result.output).toBe('<script>alert(1)</script>');
  });

  it('distinguishes an offline device from an unknown command result', () => {
    const result = parseToolContent('{"status":"device_offline","output":"设备离线"}');
    expect(result.deviceOffline).toBe(true);
    expect(result.resultUnknown).toBe(false);
  });
});
