import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { zeroAddress } from 'viem';
import { loadNetworks } from '../../src/config.js';
import { execBody, SAFE, SIM_FALSE, startStub } from '../helpers/stub.js';

const networks = loadNetworks();
const sepolia = networks['11155111'];
const GROUP = [{ chainId: 11155111, safe: SAFE, space: 'a.eth' }];
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

async function once(opts, body) {
  const s = await startStub({ groups: GROUP, ...opts });
  try {
    const res = await s.call('POST', '/send/safe-exec', execBody(networks, body));
    return { res, calls: { ...s.chains.calls }, logs: [...s.logs] };
  } finally {
    await s.close();
  }
}

describe('safe-exec (unit)', () => {
  test('safe-exec: a registered Safe with zero refund fields is simulated and sent', async () => {
    const { res, calls } = await once({}, {});
    assert.equal(res.status, 202, res.text);
    assert.equal(calls.call, 1);
    assert.equal(calls.send, 1);
  });

  test('safe-exec: gasPrice, gasToken and refundReceiver must be zero, else 403 and nothing sent', async () => {
    for (const bad of [{ gasPrice: '1' }, { gasToken: OTHER }, { refundReceiver: OTHER }]) {
      const { res, calls, logs } = await once({}, bad);
      assert.equal(res.status, 403, JSON.stringify(bad));
      assert.equal(res.json.reason, 'refund_fields_must_be_zero');
      assert.equal(calls.send, 0);
      assert.equal(calls.call, 0);
      assert.ok(logs.some((l) => l.startsWith('refused refund_fields_must_be_zero 11155111 ')), 'refusal logged');
    }
  });

  test('safe-exec: an unregistered Safe is refused with 403', async () => {
    const { res, calls } = await once({ groups: [] }, {});
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, 'safe_not_registered');
    assert.equal(calls.send, 0);
  });

  test('safe-exec: operation 1 only to MultiSend, MultiSendCallOnly, CreateCall or SignMessageLib', async () => {
    for (const key of ['multiSend', 'multiSendCallOnly', 'createCall', 'signMessageLib']) {
      const { res } = await once({}, { operation: 1, to: sepolia[key] });
      assert.equal(res.status, 202, key);
    }
    for (const to of [OTHER, sepolia.reality, sepolia.hats, zeroAddress]) {
      const { res, calls } = await once({}, { operation: 1, to });
      assert.equal(res.status, 403, to);
      assert.equal(res.json.reason, 'delegatecall_target_not_allowed');
      assert.equal(calls.send, 0);
    }
  });

  test('safe-exec: a failed simulation answers 409 and sends nothing', async () => {
    for (const sim of [SIM_FALSE, new Error('execution reverted: GS026')]) {
      const { res, calls } = await once({ chainsOpts: { sim } }, {});
      assert.equal(res.status, 409);
      assert.equal(res.json.reason, 'simulation_failed');
      assert.equal(calls.send, 0);
    }
  });

  test('safe-exec: malformed bodies answer 400 and oversized bodies 413', async () => {
    const s = await startStub({ groups: GROUP });
    try {
      for (const bad of [{ chainId: '11155111' }, { safe: 'nope' }, { value: '-1' }, { value: '1.5' }, { operation: 2 }, { data: '0xabc' }, { signatures: '0x' }]) {
        const res = await s.call('POST', '/send/safe-exec', execBody(networks, bad));
        assert.equal(res.status, 400, JSON.stringify(bad));
      }
      assert.equal((await s.call('POST', '/send/safe-exec', 'not json')).status, 400);
      const big = await s.call('POST', '/send/safe-exec', JSON.stringify(execBody(networks, { data: `0x${'00'.repeat(70 * 1024)}` })));
      assert.equal(big.status, 413);
      assert.equal(s.chains.calls.send, 0);
    } finally {
      await s.close();
    }
  });
});
