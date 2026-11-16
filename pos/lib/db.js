'use strict';
/**
 * İnce veritabanı katmanı: aynı SQL hem MySQL/MariaDB (canlı `netchief` veritabanı) hem de
 * SQLite (demo ve testler) üzerinde çalışır. Bu yüzden store.js yalnızca taşınabilir SQL kullanır;
 * tarih/saat hesapları JavaScript'te yapılır.
 *
 *   all(sql, params) → satırlar     run(sql, params) → { insertId, changes }     tx(fn) → işlem (transaction)
 */

function sqlite(file = ':memory:') {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  const raw = {
    dialect: 'sqlite',
    async all(sql, params = []) { return db.prepare(sql).all(...params).map((r) => ({ ...r })); },
    async run(sql, params = []) {
      const r = db.prepare(sql).run(...params);
      return { insertId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
  };
  // Tek bağlantı: her çağrı sıraya girer, böylece süren bir işlemin arasına başka sorgu karışmaz.
  let chain = Promise.resolve();
  const queued = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };
  return {
    dialect: 'sqlite',
    all: (sql, params) => queued(() => raw.all(sql, params)),
    run: (sql, params) => queued(() => raw.run(sql, params)),
    tx: (fn) => queued(async () => {
      db.exec('BEGIN');
      try {
        const out = await fn(raw);
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }),
    exec: (sql) => db.exec(sql),
    close: async () => db.close(),
  };
}

function mysql(opts) {
  const pool = require('mysql2/promise').createPool({
    host: opts.host, port: opts.port, user: opts.user, password: opts.password, database: opts.database,
    socketPath: opts.socketPath,
    connectionLimit: 8, dateStrings: true, decimalNumbers: true, charset: 'utf8mb4',
  });
  const wrap = (q) => ({
    dialect: 'mysql',
    async all(sql, params = []) { return (await q.query(sql, params))[0]; },
    async run(sql, params = []) {
      const [r] = await q.query(sql, params);
      return { insertId: r.insertId, changes: r.affectedRows };
    },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out = await fn(wrap(conn));
        await conn.commit();
        return out;
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    },
    async exec(sql) { for (const s of sql.split(/;\s*\n/)) if (s.trim()) await pool.query(s); },
    close: () => pool.end(),
  };
}

module.exports = { sqlite, mysql };
