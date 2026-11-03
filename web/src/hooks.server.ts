import type { Handle } from "@sveltejs/kit/hooks";
import { getTextDirection } from "@/lib/paraglide/runtime";
import { paraglideMiddleware } from "@/lib/paraglide/server";
import { checkRequest, parseAllowedHosts, parseAllowedOrigins } from "@/lib/origin-guard.mjs";

// Two things happen here, in this order, on every request.
//
// 1. The origin guard — the SvelteKit equivalent of the Next app's proxy.ts.
//    Every request is gated on the same-origin + loopback check before it can
//    reach an endpoint (which may spawn a child process or write the user's
//    files) or a page (which renders the user's CV, pipeline and reports). See
//    origin-guard.mjs for the two-layer rationale (F1 drive-by CSRF, F2 LAN
//    reachability). It runs FIRST and returns early: a refused request should not
//    pay for locale resolution, and nothing below can turn a 403 into a page.
//
// 2. Paraglide's locale middleware, which reads the locale cookie and makes
//    `m.*` resolve in that language for the whole request — pages, load
//    functions and endpoints alike.
//
// A SvelteKit hook runs for every request, pages and endpoints alike, so there is
// no matcher to get wrong. Gating only /api would leave every page ungated, which
// loopback does not cover: a page that re-resolves its own domain to 127.0.0.1
// (DNS rebinding) fetches /pipeline same-origin from the user's own browser, and
// these pages read the tracker off disk on each request. The Host header carries
// the attacker's domain there, so the guard refuses it — but only if it runs.
//
// Opt in to extra hosts (e.g. a trusted LAN box) with a comma/space separated
// CAREER_OPS_WEB_ALLOWED_HOSTS; unset means loopback only.
//
// Opt in to extra *origins* the same way with CAREER_OPS_ALLOWED_ORIGINS; unset
// means none, which leaves the guard as strict as it was. It is what a local
// companion client needs: a browser extension calls from a chrome-extension://
// origin, which Fetch Metadata always reports as "cross-site", so every one of
// its requests is refused otherwise.

// Build assets stay out: they are the same for every user, carry nothing of
// theirs, and a caller who cannot read a page has no use for the chunk that
// renders it.
const UNGATED_PREFIXES = ["/_app/", "/favicon", "/robots.txt"];

export const handle: Handle = async ({ event, resolve }) => {
  if (UNGATED_PREFIXES.some((prefix) => event.url.pathname.startsWith(prefix))) {
    return resolve(event);
  }

  const decision = checkRequest({
    secFetchSite: event.request.headers.get("sec-fetch-site"),
    origin: event.request.headers.get("origin"),
    host: event.request.headers.get("host"),
    allowedHosts: parseAllowedHosts(process.env.CAREER_OPS_WEB_ALLOWED_HOSTS),
    allowedOrigins: parseAllowedOrigins(process.env.CAREER_OPS_ALLOWED_ORIGINS),
  });
  if (!decision.ok) {
    return new Response(JSON.stringify({ error: decision.reason }), {
      status: decision.status,
      headers: { "content-type": "application/json" },
    });
  }

  return paraglideMiddleware(event.request, ({ request, locale }) =>
    resolve(
      { ...event, request },
      {
        // %lang% / %dir% are placeholders in app.html: the locale is only known
        // here, per request, so the document shell cannot be prerendered with a
        // hardcoded language.
        transformPageChunk: ({ html }) =>
          html.replace("%lang%", locale).replace("%dir%", getTextDirection(locale)),
      },
    ),
  );
};
