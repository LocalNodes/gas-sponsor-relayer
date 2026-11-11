import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { toFunctionSelector } from 'viem';
import { build, DELEGATECALL_TARGET_KEYS, SELECTORS, SIGNATURES } from '../../src/allowlist.js';
import { loadNetworks } from '../../src/config.js';
import { SAFE } from '../helpers/stub.js';

const networks = loadNetworks();
const SEPOLIA = 11155111;
const sepolia = networks[String(SEPOLIA)];
const groups = [{ chainId: SEPOLIA, safe: SAFE, space: 'a.eth' }];

// Expected selectors and encodings, computed independently with viem.
const EXPECTED = {
  execTransaction: '0x6a761202',
  deployModule: '0xf1ab873c',
  addProposal: '0x8dcd2661',
  executeProposalWithIndex: '0x14604b8c',
  submitAnswer: '0x77f325df',
  claimWinnings: '0x1101a0fd',
  withdraw: '0x3ccfd60b',
  createTemplate: '0x83bf4609',
  commit: '0xf14fcbc8',
  register: '0xcff3e7c2',
  approve: '0x095ea7b3',
  mint: '0x40c10f19',
};

describe('allowlist', () => {
  test('allowlist: each selector constant equals keccak of its Solidity signature', () => {
    assert.deepEqual(Object.keys(SELECTORS).sort(), Object.keys(SIGNATURES).sort());
    for (const [name, sig] of Object.entries(SIGNATURES)) {
      assert.equal(SELECTORS[name], toFunctionSelector(`function ${sig}`), name);
      assert.equal(SELECTORS[name], EXPECTED[name], `${name} against the expected selector`);
    }
  });

  test('allowlist: accepts a registered Safe execTransaction', () => {
    assert.deepEqual(build(networks, groups).check(SEPOLIA, SAFE, SELECTORS.execTransaction, 0, sepolia.reality), { ok: true });
  });

  test('allowlist: refuses an unknown chain, an unregistered Safe and an unlisted selector', () => {
    const list = build(networks, groups);
    assert.equal(list.check(1, SAFE, SELECTORS.execTransaction).reason, 'unknown_chain');
    assert.equal(list.check(SEPOLIA, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', SELECTORS.execTransaction).reason, 'target_not_allowed');
    assert.equal(list.check(SEPOLIA, SAFE, SELECTORS.submitAnswer).reason, 'selector_not_allowed');
    assert.equal(list.check(SEPOLIA, sepolia.reality, SELECTORS.execTransaction).reason, 'selector_not_allowed');
    assert.equal(list.check(SEPOLIA, sepolia.reality, SELECTORS.submitAnswer).ok, true);
    // A registered Group on one chain gives no access on another chain.
    assert.equal(list.check(84532, SAFE, SELECTORS.execTransaction).ok, false);
  });

  test('allowlist: operation 1 (delegatecall) only to the four Safe library targets', () => {
    const list = build(networks, groups);
    assert.deepEqual([...DELEGATECALL_TARGET_KEYS].sort(), ['createCall', 'multiSend', 'multiSendCallOnly', 'signMessageLib']);
    for (const key of DELEGATECALL_TARGET_KEYS) {
      assert.equal(list.check(SEPOLIA, SAFE, SELECTORS.execTransaction, 1, sepolia[key]).ok, true, key);
    }
    for (const outside of [sepolia.reality, sepolia.hats, sepolia.moduleProxyFactory, sepolia.realityMastercopy, SAFE, null]) {
      assert.equal(list.check(SEPOLIA, SAFE, SELECTORS.execTransaction, 1, outside).reason, 'delegatecall_target_not_allowed', String(outside));
    }
    assert.equal(list.check(SEPOLIA, SAFE, SELECTORS.execTransaction, 2, sepolia.multiSend).reason, 'bad_operation');
    // Operation 0 to the same libraries is an ordinary call and is not restricted by target.
    assert.equal(list.check(SEPOLIA, SAFE, SELECTORS.execTransaction, 0, sepolia.reality).ok, true);
  });

  test('allowlist: addresses compare case-insensitively and one hex digit different is refused', () => {
    const list = build(networks, groups);
    assert.equal(list.check(SEPOLIA, SAFE.toLowerCase(), SELECTORS.execTransaction).ok, true);
    assert.equal(list.check(SEPOLIA, SAFE.toUpperCase().replace('0X', '0x'), SELECTORS.execTransaction).ok, true);
    assert.equal(list.check(SEPOLIA, sepolia.reality.toLowerCase(), SELECTORS.submitAnswer.toUpperCase().replace('0X', '0x')).ok, true);
    const flipped = `${SAFE.slice(0, -1)}${SAFE.endsWith('0') ? '1' : '0'}`;
    assert.equal(list.check(SEPOLIA, flipped, SELECTORS.execTransaction).ok, false);
    const flippedLib = `${sepolia.multiSend.slice(0, -1)}${sepolia.multiSend.endsWith('6') ? '7' : '6'}`;
    assert.equal(list.check(SEPOLIA, SAFE, SELECTORS.execTransaction, 1, flippedLib).ok, false);
    assert.equal(list.check(SEPOLIA, SAFE, SELECTORS.execTransaction, 1, sepolia.multiSend.toLowerCase()).ok, true);
  });

  test('allowlist: an empty networks entry gives its chain no tuples, even for a registered Group', () => {
    const empty = { ...networks, 84532: {}, 999: { name: 'x', rpcUrls: ['http://x.invalid'], _sources: {} } };
    const list = build(empty, [...groups, { chainId: 84532, safe: SAFE }, { chainId: 999, safe: SAFE }]);
    assert.equal(list.check(84532, SAFE, SELECTORS.execTransaction).reason, 'unknown_chain');
    assert.equal(list.check(999, SAFE, SELECTORS.execTransaction).reason, 'unknown_chain');
    assert.equal(build({}, groups).tuples.length, 0);
    assert.equal(build(undefined, groups).check(SEPOLIA, SAFE, SELECTORS.execTransaction).ok, false);
  });
});

describe('no-direct-hats', () => {
  test('no-direct-hats: no chain allows a Hats, Arbitrator or enableModule call, and the relayer is never msg.sender of a mint', () => {
    const forbidden = [
      'mintHat(uint256,address)',
      'batchMintHats(uint256[],address[])',
      'setHatWearerStatus(uint256,address,bool,bool)',
      'mintTopHat(address,string,string)',
      'createHat(uint256,string,uint32,address,address,bool,string)',
      'enableModule(address)',
    ].map((s) => toFunctionSelector(`function ${s}`));
    assert.equal(new Set(forbidden).size, 6);
    const list = build(networks, [{ chainId: SEPOLIA, safe: SAFE }, { chainId: 84532, safe: SAFE }]);
    assert.ok(list.tuples.length > 0);
    const hatsAddresses = Object.values(networks).map((n) => n.hats.toLowerCase());
    for (const tuple of list.tuples) {
      const [, target, selector] = tuple.split(':');
      assert.ok(!hatsAddresses.includes(target), `Hats contract in tuple ${tuple}`);
      assert.ok(!forbidden.includes(selector), `forbidden selector in tuple ${tuple}`);
    }
    for (const n of ['mintHat', 'batchMintHats', 'setHatWearerStatus', 'mintTopHat', 'createHat', 'enableModule']) {
      assert.equal(SELECTORS[n], undefined, n);
    }
    // Also through check(): a send to Hats with a mint selector is refused.
    for (const s of forbidden) assert.equal(list.check(SEPOLIA, networks[String(SEPOLIA)].hats, s).ok, false);
  });
});
