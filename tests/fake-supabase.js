'use strict';
// TEST ONLY. A tiny stand-in for the parts of supabase-js that the API routes use,
// running real SQL on a real PostgreSQL database. It lets us execute the actual route
// code (create-order, verify-payment, webhook, admin ...) without a Supabase account.

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

class Builder {
  constructor(pool, table) {
    this.pool = pool; this.table = table; this.op = 'select'; this.cols = '*'; this.countMode = false;
    this.filters = []; this.orders = []; this.lim = null; this.off = 0; this.row = null; this.returning = false;
    this.mode = 'many'; this.onConflict = null;
  }
  select(cols, opts) {
    if (this.op === 'select') { this.cols = cols || '*'; this.countMode = !!(opts && opts.count); } else { this.returning = true; }
    return this;
  }
  insert(r) { this.op = 'insert'; this.row = r; return this; }
  update(r) { this.op = 'update'; this.row = r; return this; }
  upsert(r) { this.op = 'upsert'; this.row = r; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push(['eq', c, v]); return this; }
  neq(c, v) { this.filters.push(['neq', c, v]); return this; }
  in(c, v) { this.filters.push(['in', c, v]); return this; }
  gte(c, v) { this.filters.push(['gte', c, v]); return this; }
  lte(c, v) { this.filters.push(['lte', c, v]); return this; }
  or(s) { this.filters.push(['or', null, s]); return this; }
  order(c, o) { this.orders.push([c, !(o && o.ascending === false)]); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.off = a; this.lim = b - a + 1; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }

  where(params) {
    const parts = [];
    for (const [k, c, v] of this.filters) {
      if (k === 'or') {
        const ors = String(v).split(',').map((p) => {
          const m = p.match(/^([a-z_]+)\.ilike\.(.*)$/);
          if (!m) throw new Error('fake: unsupported or() part ' + p);
          params.push(m[2]); return q(m[1]) + ' ILIKE $' + params.length;
        });
        parts.push('(' + ors.join(' OR ') + ')');
        continue;
      }
      const col = c.includes('.') ? c : q(c);
      if (k === 'in') { params.push((v || []).map(String)); parts.push(col + '::text = ANY($' + params.length + '::text[])'); continue; }
      params.push(v);
      const opx = { eq: '=', neq: '<>', gte: '>=', lte: '<=' }[k];
      parts.push(col + ' ' + opx + ' $' + params.length);
    }
    return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
  }

  async run() {
    const params = [];
    let sql; let wantRows = true; let count = null;
    if (this.op === 'select') {
      if (this.table === 'order_items' && /orders!inner/.test(this.cols)) {
        const pf = this.filters.find((f) => f[1] === 'orders.payment_status');
        params.push(pf[2]);
        sql = 'SELECT oi.name, oi.qty, oi.line_total_paise FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.payment_status = $1';
      } else {
        if (/[()]/.test(this.cols)) throw new Error('fake: embedded select not supported: ' + this.cols);
        const cols = this.cols === '*' ? '*' : this.cols.split(',').map((c) => q(c.trim())).join(', ');
        const w = this.where(params);
        sql = 'SELECT ' + cols + ' FROM ' + q(this.table) + w;
        if (this.countMode) {
          const cp = []; const cw = this.where(cp);
          const r = await this.pool.query('SELECT count(*)::int AS n FROM ' + q(this.table) + cw, cp);
          count = r.rows[0].n;
        }
        if (this.orders.length) sql += ' ORDER BY ' + this.orders.map(([c, asc]) => q(c) + (asc ? ' ASC' : ' DESC')).join(', ');
        if (this.lim != null) sql += ' LIMIT ' + this.lim + ' OFFSET ' + this.off;
      }
    } else if (this.op === 'insert' || this.op === 'upsert') {
      const rows = Array.isArray(this.row) ? this.row : [this.row];
      const keys = Object.keys(rows[0]);
      const vals = rows.map((r) => '(' + keys.map((k) => { params.push(r[k]); return '$' + params.length; }).join(',') + ')');
      sql = 'INSERT INTO ' + q(this.table) + ' (' + keys.map(q).join(',') + ') VALUES ' + vals.join(',');
      if (this.op === 'upsert') {
        sql += ' ON CONFLICT (' + q(keys[0]) + ') DO UPDATE SET ' + keys.slice(1).map((k) => q(k) + ' = EXCLUDED.' + q(k)).join(',');
      }
      sql += this.returning ? ' RETURNING *' : '';
      wantRows = this.returning;
    } else if (this.op === 'update') {
      const keys = Object.keys(this.row);
      const sets = keys.map((k) => { params.push(this.row[k]); return q(k) + ' = $' + params.length; });
      sql = 'UPDATE ' + q(this.table) + ' SET ' + sets.join(',') + this.where(params) + (this.returning ? ' RETURNING *' : '');
      wantRows = this.returning;
    } else if (this.op === 'delete') {
      sql = 'DELETE FROM ' + q(this.table) + this.where(params);
      wantRows = false;
    }
    const r = await this.pool.query(sql, params);
    let data = wantRows ? r.rows : null;
    if (this.mode !== 'many' && data) {
      if (data.length > 1) return { data: null, error: { message: 'multiple rows' } };
      if (data.length === 0) return { data: null, error: this.mode === 'single' ? { message: 'no rows' } : null };
      data = data[0];
    }
    return { data, error: null, count };
  }
  then(resolve, reject) {
    return this.run().catch((e) => ({ data: null, error: { code: e.code, message: e.message } })).then(resolve, reject);
  }
}

function fakeSupabase(pool, auth) {
  return {
    from: (t) => new Builder(pool, t),
    rpc: async (fn, args) => {
      try {
        const names = Object.keys(args);
        const params = names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
        const placeholders = names.map((n, i) => q(n) + ' => $' + (i + 1) + (args[n] !== null && typeof args[n] === 'object' ? '::jsonb' : ''));
        const r = await pool.query('SELECT ' + fn + '(' + placeholders.join(', ') + ') AS v', params);
        return { data: r.rows[0].v, error: null };
      } catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
    },
    auth: {
      getUser: async (token) => {
        const u = auth && auth[token];
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'bad token' } };
      }
    }
  };
}

module.exports = { fakeSupabase };
