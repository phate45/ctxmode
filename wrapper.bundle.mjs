import{join as Fe,dirname as Pe,resolve as Q}from"node:path";import{tmpdir as Ut}from"node:os";import{mkdtempSync as $t,readFileSync as Bt,rmSync as jt}from"node:fs";import{randomBytes as Ht}from"node:crypto";import{fileURLToPath as Wt}from"node:url";import{Server as Xt}from"@modelcontextprotocol/sdk/server/index.js";import{StdioServerTransport as Vt}from"@modelcontextprotocol/sdk/server/stdio.js";import{Client as Yt}from"@modelcontextprotocol/sdk/client/index.js";import{StdioClientTransport as qt}from"@modelcontextprotocol/sdk/client/stdio.js";import{ListToolsRequestSchema as Gt,CallToolRequestSchema as zt}from"@modelcontextprotocol/sdk/types.js";import{readFileSync as G,readdirSync as xt,statSync as ve,mkdirSync as vt}from"node:fs";import{execSync as Dt}from"node:child_process";import{join as z,dirname as Nt,basename as De,resolve as C,relative as Ct}from"node:path";import{createRequire as We}from"node:module";import{existsSync as Xe,unlinkSync as re,renameSync as an}from"node:fs";var H=class{#e;constructor(e){this.#e=e}pragma(e){let t=this.#e.prepare(`PRAGMA ${e}`).all();if(!t||t.length===0)return;if(t.length>1)return t;let s=Object.values(t[0]);return s.length===1?s[0]:t[0]}exec(e){let n="",t=null;for(let i=0;i<e.length;i++){let o=e[i];if(t)n+=o,o===t&&(t=null);else if(o==="'"||o==='"')n+=o,t=o;else if(o===";"){let a=n.trim();a&&this.#e.prepare(a).run(),n=""}else n+=o}let s=n.trim();return s&&this.#e.prepare(s).run(),this}prepare(e){let n=this.#e.prepare(e);return{run:(...t)=>n.run(...t),get:(...t)=>{let s=n.get(...t);return s===null?void 0:s},all:(...t)=>n.all(...t),iterate:(...t)=>n.iterate(...t)}}transaction(e){return this.#e.transaction(e)}close(){this.#e.close()}},W=class{#e;constructor(e){this.#e=e}pragma(e){let t=this.#e.prepare(`PRAGMA ${e}`).all();if(!t||t.length===0)return;if(t.length>1)return t;let s=Object.values(t[0]);return s.length===1?s[0]:t[0]}exec(e){return this.#e.exec(e),this}prepare(e){let n=this.#e.prepare(e);return{run:(...t)=>n.run(...t),get:(...t)=>n.get(...t),all:(...t)=>n.all(...t),iterate:(...t)=>typeof n.iterate=="function"?n.iterate(...t):n.all(...t)[Symbol.iterator]()}}transaction(e){return(...n)=>{this.#e.exec("BEGIN");try{let t=e(...n);return this.#e.exec("COMMIT"),t}catch(t){throw this.#e.exec("ROLLBACK"),t}}}close(){this.#e.close()}},w=null;function Ve(r){let e=null;try{return e=new r(":memory:"),e.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)"),!0}catch{return!1}finally{try{e?.close()}catch{}}}function Ye(r,e){let n=e!==void 0?e:globalThis.Bun;if(typeof n<"u"&&n!==null)return!0;let t=r??process.versions,[s,i]=(t.node??"0.0.0").split("."),o=Number(s),a=Number(i);return!Number.isFinite(o)||!Number.isFinite(a)?!1:o>22||o===22&&a>=5}function se(){if(!w){let r=We(import.meta.url);if(globalThis.Bun){let e=r(["bun","sqlite"].join(":")).Database;w=function(t,s){let i=new e(t,{readonly:s?.readonly,create:!0}),o=new H(i);return s?.timeout&&o.pragma(`busy_timeout = ${s.timeout}`),o}}else if(Ye()){let e=null;try{({DatabaseSync:e}=r(["node","sqlite"].join(":")))}catch{e=null}e&&Ve(e)?w=function(t,s){let i=new e(t,{readOnly:s?.readonly??!1}),o=new W(i);return s?.timeout&&o.pragma(`busy_timeout = ${s.timeout}`),o}:w=r("better-sqlite3")}else w=r("better-sqlite3")}return w}function X(r){r.pragma("journal_mode = WAL"),r.pragma("synchronous = NORMAL");try{r.pragma("mmap_size = 268435456")}catch{}}function V(r){if(!Xe(r))for(let e of["-wal","-shm"])try{re(r+e)}catch{}}function ie(r){for(let e of["","-wal","-shm"])try{re(r+e)}catch{}}function Y(r){try{r.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{r.close()}catch{}}function I(r,e=[100,500,2e3]){let n;for(let t=0;t<=e.length;t++)try{return r()}catch(s){let i=s instanceof Error?s.message:String(s);if(!i.includes("SQLITE_BUSY")&&!i.includes("database is locked"))throw s;if(n=s instanceof Error?s:new Error(i),t<e.length){let o=e[t],a=Date.now();for(;Date.now()-a<o;);}}throw new Error(`SQLITE_BUSY: database is locked after ${e.length} retries. Original error: ${n?.message}`)}function oe(r){return r.includes("SQLITE_CORRUPT")||r.includes("SQLITE_NOTADB")||r.includes("database disk image is malformed")||r.includes("file is not a database")}var F=Symbol.for("__context_mode_live_dbs_v3__"),cn=(()=>{let r=globalThis;return r[F]||(r[F]=new Set,process.on("exit",()=>{for(let e of r[F])Y(e);r[F].clear()})),r[F]})();import{readFileSync as he,readdirSync as mn,unlinkSync as ct,existsSync as ut,statSync as ge,openSync as pe,fstatSync as me,closeSync as fe}from"node:fs";import{createHash as Ee}from"node:crypto";import{tmpdir as lt}from"node:os";import{join as dt}from"node:path";import{readdirSync as qe,statSync as Ge,lstatSync as ze,realpathSync as ae,existsSync as Ke,readFileSync as Je}from"node:fs";import{join as ue,extname as Qe,relative as le,sep as Ze,resolve as et}from"node:path";var tt=["node_modules",".git","dist","build",".next","coverage",".venv","__pycache__",".DS_Store"],nt=[".md",".mdx",".txt",".json",".yaml",".yml",".ts",".tsx",".js",".jsx",".py",".rs",".go",".sh"],rt=5,st=200;function it(r){let e="";for(let n=0;n<r.length;n++){let t=r[n];t==="*"?r[n+1]==="*"?(e+=".*",n++):e+="[^/]*":t==="?"?e+="[^/]":"\\^$.|+()[]{}".includes(t)?e+="\\"+t:e+=t}return new RegExp(`^${e}$`)}function ce(r,e){if(e.length===0)return!1;let n=r.split("/").pop()??r;for(let t of e){if(!t.includes("/")&&!t.includes("*")){if(n===t||r.split("/").includes(t))return!0;continue}let s=it(t);if(s.test(r)||s.test(n))return!0}return!1}function ot(r){let e=ue(r,".gitignore");if(!Ke(e))return[];try{return Je(e,"utf-8").split(/\r?\n/).map(t=>t.trim()).filter(t=>t.length>0&&!t.startsWith("#")&&!t.startsWith("!")).map(t=>t.replace(/^\//,"").replace(/\/$/,""))}catch{return[]}}function at(r,e){return le(r,e).split(Ze).join("/")}function de(r,e={}){let{include:n,exclude:t,maxDepth:s=rt,maxFiles:i=st,extensions:o,respectGitignore:a=!0,followSymlinks:u=!1}=e,c;try{c=ae(r)}catch{return{files:[],capped:!1,totalSeen:0}}let l=(o&&o.length>0?o:nt).map(E=>(E.startsWith(".")?E:"."+E).toLowerCase()),h=[...tt,...t??[],...a?ot(c):[]],d=n??[],g=[],p=new Set([c]),m=0,f=!1;function _(E,D){if(f||D>s)return;let A;try{A=qe(E,{withFileTypes:!0})}catch{return}for(let L of A){if(f)return;let S=ue(E,L.name),y=at(c,S);if(ce(y,h))continue;let O=L.isDirectory(),R=L.isFile(),N=!1;try{N=ze(S).isSymbolicLink()}catch{continue}if(N){if(!u)continue;let T;try{T=ae(S)}catch{continue}let k=le(c,T);if((k.startsWith("..")||et(k)===T)&&k.startsWith("..")||p.has(T))continue;p.add(T);try{let v=Ge(T);O=v.isDirectory(),R=v.isFile()}catch{continue}}if(O){_(S,D+1);continue}if(!R)continue;let b=Qe(S).toLowerCase();if(l.includes(b)&&!(d.length>0&&!ce(y,d))){if(m++,g.length>=i){f=!0;return}g.push(S)}}}return _(c,0),{files:g,capped:f,totalSeen:m}}var M=new Set(["the","and","for","are","but","not","you","all","can","had","her","was","one","our","out","has","his","how","its","may","new","now","old","see","way","who","did","get","got","let","say","she","too","use","will","with","this","that","from","they","been","have","many","some","them","than","each","make","like","just","over","such","take","into","year","your","good","could","would","about","which","their","there","other","after","should","through","also","more","most","only","very","when","what","then","these","those","being","does","done","both","same","still","while","where","here","were","much","update","updates","updated","deps","dev","tests","test","add","added","fix","fixed","run","running","using"]);function ye(r){let e=new Set,n=[];for(let t of r){let s=t.toLowerCase();e.has(s)||(e.add(s),n.push(t))}return n}function ht(r,e="AND"){let n=ye(r.replace(/['"(){}[\]*:^~]/g," ").split(/\s+/).filter(i=>i.length>0&&!["AND","OR","NOT","NEAR"].includes(i.toUpperCase())));if(n.length===0)return'""';let t=n.filter(i=>!M.has(i.toLowerCase()));return(t.length>0?t:n).map(i=>`"${i}"`).join(e==="OR"?" OR ":" ")}function gt(r,e="AND"){let n=r.replace(/["'(){}[\]*:^~]/g,"").trim();if(n.length<3)return"";let t=ye(n.split(/\s+/).filter(o=>o.length>=3));if(t.length===0)return"";let s=t.filter(o=>!M.has(o.toLowerCase()));return(s.length>0?s:t).map(o=>`"${o}"`).join(e==="OR"?" OR ":" ")}function pt(r,e){if(r.length===0)return e.length;if(e.length===0)return r.length;let n=Array.from({length:e.length+1},(t,s)=>s);for(let t=1;t<=r.length;t++){let s=[t];for(let i=1;i<=e.length;i++)s[i]=r[t-1]===e[i-1]?n[i-1]:1+Math.min(n[i],s[i-1],n[i-1]);n=s}return n[e.length]}function mt(r){return r<=4?1:r<=12?2:3}var $=4096,ft=3,Et=200,_t=5e3,_e=80,yt=.5;function St(r,e){let n=[],t=r.indexOf(e);for(;t!==-1;)n.push(t),t=r.indexOf(e,t+1);return n}function bt(r,e,n=30){if(r.length<2||e.length<2)return 0;let t=0,s=Math.min(r.length,e.length)-1;for(let i=0;i<s;i++){let o=r[i],a=r[i+1],u=e[i].length,c=0;for(let l of o){let h=l+u,d=h+n;for(;c<a.length&&a[c]<h;)c++;c<a.length&&a[c]<=d&&(t++,c++)}}return t}function Tt(r){if(r.length===0)return 1/0;if(r.length===1)return 0;let e=r,n=new Array(e.length).fill(0),t=1/0;for(;;){let s=1/0,i=-1/0,o=0;for(let u=0;u<e.length;u++){let c=e[u][n[u]];c<s&&(s=c,o=u),c>i&&(i=c)}let a=i-s;if(a<t&&(t=a),n[o]++,n[o]>=e[o].length)break}return t}var B=class r{#e;#n;#i;#a;#c;#u;#l;#d;#h;#g;#p;#m;#f;#E;#_;#y;#S;#b;#T;#R;#k;#x;#v;#D;#N;#C;#A;#L;#O;#w;#I;#M;#F;#P=0;static OPTIMIZE_EVERY=50;#t=new Map;static FUZZY_CACHE_SIZE=256;constructor(e){let n=se();this.#n=e??dt(lt(),`context-mode-${process.pid}.db`),V(this.#n);let t;try{t=new n(this.#n,{timeout:3e4}),X(t)}catch(s){let i=s instanceof Error?s.message:String(s);if(oe(i)){ie(this.#n),V(this.#n);try{t=new n(this.#n,{timeout:3e4}),X(t)}catch(o){throw new Error(`Failed to create fresh DB after deleting corrupt file: ${o instanceof Error?o.message:String(o)}`)}}else throw s}this.#e=t,this.#W(),this.#X()}cleanup(){try{this.#e.close()}catch{}for(let e of["","-wal","-shm"])try{ct(this.#n+e)}catch{}}#W(){this.#e.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_path TEXT,
        content_hash TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        source_category UNINDEXED,
        session_id UNINDEXED,
        event_id UNINDEXED,
        timestamp UNINDEXED,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        source_category UNINDEXED,
        session_id UNINDEXED,
        event_id UNINDEXED,
        timestamp UNINDEXED,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
    `);try{let e=this.#e.prepare("SELECT name FROM pragma_table_xinfo('chunks')").all(),n=new Set(e.map(t=>t.name));e.length>0&&!n.has("source_category")&&(this.#e.exec("DROP TABLE IF EXISTS chunks"),this.#e.exec("DROP TABLE IF EXISTS chunks_trigram"),this.#e.exec(`
          CREATE VIRTUAL TABLE chunks USING fts5(
            title,
            content,
            source_id UNINDEXED,
            content_type UNINDEXED,
            source_category UNINDEXED,
            session_id UNINDEXED,
            event_id UNINDEXED,
            timestamp UNINDEXED,
            tokenize='porter unicode61'
          );
          CREATE VIRTUAL TABLE chunks_trigram USING fts5(
            title,
            content,
            source_id UNINDEXED,
            content_type UNINDEXED,
            source_category UNINDEXED,
            session_id UNINDEXED,
            event_id UNINDEXED,
            timestamp UNINDEXED,
            tokenize='trigram'
          );
        `))}catch{}try{this.#e.exec("ALTER TABLE sources ADD COLUMN file_path TEXT")}catch{}try{this.#e.exec("ALTER TABLE sources ADD COLUMN content_hash TEXT")}catch{}}#X(){this.#a=this.#e.prepare("INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, 0, 0, ?, ?)"),this.#c=this.#e.prepare("INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, ?, ?, ?, ?)"),this.#u=this.#e.prepare("INSERT INTO chunks (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),this.#l=this.#e.prepare("INSERT INTO chunks_trigram (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),this.#d=this.#e.prepare("INSERT OR IGNORE INTO vocabulary (word) VALUES (?)"),this.#h=this.#e.prepare("DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)"),this.#g=this.#e.prepare("DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)"),this.#p=this.#e.prepare("DELETE FROM sources WHERE label = ?"),this.#m=this.#e.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ?
      ORDER BY rank
      LIMIT ?
    `),this.#f=this.#e.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `),this.#E=this.#e.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `),this.#_=this.#e.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ?
      ORDER BY rank
      LIMIT ?
    `),this.#y=this.#e.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `),this.#S=this.#e.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `),this.#T=this.#e.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#R=this.#e.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#k=this.#e.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#x=this.#e.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#v=this.#e.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#D=this.#e.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `),this.#b=this.#e.prepare("SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?"),this.#N=this.#e.prepare("SELECT label, chunk_count as chunkCount FROM sources ORDER BY id DESC"),this.#C=this.#e.prepare(`SELECT c.title, c.content, c.content_type, s.label
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       WHERE c.source_id = ?
       ORDER BY c.rowid`),this.#A=this.#e.prepare("SELECT chunk_count FROM sources WHERE id = ?"),this.#L=this.#e.prepare("SELECT content FROM chunks WHERE source_id = ?"),this.#w=this.#e.prepare("SELECT label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash FROM sources WHERE label = ?"),this.#O=this.#e.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM chunks) AS chunks,
        (SELECT COUNT(*) FROM chunks WHERE content_type = 'code') AS codeChunks
    `),this.#I=this.#e.prepare("DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))"),this.#M=this.#e.prepare("DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))"),this.#F=this.#e.prepare("DELETE FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days')")}setDenyChecker(e){this.#i=e}index(e){let{content:n,path:t,source:s,attribution:i}=e,o=typeof n=="string"&&n.length>0;if(!o&&!t)throw new Error("Either content or path must be provided");let a;if(o)a=n;else{let d=pe(t,"r");try{if(!me(d).isFile())throw new Error(`refusing to index ${t}: not a regular file`);a=he(d,"utf-8")}finally{fe(d)}}let u=s??t??"untitled",c=this.#G(a),l=t??void 0,h=l?Ee("sha256").update(a).digest("hex"):void 0;return I(()=>this.#r(c,u,a,l,h,i))}indexDirectory(e){let{path:n,source:t,attribution:s,perFileDeny:i,...o}=e,a=de(n,o),u=0,c=0,l=0,h=0;for(let d of a.files){if(i&&i(d)){l++;continue}try{let g=t?`${t}:${d}`:d,p=this.index({path:d,source:g,attribution:s});u++,c+=p.totalChunks}catch{h++}}return{filesIndexed:u,totalChunks:c,capped:a.capped,totalSeen:a.totalSeen,denied:l,failed:h,label:t??n}}indexPlainText(e,n,t=20,s,i=$){if(!e||e.trim().length===0)return this.#r([],n,"",void 0,void 0,s);let o=this.#K(e,t,i);return I(()=>this.#r(o.map(a=>({...a,hasCode:!1})),n,e,void 0,void 0,s))}indexJSON(e,n,t=$,s){if(!e||e.trim().length===0)return this.indexPlainText("",n,void 0,s,t);let i;try{i=JSON.parse(e)}catch{return this.indexPlainText(e,n,void 0,s,t)}let o=[];return this.#H(i,[],o,t),o.length===0?this.indexPlainText(e,n,void 0,s,t):I(()=>this.#r(o,n,e,void 0,void 0,s))}#r(e,n,t,s,i,o){let a=e.filter(d=>d.hasCode).length,u=o?.sessionId??"",c=o?.eventId??"",h=this.#e.transaction(()=>{if(this.#h.run(n),this.#g.run(n),this.#p.run(n),e.length===0){let m=this.#a.run(n,s??null,i??null);return Number(m.lastInsertRowid)}let d=this.#c.run(n,e.length,a,s??null,i??null),g=Number(d.lastInsertRowid),p=new Date().toISOString();for(let m of e){let f=m.hasCode?"code":"prose";this.#u.run(m.title,m.content,g,f,null,u,c,p),this.#l.run(m.title,m.content,g,f,null,u,c,p)}return g})();return t&&this.#q(t),this.#P++,this.#P%r.OPTIMIZE_EVERY===0&&this.#j(),{sourceId:h,label:n,totalChunks:e.length,codeChunks:a}}#U(e){return e.map(n=>({title:n.title,content:n.content,source:n.label,rank:n.rank,contentType:n.content_type,highlighted:n.highlighted,timestamp:n.timestamp??void 0,sessionId:n.session_id??""}))}#s(e,n){return n==="exact"?e:`%${e.replace(/\\/g,"\\\\").replace(/%/g,"\\%").replace(/_/g,"\\_")}%`}search(e,n=3,t,s="AND",i,o="like"){let a=ht(e,s),u,c;return t&&i?(u=o==="exact"?this.#k:this.#R,c=[a,this.#s(t,o),i,n]):t?(u=o==="exact"?this.#E:this.#f,c=[a,this.#s(t,o),n]):i?(u=this.#T,c=[a,i,n]):(u=this.#m,c=[a,n]),I(()=>this.#U(u.all(...c)))}searchTrigram(e,n=3,t,s="AND",i,o="like"){let a=gt(e,s);if(!a)return[];let u,c;return t&&i?(u=o==="exact"?this.#D:this.#v,c=[a,this.#s(t,o),i,n]):t?(u=o==="exact"?this.#S:this.#y,c=[a,this.#s(t,o),n]):i?(u=this.#x,c=[a,i,n]):(u=this.#_,c=[a,n]),I(()=>this.#U(u.all(...c)))}fuzzyCorrect(e){let n=e.toLowerCase().trim();if(n.length<3)return null;if(this.#t.has(n)){let c=this.#t.get(n)??null;return this.#t.delete(n),this.#t.set(n,c),c}let t=mt(n.length),s=this.#b.all(n.length-t,n.length+t),i=null,o=t+1,a=!1;for(let{word:c}of s){if(c===n){a=!0;break}let l=pt(n,c);l<o&&(o=l,i=c)}let u=a?null:o<=t?i:null;if(this.#t.size>=r.FUZZY_CACHE_SIZE){let c=this.#t.keys().next().value;c!==void 0&&this.#t.delete(c)}return this.#t.set(n,u),u}#$(e,n,t,s,i="like"){let a=Math.max(n*2,10),u=this.search(e,a,t,"OR",s,i),c=this.searchTrigram(e,a,t,"OR",s,i),l=new Map,h=d=>`${d.source}::${d.title}`;for(let[d,g]of u.entries()){let p=h(g),m=l.get(p);m?m.score+=1/(60+d+1):l.set(p,{result:g,score:1/(60+d+1)})}for(let[d,g]of c.entries()){let p=h(g),m=l.get(p);m?m.score+=1/(60+d+1):l.set(p,{result:g,score:1/(60+d+1)})}return Array.from(l.values()).sort((d,g)=>g.score-d.score).slice(0,n).map(({result:d,score:g})=>({...d,rank:-g}))}#B(e,n){let t=n.toLowerCase().split(/\s+/).filter(o=>o.length>=2),s=t.filter(o=>!M.has(o)),i=s.length>0?s:t;return e.map(o=>{let a=o.title.toLowerCase(),u=i.filter(g=>a.includes(g)).length,c=o.contentType==="code"?.6:.3,l=u>0?c*(u/i.length):0,h=0,d=0;if(i.length>=2){let g=o.content.toLowerCase(),p=i.map(m=>St(g,m));if(!p.some(m=>m.length===0)){h=1/(1+Tt(p)/Math.max(g.length,1));let f=bt(p,i);d=.5*Math.min(1,f/4)}}return{result:o,boost:l+h+d}}).sort((o,a)=>a.boost-o.boost||o.result.rank-a.result.rank).map(({result:o})=>o)}searchWithFallback(e,n=3,t,s,i="like",o){this.#Y();let a=o?Math.max(n*8,40):n,u=this.#V(o),c=this.#$(e,a,t,s,i),l=u?c.filter(u):c;if(l.length>0)return this.#B(l.slice(0,n),e).map(f=>({...f,matchLayer:"rrf"}));let h=e.toLowerCase().trim().split(/\s+/).filter(m=>m.length>=3&&!M.has(m)),d=h.join(" "),p=h.map(m=>this.fuzzyCorrect(m)??m).join(" ");if(p!==d){let m=this.#$(p,a,t,s,i),f=u?m.filter(u):m;if(f.length>0)return this.#B(f.slice(0,n),p).map(E=>({...E,matchLayer:"rrf-fuzzy"}))}return[]}#V(e){return e?n=>{let t=n.sessionId??"";return t===""||e.has(t)}:null}lastRefreshCount=0;#Y(){this.lastRefreshCount=0;let e=this.#e.prepare("SELECT label, file_path, content_hash, indexed_at FROM sources WHERE file_path IS NOT NULL").all();for(let n of e)try{if(!ut(n.file_path)||this.#i&&this.#i(n.file_path))continue;let t=ge(n.file_path).mtime,s=new Date(n.indexed_at+"Z");if(t<=s)continue;let i=pe(n.file_path,"r"),o;try{if(!me(i).isFile())continue;o=he(i,"utf-8")}finally{fe(i)}if(Ee("sha256").update(o).digest("hex")===n.content_hash)continue;this.index({content:o,path:n.file_path,source:n.label}),this.lastRefreshCount++}catch{}}getSourceMeta(e){let n=this.#w.get(e);return n?{label:n.label,chunkCount:n.chunk_count,codeChunkCount:n.code_chunk_count,indexedAt:n.indexed_at,filePath:n.file_path??null,contentHash:n.content_hash??null}:null}listSources(){return this.#N.all()}getIndexState(){let e=this.#e.prepare("SELECT COALESCE(SUM(chunk_count), 0) AS total_chunks, COUNT(*) AS total_sources, MAX(indexed_at) AS last_indexed_at FROM sources").get();return{totalChunks:e.total_chunks??0,totalSources:e.total_sources??0,lastIndexedAt:e.last_indexed_at??void 0}}getChunksBySource(e){return this.#C.all(e).map(t=>({title:t.title,content:t.content,source:t.label,rank:0,contentType:t.content_type}))}getDistinctiveTerms(e,n=40){let t=this.#A.get(e);if(!t||t.chunk_count<3)return[];let s=t.chunk_count,i=2,o=Math.max(3,Math.ceil(s*.4)),a=new Map;for(let l of this.#L.iterate(e)){let h=new Set(l.content.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(d=>d.length>=3&&!M.has(d)));for(let d of h)a.set(d,(a.get(d)??0)+1)}return Array.from(a.entries()).filter(([,l])=>l>=i&&l<=o).map(([l,h])=>{let d=Math.log(s/h),g=Math.min(l.length/20,.5),p=/[_]/.test(l),m=l.length>=12,f=p?1.5:m?.8:0;return{word:l,score:d+g+f}}).sort((l,h)=>h.score-l.score).slice(0,n).map(l=>l.word)}getStats(){let e=this.#O.get();return{sources:e?.sources??0,chunks:e?.chunks??0,codeChunks:e?.codeChunks??0}}cleanupStaleSources(e){return this.#e.transaction(s=>(this.#I.run(s),this.#M.run(s),this.#F.run(s)))(e).changes}getDBSizeBytes(){try{return ge(this.#n).size}catch{return 0}}#j(){try{this.#e.exec("INSERT INTO chunks(chunks) VALUES('optimize')"),this.#e.exec("INSERT INTO chunks_trigram(chunks_trigram) VALUES('optimize')")}catch{}}close(){this.#j(),Y(this.#e)}#q(e){let n=e.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(i=>i.length>=3&&!M.has(i)),t=[...new Set(n)],s=0;this.#e.transaction(()=>{for(let i of t){let o=this.#d.run(i);s+=o.changes}})(),s>0&&this.#t.clear()}#G(e,n=$){let t=[],s=e.split(`
