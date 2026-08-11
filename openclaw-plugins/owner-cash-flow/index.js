import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_SCRIPT = 'crm/scripts/owner-cash-flow.js';

export function isOwnerCashFlowQuestion(body) {
  const text = String(body || '').toLowerCase();
  const bookingContext = /\b(book(?:ing|ings|ed)?|reservations?|stays?|guests?|airbnb|vrbo|squarespace|direct|payouts?)\b/.test(text);
  const financialContext = /\b(cash\s*flows?|(?:future|forward|upcoming|booked)\s+(?:booking\s+)?revenue|cash\s+(?:is\s+)?still\s+(?:coming|incoming)|money\s+(?:is\s+)?(?:still\s+)?coming\s+in|expected\s+(?:income|receipts?|payouts?)|upcoming\s+payouts?|receivables?|bookings?\s+worth|balances?\s+(?:due|owed|remaining)|future\s+value)\b/.test(text);
  return bookingContext && financialContext;
}

export function reportArgsFromPrompt(body) {
  const text = String(body || '');
  const args = [];
  const asOf = text.match(/\bas[- ]of\s+(20\d{2}-\d{2}-\d{2})\b/i)?.[1];
  const through = text.match(/\bthrough\s+(20\d{2}-\d{2}-\d{2})\b/i)?.[1];
  if (asOf) args.push('--as-of', asOf);
  if (through) args.push('--through', through);
  return args;
}

function safePluginConfig(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function resolveScript(workspaceDir, relativePath) {
  const workspace = path.resolve(workspaceDir || '');
  const script = path.resolve(workspace, relativePath || DEFAULT_SCRIPT);
  if (!workspaceDir || (script !== workspace && !script.startsWith(`${workspace}${path.sep}`))) {
    throw new Error('owner cash-flow script must remain inside the agent workspace');
  }
  return { workspace, script };
}

export async function executeCanonicalReport({
  workspaceDir,
  relativePath = DEFAULT_SCRIPT,
  args = [],
  timeoutMs = 30000,
} = {}) {
  const { workspace, script } = resolveScript(workspaceDir, relativePath);
  const { stdout } = await execFileAsync(process.execPath, [script, ...args], {
    cwd: workspace,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  });
  const report = String(stdout || '').trim();
  if (!report) throw new Error('owner cash-flow report returned no output');
  return report;
}

export function createBeforeReplyHandler({ config = {}, logger = null, runReport = executeCanonicalReport } = {}) {
  const parsed = safePluginConfig(config);
  const agentIds = new Set(Array.isArray(parsed.agentIds) ? parsed.agentIds.filter(Boolean) : []);
  const relativePath = typeof parsed.scriptRelativePath === 'string'
    ? parsed.scriptRelativePath : DEFAULT_SCRIPT;
  const timeoutMs = Number.isInteger(parsed.timeoutMs) ? parsed.timeoutMs : 30000;

  return async (event, ctx) => {
    if (ctx?.trigger !== 'user' || !agentIds.has(ctx?.agentId)) return undefined;
    if (!isOwnerCashFlowQuestion(event?.cleanedBody)) return undefined;
    try {
      const text = await runReport({
        workspaceDir: ctx.workspaceDir,
        relativePath,
        args: reportArgsFromPrompt(event.cleanedBody),
        timeoutMs,
      });
      return {
        handled: true,
        reply: { text },
        reason: 'deterministic_owner_cash_flow',
      };
    } catch (error) {
      logger?.error?.(`owner cash-flow reply failed: ${error.message}`);
      return {
        handled: true,
        reply: {
          text: 'The live owner cash-flow report is temporarily unavailable. No partial financial answer was generated; please retry or check #ops.',
        },
        reason: 'owner_cash_flow_report_failed_closed',
      };
    }
  };
}

const plugin = {
  id: 'owner-cash-flow',
  name: 'Owner Cash Flow',
  description: 'Deterministic owner cash-flow responses from the canonical resort report.',
  register(api) {
    api.on('before_agent_reply', createBeforeReplyHandler({
      config: api.pluginConfig,
      logger: api.logger,
    }), { priority: 100, timeoutMs: 60000 });
  },
};

export default plugin;
