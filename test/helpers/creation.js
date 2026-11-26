// The Sepolia Safe 1.4.1 init code hash: keccak256(the factory's proxyCreationCode() ++ the L2 singleton as a uint256).
// Only the hash is kept here (licence guard); the fork suite reads the factory's code on the fork and checks it.
export const SEPOLIA_INIT_CODE_HASH = '0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee';

/** A stand-in for creationCodeReader() that answers the Sepolia hash without a read (unit tests, no network). */
export const sepoliaCreationCode = async () => ({ ok: true, hash: SEPOLIA_INIT_CODE_HASH });
