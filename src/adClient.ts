const DEFAULT_BASE_URL = "https://spinnerrecruit-api.vercel.app";

export interface Ad {
  id: string;
  text: string;
  url: string;
  company: string;
  title: string;
  location: string;
  compLabel: string | null;
  seeded: boolean;
}

export interface ServedAd {
  ad: Ad;
  serveId: string;
}

function baseUrl(): string {
  return (process.env.SPINNER_RECRUIT_API_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
}

// All requests are fire-and-forget friendly: ad serving must never break the
// wrapped session, so every failure resolves to null/void instead of throwing.

export async function fetchNextAd(
  language: string | undefined,
  sessionId: string,
  developerId: string | undefined,
): Promise<ServedAd | null> {
  try {
    const params = new URLSearchParams({ sessionId });
    if (language) params.set("lang", language);
    if (developerId) params.set("developerId", developerId);

    const res = await fetch(`${baseUrl()}/api/next-ad?${params}`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ad: Ad | null; serveId?: string };
    if (!data.ad || !data.serveId) return null;
    return { ad: data.ad, serveId: data.serveId };
  } catch {
    return null;
  }
}

export async function reportImpression(serveId: string): Promise<void> {
  try {
    await fetch(`${baseUrl()}/api/impression`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serveId }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // never throw out of the ad lifecycle
  }
}

// Terminal hyperlinks (OSC 8) open directly with no JS click handler, unlike
// the VS Code status bar item this CLI replaces — so the click itself has to
// be a server-side redirect: bill against the serve token, then 302 to the
// ad's real URL. See api/app/api/go/[serveId]/route.ts.
export function goUrl(serveId: string): string {
  return `${baseUrl()}/api/go/${serveId}`;
}
