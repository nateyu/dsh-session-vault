/** Plugin identity. Loader accepts an empty config object. */

export const PLUGIN_NAME = 'dsh-session-vault'

/** Parallel blank-log probes. */
export const INSPECT_CONCURRENCY = 4

/**
 * Cold JSONL larger than this is treated as a started conversation, matching
 * the web sidebar blank probe.
 */
export const BLANK_PROBE_MAX_BYTES = 65_536

export const Config = {
  '~standard': {
    version: 1,
    vendor: PLUGIN_NAME,
    validate() {
      return { value: {} }
    },
  },
}
