'use strict';

const fs = require('node:fs');

const ACTIVE_STATUSES = ['open', 'in_progress'];
const ALL_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'];
const STATUS_LABELS = {
  open: { es: '📋 Abierta', en: '📋 Open' },
  in_progress: { es: '🔄 En progreso', en: '🔄 In progress' },
  completed: { es: '✅ Completada', en: '✅ Completed' },
  cancelled: { es: '⊘ Cancelada', en: '⊘ Cancelled' },
};
const PRIORITY_LABELS = {
  urgent: { es: 'urgente', en: 'urgent' },
  high: { es: 'alta', en: 'high' },
  normal: { es: 'normal', en: 'normal' },
  low: { es: 'baja', en: 'low' },
};

function requiredText(value, label, maximum = 120) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer`);
  return normalized;
}

function parseStatuses(value = 'active') {
  const normalized = String(value || 'active').trim().toLowerCase().replaceAll('-', '_');
  if (normalized === 'active') return ACTIVE_STATUSES;
  if (normalized === 'all') return ALL_STATUSES;
  if (ALL_STATUSES.includes(normalized)) return [normalized];
  throw new Error('status must be active, open, in_progress, completed, cancelled, or all');
}

function loadUsers(configPath) {
  if (!configPath || !fs.existsSync(configPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return parsed.users && typeof parsed.users === 'object' && !Array.isArray(parsed.users)
    ? parsed.users : {};
}

function resolveSelector({ userId, assignee, all = false, users = {} }) {
  const supplied = [Boolean(userId), Boolean(assignee), Boolean(all)].filter(Boolean).length;
  if (supplied !== 1) throw new Error('choose exactly one of --user-id, --assignee, or --all');
  if (all) return { kind: 'all', value: null, requested: 'all' };
  if (userId) {
    const normalized = requiredText(userId, 'user id', 64);
    if (!/^[A-Z][A-Z0-9]{2,63}$/i.test(normalized)) throw new Error('user id is not valid');
    return { kind: 'user_id', value: normalized, requested: normalized };
  }
  const requested = requiredText(assignee, 'assignee');
  const alias = requested.toLowerCase();
  const configuredId = Object.entries(users)
    .find(([key]) => key.toLowerCase() === alias)?.[1];
  if (configuredId) {
    return { kind: 'user_id', value: requiredText(configuredId, `configured user ${alias}`, 64), requested };
  }
  return { kind: 'name', value: requested, requested };
}

function taskQuery({ selector, statuses, limit }) {
  const clauses = [];
  const parameters = {};
  if (selector.kind === 'user_id') {
    clauses.push('assigned_to = @assigned_to');
    parameters.assigned_to = selector.value;
  } else if (selector.kind === 'name') {
    clauses.push('LOWER(COALESCE(assigned_name, \'\')) = LOWER(@assigned_name)');
    parameters.assigned_name = selector.value;
  }
  const statusParameters = statuses.map((status, index) => {
    const key = `status_${index}`;
    parameters[key] = status;
    return `@${key}`;
  });
  clauses.push(`status IN (${statusParameters.join(', ')})`);
  parameters.limit = limit + 1;
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return {
    sql: `SELECT id, description_es, description_en, assigned_to, assigned_name,
      status, priority, created_at, due_date, completed_at
      FROM tasks
      ${where}
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        CASE WHEN due_date IS NULL OR due_date='' THEN 1 ELSE 0 END,
        due_date ASC,
        CASE WHEN status='completed' THEN completed_at ELSE created_at END DESC,
        id DESC
      LIMIT @limit`,
    parameters,
  };
}

function displayName(tasks, selector) {
  if (selector.kind === 'all') return '';
  const counts = new Map();
  for (const task of tasks) {
    const name = String(task.assigned_name || '').trim();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const known = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  if (known) return known;
  if (selector.kind === 'name') return selector.value;
  return selector.requested;
}

function taskDate(task, language) {
  if (task.status === 'completed' && task.completed_at) {
    return language === 'es' ? `completada ${task.completed_at}` : `completed ${task.completed_at}`;
  }
  if (task.due_date) return language === 'es' ? `vence ${task.due_date}` : `due ${task.due_date}`;
  return language === 'es' ? `creada ${task.created_at}` : `created ${task.created_at}`;
}

function taskLine(task, language, includeAssignee) {
  const labels = STATUS_LABELS[task.status] || { es: task.status, en: task.status };
  const priority = PRIORITY_LABELS[task.priority] || PRIORITY_LABELS.normal;
  const description = language === 'es'
    ? task.description_es
    : (task.description_en || task.description_es);
  const assignee = includeAssignee && task.assigned_name
    ? (language === 'es' ? ` · asignada a ${task.assigned_name}` : ` · assigned to ${task.assigned_name}`)
    : '';
  return `• *#${task.id}* · ${labels[language]} · ${priority[language]} · ${taskDate(task, language)}${assignee}\n  ${description}`;
}

