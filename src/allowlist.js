// Static (chainId, target, selector) allowlist (D-09, criterion 5).
//
// The relayer may send only the tuples this module builds: addresses from config/networks.json,
// plus each registered Group's own Safe for execTransaction. It never calls Hats, an Arbitrator
// or enableModule itself: those run inside owner-signed Safe transactions, so the relayer is
// never msg.sender of a mint (D-05). Inner calls of a signed Safe transaction are not
// restricted by target; only delegatecall targets are (four Safe library contracts).
import { ADDRESS_KEYS } from './config.js';

// Solidity signature of every function the relayer may ever send. The selector is the first
// four bytes of keccak256 of the signature; test/unit/allowlist.test.js recomputes each one.
export const SIGNATURES = Object.freeze({
  execTransaction: 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
  deployModule: 'deployModule(address,bytes,uint256)',
  addProposal: 'addProposal(string,bytes32[])',
  executeProposalWithIndex: 'executeProposalWithIndex(string,bytes32[],address,uint256,bytes,uint8,uint256)',
  submitAnswer: 'submitAnswer(bytes32,bytes32,uint256)',
  claimWinnings: 'claimWinnings(bytes32,bytes32[],address[],uint256[],bytes32[])',
  withdraw: 'withdraw()',
  createTemplate: 'createTemplate(string)',
  commit: 'commit(bytes32)',
  register: 'register(string,address,bytes32,address,address,uint64,address,bytes32)',
  approve: 'approve(address,uint256)',
  mint: 'mint(address,uint256)',
});

export const SELECTORS = Object.freeze({
  execTransaction: '0x6a761202', // execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)
  deployModule: '0xf1ab873c', // deployModule(address,bytes,uint256)
  addProposal: '0x8dcd2661', // addProposal(string,bytes32[])
  executeProposalWithIndex: '0x14604b8c', // executeProposalWithIndex(string,bytes32[],address,uint256,bytes,uint8,uint256)
  submitAnswer: '0x77f325df', // submitAnswer(bytes32,bytes32,uint256)
  claimWinnings: '0x1101a0fd', // claimWinnings(bytes32,bytes32[],address[],uint256[],bytes32[])
  withdraw: '0x3ccfd60b', // withdraw()
  createTemplate: '0x83bf4609', // createTemplate(string)
  commit: '0xf14fcbc8', // commit(bytes32)  (ENSv2 registrar)
  register: '0xcff3e7c2', // register(string,address,bytes32,address,address,uint64,address,bytes32)  (ENSv2 registrar)
  approve: '0x095ea7b3', // approve(address,uint256)  (ERC-20)
  mint: '0x40c10f19', // mint(address,uint256)  (MockUSDC)
});

/** networks.json keys whose addresses a Safe transaction may delegatecall (operation 1). */
export const DELEGATECALL_TARGET_KEYS = Object.freeze(['multiSend', 'multiSendCallOnly', 'createCall', 'signMessageLib']);

// Static rows: networks.json key -> selectors the relayer may send to that address.
// Hats, Arbitrator and enableModule never appear here (D-05, no-direct-hats test).
// The Zodiac module's own calls (addProposal, executeProposalWithIndex) are added per Group by
// build()'s `modules` argument, and only for modules groups.js found on the chain (25-06, TM-77);
// deployModule runs inside the owners' Safe batch, never from here.
const STATIC_ROWS = Object.freeze({
  reality: ['submitAnswer', 'claimWinnings', 'withdraw', 'createTemplate'],
  ensRegistrar: ['commit', 'register'],
  ensPaymentToken: ['approve', 'mint'],
});

// Selectors the relayer may send to a Group's own Reality module (25-07 uses them).
const MODULE_ROWS = Object.freeze(['addProposal', 'executeProposalWithIndex']);

const lower = (a) => String(a).toLowerCase();
const tupleKey = (chainId, target, selector) => `${Number(chainId)}:${lower(target)}:${lower(selector)}`;

/**
 * Build the allowlist for the given networks and registered Groups.
 * An empty or missing networks entry gives that chain no tuples at all: every send is refused,
 * even for a Group that is somehow registered on it.
 * `modules` is [{chainId, module}] as found on the chain by groups.js; each one gets the module rows
 * on a configured chain. Nothing in a request can add to it.
 */
export function build(networks, groups = [], modules = []) {
  const tuples = new Set();
  const delegate = new Map(); // chainId -> Set of lowercase library addresses
  const chains = new Set();

  for (const [id, entry] of Object.entries(networks ?? {})) {
    const hasAddress = ADDRESS_KEYS.some((k) => typeof entry?.[k] === 'string' && entry[k] !== '');
    if (!hasAddress) continue;
    chains.add(Number(id));
    for (const [key, names] of Object.entries(STATIC_ROWS)) {
      if (typeof entry[key] !== 'string' || entry[key] === '') continue;
      for (const n of names) tuples.add(tupleKey(id, entry[key], SELECTORS[n]));
    }
    const libs = new Set();
    for (const key of DELEGATECALL_TARGET_KEYS) {
      if (typeof entry[key] === 'string' && entry[key] !== '') libs.add(lower(entry[key]));
    }
    delegate.set(Number(id), libs);
  }
  for (const g of groups) {
    if (!chains.has(Number(g.chainId))) continue;
    tuples.add(tupleKey(g.chainId, g.safe, SELECTORS.execTransaction));
  }
  for (const m of modules) {
    if (!chains.has(Number(m.chainId))) continue;
    for (const n of MODULE_ROWS) tuples.add(tupleKey(m.chainId, m.module, SELECTORS[n]));
  }

  return {
    tuples: [...tuples],
    /**
     * Decide one outgoing call. `operation` and `innerTo` describe the inner call of an
     * execTransaction (operation 1 = delegatecall to innerTo).
     * Returns {ok: true} or {ok: false, reason}.
     */
    check(chainId, target, selector, operation = 0, innerTo = null) {
      if (!chains.has(Number(chainId))) return { ok: false, reason: 'unknown_chain' };
      if (!tuples.has(tupleKey(chainId, target, selector))) {
        const targetKnown = [...tuples].some((t) => t.startsWith(`${Number(chainId)}:${lower(target)}:`));
        return { ok: false, reason: targetKnown ? 'selector_not_allowed' : 'target_not_allowed' };
      }
      if (operation !== 0 && operation !== 1) return { ok: false, reason: 'bad_operation' };
      if (operation === 1) {
        if (lower(selector) !== lower(SELECTORS.execTransaction)) return { ok: false, reason: 'bad_operation' };
        if (!innerTo || !delegate.get(Number(chainId))?.has(lower(innerTo))) {
          return { ok: false, reason: 'delegatecall_target_not_allowed' };
        }
      }
      return { ok: true };
    },
  };
}
