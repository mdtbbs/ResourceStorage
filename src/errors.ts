export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class UploadValidationError extends Error {
  constructor(public readonly code: 'size_mismatch' | 'size_limit' | 'sha256_mismatch', message: string) {
    super(message);
    this.name = 'UploadValidationError';
  }
}
