/**
 * The Instagram boundary.
 *
 * Phase 9 was specified as a real integration against a Meta developer app with
 * one tester account. That app cannot be created in this environment, so the
 * network calls are mocked -- and *only* the network calls. Everything the phase
 * actually exists to prove is real: the gate re-check, the atomic status
 * transition, the race-condition test, the take-down path, the `publish_failed`
 * handling.
 *
 * The seam is this interface. `scripts/scheduler.ts` depends on `Publisher`, not
 * on a fetch call, so swapping the mock for a real client is one constructor and
 * no change to the scheduler, the gate, or any test. That is the point of
 * putting the boundary here rather than inlining `fetch` where it is used.
 *
 * What the mock deliberately does **not** do:
 *
 *   - It does not shortcut the gate. A mocked publisher that answered "published"
 *     without the scheduler re-checking approvals would make the one test this
 *     layer exists for meaningless.
 *   - It does not always succeed. Real publishing fails -- expired tokens, rate
 *     limits, deleted media -- and `publish_failed` is a real status with real
 *     UI behind it. A mock that never failed would leave that path untested and
 *     unreachable in a demo.
 */

/** What a publish needs. Deliberately not a `ContentItem` -- this layer knows nothing about campaigns. */
export type PublishRequest = {
  contentItemId: string;
  /** The caption or copy. */
  body: string;
  /** Absolute path or URL of the image/video, where the item has one. */
  mediaUrl?: string | null;
  /** The client's connected account. */
  platformAccountId: string;
  accessToken: string;
};

export type PublishResult = {
  /** Instagram's own id for the published post, stored for take-down. */
  platformPostId: string;
  publishedAt: Date;
};

/** A failure that is worth retrying later, as opposed to one that never will be. */
export class PublishError extends Error {
  readonly code = "PUBLISH_FAILED";
  /** False for an expired token or deleted media: retrying changes nothing. */
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = "PublishError";
    this.retryable = retryable;
  }
}

/**
 * The two calls Instagram's Content Publishing API actually takes, plus deletion.
 *
 * Modelled as one `publish` rather than exposing the container/publish split,
 * because the split is Instagram's implementation detail and the scheduler has
 * no decision to make between the two steps. A real client does both inside this
 * method.
 */
export interface Publisher {
  publish(request: PublishRequest): Promise<PublishResult>;
  /** Take-down. Distinct from a decline: this removes something already live. */
  remove(platformPostId: string, accessToken: string): Promise<void>;
}

/**
 * The mock.
 *
 * Deterministic rather than random, keyed off the content item id: the same item
 * behaves the same way on every run, so a demo is repeatable and a failing test
 * is reproducible. A random failure rate would make the race-condition test
 * flaky for reasons that have nothing to do with the race.
 *
 * One item in twenty fails, chosen by a hash of the id. That is frequent enough
 * that `publish_failed` is reachable in a demo of a few dozen items, and rare
 * enough that the happy path is what someone watching actually sees.
 */
export class MockPublisher implements Publisher {
  private readonly published = new Map<string, PublishRequest>();

  constructor(
    /** Set to 0 to make every publish succeed -- used by tests that are not about failure. */
    private readonly failureRate = 0.05,
  ) {}

  async publish(request: PublishRequest): Promise<PublishResult> {
    if (!request.accessToken) {
      // Not retryable: a missing token is a connection problem, and retrying it
      // on a timer would spin forever against a client nobody has connected.
      throw new PublishError("No access token for that client's account.", false);
    }

    if (this.shouldFail(request.contentItemId)) {
      throw new PublishError("Instagram rejected the media (mocked failure).", true);
    }

    // A plausible-looking id, derived rather than random so it is stable across
    // runs and can be matched in a take-down.
    const platformPostId = `mock_${hash(request.contentItemId).toString(36)}`;
    this.published.set(platformPostId, request);

    return { platformPostId, publishedAt: new Date() };
  }

  async remove(platformPostId: string, accessToken: string): Promise<void> {
    if (!accessToken) {
      throw new PublishError("No access token for that client's account.", false);
    }
    // A take-down of something never published is not an error worth failing on:
    // the caller asked for a state, and that state holds.
    this.published.delete(platformPostId);
  }

  /** Test seam: what this publisher believes is live. */
  livePostIds(): string[] {
    return [...this.published.keys()];
  }

  private shouldFail(contentItemId: string): boolean {
    if (this.failureRate <= 0) return false;
    return (hash(contentItemId) % 100) / 100 < this.failureRate;
  }
}

/** A small stable string hash. Not cryptographic -- it only needs to be repeatable. */
function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * The publisher the app uses.
 *
 * A real `InstagramPublisher` would be selected here when credentials exist. It
 * does not exist yet, so this always returns the mock -- and says so out loud
 * rather than pretending, because a demo where publishing silently does nothing
 * real is worse than one where the log says it is mocked.
 */
export function publisherFor(): Publisher {
  return new MockPublisher();
}
