'use strict';
/*
 * إحصائيات اللعبة — أرقام بس، بلا أسماء ولا صور ولا أي بيانات شخصية.
 * التخزين:
 *  - إذا في DATABASE_URL (Postgres على Render): بتنحفظ بقاعدة البيانات وما بتضيع.
 *  - غير هيك: بملف data/stats.json (على خطة Render المجانية بيضيع مع كل إعادة تشغيل أو نشر).
 */
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({ v: 1, since: new Date().toISOString(), visits: 0, rooms: 0, games: 0, finals: 0, players: 0, rounds: 0, custom: 0, groupSizes: {}, questions: {}, groups: {}, days: {} });

function today() {
  // بتوقيت دمشق
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function createStats() {
  let data = EMPTY();
  let dirty = false, timer = null;
  const backend = process.env.DATABASE_URL ? pgBackend() : fileBackend();

  function day() {
    const d = today();
    if (!data.days[d]) {
      data.days[d] = { visits: 0, games: 0, finals: 0, players: 0 };
      const keys = Object.keys(data.days).sort();
      while (keys.length > 120) delete data.days[keys.shift()];
    }
    return data.days[d];
  }
  function touch() {
    dirty = true;
    if (!timer) timer = setTimeout(() => { timer = null; flush(); }, 5000);
  }
  async function flush() {
    if (!dirty) return;
    dirty = false;
    try { await backend.save(data); } catch (e) { dirty = true; console.error('stats save failed:', e.message); }
  }

  return {
    get backend() { return backend.name; },
    async ready() {
      try { const d = await backend.load(); if (d && d.v === 1) data = { ...EMPTY(), ...d }; }
      catch (e) { console.error('stats load failed:', e.message); }
    },
    visit() { data.visits++; day().visits++; touch(); },
    event(type, p = {}) {
      const d = day();
      if (type === 'room') data.rooms++;
      else if (type === 'player') { data.players++; d.players++; }
      else if (type === 'game') {
        data.games++; d.games++;
        const k = p.n >= 10 ? '10+' : String(p.n || 0);
        data.groupSizes[k] = (data.groupSizes[k] || 0) + 1;
      } else if (type === 'round') {
        data.rounds++;
        if (p.custom) data.custom++;
        else if (p.q && (data.questions[p.q] || Object.keys(data.questions).length < 300)) data.questions[p.q] = (data.questions[p.q] || 0) + 1;
      } else if (type === 'final') {
        data.finals++; d.finals++;
        if (p.type) data.groups[p.type] = (data.groups[p.type] || 0) + 1;
      }
      touch();
    },
    snapshot() { return JSON.parse(JSON.stringify(data)); },
    flush
  };
}

function fileBackend() {
  const dir = process.env.STATS_DIR || path.join(__dirname, 'data');
  const file = path.join(dir, 'stats.json');
  return {
    name: 'file',
    async load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } },
    async save(d) {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(d));
      fs.renameSync(tmp, file);
    }
  };
}

function pgBackend() {
  const { Pool } = require('pg');
  const ssl = process.env.PGSSL === 'disable' ? false : (/render\.com|sslmode=require/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 2 });
  let ready = null;
  const init = () => ready || (ready = pool.query('CREATE TABLE IF NOT EXISTS qa3da_stats (id text PRIMARY KEY, data jsonb NOT NULL, updated timestamptz NOT NULL DEFAULT now())'));
  const ID = 'aktar-hada';
  return {
    name: 'postgres',
    async load() { await init(); const r = await pool.query('SELECT data FROM qa3da_stats WHERE id=$1', [ID]); return r.rows[0] ? r.rows[0].data : null; },
    async save(d) { await init(); await pool.query('INSERT INTO qa3da_stats (id, data, updated) VALUES ($1,$2,now()) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated=now()', [ID, d]); }
  };
}

module.exports = { createStats };
