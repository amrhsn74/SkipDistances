import { NextResponse } from "next/server";

import {
  ApprovalNotAllowedError,
  ApprovalValidationError,
  ContentItemNotFoundError,
} from "../domain/approvals";
import {
  BrandGuideNotAllowedError,
  BrandGuideNotFoundError,
  BrandGuideValidationError,
} from "../domain/brandGuides";
import { ClientContactError } from "../domain/clientContacts";
import { SingleClientApproverError } from "../domain/clientContactInvariant";
import { ClientValidationError } from "../domain/clientRoster";
import { CommentTargetNotFoundError, CommentValidationError } from "../domain/comments";
import { PermissionDeniedError } from "../domain/permissions";
import {
  PostRequestNotAllowedError,
  PostRequestNotFoundError,
  PostRequestValidationError,
} from "../domain/postRequests";
import { ReferenceValidationError } from "../domain/referenceAttachments";
import { GateClosedError, SchedulingError } from "../domain/scheduling";
import { OffTaskPromptError, RegenerateItemError } from "../engine/regenerateItem";
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

  if (error instanceof OffTaskPromptError) {
    // 422, not 403. The caller is permitted to regenerate; this particular
    // prompt was not about the client's content. A 403 would read as "you may
    // not do this", which is the wrong thing to tell a creator whose next,
    // on-task prompt will work fine. The attempt is already flagged for the
    // Admin by `regenerateItem`.
    return NextResponse.json<ApiError>(
      {
        error: {
          code: error.code,
          message: error.message,
          issues: { prompt: error.verdict.reason },
        },
      },
      { status: 422 },
    );
  }

  if (error instanceof RegenerateItemError) {
    // A regeneration that could not run at all -- an unknown item, a reference
    // belonging to a different item, a model returning the wrong item count.
    return jsonError(422, error.code, error.message);
  }

  if (error instanceof ApprovalNotAllowedError) {
    // 409, not 422. The body was well-formed and the caller is permitted -- it
    // is the item's current state that refuses, and that state can change. This
    // is the status a client gets for declining something already published,
    // where the answer is not "fix your request" but "that post is live, and a
    // live post needs a take-down rather than a retroactive decline".
    return NextResponse.json<ApiError>(
      {
        error: {
          code: error.code,
          message: error.message,
          issues: { status: error.status },
        },
      },
      { status: 409 },
    );
  }

  if (error instanceof PostRequestNotAllowedError) {
    // 409, as for an approval the status machine refuses: the body was
    // well-formed and the caller is permitted -- it is the row's current state
    // that refuses. This is what a client gets for editing a request their
    // account manager has already taken.
    return NextResponse.json<ApiError>(
      {
        error: {
          code: error.code,
          message: error.message,
          issues: { status: error.status },
        },
      },
      { status: 409 },
    );
  }

  if (error instanceof BrandGuideNotAllowedError) {
    // 409, as for an approval or a post request the state refuses: the body was
    // well-formed and the caller is permitted -- it is the version's current
    // status that refuses. This is what a client gets for approving a version
    // their account manager has not yet submitted to them.
    return NextResponse.json<ApiError>(
      {
        error: {
          code: error.code,
          message: error.message,
          issues: { status: error.status },
        },
      },
      { status: 409 },
    );
  }

  if (error instanceof CommentTargetNotFoundError) {
    // Reachable only inside the caller's scope -- a request or item they may not
    // see is denied by `enforce` first, and answers 403. So a 404 here never
    // discloses whether another client's post exists.
    return jsonError(404, error.code, error.message);
  }

  if (error instanceof BrandGuideNotFoundError) {
    // Reachable only inside the caller's scope -- a version they may not see is
    // denied by `enforce` first, and answers 403.
    return jsonError(404, error.code, error.message);
  }

  if (error instanceof PostRequestNotFoundError) {
    // Reachable only inside the caller's scope -- a request they may not see is
    // denied by `enforce` first, and answers 403.
    return jsonError(404, error.code, error.message);
  }

  if (error instanceof ContentItemNotFoundError) {
    // Reachable only for an item inside the caller's scope: an item they may not
    // see is denied by `enforce` first, and answers 403. So a 404 here never
    // discloses whether another client's item exists.
    return jsonError(404, error.code, error.message);
  }

  if (
    error instanceof ApprovalValidationError ||
    error instanceof PostRequestValidationError ||
    error instanceof ClientValidationError ||
    error instanceof ClientContactError ||
    error instanceof BrandGuideValidationError ||
    error instanceof CommentValidationError ||
    error instanceof CampaignValidationError ||
    error instanceof ReferenceValidationError
  ) {
    return NextResponse.json<ApiError>(
      { error: { code: error.code, message: error.message, issues: error.issues } },
      { status: 422 },
    );
  }

  if (error instanceof GateClosedError) {
    // 409, as for an approval the status machine refuses: the body was
    // well-formed and the caller is permitted -- it is the missing approval
    // that refuses, and that can change. `blocked_by` names which stage, so the
    // screen can say "waiting on the client" rather than a bare refusal.
    return NextResponse.json<ApiError>(
      {
        error: {
          code: error.code,
          message: error.message,
          issues: { blocked_by: error.blockedBy.join(", ") },
        },
      },
      { status: 409 },
    );
  }

  if (error instanceof SchedulingError) {
    return NextResponse.json<ApiError>(
      { error: { code: error.code, message: error.message, issues: error.issues } },
      { status: 422 },
    );
  }

  if (error instanceof SingleClientApproverError) {
    // 409, not 422. The body was well-formed and the caller is permitted -- it
    // is the person named who already approves somewhere else, and that can
    // change. This is what an account manager gets for onboarding a contact who
    // already holds another client, and the answer is not "fix your form" but
    // "that person is already somebody else's approver".
    return jsonError(409, error.code, error.message);
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
