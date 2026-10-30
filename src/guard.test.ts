import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlAllows, dangerous } from './guard.ts';

const L = 'https://127.0.0.1:50061';

test('dangerous writes are caught, reads never', () => {
  const bad: Array<[string, string]> = [
    ['POST', `${L}/lol-purchase-widget/v2/purchaseItems`],
    ['POST', `${L}/lol-yourshop/v1/offers/abc/purchase`],
    ['POST', `${L}/lol-yourshop/v1/offers/abc/reveal`],
    ['POST', `${L}/lol-loot/v1/recipes/CHAMPION_RENTAL_disenchant/craft?repeat=1`],
    ['POST', `${L}/lol-loot/v1/player-loot/CHEST_128/context-menu`],
    ['POST', `${L}/lol-player-report-sender/v1/end-of-game-reports`],
    ['POST', `${L}/lol-honor-v2/v1/honor-player`],
    ['POST', `${L}/lol-chat/v1/conversations/x%40pvp.net/messages`],
    ['POST', `${L}/lol-chat/v2/friend-requests`],
    ['DELETE', `${L}/lol-chat/v1/friends/abc`],
    ['POST', `${L}/lol-lobby/v2/lobby/invitations`],
    ['POST', `${L}/lol-lobby/v2/lobby/matchmaking/search`],
    ['POST', `${L}/process-control/v1/process/quit`],
    ['DELETE', `${L}/lol-login/v1/session`],
    ['POST', `https://store.br.lol.riotgames.com/storefront/v3/purchase`],
    ['POST', `${L}/lol-event-hub/v1/events/e1/reward-track/claim-all`],
  ];
  for (const [m, u] of bad) assert.ok(dangerous(m, u), `${m} ${u}`);
  assert.equal(dangerous('GET', `${L}/lol-purchase-widget/v1/configuration`), null);
  assert.equal(dangerous('GET', `https://example.com/x`), null);
  assert.equal(dangerous('POST', `${L}/lol-lobby/v2/lobby`), null);
  assert.equal(dangerous('PATCH', `${L}/lol-settings/v2/account/LCUPreferences/lol-loot`), null);
});

test('crawler fails every write outside its allowlist', () => {
  assert.ok(crawlAllows('GET', `${L}/lol-loot/v1/player-loot-map`));
  assert.ok(crawlAllows('POST', `${L}/lol-lobby/v2/lobby`));
  assert.ok(crawlAllows('PATCH', `${L}/lol-champ-select/v1/session/actions/3`));
  assert.ok(!crawlAllows('PATCH', `${L}/lol-settings/v2/account/LCUPreferences/lol-loot`));
  assert.ok(!crawlAllows('POST', `${L}/lol-lobby/v2/lobby/matchmaking/search`));
  assert.ok(!crawlAllows('POST', `${L}/lol-loot/v1/recipes/x/craft`));
});
