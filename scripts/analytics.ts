import { prisma } from "../lib/db";
import { insightsSource } from "../lib/instagram/insights";

/**
 * The metrics poll.
 *
 * Run alongside `scripts/scheduler.ts` in a second terminal. Writes one
 * `MetricSnapshot` row per metric per poll rather than updating a current value,
 * because performance is a history: a single mutable number cannot answer "is
 * this post still growing", which is the question the analytics views exist for.
 *
 * **Instagram Insights is mocked.** The numbers are derived deterministically
 * from the post id and how long it has been live, so they grow on a plausible
 * curve and are identical across runs. The scoping, the aggregation and the
 * time-series shape are all real.
 */

const INTERVAL_MS = Number(process.env.ANALYTICS_INTERVAL_MS ?? 300_000);

/** The published post's platform id, from the audit row publishing wrote. */
async function platformPostIdFor(contentItemId: string): Promise<string | null> {
  const row = await prisma.auditLog.findFirst({
    where: { entity_id: contentItemId, action: "published" },
    orderBy: { performed_at: "desc" },
    select: { details: true, performed_at: true },
  });

  if (!row?.details) return null;
  try {
    return (JSON.parse(row.details) as { platform_post_id?: string }).platform_post_id ?? null;
  } catch {
    return null;
  }
}

async function tick() {
  const insights = insightsSource();
  const now = new Date();

  const published = await prisma.contentItem.findMany({
    where: { status: "published" },
    select: { content_item_id: true, updated_at: true },
  });

  if (published.length === 0) {
    console.log(`[analytics] ${now.toISOString()} — nothing published yet.`);
    return;
  }

  let written = 0;

  for (const item of published) {
    const platformPostId = await platformPostIdFor(item.content_item_id);
    // An item marked published with no recorded post id predates the publishing
    // layer, or was set by hand. Skipped rather than invented: a snapshot with
    // no source is worse than a gap.
    if (!platformPostId) continue;

    const readings = await insights.read(platformPostId, item.updated_at, now);

    await prisma.metricSnapshot.createMany({
      data: readings.map((reading) => ({
        content_item_id: item.content_item_id,
        metric_type: reading.metric_type,
        value: reading.value,
        captured_at: now,
      })),
    });

    written += readings.length;
  }

  console.log(
    `[analytics] ${now.toISOString()} — ${written} snapshots across ${published.length} posts (Insights MOCKED).`,
  );
}

async function main() {
  const once = process.argv.includes("--once");

  console.log(
    `[analytics] starting${once ? " (single poll)" : ` — every ${INTERVAL_MS / 1000}s`}.`,
  );
  console.log("[analytics] Instagram Insights is MOCKED — numbers are generated locally.");

  await tick();
  if (once) return;

  const loop = async () => {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    try {
      await tick();
    } catch (error) {
      console.error("[analytics] poll failed:", error);
    }
    void loop();
  };

  void loop();
}

main()
  .catch((error) => {
    console.error("[analytics] fatal:", error);
    process.exit(1);
  })
  .finally(async () => {
    if (process.argv.includes("--once")) await prisma.$disconnect();
  });
