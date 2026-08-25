import { NextResponse } from "next/server";

import { ClientValidationError } from "../domain/clientRoster";
import { PermissionDeniedError } from "../domain/permissions";
import { CampaignValidationError } from "../engine/submitBrief";
import { PasswordChangeRequiredError, UnauthenticatedError } from "./request";

/**
 * The one place a thrown domain error becomes an HTTP status.
 *
 * Every route handler ends in `catch (error) { return errorResponse(error) }`,
 * so status codes are decided once rather than per endpoint. A route that
 * invented its own mapping would eventually answer 200 with an error body, or
 * 500 for a validation failure -- both of which a client has no way to handle.
 *
 * The domain errors carry a `code`, which is what this branches on. That is why
 * they are named classes rather than bare `Error`s.
 */

export type ApiError = {
  error: {
    code: string;
    message: string;
    /** Field-keyed detail, present only for a validation failure. */
    issues?: Record<string, string>;
  };
};

export function errorResponse(error: unknown): NextResponse<ApiError> {
  if (error instanceof UnauthenticatedError) {
    return jsonError(401, error.code, error.message);
  }

  if (error instanceof PasswordChangeRequiredError) {
    // 403 rather than 401: the session is valid, the account is not yet usable.
    return jsonError(403, error.code, error.message);
  }

  if (error instanceof PermissionDeniedError) {
    // Deliberately one status and one message for every denial reason. The
    // difference between "your role cannot do this" and "not on this client"
    // tells a prober which clients exist, and `enforce` has already recorded
    // the attempt for the Admin.
    return jsonError(403, error.code, "You may not do that.");
  }

  if (error instanceof ClientValidationError || error instanceof CampaignValidationError) {
    return NextResponse.json<ApiError>(
      { error: { code: error.code, message: error.message, issues: error.issues } },
      { status: 422 },
    );
  }

  if (error instanceof SyntaxError) {
    // A malformed JSON body. Caller error, not ours.
    return jsonError(400, "MALFORMED_BODY", "The request body is not valid JSON.");
  }

  // Anything unrecognised is a bug. Log it server-side; tell the caller nothing
  // beyond that it failed, since an internal message is exactly what should not
  // reach a browser.
  console.error("Unhandled API error:", error);
  return jsonError(500, "INTERNAL", "Something went wrong.");
}

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json<ApiError>({ error: { code, message } }, { status });
}