`),i=[],o=[],a="",u=()=>{let l=o.join(`
`).trim();if(l.length===0)return;let h=this.#ee(i,a),d=o.some(_=>/^`{3,}/.test(_));if(Buffer.byteLength(l)<=n){t.push({title:h,content:l,hasCode:d}),o=[];return}let g=l.split(/\n\n+/),p=[],m=1,f=()=>{if(p.length===0)return;let _=p.join(`

`).trim();if(_.length===0)return;let E=g.length>1?`${h} (${m})`:h;m++,t.push({title:E,content:_,hasCode:_.includes("```")}),p=[]};for(let _ of g){p.push(_);let E=p.join(`

`);Buffer.byteLength(E)>n&&p.length>1&&(p.pop(),f(),p=[_])}f(),o=[]},c=0;for(;c<s.length;){let l=s[c];if(/^[-_*]{3,}\s*$/.test(l)){u(),c++;continue}let h=l.match(/^(#{1,4})\s+(.+)$/);if(h){u();let g=h[1].length,p=h[2].trim();for(;i.length>0&&i[i.length-1].level>=g;)i.pop();i.push({level:g,text:p}),a=p,o.push(l),c++;continue}let d=l.match(/^(`{3,})(.*)?$/);if(d){let g=d[1],p=[l];for(c++;c<s.length;){if(p.push(s[c]),s[c].startsWith(g)&&s[c].trim()===g){c++;break}c++}o.push(...p);continue}o.push(l),c++}return u(),t}#z(e,n){if(Buffer.byteLength(e)<=n)return e;let t="",s=0;for(let i of e){let o=Buffer.byteLength(i);if(s+o>n)break;t+=i,s+=o}return t.length===0?[...e][0]??"":t}#o(e,n,t){let s=[],i=[],o=1,a=()=>{if(i.length===0)return;let u=i.join(`
`),c=o===1?n:`${n} (${o})`;s.push({title:c,content:u}),o++,i=[]};for(let u of e){if(Buffer.byteLength(u)>t){a();let l=u,h=1;for(;l.length>0;){let d=this.#z(l,t);if(d.length<l.length){let p=d.lastIndexOf(" "),m=d.lastIndexOf(`
`),f=Math.max(p,m);f>d.length*yt&&(d=d.slice(0,f))}let g=o===1&&h===1?n:`${n} (${o}.${h})`;s.push({title:g,content:d}),l=l.slice(d.length),h++,o++}continue}let c=i.length>0?i.join(`
`)+`
`+u:u;Buffer.byteLength(c)>t&&i.length>0&&a(),i.push(u)}return a(),s}#K(e,n,t=$){let s=e.split(/\n\s*\n/);if(s.length>=ft&&s.length<=Et&&s.every(c=>Buffer.byteLength(c)<_t))return s.flatMap((c,l)=>{let h=c.trim();if(h.length===0)return[];let d=h.split(`
`)[0].slice(0,_e)||`Section ${l+1}`;return Buffer.byteLength(h)<=t?[{title:d,content:h}]:this.#o(h.split(`
`),d,t)});let i=e.split(`
`);if(i.length<=n)return Buffer.byteLength(e)<=t?[{title:"Output",content:e}]:this.#o(i,"Output",t);let o=[],u=Math.max(n-2,1);for(let c=0;c<i.length;c+=u){let l=i.slice(c,c+n);if(l.length===0)break;let h=c+1,d=Math.min(c+l.length,i.length),g=l[0]?.trim().slice(0,_e),p=l.join(`
`);if(Buffer.byteLength(p)<=t)o.push({title:g||`Lines ${h}-${d}`,content:p});else{let m=this.#o(l,g||`Lines ${h}-${d}`,t);o.push(...m)}}return o}#H(e,n,t,s){let i=n.length>0?n.join(" > "):"(root)",o=JSON.stringify(e,null,2);if(Buffer.byteLength(o)<=s&&!(typeof e=="object"&&e!==null&&!Array.isArray(e)&&Object.values(e).some(u=>typeof u=="object"&&u!==null))){t.push({title:i,content:o,hasCode:!0});return}if(typeof e=="object"&&e!==null&&!Array.isArray(e)){let a=Object.entries(e);if(a.length>0){for(let[u,c]of a)this.#H(c,[...n,u],t,s);return}t.push({title:i,content:o,hasCode:!0});return}if(Array.isArray(e)){this.#Z(e,n,t,s);return}t.push({title:i,content:o,hasCode:!1})}#J(e){if(e.length===0)return null;let n=e[0];if(typeof n!="object"||n===null||Array.isArray(n))return null;let t=["id","name","title","path","slug","key","label"],s=n;for(let i of t)if(i in s&&(typeof s[i]=="string"||typeof s[i]=="number"))return i;return null}#Q(e,n,t,s,i){let o=e?`${e} > `:"";if(!i)return n===t?`${o}[${n}]`:`${o}[${n}-${t}]`;let a=u=>String(u[i]);return s.length===1?`${o}${a(s[0])}`:s.length<=3?o+s.map(a).join(", "):`${o}${a(s[0])}\u2026${a(s[s.length-1])}`}#Z(e,n,t,s){let i=n.length>0?n.join(" > "):"(root)",o=this.#J(e),a=[],u=0,c=l=>{if(a.length===0)return;let h=this.#Q(i,u,l,a,o);t.push({title:h,content:JSON.stringify(a,null,2),hasCode:!0})};for(let l=0;l<e.length;l++){a.push(e[l]);let h=JSON.stringify(a,null,2);Buffer.byteLength(h)>s&&a.length>1&&(a.pop(),c(l-1),a=[e[l]],u=l)}c(u+a.length-1)}#ee(e,n){return e.length===0?n||"Untitled":e.map(t=>t.text).join(" > ")}};import{createHash as Re}from"node:crypto";import{accessSync as vn,constants as Dn,existsSync as Se,mkdirSync as Nn,realpathSync as Cn,renameSync as be}from"node:fs";import{dirname as Ln,isAbsolute as On,join as Te,resolve as wn}from"node:path";function ke(r){let e=r.replace(/\\/g,"/");return/^\/+$/.test(e)?"/":/^[A-Za-z]:\/+$/.test(e)?`${e.slice(0,2)}/`:e.replace(/\/+$/,"")}function Rt(r){return Re("sha256").update(ke(r)).digest("hex").slice(0,16)}function kt(r){let e=ke(r),n=process.platform==="darwin"||process.platform==="win32"?e.toLowerCase():e;return Re("sha256").update(n).digest("hex").slice(0,16)}function xe(r){let{projectDir:e,contentDir:n}=r,t=kt(e),s=Te(n,`${t}.db`);if(Se(s))return s;let i=Rt(e);if(i===t)return s;let o=Te(n,`${i}.db`);if(Se(o))try{be(o,s);for(let a of["-wal","-shm"])try{be(o+a,s+a)}catch{}}catch{}return s}var q="CONTEXT_WRAPPER_CONFIG";function Ne(r){let e=process.env[q];if(e){let t=C(e),s;try{s=G(t,"utf-8")}catch(i){throw new Error(`${q} points at "${t}" but it could not be read: ${i.message}`)}try{return{config:JSON.parse(s),configPath:t,sourceBase:C(r)}}catch(i){throw new Error(`${q} config at "${t}" is not valid JSON: ${i.message}`)}}let n=C(r);for(;;){let t=z(n,".claude","context-mode.json");try{let i=G(t,"utf-8");return{config:JSON.parse(i),configPath:t,sourceBase:n}}catch{}let s=Nt(n);if(s===n)break;n=s}return null}function At(r,e){let n=e.replace(/[.+^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*").replace(/\?/g,".");return new RegExp(`^${n}$`).test(r)}function K(r,e,n){let t=[];try{let s=xt(r);for(let i of s){let o=z(r,i);try{let a=ve(o);a.isDirectory()&&n?t.push(...K(o,e,!0)):a.isFile()&&At(i,e)&&t.push(o)}catch{}}}catch{}return t}function P(r,e){try{let n=G(r,"utf-8");return n.trim().length===0?null:{name:e?Ct(e,r):De(r),path:r,content:n}}catch{return null}}function Lt(r,e){let n=C(e,r.path||".");if(r.paths)return r.paths.map(t=>C(n,t)).map(t=>P(t,n)).filter(t=>t!==null);if(r.exec){let t=n;try{let s=Dt(r.exec,{cwd:t,encoding:"utf-8",timeout:1e4}).trim(),i=JSON.parse(s);return Array.isArray(i)?i.map(o=>C(t,o)).map(o=>P(o,t)).filter(o=>o!==null):(process.stderr.write(`[context-wrapper] exec for "${r.label}" did not return an array
`),[])}catch(s){return process.stderr.write(`[context-wrapper] exec for "${r.label}" failed: ${s.message}
`),[]}}return r.glob&&r.path?K(n,r.glob,!!r.recursive).map(t=>P(t,n)).filter(t=>t!==null):(process.stderr.write(`[context-wrapper] source "${r.label}" has no file selection strategy (need glob+path, exec, or paths)
`),[])}function Ot(r){if(!r.startsWith("---"))return r;let e=r.indexOf(`
---`,3);return e===-1?r:r.slice(e+4).replace(/^\n+/,"")}function wt(r,e){let n=e.match(/^(\d{4}-\d{2}-\d{2})\.md$/);if(!n)return r;let t=n[1],s=r.split(`
`),i=[];for(let o of s){if(/^##\s+\d{4}-\d{2}-\d{2}\s*$/.test(o))continue;let a=o.match(/^(##\s+)(.+)$/);a?i.push(`${a[1]}[${t}] ${a[2]}`):i.push(o)}return i.join(`
`)}function It(r){return r.replace(/\n{3,}/g,`

`)}function Ce(r,e,n){let t=r;return n?.stripFrontmatter&&(t=Ot(t)),n?.prefixDates&&(t=wt(t,e)),It(t)}function Mt(r,e){return Ce(r.content,r.name,{stripFrontmatter:e.stripFrontmatter,prefixDates:e.prefixDates})}function Ft(r,e){let n=z(r,"content");return vt(n,{recursive:!0}),xe({projectDir:C(e),contentDir:n})}function Ae(r){let e=C(r.path),n=ve(e),t=String(r.source??De(e));if(n.isDirectory()){let i=r.glob??"*.md",o=r.recursive!==!1,a=K(e,i,o).map(u=>P(u,e)).filter(u=>u!==null);return{basePath:e,isDirectory:!0,files:a,sourcePrefix:t}}let s=P(e);return{basePath:e,isDirectory:!1,files:s?[s]:[],sourcePrefix:t}}function Le(r,e){let n=e?.stripFrontmatter!==!1,t=e?.prefixDates===!0;return r.map(s=>({file:s,content:Ce(s.content,s.name,{stripFrontmatter:n,prefixDates:t})})).filter(s=>s.content.trim().length>0).map(s=>({...s,source:s.file.name}))}function Oe(r,e,n,t){let s=Ft(e,n),i=new B(s),o=0,a=0,u=new Map;for(let c of r.sources){let l=Lt(c,t);if(l.length!==0)for(let h of l){let d=Mt(h,c);if(d.trim().length===0)continue;let g=`${c.label}: ${h.name}`,p=i.index({content:d,source:g});o++,a+=p.totalChunks;let m=u.get(c.label)??{label:c.label,description:c.description,files:0,chunks:0};m.files++,m.chunks+=p.totalChunks,u.set(c.label,m)}}return i.close(),{totalSources:o,totalChunks:a,dbPath:s,sources:[...u.values()]}}function we(r){return r.length===0?null:`Pre-warmed at startup and searchable now (no \`index\` call needed): ${r.map(n=>{let t=`\`${n.label}\` (${n.files} file${n.files===1?"":"s"})`;return n.description?`${t} \u2014 ${n.description}`:t}).join("; ")}. Scope to one with \`source: "<label>"\`.`}function Pt(r){return r.replace(/^⚠️ context-mode v[^\n]+ outdated → v[^\n]+ available\. Upgrade: [^\n]+\n\n/,"")}function Ie(r){let e=r?.content;if(Array.isArray(e))for(let n of e)n?.type==="text"&&typeof n.text=="string"&&(n.text=Pt(n.text))}function Me(r,e){let n=r?.content;if(Array.isArray(n))for(let t of n){if(t?.type!=="text"||typeof t.text!="string")continue;let s=/\n\n⚠ search call #\d+\/\d+ in this window\..+$/s,i=/^BLOCKED: \d+ search calls in \d+s\..+$/s;s.test(t.text)?t.text=e===!1?t.text.replace(s,""):t.text.replace(s,`

${e}`):i.test(t.text)&&(t.text=e===!1?"":String(e))}}var J={execute:"ctx_execute",index:"ctx_index",search:"ctx_search",fetch_and_index:"ctx_fetch_and_index",batch_execute:"ctx_batch_execute"};var Ue=new Map(Object.entries(J).map(([r,e])=>[e,r])),Kt=new Set(["ctx_stats","ctx_doctor","ctx_upgrade","ctx_purge","ctx_insight"]),j={execute:"Run code in the upstream sandbox. Use for derivation over files, command output, or fetched data without dumping raw bytes into context. When `path` is provided, the file is exposed inside the sandbox as FILE_CONTENT.",search:"Search indexed content with BM25/FTS5 ranking. Use after prewarm, index, fetch_and_index, batch_execute, or batch_read. Scope with `source` when you want results from a specific label or batch.",fetch_and_index:"Fetch one or more URLs, convert/index the content, and make it searchable. Use when the source is remote and you want retrieval via `search` instead of pasting raw page content into context.",batch_execute:"Run multiple shell commands, index their outputs, and optionally query the results in the same call. Use for multi-step collection where raw command output should converge into searchable indexed content."},Jt=new Set(["apps","packages","src","lib"]);function Qt(r){let e=r.split("/").filter(Boolean),n=-1;for(let s=e.length-1;s>=0;s--)if(Jt.has(e[s])){n=s;break}let t=n>=0?e.slice(n+1):e.slice(-2);return t=t.filter(s=>s!=="src"),t.join("/")}function Zt(r){let e=new Map;return r.map(n=>{let t=(e.get(n)??0)+1;return e.set(n,t),t>1?`${n} (${t})`:n})}function en(r){let n=(r?.content?.[0]?.text??"").match(/^Indexed (\d+) sections/);return n?parseInt(n[1],10):0}function Z(r,e){if(Array.isArray(r))return r.every(n=>typeof n=="string")?{ok:!0,value:r}:{ok:!1,message:`${e} must be an array of strings.`};if(typeof r=="string"){let n=r.trim();if(n.length===0)return{ok:!1,message:`${e} must not be empty.`};if(n.startsWith("[")){try{let t=JSON.parse(n);if(Array.isArray(t)&&t.every(s=>typeof s=="string"))return{ok:!0,value:t}}catch{}return{ok:!1,message:`${e} looks like a JSON array but did not parse to an array of strings: ${r}`}}return{ok:!0,value:[r]}}return{ok:!1,message:`${e} must be an array of strings.`}}function tn(r){return!!r&&r.type==="array"&&!!r.items&&r.items.type==="string"}function ee(r){let e={type:"array",items:r.items??{type:"string"}};return r.minItems!==void 0&&(e.minItems=r.minItems),{description:(r.description?r.description+" ":"")+'Accepts either an array of strings or a JSON-encoded array string, e.g. "[\\"a\\",\\"b\\"]".',anyOf:[e,{type:"string"}]}}function nn(r,e){if(!r?.properties)return r;let n={...r.properties};for(let t of e)tn(n[t])&&(n[t]=ee(n[t]));return{...r,properties:n}}async function rn(){let r=process.cwd(),e=Ne(r),n=$t(Fe(Ut(),"context-mode-")),t=Pe(Wt(import.meta.url)),s=t.endsWith("/src")?Pe(t):t,i=Fe(s,"node_modules","context-mode","server.bundle.mjs"),o=new qt({command:"node",args:[i],cwd:r,env:{...process.env,CONTEXT_MODE_DIR:n,CONTEXT_MODE_PROJECT_DIR:r,CLAUDE_PROJECT_DIR:r,PWD:r,CONTEXT_MODE_DISABLE_VERSION_CHECK:"1"},stderr:"inherit"}),a=new Yt({name:"context-wrapper",version:"0.2.0"});await a.connect(o);let u=o.pid;if(!u)throw new Error("Failed to get upstream server PID");process.stderr.write(`[context-wrapper] Connected to upstream server (pid ${u})
`);let c=j.search;if(e){let f=performance.now(),_=Oe(e.config,n,r,e.sourceBase),E=(performance.now()-f).toFixed(0);process.stderr.write(`[context-wrapper] Pre-warmed ${_.totalChunks} chunks from ${_.totalSources} files in ${E}ms (${_.dbPath})
`);let D=we(_.sources);D&&(c+=`

${D}`)}let{tools:l}=await a.listTools(),h=l.find(f=>f.name==="ctx_execute_file"),d=l.filter(f=>!Kt.has(f.name)).filter(f=>f.name!=="ctx_execute_file").filter(f=>Ue.has(f.name)).map(f=>{let _=Ue.get(f.name);if(_==="execute"&&h){let E={...f.inputSchema.properties??{}};return h.inputSchema.properties?.path?E.path=h.inputSchema.properties.path:E.path={type:"string",description:"Absolute file path or relative to project root. When provided, reads this file into a FILE_CONTENT variable inside the sandbox \u2014 file contents stay in sandbox, only your printed output enters context."},{...f,name:_,description:j.execute,inputSchema:{...f.inputSchema,properties:E}}}return _==="index"?{...f,name:_,description:"Store content in the searchable BM25 knowledge base. When `content` is provided, it is indexed directly. When `path` is provided, the wrapper reads files relative to the agent cwd, applies markdown preprocessing, and indexes each file as its own source.",inputSchema:{type:"object",properties:{content:{type:"string",description:"Raw text/markdown to index. Provide this OR path, not both."},path:{type:"string",description:"File or directory path to index. Relative paths resolve from the current working directory/worktree."},source:{type:"string",description:'Source label. For directories, each file gets "{source}: {relative/path}". Defaults to the directory basename or resolved file path.'},glob:{type:"string",description:'Directory-only filename pattern. Defaults to "*.md".'},recursive:{type:"boolean",description:"Directory-only recursive walk flag. Defaults to true."},stripFrontmatter:{type:"boolean",description:"Path-based indexing only. Strip YAML frontmatter before indexing. Defaults to true."},prefixDates:{type:"boolean",description:"Path-based indexing only. For YYYY-MM-DD.md files, prefix ## headings with [date]. Defaults to false."}}}}:_==="search"?{...f,name:_,description:c,inputSchema:nn(f.inputSchema,["queries"])}:_==="fetch_and_index"?{...f,name:_,description:j.fetch_and_index}:_==="batch_execute"?{...f,name:_,description:j.batch_execute}:{...f,name:_}});d.push({name:"batch_read",description:"Read multiple files, index them, and search across their contents. Use instead of batch_execute when all inputs are known file paths (no shell commands needed). Labels are auto-derived from file paths. Returns BM25 search results plus a batch ID \u2014 pass the batch ID as `source` to `search` for follow-up questions scoped to exactly these files.",inputSchema:{type:"object",properties:{files:ee({type:"array",items:{type:"string"},description:"File paths to read and index. Absolute paths preferred; relative paths resolve from the current working directory.",minItems:1}),queries:ee({type:"array",items:{type:"string"},description:"Search queries to run against the indexed content. Use 5\u20138 comprehensive queries. Each returns top matching sections.",minItems:1})},required:["files","queries"],additionalProperties:!1}});let g=new Xt({name:"context-wrapper",version:"0.2.0"},{capabilities:{tools:{}}});g.setRequestHandler(Gt,async()=>({tools:d})),g.setRequestHandler(zt,async f=>{let{name:_,arguments:E}=f.params;if(_==="index"&&E?.path!==void 0){let S=Q(r,String(E.path)),y;try{y=Ae({path:S,source:typeof E.source=="string"?E.source:void 0,glob:typeof E.glob=="string"?E.glob:void 0,recursive:typeof E.recursive=="boolean"?E.recursive:void 0,stripFrontmatter:typeof E.stripFrontmatter=="boolean"?E.stripFrontmatter:void 0,prefixDates:typeof E.prefixDates=="boolean"?E.prefixDates:void 0})}catch(k){return{content:[{type:"text",text:`Index error: ${k.message}`}],isError:!0}}if(y.files.length===0)return{content:[{type:"text",text:y.isDirectory?`No files matched in ${y.basePath}.`:`Nothing indexable found at ${y.basePath}.`}]};let O=Le(y.files,{stripFrontmatter:typeof E.stripFrontmatter=="boolean"?E.stripFrontmatter:void 0,prefixDates:typeof E.prefixDates=="boolean"?E.prefixDates:void 0}),R=0,N=0,b=[];for(let k of O){let v=y.isDirectory?`${y.sourcePrefix}: ${k.source}`:String(E.source??y.basePath);try{let U=await a.callTool({name:"ctx_index",arguments:{content:k.content,source:v}});N+=en(U),R++}catch(U){b.push(`${k.file.name}: ${U.message}`)}}let T=y.isDirectory?`Indexed ${R} file${R===1?"":"s"} (${N} chunks) from ${y.basePath}`:`Indexed ${N} sections from: ${String(E.source??y.basePath)}`;return{content:[{type:"text",text:b.length>0?`${T}

Errors (${b.length}):
${b.join(`
`)}`:T}],isError:b.length>0&&R===0}}if(_==="batch_read"){let S=Z(E?.files,"files"),y=Z(E?.queries,"queries"),O=[...S.ok?[]:[S.message],...y.ok?[]:[y.message]];if(O.length>0)return{content:[{type:"text",text:`Invalid arguments for batch_read:
${O.map(x=>`  - ${x}`).join(`
`)}`}],isError:!0};let R=S.value,N=y.value,b=Ht(3).toString("hex"),T=R.map(x=>Qt(Q(r,x))),k=Zt(T),v=[];for(let x=0;x<R.length;x++){let te=Q(r,R[x]),He=`${b}/${k[x]}`,ne;try{ne=Bt(te,"utf-8")}catch{v.push(te);continue}await a.callTool({name:"ctx_index",arguments:{content:ne,source:He}})}let $e=(await a.callTool({name:"ctx_search",arguments:{queries:N,source:b,limit:3}})).content?.[0]?.text??"(no results)",Be=v.length>0?`

\u26A0 Could not read ${v.length} file(s):
${v.map(x=>`  - ${x}`).join(`
`)}`:"",je=`

---
**Batch ID:** \`${b}\`
To search only these files: \`search(queries: [...], source: "${b}")\``;return{content:[{type:"text",text:$e+Be+je}]}}let D=E;if(_==="search"&&E?.queries!==void 0){let S=Z(E.queries,"queries");if(!S.ok)return{content:[{type:"text",text:`Invalid arguments for search:
  - ${S.message}`}],isError:!0};D={...E,queries:S.value}}let A;if(_==="execute"&&E?.path!==void 0?A="ctx_execute_file":A=J[_],!A)return{content:[{type:"text",text:`Unknown tool: ${_}`}],isError:!0};let L=await a.callTool({name:A,arguments:D});return Ie(L),_==="search"&&e?.config.searchReminder!==void 0&&Me(L,e.config.searchReminder),L});let p=new Vt;await g.connect(p),process.stderr.write(`[context-wrapper] MCP server ready (${d.length} tools) [tmp=${n}]
`);let m=async()=>{await Promise.allSettled([a.close(),g.close()])};process.stdin.on("end",()=>process.exit(0)),process.on("SIGINT",async()=>{await m(),process.exit(0)}),process.on("SIGTERM",async()=>{await m(),process.exit(0)}),process.on("exit",()=>{try{process.kill(u)}catch{}try{jt(n,{recursive:!0,force:!0})}catch{}})}rn().catch(r=>{process.stderr.write(`[context-wrapper] Fatal: ${r.message}
${r.stack}
`),process.exit(1)});
