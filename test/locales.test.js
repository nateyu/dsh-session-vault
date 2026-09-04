import { test } from 'node:test'
import assert from 'node:assert/strict'

import { zh, en } from '../client/locales.js'

test('English locale keys match the Chinese key set', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
})
