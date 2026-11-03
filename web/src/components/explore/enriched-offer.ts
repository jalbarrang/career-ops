import type { DiscoveredOffer } from "@/lib/explore";

/** A discovered offer joined with what the inbox/tracker snapshots already know
 *  about it — what ResultsList and the cards actually render. */
export type EnrichedOffer = DiscoveredOffer & { inPipeline: boolean; evaluatedN?: string };
