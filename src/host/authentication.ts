import { AppError } from "../core/errors.js";

/**
Authorises a request to a loopback host with a private launch token.
*/
export function authorizeLocalRequest(request: Request, token: string): void {
  const url = new URL(request.url);
  if (
    request.headers.get("host") !== url.host ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  )
    throw new AppError({ code: "FORBIDDEN", message: "Invalid host." });
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`)
    throw new AppError({
      code: "UNAUTHORIZED",
      message:
        "Open the launch URL from the control-plane terminal to reconnect this browser.",
    });
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin)
    throw new AppError({
      code: "FORBIDDEN",
      message: "Cross-origin requests are not allowed.",
    });
}
