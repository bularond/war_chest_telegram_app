/**
 * The addon, loaded.
 *
 * Kept as CommonJS on purpose: a native addon is a `require`, and wrapping it in
 * an ESM shim only moves the `createRequire` somewhere less obvious.
 */
module.exports = require('./wc-core.node');
