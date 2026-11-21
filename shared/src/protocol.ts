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

/**
 * `proverb`: the language challenge. `fallback`: the accessible way through (docs/DESIGN.md section
 * 6.3, D3 option B): no question, a harder proof-of-work, and a low-score token.
 */
export type ChallengeType = 'proverb' | 'fallback';

/** The score of a pass earned by the fallback, without answering a question. */
export const FALLBACK_SCORE = 0.3;

export interface ProverbOption {
  id: string;
  text: string;
}

export interface ProverbQuestion {
  prompt: string;
  options: ProverbOption[];
}

/** One question below level 4; two at level 4 and above; none for a `fallback` challenge. */
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
  /** One option id per question; empty for a `fallback` challenge. */
  answer: string[];
  /** base64 ALTCHA payload. */
  pow: string;
}

/**
 * POST /report: the visitor flags one question of the challenge on screen as wrong or offensive
 * (docs/DESIGN.md section 11). The server reads the item id from the seal and records only that.
 */
export interface ReportRequest {
  sealed: string;
  /** Index of the question in `display.questions`. */
  question: number;
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
  /** True when the visitor took the fallback (no question answered); the score is then low. */
  fallback?: boolean;
  'error-codes': ErrorCode[];
}
