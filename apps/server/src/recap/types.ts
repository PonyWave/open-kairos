export type RecapValidity = 'valid' | 'invalid';

export type RecapErrorCode =
  | 'incomplete_tool_round_trip'
  | 'invalid_recap'
  | 'recap_coverage_error'
  | 'recap_not_found';

export class RecapError extends Error {
  readonly code: RecapErrorCode;

  constructor(code: RecapErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecapError';
    this.code = code;
  }
}

export interface Recap {
  recapId: string;
  threadId: string;
  agentId: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  sourceMessageSeqs: readonly number[];
  sourceCreatedAtStart: string;
  sourceCreatedAtEnd: string;
  content: string;
  createdAt: string;
  validity: RecapValidity;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface SaveRecapInput {
  threadId: string;
  agentId: string;
  sourceMessageSeqs: readonly number[];
  content: string;
  recapId?: string;
  createdAt?: string;
}

export interface RecapQuery {
  threadId: string;
  agentId: string;
  recapId?: string;
  validity?: RecapValidity;
  query?: string;
  fromSeq?: number;
  toSeq?: number;
  limit?: number;
  offset?: number;
}

export interface RecapSourceGroup {
  sourceMessageSeqs: readonly number[];
}
