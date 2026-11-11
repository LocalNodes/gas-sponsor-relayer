// Per configured chain: a public client for reads (falling back across the RPC URLs), a proof client on the first
// URL only, and a wallet client that broadcasts on that same URL, once. Sends go through the serial per-chain
// queue in queue.js, so two sends from the one key never race for a nonce.
import { createPublicClient, createWalletClient, defineChain, fallback, http } from 'viem';
import { chainIsConfigured, chainIsSponsored } from './config.js';

export function createChains({ config, networks }) {
  const clients = new Map();

  function build(chainId) {
    const entry = networks[String(chainId)];
    const urls = config.rpcUrls[String(chainId)] ? [config.rpcUrls[String(chainId)]] : entry.rpcUrls;
    const chain = defineChain({
      id: Number(chainId),
      name: entry.name ?? String(chainId),
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: urls } },
    });
    // Reads may fall back from one URL to the next.
    const transport = urls.length === 1 ? http(urls[0]) : fallback(urls.map((u) => http(u)));
    return {
      chain,
      // False on a chain whose sends the relayer does not pay for (Base Sepolia until Phase 30): the queue and the
      // pipeline refuse them before anything is reserved or sent.
      sponsored: chainIsSponsored(networks, chainId),
      publicClient: createPublicClient({ chain, transport }),
      // The release proof (queue.js) reads one endpoint in one pass, never a mix: the one the broadcasts go to.
      proofClient: createPublicClient({ chain, transport: http(urls[0]) }),
      // The raw broadcast goes to one endpoint, once: no fallback and no retry (25-28 round 2, HIGH 1). A fallback
      // would try the next URL after the first took the send and lost its answer, and the next URL's refusal would
      // then hide a live broadcast. One attempt makes "the node refused" mean what it says.
      walletClient: config.account ? createWalletClient({ account: config.account, chain, transport: http(urls[0], { retryCount: 0 }) }) : null,
    };
  }

  return {
    /** Clients for a configured chain, or null. */
    get(chainId) {
      if (!chainIsConfigured(networks, chainId)) return null;
      const key = String(chainId);
      if (!clients.has(key)) clients.set(key, build(chainId));
      return clients.get(key);
    },
  };
}
