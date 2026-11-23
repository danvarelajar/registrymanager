import { insertLog, pruneLogs } from './db.js';

/**
 * Application log for troubleshooting. Entries are stored in SQLite (so they survive restarts)
 * and mirrored to the container console. Never pass passwords or tokens in `context`.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'];
let writesSincePrune = 0;

function serializeError(err) {
  if (!err) return undefined;
  if (!(err instanceof Error)) return { message: String(err) };
  const out = { message: err.message };
  if (err.code) out.code = err.code;
  if (err.statusCode) out.statusCode = err.statusCode;
  if (err.cause) out.cause = err.cause.code || err.cause.message || String(err.cause);
  return out;
}

/**
 * A short, practical explanation of common push and registry failures.
 */
export function hintFor(message = '') {
  const m = String(message);
  if (/i\/o timeout|ETIMEDOUT|context deadline exceeded|TLS handshake timeout/i.test(m)) {
    return 'Network timeout: the registry did not answer. Check VPN, firewall, proxy, or that the host and port are right. Run diagnostics to see which step fails.';
  }
  if (/ECONNREFUSED|connection refused/i.test(m)) {
    return 'Connection refused: the host is reachable but nothing is listening on that port.';
  }
  if (/ENOTFOUND|EAI_AGAIN|no such host|server misbehaving/i.test(m)) {
    return 'DNS lookup failed: the registry hostname could not be resolved.';
  }
  if (/ECONNRESET|connection reset|broken pipe|EOF/i.test(m)) {
    return 'The connection was dropped mid-transfer. Often a proxy, VPN, or an unstable network; retrying usually works.';
  }
  if (/x509|certificate|self[- ]signed|unknown authority/i.test(m)) {
    return 'TLS certificate problem. Docker must trust the registry certificate (or list it under insecure-registries in Docker settings).';
  }
  if (/\b401\b|unauthorized|authentication required/i.test(m)) {
    return 'Not authenticated. Run docker login for this registry on the host.';
  }
  if (/\b403\b|denied|forbidden/i.test(m)) {
    return 'Login accepted but access denied. The user lacks permission on this repository or namespace.';
  }
  if (/no space left on device/i.test(m)) {
    return 'Docker ran out of disk space. Free space in Docker Desktop (docker system prune) and retry.';
  }
  if (/No (manifest|RepoTags)|Invalid manifest/i.test(m)) {
    return 'The tar is not a valid docker save archive.';
  }
  return undefined;
}

export function log(level, category, message, context = {}) {
  if (!LEVELS.includes(level)) level = 'info';
  const ctx = { ...context };
  if (ctx.error) {
    ctx.error = serializeError(ctx.error);
    if (!ctx.hint) {
      const hint = hintFor(ctx.error.message);
      if (hint) ctx.hint = hint;
    }
  }
  for (const k of Object.keys(ctx)) if (ctx[k] === undefined) delete ctx[k];

  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (level !== 'debug') {
    consoleFn(`[${level}] [${category}] ${message}${ctx.error ? ` - ${ctx.error.message}` : ''}`);
  }

  try {
    insertLog(level, category, message, ctx);
    if (++writesSincePrune >= 200) {
      writesSincePrune = 0;
      pruneLogs();
    }
  } catch (err) {
    console.error('Failed to write log entry:', err.message);
  }
}

export const logger = {
  debug: (category, message, context) => log('debug', category, message, context),
  info: (category, message, context) => log('info', category, message, context),
  warn: (category, message, context) => log('warn', category, message, context),
  error: (category, message, context) => log('error', category, message, context),
};

export { LEVELS };
