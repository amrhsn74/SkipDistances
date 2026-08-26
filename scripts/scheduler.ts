import { prisma } from "../lib/db";
import { dueForPublishing, publishItem } from "../lib/domain/publish";
import { publisherFor } from "../lib/instagram/client";

/**
 * The publishing loop.
 *
 * Run in a second terminal alongside `npm run dev`. A standalone script rather
 * than a Next route because a route is not a long-running process, and a real
 * cron or queue is more machinery than a one-week build needs.
 *
 * The script decides almost nothing. It finds what is due and hands each item to
 * `publishItem`, which owns the gate re-check and the atomic claim -- the two
 * things this layer exists to get right. Putting either here would mean a second
 * caller could publish without them.
 *
 * **Instagram is mocked.** The network calls go to `MockPublisher`; everything
 * around them is real. The log says so on every tick rather than only at
 * startup, so nobody watching a demo mistakes a mocked publish for a live one.
 */

const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS ?? 30_000);

async function tick() {
  const publisher = publisherFor();
  const due = await dueForPublishing();

  if (due.length === 0) {
    console.log(`[scheduler] ${new Date().toISOString()} — nothing due.`);
    return;
  }

  console.log(`[scheduler] ${new Date().toISOString()} — ${due.length} due (Instagram MOCKED).`);

  for (const contentItemId of due) {
    // One at a time rather than in parallel. The claim makes concurrent ticks
    // safe, but a burst of parallel publishes against a real rate-limited API
    // would be the first thing to break when the mock is swapped out.
    const outcome = await publishItem(contentItemId, publisher);

    switch (outcome.status) {
      case "published":
        console.log(`  ✓ ${contentItemId} → ${outcome.platformPostId}`);
        break;
      case "skipped":
        console.log(`  – ${contentItemId} skipped: ${outcome.reason}`);
        break;
      case "failed":
        console.log(
          `  ✗ ${contentItemId} failed${outcome.retryable ? "" : " (not retryable)"}: ${outcome.reason}`,
        );
        break;
    }
  }
}

async function main() {
  const once = process.argv.includes("--once");

  console.log(
    `[scheduler] starting${once ? " (single tick)" : ` — every ${INTERVAL_MS / 1000}s`}.`,
  );
  console.log("[scheduler] Instagram publishing is MOCKED — no post leaves this machine.");

  await tick();
  if (once) return;

  // `setInterval` would overlap ticks if one ran long. Chaining keeps exactly
  // one tick in flight, which matters more here than a precise cadence.
  const loop = async () => {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    try {
      await tick();
    } catch (error) {
      // A failed tick must not kill the loop: the next one may well succeed, and
      // a scheduler that dies silently is worse than one that logs and retries.
      console.error("[scheduler] tick failed:", error);
    }
    void loop();
  };

  void loop();
}

main()
  .catch((error) => {
    console.error("[scheduler] fatal:", error);
    process.exit(1);
  })
  .finally(async () => {
    if (process.argv.includes("--once")) await prisma.$disconnect();
  });