function reportTitle({ language, statuses, assigneeName, count }) {
  const scope = statuses.length === 2 && statuses.every(status => ACTIVE_STATUSES.includes(status))
    ? (language === 'es' ? 'Tareas activas' : 'Active tasks')
    : statuses.length === ALL_STATUSES.length
      ? (language === 'es' ? 'Todas las tareas' : 'All tasks')
      : `${language === 'es' ? 'Tareas' : 'Tasks'} · ${STATUS_LABELS[statuses[0]]?.[language] || statuses[0]}`;
  const owner = assigneeName ? ` · ${assigneeName}` : '';
  return `*${scope}${owner} (${count})*`;
}

function formatReport({ tasks, selector, statuses, truncated, limit, observedAt = new Date().toISOString() }) {
  const assigneeName = displayName(tasks, selector);
  const includeAssignee = selector.kind === 'all';
  const renderLanguage = language => {
    const lines = [reportTitle({ language, statuses, assigneeName, count: tasks.length })];
    if (tasks.length) {
      lines.push(...tasks.map(task => taskLine(task, language, includeAssignee)));
    } else {
      lines.push(language === 'es'
        ? 'No hay tareas que coincidan con esta consulta.'
        : 'There are no tasks matching this query.');
    }
    if (truncated) {
      lines.push(language === 'es'
        ? `Se muestran las primeras ${limit}; usa un estado o responsable más específico para ver el resto.`
        : `Showing the first ${limit}; use a narrower status or assignee to see the rest.`);
    }
    lines.push(language === 'es'
      ? `Verificado en la base de tareas de Paloma: ${observedAt}`
      : `Verified against Paloma's task database: ${observedAt}`);
    return lines.join('\n\n');
  };
  return `🕊️ *Paloma*\n\n${renderLanguage('es')}\n\n───\n\n${renderLanguage('en')}`;
}

function buildTaskReport(database, options = {}) {
  const statuses = parseStatuses(options.status);
  const limit = options.limit === undefined ? 100 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer from 1 to 100');
  }
  const selector = resolveSelector({
    userId: options.userId,
    assignee: options.assignee,
    all: options.all,
    users: options.users || {},
  });
  if (selector.kind !== 'all' && options.selectorLabel) {
    selector.requested = requiredText(options.selectorLabel, 'selector label');
  }
  const query = taskQuery({ selector, statuses, limit });
  const rows = database.prepare(query.sql).all(query.parameters);
  const truncated = rows.length > limit;
  const tasks = rows.slice(0, limit);
  return {
    selector,
    statuses,
    tasks,
    truncated,
    limit,
    text: formatReport({ tasks, selector, statuses, truncated, limit, observedAt: options.observedAt }),
  };
}

module.exports = {
  ACTIVE_STATUSES,
  ALL_STATUSES,
  buildTaskReport,
  displayName,
  formatReport,
  loadUsers,
  parseStatuses,
  resolveSelector,
  taskQuery,
};
