// Group registration (D-18). A Group's Safe is sponsored only after its owners sign a
// SponsorRegistration as a SafeMessage; the relayer asks the Safe itself (EIP-1271).
import { getAddress, hashTypedData, isAddress, isHex, parseAbi, toFunctionSelector } from 'viem';
import { nameJobStarted } from './sends/ens.js';

// ERC-1271 magic value: the selector of isValidSignature(bytes32,bytes), computed, not typed.
export const ERC1271_MAGIC = toFunctionSelector('function isValidSignature(bytes32,bytes)');

const safeAbi = parseAbi(['function isValidSignature(bytes32 _dataHash, bytes _signature) view returns (bytes4)']);

export const registrationTypes = Object.freeze({
  SponsorRegistration: [
    { name: 'relayer', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'safe', type: 'address' },
    { name: 'space', type: 'string' },
    { name: 'community', type: 'string' },
  ],
});

export function registrationTypedData({ chainId, relayer, safe, space, community }) {
  return {
    domain: { name: 'gas-sponsor-relayer', version: '1', chainId: Number(chainId) },
    types: registrationTypes,
    primaryType: 'SponsorRegistration',
    message: { relayer: getAddress(relayer), chainId: BigInt(chainId), safe: getAddress(safe), space, community },
  };
}

/** EIP-712 hash of the registration. The Safe wraps it in SafeMessage itself. */
export function registrationDigest(fields) {
  return hashTypedData(registrationTypedData(fields));
}

const SPACE_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;

/**
 * Validate the request body of POST /groups. Returns {ok, value} or {ok: false, error}.
 * `relayer` and `community` are not read from the body: the relayer uses its own.
 */
export function parseRegistrationBody(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const { chainId, safe, space, signature } = body;
  if (!Number.isInteger(chainId) || chainId <= 0) return { ok: false, error: 'chainId must be a positive integer' };
  if (typeof safe !== 'string' || !isAddress(safe, { strict: false })) return { ok: false, error: 'safe must be an address' };
  if (typeof space !== 'string' || !SPACE_RE.test(space)) return { ok: false, error: 'space must be a lowercase ENS name' };
  if (typeof signature !== 'string' || !isHex(signature) || signature.length < 132 || signature.length > 2 + 2 * 65 * 32) {
    return { ok: false, error: 'signature must be hex, 65 bytes per owner' };
  }
  return { ok: true, value: { chainId, safe: getAddress(safe), space, signature } };
}

/**
 * Check on-chain that the Safe accepts the signature over the registration digest.
 * Anything but the magic value (a revert, an EOA, a wrong signer) is a refusal.
 */
export async function verifyRegistration({ publicClient, relayer, community, chainId, safe, space, signature }) {
  const digest = registrationDigest({ chainId, relayer, safe, space, community });
  try {
    const result = await publicClient.readContract({
      address: safe,
      abi: safeAbi,
      functionName: 'isValidSignature',
      args: [digest, signature],
    });
    return result === ERC1271_MAGIC;
  } catch {
    return false;
  }
}

/**
 * Store a registration whose signature the Safe has accepted (verifyRegistration). One read-and-write
 * transaction, so a racing registration or name job cannot slip between the check and the write.
 *
 * - No row: the Safe is registered ({outcome: 'created'}).
 * - Same space: nothing changes ({outcome: 'same', group}).
 * - Another space: the new space replaces the old one in the Safe's one row ({outcome: 'replaced',
 *   replaced: <old space>}), but only while no name job for the old space has started registering
 *   (nameJobStarted). Otherwise nothing changes ({outcome: 'refused'}). The case it serves: the name was
 *   taken between registration and name reservation (25-19 follow-up, ruling 2026-11-08).
 */
export function storeRegistration(db, { chainId, safe, space, community }) {
  return db.atomically(() => {
    const existing = db.getGroup(chainId, safe);
    if (!existing) {
      db.addGroup({ chainId, safe, space, community });
      return { outcome: 'created' };
    }
    if (existing.space === space) return { outcome: 'same', group: existing };
    const label = existing.space.endsWith('.eth') ? existing.space.slice(0, -'.eth'.length) : null;
    if (label !== null && db.listJobsFor(chainId, safe, label).some(nameJobStarted)) return { outcome: 'refused' };
    if (db.replaceGroupSpace({ chainId, safe, from: existing.space, space, community }) !== 1) return { outcome: 'refused' };
    return { outcome: 'replaced', replaced: existing.space };
  });
}

/** Is this Safe registered on this chain? Every send passes this before the allowlist. */
export function isRegistered(db, chainId, safe) {
  return db.getGroup(chainId, safe) !== null;
}
