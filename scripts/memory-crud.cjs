/**
 * memory-crud.js — Minimal lesson CRUD for Orb
 *
 * Reads/writes lesson files in data/lessons/.
 * API consumed by memory-reflect.js.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.ORB_DATA || path.join(
  process.env.WORKSPACE || '/Users/karry/Orb/profiles/karry/workspace',
  '..', 'data'
);
const LESSONS_DIR = path.join(DATA_DIR, 'lessons');

function ensureLessonsDir() {
  if (!fs.existsSync(LESSONS_DIR)) {
    fs.mkdirSync(LESSONS_DIR, { recursive: true });
  }
}

function topicToFilename(topic) {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    + '.md';
}

/**
 * Verify what CRUD action to take for a given extraction.
 * Returns { action: 'ADD'|'UPDATE'|'NOOP', detail, filePath }
 */
async function crudVerify({ type, topic, content }) {
  ensureLessonsDir();
  const filename = topicToFilename(topic);
  const filePath = path.join(LESSONS_DIR, filename);

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    // Simple dedup: if existing content already contains the key phrase, skip
    const contentKey = content.slice(0, 80).toLowerCase();
    if (existing.toLowerCase().includes(contentKey)) {
      return { action: 'NOOP', detail: `Already covered in ${filename}`, filePath };
    }
    return { action: 'UPDATE', detail: `Will update ${filename}`, filePath };
  }

  return { action: 'ADD', detail: `Will create ${filename}`, filePath };
}

/**
 * Execute the CRUD operation.
 * Returns { message }
 */
async function executeCrud({ action, filePath, content, topic, type }) {
  ensureLessonsDir();

  if (action === 'ADD') {
    const body = `# ${topic}\n\n- type: ${type || 'lesson'}\n- priority: P2\n- created: ${new Date().toISOString().slice(0, 10)}\n\n${content}\n`;
    fs.writeFileSync(filePath, body);
    return { message: `Created ${path.basename(filePath)}` };
  }

  if (action === 'UPDATE') {
    let existing = fs.readFileSync(filePath, 'utf-8');
    const updateNote = `\n\n---\n_Updated ${new Date().toISOString().slice(0, 10)}_\n\n${content}\n`;
    existing += updateNote;
    fs.writeFileSync(filePath, existing);
    return { message: `Updated ${path.basename(filePath)}` };
  }

  return { message: `NOOP for ${path.basename(filePath || 'unknown')}` };
}

module.exports = { crudVerify, executeCrud };
