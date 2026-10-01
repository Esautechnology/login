/* Tiny in-memory stand-in for PostgreSQL. Used only when DATABASE_URL is not set (demo mode).
   Data is lost whenever the server restarts. It understands just the queries used by server.js. */
const T = { products: [], orders: [] };
let seq = 1;
const DEF = {
  products: () => ({ brand: "", image: "", emoji: "📦", stock: 0, created_at: new Date() }),
  orders: () => ({ status: "pending", message: "", checkout_request_id: null, mpesa_receipt: null,
    stock_issue: false, fulfilment: "new", last_query: null, created_at: new Date(), paid_at: null }),
};
const out = (rows, n) => ({ rows, rowCount: n === undefined ? rows.length : n });
const copy = (r) => ({ ...r });

function val(e, row, p) {
  e = e.trim(); let m;
  if ((m = e.match(/^\$(\d+)$/))) return p[m[1] - 1];
  if ((m = e.match(/^'(.*)'$/))) return m[1];
  if (e === "now()") return new Date();
  if (e === "true" || e === "false") return e === "true";
  if (/^\d+$/.test(e)) return Number(e);
  if ((m = e.match(/^(\w+)\s*([-+])\s*\$(\d+)$/)))
    return m[2] === "-" ? Number(row[m[1]]) - Number(p[m[3] - 1]) : Number(row[m[1]]) + Number(p[m[3] - 1]);
  throw new Error("memdb: unsupported expression " + e);
}
function test(where, row, p) {
  if (!where) return true;
  return where.split(/\s+AND\s+/i).every((c) => {
    let m = c.trim().match(/^(\w+)\s*=\s*ANY\(\$(\d+)\)$/);
    if (m) return (p[m[2] - 1] || []).map(String).includes(String(row[m[1]]));
    m = c.trim().match(/^(\w+)\s*(>=|=)\s*(.+)$/);
    if (!m) throw new Error("memdb: unsupported condition " + c);
    const l = row[m[1]], r = val(m[3], row, p);
    return m[2] === ">=" ? Number(l) >= Number(r) : String(l) === String(r);
  });
}

function run(sql, p) {
  sql = sql.replace(/\s+/g, " ").trim(); let m;
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql) || /^CREATE /i.test(sql)) return out([]);

  if (/^SELECT count\(\*\)::int AS n FROM orders WHERE phone=\$1 AND created_at > now\(\) - interval '10 minutes'$/i.test(sql)) {
    const cut = Date.now() - 600000;
    return out([{ n: T.orders.filter((o) => o.phone === p[0] && +o.created_at > cut).length }]);
  }
  if ((m = sql.match(/^SELECT count\(\*\)::int AS n FROM (\w+)$/i))) return out([{ n: T[m[1]].length }]);

  if ((m = sql.match(/^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (\w+)( DESC)?)?(?: LIMIT (\d+))?(?: FOR UPDATE)?$/i))) {
    let rows = T[m[2]].filter((r) => test(m[3], r, p)).map((r, i) => ({ r, i }));
    if (m[4]) rows.sort((a, b) => {
      const x = a.r[m[4]], y = b.r[m[4]];
      const c = x < y ? -1 : x > y ? 1 : 0;
      return (m[5] ? -c : c) || (m[5] ? b.i - a.i : a.i - b.i);
    });
    rows = rows.map((o) => o.r);
    if (m[6]) rows = rows.slice(0, Number(m[6]));
    const cols = m[1].trim() === "*" ? null : m[1].split(",").map((s) => s.trim());
    return out(rows.map((r) => { if (!cols) return copy(r); const o = {}; cols.forEach((c) => (o[c] = r[c])); return o; }));
  }

  if ((m = sql.match(/^INSERT INTO (\w+)\s*\((.+?)\) VALUES\s*\((.+?)\)( RETURNING \*)?$/i))) {
    const t = m[1], cols = m[2].split(",").map((s) => s.trim()), exprs = m[3].split(",");
    const row = { ...DEF[t]() };
    if (t === "products") row.id = seq++;
    cols.forEach((c, i) => {
      let v = val(exprs[i], row, p);
      if (c === "items" && typeof v === "string") v = JSON.parse(v);
      row[c] = v;
    });
    T[t].push(row);
    return out(m[4] ? [copy(row)] : [], 1);
  }

  if ((m = sql.match(/^UPDATE (\w+) SET (.+?) WHERE (.+?)( RETURNING \*)?$/i))) {
    const hit = T[m[1]].filter((r) => test(m[3], r, p));
    for (const r of hit) {
      const upd = {};
      m[2].split(",").forEach((a) => { const k = a.indexOf("="); upd[a.slice(0, k).trim()] = val(a.slice(k + 1), r, p); });
      Object.assign(r, upd);
    }
    return out(m[4] ? hit.map(copy) : [], hit.length);
  }

  if ((m = sql.match(/^DELETE FROM (\w+) WHERE (.+)$/i))) {
    const before = T[m[1]].length;
    T[m[1]] = T[m[1]].filter((r) => !test(m[2], r, p));
    return out([], before - T[m[1]].length);
  }
  throw new Error("memdb: unsupported query: " + sql);
}

class Pool {
  async query(sql, p) { return run(sql, p || []); }
  async connect() { return { query: async (s, p) => run(s, p || []), release() {} }; }
}
module.exports = { Pool };
