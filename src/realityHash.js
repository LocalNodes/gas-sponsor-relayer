// Zodiac Reality module v2.0.0 hashes, computed locally (RealityModule.sol lines 11-21, 402-411, 449-513).
// test/unit/answer.test.js holds these to test/fixtures/vectors/reality.json, and the fork tests hold them to the module's
// own views (getTransactionHash, buildQuestion, getQuestionId).
import { concat, encodeAbiParameters, keccak256, toBytes } from 'viem';

export const DOMAIN_TYPEHASH = '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218';
export const TRANSACTION_TYPEHASH = '0x72e9670a7ee00f5fbf1049b8c38e3f22fab7e9b85029e85cf9412f17fdd5c2ad';
/** U+241F, UTF-8 bytes e2 90 9f: the module joins the proposal id and the transaction hash with it. */
export const QUESTION_SEPARATOR = '␟';

/** The module's hash of one transaction. `nonce` is the transaction's index in the proposal. */
export function moduleTransactionHash(chainId, module, tx, nonce) {
  const domainSeparator = keccak256(
    encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [DOMAIN_TYPEHASH, BigInt(chainId), module]),
  );
  const transactionHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'uint256' }],
      [TRANSACTION_TYPEHASH, tx.to, BigInt(tx.value), keccak256(tx.data), tx.operation, BigInt(nonce)],
    ),
  );
  return keccak256(concat(['0x1901', domainSeparator, transactionHash]));
}

/** keccak256 of the packed transaction hashes, in the proposal's order. */
export function packedTxHashes(txHashes) {
  return keccak256(concat(txHashes));
}

/** proposalId + U+241F + the lowercase hex (no 0x) of the packed hash. */
export function buildQuestion(proposalId, txHashes) {
  return proposalId + QUESTION_SEPARATOR + packedTxHashes(txHashes).slice(2);
}

/** The key of the module's questionIds mapping. */
export const questionHashOf = (question) => keccak256(toBytes(question));
