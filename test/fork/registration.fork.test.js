import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { account, CHAIN_ID, COMMUNITY, deploySafe, forkClients, signRegistration, startRelayer } from '../helpers/fork.js';

describe('registration (fork)', () => {
  let pub;
  let relayer;
  let safe;
  const owners = [account(0), account(1)];

  before(async () => {
    const clients = await forkClients();
    pub = clients.pub;
    safe = await deploySafe(pub, clients.wallet, owners, 2);
    relayer = await startRelayer();
  });
  after(async () => {
    await relayer?.close();
  });

  const body = (space, signature) => ({ chainId: CHAIN_ID, safe, space, signature });

  test('registration: a valid 2-owner signature is accepted and listed in /status', async () => {
    const space = 'reg-valid.eth';
    const signature = await signRegistration({ relayer: relayer.relayer, safe, space, signers: owners });
    const res = await relayer.call('POST', '/groups', body(space, signature));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.safe, safe);
    assert.equal(res.json.space, space);
    const status = await relayer.call('GET', '/status');
    assert.equal(status.status, 200, status.text);
    assert.ok(status.json.groups.some((g) => g.safe === safe && g.space === space && g.chainId === CHAIN_ID));
  });

  test('registration: one owner plus a non-owner is refused with 403', async () => {
    const space = 'reg-nonowner.eth';
    const signature = await signRegistration({ relayer: relayer.relayer, safe, space, signers: [owners[0], account(7)] });
    const res = await relayer.call('POST', '/groups', body(space, signature));
    assert.equal(res.status, 403, res.text);
    const status = await relayer.call('GET', '/status');
    assert.ok(!status.json.groups.some((g) => g.space === space));
  });

  test('registration: a signature for a different space than the request names is refused with 403', async () => {
    const signature = await signRegistration({ relayer: relayer.relayer, safe, space: 'reg-signed.eth', signers: owners });
    const res = await relayer.call('POST', '/groups', body('reg-other.eth', signature));
    assert.equal(res.status, 403, res.text);
  });

  test('registration: a signature made for another community is refused with 403', async () => {
    const signature = await signRegistration({ relayer: relayer.relayer, safe, space: 'reg-comm.eth', community: `${COMMUNITY} copy`, signers: owners });
    const res = await relayer.call('POST', '/groups', body('reg-comm.eth', signature));
    assert.equal(res.status, 403, res.text);
  });

  test('registration: a signature that names another relayer address is refused with 403', async () => {
    const signature = await signRegistration({ relayer: account(6).address, safe, space: 'reg-relayer.eth', signers: owners });
    const res = await relayer.call('POST', '/groups', body('reg-relayer.eth', signature));
    assert.equal(res.status, 403, res.text);
  });
});
