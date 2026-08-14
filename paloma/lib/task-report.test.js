'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
  buildTaskReport,
  parseStatuses,
  resolveSelector,
} = require('./task-report');

function taskDatabase() {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    description_es TEXT NOT NULL,
    description_en TEXT,
    assigned_to TEXT,
    assigned_name TEXT,
    status TEXT NOT NULL,
    priority TEXT,
    created_at TEXT NOT NULL,
    due_date TEXT,
    completed_at TEXT
  )`);
  const insert = database.prepare(`INSERT INTO tasks
    (id, description_es, description_en, assigned_to, assigned_name, status,
     priority, created_at, due_date, completed_at)
    VALUES (@id, @description_es, @description_en, @assigned_to, @assigned_name,
      @status, @priority, @created_at, @due_date, @completed_at)`);
  insert.run({
    id: 1, description_es: 'Pegar etiquetas', description_en: 'Apply labels',
    assigned_to: 'USERGIO', assigned_name: 'Sergio Gracia', status: 'open',
    priority: 'high', created_at: '2026-08-14 16:44:00', due_date: null, completed_at: null,
  });
  insert.run({
    id: 2, description_es: 'Reparar cerradura', description_en: 'Repair lock',
    assigned_to: 'USERGIO', assigned_name: 'Sergio Gracia', status: 'in_progress',
    priority: 'urgent', created_at: '2026-08-10 10:00:00', due_date: '2026-08-15', completed_at: null,
  });
  insert.run({
    id: 3, description_es: 'Cambiar foco', description_en: 'Replace bulb',
    assigned_to: 'USERGIO', assigned_name: 'Sergio Gracia', status: 'completed',
    priority: 'normal', created_at: '2026-08-01 09:00:00', due_date: null,
    completed_at: '2026-08-12 12:00:00',
  });
  insert.run({
    id: 4, description_es: 'Comprar toallas', description_en: 'Buy towels',
    assigned_to: 'UMAYELA', assigned_name: 'Mayela Gomez', status: 'open',
    priority: 'normal', created_at: '2026-08-13 09:00:00', due_date: null, completed_at: null,
  });
  return database;
}

test('resolves configured aliases without a Slack profile lookup', () => {
  assert.deepEqual(resolveSelector({ assignee: 'sergio', users: { sergio: 'USERGIO' } }), {
    kind: 'user_id', value: 'USERGIO', requested: 'sergio',
  });
  assert.deepEqual(parseStatuses('active'), ['open', 'in_progress']);
  assert.deepEqual(parseStatuses('completed'), ['completed']);
});

test('renders every active task for a Slack user in Spanish and English', t => {
  const database = taskDatabase();
  t.after(() => database.close());
  const report = buildTaskReport(database, {
    assignee: 'sergio', users: { sergio: 'USERGIO' }, status: 'active',
    observedAt: '2026-08-14T17:00:00.000Z',
  });
  assert.deepEqual(report.tasks.map(task => task.id), [2, 1]);
  assert.match(report.text, /Tareas activas · Sergio Gracia \(2\)/);
  assert.match(report.text, /#2.*En progreso.*Reparar cerradura/s);
  assert.match(report.text, /#1.*Abierta.*Pegar etiquetas/s);
  assert.match(report.text, /Active tasks · Sergio Gracia \(2\)/);
  assert.match(report.text, /#2.*In progress.*Repair lock/s);
  assert.doesNotMatch(report.text, /Cambiar foco/);
  assert.doesNotMatch(report.text, /Comprar toallas/);
  assert.match(report.text, /Verified against Paloma's task database/);
});

test('supports completed and all-assignee reports without omitting ownership', t => {
  const database = taskDatabase();
  t.after(() => database.close());
  const completed = buildTaskReport(database, {
    userId: 'USERGIO', status: 'completed', observedAt: '2026-08-14T17:00:00.000Z',
  });
  assert.deepEqual(completed.tasks.map(task => task.id), [3]);
  assert.match(completed.text, /Completada/);
  assert.match(completed.text, /Completed/);

  const all = buildTaskReport(database, {
    all: true, status: 'active', observedAt: '2026-08-14T17:00:00.000Z',
  });
  assert.equal(all.tasks.length, 3);
  assert.match(all.text, /asignada a Sergio Gracia/);
  assert.match(all.text, /assigned to Mayela Gomez/);
});

test('reports an empty result instead of claiming the database failed', t => {
  const database = taskDatabase();
  t.after(() => database.close());
  const report = buildTaskReport(database, {
    userId: 'UNOBODY', status: 'active', observedAt: '2026-08-14T17:00:00.000Z',
  });
  assert.equal(report.tasks.length, 0);
  assert.match(report.text, /No hay tareas que coincidan/);
  assert.match(report.text, /There are no tasks matching/);
});
