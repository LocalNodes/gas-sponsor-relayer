import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrationDigest } from '../../src/registration.js';
import { COMMUNITY, SAFE, SIG65, startStub } from '../helpers/stub.js';

const vector = JSON.parse(readFileSync(new URL('../fixtures/vectors/registration.json', import.meta.url), 'utf8'));

test('registration digest equals the fresh3 vector (25-02)', () => {
  const m = vector.message;
  const digest = registrationDigest({ chainId: m.chainId, relayer: m.relayer, safe: m.safe, space: m.space, community: m.community });
  assert.equal(digest, vector.digest);
});

test('registration digest changes with the space, the community, the relayer and the chain', () => {
  const m = vector.message;
  const base = { chainId: m.chainId, relayer: m.relayer, safe: m.safe, space: m.space, community: m.community };
  const d = registrationDigest(base);
  assert.notEqual(registrationDigest({ ...base, space: 'other.eth' }), d);
  assert.notEqual(registrationDigest({ ...base, community: 'Other' }), d);
  assert.notEqual(registrationDigest({ ...base, relayer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }), d);
  assert.notEqual(registrationDigest({ ...base, chainId: 84532 }), d);
});

// Drupal builds the SponsorRegistration message the Group's owners sign, so it must use the community
// value this relayer checks against (25-18 ruling 2). GET /status is the one place it reads it from.
test('GET /status reports the community the registration check uses (25-18)', async () => {
  const s = await startStub({});
  try {
    const status = await s.call('GET', '/status');
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.community, COMMUNITY);
    const reg = await s.call('POST', '/groups', { chainId: 11155111, safe: SAFE, space: 'a.eth', signature: SIG65 });
    assert.equal(reg.status, 201, reg.text);
    assert.equal(reg.json.community, status.json.community, 'the value a registration is checked against');
  } finally {
    await s.close();
  }
});

test('GET /status reports an empty community when SPONSOR_RELAYER_COMMUNITY is unset (25-18)', async () => {
  const s = await startStub({ env: { SPONSOR_RELAYER_COMMUNITY: undefined } });
  try {
    const status = await s.call('GET', '/status');
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.community, '');
  } finally {
    await s.close();
  }
});
