// Wire types of the verify API (docs/DESIGN.md section 5.1), shared by the server, the widget
// and the SDKs.

import type { PowChallenge } from './pow.js';

export const API_PREFIX = '/api/v1';

/** Stable error codes. */
export type ErrorCode =
  | 'invalid-sitekey'
  | 'invalid-secret'
  | 'invalid-input-response'
  | 'timeout-or-duplicate'
  | 'hostname-mismatch'
  | 'rate-limited'
  | 'bad-pow'
  | 'wrong-answer'
  | 'bad-request'
  /** siteverify: the `action` the site sent is not the one bound into the token. */
  | 'action-mismatch'
  | 'store-unavailable';

export type ChallengeType = 'proverb';

export interface ProverbOption {
  id: string;
  text: string;
}

export interface ProverbQuestion {
  prompt: string;
  options: ProverbOption[];
}

/** One question below level 4; two at level 4 and above. */
export interface ProverbDisplay {
  questions: ProverbQuestion[];
}

export interface ChallengeResponse {
  sealed: string;
  type: ChallengeType;
  display: ProverbDisplay;
  pow: PowChallenge;
  /** Unix milliseconds. */
  expires: number;
}

export interface SolveRequest {
  sealed: string;
  /** One option id per question. */
  answer: string[];
  /** base64 ALTCHA payload. */
  pow: string;
}

export interface SolveOk {
  token: string;
  /** Unix milliseconds. */
  expires: number;
}

export interface SolveError {
  error: ErrorCode;
  /** A fresh challenge at the new level, after a wrong answer or a bad PoW. */
  next?: ChallengeResponse;
}

export interface SiteverifyResponse {
  success: boolean;
  /** ISO 8601 time the challenge was solved. */
  challenge_ts?: string;
  hostname?: string;
  score?: number;
  action?: string;
  'error-codes': ErrorCode[];
}
