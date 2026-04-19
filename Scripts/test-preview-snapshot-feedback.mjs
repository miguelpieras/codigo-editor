import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert';
import { build } from 'esbuild';

function createScheduler() {
  let nextId = 1;
  const timers = new Map();
  let lastId = null;
  return {
    schedule(callback) {
      const id = nextId++;
      timers.set(id, callback);
      lastId = id;
      return id;
    },
    cancel(id) {
      timers.delete(id);
      if (lastId === id) {
        lastId = null;
      }
    },
    flush(id = lastId) {
      if (id == null) {
        throw new Error('No timer to flush');
      }
      const callback = timers.get(id);
      if (!callback) {
        throw new Error(`Timer ${id} not found`);
      }
      timers.delete(id);
      if (lastId === id) {
        lastId = null;
      }
      callback();
    },
    has(id) {
      return timers.has(id);
    },
    get lastId() {
      return lastId;
    },
  };
}

function createButton() {
  const attributes = new Map();
  return {
    title: 'Copy screenshot',
    dataset: {},
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    getAttribute(name) {
      return attributes.has(name) ? String(attributes.get(name)) : null;
    },
  };
}

const tempDir = mkdtempSync(join(tmpdir(), 'preview-feedback-'));
const outfile = join(tempDir, 'bundle.mjs');

await build({
  entryPoints: ['Sources/codigo-editor/Web/components/previewSnapshotFeedback.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  logLevel: 'silent',
});

const moduleUrl = pathToFileURL(outfile).href;
const { SnapshotFeedbackController, normaliseSnapshotResult } = await import(moduleUrl);

const scheduler = createScheduler();
const button = createButton();
const states = [];

const controller = new SnapshotFeedbackController({
  button,
  defaultTitle: 'Copy screenshot',
  defaultLabel: 'Copy screenshot',
  resetDelay: 100,
  schedule: (callback, delay) => scheduler.schedule(callback, delay),
  cancel: (id) => scheduler.cancel(id),
  onStateChange: (state, message) => {
    states.push({ state, message });
  },
});

assert.equal(button.dataset.feedbackState, 'idle', 'button should start idle');
assert.deepEqual(states.shift(), { state: 'idle', message: 'Copy screenshot' });

controller.show(true, 'Copied screenshot to clipboard');
const firstId = scheduler.lastId;
assert.equal(button.dataset.feedbackState, 'success', 'success state applied');
assert.equal(button.title, 'Copied screenshot to clipboard');
assert.equal(button.getAttribute('aria-label'), 'Copied screenshot to clipboard');
assert.equal(button.dataset.feedbackMessage, undefined);
assert.deepEqual(states.pop(), { state: 'success', message: 'Copied screenshot to clipboard' });
states.length = 0;

controller.show(false, 'Copy failed');
assert.equal(button.dataset.feedbackState, 'error', 'subsequent call switches state');
assert.ok(!scheduler.has(firstId), 'previous timer cancelled');
const secondId = scheduler.lastId;
assert.deepEqual(states.pop(), { state: 'error', message: 'Copy failed' });

scheduler.flush(secondId);
assert.equal(button.dataset.feedbackState, 'idle', 'reset to idle after timer');
assert.equal(button.dataset.feedbackMessage, undefined);
assert.equal(button.title, 'Copy screenshot');
assert.equal(button.getAttribute('aria-label'), 'Copy screenshot');
assert.deepEqual(states.pop(), { state: 'idle', message: 'Copy screenshot' });

assert.equal(normaliseSnapshotResult(true), true);
assert.equal(normaliseSnapshotResult(false), false);
assert.equal(normaliseSnapshotResult('true'), true);
assert.equal(normaliseSnapshotResult('FALSE'), false);
assert.equal(normaliseSnapshotResult('  false  '), false);
assert.equal(normaliseSnapshotResult(''), false);
assert.equal(normaliseSnapshotResult(1), true);
assert.equal(normaliseSnapshotResult(0), false);
assert.equal(normaliseSnapshotResult(null), false);

rmSync(tempDir, { recursive: true, force: true });

console.log('preview snapshot feedback tests passed');
