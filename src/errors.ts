export class ProxyError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "invalid_request_error",
  ) {
    super(message);
    this.name = "ProxyError";
  }
}
export function errorBody(error: unknown): {
  error: { message: string; type: string; code: string };
} {
  const known = error instanceof ProxyError;
  return {
    error: {
      message: known ? error.message : "Internal server error",
      type: known ? error.code : "server_error",
      code: known ? error.code : "server_error",
    },
  };
}
