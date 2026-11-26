const confirmation = /^(?:yes(?: sir)?|yep|yeah|sure|okay?|continue|proceed|go ahead|do it|check it|use the browser)[.! ]*$/i;
const externalChrome = /\b(?:outside|external|regular|personal|my)\s+(?:google\s+)?chrome\b|\bchrome\s+outside (?:of )?pilo\b/i;

export function requestedBrowserTarget(
  task: string,
  history: readonly { role: string; text: string }[] = []
): { external: boolean; profile?: string } | undefined {
  const request = task.trim();
  if (/\b(?:no browser|(?:don['’]t|do not|never)\s+(?:open|use|launch)\s+(?:the |my |your )?(?:browser|chrome))\b/i.test(request)) return;
  const prior = history.filter(turn => turn.role === "user" && turn.text.trim() !== request).slice(-2);
  const confirmed = confirmation.test(request);
  const current = confirmed ? prior.at(-1)?.text.trim() ?? "" : request;
  if (/^(?:how|what|why|which|where)\b/i.test(current) && !/\bfor me\b/i.test(current)) return;
  const external = externalChrome.test(current);
  const profile = (current.match(/\b(?:from|using|use)\s+(?:the\s+)?["“]?([\w -]{1,60}?)["”]?\s+(?:chrome\s+|browser\s+)?profile\b/i)
    ?? current.match(/\b(?:chrome|browser) profile\s+(?:named\s+)?["“]([^"”]+)["”]/i))?.[1].trim();
  if (external) {
    // A correction can change the browser without repeating the requested profile.
    const previous = confirmed ? prior.at(-2) : prior.at(-1);
    const correction = /\b(?:not|instead|outside)\b/i.test(current);
    const inherited = correction && previous ? requestedBrowserTarget(previous.text)?.profile : undefined;
    return { external: true, profile: profile || inherited };
  }
  if (profile && /\b(?:browser|chrome)\b/i.test(current)) return { external: false, profile };
}

export function externalChromeEndpoint(profile: string | undefined, boundProfile = process.env.BROWSER_AGENT_EXTERNAL_CHROME_PROFILE,
  endpoint = process.env.BROWSER_AGENT_EXTERNAL_CHROME_ENDPOINT): string | undefined {
  if (!boundProfile?.trim() || (profile && profile.toLowerCase() !== boundProfile.trim().toLowerCase()) || !endpoint) return;
  // This binding is operator configuration, never taken from a chat message.
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}\/?$/i.test(endpoint)) return;
  try { return new URL(endpoint).origin; } catch { return; }
}
