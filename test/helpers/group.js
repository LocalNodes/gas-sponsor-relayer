// A Group for the Reality tests (25-07), built on whichever fork FORK_NETWORK names.
//
// The Group is a 2-of-2 Safe with a Zodiac Reality module that the Safe owns, avatars and targets, set up the way
// the real setup batch sets the module up (timeout 600 s, cooldown 300 s, no expiration, minimum bond 0.001 ETH).
// It is built from the chain's own addresses in config/networks.json, with random salts, so every test file gets its own
// Group and the same helper works on Ethereum Sepolia and Base Sepolia (25-26). The full setup batch, with the reference
// Arbitrator and the hats, is proven in setup.fork.test.js; these tests do not need them.
//
// Reality.eth refuses a question whose template does not exist, so the helper creates the SafeSnap template on the
// fork and passes its id to the module. The module never reads the template text; only Reality's template id counts.
import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, encodeFunctionData, getAddress, hexToBigInt, parseAbi, toHex, zeroAddress } from 'viem';
import { loadNetworks } from '../../src/config.js';
import { account, CHAIN_ID, signRegistration, signSafeTx, deploySafe } from './fork.js';

process.env.WEB3_ENABLED = 'true';

export const GROUP = Object.freeze({ timeout: 600, cooldown: 300, expiration: 0, bond: 10n ** 15n });

/** The SafeSnap question template. */
export const SAFESNAP_TEMPLATE = JSON.stringify({
  title:
    'Did the Snapshot proposal with the id %s pass the execution of the array of Module transactions with the hash 0x%s? The hash is the keccak of the concatenation of the individual EIP-712 hashes of the Module transactions. If this question was asked before the Snapshot proposal was resolved it should ALWAYS be resolved to INVALID!',
  lang: 'en',
  type: 'bool',
  category: 'DAO proposal',
});

export const realityAbi = parseAbi([
  'function createTemplate(string content) returns (uint256)',
  'function templates(uint256) view returns (uint256)',
  'function isFinalized(bytes32 question_id) view returns (bool)',
  'function getFinalizeTS(bytes32 question_id) view returns (uint32)',
  'function getBestAnswer(bytes32 question_id) view returns (bytes32)',
  'function getBond(bytes32 question_id) view returns (uint256)',
  'function resultFor(bytes32 question_id) view returns (bytes32)',
  'function balanceOf(address) view returns (uint256)',
  'function submitAnswer(bytes32 question_id, bytes32 answer, uint256 max_previous) payable',
  'function claimWinnings(bytes32 question_id, bytes32[] history_hashes, address[] addrs, uint256[] bonds, bytes32[] answers)',
  'function withdraw()',
  'event LogNewAnswer(bytes32 answer, bytes32 indexed question_id, bytes32 history_hash, address indexed user, uint256 bond, uint256 ts, bool is_commitment)',
]);

export const moduleAbi = parseAbi([
  'function questionIds(bytes32 questionHash) view returns (bytes32)',
  'function executedProposalTransactions(bytes32 questionHash, bytes32 txHash) view returns (bool)',
  'function minimumBond() view returns (uint256)',
  'function questionCooldown() view returns (uint32)',
  'function questionTimeout() view returns (uint32)',
  'function template() view returns (uint256)',
  'function buildQuestion(string proposalId, bytes32[] txHashes) view returns (string)',
  'function getQuestionId(string question, uint256 nonce) view returns (bytes32)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 nonce) view returns (bytes32)',
]);

const factoryAbi = parseAbi(['function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)']);
const setUpAbi = parseAbi(['function setUp(bytes initializeParams)']);
const safeAbi = parseAbi([
  'function enableModule(address module)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool success)',
]);

export const networkEntry = () => loadNetworks()[String(CHAIN_ID)];

