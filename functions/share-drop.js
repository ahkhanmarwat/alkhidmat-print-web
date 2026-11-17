// share-drop — same-origin Web Share Target endpoint (Cloudflare Pages
// Function). Deployed to the GitHub repo root as functions/share-drop.js
// (Cloudflare Pages convention), so the installed PWA's manifest
// share_target action "share-drop" resolves to <own origin>/share-drop:
// SAME-ORIGIN, which Chromium requires — it silently ignores a whole
// share_target whose action is cross-origin / outside the manifest
// scope (that is why the app installed from GitHub Pages but never
// appeared in any share sheet while the action pointed at supabase.co).
//
// The real intake still lives in the Supabase `share-drop` Edge Function
// (strict validation, private-bucket parking, share_drops rows). This
// function only proxies the multipart POST there and rewrites the
// resulting 303 redirect onto this origin, keeping ONLY the query
// string (?drop=<group> or ?drop_error=<code>) — the PWA landing code
// reads exactly those params, and the upstream redirect base may still
// point at the old GitHub Pages URL.

const SUPABASE_SHARE_DROP =
  "https://aqucbptusdjomfernoqg.supabase.co/functions/v1/share-drop";

/**
 * Build the browser-facing redirect target from the upstream Location
 * header: keep ONLY its query string, re-anchored on our own origin.
 * Missing, malformed, or query-less Location -> the honest error
 * landing (?drop_error=server), never a silent success page.
 */
export function redirectTarget(locationHeader, ownOrigin) {
  const fallback = `${ownOrigin}/?drop_error=server`;
  if (!locationHeader) return fallback;
  let url;
  try {
    url = new URL(locationHeader);
  } catch {
    return fallback;
  }
  if (!url.search) return fallback;
  return `${ownOrigin}/${url.search}`;
}

export async function onRequestPost(context) {
  const ownOrigin = new URL(context.request.url).origin;
  try {
    const form = await context.request.formData();
    const upstream = await fetch(SUPABASE_SHARE_DROP, {
      method: "POST",
      body: form,
      redirect: "manual",
    });
    return new Response(null, {
      status: 303,
      headers: {
        Location: redirectTarget(upstream.headers.get("Location"), ownOrigin),
      },
    });
  } catch {
    return new Response(null, {
      status: 303,
      headers: { Location: `${ownOrigin}/?drop_error=server` },
    });
  }
}

/** Liveness check only — shares arrive as POST, never GET. */
export function onRequestGet() {
  return new Response("Method not allowed", { status: 405 });
}
