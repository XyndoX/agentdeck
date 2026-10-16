// node --test tests/collect.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { category, fold, summary } from '../collector/collect.mjs'

test('tool calls sort into kinds of work', () => {
  assert.equal(category('WebSearch'), 'search')
  assert.equal(category('WebFetch'), 'crawl')
  assert.equal(category('mcp__plugin_chrome-devtools-mcp_chrome-devtools__navigate_page'), 'crawl')
  assert.equal(category('mcp__plugin_chrome-devtools-mcp_chrome-devtools__click'), 'computer')
  assert.equal(category('Edit'), 'edit')
  assert.equal(category('Bash', { command: 'cd app && npm run build' }), 'build')
  assert.equal(category('Bash', { command: 'npx vitest run' }), 'test')
  assert.equal(category('Bash', { command: 'mkdir -p tests' }), 'shell')
  assert.equal(category('Bash', { command: 'git push' }), 'git')
  assert.equal(category('Agent'), 'agent')
  assert.equal(summary('WebSearch', { query: 'kitty graphics' }), '“kitty graphics”')
})

test('a transcript folds into calls with open and finished ones', () => {
  const t = s => `2026-10-16T10:00:0${s}.000Z`
  const lines = [
    { type: 'assistant', timestamp: t(0), message: { model: 'claude-opus-5-5', usage: { output_tokens: 40 }, content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: '/x/y.ts' } }, { type: 'tool_use', id: 'b', name: 'WebSearch', input: { query: 'q' } }] } },
    { type: 'user', timestamp: t(2), message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }] } },
    'not json',
  ].map(l => typeof l === 'string' ? l : JSON.stringify(l))
  const a = fold({ id: 'main', calls: new Map(), order: [], model: '', tokensOut: 0, firstAt: 0, lastAt: 0, lastText: '', files: new Map() }, lines)
  assert.equal(a.model, 'claude-opus-5-5')
  assert.equal(a.tokensOut, 40)
  assert.equal(a.calls.get('a').err, true)
  assert.equal(a.calls.get('a').end - a.calls.get('a').start, 2000)
  assert.equal(a.calls.get('b').end, 0) // still running
  assert.equal(a.files.get('/x/y.ts').n, 1)
})
