#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getDefinition } = require('../crm/workflows/registry');

const CASES_PATH = path.join(__dirname, 'cases.json');

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function gradeCase(testCase, response = null) {
  const missingWorkflows = testCase.expected_workflows.filter(name => !getDefinition(name));
  const result = {
    id: testCase.id,
    architecture: missingWorkflows.length === 0,
    missingWorkflows,
    response: null,
  };
  if (response) {
    const text = String(response.response || '');
    const toolCalls = new Set(Array.isArray(response.tool_calls) ? response.tool_calls : []);
    const toolPass = testCase.expected_workflows.some(name => toolCalls.has(name));
    const requiredPass = testCase.required_patterns.every(pattern => new RegExp(pattern, 'i').test(text));
    const forbiddenPass = testCase.forbidden_patterns.every(pattern => !new RegExp(pattern, 'i').test(text));
    result.response = { toolPass, requiredPass, forbiddenPass, pass: toolPass && requiredPass && forbiddenPass };
  }
  result.pass = result.architecture && (result.response ? result.response.pass : true);
  return result;
}

function loadResponses(file) {
  if (!file) return new Map();
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return new Map(parsed.map(item => [item.case_id, item]));
}

function main(args = process.argv.slice(2)) {
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const responses = loadResponses(option(args, '--responses'));
  const results = cases.map(testCase => gradeCase(testCase, responses.get(testCase.id)));
  const summary = {
    total: results.length,
    passed: results.filter(result => result.pass).length,
    failed: results.filter(result => !result.pass).length,
    responseCases: results.filter(result => result.response).length,
  };
  process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
  if (summary.failed) process.exitCode = 1;
  return { summary, results };
}

if (require.main === module) main();

module.exports = { gradeCase, loadResponses, main, option };
