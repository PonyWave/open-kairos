import { Code, ConnectError } from '@connectrpc/connect';
import { ErrorCode, ErrorDetailSchema } from '@kairos/contracts';
import { describe, expect, it } from 'vitest';
import { ActionPayloadError } from './actions.js';
import { classifyActionFailure } from './errors.js';

function businessError(
  code: ErrorCode,
  transportCode = Code.Aborted,
  terminal?: boolean,
): ConnectError {
  return new ConnectError('rejected', transportCode, undefined, [
    {
      desc: ErrorDetailSchema,
      value: {
        code,
        message: 'rejected',
        retryable: false,
        ...(terminal === undefined ? {} : { terminal }),
      },
    },
  ]);
}

describe('classifyActionFailure', () => {
  it.each([
    ErrorCode.UNAUTHENTICATED,
    ErrorCode.PERMISSION_DENIED,
    ErrorCode.VERSION_CONFLICT,
    ErrorCode.ACTION_CONFLICT,
    ErrorCode.DEVICE_OFFLINE,
    ErrorCode.RECAP_INVALID,
    ErrorCode.INPUT_TOO_LARGE,
    ErrorCode.PROTOCOL_INCOMPATIBLE,
    ErrorCode.INVALID_ARGUMENT,
    ErrorCode.NOT_FOUND,
    ErrorCode.FAILED_PRECONDITION,
  ])('treats business rejection %s as not executed', (code) => {
    expect(classifyActionFailure(businessError(code))).toBe('not-executed');
  });

  it.each([
    Code.InvalidArgument,
    Code.NotFound,
    Code.FailedPrecondition,
    Code.Unauthenticated,
    Code.PermissionDenied,
    Code.Unimplemented,
    Code.OutOfRange,
  ])('treats RPC rejection %s as not executed', (code) => {
    expect(classifyActionFailure(new ConnectError('rejected', code))).toBe('not-executed');
  });

  it.each([
    Code.Canceled,
    Code.Unknown,
    Code.DeadlineExceeded,
    Code.AlreadyExists,
    Code.Aborted,
    Code.ResourceExhausted,
    Code.Internal,
    Code.Unavailable,
    Code.DataLoss,
  ])('keeps RPC failure %s unknown', (code) => {
    expect(classifyActionFailure(new ConnectError('uncertain', code))).toBe('unknown');
  });

  it('requires a business detail before treating Aborted as a version conflict', () => {
    expect(classifyActionFailure(new ConnectError('aborted', Code.Aborted))).toBe('unknown');
    expect(classifyActionFailure(businessError(ErrorCode.VERSION_CONFLICT))).toBe('not-executed');
  });

  it.each([ErrorCode.OPERATION_UNKNOWN, ErrorCode.INTERNAL])(
    'keeps business failure %s unknown even with a rejecting RPC code',
    (code) => {
      expect(classifyActionFailure(businessError(code, Code.InvalidArgument))).toBe('unknown');
    },
  );

  it.each([ErrorCode.OPERATION_UNKNOWN, ErrorCode.INTERNAL])(
    'marks business failure %s terminal only with an explicit terminal detail',
    (code) => {
      expect(classifyActionFailure(businessError(code, Code.Internal, true))).toBe('terminal');
      expect(classifyActionFailure(businessError(code, Code.Internal, false))).toBe('unknown');
      expect(classifyActionFailure(businessError(code, Code.Internal))).toBe('unknown');
    },
  );

  it('requires every business detail to be explicitly terminal', () => {
    const detail = (terminal: boolean) => ({
      desc: ErrorDetailSchema,
      value: {
        code: ErrorCode.INTERNAL,
        message: 'persisted failure',
        retryable: false,
        terminal,
      },
    });
    expect(
      classifyActionFailure(
        new ConnectError('mixed', Code.Internal, undefined, [detail(true), detail(false)]),
      ),
    ).toBe('unknown');
    expect(
      classifyActionFailure(
        new ConnectError('terminal', Code.Internal, undefined, [detail(true), detail(true)]),
      ),
    ).toBe('terminal');
  });

  it('keeps the existing not-executed classification when terminal is false', () => {
    expect(
      classifyActionFailure(
        businessError(ErrorCode.FAILED_PRECONDITION, Code.FailedPrecondition, false),
      ),
    ).toBe('not-executed');
  });

  it.each([ErrorCode.UNSPECIFIED, 99 as ErrorCode])(
    'keeps unrecognized business detail %s unknown with a rejecting RPC code',
    (code) => {
      expect(classifyActionFailure(businessError(code, Code.InvalidArgument))).toBe('unknown');
    },
  );

  it('distinguishes local payload validation from completion failures', () => {
    expect(classifyActionFailure(new ActionPayloadError())).toBe('not-executed');
    expect(classifyActionFailure(new Error('completion failed'))).toBe('unknown');
  });
});
