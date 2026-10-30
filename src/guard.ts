/**
 * Safety rules agreed with the user for their real account: nothing that spends currency or loot, no real queue, nothing
 * that reaches other players, no account changes. Matching is on method + path because button labels change with the
 * locale and the patch; the request is what actually does the damage.
 */

/** Phases where a reload or a crawl would hurt (queue pop lost, champ select dodge, game disconnect). */
export const BUSY_PHASES = ['Matchmaking', 'ReadyCheck', 'ChampSelect', 'GameStart', 'InProgress', 'Reconnect'];
export const CRAWL_PHASES = ['None', 'Lobby'];

const DANGEROUS: Array<[RegExp, string]> = [
  [/purchase|checkout|\/buy\b|\/orders?\b|\/gift|\/transaction/i, 'purchase'],
  // Any loot write except the refresh the loot screen fires on open: craft, disenchant, open chest, reroll, redeem.
  [/^\/lol-loot\/(?!v1\/refresh$)/i, 'loot craft/disenchant'],
  [/reroll/i, 'reroll'],
  [/report/i, 'report'],
  [/\/lol-honor/i, 'honor'],
  [/\/lol-chat\/v\d\/conversations\/[^/]+\/messages/i, 'chat message'],
  [/friend-requests|\/lol-chat\/v\d\/friends|blocked-players|friend-groups/i, 'friend list change'],
  [/invitation|\/invite/i, 'invite'],
  [/matchmaking\/search|\/lol-matchmaking\/v\d\/search/i, 'real queue'],
  [/alias|current-summoner\/name|name-change/i, 'name change'],
  [/claim|select-reward|reward-choice|redeem/i, 'reward claim/choice'],
  [/\/process-control\/|\/riotclient\/(kill|restart|launch)/i, 'client quit/restart'],
  [/\/lol-login\/v\d\/session$/i, 'logout'],
  [/\/lol-yourshop\/v\d\/offers\/[^/]+\/reveal/i, 'Your Shop reveal'],
];

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i;

/** Why this request must not go out, or null when it is fine. GETs are always fine. */
export function dangerous(method: string, url: string): string | null {
  if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'OPTIONS') return null;
  if (/^https?:\/\//i.test(url) && !LOOPBACK.test(url)) return 'write to a remote host';
  const path = pathOf(url);
  for (const [re, why] of DANGEROUS) if (re.test(path)) return why;
  return null;
}

/** Writes the crawler lets through; every other write is recorded and failed. */
const CRAWL_ALLOW: RegExp[] = [
  /^POST \/lol-lobby\/v2\/lobby$/,
  /^DELETE \/lol-lobby\/v2\/lobby$/,
  /^POST \/lol-lobby\/v1\/lobby\/custom\/start-champ-select$/,
  /^POST \/lol-lobby-team-builder\/champ-select\/v1\/session\/quit$/,
  /^PATCH \/lol-champ-select\/v1\/session\/actions\/\d+$/,
  /^POST \/lol-loot\/v1\/refresh$/,
  /^(POST|PUT|DELETE) \/(telemetry|tracing)\//,
];

export function crawlAllows(method: string, url: string): boolean {
  if (dangerous(method, url)) return false;
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'OPTIONS') return true;
  const line = `${m} ${pathOf(url)}`;
  return CRAWL_ALLOW.some((re) => re.test(line));
}

export function pathOf(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
}