/** Create the SafeSnap template on the fork and return its id (Reality 3.0 hands out ids in order). */
export async function createTemplate(pub, wallet) {
  const { reality } = networkEntry();
  const payer = account(2);
  const sim = await pub.simulateContract({ account: payer, address: reality, abi: realityAbi, functionName: 'createTemplate', args: [SAFESNAP_TEMPLATE] });
  const hash = await wallet(payer).writeContract(sim.request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('createTemplate reverted');
  if ((await pub.readContract({ address: reality, abi: realityAbi, functionName: 'templates', args: [sim.result] })) === 0n) throw new Error('template not stored');
  return sim.result;
}

/**
 * A 2-of-2 Safe with the Reality module deployed, owned by the Safe and enabled, and 0.01 ETH in the Safe.
 * Returns { safe, module, templateId, owners, space }.
 */
export async function createGroup(pub, wallet, { owners = [account(0), account(1)], fund = 10n ** 16n } = {}) {
  const net = networkEntry();
  const templateId = await createTemplate(pub, wallet);
  const safe = await deploySafe(pub, wallet, owners, 2);

  const params = encodeAbiParameters(
    [
      { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' },
      { type: 'uint32' }, { type: 'uint32' }, { type: 'uint32' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'address' },
    ],
    // owner, avatar, target = the Safe; the Safe also stands in as the arbitrator, which these tests never call on.
    [safe, safe, safe, net.reality, GROUP.timeout, GROUP.cooldown, GROUP.expiration, GROUP.bond, templateId, safe],
  );
  const initializer = encodeFunctionData({ abi: setUpAbi, functionName: 'setUp', args: [params] });
  const saltNonce = hexToBigInt(toHex(randomBytes(16)));
  const payer = account(2);
  const sim = await pub.simulateContract({ account: payer, address: net.moduleProxyFactory, abi: factoryAbi, functionName: 'deployModule', args: [net.realityMastercopy, initializer, saltNonce] });
  const deployed = await pub.waitForTransactionReceipt({ hash: await wallet(payer).writeContract(sim.request) });
  if (deployed.status !== 'success') throw new Error('module deployment reverted');
  const module = getAddress(sim.result);

  // The owners enable the module on their Safe (a Safe transaction, executed by any account).
  const tx = { to: safe, value: 0n, data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [module] }), operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress };
  const signatures = await signSafeTx(pub, safe, tx, owners);
  const executor = account(3);
  const exec = await pub.waitForTransactionReceipt({
    hash: await wallet(executor).writeContract({
      address: safe,
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures],
    }),
  });
  if (exec.status !== 'success') throw new Error('enableModule reverted');
  if (!(await pub.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [module] }))) throw new Error('module not enabled');

  if (fund > 0n) {
    const funded = await pub.waitForTransactionReceipt({ hash: await wallet(account(4)).sendTransaction({ to: safe, value: fund }) });
    if (funded.status !== 'success') throw new Error('funding the Safe failed');
  }
  return { safe, module, templateId, owners, space: `reality-${randomBytes(4).toString('hex')}.eth` };
}

/** Register the Group with a running relayer (owner-signed, 201). */
export async function registerGroup(relayer, group) {
  const signature = await signRegistration({ relayer: relayer.relayer, safe: group.safe, space: group.space, signers: group.owners });
  const res = await relayer.call('POST', '/groups', { chainId: CHAIN_ID, safe: group.safe, space: group.space, signature });
  if (res.status !== 201) throw new Error(`registration answered ${res.status}: ${res.text}`);
  return res;
}

/** The module's own hash of one transaction at one index, from its on-chain view (not the relayer's formula). */
export function moduleTxHash(pub, module, tx, nonce) {
  return pub.readContract({ address: module, abi: moduleAbi, functionName: 'getTransactionHash', args: [tx.to, BigInt(tx.value), tx.data ?? '0x', tx.operation ?? 0, BigInt(nonce)] });
}

/** Move the fork's clock: the next block carries timestamp `ts`. */
export async function mineAt(pub, ts) {
  await pub.request({ method: 'evm_setNextBlockTimestamp', params: [Number(ts)] });
  await pub.request({ method: 'evm_mine', params: [] });
}

export const latestTimestamp = async (pub) => (await pub.getBlock()).timestamp;

/** Poll until the relayer's queue has seen the receipt of `hash` (the queue settles the cap ledger on a tick). */
export async function settle(pub, relayer, hash) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  await relayer.queue.tick();
  return receipt;
}
