export type AppErrorCode =
  "BAD_REQUEST" | "CONFLICT" | "UNAUTHORIZED" | "FORBIDDEN";

/**
An application failure whose public code is independent of its transport.
*/
export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(options: { code: AppErrorCode; message: string }) {
    super(options.message);
    this.name = "AppError";
    this.code = options.code;
  }
}
