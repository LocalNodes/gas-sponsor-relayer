// A LogNewQuestion log as a node returns it: topics and ABI-encoded data, with `args` decoded by viem's own event
// decoder, so a test reads a question the way the relayer does on the chain.
import { decodeEventLog, encodeAbiParameters, encodeEventTopics } from 'viem';
import { newQuestion } from '../../src/questionTime.js';

const ZERO32 = `0x${'00'.repeat(32)}`;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

export function questionLog({ blockNumber, questionId, user, question, created, contentHash = ZERO32 }) {
  const topics = encodeEventTopics({ abi: [newQuestion], eventName: 'LogNewQuestion', args: { question_id: questionId, user, content_hash: contentHash } });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'string' }, { type: 'address' }, { type: 'uint32' }, { type: 'uint32' }, { type: 'uint256' }, { type: 'uint256' }],
    // A time that is not a whole number cannot be on the chain: Reality's 0 is the time that cannot be read.
    [0n, question, ZERO_ADDRESS, 3600, 0, 0n, typeof created === 'bigint' && created >= 0n ? created : 0n],
  );
  const { args } = decodeEventLog({ abi: [newQuestion], data, topics });
  return { blockNumber, topics, data, args };
}
