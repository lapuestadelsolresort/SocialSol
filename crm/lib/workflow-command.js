'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { ROOT } = require('../../lib/runtime-paths');

const MAX_CAPTURE_BYTES = 1024 * 1024;

function cleanEnvironment(extra = {}) {
  return {
    ...process.env,
    SOCIALSOL_ROOT: ROOT,
    ...extra,
  };
}

function resolveRepoFile(relativePath) {
  const absolute = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`workflow command escapes repository root: ${relativePath}`);
  }
  return absolute;
}

function runCommand({ executable, args = [], cwd = ROOT, env = {}, timeoutMs = 10 * 60_000 } = {}) {
  if (!executable || !Array.isArray(args)) throw new Error('invalid workflow command specification');
  return new Promise((resolve, reject) => {
    execFile(executable, args.map(String), {
      cwd,
      env: cleanEnvironment(env),
      timeout: timeoutMs,
      maxBuffer: MAX_CAPTURE_BYTES,
      windowsHide: true,
    }, (error, stdout = '', stderr = '') => {
      const result = {
        executable: path.basename(executable),
        exitCode: Number.isInteger(error?.code) ? error.code : 0,
        signal: error?.signal || null,
        stdout: String(stdout).slice(0, MAX_CAPTURE_BYTES),
        stderr: String(stderr).slice(0, MAX_CAPTURE_BYTES),
      };
      if (!error) return resolve(result);
      const wrapped = new Error(`workflow command failed (${result.executable}, exit ${result.exitCode}): ${result.stderr.trim() || error.message}`);
      wrapped.code = error.killed ? 'workflow_command_timeout' : 'workflow_command_failed';
      wrapped.retryable = error.killed || result.exitCode === 75;
      wrapped.result = result;
      return reject(wrapped);
    });
  });
}

function nodeCommand(relativeScript, args = [], options = {}) {
  return {
    executable: process.execPath,
    args: [resolveRepoFile(relativeScript), ...args],
    ...options,
  };
}

function pythonCommand(relativeScript, args = [], options = {}) {
  return {
    executable: process.env.PYTHON_BIN || 'python3',
    args: [resolveRepoFile(relativeScript), ...args],
    ...options,
  };
}

module.exports = {
  MAX_CAPTURE_BYTES,
  cleanEnvironment,
  nodeCommand,
  pythonCommand,
  resolveRepoFile,
  runCommand,
};
