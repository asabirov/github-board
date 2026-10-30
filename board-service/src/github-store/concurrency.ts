/** Each baseline, read and delivery holds one connection, and each kind is
 *  gated to its number below, so a transaction that holds a slot always finds
 *  a free connection in the pool of `STORE_CONNECTIONS`. */
export const BASELINES_AT_ONCE = 2;
export const READS_AT_ONCE = 2;
export const DELIVERY_CONNECTIONS = 2;
export const STORE_CONNECTIONS = BASELINES_AT_ONCE + READS_AT_ONCE + DELIVERY_CONNECTIONS;
