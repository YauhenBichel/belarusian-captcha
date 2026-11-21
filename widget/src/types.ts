// The widget's public types, with no imports: the npm package `belarusian-captcha` ships these
// declarations to bundler users, who do not have the private shared package (or JSON modules).
// api.ts and pow.ts check that the copies below stay equal to the shared types they mirror.

export type Lang = 'be' | 'be-Latn' | 'ru' | 'en';

/** Error codes the verify API returns (the same as `ErrorCode` in shared/src/protocol.ts). */
export type ApiErrorCode =
  | 'invalid-sitekey'
  | 'invalid-secret'
  | 'invalid-input-response'
  | 'timeout-or-duplicate'
  | 'hostname-mismatch'
  | 'rate-limited'
  | 'bad-pow'
  | 'wrong-answer'
  | 'bad-request'
  | 'action-mismatch'
  | 'store-unavailable';

/** An error code from the API, or one of the widget's own. */
export type WidgetErrorCode = ApiErrorCode | 'network-error' | 'bad-response' | 'pow-failed';

/** The proof-of-work search input (the `challenge`, `salt` and `maxnumber` of a challenge). */
export interface PowTask {
  challenge: string;
  salt: string;
  maxnumber: number;
}

export interface PowFound {
  number: number;
  /** Milliseconds the search took. */
  took: number;
}

export interface PowJob {
  result: Promise<PowFound | null>;
  cancel(): void;
}

export type PowSolver = (task: PowTask) => PowJob;

/** Compiles only when A and B are the same type; used to keep the copies above in step. */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
