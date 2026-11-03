/**
 * The module OpenCode loads (`package.json` `main`, `exports["."]` and
 * `exports["./server"]`). It exports the plugin and nothing else.
 *
 * The host calls every export of a plugin module as a plugin: opencode-ai
 * 1.19.3's loader walks `Object.values` of the module, skips repeated values,
 * and throws "Plugin export is not a function" on anything that is neither a
 * function nor an object with a `server` function (read from the installed
 * bundle, not run). `./plugin.ts` also exports constants and helpers for MAD's
 * own tests and scripts, so it cannot be the entry. Import those from
 * `./plugin.ts`, never from here.
 */
import { MadPlugin } from "./plugin.ts"

export default MadPlugin
