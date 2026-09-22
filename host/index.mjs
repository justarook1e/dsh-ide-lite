// dsh-file-edit — static host plugin.
// Persisted across DSH restarts: mounted from ~/.dsh/profiles/web/cordis.patch.yml.
// Browser RPC arrives at POST /dsh-file-edit/api (registered on ctx.webServer).
// Per-session review state (baseline + pending decisions) is persisted under
// ~/.dsh/dsh-file-edit-state/<sessionId>.json so accept/reject survives restarts.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, rmSync, statSync, createWriteStream, realpathSync, chmodSync } from 'node:fs'
import { open as openP } from 'node:fs/promises'
import { join, dirname, relative, isAbsolute, resolve as resolvePath } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'

const STATE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-file-edit-state')
// v1.10.0 rename migration: the plugin used to live under dsh-files with its
// state in dsh-files-state/. Carry the old per-session review state (pending
// decisions, baselines, lastReject) over once so the rename does not reset
// every session's review state.
{
  const legacy = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-files-state')
  if (!existsSync(STATE_DIR) && existsSync(legacy)) {
    try { renameSync(legacy, STATE_DIR) } catch (e) {
      console.error('[dsh-file-edit] state migration failed:', e && e.message ? e.message : e)
    }
  }
}
mkdirSync(STATE_DIR, { recursive: true })

// v1.20: session deletion (permanent). DSH exposes no session-delete API, so
// the plugin removes the session's own artifacts from the JSONL store. The
// layout mirrors session-persistence-jsonl exactly
// (packages/session/session-persistence-jsonl/src/format.ts):
//   <root>/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.jsonl.zstd
// with root = dshHomePath('sessions') (bundle/base/cordis.patch.yml). The two
// encoders below are faithful mirrors (injective, separator-safe); the delete
// handler validates the target again before rmSync.
const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
// Session ids are session-<uuid>; allow only encodeSegment-safe code units so
// no traversal/absolute path can ever reach the filesystem.
const SESSION_ID_RE = /^session-[A-Za-z0-9._~-]{8,160}$/
function encodeSegmentOf(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}
function projectKeyOf(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return '--' + slug.slice(0, 251) + '--'
}

export default {
  // Hard dependencies: the loader waits for these host services to become
  // ACTIVE before apply runs (ctx.get is strict about fiber state and can
  // return undefined when the bundle layer is still settling).
  inject: ['fs', 'sandboxPolicy', 'sessions', 'webServer', 'shell'],
  apply(ctx) {
    const fs = ctx.fs
    const sandboxPolicy = ctx.sandboxPolicy
    const sessions = ctx.sessions
    const shell = ctx.shell
    const webServer = ctx.webServer
    if (!fs || !sandboxPolicy || !sessions || !webServer) {
      console.error('[dsh-file-edit] missing host services (fs, sandboxPolicy, sessions, webServer)')
      return
    }

    const MAX_CONTENT_BYTES = 512 * 1024
    // v1.31: the "content in memory" window above which an entry is read as a
    // SIGNATURE instead (see sigFor). Text beyond this stays reviewable and
    // diffable — that is the whole point of the signature — but its content is
    // not kept between calls. Beyond MAX_SIG_BYTES even the streaming pass is
    // refused (a 2GB log must not be hashed on a 20s poll), and only that tier
    // still degrades to whole-file accept/reject.
    const MAX_SIG_BYTES = 64 * 1024 * 1024
    const SIG_TIERS = { hash: 'h', sampled: 's' }
    // Sampled-signature windows (only used past MAX_SIG_BYTES — see sigFor).
    const SIG_SAMPLE_BYTES = 64 * 1024
    const SIG_SAMPLE_READ_BYTES = SIG_SAMPLE_BYTES + 1
    // v1.31: how much text the DIFF VIEW still ships whole. A file in this tier
    // is fully reviewable (real hunks, real stats) regardless — this bound only
    // decides whether the viewer also gets the surrounding file to render as
    // context, or just the hunks plus a head/tail preview. It is a
    // rendering/DOM bound, not a review bound: 40,000 lines is already far past
    // what a browser should be asked to lay out at once.
    const MAX_DIFF_SHIP_LINES = 40000
    const MAX_ENTRIES = 8000
    const MAX_DEPTH = 16
    // v1.20.4: expanded hard-skip list. These are dependency/runtime/cache/
    // generated-output directories — never authored source — so agent changes
    // inside them are NOT reviewed (and they do not consume the walk budget).
    // v1.27: this list now governs the REVIEW SCAN ONLY (walkFiles). The file
    // tree has its own, much smaller hide list (TREE_SKIP_DIRS) so that a
    // dependency/runtime folder is still browsable — see the note there.
    const SKIP_DIRS = new Set([
      // version control / editor / tooling metadata
      '.git', '.dsh', '.idea', '.vscode', '.DS_Store',
      // node / js toolchains, package managers, bundler caches
      'node_modules', 'bower_components', 'jspm_packages', '.yarn', '.pnpm-store',
      // js framework build outputs + their caches
      '.next', '.nuxt', '.svelte-kit', '.astro', '.output', '_next', '.angular', '.vite', '.parcel-cache', '.turbo', '.cache', '.swc',
      'build',
      // python runtimes, environments, caches
      'python', '.venv', 'venv', 'env', 'site-packages', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
      // rust / java / .gradle / xcode / dart / flutter
      'target', '.gradle', 'DerivedData', 'Pods', 'Carthage', '.swiftpm', '.dart_tool',
      // ruby / php / go / elixir / erlang dependencies
      'vendor', 'deps', '_build', '.stack-work', '.bundle',
      // playwright & test artifacts
      'playwright_browsers', 'playwright-report', 'test-results', 'coverage', '.nyc_output',
      // misc infra
      '.terraform', '.eslintcache', '.stylelintcache',
    ])
    // v1.27: the file tree hides only what is not worth browsing at all —
    // VCS/editor metadata and this plugin's own state. Dependency, runtime and
    // build folders stay VISIBLE (that is what SKIP_DIRS above is now scoped
    // to: they are excluded from the review scan / diff, not from the tree).
    // Rationale: SKIP_DIRS matches by folder NAME at any depth, so a folder
    // legitimately called `python/`, `build/` or `vendor/` used to disappear
    // from the sidebar entirely even when it was just project layout.
    const TREE_SKIP_DIRS = new Set(['.git', '.dsh', '.idea', '.vscode', '.DS_Store'])
    // The tree gets its own, larger ceiling: MAX_ENTRIES is a REVIEW-coverage
    // bound (how much source the diff may cover). With dependency folders now
    // rendered, that number would truncate the tree far too early, so the tree
    // is bounded separately — purely as a payload/serialization guard.
    const TREE_MAX_NODES = 20000
    // v1.13.3: change triggers are event-driven and NARROW — the client no
    // longer fast-polls (its fixed 20s arm is only a failsafe), so a trigger
    // here must be both precise and cheap. write/edit always mutate and carry
    // an explicit file_path. shell/pwsh are opaque text, so instead of
    // "any shell call dirties the session" only commands that can actually
    // change the workspace get through: read-only traffic (Get-ChildItem,
    // node --version, git status, ...) now costs nothing.
    // v1.18: extended with the remaining file-mutating PowerShell cmdlets and
    // the direct .NET static file APIs (which the extractor cannot locate
    // precisely, so they intentionally fall back to the full walk). False
    // positives here only cost one walk — never a missed change.
    const MUTATING_SHELL_RE = /Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Clear-Content|Tee-Object|Export-Csv|Export-Clixml|Set-Item|WriteAllText|AppendAllText|WriteAllLines|WriteAllBytes|File\.Copy|File\.Move|File\.Delete|del\s|rm\s|rmdir|mkdir\s|\bmd\s|\brd\s/i
    // v1.15.1: git commands that change the worktree↔HEAD relationship (the
    // thing the VCS badges answer). commit/checkout/reset/... never touch a
    // worktree byte the scanner could see, so they need their own trigger
    // that bumps the tree stamp directly. Read-only git (status/log/diff/...)
    // stays untriggered. Substring false positives (echo 'git commit') cost
    // one extra walk — same acceptable trade as MUTATING_SHELL_RE.
    const MUTATING_GIT_RE = /\bgit\s+(?:add|commit|checkout|co|reset|clean|restore|stash|rm|mv|merge|rebase|pull|cherry-pick|apply|am|switch|init)\b/i
    // v1.18: git commands that change ONLY the index/HEAD relationship (never
    // a worktree byte the scanner could see). They still bump the tree stamp
    // so the VCS badges re-ask git, but they must NOT set dirty — a full
    // walk after every `git add`/`git commit` was pure waste on big
    // workspaces. Worktree-mutating git (checkout/reset/clean/restore/rm/mv/
    // merge/rebase/pull/cherry-pick/apply/am/switch/stash) keeps the dirty
    // path, resolved precisely when the command names its files.
    // v1.18: git subcommands that DO rewrite worktree bytes (everything in the
    // mutating list except the index-only add/commit/init). Used to decide
    // whether a command may take the index-only shortcut: a command mixing
    // `git add` with `git checkout -- x`/`git reset --hard` must NOT be treated
    // as index-only, otherwise the worktree change is silently dropped.
    const GIT_WORKTREE_RE = /\bgit\s+(?:checkout|co|reset|clean|restore|stash|rm|mv|merge|rebase|pull|cherry-pick|apply|am|switch)\b/i
    const knownSessions = new Set()
    // Undo safety: reject overwrites disk with baseline content, so every
    // reject snapshots the pre-reject bytes first (one undo level per
    // session). Binary baseline blobs and undo backups skip bigger files.
    const MAX_BACKUP_BYTES = 4 * 1024 * 1024
    // v1.9: markdown files render fully in the viewer (no line cap, no
    // preview truncation). Content beyond the 512KB scan cap is read ON
    // DEMAND when the file is opened, bounded by this payload ceiling
    // (32MB — shipping more than that as JSON would defeat the purpose).
    const MAX_MD_RENDER_BYTES = 32 * 1024 * 1024
    // v1.18: the client's failsafe poll runs every 20s, and the whole-workspace
    // walk is now reserved for exactly that cadence (plus the first scan and
    // the "could not locate the changed file" fallback). Every getModified/
    // getDiff/listTree/mutation RPC re-checks freshness: a session whose last
    // full scan is older than this TTL gets one full walk, otherwise precise
    // per-path refreshes (or nothing) keep the state current.
    const FULL_SCAN_TTL = 20000

    // ---------- text / path helpers ----------
    function splitLines(text) {
      if (!text) return []
      const t = text.replace(/\r\n/g, '\n')
      const parts = t.split('\n')
      if (t.endsWith('\n')) parts.pop()
      return parts
    }
    // v1.33 (F6): the write style must be PER LINE when a file MIXES endings.
    // `crlf` is one boolean ("the file contains at least one CRLF"), so rebuilding
    // a mixed file with it rewrote EVERY line's ending: a one-line inline edit
    // turned "l1\nl2\r\nl3\n" into all-CRLF — a whole-file change the plugin's own
    // (EOL-blind) diff never showed. `eolMap` is a per-line terminator map
    // ('l' = LF, 'c' = CRLF, 'n' = no terminator / EOF without a newline) aligned
    // 1:1 with the line array. It is null for uniform files — the overwhelmingly
    // common case — which keeps the legacy fast path byte-for-byte.
    function eolMapOf(raw) {
      if (typeof raw !== 'string' || raw.indexOf('\n') < 0) return null
      // Count first: only a genuinely mixed file pays for the split.
      let lf = 0
      let crlf = 0
      for (let i = raw.indexOf('\n'); i >= 0; i = raw.indexOf('\n', i + 1)) {
        if (i > 0 && raw.charCodeAt(i - 1) === 13) crlf++
        else lf++
      }
      if (lf === 0 || crlf === 0) return null
      const segs = raw.split('\n')
      const endsNL = raw.charCodeAt(raw.length - 1) === 10
      const count = endsNL ? segs.length - 1 : segs.length
      let out = ''
      for (let i = 0; i < count; i++) {
        if (i === count - 1 && !endsNL) { out += 'n'; continue }
        out += segs[i].charCodeAt(segs[i].length - 1) === 13 ? 'c' : 'l'
      }
      return out
    }
    function dominantEolChar(eolMap, crlf) {
      if (!eolMap) return crlf ? 'c' : 'l'
      let c = 0
      let l = 0
      for (let i = 0; i < eolMap.length; i++) {
        const ch = eolMap.charCodeAt(i)
        if (ch === 99) c++
        else if (ch === 108) l++
      }
      if (c === l) return crlf ? 'c' : 'l'
      return c > l ? 'c' : 'l'
    }
    // Mirror of mergeHunks for the terminator map: the same reverse-order splice
    // keeps the merged text and the merged map index-aligned.
    //
    // v1.32.7 (F6 fix): the LAST line's terminator follows the file's trailing
    // newline state — the rule remapEolMap already applies. Filling every new
    // line with `dom` added a trailing newline to a mixed-EOL file that had none
    // (a byte the user never asked for, which the entry's `eol: false` then
    // disagreed with).
    function mergeEolMap(baseMap, hunks, decisions, trailingNL, crlf) {
      if (!baseMap) return null
      const out = baseMap.split('')
      const dom = dominantEolChar(baseMap, crlf === true)
      for (let i = hunks.length - 1; i >= 0; i--) {
        const h = hunks[i]
        if (decisions.get(h.id) === 'reject') continue
        out.splice(h.oldStart, h.oldLen, ...new Array(h.newLines.length).fill(dom))
      }
      if (out.length > 0) out[out.length - 1] = trailingNL ? dom : 'n'
      return out.join('')
    }
    // Map an old line array onto a new one through the Myers op stream the caller
    // already computed for the edit fold.
    //
    // v1.32.7 (F6 fix): myersOps TRIMS the common prefix/suffix, so the stream
    // covers only the changed region — the old `out.length !== newLen` test
    // therefore returned null for every edit that keeps a first or last line,
    // i.e. for virtually every real save, and the per-line map silently degraded
    // to the uniform style (mixed-EOL file rewritten wholesale on Ctrl+S). The
    // map is now rebuilt by pairing the RETAINED lines in order (skipping
    // deletions, filling insertions), which is exactly the alignment the op
    // stream encodes and is valid for a trimmed stream too. An inserted line
    // continues the previous line's terminator; if that previous line was the
    // old last line WITHOUT one ('n'), it must gain a terminator or the appended
    // text would be glued onto it. Returns null only when the stream and the
    // arrays disagree — every caller then falls back to the uniform style, i.e.
    // exactly the pre-v1.33 behaviour.
    function remapEolMap(oldMap, ops, newLen, trailingNL, crlf) {
      if (!oldMap || !ops) return null
      if (newLen === 0) return ''
      const dom = dominantEolChar(oldMap, crlf)
      const deleted = new Set()
      const inserted = new Set()
      for (const op of ops) {
        if (op.t === 'd') deleted.add(op.i)
        else if (op.t === 'i') inserted.add(op.j)
      }
      const out = []
      let i = 0
      for (let j = 0; j < newLen; j++) {
        if (inserted.has(j)) {
          // The line before an insertion now has a follower: a terminator-less
          // ('n') predecessor has to gain one.
          if (out.length > 0 && out[out.length - 1] === 'n') out[out.length - 1] = dom
          out.push(out.length > 0 ? out[out.length - 1] : dom)
          continue
        }
        while (i < oldMap.length && deleted.has(i)) i++
        if (i >= oldMap.length) return null
        out.push(oldMap[i])
        i++
      }
      while (i < oldMap.length && deleted.has(i)) i++
      if (i !== oldMap.length) return null
      out[newLen - 1] = trailingNL ? dom : 'n'
      return out.join('')
    }
    function joinLines(lines, trailingNL, crlf, eolMap) {
      if (lines.length === 0) return ''
      if (eolMap && eolMap.length === lines.length) {
        let out = ''
        for (let i = 0; i < lines.length; i++) {
          const ch = eolMap.charCodeAt(i)
          out += lines[i]
          if (ch === 99) out += '\r\n'
          else if (ch === 108) out += '\n'
        }
        return out
      }
      const sep = crlf ? '\r\n' : '\n'
      return lines.join(sep) + (trailingNL ? sep : '')
    }
    // v1.31: byte-level CRLF -> LF. This mirrors what splitLines does to text,
    // so a signature built from these bytes answers exactly the question the
    // diff answers: "are the LINES the same?". It is what makes a pure
    // CRLF<->LF flip invisible for files whose content is not in memory —
    // without reading the file into memory to find out.
    function lfBytes(bytes) {
      let crlf = false
      for (let i = 0; i < bytes.length - 1; i++) {
        if (bytes[i] === 13 && bytes[i + 1] === 10) { crlf = true; break }
      }
      if (!crlf) return bytes
      const out = Buffer.allocUnsafe(bytes.length)
      let n = 0
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]
        if (b === 13 && i + 1 < bytes.length && bytes[i + 1] === 10) continue
        out[n++] = b
      }
      return n === bytes.length ? bytes : out.subarray(0, n)
    }
    // Two signatures are comparable only when they came from the same tier
    // (a sampled identity is a weaker claim than a full hash).
    function sameSig(a, b) {
      if (!a || !b) return false
      return a.tier === b.tier && a.n === b.n && a.h === b.h
    }
    // A signature over text that is already in memory. It MUST hash the same
    // bytes the streaming path hashes (LF-normalized UTF-8), or the two would
    // disagree about a file that merely crossed the in-memory window.
    function sigOfText(text) {
      const bytes = lfBytes(Buffer.from(text, 'utf8'))
      return { tier: SIG_TIERS.hash, n: bytes.length, h: createHash('sha1').update(bytes).digest('hex') }
    }
    // v1.31 content signature. `opts.digest` feeds every normalized chunk to a
    // caller-owned hash, `opts.writePath` mirrors them into a file — so ONE
    // streaming pass can produce the review verdict, the baseline blob and the
    // on-disk byte count together (that is how a large text baseline is
    // snapshotted for a later reject without a second read).
    //
    // Memory stays O(chunk): the run of \r bytes at a chunk boundary is held
    // back until the next chunk decides whether each is half of a CRLF pair,
    // because a naive per-chunk replace would miss (and corrupt) a CRLF that
    // straddles the seam.
    async function streamNormalized(target, opts) {
      const options = opts || {}
      const digest = options.digest
      const out = options.writePath !== undefined ? createWriteStream(options.writePath) : null
      // One error handler for the whole stream: re-attaching `once('error')` per
      // drain (the obvious shape) accumulates listeners and trips Node's
      // MaxListeners warning on a file with many chunks.
      let fail = null
      const onError = (e) => { fail = e || new Error('write failed') }
      if (out) {
        out.on('error', onError)
        await new Promise(function (res, rej) {
          out.once('open', res)
          out.once('error', rej)
        })
      }
      let carried = ''
      let n = 0
      const flush = async (s) => {
        n += Buffer.byteLength(s, 'utf8')
        if (!out) return
        if (out.write(s)) { if (fail) throw fail; return }
        await new Promise(function (res) { out.once('drain', res) })
        if (fail) throw fail
      }
      try {
        const stream = await fs.streamText(target)
        for await (const chunk of stream) {
          let text = carried + String(chunk)
          // Hold back a trailing CR run: it may be the first half of a CRLF.
          let end = text.length
          while (end > 0 && text.charCodeAt(end - 1) === 13) end--
          carried = text.slice(end)
          text = text.slice(0, end).replace(/\r\n/g, '\n')
          if (text === '') continue
          if (digest) digest.update(text)
          await flush(text)
        }
        // A file ending in a lone CR: it is content, not half of a CRLF pair.
        if (carried !== '') {
          if (digest) digest.update(carried)
          await flush(carried)
        }
        if (out) await new Promise(function (res) { out.end(function () { res() }) })
        if (fail) throw fail
      } catch (e) {
        // Never leave a half-written blob behind: it must not be mistaken for a
        // complete snapshot on the next run.
        if (out) { try { out.destroy() } catch (e2) {} }
        try { if (options.writePath !== undefined) rmSync(options.writePath, { force: true }) } catch (e3) {}
        throw e
      }
      return n
    }
    function joinPath(root, rel) {
      const sep = root.indexOf('\\') >= 0 ? '\\' : '/'
      return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep)
    }
    // Normalize a tool-provided path (write/edit `file_path`) to a workspace-
    // relative path. Absolute paths must live under the session root;
    // relative paths are cleaned (`./` stripped, backslashes unified) and
    // `..`/empty segments rejected. Returns null when the path cannot be
    // attributed to a workspace file (caller falls back to window mode).
    function normalizeRelPath(root, raw) {
      if (!root || typeof raw !== 'string' || raw === '') return null
      let p = raw.replace(/\\/g, '/')
      if (/^[A-Za-z]:\//.test(p) || p.startsWith('/')) {
        const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '')
        const cmp = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s
        if (cmp(p) === cmp(r)) p = ''
        else if (cmp(p).startsWith(cmp(r) + '/')) p = p.slice(r.length + 1)
        else return null
      } else {
        p = p.replace(/^\.\//, '')
      }
      if (p === '' || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return null
      return p
    }
    // v1.34 (F2): the ONE entry point for a client-supplied workspace path.
    // normalizeRelPath() already rejected absolute paths outside the root and
    // every '..' segment — it was simply never wired to the RPC surface, so
    // joinPath(root, path) resolved "../.." straight out of the workspace and a
    // write RPC could replace any file the process may write. That is reachable
    // by any local caller: the agent's own shell carries DSH_SESSION_ID and
    // DSH_WEB_URL, and the sandbox vocabulary is file effects only (network is
    // not confined), so the confined party can POST to this API itself.
    function relPathArg(st, args) {
      const raw = args && args.path !== undefined && args.path !== null ? String(args.path) : ''
      return st && st.root ? normalizeRelPath(st.root, raw) : null
    }
    function badPath() {
      return { ok: false, code: 'bad-path', message: '路径不在工作区内' }
    }
    // v1.34 (F7): the file TREE may browse any workspace DSH knows about, but not
    // an arbitrary absolute path. The root override used to skip the session and
    // the state entirely, so a caller with NO valid session could enumerate any
    // directory on the host (listDir({sessionId:'x', root:'C:\\'}) returned a
    // listing). The client only ever sends roots it got from ctx.workspaces, so
    // gating on the host-side registry keeps the feature intact.
    function workspaceRootsOf(ctxRef) {
      let reg
      try { reg = ctxRef.get('workspaceRegistry') } catch (e) { reg = undefined }
      if (!reg || typeof reg.list !== 'function') return null
      try {
        const out = []
        for (const w of reg.list()) {
          const p = w && w.path
          if (typeof p === 'string' && p !== '') out.push(p)
        }
        return out
      } catch (e) {
        return null
      }
    }
    function samePathKey(a, b) {
      return process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b)
    }
    // A root override is legitimate only for a LIVE session and (when the
    // deployment exposes the registry) for a root DSH itself registered. A
    // deployment without the registry degrades to the session requirement —
    // never back to "no check at all".
    async function allowRootOverride(ctxRef, sid, rootPath, sessionRoot) {
      const session = sessions.get(sid)
      if (!session) return { ok: false, error: 'session-not-found' }
      let want = rootPath
      try { want = (await fs.resolve(rootPath)).targetKey } catch (e) { want = rootPath }
      // The session's OWN workspace is always legitimate (a session may run in a
      // directory the registry has no record of). The header cwd is the
      // authority here — st.root is still null before the first scan, and
      // gating a tree request on scan state would break the first expansion.
      const ownRaw = (session.header && session.header.cwd) || sessionRoot
      if (ownRaw) {
        let own = ownRaw
        try { own = (await fs.resolve(ownRaw)).targetKey } catch (e) { own = ownRaw }
        if (samePathKey(own, want)) return { ok: true }
      }
      const roots = workspaceRootsOf(ctxRef)
      if (roots === null) return { ok: true }
      for (const p of roots) {
        let have = p
        try { have = (await fs.resolve(p)).targetKey } catch (e) { have = p }
        if (samePathKey(have, want)) return { ok: true }
      }
      return { ok: false, error: 'root-not-a-workspace' }
    }
    // ---------- precise path extraction from shell/pwsh/git commands (v1.18) ----------
    // The whole-workspace walk is reserved for the 20s failsafe and for
    // mutations whose file targets cannot be located. For the others we
    // extract the target paths from the command TEXT so the review state can
    // be refreshed per file. This is best-effort: anything ambiguous
    // (wildcards, `$` variables, cmd %vars%, unquoted weirdness, paths that
    // do not resolve under the workspace root) makes the extractor return
    // null and the caller fall back to the full scan — false fallbacks are
    // safe (one walk), false precision would silently miss agent changes.
    const PS_PARAM_RE = /-(?:Path|LiteralPath|FilePath|Destination|NewName)\s+((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')|[^\s;|&]+)/gi
    const PS_CMDLET_RE = /\b(?:Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Clear-Content|Tee-Object|Export-Csv|Export-Clixml|Set-Item|rm|rmdir|del)\b([^;|&]*)/gi
    // Direct .NET static file APIs (called without a PowerShell cmdlet). Their
    // path is the first positional argument; only the common single-target
    // forms are extracted, everything else falls back to the full walk.
    const DOTNET_FILE_RE = /(?:\[(?:System\.)?IO\.File\]::)?(WriteAllText|AppendAllText|WriteAllLines|WriteAllBytes|Delete)\s*\(\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')|[^\s,)]+)/gi
    // PowerShell value-taking parameters on the cmdlets above (a following
    // token is that flag's value, not a positional path); switches do not
    // consume a value. A flag outside both lists conservatively consumes its
    // next token (avoids misreading a value as a path).
    const PS_VALUE_FLAGS = new Set(['path', 'literalpath', 'filepath', 'destination', 'newname', 'value', 'itemtype', 'encoding', 'filter', 'include', 'exclude', 'name', 'indent', 'width', 'delimiter', 'noheader', 'inputobject'])
    const PS_SWITCHES = new Set(['force', 'recurse', 'confirm', 'whatif', 'append', 'noclobber', 'passthru', 'quiet', 'compress', 'verbose', 'debug'])
    function tokenizeWords(rest) {
      return String(rest || '').match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s]+/g) || []
    }
    function unquoteCmd(raw) {
      const s = String(raw || '').replace(/,$/, '')
      if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'")
      // v1.18: double-quoted strings are NOT backslash-escaped in PowerShell
      // (and in bash only quote/backslash/dollar/backtick are escaped). A
      // Windows path like "C:\Users\HW\...\x.py" must keep its backslashes —
      // the old `replace(/\\(.)/g, '$1')` corrupted it into "C:UsersHW...x.py"
      // so Set-Content/Add-Content with a quoted absolute path was never found.
      // Only unescape a literal escaped quote `\"`.
      if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1).replace(/\\"/g, '"')
      return s
    }
    function splitCommas(raw) {
      if (raw.length >= 2 && (raw[0] === "'" || raw[0] === '"') && raw[raw.length - 1] === raw[0]) return [raw]
      return String(raw).split(',')
    }
    // Validate one unquoted, comma-split token into a workspace-relative
    // path. Returns the rel path or null (suspect token: wildcard, variable,
    // empty, or outside the workspace root). Degenerate separators ('' or
    // ',') are SKIPPED by the callers, not treated as suspects.
    function cmdPathToRel(root, s) {
      if (s === '') return null
      // Trailing slashes (`rm -rf build/`) are directory noise, not path
      // segments; the backtick is PowerShell's escape character (a literal
      // backtick in a path is vanishingly rare, and misreading an escaped
      // token as a path would be a false-precision bug).
      s = s.replace(/\/+$/, '')
      if (s === '') return null
      if (/[*?[\]$%~`]/.test(s)) return null
      return normalizeRelPath(root, s)
    }
    // PowerShell forms: `-Path/-LiteralPath/-FilePath/-Destination/-NewName
    // <value>` plus positional tokens. Positional scanning skips a token
    // right after a value-taking flag (its value), and skips switch flags
    // entirely. Bash forms (rm/del/rmdir) never consume a value after a flag,
    // so every non-flag token is a target. Returns null when no target can be
    // reliably enumerated.
    function extractCommandPaths(cmd, root) {
      if (typeof cmd !== 'string' || cmd === '') return null
      const out = new Set()
      let m
      PS_PARAM_RE.lastIndex = 0
      while ((m = PS_PARAM_RE.exec(cmd))) {
        for (const part of splitCommas(m[1])) {
          const s = unquoteCmd(part)
          if (s === '' || s === ',') continue
          const rel = cmdPathToRel(root, s)
          if (!rel) return null
          out.add(rel)
        }
      }
      PS_CMDLET_RE.lastIndex = 0
      while ((m = PS_CMDLET_RE.exec(cmd))) {
        const name = m[0].split(/\s+/)[0].toLowerCase()
        const bashForm = name === 'rm' || name === 'rmdir' || name === 'del'
        const tokens = tokenizeWords(m[1])
        let i = 0
        while (i < tokens.length) {
          const raw = tokens[i]
          if (raw === '--') { i++; continue }
          const flag = /^[-/][A-Za-z]/.test(raw)
          if (flag) {
            if (!bashForm) {
              const flagName = raw.replace(/^[-/]/, '').toLowerCase()
              if (!PS_SWITCHES.has(flagName)) i++ // value-taking flag: skip its value
            }
            i++
            continue
          }
          for (const part of splitCommas(raw)) {
            const s = unquoteCmd(part)
            if (s === '' || s === ',') continue
            const rel = cmdPathToRel(root, s)
            if (!rel) return null
            out.add(rel)
          }
          i++
        }
      }
      return out.size > 0 ? out : null
    }
    // .NET static file APIs (no PowerShell cmdlet): the FIRST positional
    // argument is the target path for the single-target write/delete forms.
    // Copy/Move take source+destination and are left to the full-walk fallback
    // (extracting both and guessing which side changed would be false precision).
    function extractDotNetPaths(cmd, root) {
      if (typeof cmd !== 'string' || cmd === '') return null
      const out = new Set()
      let m
      DOTNET_FILE_RE.lastIndex = 0
      while ((m = DOTNET_FILE_RE.exec(cmd))) {
        const s = unquoteCmd(m[2])
        if (s === '' || s === ',') continue
        const rel = cmdPathToRel(root, s)
        if (!rel) return null
        out.add(rel)
      }
      return out.size > 0 ? out : null
    }
    // git worktree-mutating commands with explicit file targets:
    //   git rm|mv <path...>            — positional paths
    //   git checkout|co|restore|reset -- <path...>  — paths after `--`
    // Anything else (merge/rebase/pull/switch/clean/reset without `--`,
    // checkout without `--`, revisions as targets) returns null → fallback.
    function extractGitPaths(cmd, root) {
      if (typeof cmd !== 'string' || cmd === '') return null
      const m = /\bgit\s+(rm|mv|checkout|co|restore|reset)\b([^;|&]*)/i.exec(cmd)
      if (!m) return null
      const sub = m[1].toLowerCase()
      const rest = m[2]
      const out = new Set()
      let tokens
      if (sub === 'checkout' || sub === 'co' || sub === 'restore' || sub === 'reset') {
        // Paths come after a STANDALONE `--` separator. A `--` glued to a
        // flag (`git reset --hard`) is not a separator — `--hard` is the
        // reset mode, so no paths can be located → fallback.
        const sep = /(?:^|\s)--(?=\s|$)/.exec(rest)
        if (!sep) return null
        tokens = tokenizeWords(rest.slice(sep.index + sep[0].length))
      } else {
        tokens = tokenizeWords(rest)
      }
      for (const t of tokens) {
        if (/^[-/][A-Za-z]/.test(t)) continue
        for (const part of splitCommas(t)) {
          const s = unquoteCmd(part)
          if (s === '' || s === ',') continue
          const rel = cmdPathToRel(root, s)
          if (!rel) return null
          out.add(rel)
        }
      }
      return out.size > 0 ? out : null
    }
    // v1.9: markdown files get a full rendered view in the client. The flag
    // rides the entry so diffPayload can ship the whole document (no line
    // cap) without knowing the path at every call site.
    function isMarkdownPath(rel) {
      const base = String(rel || '').split('/').pop().toLowerCase()
      return base.endsWith('.md') || base.endsWith('.markdown')
    }
    function cloneEntry(e) {
      return { present: e.present, content: e.content, eol: e.eol, crlf: e.crlf === true, eolMap: e.eolMap ?? null, version: e.version, size: e.size, note: e.note, binRef: e.binRef ?? null, binSize: e.binSize ?? 0, md: e.md === true, sig: e.sig ?? null, trunc: e.trunc ?? null, baselineRef: e.baselineRef ?? null, baselineBytes: e.baselineBytes ?? 0 }
    }
    // "File was not in the baseline" as an explicit ABSENT entry instead of
    // null: every consumer (modifiedFiles / diffPayload / reject paths) then
    // treats it as a regular entry with present:false, which is what makes
    // newly created files render as one big "added" hunk and lets reject
    // restore the pre-file state (delete it).
    function absentEntry() {
      return { present: false, content: null, eol: false, crlf: false, eolMap: null, version: null, size: 0, note: undefined, binRef: null, binSize: 0, md: false, sig: null, trunc: null }
    }
    // Shared shape for "this file is gone" (deletion sweep, targeted refresh,
    // reject of a created file): one place to keep the entry fields in sync.
    // `note` stays undefined (unlike absentEntry, which is also the shape of a
    // never-baselined path) so the deleted branch of the payload — not a note —
    // is what renders it.
    function goneEntry() {
      return { present: false, content: null, eol: false, crlf: false, eolMap: null, version: null, size: 0, binRef: null, binSize: 0, md: false, sig: null, trunc: null }
    }

    // ---------- line diff (Myers + anchored fallback) ----------
    // v1.30: the Myers pass is bounded (time AND memory both grow with the
    // size of the trimmed region), so a change region bigger than this budget
    // is handed to the ANCHORED diff below instead of being reported as one
    // whole-region hunk — see diffRange for the bug that caused.
    const MYERS_MAX_SUM = 6000
    // Recursion ceiling for the anchored splitter. Each level either consumes
    // unique common lines (so the regions strictly shrink) or falls back to a
    // single hunk; the cap only exists so a pathological input cannot recurse
    // without bound.
    const ANCHOR_MAX_DEPTH = 32
    function myersOps(a, b) {
      const n = a.length, m = b.length
      let start = 0
      while (start < n && start < m && a[start] === b[start]) start++
      let endA = n, endB = m
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
      const na = endA - start, nb = endB - start
      if (na === 0 && nb === 0) return []
      if (na + nb > MYERS_MAX_SUM) return null
      const max = na + nb
      const MAX_D = Math.min(400, max)
      const v = new Array(2 * max + 1).fill(0)
      const trace = []
      let found = -1
      outer: for (let d = 0; d <= MAX_D; d++) {
        trace.push(v.slice())
        for (let k = -d; k <= d; k += 2) {
          const idx = k + max
          let x
          if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) x = v[idx + 1]
          else x = v[idx - 1] + 1
          let y = x - k
          while (x < na && y < nb && a[start + x] === b[start + y]) { x++; y++ }
          v[idx] = x
          if (x >= na && y >= nb) { found = d; break outer }
        }
      }
      if (found < 0) return null
      let x = na, y = nb
      const rev = []
      for (let d = found; d >= 0; d--) {
        const vp = trace[d]
        const k = x - y
        const idx = k + max
        let prevK
        if (k === -d || (k !== d && vp[idx - 1] < vp[idx + 1])) prevK = k + 1
        else prevK = k - 1
        const prevX = vp[prevK + max]
        const prevY = prevX - prevK
        while (x > prevX && y > prevY) { rev.push({ t: 'e', i: start + x - 1, j: start + y - 1 }); x--; y-- }
        if (d > 0) {
          if (x === prevX) rev.push({ t: 'i', j: start + prevY })
          else rev.push({ t: 'd', i: start + prevX })
        }
        x = prevX; y = prevY
      }
      rev.reverse()
      return rev
    }

    // Turn one Myers op stream into hunks. `ops` is relative to the slices it
    // was computed from, so every emitted coordinate is shifted back into the
    // full arrays by (aOff, bOff) — that is what lets the same routine serve
    // both the whole file and an anchored sub-region.
    function hunksFromOps(ops, b, out, aOff, bOff) {
      // Pure runs borrow the counterpart coordinate, corrected by the
      // CUMULATIVE shift accumulated from every earlier hunk (each prior
      // change moves the new file's indices by newLen − oldLen). The naive
      // mirror (newStart = oldStart) was only right for the FIRST hunk —
      // later pure hunks drifted by one per preceding change (live payload
      // with three deletions reported 101/197 instead of 100/195, which
      // also starved the last hunk of its trailing context block and broke
      // the jump caret chain). Op-derived coordinates (o.i/o.j) are already
      // absolute within the region and need no shift.
      let shift = 0
      let i = 0
      while (i < ops.length) {
        const op = ops[i]
        if (op.t === 'e') { i++; continue }
        const h = { oldStart: -1, oldLen: 0, newStart: -1, newLen: 0, newLines: [] }
        while (i < ops.length && ops[i].t !== 'e') {
          const o = ops[i]
          if (o.t === 'd') { if (h.oldStart < 0) h.oldStart = o.i; h.oldLen++ }
          else { if (h.newStart < 0) h.newStart = o.j; h.newLen++; h.newLines.push(b[o.j]) }
          i++
        }
        if (h.oldStart < 0) h.oldStart = h.newStart - shift
        if (h.newStart < 0) h.newStart = h.oldStart + shift
        shift += h.newLen - h.oldLen
        h.oldStart += aOff
        h.newStart += bOff
        out.push(h)
      }
    }

    // Anchors = lines that occur EXACTLY ONCE in both regions ("patience diff"
    // pivots). Such a pair provably matches, and the longest increasing
    // subsequence of the pairs keeps them in order, so the region can be split
    // at every anchor and each gap diffed on its own. This is what keeps a
    // hand-edited large file cheap: a couple of small edits far apart leave
    // thousands of unique lines between them, and those become anchors.
    function anchorPairs(a, b, aFrom, aTo, bFrom, bTo) {
      const ca = new Map()
      for (let i = aFrom; i < aTo; i++) { const k = a[i]; ca.set(k, (ca.get(k) || 0) + 1) }
      const cb = new Map()
      for (let j = bFrom; j < bTo; j++) { const k = b[j]; cb.set(k, (cb.get(k) || 0) + 1) }
      // Positions of the lines that are unique in BOTH regions — a Map lookup
      // instead of a scan per candidate (an indexOf in this loop made the pass
      // O(region²), which is exactly the size class this path exists for).
      const posB = new Map()
      for (let j = bFrom; j < bTo; j++) {
        const k = b[j]
        if (cb.get(k) === 1 && ca.get(k) === 1) posB.set(k, j)
      }
      const pairs = []
      for (let i = aFrom; i < aTo; i++) {
        const k = a[i]
        if (ca.get(k) !== 1 || cb.get(k) !== 1) continue
        pairs.push([i, posB.get(k)])
      }
      if (pairs.length === 0) return pairs
      // Longest increasing subsequence on the b-index (O(k log k)); `tail[t]`
      // is the smallest possible tail b-index of a length-(t+1) run, `prev`
      // threads the chain back together.
      const tail = []      // indexes INTO pairs
      const prev = new Array(pairs.length).fill(-1)
      for (let p = 0; p < pairs.length; p++) {
        let lo = 0, hi = tail.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (pairs[tail[mid]][1] < pairs[p][1]) lo = mid + 1
          else hi = mid
        }
        if (lo > 0) prev[p] = tail[lo - 1]
        tail[lo] = p
      }
      const chain = []
      for (let p = tail.length > 0 ? tail[tail.length - 1] : -1; p >= 0; p = prev[p]) chain.push(pairs[p])
      chain.reverse()
      return chain
    }

    // Diff one region [aFrom,aTo) × [bFrom,bTo). Shared prefix/suffix are
    // trimmed first, then the region is either small enough for exact Myers or
    // split at anchors. A region with no anchor at all (nothing in common, or
    // every line duplicated) is genuinely one replacement and is emitted as
    // one hunk — which is the ONLY case where a whole region is reported.
    function diffRange(a, b, aFrom, aTo, bFrom, bTo, out, depth) {
      const total = aTo - aFrom, btotal = bTo - bFrom
      let s = 0
      const lim = Math.min(total, btotal)
      while (s < lim && a[aFrom + s] === b[bFrom + s]) s++
      let na = total - s, nb = btotal - s
      while (na > 0 && nb > 0 && a[aFrom + s + na - 1] === b[bFrom + s + nb - 1]) { na--; nb-- }
      if (na === 0 && nb === 0) return
      const aStart = aFrom + s, bStart = bFrom + s
      if (na + nb <= MYERS_MAX_SUM) {
        const sa = a.slice(aStart, aStart + na)
        const sb = b.slice(bStart, bStart + nb)
        const ops = myersOps(sa, sb)
        if (ops !== null) { hunksFromOps(ops, sb, out, aStart, bStart); return }
      }
      if (depth < ANCHOR_MAX_DEPTH) {
        const anchors = anchorPairs(a, b, aStart, aStart + na, bStart, bStart + nb)
        if (anchors.length > 0) {
          let pa = aStart, pb = bStart
          for (const pair of anchors) {
            if (pair[0] > pa || pair[1] > pb) diffRange(a, b, pa, pair[0], pb, pair[1], out, depth + 1)
            pa = pair[0] + 1
            pb = pair[1] + 1
          }
          if (pa < aStart + na || pb < bStart + nb) diffRange(a, b, pa, aStart + na, pb, bStart + nb, out, depth + 1)
          return
        }
      }
      out.push({ oldStart: aStart, oldLen: na, newStart: bStart, newLen: nb, newLines: b.slice(bStart, bStart + nb) })
    }

    function computeHunks(a, b) {
      const hunks = []
      diffRange(a, b, 0, a.length, 0, b.length, hunks, 0)
      for (let k = 0; k < hunks.length; k++) hunks[k].id = 'h' + k
      return hunks
    }

    function mergeHunks(a, hunks, decisions) {
      const out = a.slice()
      for (let i = hunks.length - 1; i >= 0; i--) {
        const h = hunks[i]
        if (decisions.get(h.id) === 'reject') continue
        out.splice(h.oldStart, h.oldLen, ...h.newLines)
      }
      return out
    }

    // ---------- per-session state (with disk persistence) ----------
    function sidSafe(sid) {
      return sid.replace(/[^a-zA-Z0-9._-]/g, '_')
    }
    function stateFile(sid) {
      return join(STATE_DIR, sidSafe(sid) + '.json')
    }
    function undoRoot(sid) { return join(STATE_DIR, sidSafe(sid), 'undo') }
    function blobRoot(sid) { return join(STATE_DIR, sidSafe(sid), 'blobs') }
    function newUndoRec() {
      return { opId: 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), files: [] }
    }
    // Publish (or drop) the reject-undo record. A reject that produced no
    // backups must also clear a stale previous record, otherwise the undo
    // toast would revert an older operation than the one just performed.
    function commitUndo(st, rec) {
      const root = undoRoot(st.sid)
      if (!rec || rec.files.length === 0) {
        st.lastReject = null
        if (rec) { try { rmSync(join(root, rec.opId), { recursive: true, force: true }) } catch (e) {} }
        return
      }
      st.lastReject = { opId: rec.opId, ts: Date.now(), files: rec.files }
      // Single undo level: drop any older backup dirs for this session.
      try {
        if (existsSync(root)) {
          for (const name of readdirSync(root)) {
            if (name !== rec.opId) { try { rmSync(join(root, name), { recursive: true, force: true }) } catch (e) {} }
          }
        }
      } catch (e) {}
    }
    // v1.32.3 PERF: two things made persistence the last real stall of the DIFF
    // feature on a big workspace, and both are fixed here.
    //
    //  * The payload is built ONCE per generation (`files` object + JSON text)
    //    and NEVER on the event loop in a blocking write. v1.18 already moved the
    //    serialize behind a 250ms debounce, but the write itself stayed
    //    `writeFileSync`: on the real module-one session (34,252 entries, 263MB
    //    state, 83MB of JSON) that is a ~130ms synchronous write plus a ~195ms
    //    JSON.stringify, i.e. ~350ms during which the whole plugin — and every
    //    other request the DSH web server is serving — is frozen. The write now
    //    goes through an ordered per-session async queue with a temp-file +
    //    rename (atomic, so a crash mid-write can never leave a truncated state).
    //
    //  * A save whose content is IDENTICAL to what is already on disk is skipped.
    //    The debounced path is reached by read-driven flows too (a scan that only
    //    bumped a version, an accept that folded to the same bytes), and
    //    re-serializing ~83MB for an unchanged map is pure waste. The stamp is a
    //    cheap fingerprint of the persisted payload, so a false "unchanged" is
    //    impossible: any differing entry changes at least one component.
    const saveChain = new Map()   // sid -> Promise (ordered writes per session)
    const lastSaveStamp = new Map() // sid -> { stamp, bytes }
    // The fingerprint covers everything the payload carries: the file set, each
    // entry's revision + decision count, and the undo record. Note that the two
    // blob markers (`baselineRef`, `binRef`) are mutated in place WITHOUT a rev
    // bump by the snapshot helpers, so their presence is folded in separately —
    // otherwise a blob that just became restorable would look "unchanged".
    function stateStamp(st) {
      let h = 2166136261
      let refs = 0
      let noteLarge = 0
      const mix = (n) => { h ^= (n | 0); h = Math.imul(h, 16777619) }
      mix(st.files.size)
      for (const entry of st.files) {
        const f = entry[1]
        mix(f.rev)
        mix(f.decisions.size)
        if (f.base && (f.base.binRef || f.base.baselineRef)) refs++
        if (f.cur && (f.cur.binRef || f.cur.baselineRef)) refs++
        if (f.cur && f.cur.content === null) noteLarge++
        const name = entry[0]
        for (let i = 0; i < name.length; i++) mix(name.charCodeAt(i))
      }
      mix(refs)
      mix(noteLarge)
      mix(st.baseReady ? 1 : 0)
      mix(st.lastReject ? (st.lastReject.files ? st.lastReject.files.length : 0) + 1 : 0)
      if (st.root) for (let i = 0; i < st.root.length; i++) mix(st.root.charCodeAt(i))
      return (h >>> 0).toString(36)
    }
    // Build the persisted payload. Split out so the synchronous (force/teardown)
    // path and the queued path serialize exactly the same thing.
    function statePayload(st) {
      const files = {}
      for (const entry of st.files) {
        const base = entry[1].base
        const cur = entry[1].cur
        // v1.18: a clean file needs only its baseline persisted — loadState
        // reconstructs cur as a clone of it. Big workspaces (15K entries,
        // BM_automation) used to serialize EVERY file's content twice;
        // halving the state blob is what makes per-file accept/reject saves
        // tolerable on the debounced path. v1.29: "clean" is entrySame, the
        // same content-first rule the review itself uses (an EOL-only flip is
        // clean even though its version token moved). v1.32.3: with the
        // identity fast path in entrySame this is now O(1) for the dominant
        // case (base === cur), which is most of the map.
        const redundantCur = entrySame(base, cur)
        files[entry[0]] = {
          base: base,
          cur: redundantCur ? undefined : cur,
          rev: entry[1].rev,
          decisions: Object.fromEntries(entry[1].decisions),
        }
      }
      return { root: st.root, baseReady: st.baseReady, files, lastReject: st.lastReject ?? null }
    }
    // GC: drop blob files no longer referenced by any entry. Two kinds live
    // here: binary snapshots (binRef) and v1.31 large-TEXT baseline snapshots
    // (baselineRef, what makes a big text file rejectable without keeping its
    // content in memory).
    function gcBlobs(st) {
      try {
        const dir = blobRoot(st.sid)
        if (!existsSync(dir)) return
        const refs = new Set()
        for (const entry of st.files) {
          const f = entry[1]
          if (f.base && f.base.binRef) refs.add(f.base.binRef)
          if (f.cur && f.cur.binRef) refs.add(f.cur.binRef)
          if (f.base && f.base.baselineRef) refs.add(f.base.baselineRef)
          if (f.cur && f.cur.baselineRef) refs.add(f.cur.baselineRef)
        }
        for (const name of readdirSync(dir)) {
          if (!refs.has(name)) { try { rmSync(join(dir, name), { force: true }) } catch (e) {} }
        }
      } catch (e) {}
    }
    // Hand the JSON payload to the session's write queue. Writes are serialized
    // per session (a temp file can only hold one generation at a time) and the
    // LAST queued generation always wins, so a burst of accepts costs one rename.
    // `after` runs once this generation is on disk (the blob GC rides it so the
    // 21K-file readdir never shares a tick with a user-visible RPC).
    //
    // A payload is an ARRAY of string pieces, never one concatenated string:
    // `parts.join('')` over the 600-odd serialization batches copies the whole
    // 244MB payload into a fresh flat string (~75ms of straight CPU), and the
    // first chunked `slice()` of that rope then flattens it a second time.
    // Writing the pieces as they are skips both copies — same bytes on disk.
    function payloadChars(payload) {
      if (typeof payload === 'string') return payload.length
      let n = 0
      for (const p of payload) n += p.length
      return n
    }
    // Small payloads still go through the same temp+rename discipline (the write
    // itself is one call, so it cannot be interrupted by the event loop).
    function writeJsonSync(tmp, file, payload) {
      writeFileSync(tmp, typeof payload === 'string' ? payload : payload.join(''))
      renameSync(tmp, file)
    }
    // v1.32.3 FIX (data loss): every chunk must be appended at the CURRENT file
    // offset. `fh.write(text, 0, 'utf8')` is the string overload's
    // `(position, encoding)` form, and that 0 is an ABSOLUTE offset — so each
    // chunk overwrote the file from byte 0 and the renamed file kept only the
    // LAST chunk. That is exactly how a complete 263MB state became a 4.6MB
    // fragment on disk while every "saved" check still passed (they were reading
    // the untouched previous file). `null` means "append at the current offset".
    //
    // v1.32.3 PERF: the loop also yields explicitly on a time budget. Awaiting
    // `fh.write` is not guaranteed to hand the loop back to its timer phase, and
    // on the real 263MB state the whole 3.6s write ran without a single timer
    // tick. The yield bounds the damage to one chunk per turn.
    const WRITE_CHUNK_CHARS = 1024 * 1024
    const WRITE_YIELD_MS = 4
    async function writeJsonAtomic(tmp, file, payload) {
      const pieces = typeof payload === 'string' ? [payload] : payload
      const fh = await openP(tmp, 'w')
      try {
        let yieldAt = performance.now() + WRITE_YIELD_MS
        for (const piece of pieces) {
          if (piece.length <= WRITE_CHUNK_CHARS) {
            await fh.write(piece, null, 'utf8')
            if (performance.now() >= yieldAt) { yieldAt = performance.now() + WRITE_YIELD_MS; await new Promise((r) => setImmediate(r)) }
            continue
          }
          for (let i = 0; i < piece.length; i += WRITE_CHUNK_CHARS) {
            await fh.write(piece.slice(i, i + WRITE_CHUNK_CHARS), null, 'utf8')
            if (performance.now() >= yieldAt) { yieldAt = performance.now() + WRITE_YIELD_MS; await new Promise((r) => setImmediate(r)) }
          }
        }
        // fsync before the handle closes. Without it a crash can leave the
        // RENAMED file full of zeros (or short) even though the rename itself
        // was atomic — the failure mode that produced a truncated state file.
        await fh.datasync()
      } catch (e) {
        try { await fh.close() } catch (e2) {}
        throw e
      }
      await fh.close()
      // Atomic publish: a crash (or a kill) mid-write leaves the previous
      // complete state in place instead of a truncated file.
      renameSync(tmp, file)
    }
    function enqueueStateWrite(st, payload, after) {
      const sid = st.sid
      const file = stateFile(sid)
      // One temp name per queued generation: two in-flight payloads must never
      // share a file, or the abandoned one could tear the winner's write.
      const tmp = file + '.' + process.pid + '.' + (writeSeq++) + '.tmp'
      const prev = saveChain.get(sid) || Promise.resolve()
      const next = prev
        .then(() => {
          // Superseded by the synchronous path (reject / teardown flush): that
          // write is the newer, authoritative one — never publish this older
          // payload on top of it, and never leave its temp file behind.
          if (abandonedSaves.has(sid)) return
          return writeJsonAtomic(tmp, file, payload).then(() => { if (after) after() })
        })
        .catch((e) => {
          try { rmSync(tmp, { force: true }) } catch (e2) {}
          console.error('[dsh-file-edit] async saveState failed:', e && e.message ? e.message : e)
        })
      abandonedSaves.delete(sid)
      saveChain.set(sid, next)
      return next
    }
    let writeSeq = 0
    const abandonedSaves = new Set()
    // The synchronous variant: only for the paths that must be durable BEFORE
    // the call returns (reject / undo-reject, whose undo record is the whole
    // point, and the teardown flush).
    //
    // v1.32.3 CRASH SAFETY: this used to write the LIVE state file directly with
    // `writeFileSync`. A 263MB write takes tens of milliseconds, and the process
    // can die inside it (an OOM kill, a Ctrl+C, a Windows termination): the
    // result is a truncated file that is not JSON at all, i.e. the session loses
    // its entire review baseline — the exact failure observed in the wild
    // (session-171ba65f…, 263MB reduced to a 4.5MB fragment). Every path now
    // writes a temp file and renames it over the target, so the worst case is
    // "the previous complete state survives".
    function saveStateSync(st, payload) {
      const sid = st.sid
      const file = stateFile(sid)
      const tmp = file + '.' + process.pid + '.' + (writeSeq++) + '.tmp'
      try {
        // The direct write is the FINAL word: abandon the run's temp file before
        // writing, and mark the chain so a queued (now older) payload is dropped
        // instead of resurrecting pre-teardown state after the flush.
        const run = st.saveRun
        if (run && run.active) {
          run.active = false
          if (st.saveRun === run) st.saveRun = null
        }
        if (saveChain.has(sid)) { saveChain.delete(sid); abandonedSaves.add(sid) }
        writeJsonSync(tmp, file, JSON.stringify(payload))
        lastSaveStamp.set(sid, { stamp: stateStamp(st) })
        gcBlobs(st)
      } catch (e) {
        try { rmSync(tmp, { force: true }) } catch (e2) {}
        console.error('[dsh-file-edit] saveState failed:', e)
      }
    }
    // v1.32.3 PERF: the debounced save builds its JSON text in TIME-SLICED
    // CHUNKS. `JSON.stringify` over the whole 83MB payload is ~200ms of straight
    // CPU, and it was the last thing in this plugin that could park the event
    // loop long enough to be felt as a freeze (it runs ~250ms after every accept,
    // i.e. right when the user is looking at the result). Each chunk serializes
    // its own entries with the native stringifier (so the bytes are identical to
    // the single-pass result) and the run yields as soon as it has spent ~6ms.
    //
    // Consistency: entries are read from the LIVE map, so a payload is only
    // complete if the map did not change shape while the run was in flight. The
    // entry count is the cheap witness of that (entry REVISIONS only move from a
    // mutation, and the debounce already guarantees the run starts after the
    // mutation that triggered it), and a mismatch simply restarts the run against
    // the newer map — after this run's write, so the newest state always wins.
    const SAVE_CHUNK_MS = 6
    function saveRunActive(st) {
      return !!(st.saveRun && st.saveRun.active)
    }
    function finishSaveRun(st, run) {
      if (!run.active) return
      run.active = false
      if (st.saveRun === run) st.saveRun = null
      if (st.files.size !== run.keys.length) {
        // The file set moved under the run: throw this payload away and
        // re-serialize the newer map.
        st.saveDirty = false
        return
      }
      // The payload stays an ARRAY of pieces all the way to the writer: joining
      // the ~600 serialization batches into one 244MB string is ~75ms of
      // straight CPU, and the first chunked `slice()` of that rope then flattens
      // it a second time. Handing the pieces over skips both copies.
      const parts = run.parts.concat([run.tail])
      // The stamp is taken here, immediately after the last chunk: anything a
      // chunk already captured is in this payload, so a mutation during the run
      // is never lost (its entry is serialized from the live object).
      lastSaveStamp.set(st.sid, { stamp: stateStamp(st) })
      st.saveDirty = false
      const gen = st.saveGen || 0
      void enqueueStateWrite(st, parts, () => gcBlobs(st)).then(() => {
        // A mutation landed while this run serialized: persist it too.
        if ((st.saveGen || 0) !== gen && !saveRunActive(st)) void startSaveRun(st)
      })
    }
    const SAVE_BATCH_PARTS = 64
    function stepSaveRun(st, run) {
      return new Promise((resolve) => {
        setImmediate(() => {
          if (!run.active) { resolve(); return }
          try {
            const t0 = performance.now()
            // Entries accumulate in a small batch first: one `join` per batch
            // keeps `run.parts` at a few hundred elements instead of 34K, which
            // is what makes the final concatenation cheap.
            const batch = []
            for (;;) {
              if (run.i >= run.keys.length) {
                if (batch.length > 0) run.parts.push(batch.join(''))
                finishSaveRun(st, run)
                resolve()
                return
              }
              const key = run.keys[run.i++]
              const f = st.files.get(key)
              // The entry vanished from the map mid-run: it must not be written
              // (the restart above re-serializes the newer map).
              if (!f) continue
              if (f.base === undefined && f.cur === undefined) continue
              batch.push((run.count === 0 ? '' : ',') + JSON.stringify(key) + ':' + JSON.stringify({
                base: f.base,
                cur: entrySame(f.base, f.cur) ? undefined : f.cur,
                rev: f.rev,
                decisions: Object.fromEntries(f.decisions),
              }))
              run.count++
              if (batch.length >= SAVE_BATCH_PARTS) {
                run.parts.push(batch.join(''))
                batch.length = 0
              }
              // v1.32.3: the budget is checked after EVERY entry, not every N.
              // One 18MB entry (drawingfile_ie.js) is a ~100ms JSON.stringify on
              // its own, so a 256-entry granularity never looked at the clock
              // before a whole chunk was already spent; now a heavy entry yields
              // immediately instead of sharing its tick with the next ones.
              if (performance.now() - t0 >= SAVE_CHUNK_MS) {
                if (batch.length > 0) { run.parts.push(batch.join('')); batch.length = 0 }
                stepSaveRun(st, run).then(resolve)
                return
              }
            }
          } catch (e) {
            run.active = false
            if (st.saveRun === run) st.saveRun = null
            console.error('[dsh-file-edit] saveState failed:', e)
            resolve()
          }
        })
      })
    }
    function startSaveRun(st) {
      // {"root":…,"baseReady":…  +  ,"files":{  +  <entries>  +  },"lastReject":…}
      const head = JSON.stringify({ root: st.root ?? null, baseReady: st.baseReady === true }).slice(0, -1)
      const run = {
        active: true,
        keys: Array.from(st.files.keys()),
        i: 0,
        count: 0,
        parts: [head, ',"files":{'],
        tail: '},"lastReject":' + JSON.stringify(st.lastReject ?? null) + '}',
      }
      st.saveRun = run
      st.saveGen = st.saveGen || 0
      return stepSaveRun(st, run)
    }
    // v1.32.3: `opts.force` keeps the OLD blocking semantics for the destructive
    // paths (their undo record is the whole point); the debounced path slices the
    // serialization and writes asynchronously, so the RPC that asked for the save
    // has long returned and the event loop is never parked on 80MB+ of JSON.
    function saveState(st, opts) {
      try {
        const force = !!(opts && opts.force)
        // A save run already in flight for this session persists a NEWER map than
        // a second run started now would — never run two at once.
        if (!force && saveRunActive(st)) return
        const stamp = stateStamp(st)
        const last = lastSaveStamp.get(st.sid)
        // Nothing the payload would carry has changed since the last save.
        if (!force && last && last.stamp === stamp) return
        if (force) { saveStateSync(st, statePayload(st)); return }
        void startSaveRun(st)
      } catch (e) {
        console.error('[dsh-file-edit] saveState failed:', e)
      }
    }
    // v1.18: state saves are DEBOUNCED (250ms per session). Serializing the
    // whole review map can take seconds on big workspaces; a user clicking
    // accept on several files in a row (or accept-all) must not block on a
    // full JSON.stringify per click — one save after the burst covers them
    // all, and the RPC response is sent before the timer fires. Destructive
    // paths (reject / undo-reject / hunk-reject) pass force=true: their undo
    // records must hit disk immediately. The teardown effect flushes any
    // pending save so a stop/update cannot drop the last accept.
    // v1.32.3: force now means "write synchronously BEFORE returning" (the old
    // behaviour, kept for the destructive paths); the debounced path serializes
    // once and hands the text to the async write queue.
    const saveTimers = new Map()
    function scheduleSave(st, force) {
      const sid = st.sid
      const existing = saveTimers.get(sid)
      if (existing) { clearTimeout(existing.t); saveTimers.delete(sid) }
      if (force) { saveState(st, { force: true }); return }
      saveTimers.set(sid, { st: st, t: setTimeout(() => { saveTimers.delete(sid); saveState(st) }, 250) })
    }
    // v1.32.3 CRASH RECOVERY: a state file that cannot be parsed used to be
    // swallowed by this catch, so a truncated/corrupt file silently started the
    // session from an EMPTY map — the review pane then showed nothing (or a
    // full-workspace "everything changed") with no explanation, and the first
    // save overwrote the evidence. Now the bad file is QUARANTINED (renamed
    // aside, never deleted) and the failure is reported, so the next save
    // rebuilds a clean baseline from disk instead of looping on the same parse
    // error. Written atomically by saveState, so a corrupt file now means real
    // damage (a killed process, a bad disk) rather than a normal crash.
    function quarantineStateFile(sid, why) {
      try {
        const from = stateFile(sid)
        if (!existsSync(from)) return null
        const to = from + '.corrupt-' + Date.now()
        renameSync(from, to)
        console.error('[dsh-file-edit] state file was not readable (' + why + '); moved aside to ' + to)
        return to
      } catch (e) {
        console.error('[dsh-file-edit] could not quarantine the unreadable state file:', e && e.message ? e.message : e)
        return null
      }
    }
    function loadState(sid) {
      let raw
      try {
        raw = readFileSync(stateFile(sid), 'utf8')
      } catch (e) {
        // No state yet is NORMAL (first run of a session), not damage.
        return null
      }
      let data
      try {
        data = JSON.parse(raw)
      } catch (e) {
        quarantineStateFile(sid, e && e.message ? e.message : String(e))
        return null
      }
      try {
        if (!data || typeof data !== 'object') {
          quarantineStateFile(sid, 'not a JSON object')
          return null
        }
        const files = new Map()
        for (const key of Object.keys(data.files ?? {})) {
          const f = data.files[key]
          // Heal legacy states: base === null meant "not in baseline" but
          // every consumer expected a present:false entry.
          const base = f.base ?? absentEntry()
          if (base.crlf === undefined) base.crlf = false
          if (typeof base.binRef !== 'string') base.binRef = null
          // v1.33: a legacy (pre-eolMap) state simply has no per-line EOL map;
          // null is the "uniform file" answer and keeps the legacy write path.
          if (typeof base.eolMap !== 'string') base.eolMap = null
          // v1.18: clean files persist only their baseline; reconstruct the
          // redundant cur as a clone of it.
          const cur = f.cur ?? (base ? cloneEntry(base) : null)
          if (cur && cur.crlf === undefined) cur.crlf = false
          if (cur && typeof cur.binRef !== 'string') cur.binRef = null
          if (cur && typeof cur.eolMap !== 'string') cur.eolMap = null
          files.set(key, {
            base: base,
            cur: cur,
            rev: f.rev ?? 0,
            decisions: new Map(Object.entries(f.decisions ?? {})),
          })
        }
        const lr = data.lastReject
        const lastReject = lr && typeof lr.opId === 'string' && Array.isArray(lr.files)
          ? { opId: lr.opId, ts: lr.ts ?? 0, files: lr.files }
          : null
        return { root: data.root ?? null, baseReady: data.baseReady === true, files, lastReject }
      } catch (e) {
        // Parsed but structurally unusable: same treatment as unparseable.
        quarantineStateFile(sid, 'unusable structure: ' + (e && e.message ? e.message : String(e)))
        return null
      }
    }

    function bumpTree(st) { st.treeStamp = (st.treeStamp || 0) + 1 }

    function newState(sid) {
      const restored = loadState(sid)
      return {
        sid,
        root: restored?.root ?? null, policy: null, error: null,
        files: restored?.files ?? new Map(),
        scanning: null, dirty: false, scannedAt: 0,
        baseReady: restored?.baseReady ?? false,
        lastReject: restored?.lastReject ?? null,
        // v1.8 change attribution (direction B): the review covers changes
        // that flowed through the AGENT's tool channel, not the file system
        // as a whole. `touched` = explicit paths from write/edit tool calls
        // that the next scan should review; `shellWindow` = an opaque shell/
        // pwsh command ran, so every non-pending change found by the next
        // scan is conservatively attributed to it. Both are process-local
        // (persisting attribution across restarts would be wrong: a fresh
        // page/turn should not re-review already-folded user files).
        touched: new Set(),
        // v1.33 (F1): paths the write tool itself reported as `operation:
        // 'create'`. Positive proof of "the AGENT created this file", which is
        // the ONLY condition under which a reject may delete a file (see
        // doReject / assertDeletable). Process-local on purpose, like `touched`:
        // after a restart the proof is gone and reject refuses instead of
        // destroying a file whose pre-image was never observed.
        created: new Set(),
        shellWindow: false,
        // v1.18 precise DIFF refresh: `pendingTargets` is either a Set of
        // workspace-relative paths the next resolution should refresh
        // per-file (write/edit, or a shell/git command whose targets we could
        // extract), or null = the mutation could NOT be located precisely and
        // the next resolution must run the full walk (fallback). `targetTask`
        // dedups concurrent targeted refreshes (mirror of `scanning`).
        pendingTargets: new Set(),
        targetTask: null,
        // v1.18: git index-only commands (add/commit/init) change no worktree
        // byte, so they must not dirty the session — but the client still
        // needs to reload the tree (VCS badges re-ask git). getModified
        // consumes this flag without scanning.
        treeDirty: false,
        // Monotonic counter bumped by every mutating tool result. The scan
        // snapshots it at entry and clears `dirty` only when no mutation
        // landed mid-scan (a mid-scan write must not be swallowed by the
        // scan's own dirty=false).
        mutationStamp: 0,
        // Monotonic per-session notification counter: bumped whenever the FILE
        // SET (not just content) changed. The client polls it via getModified
        // and reloads the sidebar file tree on change. Process-local only —
        // persistence is unnecessary (a fresh page reload re-fetches the tree).
        treeStamp: 0,
      }
    }
    const states = new Map()
    function stateFor(sid) {
      let s = states.get(sid)
      if (!s) { s = newState(sid); states.set(sid, s) }
      return s
    }

    // ---------- long-poll change wake-ups ----------
    // The client polls getModified every 6s as its fallback, but an agent
    // tool result only SETS the dirty flag — diff stats then lag until the
    // next poll. These waiters let a long-polled `wait` request resolve the
    // moment a mutation event lands (bursts are coalesced by a short timer),
    // so the client refreshes the stats immediately.
    const waiters = new Map()
    function notify(sid) {
      const set = waiters.get(sid)
      if (set && set.size > 0) {
        waiters.delete(sid)
        for (const resolve of set) { try { resolve({ ok: true, changed: true }) } catch (e) {} }
      }
      // v1.13.3: SSE push channel. The long-poll wait chain has proven
      // unreliable in the real browser (its self-managed loop can silently
      // die), so every wake also broadcasts to connected EventSource clients.
      // EventSource reconnects natively — nothing of ours has to stay alive.
      const sse = sseClients.get(sid)
      if (sse && sse.size > 0) {
        for (const res of sse) { try { res.write('data: changed\n\n') } catch (e) {} }
      }
    }
    const notifyTimers = new Map()
    function scheduleNotify(sid, delay) {
      const existing = notifyTimers.get(sid)
      if (existing) clearTimeout(existing)
      notifyTimers.set(sid, setTimeout(() => { notifyTimers.delete(sid); notify(sid) }, delay))
    }

    // ---------- SSE push channel ----------
    // GET /dsh-file-edit/events?sessionId=... holds a text/event-stream
    // connection; every coalesced mutation wake writes one `data: changed`
    // frame. Pattern mirrors the harness's own HMR SSE route
    // (packages/client/hmr): comment ping on connect, per-res close cleanup,
    // destroy on teardown.
    const sseClients = new Map()
    function handleSse(req, res) {
      let sid = ''
      try {
        const u = new URL(req.url, 'http://localhost')
        sid = u.searchParams.get('sessionId') || ''
      } catch (e) {}
      if (!sid) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'no-session' }))
        return
      }
      // The connection itself proves this session is being watched: register
      // it so tools/result wakes are not dropped for pages that have not
      // issued an API call yet.
      knownSessions.add(sid)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      try { res.write(': connected\n\n') } catch (e) {}
      let set = sseClients.get(sid)
      if (!set) { set = new Set(); sseClients.set(sid, set) }
      set.add(res)
      const cleanup = () => {
        clearInterval(hb)
        const s = sseClients.get(sid)
        if (s) { s.delete(res); if (s.size === 0) sseClients.delete(sid) }
      }
      // Heartbeat: keep proxies/browsers from closing an idle stream, and
      // surface dead sockets (the write throw routes into cleanup).
      const hb = setInterval(() => {
        try { res.write(': ping\n\n') } catch (e) { cleanup() }
      }, 20000)
      let closed = false
      const onClose = () => { if (!closed) { closed = true; cleanup() } }
      try { req.on('close', onClose) } catch (e) {}
      try { res.on('close', onClose) } catch (e) {}
    }
    function requireState(args) {
      const sid = args && args.sessionId ? String(args.sessionId) : ''
      if (!sid) return null
      knownSessions.add(sid)
      return stateFor(sid)
    }
    function resolveSession(sid) {
      const session = sessions.get(sid)
      if (!session) return { error: 'session-not-found' }
      const cwd = session.header && session.header.cwd
      if (!cwd) return { error: 'no-workspace' }
      // Policy resolution must never take the scan down: a transient policy
      // failure is a retryable scan error, not a fatal one.
      let policy
      try { policy = sandboxPolicy.resolve({ session }) } catch (e) { policy = {} }
      return { session, policy, root: cwd }
    }

    // ---------- scanning ----------
    // v1.31 content signature for an entry whose content is NOT (or must not
    // be) held in memory. Returns { sig, trunc } — `sig` is a real
    // LF-normalized content hash (comparable to any text content), `trunc` is
    // the last-resort sampled identity used only past MAX_SIG_BYTES, where a
    // full pass would mean reading gigabytes on every poll.
    async function sigFor(target, size) {
      if (size <= MAX_SIG_BYTES) {
        try {
          const digest = createHash('sha1')
          const n = await streamNormalized(target, { digest: digest })
          return { sig: { tier: SIG_TIERS.hash, n: n, h: digest.digest('hex') }, trunc: null }
        } catch (e) {
          // No streaming backend (or an unreadable file): fall through to the
          // sampled identity rather than claiming a content verdict we cannot
          // support.
        }
      }
      try {
        const want = SIG_SAMPLE_READ_BYTES
        const parts = []
        const push = (bytes) => { if (bytes && bytes.length) parts.push(lfBytes(bytes)) }
        push(await fs.readByteRange(target, { offset: 0, length: want }))
        const mid = Math.max(0, Math.floor(size / 2) - Math.floor(SIG_SAMPLE_BYTES / 2))
        push(await fs.readByteRange(target, { offset: mid, length: want }))
        push(await fs.readByteRange(target, { offset: Math.max(0, size - SIG_SAMPLE_BYTES), length: want }))
        const digest = createHash('sha1')
        for (const p of parts) digest.update(p)
        return { sig: null, trunc: { tier: SIG_TIERS.sampled, n: size, h: digest.digest('hex') } }
      } catch (e) {
        return { sig: null, trunc: null }
      }
    }
    // Baseline snapshot for a large TEXT file (the fingerprint tier): the
    // normalized content goes into the blob dir so a later reject can restore
    // it byte-for-byte. Returns { sig, ref, bytes } or null.
    async function snapshotText(st, rel, target, size) {
      if (size > MAX_SIG_BYTES) return null
      try {
        const ref = createHash('sha1').update(rel).update(String(size)).update(String(Date.now())).digest('hex')
        const dir = blobRoot(st.sid)
        mkdirSync(dir, { recursive: true })
        const blobPath = join(dir, ref)
        const digest = createHash('sha1')
        const n = await streamNormalized(target, { digest: digest, writePath: blobPath })
        return { sig: { tier: SIG_TIERS.hash, n: n, h: digest.digest('hex') }, ref: ref, bytes: n }
      } catch (e) {
        return null
      }
    }
    // v1.31: a text baseline that is too large to keep in memory still has to be
    // RESTORABLE (拒绝 = write the baseline back). One streaming pass mirrors its
    // normalized bytes into the session blob dir, so reject reads that file
    // instead of needing `base.content`. Only ever called when an entry BECOMES
    // a baseline (never for `cur`), and never overwrites an existing snapshot —
    // the baseline object is often mutated in place (`f.base.size = …`), which
    // v1.31: normalized bytes of a baseline that was read as CONTENT and is worth
    // preserving (>= MAX_CONTENT_BYTES). Keyed by the entry's own fingerprint and
    // written the moment the entry becomes a baseline, so the snapshot can never
    // observe a later write to the file. Bounded by the review set: only the
    // current baseline of each large file is held, and by exactly one generation.
    const baselineBufs = new Map()
    function bufferBaseline(entry) {
      if (!entry || !entry.present || !entry.sig || entry.baselineRef || entry.content === null) return
      if (entry.sig.tier !== SIG_TIERS.hash || entry.size > MAX_SIG_BYTES) return
      if (baselineBufs.has(entry.sig.h)) return
      baselineBufs.set(entry.sig.h, Buffer.from(entry.content, 'utf8'))
    }
    // must not invalidate its blob.
    async function blobSnapshot(st, rel, entry) {
      if (!entry || !entry.present || !entry.sig || entry.baselineRef) return false
      if (entry.size > MAX_SIG_BYTES || entry.sig.tier !== SIG_TIERS.hash) return false
      if (entry.syncing) return false
      entry.syncing = true
      const done = (ok) => { entry.syncing = false; return ok }
      try {
        const dir = blobRoot(st.sid)
        mkdirSync(dir, { recursive: true })
        const ref = createHash('sha1').update('base\u0001').update(rel).update(entry.sig.h).digest('hex')
        const blobPath = join(dir, ref)
        if (existsSync(blobPath)) {
          entry.baselineRef = ref
          entry.baselineBytes = entry.sig.n
          return done(true)
        }
        // Prefer the bytes captured at baseline time (race-free by construction).
        const held = baselineBufs.get(entry.sig.h)
        if (held) {
          if (held.length !== entry.sig.n) return done(false)
          writeBytesAtomicSync(blobPath, held)
          entry.baselineRef = ref
          entry.baselineBytes = entry.sig.n
          return done(true)
        }
        // No captured copy (e.g. the state was restored from disk, or the
        // baseline predates this version): stream the file and VERIFY it against
        // the fingerprint — a mismatch means the file already moved on, and a
        // snapshot that does not match the baseline must never be kept.
        const target = await fs.resolve(joinPath(st.root, rel))
        const digest = createHash('sha1')
        const n = await streamNormalized(target, { digest: digest, writePath: blobPath })
        if (n !== entry.sig.n || digest.digest('hex') !== entry.sig.h) {
          try { rmSync(blobPath, { force: true }) } catch (e) {}
          return done(false)
        }
        entry.baselineRef = ref
        entry.baselineBytes = entry.sig.n
        return done(true)
      } catch (e) {
        return done(false)
      }
    }
    // v1.31: `prev` lets an unchanged file (same stat identity) skip the whole
    // read — including the streaming signature pass. Content is read for
    // anything up to MAX_SIG_BYTES; past that only a stat identity is kept, so
    // the workspace scan never holds a large file's text in memory.
    async function loadFileEntry(st, rel, prev) {
      const md = isMarkdownPath(rel)
      const target = await fs.resolve(joinPath(st.root, rel))
      let info
      try { info = await fs.stat(target) } catch (e) { info = undefined }
      if (!info) return { ...absentEntry(), md: md }
      // Stat identity unchanged: the entry we already hold is still true (this
      // is what keeps a 60MB file from being re-hashed on every poll).
      if (prev && prev.present && prev.version === info.version && prev.size === info.size) return prev
      // Past MAX_SIG_BYTES nothing is hashed either: the file is reviewed by its
      // stat identity alone (accept/reject still work), which is the ONE size
      // tier where that is true.
      if (info.size > MAX_SIG_BYTES) {
        const fp = await sigFor(target, info.size)
        return { present: true, content: null, eol: false, crlf: false, eolMap: null, version: info.version, size: info.size, note: 'large', trunc: fp.trunc, binRef: null, binSize: 0, md: md }
      }
      try {
        const text = await fs.readText(target)
        const content = text.replace(/\r\n/g, '\n')
        const entry = { present: true, content: content, eol: text.endsWith('\n'), crlf: /\r\n/.test(text), eolMap: eolMapOf(text), version: info.version, size: info.size, binRef: null, binSize: 0, md: md }
        // v1.31: with the content in hand, the fingerprint costs one hash — and it
        // is what makes the baseline snapshot race-free: the blob is written from
        // THESE bytes the moment they are known to be the baseline, so a later
        // write to the file cannot leak into the snapshot. (Only computed for
        // entries big enough to be worth preserving as a blob; a small file's
        // baseline is simply its own content, which stays in memory.)
        if (info.size > MAX_CONTENT_BYTES) entry.sig = sigOfText(content)
        return entry
      } catch (e) {
        // Binary content (readText refused it): snapshot the raw bytes (up to
        // MAX_BACKUP_BYTES) into the per-session blob dir so a later reject
        // can restore the baseline. Bigger binaries stay unrestorable.
        let binRef = null
        let binSize = 0
        if (info.size <= MAX_BACKUP_BYTES) {
          try {
            const bytes = await fs.readBytes(target, undefined, MAX_BACKUP_BYTES)
            const hash = createHash('sha1').update(rel).update(String(info.version)).digest('hex')
            const blobPath = join(blobRoot(st.sid), hash)
            if (!existsSync(blobPath)) {
              mkdirSync(blobRoot(st.sid), { recursive: true })
              // v1.34 (F5): a truncated BASELINE blob would be restored as file
              // content by a later reject — publish it atomically.
              writeBytesAtomicSync(blobPath, bytes)
            }
            binRef = hash
            binSize = bytes.length
          } catch (e2) { binRef = null }
        }
        return { present: true, content: null, eol: false, crlf: false, eolMap: null, version: info.version, size: info.size, note: 'binary', binRef: binRef, binSize: binSize, md: md }
      }
    }

    // v1.32.7 (F3 fix): "the content did not change" must NOT freeze the stat
    // token. v1.29's keep-the-old-entry rule (refreshOne / getDiff /
    // saveUserFile) is about not re-rendering for an identical rewrite, and it
    // still holds — but the token it kept is the SAME token the F3 write guard
    // (`replaceIfVersion`) compares against the disk. Once the disk moved on
    // (an identical rewrite by the agent's own write/edit tool, a CRLF<->LF
    // flip, a formatter or git touching the file), every later write was
    // refused with FS_STALE_VERSION and NO refresh could ever heal the entry:
    // a permanent per-file write lock. Content equality is decided by
    // entrySame (content / LF-normalized fingerprint), so adopting the freshly
    // observed identity here cannot hide a real change — an entry whose
    // equality would fall back to the version token (binary, sampled) never
    // reaches this call with a moved token.
    function adoptIdentity(cur, next) {
      if (!cur || !next || !cur.present || !next.present) return
      if (cur.version === next.version && cur.size === next.size) return
      // Only a content/fingerprint verdict may carry an identity forward.
      if (next.content === null && !next.sig) return
      cur.version = next.version
      cur.size = next.size
    }
    async function refreshOne(st, rel, w) {
      let f = st.files.get(rel)
      if (!f) { f = { base: null, cur: null, rev: 0, decisions: new Map() }; st.files.set(rel, f) }
      // Stat fast path: same token AND same size means the file was not touched
      // at all, so there is nothing to re-read.
      if (f.cur && f.cur.present && f.cur.version === w.version && f.cur.size === w.size) return f
      if (f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
      const next = await loadFileEntry(st, rel, f.cur)
      // v1.29: a stat change is not a change. When the newly read text is
      // identical to what we already hold (an identical rewrite, an editor
      // "save", or a pure CRLF<->LF flip — which changes `size` by one byte
      // per line), keep the EXISTING entry (old version included) so the pane
      // does not re-render for nothing.
      // v1.31: `rev` still moves — the stat identity did change, and `rev` is
      // also the per-entry content generation the stats cache keys on (a
      // separate, liveness-only counter would need to be threaded through every
      // entry). What stays put is the CONTENT, which is what "unchanged" has to
      // mean for isChanged / isPending.
      // v1.32.7: the identity does NOT stay put (see adoptIdentity) — keeping it
      // was what turned a same-content stat bump into an unwritable file.
      if (entrySame(f.cur, next)) adoptIdentity(f.cur, next)
      else f.cur = next
      f.rev++
      return f
    }

    // "The file is under review" — presence or content differs from the
    // baseline (v1.29: content-first via entrySame, so an identical rewrite or
    // a pure CRLF/LF flip never opens a review). Used by the scan, the targeted
    // refresh and the deletion sweep to decide whether a change belongs to the
    // review.
    function isPending(f) {
      return !!(f && f.base && f.cur && !entrySame(f.base, f.cur))
    }

    async function scan(sid) {
      const st = stateFor(sid)
      if (st.scanning) return st.scanning
      const task = (async () => {
        try {
          const res = resolveSession(sid)
          if (res.error) {
            // Session/workspace temporarily unavailable (session-not-found,
            // no-workspace, policy hiccup). Record the error and keep dirty
            // set: the pending mutation survives and the next scan retries.
            st.error = res.error
            return
          }
          st.root = res.root
          st.policy = res.policy
          try {
          const stamp = st.mutationStamp || 0
          // v1.18: snapshot the touched set at walk start. The loop below
          // consumes attribution for the paths it actually sees; a path the
          // agent touched MID-walk (after we already processed it) must keep
          // its touched entry so the follow-up targetedRefresh still attributes
          // it — otherwise the edit gets silently folded (the "edited file's
          // DIFF never shows" race).
          const touchedAtStart = new Set(st.touched)
          const rootTarget = await fs.resolve(res.root)
          // v1.17: the gitignore-excluded set exempts ignored entries from
          // the walk budget (see walkFiles); one git call per scan burst
          // (TTL-cached together with the VCS decorations).
          const ignored = await ignoredInfoFor(res.root)
          const walked = []
          await walkFiles(rootTarget, '', walked, 0, { n: 0 }, ignored)
          const seen = new Set()
          const firstScan = !st.baseReady
          // v1.8 attribution: a change belongs to the review iff the agent's
          // tool channel caused it. `shellWindow` is the conservative whole-
          // window fallback for opaque shell/pwsh commands; `touched` is the
          // precise per-path set from write/edit calls. Files already pending
          // review keep their pending state regardless of attribution (never
          // silently fold a decision the user has not made).
          const shellWindow = st.shellWindow === true
          const attrib = (rel) => shellWindow || st.touched.has(rel)
          let treeChanged = false
          // v1.15: content-only changes (no file set change) now bump the
          // tree stamp too — the sidebar reloads and the git VCS letters
          // (M/U/A/D/R) refresh right after an agent edit instead of waiting
          // for a manual ⟳.
          let contentChanged = false
          for (const w of walked) {
            seen.add(w.rel)
            const before = st.files.get(w.rel)
            // refreshOne mutates the SAME entry object, so the pre-refresh
            // values must be captured first — comparing before.cur against
            // f.cur afterwards would compare the object with itself.
            const beforeCur = before && before.cur ? before.cur : null
            const pending = isPending(before)
            const f = await refreshOne(st, w.rel, w)
            if (!before || !beforeCur || beforeCur.present !== f.cur.present) treeChanged = true
            else if (beforeCur.present && f.cur.present && !entrySame(beforeCur, f.cur)) contentChanged = true
            // First scan: baseline = current content (everything is baseline,
            // nothing is reviewed). Later scans decide by attribution.
            if (f.base === null) {
              f.base = firstScan ? cloneEntry(f.cur) : (attrib(w.rel) ? absentEntry() : cloneEntry(f.cur))
            }
            // A non-pending file whose content changed outside the agent
            // channel (the user's own edit in an editor, a git checkout, a
            // copied file): fold the new content into the baseline silently
            // instead of opening a review. v1.29: `!entrySame` last, so a pure
            // CRLF/LF flip neither bumps the tree stamp nor re-folds anything —
            // it simply is not a change.
            if (!firstScan && before && beforeCur && beforeCur.present && f.cur.present &&
                !pending && !attrib(w.rel) && !entrySame(beforeCur, f.cur)) {
              f.base = cloneEntry(f.cur)
              armBaseline(st, w.rel, f)
              // v1.32.7 (F1 hygiene): this path now HAS a real baseline, so the
              // create proof for it is spent (see doAccept).
              st.created.delete(w.rel)
              if (f.decisions.size > 0) f.decisions.clear()
              f.rev++
            }
          }
          for (const entry of st.files) {
            const rel = entry[0], f = entry[1]
            if (!seen.has(rel) && f.cur && f.cur.present) {
              treeChanged = true
              const pending = isPending(f)
              if (f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
              f.cur = goneEntry()
              f.rev++
              // User-side deletion (not through the agent channel, file was
              // not pending): fold the deletion into the baseline silently.
              if (!pending && !attrib(rel)) f.base = absentEntry()
            }
          }
          st.baseReady = true
          // A mutation that landed while this scan walked must keep the flag
          // so the next scan picks it up (mutationStamp guarded).
          if ((st.mutationStamp || 0) === stamp) {
            st.dirty = false
            st.shellWindow = false
            // v1.18: a full walk consumed every pending precise target (they
            // are all covered by it). When a fallback (pendingTargets = null)
            // landed mid-walk, the guard above leaves dirty set AND keeps
            // pendingTargets = null → the next resolution walks again.
            st.pendingTargets = new Set()
          }
          // Consume only the touched paths this scan actually saw AND that
          // were already touched when the walk started; a path added mid-scan
          // (or skipped by walk caps) survives so the next targetedRefresh
          // still attributes it instead of folding it into the baseline.
          for (const rel of seen) { if (touchedAtStart.has(rel)) st.touched.delete(rel) }
          // v1.31: every file this walk touched that now carries a fingerprint
          // baseline gets its restore blob (one pass, after the loop).
          armSeenBaselines(st, seen)
          st.scannedAt = Date.now()
          st.error = null
          if (treeChanged || contentChanged) {
            if (!firstScan) bumpTree(st)
            // v1.18: only persist when something actually changed — a
            // no-change failsafe walk must not re-serialize a huge state blob.
            scheduleSave(st)
            // A BACKGROUND failsafe walk that found changes must wake the
            // client so it re-fetches immediately instead of waiting for the
            // next 20s poll. Harmless no-op for blocking (first/fallback)
            // scans whose caller is already awaiting the response.
            if (!firstScan) scheduleNotify(sid, 0)
          }
          } catch (e) {
            st.error = e && e.message ? String(e.message) : String(e)
          }
        } catch (e) {
          st.error = e && e.message ? String(e.message) : String(e)
        }
      })()
      // CRITICAL: assign the promise first, then await it, and only clear the
      // flag when it is still ours. The old `st.scanning = (async () => {...}
      // finally { st.scanning = null })()` form raced: a scan that failed
      // SYNCHRONOUSLY (resolveSession error before the first await) ran its
      // finally BEFORE the assignment landed, so st.scanning ended up holding
      // a settled promise — truthy forever — and every later scan() returned
      // it without scanning. getModified then failed forever (adds/deletes
      // never appeared) while getDiff's single-file path kept working
      // (edits updated instantly).
      st.scanning = task
      try { await task } finally { if (st.scanning === task) st.scanning = null }
      return task
    }

    // ---------- precise per-path refresh (v1.18) ----------
    // The review state can be refreshed for exactly the files a mutation
    // named (write/edit file_path, or paths extracted from a shell/git
    // command), without walking the whole workspace. Semantics mirror the
    // full scan's per-file handling: reload changed content, mark deletions,
    // assign baselines by attribution, fold non-attributed changes, bump the
    // tree stamp on set/content changes. A target that is a DIRECTORY (e.g.
    // New-Item -ItemType Directory, rm -rf on a folder) cannot be enumerated
    // precisely → returns { fallback: true } and the caller runs the full
    // scan instead.
    function addTarget(st, rel) {
      if (st.pendingTargets instanceof Set) st.pendingTargets.add(rel)
      // pendingTargets === null (a fallback is already pending) stays null:
      // the full scan covers this path anyway.
    }
    function fallbackWindow(st) {
      st.pendingTargets = null
      st.shellWindow = true
    }
    async function targetedRefresh(sid) {
      const st = stateFor(sid)
      if (st.targetTask) return st.targetTask
      const task = (async () => {
        try {
          const res = resolveSession(sid)
          if (res.error) {
            // Same retry semantics as scan: keep dirty, resolve later.
            st.error = res.error
            return
          }
          st.root = res.root
          st.policy = res.policy
          const stamp = st.mutationStamp || 0
          const targets = st.pendingTargets instanceof Set ? Array.from(st.pendingTargets) : []
          st.pendingTargets = new Set()
          if (targets.length === 0) {
            if ((st.mutationStamp || 0) === stamp) { st.dirty = false; st.shellWindow = false }
            return
          }
          let treeChanged = false
          let contentChanged = false
          for (const rel of targets) {
            let info
            try {
              info = await fs.stat(await fs.resolve(joinPath(st.root, rel)))
            } catch (e) { info = undefined }
            if (info && info.type === 'directory') {
              // A directory target: the mutation's full footprint is unknown
              // (every file under it may be affected) → fall back to the walk.
              st.pendingTargets = null
              st.shellWindow = true
              st.dirty = true
              return { fallback: true }
            }
            const before = st.files.get(rel)
            const beforeCur = before && before.cur ? before.cur : null
            const pending = isPending(before)
            const attrib = st.touched.has(rel)
            if (!info) {
              // Target is gone from disk. Only entries we already tracked as
              // present become "deleted" review items; never-seen paths have
              // nothing to review (same as the scan's deletion sweep).
              if (before && before.cur && before.cur.present) {
                treeChanged = true
                if (before.decisions.size > 0) { before.decisions.clear(); before.rev++ }
                before.cur = goneEntry()
                before.rev++
                if (!pending && !attrib) before.base = absentEntry()
              }
              continue
            }
            const f = before || { base: null, cur: null, rev: 0, decisions: new Map() }
            if (!f.cur || !f.cur.present || f.cur.version !== info.version || f.cur.size !== info.size) {
              const next = await loadFileEntry(st, rel, f.cur)
              // v1.29: identical text (including a pure CRLF/LF flip) keeps the
              // existing entry, so no rev bump and no spurious review.
              // v1.32.7: but its identity token advances (adoptIdentity) — the
              // F3 write guard must compare against what the disk really holds.
              if (!entrySame(f.cur, next)) {
                if (f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
                f.cur = next
                f.rev++
              } else {
                adoptIdentity(f.cur, next)
              }
            }
            if (!before) st.files.set(rel, f)
            if (!before || !beforeCur || beforeCur.present !== f.cur.present) treeChanged = true
            else if (beforeCur.present && f.cur.present && !entrySame(beforeCur, f.cur)) contentChanged = true
            // First sight of this file (never scanned): the agent channel
            // decides the baseline — touched → "added" review, otherwise fold.
            if (f.base === null) {
              f.base = attrib ? absentEntry() : cloneEntry(f.cur)
              armBaseline(st, rel, f)
            }
            // Non-pending change outside the agent channel → fold silently
            // (mirror of the scan; prevents the open viewer flashing a diff
            // the next scan would accept anyway).
            if (before && beforeCur && beforeCur.present && f.cur.present &&
                !pending && !attrib && !entrySame(beforeCur, f.cur)) {
              f.base = cloneEntry(f.cur)
              armBaseline(st, rel, f)
              // v1.32.7 (F1 hygiene): a real baseline now exists for this path.
              st.created.delete(rel)
              if (f.decisions.size > 0) f.decisions.clear()
              f.rev++
            }
          }
          // Consume the touched entries we handled (mirror of the scan).
          for (const rel of targets) st.touched.delete(rel)
          // v1.31: same arming sweep as the scan — a precise refresh can also be
          // where a large text baseline is first established.
          armSeenBaselines(st, targets)
          if ((st.mutationStamp || 0) === stamp) {
            st.dirty = false
            st.shellWindow = false
          }
          st.scannedAt = Date.now()
          st.error = null
          if (treeChanged || contentChanged) {
            bumpTree(st)
            scheduleSave(st)
          }
        } catch (e) {
          st.error = e && e.message ? String(e.message) : String(e)
        }
      })()
      st.targetTask = task
      try { await task } finally { if (st.targetTask === task) st.targetTask = null }
      return task
    }

    // The freshness rule shared by every RPC that needs the review state:
    //  * not scanned yet            → full scan (first scan builds the baseline);
    //  * dirty with precise targets → targeted per-file refresh;
    //  * dirty without targets      → full scan (the mutation could not be
    //    located precisely — the fallback the user asked to keep);
    //  * treeDirty (git add/commit) → consume the flag, no scan at all;
    //  * last full scan older than FULL_SCAN_TTL → one full walk (the 20s
    //    failsafe the client's poll rides on).
    //
    // `failsafe` distinguishes the two RPC families:
    //  * READ RPCs (getModified/getDiff/listTree) run the 20s failsafe walk in
    //    the BACKGROUND so a large-workspace walk (seconds) never blocks the
    //    response; the walk wakes the client when it actually changed files.
    //  * MUTATION RPCs (accept/reject/hunk/edit/save) pass `failsafe:false` —
    //    folding the in-memory baseline needs no external-change absorption and
    //    must never pay a full walk just because the state is >20s old (the
    //    "accept is laggy on many files" complaint).
    async function ensureFresh(st, sid, opts) {
      const failsafe = !opts || opts.failsafe !== false
      if (!st.baseReady) { await scan(sid); return }
      if (st.dirty) {
        // A background failsafe walk may be mid-flight (started by an earlier
        // read RPC). Wait for it before resolving precise targets so the two
        // never interleave mutations of the same review map.
        if (st.scanning) await st.scanning
        if (st.pendingTargets instanceof Set && st.pendingTargets.size > 0) {
          const r = await targetedRefresh(sid)
          if (r && r.fallback) await scan(sid)
        } else {
          await scan(sid)
        }
        return
      }
      if (st.treeDirty) st.treeDirty = false
      if (failsafe && (st.scannedAt === 0 || Date.now() - st.scannedAt >= FULL_SCAN_TTL)) {
        // Background: do not await — the response must go out before the walk.
        void scan(sid)
      }
    }

    async function walkFiles(dirTarget, rel, out, depth, count, ignored) {
      if (depth > MAX_DEPTH || count.n >= MAX_ENTRIES) return
      let entries
      try { entries = await fs.listDir(dirTarget) } catch (e) { return }
      for (const e of entries) {
        if (count.n >= MAX_ENTRIES) return
        const childRel = rel ? rel + '/' + e.name : e.name
        const repoRel = ignored && ignored.prefix ? ignored.prefix + '/' + childRel : childRel
        if (e.type === 'directory') {
          if (SKIP_DIRS.has(e.name)) continue
          // v1.17: wholly-ignored directories still descend — their files
          // stay reviewable. Only the budget accounting skips them.
          await walkFiles(e.target, childRel, out, depth + 1, count, ignored)
        } else if (e.type === 'file') {
          // v1.17: gitignored files stay fully in the review map (baseline +
          // diff) — they simply don't consume the MAX_ENTRIES budget.
          const isIgnored = !!(ignored && ignored.files.has(repoRel))
          if (!isIgnored) count.n++
          let version = e.version !== undefined ? e.version : null
          let size = e.size !== undefined ? e.size : 0
          if (version === null) {
            try {
              const info = await fs.stat(e.target)
              if (info) { version = info.version; size = info.size !== undefined ? info.size : size }
            } catch (err) {}
          }
          out.push({ rel: childRel, version: version, size: size })
        }
      }
    }

    async function treeNode(dirTarget, rel, depth, count, paths, ignored) {
      if (depth > MAX_DEPTH || count.n >= TREE_MAX_NODES) return null
      let entries
      try { entries = await fs.listDir(dirTarget) } catch (e) { return null }
      const node = { name: rel === '' ? '.' : rel.split('/').pop(), type: 'directory', path: rel, children: [] }
      if (paths) paths.push(rel)
      for (const e of entries) {
        if (count.n >= TREE_MAX_NODES) break
        const childRel = rel ? rel + '/' + e.name : e.name
        const repoRel = ignored && ignored.prefix ? ignored.prefix + '/' + childRel : childRel
        if (e.type === 'directory') {
          // v1.27: only genuinely internal metadata is hidden; dependency /
          // runtime / build folders are listed (they are merely NOT scanned for
          // review — see SKIP_DIRS). Their contents still cost tree budget, so
          // a huge folder can exhaust the tree ceiling; MAX_DEPTH also applies.
          if (TREE_SKIP_DIRS.has(e.name)) continue
          // v1.17: ignored directories keep their full children in the tree
          // (grayed) — only the budget accounting skips ignored entries.
          const child = await treeNode(e.target, childRel, depth + 1, count, paths, ignored)
          if (child) node.children.push(child)
        } else if (e.type === 'file') {
          // v1.17: gitignored files stay in the tree (grayed by annotateTree)
          // with the same budget exemption as the scan.
          const isIgnored = !!(ignored && ignored.files.has(repoRel))
          if (!isIgnored) count.n++
          const fileNode = { name: e.name, type: 'file', size: e.size !== undefined ? e.size : 0, path: childRel }
          if (isIgnored) fileNode.ignored = true
          node.children.push(fileNode)
          if (paths) paths.push(childRel)
        }
      }
      // v1.15: directories first, files after; each group alphabetical
      // (case-insensitive). The fs listing order is not guaranteed to be
      // alphabetical, so the tree used to render in arbitrary order.
      node.children.sort(function (x, y) {
        const dx = x.type === 'directory' ? 0 : 1
        const dy = y.type === 'directory' ? 0 : 1
        if (dx !== dy) return dx - dy
        return String(x.name).localeCompare(String(y.name), undefined, { sensitivity: 'base' })
      })
      return node
    }

    // v1.30 lazy tree: the immediate children of ONE directory. The sidebar no
    // longer asks for the whole workspace tree up front — each expansion costs
    // one level, so the first row can render without serializing a dependency
    // folder that happens to live under the root, and a 20k-node workspace no
    // longer pays a 2.6MB payload before anything is visible.
    // The per-directory ceiling is a payload/DOM guard only (a flat folder with
    // tens of thousands of entries); `truncated` tells the client so it can say
    // so instead of silently lying.
    const TREE_DIR_MAX = 4000
    async function treeChildren(dirTarget, rel) {
      let entries
      try { entries = await fs.listDir(dirTarget) } catch (e) { return null }
      const out = []
      for (const e of entries) {
        const childRel = rel ? rel + '/' + e.name : e.name
        if (e.type === 'directory') {
          if (TREE_SKIP_DIRS.has(e.name)) continue
          out.push({ name: e.name, type: 'directory', path: childRel })
        } else if (e.type === 'file') {
          out.push({ name: e.name, type: 'file', path: childRel, size: e.size !== undefined ? e.size : 0 })
        }
      }
      // Same ordering contract as the whole-tree builder: directories first,
      // then files, each group case-insensitively alphabetical.
      out.sort(function (x, y) {
        const dx = x.type === 'directory' ? 0 : 1
        const dy = y.type === 'directory' ? 0 : 1
        if (dx !== dy) return dx - dy
        return String(x.name).localeCompare(String(y.name), undefined, { sensitivity: 'base' })
      })
      const truncated = out.length > TREE_DIR_MAX
      return { children: truncated ? out.slice(0, TREE_DIR_MAX) : out, truncated: truncated }
    }

    // Decorate ONE listing with the same VCS letters / .gitignore graying the
    // whole-tree path applies: a file takes its own letter, a directory the
    // strongest letter among its descendants.
    async function decorateChildren(root, rel, children) {
      if (!children || children.length === 0) return
      const git = await gitInfoFor(root, [])
      if (!git) return
      const repoRel = (p) => (git.prefix ? git.prefix + '/' + p : p)
      const ignored = await checkIgnoreFor(root, rel, children.map((c) => repoRel(c.path)))
      const dirAgg = dirAggOf(git)
      for (const c of children) {
        const rr = repoRel(c.path)
        if (c.type === 'directory') {
          const agg = dirAgg.get(rr)
          if (agg) c.git = agg.letter
        } else {
          const l = git.statuses.get(rr)
          if (l) c.git = l
        }
        if (ignored.has(rr)) c.ignored = true
      }
    }

    // ---------- git VCS annotations (v1.15) ----------
    // The sidebar tree gets VSCode-style version-control decorations: a git
    // status letter per file (M modified / U untracked / A added / D deleted /
    // R renamed — staged or unstaged, whichever is the "newer" side wins) and
    // gray styling for .gitignore-excluded files/folders. Status comes from
    // one `git status --porcelain=v2 -z` call per workspace (cached briefly so
    // tree reload bursts share it); exclusions come from a single batched
    // `git check-ignore --stdin -z` fed with every walked path. Both are
    // optional decorations: no git → no letters, no failure path breaks the
    // tree. The whole section is process-local (no state persistence needed).
    const GIT_TTL = 2000
    const GIT_CANDIDATES = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']
    const gitCache = new Map()
    // v1.17: cached gitignore-excluded path set (same TTL as the VCS cache) —
    // ignored entries still walk, scan and review; only MAX_ENTRIES skips them.
    const ignoredCache = new Map()
    const gitKeyOf = (root) => (process.platform === 'win32' ? String(root).toLowerCase() : String(root))
    // v1.15.1: the plugin's own disk writes (reject / undo-reject / user
    // save) change the worktree↔HEAD relationship directly, so the 2s cached
    // git snapshot for that workspace would be stale on the very next tree
    // load (which the same action just scheduled via a treeStamp bump). Drop
    // the cache entry so the reload re-asks git and the badges tell the truth
    // immediately.
    function invalidateGitCacheFor(root) {
      if (!root) return
      const key = gitKeyOf(root)
      gitCache.delete(key)
      // v1.17: the ignored set changes with .gitignore edits and git add/rm —
      // drop it together with the status snapshot so the next walk re-asks git.
      ignoredCache.delete(key)
    }
    function findRepoRoot(root) {
      let cur = root
      for (let i = 0; i < 10 && cur; i++) {
        if (existsSync(join(cur, '.git'))) return cur
        const parent = join(cur, '..')
        if (parent === cur) break
        cur = parent
      }
      return null
    }
    function runGit(bin, args, cwd, input) {
      return new Promise((resolve) => {
        let settled = false
        const out = []
        const err = []
        let child
        try {
          child = spawn(bin, args, { cwd: cwd, windowsHide: true, env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0' }) })
        } catch (e) {
          resolve({ ok: false, spawnError: e })
          return
        }
        const kill = setTimeout(() => { try { child.kill() } catch (e) {} }, 20000)
        child.on('error', (e) => {
          if (settled) return
          settled = true
          clearTimeout(kill)
          resolve({ ok: false, spawnError: e })
        })
        if (child.stdout) child.stdout.on('data', (d) => out.push(d))
        if (child.stderr) child.stderr.on('data', (d) => err.push(d))
        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(kill)
          resolve({ ok: true, code: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
        })
        try { child.stdin.end(input === undefined ? '' : input) } catch (e) {}
      })
    }
    // XY pair → single letter. The worktree column (Y) wins when both are
    // set — it is the state the tree actually shows on disk. Untracked `?`
    // records (porcelain v2 lists them as a bare `? path` field) map to U;
    // copied/typechange/unmerged collapse to M (the closest review state).
    function gitLetterOf(xy) {
      const x = xy ? xy.charAt(0) : ''
      const y = xy ? xy.charAt(1) : ''
      const c = (y && y !== '.' && y !== ' ') ? y : x
      if (c === '?') return 'U'
      if (c === 'A') return 'A'
      if (c === 'D') return 'D'
      if (c === 'R') return 'R'
      if (c === 'C' || c === 'T' || c === 'M' || c === 'U') return 'M'
      return null
    }
    // porcelain v2 + -z: RECORDS are NUL-terminated but the fields INSIDE a
    // record stay space-separated (verified against git 2.55); a pathname
    // containing spaces arrives C-quoted (`"my file.txt"`). This unquotes the
    // minimal C-escape set git's quote.c uses.
    function gitUnquote(s) {
      if (typeof s !== 'string' || s.charAt(0) !== '"') return s
      let out = ''
      for (let k = 1; k < s.length - 1; k++) {
        const ch = s.charAt(k)
        if (ch === '\\' && k + 1 < s.length - 1) {
          k++
          const n = s.charAt(k)
          if (n === 'n') out += '\n'
          else if (n === 't') out += '\t'
          else out += n
        } else out += ch
      }
      return out
    }
    async function gitInfoFor(root, relPaths) {
      // relPaths: workspace-relative paths of every walked file AND directory
      // ('' = the workspace root itself). Cached per root with a short TTL so
      // a burst of tree reloads shares one status computation.
      const key = gitKeyOf(root)
      const hit = gitCache.get(key)
      if (hit && Date.now() - hit.t < GIT_TTL) return hit.p
      const p = (async () => {
        const repoRoot = findRepoRoot(root)
        if (!repoRoot) return null
        let prefix = relative(repoRoot, root).replace(/\\/g, '/')
        if (prefix === '.') prefix = ''
        let statusOut = null
        for (const bin of GIT_CANDIDATES) {
          const r = await runGit(bin, ['-c', 'core.quotepath=false', '-c', 'status.renames=true', 'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'], repoRoot)
          if (r.spawnError) continue
          if (!r.ok || r.code !== 0) return null // not a git repo (or git broken) → no decorations
          statusOut = r.stdout
          break
        }
        if (statusOut === null) return null
        const statuses = new Map()
        const records = statusOut.toString('utf8').split('\0')
        for (const rec of records) {
          if (rec === '') continue
          const t = rec.charAt(0)
          if (t === '1' || t === '2' || t === 'u') {
            // Split on spaces: every field up to the pathname is guaranteed
            // space-free, and the pathname is the rest of the record (so a
            // path containing spaces survives as one quoted tail element).
            const parts = rec.split(' ')
            const pathAt = t === '1' ? 8 : t === '2' ? 9 : 10
            const xy = parts.length > 1 ? parts[1] : ''
            const letter = gitLetterOf(xy)
            if (!letter) continue
            const path = gitUnquote(parts.slice(pathAt).join(' '))
            if (path) statuses.set(path, letter)
          } else if (t === '?') {
            // untracked: the whole record is `? <path>` (v2 quirk)
            const path = gitUnquote(rec.slice(2))
            if (path) statuses.set(path, 'U')
          }
          // anything else: unknown record shape — skip defensively
        }
        // .gitignore exclusions: one check-ignore process for the whole
        // tree. An ignored directory is reported itself AND each path under
        // it, so folders gray out with their contents; negation patterns
        // (`!keep.log`) are honored by git itself. Exit 0 = some ignored,
        // exit 1 = none ignored (empty set, not an error).
        const ignored = new Set()
        const repoPaths = relPaths.map((r) => (prefix ? prefix + '/' + r : r)).filter((r) => r !== '')
        if (repoPaths.length > 0) {
          for (const bin of GIT_CANDIDATES) {
            const r = await runGit(bin, ['check-ignore', '--stdin', '-z'], repoRoot, repoPaths.join('\0') + '\0')
            if (r.spawnError) continue
            if (r.ok && r.code === 0) {
              const s = r.stdout.toString('utf8')
              for (const p of s.split('\0')) if (p !== '') ignored.add(p)
            }
            // code 1 (nothing ignored) or any failure: leave the set empty
            break
          }
        }
        return { prefix: prefix, statuses: statuses, ignored: ignored }
      })().catch(() => null)
      gitCache.set(key, { t: Date.now(), p: p })
      return p
    }
    // v1.17: gitignore-excluded entries must not consume the walk budget.
    // The ignored set comes from ONE `git ls-files --others --ignored
    // --exclude-standard -z` call listing every ignored file individually
    // (negation patterns such as `!keep.log` are honored by git itself:
    // un-ignored files are simply absent from the list; tracked files are
    // never reported — git cannot ignore them). Ignored entries still walk,
    // scan and review exactly as before — only the MAX_ENTRIES accounting
    // skips them. Non-git workspaces and git failures return null = the
    // pre-v1.17 behavior.
    async function ignoredInfoFor(root) {
      const key = gitKeyOf(root)
      const hit = ignoredCache.get(key)
      if (hit && Date.now() - hit.t < GIT_TTL) return hit.p
      const p = (async () => {
        const repoRoot = findRepoRoot(root)
        if (!repoRoot) return null
        let prefix = relative(repoRoot, root).replace(/\\/g, '/')
        if (prefix === '.') prefix = ''
        let out = null
        for (const bin of GIT_CANDIDATES) {
          const r = await runGit(bin, ['-c', 'core.quotepath=false', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'], repoRoot)
          if (r.spawnError) continue
          if (!r.ok || r.code !== 0) return null // git broken / not a repo
          out = r.stdout
          break
        }
        if (out === null) return null
        const files = new Set()
        for (const part of out.toString('utf8').split('\0')) {
          if (part === '') continue
          files.add(part.replace(/\\/g, '/'))
        }
        return { prefix: prefix, files: files }
      })().catch(() => null)
      ignoredCache.set(key, { t: Date.now(), p: p })
      return p
    }

    // Post-order decoration pass: files take their own letter; a directory
    // takes the strongest letter among its descendants (D > A > R > M > U) so
    // a folder containing any change is itself flagged. Deleted files (D)
    // never appear as tree nodes (they are gone from disk), so their letters
    // reach ancestor directories through the status map instead. The ignored
    // flag is per node — every walked path was fed to check-ignore
    // individually.
    const GIT_PRIORITY = { U: 1, M: 2, R: 3, A: 4, D: 5 }
    // v1.30: the "strongest letter per ancestor directory" table, factored out
    // of annotateTree so the LAZY tree path (one directory per request) can ask
    // the same question for a single folder without walking a whole tree.
    // Cached per git snapshot (the snapshot itself is cached with a 2s TTL).
    const dirAggCache = new WeakMap()
    function dirAggOf(git) {
      let agg = dirAggCache.get(git)
      if (agg) return agg
      // Aggregate every status path's letter into each of its ancestor
      // directories (repo-relative keys) — O(entries × depth), depth ≤ 16.
      agg = new Map()
      for (const entry of git.statuses) {
        const letter = entry[1]
        const prio = GIT_PRIORITY[letter] || 1
        const segs = entry[0].split('/')
        for (let k = 0; k < segs.length; k++) {
          const d = segs.slice(0, k).join('/')
          const cur = agg.get(d)
          if (!cur || cur.p < prio) agg.set(d, { p: prio, letter: letter })
        }
      }
      dirAggCache.set(git, agg)
      return agg
    }
    // v1.30: batched `git check-ignore` for one directory listing. Kept apart
    // from gitInfoFor because that helper's cached result carries the ignored
    // set of whatever path list produced it — fine for a whole-tree load, wrong
    // for a per-directory one. Keyed per (root, dir) with the same short TTL.
    const ignoreCache = new Map()
    async function checkIgnoreFor(root, dirRel, repoPaths) {
      if (!repoPaths || repoPaths.length === 0) return new Set()
      const key = gitKeyOf(root) + '\u0001' + dirRel
      const hit = ignoreCache.get(key)
      if (hit && Date.now() - hit.t < GIT_TTL) return hit.p
      const p = (async () => {
        const repoRoot = findRepoRoot(root)
        if (!repoRoot) return new Set()
        const ignored = new Set()
        for (const bin of GIT_CANDIDATES) {
          const r = await runGit(bin, ['check-ignore', '--stdin', '-z'], repoRoot, repoPaths.join('\0') + '\0')
          if (r.spawnError) continue
          if (r.ok && r.code === 0) {
            const s = r.stdout.toString('utf8')
            for (const x of s.split('\0')) if (x !== '') ignored.add(x)
          }
          break // code 1 (nothing ignored) or a failure: leave the set empty
        }
        return ignored
      })().catch(() => new Set())
      ignoreCache.set(key, { t: Date.now(), p: p })
      return p
    }
    function annotateTree(node, git) {
      const repoRel = (rel) => (git.prefix ? git.prefix + '/' + rel : rel)
      // Post-order decoration pass: files take their own letter; a directory
      // takes the strongest letter among its descendants (D > A > R > M > U) so
      // a folder containing any change is itself flagged. Deleted files (D)
      // never appear as tree nodes (they are gone from disk), so their letters
      // reach ancestor directories through the status map instead. The ignored
      // flag is per node — every walked path was fed to check-ignore
      // individually.
      const dirAgg = dirAggOf(git)
      const visit = (node, rel) => {
        let best = 0
        if (node.type === 'directory') {
          const agg = dirAgg.get(repoRel(rel))
          if (agg && agg.p > best) { best = agg.p; node.git = agg.letter }
          for (const c of node.children || []) {
            const r = visit(c, rel ? rel + '/' + c.name : c.name)
            if (r > best) { best = r; if (c.git) node.git = c.git }
          }
        } else {
          const l = git.statuses.get(repoRel(rel))
          if (l) { node.git = l; best = GIT_PRIORITY[l] || 1 }
        }
        if (git.ignored.has(repoRel(rel))) node.ignored = true
        return best
      }
      visit(node, '')
    }

    // ---------- analysis ----------
    // v1.31: an entry that carries a fingerprint but no content is "not loaded
    // yet". Loading is a review-time cost (the file is being looked at), never
    // a scan-time one — that is what lets a large text file stay reviewable
    // without keeping its text in the workspace state.
    function isUnloaded(entry) {
      return !!(entry && entry.present && entry.content === null && entry.sig)
    }
    // Load the content of a fingerprint entry IN PLACE (entry.loading guards a
    // concurrent double-load). `root`/`rel` locate the file; everything else the
    // consumer needs is already on the entry.
    //
    // v1.31 CRITICAL: a BASELINE entry must be refilled from its own blob, never
    // from the file on disk — the file holds the EDITED content at this point, so
    // reading it would overwrite the baseline with the change and turn a real
    // edit into a phantom "changed with 0 hunks". Content entries (the common
    // case) still come from disk, which is exactly what they describe.
    async function ensureLoaded(root, rel, entry) {
      if (!entry || !entry.present) return
      if (entry.content !== null || !entry.sig || entry.loading) return
      if (entry.size > MAX_SIG_BYTES && !entry.baselineRef) return
      try {
        let text
        let fromBlob = false
        if (entry.baselineRef) {
          const blob = join(blobRoot(st.sid), entry.baselineRef)
          if (!existsSync(blob)) return
          entry.loading = true
          text = readFileSync(blob, 'utf8')
          entry.loading = false
          fromBlob = true
        } else {
          const target = await fs.resolve(joinPath(root, rel))
          entry.loading = true
          text = await fs.readText(target)
          entry.loading = false
        }
        entry.content = text.replace(/\r\n/g, '\n')
        // v1.33 (F6): a baseline blob holds LF-NORMALIZED bytes (streamNormalized
        // mirrors the normalized text), so re-deriving the write style from it
        // would silently turn a CRLF baseline into an LF one and make the next
        // reject flip every line ending of the restored file. The style is read
        // from the FILE only; a blob load keeps what the entry already knows.
        if (!fromBlob) {
          entry.eol = text.endsWith('\n')
          entry.crlf = /\r\n/.test(text)
          entry.eolMap = eolMapOf(text)
        }
        // The fingerprint is KEPT alongside the content: equality can then be
        // settled by a hash instead of re-walking two line arrays, and it costs
        // two short strings in memory (never in the state file — saveState picks
        // explicit fields, and a clean entry persists only its baseline anyway).
      } catch (e) {
        entry.loading = false
      }
    }
    async function fileLines(root, rel, entry) {
      await ensureLoaded(root, rel, entry)
      return linesOf(entry)
    }
    // v1.18: per-entry review stats cache. Computing the stats runs the diff
    // over the file's lines, which for a session with hundreds of modified
    // files made EVERY getModified (and acceptAll's list) pay the full diff
    // pass. The cache is keyed on f.rev — every mutation of (base, cur,
    // decisions) bumps rev, so a hit is exact. Not persisted (saveState picks
    // explicit fields only).
    // v1.31: async, because a fingerprint entry loads its content here (once,
    // then it is cached on the entry and on rev). The old MAX_DIFF_LINES gate
    // is gone: the anchored engine has no line ceiling, so a big file now gets
    // real +N/-M numbers instead of a forced "过大".
    // v1.31: the cache key includes both version tokens. `f.rev` alone is not
    // enough: `refreshOne` deliberately keeps the same entry (and therefore the
    // same stats when nothing was decided) across an EOL-only rewrite, while the
    // file's OTHER side can still be replaced by a real edit between two calls —
    // a version-stamped key cannot go stale that way.
    function statsKey(f) {
      return f.rev + '|' + ((f.base && f.base.version) || '-') + '|' + ((f.cur && f.cur.version) || '-')
    }
    async function fileStats(root, rel, f) {
      const key = statsKey(f)
      if (f.statsCache && f.statsCache.key === key) return f.statsCache
      const status = !f.base || !f.base.present ? 'added' : (!f.cur.present ? 'deleted' : 'modified')
      const note = (f.base && f.base.note) || f.cur.note || null
      let s
      if (note) {
        s = { status: status, note: note, pending: 1, added: 0, removed: 0 }
      } else {
        const baseLines = await fileLines(root, rel, f.base)
        const curLines = await fileLines(root, rel, f.cur)
        if (isUnloaded(f.base) || isUnloaded(f.cur)) {
          // Beyond MAX_SIG_BYTES: the content cannot be held at all, so the
          // counts stay unknown rather than being invented.
          s = { status: status, note: 'large', pending: 1, added: 0, removed: 0 }
        } else {
          const hunks = computeHunks(baseLines, curLines)
          let added = 0, removed = 0, pending = 0
          for (const h of hunks) {
            if (f.decisions.has(h.id)) continue
            pending++
            added += h.newLen
            removed += h.oldLen
          }
          s = { status: status, note: null, pending: pending, added: added, removed: removed }
        }
      }
      f.statsCache = { key: key, rev: f.rev, ...s }
      return f.statsCache
    }
    async function modifiedFiles(st) {
      const files = []
      for (const entry of st.files) {
        const rel = entry[0], f = entry[1]
        // Content-first listing (v1.29): isChanged() compares the normalized
        // text for entries that carry it — and the LF-normalized fingerprint for
        // the ones that do not — so an identical rewrite, including a pure
        // CRLF<->LF conversion (which moves the stat identity: one byte per
        // line), is simply not listed. Only binary content still falls back to
        // the version axis, because nothing else is knowable about it.
        if (!f.cur || !isChanged(f)) continue
        const s = await fileStats(st.root, rel, f)
        files.push({ path: rel, status: s.status, note: s.note, pending: s.pending, added: s.added, removed: s.removed })
      }
      files.sort(function (x, y) { return x.path < y.path ? -1 : (x.path > y.path ? 1 : 0) })
      return files
    }

    // ---------- change identity (content-first, v1.29) ----------
    // "Do these two observations of the same file describe the same content?"
    //
    // The version token is the fs service's FsVersion
    // (`dev:ino:size:mtimeNs:ctimeNs`) — a STAT identity, not a content hash.
    // Any rewrite bumps it even when not one character changed: an agent
    // `write` of the identical text, an editor "save" with no edits, or — the
    // reported bug — a pure CRLF<->LF conversion, which changes `size` (one
    // byte per line) while every LINE stays the same. Comparing versions
    // therefore raised a review for files with nothing to review: the file
    // showed up as 已修改 with a "无未决定修改" toolbar and accept/reject
    // buttons (a "full diff" over an unchanged file), for BOTH the plugin's own
    // viewer and the modified-file list.
    //
    // Text entries carry their normalized content (`\r\n` -> `\n`, done once at
    // read time in loadFileEntry), so they get a real comparison: the LINE
    // ARRAYS — exactly what the diff itself compares and renders — must be
    // equal. That makes the comparison blind to the line-ending style (CRLF vs
    // LF) AND to the presence of a final newline, because neither changes a
    // single line: `eol`/`crlf` are write-style hints for joinLines, not
    // content. Ignoring them here is the whole point of the fix — the reported
    // bug is precisely a flip of those two flags with identical lines.
    //
    // Entries without content used to be stuck on the version axis (binary AND
    // every text file past 512KB) — which is exactly why a CRLF/LF flip kept
    // producing a phantom "已修改" for large files even after v1.29 fixed it for
    // small ones. v1.31 splits that case in two:
    //   * a text entry past the in-memory window carries `sig`, an LF-normalized
    //     content hash — a REAL content verdict, so it is compared as one;
    //   * binary content (`note: 'binary'`) and the past-MAX_SIG_BYTES tier
    //     (`trunc`, a sampled identity) keep the version axis, which is all that
    //     is knowable about them. `note` differing => different kind of
    //     observation => changed (a file that became readable is a transition).
    function entrySame(a, b) {
      if (!a || !b) return a === b
      // v1.32.3 PERF: the SAME object is trivially equal, and this is the
      // dominant case in the whole review map — a clean entry keeps base === cur
      // for its lifetime, and accepting a file assigns `f.base = cloneEntry(f.cur)`
      // which the next sweep compares again. Without this line every 6s poll and
      // every acceptAll walked all 34K entries into a content comparison.
      if (a === b) return true
      if (a.present !== b.present) return false
      if (!a.present) return true
      if ((a.note || null) !== (b.note || null)) return false
      // Both sides fingerprinted: the hashes already answer the question (an
      // entry keeps its fingerprint after its content is loaded, so this path is
      // common). Fall through to the text comparison when either side has none.
      if (a.sig && b.sig) {
        if (sameSig(a.sig, b.sig)) return true
        if (a.content !== null && b.content !== null) return linesEqual(a.content, b.content)
        return false
      }
      const ac = a.content !== null && a.content !== undefined
      const bc = b.content !== null && b.content !== undefined
      if (ac && bc) return linesEqual(a.content, b.content)
      // One side has content, the other only a fingerprint (the file crossed
      // the 512KB window). A fingerprint IS a normalized-content hash, so hash
      // the content and compare — no version fallback for a question we can
      // answer exactly.
      if (ac || bc) {
        const withContent = ac ? a : b
        const other = ac ? b : a
        if (other.sig) return sameSig(sigOfText(withContent.content), other.sig)
        return a.version === b.version
      }
      if (a.sig && b.sig) return sameSig(a.sig, b.sig)
      if (a.trunc && b.trunc) return sameSig(a.trunc, b.trunc)
      return a.version === b.version
    }
    // v1.32.3 PERF: "do these two texts have the same lines?" — the hot
    // predicate of the whole review (modifiedFiles calls it for EVERY entry on
    // every poll, acceptAll twice per click). The previous implementation
    // allocated two line ARRAYS for every comparison, even for the overwhelmingly
    // common case of two byte-identical normalized strings; on a 34K-entry /
    // 263MB module-one state that was 25K splitLines calls and ~220ms of pure
    // allocation per sweep. Now the identical case is a single memcmp and no
    // array is built at all; only genuinely different texts fall through to the
    // line walk, and that walk streams instead of allocating.
    //
    // Equivalence with splitLines (the definition of "same lines" used
    // everywhere else): compare the LF-normalized texts first (that alone
    // settles CRLF-vs-LF and a final-newline-only difference), then compare line
    // by line without materializing the arrays. splitLines drops exactly one
    // trailing empty line, which is what the explicit "the last line ends the
    // string" tests below reproduce.
    function linesEqual(x, y) {
      if (x === y) return true
      if (x === null || y === null || x === undefined || y === undefined) return false
      // splitLines returns [] for an empty string, which is NOT the same as [""]
      // (the line list of "\n"), so the falsy case keeps its own answer.
      if (!x || !y) return !x && !y
      let a = x.indexOf('\r') >= 0 ? x.replace(/\r\n/g, '\n') : x
      let b = y.indexOf('\r') >= 0 ? y.replace(/\r\n/g, '\n') : y
      // splitLines drops the final empty line: the terminator of the last line
      // is not content, so "a", "a\n" and "a\r\n" are the same single line.
      if (a.charCodeAt(a.length - 1) === 10) a = a.slice(0, -1)
      if (b.charCodeAt(b.length - 1) === 10) b = b.slice(0, -1)
      if (a === b) return true
      const la = a.length, lb = b.length
      let i = 0, j = 0
      for (;;) {
        const na = a.indexOf('\n', i)
        const nb = b.indexOf('\n', j)
        const ea = na < 0 ? la : na
        const eb = nb < 0 ? lb : nb
        if (ea - i !== eb - j) return false
        for (let k = 0; k < ea - i; k++) if (a.charCodeAt(i + k) !== b.charCodeAt(j + k)) return false
        if (ea === la || eb === lb) return ea === la && eb === lb
        i = ea + 1
        j = eb + 1
      }
    }
    function linesOf(entry) {
      return entry && entry.present && entry.content !== null ? splitLines(entry.content) : []
    }
    // "This entry's lines are in hand" — an ABSENT entry counts (an empty
    // baseline is a legitimate diff side), a present entry whose content could
    // not be loaded does not.
    function hasLines(entry) {
      return !!entry && (!entry.present || entry.content !== null)
    }
    function isChanged(f) {
      if (!f.base || !f.cur) return true
      return !entrySame(f.base, f.cur)
    }

    // v1.31: async — a fingerprint entry (text past the in-memory window) loads
    // its content HERE, at review time, which is what turns "整文件接受/拒绝"
    // into a real per-hunk diff. The old MAX_DIFF_LINES gate is gone: the
    // anchored engine has no line ceiling, so the only files that still fall
    // back to a note are binary ones and the past-MAX_SIG_BYTES tier (whose
    // content is never held at all).
    async function diffPayload(f, root, rel, prevRev) {
      const status = !f.base || !f.base.present ? 'added' : (!f.cur.present ? 'deleted' : 'modified')
      if (prevRev !== undefined && prevRev !== null && prevRev === f.rev) {
        return { ok: true, same: true, rev: f.rev }
      }
      const changed = isChanged(f)
      // Deleted files: no line diff — the whole old content as red hunks was
      // noise. Ship a banner payload; the client offers accept (confirm the
      // deletion) / reject (restore from baseline) instead.
      if (status === 'deleted') {
        return { ok: true, rev: f.rev, status: status, changed: changed, deleted: true, hunks: [], current: null, baseline: null }
      }
      // Created and deleted again within the session: nothing on disk now,
      // nothing in the baseline — net zero vs the baseline. Banner payload
      // instead of an empty "editable" file.
      if (status === 'added' && !f.cur.present) {
        return { ok: true, rev: f.rev, status: status, changed: false, zero: true, hunks: [], current: null, baseline: null }
      }
      // A note (binary, or past MAX_SIG_BYTES) is decided BEFORE any load: those
      // entries have no content to load by definition.
      const note = (f.base && f.base.note) || f.cur.note || null
      if (note) {
        return { ok: true, rev: f.rev, status: status, changed: changed, note: note, hunks: [], current: null, baseline: null }
      }
      const baseLines = await fileLines(root, rel, f.base)
      const curLines = await fileLines(root, rel, f.cur)
      // Load failed (file vanished / refuses to read): honest "nothing to show"
      // beats claiming an empty diff.
      if (f.base.present && baseLines.length === 0 && f.base.size > 0) {
        return { ok: true, rev: f.rev, status: status, changed: changed, note: 'unreadable', hunks: [], current: null, baseline: null }
      }
      // v1.9: a clean markdown file renders in full (no line cap, no preview
      // truncation). Review states (changed) keep the diff path below — pending
      // edits must stay visible for accept/reject.
      const md = (f.base && f.base.md) || (f.cur && f.cur.md)
      if (md && !changed) {
        return { ok: true, rev: f.rev, status: status, changed: false, hunks: [], current: curLines, baseline: null }
      }
      const all = computeHunks(baseLines, curLines)
      const hunks = []
      for (const h of all) if (!f.decisions.has(h.id)) hunks.push(h)
      // v1.31: past the shipping bound the viewer gets the HUNKS plus a
      // head/tail preview instead of the whole file. Hunk accept/reject does not
      // need the surrounding text (applyHunk recomputes from the host's own
      // copy), so this stays a rendering bound — never a review bound.
      const huge = curLines.length > MAX_DIFF_SHIP_LINES || baseLines.length > MAX_DIFF_SHIP_LINES
      if (huge) {
        const head = 400
        const tail = 200
        const tailStart = curLines.length > head + tail ? curLines.length - tail : 0
        return {
          ok: true, rev: f.rev, status: status, changed: changed, hunks: hunks,
          baseline: null, current: null, windowed: true, lineCount: curLines.length,
          preview: curLines.slice(0, head),
          previewTail: tailStart > 0 ? curLines.slice(tailStart) : [],
          previewTailStart: tailStart > 0 ? tailStart + 1 : 0,
        }
      }
      return {
        ok: true, rev: f.rev, status: status, changed: changed, hunks: hunks,
        baseline: hunks.length > 0 ? baseLines : null,
        current: curLines,
      }
    }

    // ---------- mutations ----------
    // v1.13.1: the cached st.policy can be null (state restored from disk and
    // no scan ran since the restart — getDiff serves from the restored map,
    // so resolveSession never refreshed it) or empty (resolve threw). Passing
    // null/empty to the fs service makes it fall back to the AGENTLESS policy
    // (deployment default + fallback root = the DSH process cwd), which denies
    // writes that are actually inside the session workspace — the observed
    // "file access denied under workspace-write mode" on Ctrl+S. Re-resolve
    // the session's CURRENT policy for every mutation; fall back to the cached
    // one only when the session is unavailable.
    function freshPolicy(st) {
      try {
        const session = sessions.get(st.sid)
        if (session) {
          const p = sandboxPolicy.resolve({ session })
          if (p && p.mode) return p
        }
      } catch (e) {}
      return st.policy ?? undefined
    }
    // v1.33 (F3): every write now carries the version its content was built from.
    // `fs.writeText`'s `replaceIfVersion` / `createIfAbsent` intent turns a
    // concurrent (never-observed) change into FS_STALE_VERSION instead of a silent
    // overwrite. The plugin's own `rev` only guards against a STALE CLIENT — it
    // says nothing about the disk moving on beneath the in-memory state (an
    // unobserved external edit, another session on the same workspace, a build
    // step), which is exactly how a reject used to discard newer content.
    async function writeFile(st, rel, content, guard) {
      const target = await fs.resolve(joinPath(st.root, rel))
      const outcome = await fs.writeText(target, content, guard, undefined, freshPolicy(st))
      return outcome
    }
    // Guard token for "replace exactly what we last observed". An entry with no
    // version (absent, or already gone) gets createIfAbsent instead: restoring a
    // file the agent deleted must still work, while a target that reappeared
    // under us is refused.
    function guardOf(entry) {
      if (entry && entry.present && entry.version !== null && entry.version !== undefined) {
        return { kind: 'replaceIfVersion', version: entry.version }
      }
      return { kind: 'createIfAbsent' }
    }
    function isStaleWrite(e) {
      const code = e && e.code ? String(e.code) : ''
      if (code === 'FS_STALE_VERSION' || code === 'FS_NOT_OBSERVED') return true
      const msg = e && e.message ? String(e.message) : String(e)
      return /changed since it was read|no longer exists|without reading it first/.test(msg)
    }
    function staleWriteError() {
      const e = new Error('文件已变化，请刷新后重试')
      e.code = 'FS_STALE_VERSION'
      return e
    }
    async function deleteFile(st, rel, info) {
      if (!shell) throw new Error('shell 服务不可用，无法删除文件')
      const target = await fs.resolve(joinPath(st.root, rel))
      const p = fs.processPath(target)
      const isWin = process.platform === 'win32'
      const bashQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
      const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'"
      const isDir = !!(info && info.type === 'directory')
      // v1.33 (F4): ONE dialect, chosen by platform, and NO cross-dialect
      // fallback. The removed fallback ran a bash-quoted rm command through
      // PowerShell whenever the PowerShell command failed. bash's quote escape
      // is not PowerShell syntax: it closes the quote early, so an apostrophe in
      // a path let any semicolon after it become a statement separator —
      // arbitrary command execution from a single reject click (reproduced with
      // a non-empty directory whose name carried a quote plus a payload, where
      // the primary Remove-Item fails on the not-empty directory and the
      // alternate ran the payload). PowerShell quoting is doubled for pwsh,
      // backslash-escaped for bash, and each dialect stays in its own command.
      const command = isWin
        ? 'Remove-Item -LiteralPath ' + psQuote(p) + ' -Force' + (isDir ? ' -Recurse' : '')
        : 'rm -f' + (isDir ? ' -r' : '') + ' -- ' + bashQuote(p)
      // v1.13.1: same null-policy hazard as writeFile — resolve fresh.
      const policy = freshPolicy(st)
      let result
      try {
        result = await shell.run(shell.resolve({ command: command, sandboxPolicy: policy }))
      } catch (e) {
        result = undefined
      }
      if (!result || result.exitCode !== 0) {
        const stderr = result && result.stderr && result.stderr.text !== undefined ? String(result.stderr.text) : String((result && result.stderr) || '')
        throw new Error('删除失败: ' + stderr)
      }
      // The plugin itself removed a file from disk: notify the client so the
      // sidebar file tree reloads (rejecting an added file = delete).
      bumpTree(st)
    }
    // Copy the file's current bytes into the undo dir before a reject
    // overwrites or deletes them. Returns the record entry (afterVersion is
    // filled by the caller once the reject write/delete has settled), or
    // null when there is nothing to back up (absent / too large / bad path).
    async function snapshotForUndo(st, path, rec) {
      try {
        const segs = path.split('/')
        if (segs.some(function (s) { return s === '..' || s === '.' || s === '' })) return null
        const target = await fs.resolve(joinPath(st.root, path))
        const info = await fs.stat(target)
        if (!info || info.size > MAX_BACKUP_BYTES) return null
        const bytes = await fs.readBytes(target, undefined, MAX_BACKUP_BYTES)
        const dir = join(undoRoot(st.sid), rec.opId, ...segs.slice(0, -1))
        mkdirSync(dir, { recursive: true })
        // v1.34 (F5): a truncated undo backup would be restored verbatim by
        // 撤销, so the backup is published atomically too.
        writeBytesAtomicSync(join(dir, segs[segs.length - 1]), bytes)
        return { path: path, afterVersion: null }
      } catch (e) {
        return null
      }
    }
    // v1.33 (F1): "reject an added file" means DELETE it, which is only sound
    // when the plugin can prove the file did not exist before the agent touched
    // it. An ABSENT baseline is not that proof: the review map has no entry for
    // every path the scan never reached (SKIP_DIRS, deeper than MAX_DEPTH, past
    // the MAX_ENTRIES budget) nor for a file that appeared after the last scan,
    // and attributing those to "the agent created it" made one reject click
    // delete a file the user had owned all along (reproduced for both the
    // skipped-directory and the user-created-then-agent-edited cases). The only
    // positive proof is the write tool's own outcome (operation: 'create',
    // recorded by the tools/result hook); everything else refuses instead of
    // destroying data it cannot restore.
    function assertDeletable(st, path, info) {
      if (info && info.type && info.type !== 'file') {
        throw new Error('无法删除：' + path + ' 不是普通文件，拒绝不会删除它')
      }
      if (!st.created.has(path)) {
        throw new Error('无法证明「' + path + '」是 AI 新建的文件（它不在本次审查的基线快照中），为避免误删，拒绝不会删除它。可先点 ✓ 接受该文件，或手动删除。')
      }
    }
    // v1.34 (F5): raw-byte writes cannot use fs.writeText (their payload is not
    // UTF-8 text), and the two that write USER files used to bypass BOTH the
    // sandbox fence and the temp+rename publish every other write goes through:
    // under read-only / workspace-write they still rewrote files, and a crash
    // mid-write could leave a truncated source file where a complete one was
    // (the failure mode DEV.md 6.20 records for the state file).
    function writeBytesAtomicSync(absPath, data) {
      const dir = dirname(absPath)
      const tmp = join(dir, '.' + absPath.slice(dir.length + 1) + '.' + process.pid + '.dshfe-tmp')
      // v1.32.7 (F5 fix): the fs backend passes the target's CURRENT mode into
      // its atomic write (fs-local: writeFileAtomic(..., existing?.mode, ...)),
      // so a byte restore must not silently re-create the file with the process
      // default — a 0755 script came back 0644 on POSIX. rename() replaces the
      // inode, so the mode has to be applied to the temp file before publishing.
      let mode = null
      try { mode = statSync(absPath).mode } catch (e) { mode = null }
      try {
        writeFileSync(tmp, data)
        if (mode !== null) { try { chmodSync(tmp, mode & 0o777) } catch (e) {} }
        renameSync(tmp, absPath)
      } catch (e) {
        try { rmSync(tmp, { force: true }) } catch (e2) {}
        throw e
      }
    }
    // The same policy fence fs-sandbox applies to writeText, mirrored for the
    // byte paths: read-only denies; workspace-write requires the canonical
    // target under writableRoots(policy) — the workspace root, /tmp, os.tmpdir()
    // (dsh-sandbox derives exactly that allow-list; imported here is not
    // possible, so the rule is restated, not reinvented).
    async function assertWritableTarget(st, target) {
      const policy = freshPolicy(st)
      // v1.32.7 (F5 fix): a policy without a mode used to mean "no fence at all"
      // (fail-open). The deployment default is the mode the fs sandbox itself
      // falls back to, and read-only is the fail-safe of last resort.
      const mode = (policy && policy.mode) || (sandboxPolicy && sandboxPolicy.defaultMode) || 'read-only'
      if (mode === 'danger-full-access') return target
      if (mode === 'read-only') throw new Error('文件访问被拒绝：read-only 模式不允许写入 [FS_SANDBOX_DENIED]')
      // Re-canonicalize NOW and hand the fresh target back to the caller, which
      // writes to THAT one: the fs sandbox does the same in checkedTarget, so a
      // symlink ancestor swapped between resolve and the mutation cannot slip
      // through the check-here-write-there window.
      const fresh = await fs.resolve(fs.processPath(target))
      const roots = []
      const seen = new Set()
      for (const p of [policy.workspaceRoot, '/tmp', tmpdir()]) {
        if (typeof p !== 'string' || p === '') continue
        let key = p
        try { key = (await fs.resolve(p)).targetKey } catch (e) { key = p }
        if (seen.has(key)) continue
        seen.add(key)
        roots.push(key)
      }
      for (const root of roots) {
        let under = false
        try { under = fs.contains({ targetKey: root, displayPath: root }, fresh) } catch (e) { under = false }
        if (under) return fresh
      }
      throw new Error('文件访问被拒绝：workspace-write 模式下目标不在可写根目录内 [FS_SANDBOX_DENIED]')
    }
    async function doReject(st, f, path, rec) {
      if (!f.base || !f.base.present) {
        // Added file: reject = delete. If it is already gone (agent deleted
        // it after our scan), converge idempotently instead of making the
        // shell fail on a nonexistent path.
        let info
        try { info = await fs.stat(await fs.resolve(joinPath(st.root, path))) } catch (e) { info = undefined }
        if (!info) {
          f.base = cloneEntry(f.cur)
          armBaseline(st, path, f)
          f.decisions.clear()
          f.rev++
          f.justRejected = true
          return
        }
        // v1.33 (F1): refuse unless the agent provably created it, and never
        // delete through a path whose on-disk state already moved on.
        assertDeletable(st, path, info)
        if (f.cur && f.cur.present && f.cur.version !== info.version) throw staleWriteError()
        const snap = rec ? await snapshotForUndo(st, path, rec) : null
        await deleteFile(st, path, info)
        st.created.delete(path)
        f.cur = goneEntry()
        if (snap) { snap.afterVersion = null; rec.files.push(snap) }
      } else if (f.base.content === null && f.base.baselineRef) {
        // v1.31: a TEXT baseline past the in-memory window. Its normalized
        // bytes were mirrored into the session blob dir when it BECAME the
        // baseline, so reject restores from that file — the large-file analogue
        // of writing `base.content` back, and the reason big files can be
        // rejected at all without holding their text in memory.
        const blobPath = join(blobRoot(st.sid), f.base.baselineRef)
        if (!existsSync(blobPath)) throw new Error('无法还原：大文件基线快照已丢失')
        const snap = rec ? await snapshotForUndo(st, path, rec) : null
        // The blob is LF-normalized, so the STORED style is what restores the
        // bytes: the boolean crlf for a uniform file (v1.13.1) and the per-line
        // map for a mixed one (v1.33/F6).
        const blobText = readFileSync(blobPath, 'utf8')
        const live = f.base.eolMap
          ? joinLines(splitLines(blobText), f.base.eol, f.base.crlf, f.base.eolMap)
          : (f.base.crlf ? blobText.split('\n').join('\r\n') : blobText)
        const outcome = await writeFile(st, path, live, guardOf(f.cur))
        const restoredEntry = {
          present: true, content: null, eol: f.base.eol, crlf: f.base.crlf === true, eolMap: f.base.eolMap ?? null,
          version: outcome.version, size: outcome.size !== undefined ? outcome.size : Buffer.byteLength(live, 'utf8'),
          sig: f.base.sig ? { tier: f.base.sig.tier, n: f.base.sig.n, h: f.base.sig.h } : null,
          baselineRef: f.base.baselineRef, baselineBytes: f.base.baselineBytes ?? 0,
          binRef: null, binSize: 0, md: f.base.md === true,
        }
        f.cur = restoredEntry
        // Restored content IS the baseline again: share the same fingerprint and
        // the same blob, so isChanged() reports clean and a second reject still
        // has a restore source.
        f.base = cloneEntry(restoredEntry)
        if (snap) { snap.afterVersion = outcome.version; rec.files.push(snap) }
      } else if (f.base.content === null) {
        // Binary / oversized baseline: restore the byte snapshot taken at
        // baseline time (binaries up to MAX_BACKUP_BYTES only).
        const blobPath = f.base.binRef ? join(blobRoot(st.sid), f.base.binRef) : null
        if (!blobPath || !existsSync(blobPath)) throw new Error('无法还原：文件过大或非文本')
        const target = await fs.resolve(joinPath(st.root, path))
        // v1.33 (F3): this branch has no fs.writeText path (it restores raw
        // bytes), so it re-checks the reviewed version itself before writing.
        const liveInfo = await fs.stat(target)
        if (f.cur && f.cur.present) {
          if (!liveInfo || liveInfo.version !== f.cur.version) throw staleWriteError()
        } else if (liveInfo) {
          throw staleWriteError()
        }
        // v1.34 (F5): fence the byte restore and publish it atomically.
        // v1.32.7: the fence returns the freshly canonicalized target, and THAT
        // is what gets written (and re-stat'ed below).
        const fresh = await assertWritableTarget(st, target)
        const snap = rec ? await snapshotForUndo(st, path, rec) : null
        writeBytesAtomicSync(fs.processPath(fresh), readFileSync(blobPath))
        const info = await fs.stat(fresh)
        f.cur = { present: true, content: null, eol: false, crlf: false, eolMap: null, version: info.version, size: info.size, note: 'binary', binRef: f.base.binRef, binSize: f.base.binSize }
        // Restored content IS the baseline again: align versions so
        // isChanged() reports no diff (binary has no content comparison).
        f.base = { ...cloneEntry(f.base), version: info.version, size: info.size }
        if (snap) { snap.afterVersion = info.version; rec.files.push(snap) }
      } else {
        const snap = rec ? await snapshotForUndo(st, path, rec) : null
        // Write back with the ORIGINAL line endings: normalizing to LF here
        // used to rewrite CRLF files wholesale (one giant spurious diff).
        // v1.33 (F6): a MIXED file is rebuilt through its per-line map instead,
        // so the lines the agent never touched keep the ending they had on disk.
        const baseLines = splitLines(f.base.content)
        const writeContent = f.base.eolMap && f.base.eolMap.length === baseLines.length
          ? joinLines(baseLines, f.base.eol, f.base.crlf, f.base.eolMap)
          : (f.base.crlf ? f.base.content.split('\n').join('\r\n') : f.base.content)
        const outcome = await writeFile(st, path, writeContent, guardOf(f.cur))
        f.cur = { present: true, content: f.base.content, eol: f.base.eol, crlf: f.base.crlf, eolMap: f.base.eolMap ?? null, version: outcome.version, size: outcome.size !== undefined ? outcome.size : writeContent.length, binRef: null, binSize: 0 }
        // Restored content IS the baseline: align versions so isChanged()
        // reports no diff (matters for large files where content comparison
        // is unavailable).
        f.base = { ...cloneEntry(f.base), version: outcome.version, size: outcome.size !== undefined ? outcome.size : writeContent.length }
        if (snap) { snap.afterVersion = outcome.version; rec.files.push(snap) }
      }
      f.decisions.clear()
      f.rev++
      // v1.13: reject rewrites disk content behind the client's back. The
      // next getDiff payload carries justRejected so the client resets the
      // per-file user edit history (unsaved user edits are discarded — their
      // base content was just reverted) instead of trying to reconcile.
      f.justRejected = true
      // v1.15.1: reject wrote disk (restored content or deleted the file),
      // which changes the worktree↔HEAD relationship the VCS badges answer.
      // Reload the tree unconditionally — not only for resurrected files —
      // and drop the cached git snapshot so the reload re-asks git. Note the
      // badge is NOT "cleared" here: baseline ≠ HEAD in general, so the
      // re-query may legitimately show an M (or remove one — when the
      // baseline equals HEAD, as after rejecting a committed-then-edited
      // file). Let git say what is true.
      bumpTree(st)
      invalidateGitCacheFor(st.root)
    }
    // v1.31: arm a just-assigned baseline with its restore source. Text whose
    // content is in memory needs nothing (reject writes `base.content` back);
    // a LARGE text baseline gets its normalized bytes mirrored into the session
    // blob dir. Called right after every `f.base = …` of a PRESENT entry — it is
    // cheap and idempotent (it returns immediately for anything in memory).
    function armBaseline(st, rel, f) {
      if (!f || !f.base || !f.base.present) return
      // v1.31: a content baseline large enough to matter keeps its bytes for the
      // snapshot, taken NOW (the entry is currently the baseline, so this is the
      // only moment the content is guaranteed to be the baseline's).
      bufferBaseline(f.base)
      if (!f.base.sig || f.base.baselineRef || f.base.syncing) return
      void blobSnapshot(st, rel, f.base)
    }
    // Sweep a batch of just-processed paths and give every fingerprint baseline
    // its restore blob. It runs as ONE pass after the scan/refresh loop rather
    // than at each `f.base = …`: a baseline is assigned from several branches
    // (first scan, fold, on-demand load), and missing one of them is exactly how
    // a big file ends up with a fingerprint it cannot restore from.
    function armSeenBaselines(st, rels) {
      for (const rel of rels) {
        const f = st.files.get(rel)
        if (f) armBaseline(st, rel, f)
      }
    }
    async function doAccept(st, f, path) {
      // A binary baseline needs its bytes for a future reject; snapshot them
      // now that this content becomes the new baseline.
      if (f.cur && f.cur.present && f.cur.note === 'binary' && !f.cur.binRef) {
        try {
          const target = await fs.resolve(joinPath(st.root, path))
          const info = await fs.stat(target)
          if (info && info.size <= MAX_BACKUP_BYTES) {
            const bytes = await fs.readBytes(target, undefined, MAX_BACKUP_BYTES)
            const hash = createHash('sha1').update(path).update(String(info.version)).digest('hex')
            const blobPath = join(blobRoot(st.sid), hash)
            if (!existsSync(blobPath)) {
              mkdirSync(blobRoot(st.sid), { recursive: true })
              writeBytesAtomicSync(blobPath, bytes)
            }
            f.cur.binRef = hash
            f.cur.binSize = bytes.length
          }
        } catch (e) {}
      }
      f.base = cloneEntry(f.cur)
      armBaseline(st, path, f)
      // v1.32.7 (F1 hygiene): accepting a created file makes its content the
      // baseline, so the "the agent created this path" proof is spent. Leaving
      // it behind would let a LATER entry for the same path that happens to have
      // an absent baseline (user deletes and re-creates it, then the agent
      // touches it) be deleted on the strength of a stale proof.
      st.created.delete(path)
      f.decisions.clear()
      f.rev++
    }

    // ---------- RPC API ----------
    const api = {
      async listTree(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const rootOverride = args && args.root ? String(args.root) : null
        // Build the tree and decorate it with git VCS annotations (v1.15).
        // The walk collects every visited path so one check-ignore batch can
        // gray out .gitignore-excluded entries; a non-git workspace simply
        // skips the decorations.
        const build = async (rootPath) => {
          const rootTarget = await fs.resolve(rootPath)
          // v1.17: the ignored set exempts gitignored entries from the tree
          // budget; they still render (grayed) with their full children.
          const ignored = await ignoredInfoFor(rootPath)
          const paths = []
          const tree = await treeNode(rootTarget, '', 0, { n: 0 }, paths, ignored)
          if (tree) {
            const git = await gitInfoFor(rootPath, paths)
            if (git) annotateTree(tree, git)
          }
          return tree
        }
        if (rootOverride) {
          const gate = await allowRootOverride(ctx, sid, rootOverride, st.root)
          if (!gate.ok) return gate
          try {
            const tree = await build(rootOverride)
            return { ok: true, root: rootOverride, tree: tree }
          } catch (e) {
            return { ok: false, error: e && e.message ? String(e.message) : String(e) }
          }
        }
        // v1.18: the tree walk itself reflects disk, so a full scan here is
        // only needed to keep the review state fresh (first scan / dirty /
        // 20s failsafe) — not on every tree expansion.
        if (!st.root) await scan(sid)
        else await ensureFresh(st, sid)
        if (st.error) return { ok: false, error: st.error }
        try {
          const tree = await build(st.root)
          return { ok: true, root: st.root, tree: tree }
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      },

      // v1.30: the lazy tree's workhorse — the IMMEDIATE children of one
      // directory ('' = the workspace root). Same node shape as listTree's
      // children (name/type/path/size + git letter + ignored flag) so the
      // client renders both modes with one component, but the request and the
      // payload are bounded to a single level. listTree stays as the fallback
      // for a client running against an older host (fresh client bundle before
      // the host module is reloaded).
      async listDir(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const rootOverride = args && args.root ? String(args.root) : null
        const rawPath = args && args.path !== undefined && args.path !== null ? String(args.path) : ''
        if (rootOverride) {
          // v1.34 (F7): the override needs a live session and a registered root.
          const gate = await allowRootOverride(ctx, sid, rootOverride, st.root)
          if (!gate.ok) return gate
        }
        if (!rootOverride) {
          // Same freshness policy as listTree: the listing itself reflects
          // disk, the scan only keeps the REVIEW state current.
          if (!st.root) await scan(sid)
          else await ensureFresh(st, sid)
          if (st.error) return { ok: false, error: st.error }
        }
        const rootPath = rootOverride || st.root
        if (!rootPath) return { ok: false, error: 'no-workspace' }
        let rel = ''
        if (rawPath !== '' && rawPath !== '.' && rawPath !== './') {
          const norm = normalizeRelPath(rootPath, rawPath)
          if (!norm) return { ok: false, error: 'bad-path' }
          rel = norm
        }
        try {
          const dirTarget = rel ? await fs.resolve(joinPath(rootPath, rel)) : await fs.resolve(rootPath)
          const info = await fs.stat(dirTarget)
          if (!info) return { ok: false, error: 'not-found' }
          if (info.type && info.type !== 'directory') return { ok: false, error: 'not-a-directory' }
          const res = await treeChildren(dirTarget, rel)
          if (res === null) return { ok: false, error: 'list-failed' }
          await decorateChildren(rootPath, rel, res.children)
          return { ok: true, root: rootPath, path: rel, children: res.children, truncated: res.truncated, limit: TREE_DIR_MAX }
        } catch (e) {
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      },

      async getModified(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        // v1.18: precise mutations refresh only their files; the full walk
        // runs on the first scan, the unlocatable-mutation fallback, and the
        // 20s failsafe cadence (ensureFresh).
        await ensureFresh(st, sid)
        if (st.error) return { ok: false, error: st.error }
        return { ok: true, root: st.root, files: await modifiedFiles(st), treeStamp: st.treeStamp, undo: st.lastReject ? { opId: st.lastReject.opId, count: st.lastReject.files.length, ts: st.lastReject.ts, kept: st.lastReject.kept === true } : null }
      },

      // Long-poll wake-up: resolves as soon as an agent mutation (write/edit/
      // shell/pwsh tool result) dirties the session — or immediately when it
      // is already dirty — otherwise after WAIT_MS. The client chains these
      // calls so diff stats update the moment a tool result lands instead of
      // waiting for its 6s fallback poll.
      async wait(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        if (st.baseReady && st.dirty) return { ok: true, changed: true }
        const WAIT_MS = 15000
        const MAX_WAITERS = 4
        return await new Promise((resolve) => {
          let set = waiters.get(sid)
          if (!set) { set = new Set(); waiters.set(sid, set) }
          if (set.size >= MAX_WAITERS) { resolve({ ok: true, changed: false }); return }
          let settled = false
          let h = null
          const finish = (payload) => {
            if (settled) return
            settled = true
            if (h) clearTimeout(h)
            set.delete(finish)
            resolve(payload)
          }
          set.add(finish)
          h = setTimeout(() => finish({ ok: true, changed: false }), WAIT_MS)
        })
      },

      // v1.20: permanently delete one or more sessions (UI: per-row dot menu
      // 删除 + manage-mode batch delete). The client sends {sessionId, cwd?}
      // pairs. Refuses live (attached/running) sessions — their persistence
      // would be recreated by the still-owning fiber; the client disables the
      // current session's delete affordances, and the host guard is the back
      // stop. Removes the session dir, the plugin's own review state and the
      // DSH projection caches get reconciled by the client's list refresh.
      async deleteSessions(args) {
        const raw = args && Array.isArray(args.sessions) ? args.sessions : []
        if (raw.length === 0) return { ok: false, error: 'empty-sessions' }
        const results = []
        for (const item of raw) {
          const sid = item && item.sessionId ? String(item.sessionId) : ''
          if (!SESSION_ID_RE.test(sid)) {
            results.push({ sessionId: sid || null, ok: false, error: 'bad-session-id' })
            continue
          }
          if (sessions.get(sid)) {
            results.push({ sessionId: sid, ok: false, error: 'session-live' })
            continue
          }
          const enc = encodeSegmentOf(sid)
          const candidates = []
          const cwd = item && typeof item.cwd === 'string' ? item.cwd : ''
          if (cwd) {
            try { candidates.push(join(SESSIONS_ROOT, projectKeyOf(cwd), enc)) } catch (e) {}
          }
          // Fallback: scan every bucket for the encoded session dir (covers
          // cwd mismatches and sessions whose header cwd differs from the
          // workspace path the browser reports).
          try {
            for (const entry of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue
              const cand = join(SESSIONS_ROOT, entry.name, enc)
              if (existsSync(cand) && candidates.indexOf(cand) < 0) candidates.push(cand)
            }
          } catch (e) {}
          let deleted = 0
          let lastError = null
          for (const dir of candidates) {
            // Safety net: the removal target must sit EXACTLY one level under
            // the sessions root and its basename must be the encoded id.
            const rel = relative(SESSIONS_ROOT, dir)
            const parts = rel.split(/[\\/]/)
            if (parts.length !== 2 || parts[1] !== enc || parts[0] === '' || parts[0] === '.' || parts[0] === '..') continue
            if (!existsSync(dir)) continue
            // v1.34 (F5 family): rmSync is a direct, unfenced call, so the TEXT
            // check above is not enough — a symlinked or junctioned bucket
            // directory would let it delete outside the sessions root. Re-check
            // the shape on the REALPATH before removing anything.
            const realRoot = (() => { try { return realpathSync(SESSIONS_ROOT) } catch (e) { return SESSIONS_ROOT } })()
            const realDir = (() => { try { return realpathSync(dir) } catch (e) { return dir } })()
            const realParts = relative(realRoot, realDir).split(/[\\/]/)
            if (realParts.length !== 2 || realParts[1] !== enc || realParts[0] === '' || realParts[0] === '.' || realParts[0] === '..') continue
            try {
              rmSync(dir, { recursive: true, force: true })
              deleted++
            } catch (e) {
              lastError = e && e.message ? String(e.message) : String(e)
              break
            }
          }
          // Drop the plugin's own review state for the removed session.
          try { const sf = stateFile(sid); if (existsSync(sf)) rmSync(sf, { force: true }) } catch (e) {}
          try { const sd = join(STATE_DIR, sidSafe(sid)); if (existsSync(sd)) rmSync(sd, { recursive: true, force: true }) } catch (e) {}
          if (deleted === 0) {
            results.push({ sessionId: sid, ok: false, error: lastError || 'not-found' })
          } else {
            results.push({ sessionId: sid, ok: true, deleted: deleted })
          }
        }
        return { ok: true, results: results }
      },

      async getDiff(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        // v1.18: resolve pending mutations precisely (targeted refresh) or by
        // the full-walk fallback; the 20s failsafe walk runs in the background.
        await ensureFresh(st, sid)
        // v1.34 (F2): the client path is validated against the workspace root
        // BEFORE it can address anything (getDiff registers entries on demand, so
        // the read side needs it too). ensureFresh above has resolved st.root.
        const path = relPathArg(st, args)
        if (path === null) return badPath()
        // Single-file freshness check for the OPEN file: one cheap stat that
        // keeps the viewer current even when the mutation targeted another
        // file or came from outside the agent channel (v1.8 fold semantics).
        try {
          const f = st.files.get(path)
          if (f && f.cur) {
            const target = await fs.resolve(joinPath(st.root, path))
            const info = await fs.stat(target)
            const touched = !f.cur.present || !info || f.cur.version !== info.version || f.cur.size !== info.size
            if (touched) {
              const pending = isPending(f)
              const next = await loadFileEntry(st, path, f.cur)
              // v1.29: only a CONTENT difference is a change. Identical text
              // (an editor save with no edits, an identical agent rewrite, a
              // pure CRLF/LF flip) leaves the entry — and therefore `changed`,
              // rev and the client's cached payload — exactly as it was.
              if (entrySame(f.cur, next)) {
                // v1.32.7: same content, moved identity — carry the NEW token
                // onto the entry (adoptIdentity), or every later write to this
                // file is refused as stale with no way to recover.
                adoptIdentity(f.cur, next)
              } else {
                if (f.decisions.size > 0) { f.decisions.clear(); f.rev++ }
                f.cur = next
                f.rev++
                // v1.8 attribution: a non-pending file changed outside the
                // agent channel (the user's own edit) folds into the baseline
                // right away, so the open viewer never flashes a diff that the
                // next scan would silently accept.
                if (!pending && !st.touched.has(path) && st.shellWindow !== true && f.cur.present) {
                  f.base = cloneEntry(f.cur)
                  armBaseline(st, path, f)
                  // v1.32.7 (F1 hygiene): a real baseline now exists for this path.
                  st.created.delete(path)
                  f.decisions.clear()
                  f.rev++
                }
              }
            }
          }
        } catch (e) {}
        if (st.error) return { ok: false, error: st.error }
        let f = st.files.get(path)
        // Files that never went through a scan (created after the last one,
        // or skipped by walk caps) load on demand. Attribution decides their
        // baseline: agent-created → "added" review hunk (reject deletes the
        // file); everything else → folded baseline, plain content view.
        if (!f || !f.cur) {
          try {
            const entry = await loadFileEntry(st, path)
            if (!entry.present) return { ok: true, missing: true }
            if (!f) {
              f = { base: null, cur: null, rev: 0, decisions: new Map() }
              st.files.set(path, f)
              // The map did not know this file: the sidebar tree may not show
              // it yet, so notify the client to reload (a later scan would see
              // no "new" presence change and would not bump again).
              bumpTree(st)
            }
            f.cur = entry
            // v1.8 attribution on demand: agent-created files (in the touched
            // set) enter the review as "added"; anything else — the user's own
            // copy, a build artifact, a download — folds into the baseline
            // silently and just renders its content.
            if (f.base === null) {
              if (st.touched.has(path)) {
                f.base = absentEntry()
                st.touched.delete(path)
              } else {
                f.base = cloneEntry(entry)
                armBaseline(st, path, f)
              }
            }
            f.rev++
            scheduleSave(st)
          } catch (e) {
            return { ok: true, missing: true }
          }
        }
        if (!f.cur) return { ok: true, missing: true }
        // v1.31: note the shape change — a file past MAX_SIG_BYTES now also
        // keeps note:'large' here, but for a different reason than v1.9's
        // markdown path: its size, not its extension, is what stops the load.
        // diffPayload (below) turns that into the honest banner payload.
        // v1.9: large markdown (>512KB scan cap) loads its content ON DEMAND
        // when the file is opened, so the viewer renders the whole document
        // (bounded by MAX_MD_RENDER_BYTES). The entry keeps note:'large' for
        // every other consumer; only the diff payload treats it as renderable.
        if (f.cur.md && f.cur.note === 'large' && f.cur.content === null && f.cur.size <= MAX_SIG_BYTES) {
          try {
            const target = await fs.resolve(joinPath(st.root, path))
            const text = await fs.readText(target)
            if (typeof text === 'string') {
              f.cur.content = text.replace(/\r\n/g, '\n')
              f.cur.crlf = /\r\n/.test(text)
              f.cur.eol = text.endsWith('\n')
              f.cur.eolMap = eolMapOf(text)
              f.rev++
            }
          } catch (e) {}
        }
        const prev = args && args.rev !== undefined && args.rev !== null ? Number(args.rev) : undefined
        const payload = await diffPayload(f, st.root, path, prev)
        // v1.13: root lets the client key its per-file user edit history by
        // (workspace, relative path) — the history then survives closing/
        // reopening the tab and switching sessions within the workspace.
        payload.root = st.root
        // Transient reject marker (consumed once): a reject/undo-reject just
        // rewrote disk content, so the client should reset user edit history
        // for this file rather than reconcile against the new content.
        if (!payload.same) payload.justRejected = f.justRejected === true
        if (f.justRejected) f.justRejected = false
        return payload
      },

      async applyHunk(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const hunkId = args && args.hunkId ? String(args.hunkId) : ''
        const action = args && args.action === 'reject' ? 'reject' : 'accept'
        await ensureFresh(st, sid, { failsafe: false })
        // v1.34 (F2): the client path is validated against the workspace root
        // BEFORE it can address anything (getDiff registers entries on demand, so
        // the read side needs it too). ensureFresh above has resolved st.root.
        const path = relPathArg(st, args)
        if (path === null) return badPath()
        const f = st.files.get(path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        if (f.rev !== Number(args.rev)) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试' }
        const baseLines = await fileLines(st.root, path, f.base)
        const curLines = await fileLines(st.root, path, f.cur)
        const all = computeHunks(baseLines, curLines)
        let hunk = null
        for (const h of all) if (h.id === hunkId) hunk = h
        if (hunk === null) return { ok: false, code: 'stale', message: '修订已变化，请刷新后重试' }
        f.decisions.set(hunkId, action)
        if (action === 'reject') {
          const rec = newUndoRec()
          if (!f.base || !f.base.present) {
            // v1.33 (F1): the same proof requirement as doReject — this branch
            // deletes the whole file, and an absent baseline alone does not mean
            // the agent created it.
            let info
            try { info = await fs.stat(await fs.resolve(joinPath(st.root, path))) } catch (e) { info = undefined }
            if (!info) {
              f.base = cloneEntry(f.cur)
              armBaseline(st, path, f)
              f.decisions.clear()
              f.rev++
              f.justRejected = true
              return await diffPayload(f, st.root, path)
            }
            assertDeletable(st, path, info)
            if (f.cur && f.cur.present && f.cur.version !== info.version) {
              f.decisions.delete(hunkId)
              return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试' }
            }
            const snap = await snapshotForUndo(st, path, rec)
            await deleteFile(st, path, info)
            st.created.delete(path)
            f.cur = goneEntry()
            if (snap) { snap.afterVersion = null; rec.files.push(snap) }
          } else {
            const snap = await snapshotForUndo(st, path, rec)
            const merged = mergeHunks(baseLines, all, f.decisions)
            // v1.33 (F6): the terminator map follows the same splice, so a
            // rejected hunk of a mixed-EOL file does not rewrite the endings of
            // the lines it kept.
            const mergedMap = f.base.eolMap && f.base.eolMap.length === baseLines.length
              ? mergeEolMap(f.base.eolMap, all, f.decisions, f.base.eol, f.base.crlf)
              : null
            const text = joinLines(merged, f.base.eol, f.base.crlf, mergedMap)
            let outcome
            try {
              // v1.33 (F3): the merge is built from in-memory content, so it must
              // only land on the exact version it was computed from.
              outcome = await writeFile(st, path, text, guardOf(f.cur))
            } catch (e) {
              // The decision was already recorded; undo it so the in-memory state
              // still describes the file that is actually on disk.
              f.decisions.delete(hunkId)
              if (isStaleWrite(e)) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试', payload: await diffPayload(f, st.root, path) }
              throw e
            }
            f.cur = { present: true, content: text.replace(/\r\n/g, '\n'), eol: f.base.eol, crlf: f.base.crlf, eolMap: mergedMap, version: outcome.version, size: outcome.size !== undefined ? outcome.size : text.length, binRef: null, binSize: 0 }
            if (snap) { snap.afterVersion = outcome.version; rec.files.push(snap) }
          }
          commitUndo(st, rec)
          // v1.15.1: hunk-reject wrote disk (merged content or deleted the
          // file) → reload the tree and drop the cached git snapshot so the
          // VCS badges re-ask git immediately (same reasoning as doReject).
          bumpTree(st)
          invalidateGitCacheFor(st.root)
        }
        let pendingCount = 0
        for (const h of all) if (!f.decisions.has(h.id)) pendingCount++
        if (pendingCount === 0) {
          f.base = cloneEntry(f.cur)
          armBaseline(st, path, f)
          f.decisions.clear()
        }
        f.rev++
        // v1.18: hunk-reject committed an undo record → persist immediately;
        // accept-only decisions can ride the debounced save.
        scheduleSave(st, action === 'reject')
        return await diffPayload(f, st.root, path)
      },

      // User edit from the file view's inline editor. One line at a time;
      // idx addresses the CURRENT content line (0-based; idx === length
      // appends, which is how the empty-file placeholder types its first
      // line). Semantics: the edit is written to disk immediately. Context
      // lines fold the same edit into the baseline (user edits are NOT
      // counted into the diff and do not disturb pending hunks); edits to
      // agent-ADDED lines stay inside their pending hunk (still counted).
      async applyEdit(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const idx = Number(args.idx)
        // v1.33 (F6): the line text is written back VERBATIM. The old blanket
        // CR strip deleted every lone CR the file contained (a Mac-classic file
        // collapsed into a single line after one keystroke) — a byte the user
        // never touched. The client's line model is LF-normalized already; a
        // stray CR here IS content.
        const text = args && typeof args.text === 'string' ? args.text : ''
        if (!Number.isInteger(idx) || idx < 0) return { ok: false, code: 'stale', message: '编辑位置无效' }
        await ensureFresh(st, sid, { failsafe: false })
        // v1.34 (F2): the client path is validated against the workspace root
        // BEFORE it can address anything (getDiff registers entries on demand, so
        // the read side needs it too). ensureFresh above has resolved st.root.
        const path = relPathArg(st, args)
        if (path === null) return badPath()
        const f = st.files.get(path)
        if (!f || !f.cur || !f.cur.present) return { ok: false, code: 'not-found', message: '文件不存在' }
        if (f.rev !== Number(args.rev)) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试' }
        const baseLines = await fileLines(st.root, path, f.base)
        const curLines = await fileLines(st.root, path, f.cur)
        // v1.31: an unloadable file (binary, or past MAX_SIG_BYTES) is reviewed
        // by hunks but never edited inline — the editor round-trips the WHOLE
        // text, and rebuilding it from no content would rewrite the file.
        if (!hasLines(f.cur) || !hasLines(f.base)) return { ok: false, code: 'no-content', message: '文件内容不可读，无法行内编辑' }
        if (idx > curLines.length) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试' }
        // Edited lines address cur lines only, so they can never be diff OLD
        // (deleted) lines — the client renders those read-only.
        const all = computeHunks(baseLines, curLines)
        let container = null
        for (const h of all) {
          if (idx >= h.newStart && idx < h.newStart + h.newLen) { container = h; break }
        }
        const nextCur = curLines.slice()
        if (idx === curLines.length) nextCur.push(text)
        else nextCur[idx] = text
        // v1.33 (F6): the terminator map follows the same single-line splice, so
        // the untouched lines keep the ending they had on disk. Only an APPEND
        // changes the map: the previously last line gains a terminator and the
        // new last line takes the file's trailing-newline state.
        let nextMap = f.cur.eolMap && f.cur.eolMap.length === curLines.length ? f.cur.eolMap : null
        if (nextMap) {
          const dom = dominantEolChar(nextMap, f.cur.crlf)
          if (idx === curLines.length) nextMap = nextMap.slice(0, nextMap.length - 1) + dom + (f.cur.eol ? dom : 'n')
        }
        if (nextMap && nextMap.length !== nextCur.length) nextMap = null
        if (!container && f.base && f.base.present) {
          // Context line: fold the identical edit into the baseline at the
          // aligned index. Alignment shift = sum of (newLen - oldLen) over
          // hunks at or before this position in cur coordinates.
          let shift = 0
          for (const h of all) { if (h.newStart <= idx) shift += h.newLen - h.oldLen }
          const baseIdx = idx - shift
          if (baseIdx >= 0 && baseIdx <= baseLines.length) {
            baseLines.splice(baseIdx, baseIdx < baseLines.length ? 1 : 0, text)
            // The folded baseline keeps its EOL map only while the two stay
            // index-aligned; otherwise the legacy uniform style is used.
            const foldedMap = f.base.eolMap && f.base.eolMap.length === baseLines.length ? f.base.eolMap : null
            f.base = { ...cloneEntry(f.base), content: joinLines(baseLines, f.base.eol), eolMap: foldedMap }
          }
        }
        // container !== null: the line belongs to a hunk (pending added line,
        // or a decided-accepted line). Either way the edit updates cur only —
        // pending hunks keep counting it, decided hunks stay hidden.
        const newAll = computeHunks(baseLines, nextCur)
        // If the hunk topology changed (merged/split hunks), drop stale
        // decisions rather than misapplying them to reshaped hunks.
        const shapeOf = (h) => h.oldStart + ':' + h.oldLen + ':' + h.newStart + ':' + h.newLen
        if (all.map(shapeOf).join('|') !== newAll.map(shapeOf).join('|')) f.decisions.clear()
        const textOut = joinLines(nextCur, f.cur.eol, f.cur.crlf, nextMap)
        let outcome
        try {
          // v1.33 (F3): the whole file is rebuilt from in-memory content, so it
          // may only replace the exact version that content came from — an
          // unobserved external edit is reported as stale instead of vanishing.
          outcome = await writeFile(st, path, textOut, guardOf(f.cur))
        } catch (e) {
          if (isStaleWrite(e)) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试', payload: await diffPayload(f, st.root, path) }
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
        f.cur = { present: true, content: textOut.replace(/\r\n/g, '\n'), eol: f.cur.eol, crlf: f.cur.crlf, eolMap: nextMap, version: outcome.version, size: outcome.size !== undefined ? outcome.size : textOut.length }
        // changed-flag hygiene: with no pending hunks the file IS the
        // baseline now — align versions so the toolbar hides.
        const newPending = newAll.filter((h) => !f.decisions.has(h.id))
        if (newPending.length === 0 && f.base && f.base.present) {
          f.base = { ...cloneEntry(f.base), version: outcome.version, size: outcome.size !== undefined ? outcome.size : textOut.length }
        }
        f.rev++
        // v1.15.1: user edit wrote disk → the worktree↔HEAD relationship may
        // have changed (editing a committed file makes it M). Reload the tree
        // and drop the cached git snapshot so the badges re-ask git.
        bumpTree(st)
        invalidateGitCacheFor(st.root)
        scheduleSave(st)
        return await diffPayload(f, st.root, path)
      },

      // v1.13: whole-content user save. The client's line editor keeps its
      // own undo/redo model and sends the FULL current content (its own edits
      // applied on top of whatever the file held). Semantics extend v1.3's
      // applyEdit to arbitrary multi-line changes:
      //  * context edits (outside every pending hunk) fold into the baseline
      //    at the shift-aligned index — user edits never enter the review;
      //  * edits inside a pending hunk's new range update cur only, so they
      //    stay visible inside that hunk until accept/reject;
      //  * the write keeps the file's original EOL style (CRLF/eol flags).
      // The rev guard prevents clobbering an agent edit the client has not
      // seen yet; the stale response carries the fresh payload so the client
      // can merge its edits onto the new content and retry.
      async saveUserFile(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const rawLines = Array.isArray(args.lines) ? args.lines : null
        if (!rawLines) return { ok: false, code: 'bad', message: '无效的保存内容' }
        // v1.33 (F6): verbatim, same reasoning as applyEdit — a lone CR in the
        // line text is FILE CONTENT (a Mac-classic line break), not noise to be
        // deleted behind the user's back.
        const lines = rawLines.map((s) => String(s))
        await ensureFresh(st, sid, { failsafe: false })
        // v1.34 (F2): the client path is validated against the workspace root
        // BEFORE it can address anything (getDiff registers entries on demand, so
        // the read side needs it too). ensureFresh above has resolved st.root.
        const path = relPathArg(st, args)
        if (path === null) return badPath()
        if (st.baseReady) {
          // On-disk freshness check (mirrors getDiff's single-file refresh):
          // the editor may have been open across an agent edit the scan has
          // not absorbed yet — refresh this file first so the rev guard below
          // sees the true state instead of silently overwriting agent work.
          const f0 = st.files.get(path)
          if (f0 && f0.cur) {
            try {
              const target = await fs.resolve(joinPath(st.root, path))
              const info = await fs.stat(target)
              if (!info || !f0.cur.present || f0.cur.version !== info.version || f0.cur.size !== info.size) {
                const next = await loadFileEntry(st, path, f0.cur)
                // v1.29: an identical re-read (editor save, EOL-only flip) keeps
                // the entry, so the stale-write guard below still sees the true
                // on-disk state without a spurious rev bump.
                if (!entrySame(f0.cur, next)) {
                  if (f0.decisions.size > 0) { f0.decisions.clear(); f0.rev++ }
                  f0.cur = next
                  f0.rev++
                } else {
                  // v1.32.7: identical content still means the stat identity may
                  // have moved — adopt it so the guard below (and every later
                  // write) compares against the real disk token.
                  adoptIdentity(f0.cur, next)
                }
              }
            } catch (e) {}
          }
        }
        if (st.error) return { ok: false, error: st.error }
        let f = st.files.get(path)
        if (!f || !f.cur) {
          // Never went through a scan: load on demand (same attribution rules
          // as getDiff — agent-created files stay reviewable as "added").
          try {
            const entry = await loadFileEntry(st, path)
            if (!f) {
              f = { base: null, cur: null, rev: 0, decisions: new Map() }
              st.files.set(path, f)
              bumpTree(st)
            }
            f.cur = entry
            if (f.base === null) {
              if (st.touched.has(path)) { f.base = absentEntry(); st.touched.delete(path) } else { f.base = cloneEntry(entry); armBaseline(st, path, f) }
            }
            f.rev++
            scheduleSave(st)
          } catch (e) {
            return { ok: false, code: 'not-found', message: '文件不存在' }
          }
        }
        if (!f.cur || !f.cur.present) return { ok: false, code: 'deleted', message: '文件已被删除' }
        f.justRejected = false
        const wantRev = args && args.rev !== undefined && args.rev !== null ? Number(args.rev) : NaN
        if (Number.isFinite(wantRev) && f.rev !== wantRev) {
          return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试', payload: await diffPayload(f, st.root, path) }
        }
        const baseLines = await fileLines(st.root, path, f.base)
        const curLines = await fileLines(st.root, path, f.cur)
        // v1.31: a whole-content save needs the reference text on both sides —
        // same rule as the inline editor (see applyEdit).
        if (!hasLines(f.cur) || !hasLines(f.base)) return { ok: false, code: 'no-content', message: '文件内容不可读，无法保存' }
        const all = computeHunks(baseLines, curLines)
        const canFold = !!(f.base && f.base.present && f.base.content !== null)
        let newBase = canFold ? baseLines.slice() : null
        // v1.33 (F6): the same op stream that folds this save into the baseline
        // also carries the per-line EOL map onto the new content, so a mixed-EOL
        // file keeps its endings on the lines the user did not touch.
        let saveOps = null
        if (newBase) {
          // v1.22: the user's own save never enters the review — ops fold into
          // the baseline EVERYWHERE, including inside pending hunks. shiftAt
          // maps an OUT-of-hunk cur index onto the aligned baseline index;
          // in-hunk positions get a dedicated mapping (below) because shiftAt
          // overcounts the containing hunk's own delta.
          const shiftAt = new Array(curLines.length + 1).fill(0)
          for (const h of all) shiftAt[h.newStart] += h.newLen - h.oldLen
          for (let i = 1; i < shiftAt.length; i++) shiftAt[i] += shiftAt[i - 1]
          const ops = myersOps(curLines, lines)
          saveOps = ops
          const ctxDel = []
          const ctxIns = []
          let insBefore = 0
          if (ops) {
            const hunkAt = (p) => {
              for (const h of all) if (p >= h.newStart && p < h.newStart + h.newLen) return h
              return null
            }
            for (const op of ops) {
              if (op.t === 'e') continue
              if (op.t === 'd') {
                const curPos = op.i
                const h = hunkAt(curPos)
                if (h) {
                  // cur line p inside hunk h corresponds to base line
                  // h.oldStart + (p − h.newStart) (the hunk's own old range);
                  // insertion-only hunks have no counterpart → no base delete.
                  const baseIdx = h.oldStart + (curPos - h.newStart)
                  if (baseIdx < h.oldStart + h.oldLen) ctxDel.push({ idx: baseIdx })
                } else {
                  ctxDel.push({ idx: curPos - (shiftAt[curPos] || 0) })
                }
              } else {
                const curPos = op.j - insBefore
                insBefore++
                const h = hunkAt(curPos)
                if (h) {
                  // The user's inserted text becomes part of the reference:
                  // insert it into the baseline at the hunk's own old range,
                  // clamped (append for inserts at the tail of a replace).
                  const baseIdx = Math.max(h.oldStart, Math.min(h.oldStart + h.oldLen, h.oldStart + (curPos - h.newStart)))
                  ctxIns.push({ idx: baseIdx, text: lines[op.j] })
                } else {
                  ctxIns.push({ idx: curPos - (shiftAt[curPos] || 0), text: lines[op.j] })
                }
              }
            }
          } else if (all.length === 0) {
            // Diff engine over budget on a user edit: no pending hunks to
            // protect, so the whole rewrite counts as a context edit — fold
            // everything into the baseline (the user owns the new content).
            newBase = lines.slice()
          }
          if (ops) {
            // Apply in reverse index order so earlier splices stay valid.
            ctxDel.sort((x, y) => y.idx - x.idx)
            for (const d of ctxDel) { if (d.idx >= 0 && d.idx < newBase.length) newBase.splice(d.idx, 1) }
            ctxIns.sort((x, y) => y.idx - x.idx)
            for (const ins of ctxIns) {
              const idx = Math.max(0, Math.min(newBase.length, ins.idx))
              newBase.splice(idx, 0, ins.text)
            }
          }
        }
        const saveMap = f.cur.eolMap && f.cur.eolMap.length === curLines.length
          ? remapEolMap(f.cur.eolMap, saveOps, lines.length, f.cur.eol, f.cur.crlf)
          : null
        const textOut = joinLines(lines, f.cur.eol, f.cur.crlf, saveMap)
        let outcome
        try {
          // v1.33 (F3): a whole-content save replaces the file, so it must land
          // on the exact version it was built from (the same guard applyEdit and
          // the reject paths use).
          outcome = await writeFile(st, path, textOut, guardOf(f.cur))
        } catch (e) {
          if (isStaleWrite(e)) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试', payload: await diffPayload(f, st.root, path) }
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
        f.cur = { present: true, content: joinLines(lines, f.cur.eol), eol: f.cur.eol, crlf: f.cur.crlf, eolMap: saveMap, version: outcome.version, size: outcome.size !== undefined ? outcome.size : textOut.length, binRef: null, binSize: 0, md: f.cur.md === true }
        if (newBase !== null) {
          // The folded baseline keeps its own map only while it still lines up
          // with the folded base array (the fold uses shifted base indices, so
          // anything else falls back to the uniform style).
          const baseMap = f.base.eolMap && f.base.eolMap.length === newBase.length ? f.base.eolMap : null
          f.base = { ...cloneEntry(f.base), content: joinLines(newBase, f.base.eol), eolMap: baseMap }
        }
        // Hunk topology changed (merged/split/vanished) → drop stale decisions
        // instead of misapplying them to reshaped hunks (v1.3 rule).
        const newAll = computeHunks(newBase !== null ? newBase : baseLines, lines)
        const shapeOf = (h) => h.oldStart + ':' + h.oldLen + ':' + h.newStart + ':' + h.newLen
        if (all.map(shapeOf).join('|') !== newAll.map(shapeOf).join('|')) f.decisions.clear()
        const newPending = newAll.filter((h) => !f.decisions.has(h.id))
        if (newPending.length === 0 && f.base && f.base.present) {
          // No pending hunks left: the file IS the baseline now — align
          // versions so isChanged() reports clean (same as applyEdit).
          f.base = { ...cloneEntry(f.base), version: outcome.version, size: outcome.size !== undefined ? outcome.size : textOut.length }
        }
        f.rev++
        // v1.15.1: user save wrote disk → the worktree↔HEAD relationship may
        // have changed. Reload the tree and drop the cached git snapshot so
        // the badges re-ask git immediately (same as applyEdit).
        bumpTree(st)
        invalidateGitCacheFor(st.root)
        scheduleSave(st)
        return await diffPayload(f, st.root, path)
      },

      async acceptFile(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        // v1.18: no unconditional walk — accept only needs the review state
        // fresh (first scan / dirty), not a disk re-sync or the 20s failsafe.
        await ensureFresh(st, sid, { failsafe: false })
        // v1.34 (F2): the client path is validated against the workspace root
        // BEFORE it can address anything (getDiff registers entries on demand, so
        // the read side needs it too). ensureFresh above has resolved st.root.
        const path = relPathArg(st, args)
        if (path === null) return badPath()
        const f = st.files.get(path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        await doAccept(st, f, path)
        scheduleSave(st)
        return { ok: true }
      },

      async rejectFile(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        await ensureFresh(st, sid, { failsafe: false })
        // v1.34 (F2): the client path is validated against the workspace root
        // BEFORE it can address anything (getDiff registers entries on demand, so
        // the read side needs it too). ensureFresh above has resolved st.root.
        const path = relPathArg(st, args)
        if (path === null) return badPath()
        const f = st.files.get(path)
        if (!f || !f.cur) return { ok: false, code: 'not-found', message: '文件不存在' }
        let rec = null
        try {
          rec = newUndoRec()
          await doReject(st, f, path, rec)
          commitUndo(st, rec)
          // v1.18: reject is destructive (disk rewritten + undo record) —
          // persist immediately, never ride the debounced save.
          scheduleSave(st, true)
          return { ok: true }
        } catch (e) {
          // A refused or stale reject wrote nothing: drop the pre-reject backup
          // this attempt had already taken so it cannot outlive the operation.
          if (rec) { try { rmSync(join(undoRoot(st.sid), rec.opId), { recursive: true, force: true }) } catch (e2) {} }
          if (isStaleWrite(e)) return { ok: false, code: 'stale', message: '文件已变化，请刷新后重试', payload: await diffPayload(f, st.root, path) }
          return { ok: false, error: e && e.message ? String(e.message) : String(e) }
        }
      },

      async acceptAll(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        await ensureFresh(st, sid, { failsafe: false })
        const list = await modifiedFiles(st)
        let applied = 0
        for (const item of list) {
          const f = st.files.get(item.path)
          if (!f) continue
          await doAccept(st, f, item.path)
          applied++
        }
        // v1.18: one debounced save covers the whole batch (and any accepts
        // that follow within 250ms); the response goes out before the
        // (potentially huge) state serialization runs in the background.
        scheduleSave(st)
        return { ok: true, applied: applied, files: await modifiedFiles(st) }
      },

      async rejectAll(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        await ensureFresh(st, sid, { failsafe: false })
        const list = await modifiedFiles(st)
        const failed = []
        const rec = newUndoRec()
        let applied = 0
        for (const item of list) {
          const f = st.files.get(item.path)
          if (!f) continue
          try {
            await doReject(st, f, item.path, rec)
            applied++
          } catch (e) {
            failed.push({ path: item.path, error: e && e.message ? String(e.message) : String(e) })
          }
        }
        commitUndo(st, rec)
        scheduleSave(st, true)
        return { ok: true, applied: applied, failed: failed, files: await modifiedFiles(st) }
      },

      // Undo the last reject batch: rewrite the pre-reject bytes for every
      // file in the record, unless the file changed again on disk since the
      // reject (version guard — never clobber newer agent work).
      async undoReject(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        if (!st.root) { await scan(sid); if (st.error) return { ok: false, error: st.error } }
        const rec = st.lastReject
        if (!rec) return { ok: false, code: 'no-undo', message: '没有可撤销的拒绝操作' }
        const restored = []
        const skipped = []
        let fenceDenied = false
        for (const item of rec.files) {
          const segs = item.path.split('/')
          if (segs.some(function (s) { return s === '..' || s === '.' || s === '' })) {
            skipped.push({ path: item.path, reason: 'invalid' })
            continue
          }
          const src = join(undoRoot(st.sid), rec.opId, ...segs)
          if (!existsSync(src)) {
            skipped.push({ path: item.path, reason: '备份丢失' })
            continue
          }
          const target = await fs.resolve(joinPath(st.root, item.path))
          let info
          try { info = await fs.stat(target) } catch (e) { info = undefined }
          const expectAbsent = item.afterVersion === null || item.afterVersion === undefined
          if (expectAbsent ? !!info : (!info || info.version !== item.afterVersion)) {
            skipped.push({ path: item.path, reason: '文件已再次变化' })
            continue
          }
          try {
            const bytes = readFileSync(src)
            // v1.34 (F5): same fence + atomic publish as the reject path.
            // v1.32.7: the fence's freshly canonicalized target is the one written.
            const fresh = await assertWritableTarget(st, target)
            writeBytesAtomicSync(fs.processPath(fresh), bytes)
            restored.push(item.path)
            let f = st.files.get(item.path)
            if (!f) {
              f = { base: absentEntry(), cur: null, rev: 0, decisions: new Map() }
              st.files.set(item.path, f)
            }
            f.cur = await loadFileEntry(st, item.path)
            if (f.decisions.size > 0) f.decisions.clear()
            f.rev++
            // v1.13: like reject, undoing a reject rewrites disk content —
            // tell the client to reset this file's user edit history.
            f.justRejected = true
            // v1.18: disk changed under the state → the next resolution must
            // run the full walk (the restore's footprint is unknown), not a
            // stale per-file refresh.
            st.dirty = true
            st.pendingTargets = null
          } catch (e) {
            const msg = e && e.message ? String(e.message) : String(e)
            // v1.32.7 (F5 fix): a sandbox refusal is the ONE skip reason that is
            // transient and environment-caused ("switch the mode and retry"), so
            // it must not consume the record below.
            if (msg.indexOf('FS_SANDBOX_DENIED') >= 0) fenceDenied = true
            skipped.push({ path: item.path, reason: msg })
          }
        }
        // v1.32.7 (F5 fix): a fence refusal wrote NOTHING, so the undo record
        // (the only copy of the pre-reject bytes) has to survive — consuming it
        // turned "read-only denied the undo" into "the undo is gone forever".
        // A skip caused by the file changing again IS a real state move and
        // still ends the record, exactly as before.
        if (restored.length === 0 && fenceDenied) {
          // Mark the record so getModified can tell the client it is still
          // actionable (the undo affordance is otherwise age-bounded).
          rec.kept = true
          return { ok: true, restored: restored, skipped: skipped, kept: true }
        }
        // v1.15.1: any restored file changed disk → reload the tree and drop
        // the cached git snapshot so the VCS badges re-ask git (undo-reject
        // restores the pre-reject bytes, which may differ from HEAD).
        if (restored.length > 0) {
          bumpTree(st)
          invalidateGitCacheFor(st.root)
        }
        try { rmSync(join(undoRoot(st.sid), rec.opId), { recursive: true, force: true }) } catch (e) {}
        st.lastReject = null
        // v1.18: undo clears a persisted record (lastReject) → force-save.
        scheduleSave(st, true)
        return { ok: true, restored: restored, skipped: skipped }
      },

      // ---------- v1.24: integrated terminal ----------
      // One terminal per session, rooted at the session workspace. Every
      // submitted line runs as its OWN child process (`pwsh -Command <line>` /
      // `bash -c <line>`) so the process tree can be killed precisely
      // (Ctrl+C / 停止): a persistent `-Command -` shell cannot be interrupted
      // without killing the shell itself, and a child that reads stdin would
      // swallow the following command lines. `cd` is handled by the host (it
      // moves the terminal's cwd), so the common navigation flow still reads
      // like a shell; a running command keeps a writable stdin so interactive
      // prompts can be answered from the terminal input line.
      async termStart(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const root = await ensureTermRoot(st, sid)
        if (!root) return { ok: false, error: 'no-workspace' }
        const t = termFor(sid, root)
        if (!t.motd) {
          t.motd = TERM_SHELL.name + ' · ' + t.cwd
          if (TERM_SHELL.dialect === 'pwsh') {
            t.motd += '\n每条命令在独立进程中运行；cd 在本终端内保持，Ctrl+C 结束当前进程。'
          } else {
            t.motd += '\nEach line runs in its own process; cd persists here, Ctrl+C ends the running one.'
          }
        }
        return termReadOf(t, 0)
      },
      async termRead(args) {
        const sid = args && args.sessionId ? String(args.sessionId) : ''
        if (!sid) return { ok: false, error: 'no-session' }
        knownSessions.add(sid)
        const t = terms.get(sid)
        if (!t) return { ok: true, started: false, reset: true, text: '', total: 0, busy: false }
        return termReadOf(t, Number(args.after) || 0)
      },
      async termRun(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const root = await ensureTermRoot(st, sid)
        if (!root) return { ok: false, error: 'no-workspace' }
        const t = termFor(sid, root)
        return termExec(st, t, args && typeof args.command === 'string' ? args.command : '', args && args.source === 'run' ? 'run' : 'user')
      },
      async termWrite(args) {
        const t = terms.get(args && args.sessionId ? String(args.sessionId) : '')
        if (!t || !t.busy || !t.child || !t.child.stdin) return { ok: false, error: 'not-running' }
        const text = args && typeof args.text === 'string' ? args.text : ''
        try { t.child.stdin.write(text) } catch (e) { return { ok: false, error: e && e.message ? String(e.message) : String(e) } }
        return { ok: true, ...termInfoOf(t) }
      },
      async termSignal(args) {
        const t = terms.get(args && args.sessionId ? String(args.sessionId) : '')
        if (!t || !t.busy || !t.pid) return { ok: false, error: 'not-running' }
        t.lastKilled = true
        termKillTree(t.pid, args && typeof args.signal === 'string' ? args.signal : 'SIGINT')
        return { ok: true }
      },
      async termClear(args) {
        const t = terms.get(args && args.sessionId ? String(args.sessionId) : '')
        if (!t) return { ok: true }
        t.buf = ''
        t.dropped = t.total
        t.forceReset = true
        t.rev++
        return { ok: true }
      },
      async termClose(args) {
        const sid = args && args.sessionId ? String(args.sessionId) : ''
        const t = terms.get(sid)
        if (!t) return { ok: true }
        terms.delete(sid)
        if (t.pid) termKillTree(t.pid, 'SIGKILL')
        return { ok: true }
      },
      async termDetect(args) {
        const st = requireState(args)
        if (!st) return { ok: false, error: 'no-session' }
        const sid = String(args.sessionId)
        const root = await ensureTermRoot(st, sid)
        if (!root) return { ok: false, error: 'no-workspace' }
        // v1.34 (F2): same validation as every other client path — an odd path
        // here only steers which FILE the run button would run, so it
        // degrades to "no file" (and a plain reason) instead of erroring.
        const activePath = relPathArg(st, args) || ''
        const r = await detectRunTarget(st, activePath)
        return { ok: true, root: root, shell: TERM_SHELL.name, path: activePath, candidates: r.candidates, reason: r.reason || null }
      },
    }

    // ---------- v1.24: terminal engine ----------
    const TERM_MAX_CHARS = 400 * 1024
    const TERM_COLOR_ENV = {
      FORCE_COLOR: '1',
      CLICOLOR_FORCE: '1',
      COLORTERM: 'truecolor',
      TERM: 'xterm-256color',
      PY_COLORS: '1',
      PYTHONIOENCODING: 'utf-8',
      npm_config_color: 'always',
    }
    // PowerShell's default pipe encoding is the OEM code page; DSH's own
    // pwsh-local prepends the same encoding preamble so non-ASCII output
    // survives. `$ProgressPreference` silences the module-autoload progress
    // record, which Windows PowerShell 5.1 otherwise serializes to stderr as
    // CLIXML noise on every invocation.
    const PS_SCRIPT_PRE = '$ProgressPreference = "SilentlyContinue"\n'
      + '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'
      + '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'
    // Exact exit code for the command above: `$?` is False after a native
    // command that returned non-zero (a cmdlet error also makes it False), and
    // `$LASTEXITCODE` then carries the native code. The capture lives on its
    // OWN lines so a trailing `# comment` cannot swallow it.
    const PS_SCRIPT_TAIL = '\n$__dshfe_ok = $?\n'
      + '$__dshfe_code = 0\n'
      + 'if (-not $__dshfe_ok) { if ($LASTEXITCODE -is [int]) { $__dshfe_code = $LASTEXITCODE } else { $__dshfe_code = 1 } }\n'
      + 'exit $__dshfe_code\n'
    // Each command runs from a generated script file instead of a `-Command`
    // string: PowerShell 5.1's own command-line parser mangles a quoted
    // `-Command` argument (Node escapes inner `"` as `\"`, which PS re-parses),
    // and `-EncodedCommand` routes the error stream through CLIXML. A UTF-8
    // BOM script is the only transport that survives arbitrary user text —
    // quotes, parentheses, Chinese, multi-line blocks — with clean stderr and
    // a faithful exit code.
    const TERM_TMP_DIR = join(tmpdir(), 'dsh-file-edit-term-' + process.pid)
    const terms = new Map()

    function termFileExists(p) {
      try { return existsSync(p) } catch (e) { return false }
    }
    // Mirror of dsh-pwsh-local resolve.ts: PowerShell 7 install → PATH pwsh.exe
    // → Windows PowerShell 5.1. No shell service dependency: a user-facing
    // terminal must not be confined by the agent's sandbox policy.
    function resolveTermShell() {
      if (process.platform === 'win32') {
        const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
        const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
        const candidates = [join(programFiles, 'PowerShell', '7', 'pwsh.exe')]
        for (const entry of (process.env.PATH ?? '').split(';')) {
          const trimmed = entry.trim().replace(/^"|"$/g, '')
          if (trimmed.length > 0) candidates.push(join(trimmed, 'pwsh.exe'))
        }
        candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
        for (const candidate of candidates) {
          if (termFileExists(candidate)) {
            const legacy = /powershell\.exe$/i.test(candidate)
            return { exe: candidate, name: legacy ? 'Windows PowerShell 5.1' : 'PowerShell 7', dialect: 'pwsh' }
          }
        }
        return { exe: 'pwsh', name: 'pwsh', dialect: 'pwsh' }
      }
      const sh = process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : 'bash'
      return { exe: sh, name: sh.split('/').pop() || sh, dialect: 'bash' }
    }
    const TERM_SHELL = resolveTermShell()
    // Build the exact invocation for one command. `args` NEVER repeats the
    // executable (Node's spawn takes the executable separately); passing it
    // again made PowerShell re-launch itself as a child process, which then
    // reported only its own 0/1 instead of the command's exit code.
    // pwsh gets a generated script file (path returned so the caller can clean
    // it up and scrub it from output); bash takes the command text directly,
    // which has no re-quoting hazard.
    function termSpec(t, command) {
      if (TERM_SHELL.dialect !== 'pwsh') return { exe: TERM_SHELL.exe, args: ['-c', command], script: null }
      mkdirSync(TERM_TMP_DIR, { recursive: true })
      t.scriptSeq = (t.scriptSeq || 0) + 1
      const file = join(TERM_TMP_DIR, 'cmd-' + t.scriptSeq + '.ps1')
      // UTF-8 BOM: without it Windows PowerShell 5.1 reads the file as ANSI and
      // garbles non-ASCII command text.
      writeFileSync(file, '\uFEFF' + PS_SCRIPT_PRE + command + PS_SCRIPT_TAIL, 'utf8')
      return {
        exe: TERM_SHELL.exe,
        args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
        script: file,
      }
    }
    function termEnv() {
      const env = Object.assign({}, process.env, TERM_COLOR_ENV)
      if (env.NO_COLOR !== undefined) delete env.NO_COLOR
      return env
    }
    async function ensureTermRoot(st, sid) {
      if (st.root) return st.root
      const r = resolveSession(sid)
      if (r && !r.error && r.root) st.root = r.root
      return st.root
    }
    function termFor(sid, root) {
      let t = terms.get(sid)
      if (!t) {
        t = {
          sid, root: root || null, cwd: root || null,
          child: null, pid: 0, busy: false, command: null, exitCode: null,
          startedAt: 0, endedAt: 0, lastKilled: false,
          buf: '', dropped: 0, total: 0, rev: 0, forceReset: false, motd: '',
          scriptSeq: 0, scrubFrom: null, scrubTo: '',
        }
        terms.set(sid, t)
      }
      if (root && t.root !== root) {
        t.root = root
        if (!t.busy) t.cwd = root
      }
      return t
    }
    function termAppend(t, text) {
      if (!text) return
      // The generated script path shows up in PowerShell error records
      // ("At C:\...\cmd-3.ps1:4 char:1"); present it as the user's command.
      if (t.scrubFrom && text.indexOf(t.scrubFrom) >= 0) text = text.split(t.scrubFrom).join(t.scrubTo)
      t.buf += text
      t.total += text.length
      if (t.buf.length > TERM_MAX_CHARS) {
        const cut = t.buf.length - TERM_MAX_CHARS
        t.buf = t.buf.slice(cut)
        t.dropped += cut
      }
      t.rev++
    }
    function termInfoOf(t) {
      return {
        ok: true,
        sessionId: t.sid,
        root: t.root,
        cwd: t.cwd,
        shell: TERM_SHELL.name,
        shellPath: TERM_SHELL.exe,
        busy: t.busy,
        command: t.command,
        exitCode: t.exitCode,
        total: t.total,
        pid: t.pid,
        rev: t.rev,
        eol: process.platform === 'win32' ? '\r\n' : '\n',
      }
    }
    function termReadOf(t, after) {
      let reset = false
      let text = ''
      if (t.forceReset || after < t.dropped || after > t.total) {
        reset = true
        text = t.buf
        t.forceReset = false
      } else {
        text = t.buf.slice(after - t.dropped)
      }
      return { ...termInfoOf(t), started: true, reset, text, dropped: t.dropped, motd: t.motd }
    }
    // `cd` is the one piece of shell state worth keeping across the per-command
    // processes: the host resolves it, validates the target and moves the
    // terminal's cwd. Compound lines (`cd a && b`) are left to the shell so a
    // real command is never mistaken for navigation.
    function termCdTarget(t, line) {
      const m = /^\s*(?:cd|chdir|set-location|sl|pushd)\b\s*(.*)$/i.exec(line)
      if (!m) return null
      let raw = (m[1] || '').trim()
      if (/[;&|]/.test(raw)) return null
      const base = t.cwd || t.root || process.cwd()
      if (raw === '' || raw === '~') raw = t.root || base
      else if (raw.startsWith('~')) raw = homedir() + raw.slice(1)
      raw = raw.replace(/^['"]|['"]$/g, '')
      if (raw === '') return null
      const dir = isAbsolute(raw) ? raw : resolvePath(base, raw)
      try {
        if (!existsSync(dir)) return { error: '目录不存在: ' + dir }
        if (!statSync(dir).isDirectory()) return { error: '不是目录: ' + dir }
      } catch (e) {
        return { error: '无法进入目录: ' + (e && e.message ? String(e.message) : String(e)) }
      }
      return { dir }
    }
    function termKillTree(pid, signal) {
      if (!pid) return
      if (process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.on('error', () => {})
        } catch (e) {}
        return
      }
      const sig = signal === 'SIGKILL' ? 'SIGKILL' : signal
      try { process.kill(-pid, sig) } catch (e) {
        try { process.kill(pid, sig) } catch (e2) {}
      }
      // Escalate: a process that ignores the polite signal must not pin the
      // terminal in RUNNING forever.
      const timer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL') } catch (e) { try { process.kill(pid, 'SIGKILL') } catch (e2) {} }
      }, 4000)
      if (timer.unref) timer.unref()
    }
    function termExec(st, t, command, source) {
      if (t.busy) return { ok: false, error: 'busy' }
      const line = String(command == null ? '' : command).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '')
      if (line.trim() === '') return { ok: true, skipped: true, ...termInfoOf(t) }
      termAppend(t, '\x1b[2m$ \x1b[0m' + line + '\n')
      const cd = termCdTarget(t, line)
      if (cd) {
        if (cd.error) {
          termAppend(t, '\x1b[31m' + cd.error + '\x1b[0m\n')
        } else {
          t.cwd = cd.dir
          termAppend(t, '\x1b[2m' + cd.dir + '\x1b[0m\n')
        }
        return { ok: true, ...termInfoOf(t) }
      }
      let child
      let spec
      try {
        spec = termSpec(t, line)
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e)
        termAppend(t, '\x1b[31m[无法生成命令脚本] ' + msg + '\x1b[0m\n')
        return { ok: false, error: msg }
      }
      t.scrubFrom = spec.script
      t.scrubTo = '<命令>'
      try {
        child = spawn(spec.exe, spec.args, {
          cwd: t.cwd || t.root || process.cwd(),
          env: termEnv(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          // POSIX: one process group per command so a signal reaches the whole
          // tree (npm run dev → node → ...), not just the shell wrapper.
          detached: process.platform !== 'win32',
        })
      } catch (e) {
        const msg = e && e.message ? String(e.message) : String(e)
        if (spec.script) { try { rmSync(spec.script, { force: true }) } catch (e2) {} }
        termAppend(t, '\x1b[31m[启动失败] ' + msg + '\x1b[0m\n')
        return { ok: false, error: msg }
      }
      t.child = child
      t.pid = child.pid || 0
      t.busy = true
      t.command = line
      t.exitCode = null
      t.lastKilled = false
      t.startedAt = Date.now()
      if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => termAppend(t, d)) }
      if (child.stderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => termAppend(t, d)) }
      if (child.stdin) child.stdin.on('error', () => {})
      child.on('error', (e) => {
        termAppend(t, '\x1b[31m[启动失败] ' + (e && e.message ? String(e.message) : String(e)) + '\x1b[0m\n')
      })
      child.on('close', (code, signal) => {
        if (t.child !== child) return
        t.child = null
        t.pid = 0
        t.busy = false
        t.command = null
        t.exitCode = typeof code === 'number' ? code : null
        t.endedAt = Date.now()
        if (spec.script) { try { rmSync(spec.script, { force: true }) } catch (e) {} }
        t.scrubFrom = null
        if (t.lastKilled) termAppend(t, '\x1b[33m[已中断]\x1b[0m\n')
        else if (t.exitCode !== null && t.exitCode !== 0) termAppend(t, '\x1b[31m[退出代码 ' + t.exitCode + ']\x1b[0m\n')
        else if (signal) termAppend(t, '\x1b[33m[信号 ' + signal + ']\x1b[0m\n')
        // A terminal command is a USER action: its file changes fold into the
        // baseline (never the review), but mutating commands still refresh the
        // tree/modified list so build output and installs show up right away.
        if (source === 'run' || MUTATING_SHELL_RE.test(line) || MUTATING_GIT_RE.test(line)) {
          if (st && st.baseReady) {
            st.dirty = true
            st.mutationStamp = (st.mutationStamp || 0) + 1
            invalidateGitCacheFor(st.root)
            bumpTree(st)
            scheduleNotify(st.sid, 300)
          }
        }
      })
      return { ok: true, ...termInfoOf(t) }
    }

    // ---------- v1.24: run-target detection ----------
    // v1.32.9: the run button runs THE FILE THAT IS OPEN — nothing else.
    //
    // The previous detector scanned the project for an entry point (npm scripts,
    // manage.py, Gradle/Maven/Cargo/Go/.NET/Make/PHP/Ruby/Compose, and the entry
    // names main.py/app.py/run.py/… ) and ranked that ABOVE the active file.
    // `activePath` was consulted only inside an `out.length === 0` fallback, so a
    // project with any recognizable entry never reached it: opening `DEMO_UI.py`
    // in ECR-filing-automation (which also has `run.py`) and pressing 运行
    // executed `run.py`. Project-entry detection is gone by decision; what
    // remains is the half the button genuinely needs — resolving the RUNNER for
    // ONE file, with the project-local runtime (.venv, runtime/python/python.exe,
    // a portable node, …) preferred over PATH.
    function termQuote(s) {
      if (TERM_SHELL.dialect === 'pwsh') return "'" + String(s).replace(/'/g, "''") + "'"
      return "'" + String(s).replace(/'/g, "'\\''") + "'"
    }
    // Extension → the runner that has to be resolved before the file can run.
    const RUN_EXT_HINT = '.py / .js / .mjs / .cjs / .ts / .ps1 / .sh'
    const RUN_KINDS = {
      py: 'python',
      js: 'node', mjs: 'node', cjs: 'node',
      ts: 'tsx', mts: 'tsx', cts: 'tsx',
      ps1: 'pwsh', sh: 'bash',
    }
    // A binary (or non-UTF-8) file that merely carries a script extension must not
    // be "run". `fs.readText` refuses exactly that class (NUL byte / invalid UTF-8
    // → FS_NOT_TEXT), so one read doubles as the check. Past this size the probe
    // is skipped: a multi-megabyte script is still a script.
    const RUN_PROBE_MAX_BYTES = 1024 * 1024

    // Returns { candidates, reason }: ONE candidate when the open file can be
    // run, otherwise none plus the sentence the client shows on its greyed button.
    // Zero or one on purpose — with no project scanning there is no second target
    // to choose between, which is why the picker is gone with it.
    async function detectRunTarget(st, activePath) {
      const root = st.root
      const none = (reason) => ({ candidates: [], reason: reason })
      const rel = String(activePath || '').replace(/\\/g, '/').replace(/^\/+/, '')
      if (rel.length === 0) return none('没有打开的文件')
      if (isAbsolute(rel) || rel.split('/').indexOf('..') >= 0) return none('文件不在工作区内')
      const segs = rel.split('/').filter((s) => s.length > 0)
      const name = segs.length > 0 ? segs[segs.length - 1] : ''
      const dot = name.lastIndexOf('.')
      const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
      const kind = Object.prototype.hasOwnProperty.call(RUN_KINDS, ext) ? RUN_KINDS[ext] : null
      if (!kind) return none('当前文件不是可运行的程序文件（' + RUN_EXT_HINT + '）')
      let rootTarget
      try { rootTarget = await fs.resolve(root) } catch (e) { return none('无法读取工作区') }
      let entries = []
      try { entries = await fs.listDir(rootTarget) } catch (e) { entries = [] }
      const files = new Set()
      const dirs = new Set()
      for (const e of entries) { if (e.type === 'directory') dirs.add(e.name); else files.add(e.name) }
      const has = (n) => files.has(n)
      const hasDir = (n) => dirs.has(n)
      const existsRel = async (r2) => { try { return !!(await fs.stat(await fs.resolve(joinPath(root, r2)))) } catch (e) { return false } }
      const firstExisting = async (rels) => { for (const r2 of rels) if (await existsRel(r2)) return r2; return null }
      const localExe = (r2) => (TERM_SHELL.dialect === 'pwsh' ? '& ' : '') + '"' + joinPath(root, r2) + '"'
      // The file itself is verified BEFORE any runner is resolved: a directory (or
      // a special entry) named like a script must never become a target. This is
      // the v1.32.8 lesson — "this name exists" is not "this is runnable".
      const abs = joinPath(root, rel)
      let info = null
      try { info = await fs.stat(await fs.resolve(abs)) } catch (e) { info = null }
      if (!info || info.type !== 'file') return none('文件不存在或不是普通文件')
      if (info.size <= RUN_PROBE_MAX_BYTES) {
        try { await fs.readText(await fs.resolve(abs)) } catch (e) { return none('二进制文件不可运行') }
      }
      // ---- project-local runtimes (v1.25) ----
      // "Local first" has to mean the RUNTIME, not just the script: a bare
      // `python`/`node`/`bash` is resolved by the child shell against PATH,
      // i.e. the host process's environment — the project folder is never
      // consulted. So every runtime this detector emits is looked up inside
      // the workspace first and, when found, invoked by absolute path.
      //
      // Search order (first hit wins):
      //   1. dependency-carrying environments: .venv / venv / env (+ Scripts|bin)
      //   2. the project root itself
      //   3. bin / Scripts / tools / runtime / .python / node_modules/.bin / vendor
      //   4. root-level folders that are a Python distribution (python/,
      //      python3.12/, miniconda3/, …) plus their Scripts|bin subdirs
      //   5. folders of the same shape found under an OPPOSITE-named folder in
      //      the root (`dist_package/python/` in a repo called `BM_automation`)
      //      or beside the file being run (`dist_package/src/x.py` with the
      //      runtime at `dist_package/python/`) — see the discovery below
      // A venv outranks a stray `python.exe` in the root because it carries the
      // project's installed packages; everything here outranks PATH.
      const EXE_DIRS = ['.venv', 'venv', 'env']
      const PLAIN_EXE_DIRS = ['bin', 'Scripts', 'tools', 'runtime', '.python', 'node_modules/.bin']
      const VENDOR_EXE_DIRS = ['vendor']
      // Root-level folders that are (or contain) a Python distribution:
      // portable/embeddable Python, `python3.12/`, conda envs, WinPython, pypy.
      const PY_DIR_RE = /^(?:py|python|pyenv|conda|miniconda|anaconda|winpython|pypy)[\w.-]*$/i
      const exeNames = (base) => (process.platform === 'win32' ? [base + '.exe', base] : [base])
      const pyExeNames = process.platform === 'win32'
        ? ['python.exe', 'python3.exe', 'python', 'python3']
        : ['python3', 'python']
      // Two caches on purpose: the exe-directory cache lowercases names (so
      // `Python.EXE` still matches on Windows), while the root cache must keep
      // the on-disk case because those names are used to build paths.
      const dirCache = new Map()
      const rootCache = new Map()
      // One listDir per directory (memoized): cheaper and race-free compared
      // with stat-ing every candidate path, and a missing directory is simply
      // an empty map.
      //
      // v1.32.8: the value is the entry TYPE, not just its presence. A bare
      // name match used to accept a DIRECTORY as an executable, which is how
      // `runtime/python/` (the embeddable-interpreter container) became the
      // command `& "<root>\runtime\python"` — PowerShell answers that with a
      // CommandNotFoundException ("不是 cmdlet、函数、脚本文件或可运行程序"),
      // as if the path were a typo. The type is the difference between "this
      // name exists" and "this name is runnable".
      const dirNames = async (rel) => {
        if (dirCache.has(rel)) return dirCache.get(rel)
        const names = new Map()
        try {
          const target = rel === '.' ? rootTarget : await fs.resolve(joinPath(root, rel))
          const entries2 = await fs.listDir(target)
          for (const e of entries2) names.set(String(e.name).toLowerCase(), e.type)
        } catch (e) { /* missing / unreadable → empty */ }
        dirCache.set(rel, names)
        return names
      }
      // Case-preserving listing of a workspace-relative directory, `null` when
      // it is not a directory. Used only for runtime-folder discovery.
      const dirEntryNames = async (rel) => {
        if (rootCache.has(rel)) return rootCache.get(rel)
        let names = null
        try {
          const target = rel === '.' ? rootTarget : await fs.resolve(joinPath(root, rel))
          const st2 = await fs.stat(target)
          if (st2 && st2.type === 'directory') {
            names = []
            for (const e of await fs.listDir(target)) {
              if (e.type === 'directory') names.push(String(e.name))
            }
          }
        } catch (e) { names = null }
        rootCache.set(rel, names)
        return names
      }
      // Every directory that may hold a project-local runtime, in priority
      // order.
      const exeRels = []
      const addExeRel = (rel) => {
        const clean = String(rel).replace(/\/+$/, '')
        if (clean === '' || clean === '.') { if (exeRels.indexOf('.') < 0) exeRels.push('.'); return }
        if (exeRels.indexOf(clean) < 0) exeRels.push(clean)
      }
      // A folder shaped like a Python distribution is picked up wherever it is
      // found: `dist_package/python/python.exe` is a packaging convention
      // (PyInstaller/embeddable runtime shipped next to the sources), not a
      // root-level one, so the name heuristic travels with the directory.
      const addPyDir = (base, name) => {
        const rel = base === '' ? name : base + '/' + name
        addExeRel(rel)
        addExeRel(rel + '/Scripts')
        addExeRel(rel + '/bin')
      }
      const collectPyDirs = async (base, names) => {
        if (!names) return
        for (const d of names) if (PY_DIR_RE.test(d)) await addPyDir(base, d)
      }
      for (const d of EXE_DIRS) {
        if (!hasDir(d) && !has(d)) continue
        addExeRel(d)
        addExeRel(d + '/Scripts')
        addExeRel(d + '/bin')
      }
      addExeRel('.')
      for (const d of PLAIN_EXE_DIRS.concat(VENDOR_EXE_DIRS)) if (hasDir(d)) addExeRel(d)
      // 4. root-level Python distributions.
      await collectPyDirs('', Array.from(dirs))
      // 5. The same shape one level deeper, in both directions:
      //      root/<X>/python/            (sibling folder in the root)
      //      <root of the active file>/python/   (its own folder)
      // For `dist_package/src/BM_Specialist.py` that covers both
      // `dist_package/python/` (parent of the file's own folder) and
      // `<workspace>/python/`.
      {
        const rel2 = String(activePath || '').replace(/\\/g, '/').replace(/^\/+/, '')
        if (rel2.length > 0 && !isAbsolute(rel2) && rel2.split('/').indexOf('..') < 0) {
          const segs = rel2.split('/').filter((s) => s.length > 0)
          const dirsOfFile = segs.slice(0, -1)
          const nested = new Set()
          for (let k = 0; k < dirsOfFile.length; k++) nested.add(dirsOfFile.slice(0, k).join('/'))
          for (const x of Array.from(dirs)) nested.add(x)
          for (const base of Array.from(nested)) {
            if (base === '') continue
            // `dirEntryNames` is the directory check: `null` means "not a
            // directory / unreadable", so it doubles as the stat.
            const inner = await dirEntryNames(base)
            if (!inner) continue
            if (PY_DIR_RE.test(base.split('/').pop())) continue
            await collectPyDirs(base, inner)
          }
        }
      }
      // 6. v1.32.8: the same distribution shape INSIDE a runtime container.
      // `runtime/python/python.exe` (an embeddable CPython unpacked into a
      // project folder) is the packaging convention this repo's own runtime
      // uses, and `PLAIN_EXE_DIRS` listing `runtime` is what the detector was
      // intended to find. The container name itself tells us nothing, so the
      // decision has to be made from its CONTENTS — which is why this runs
      // after `exeRels` is populated and before anything is resolved.
      for (const rel of exeRels.slice()) {
        const inner = await dirEntryNames(rel)
        if (!inner) continue
        if (PY_DIR_RE.test(String(rel).split('/').pop())) continue
        await collectPyDirs(rel, inner)
      }
      // First match wins across the ordered directories; `names` are tried in
      // the order given inside each directory.
      //
      // v1.32.8: three rules keep a name collision from producing an unrunnable
      // command.
      //   * `accept` takes only entries whose type can actually be executed:
      //     `file` and `symlink` (fs reports the FOLLOWED type, so POSIX
      //     `.venv/bin/python` — a link to a real interpreter — still reads as
      //     `file`), never `directory`.
      //   * Pass 1 prefers an EXTENSIONED name. `pyExeNames` carries the bare
      //     `python`/`python3` for POSIX `bin/` shims; on Windows that bare name
      //     is what matched `runtime/python/`. A `python.exe` anywhere in the
      //     search order now outranks a bare name.
      //   * Pass 2 relaxes the name set AND the type filter, then `resolveExe`
      //     stats the winner and refuses a non-file. The stats never substitute
      //     for pass 1: these candidates are the run commands' last resort.
      const isRunnableType = (t) => t === 'file' || t === 'symlink'
      const findLocalExe = async (names) => {
        const search = async (candidates, accept) => {
          for (const rel of exeRels) {
            const present = await dirNames(rel)
            if (present.size === 0) continue
            for (const n of candidates) {
              const type = present.get(n.toLowerCase())
              if (type === undefined || !accept(type)) continue
              return { rel: rel === '.' ? n : rel + '/' + n }
            }
          }
          return null
        }
        const extensioned = names.filter((n) => n.indexOf('.') >= 0)
        return (await search(extensioned.length > 0 ? extensioned : names, isRunnableType))
          || (await search(names, () => true))
      }
      // `& ` is required by PowerShell for a quoted path; harmless on POSIX.
      const exeCommand = (absPath) => (TERM_SHELL.dialect === 'pwsh' ? '& ' : '') + '"' + absPath + '"'
      // A local hit only counts when the ABSOLUTE path really is a file. This
      // is the terminal guard for the v1.32.8 defect: a directory (or a special
      // entry) reached through the looser pass-2 name match must degrade to the
      // PATH fallback instead of being emitted as `& "<dir>" run.py`. `resolve`
      // + `stat` also follow a link, so a venv shim passes and a context
      // directory does not.
      const isRealFileTarget = async (abs) => {
        try {
          const info = await fs.stat(await fs.resolve(abs))
          return !!info && info.type === 'file'
        } catch (e) { return false }
      }
      // Resolve one runtime once, then reuse: `command` is either the local
      // absolute path or the bare global name, `source` drives the 本地/全局
      // badge and the local-first ranking, `note` explains it in the picker.
      const resolveExe = async (names, fallback) => {
        const found = await findLocalExe(names)
        if (found) {
          const abs = joinPath(root, found.rel)
          if (await isRealFileTarget(abs)) {
            return { command: exeCommand(abs), source: 'local', note: found.rel, label: found.rel }
          }
        }
        return { command: fallback, source: 'global', note: '', label: fallback }
      }
      const noteOf = (r) => (r.note ? '本地 ' + r.note : '全局 PATH')

      // ---- the command, for this one file ----
      // Every path here is ABSOLUTE: the terminal's cwd follows the user's own
      // `cd`, so a relative script path would silently point at the wrong place.
      const quoted = termQuote(abs)
      const mkCand = (id, label, command, source, note, kindName) => ({
        id: id,
        label: label,
        command: command,
        kind: kindName,
        source: source,
        detail: '当前文件 · ' + (note ? '本地 ' + note : '全局 PATH'),
        // Exactly one target exists, so the client runs it without asking.
        primary: true,
      })
      const mkRunner = (id, go, kindName) => mkCand(id, go.label + ' ' + name, go.command + ' ' + quoted, go.source, go.note, kindName)
      if (kind === 'python') {
        const pyRun = await resolveExe(pyExeNames, process.platform === 'win32' ? 'python' : 'python3')
        return { candidates: [mkRunner('py:active', pyRun, 'python')], reason: null }
      }
      if (kind === 'node') {
        const nodeRun = await resolveExe(exeNames('node'), 'node')
        return { candidates: [mkRunner('node:active', nodeRun, 'node')], reason: null }
      }
      if (kind === 'tsx') {
        // TypeScript needs the project-local tsx: there is no global fallback
        // worth trusting, and a bare `node x.ts` has never worked.
        const tsx = await firstExisting(['node_modules/.bin/tsx.cmd', 'node_modules/.bin/tsx'])
        if (!tsx) return none('运行 .ts 需要项目本地的 tsx（node_modules/.bin/tsx）')
        return { candidates: [mkCand('tsx:active', tsx + ' ' + name, localExe(tsx) + ' ' + quoted, 'local', tsx, 'node')], reason: null }
      }
      if (kind === 'pwsh') {
        if (TERM_SHELL.dialect !== 'pwsh') return none('当前终端不是 PowerShell，无法直接运行 .ps1')
        return { candidates: [mkCand('ps1:active', name, '& ' + quoted, 'local', rel, 'script')], reason: null }
      }
      const bashRun = await resolveExe(exeNames('bash'), 'bash')
      return { candidates: [mkRunner('sh:active', bashRun, 'script')], reason: null }
    }

    // ---------- HTTP carrier ----------
    const route = webServer.register({
      kind: 'prefix',
      path: '/dsh-file-edit',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET' && req.url && req.url.startsWith('/dsh-file-edit/events')) {
            handleSse(req, res)
            return
          }
          if (req.method !== 'POST' || req.url !== '/dsh-file-edit/api') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'not found' }))
            return
          }
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          let body
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'bad json' }))
            return
          }
          const method = body && typeof body.method === 'string' ? body.method : ''
          const handler = api[method]
          if (typeof handler !== 'function') {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'no such method: ' + method }))
            return
          }
          const result = await handler(body.args && typeof body.args === 'object' ? body.args : {})
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result ?? { ok: true }))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: e && e.message ? String(e.message) : String(e) }))
        }
      },
    })
    ctx.effect(() => route, 'dsh-file-edit: web route')

    // Wake pending long-polls on teardown so no held request outlives the
    // plugin fiber, and drop coalescing timers.
    ctx.effect(() => () => {
      for (const [, set] of waiters) {
        for (const resolve of set) { try { resolve({ ok: true, changed: false }) } catch (e) {} }
        set.clear()
      }
      waiters.clear()
      for (const [, set] of sseClients) {
        for (const res of set) { try { res.destroy() } catch (e) {} }
        set.clear()
      }
      sseClients.clear()
      for (const [, h] of notifyTimers) clearTimeout(h)
      notifyTimers.clear()
      // v1.18: flush any debounced state saves so a stop/update cannot drop
      // the last accept/reject/scan changes.
      // v1.32.3: the flush must reach DISK before the fiber ends, so it always
      // uses the synchronous path. That write also supersedes any queued async
      // generation, whose temp file would otherwise be published AFTER this
      // flush and resurrect the older state.
      const flushSids = new Set()
      for (const [sid, rec] of saveTimers) { clearTimeout(rec.t); flushSids.add(sid) }
      for (const sid of saveChain.keys()) flushSids.add(sid)
      for (const sid of abandonedSaves) flushSids.add(sid)
      for (const [sid, s] of states) if (s.saveRun && s.saveRun.active) flushSids.add(sid)
      for (const sid of flushSids) {
        const s = states.get(sid)
        if (!s) {
          // A session whose state was already evicted: only its pending write
          // needs to be dropped (there is nothing in memory left to flush).
          abandonedSaves.add(sid)
          continue
        }
        saveState(s, { force: true })
      }
      saveTimers.clear()
      // v1.24: no terminal child may outlive the plugin fiber.
      for (const [, t] of terms) { if (t.pid) termKillTree(t.pid, 'SIGKILL') }
      terms.clear()
      try { rmSync(TERM_TMP_DIR, { recursive: true, force: true }) } catch (e) {}
    }, 'dsh-file-edit: wait cleanup')

    // ---------- change triggers ----------
    ctx.on('tools/result', (exec, result) => {
      const agent = exec && exec.agent
      const sid = agent && agent.session ? agent.session.id : undefined
      if (!sid || !knownSessions.has(sid)) return
      const name = exec && exec.name ? exec.name : ''
      // v1.13.3 bugfix: the harness ToolExecution carries the parsed tool
      // arguments under `exec.arguments` (packages/core/tools: ToolExecution),
      // NOT `exec.args`. Reading `exec.args` yielded undefined, so shell/pwsh
      // command text was never inspected (Remove-Item never triggered) and
      // write/edit attribution always fell back to the whole-window sweep.
      const args = exec && (exec.arguments ?? exec.args)
      let mutating = false
      let cmd = ''
      if (name === 'write' || name === 'edit') mutating = true
      else if (name === 'shell' || name === 'pwsh') {
        // Only commands that can change the workspace trigger a refresh.
        // A command text we cannot inspect is treated as non-mutating
        // (strict per requirement: everything else must not trigger).
        // v1.15.1: mutating GIT commands count too — commit/checkout/... do
        // not match the shell-mutation list but still change the state the
        // VCS badges answer.
        cmd = args && typeof args.command === 'string' ? args.command : ''
        mutating = cmd !== '' && (MUTATING_SHELL_RE.test(cmd) || MUTATING_GIT_RE.test(cmd))
      }
      if (!mutating) return
      const st = stateFor(sid)
      if (!st.baseReady) return
      // v1.15.1: any agent mutation can change the VCS letters — drop the
      // cached git snapshot for this workspace so the next tree load re-asks
      // git (the 2s cache would otherwise serve a pre-mutation snapshot).
      invalidateGitCacheFor(st.root)
      // v1.18: git index-only commands (add/commit/init) change no worktree
      // byte — no dirty, no scan of any kind. The tree stamp + cache
      // invalidation refresh the VCS badges; getModified consumes treeDirty
      // without walking. Only commands with NO worktree-mutating git subcommand
      // qualify: `git add; git checkout -- x`/`git reset --hard` fall through
      // to the dirty path so their worktree change is never dropped.
      if (MUTATING_GIT_RE.test(cmd) && !GIT_WORKTREE_RE.test(cmd)) {
        st.treeDirty = true
        bumpTree(st)
        scheduleNotify(sid, 300)
        return
      }
      st.dirty = true
      st.mutationStamp = (st.mutationStamp || 0) + 1
      // Worktree-mutating git commands bump the tree stamp directly (they can
      // change mostly .git or content the scanner may not attribute).
      if (MUTATING_GIT_RE.test(cmd)) bumpTree(st)
      // v1.8 change attribution (direction B): only changes that flowed
      // through the agent's tool channel enter the review.
      // v1.18: whenever the tool call NAMES its file targets, attribute and
      // refresh exactly those files (targeted refresh — no full walk).
      // write/edit carry an explicit file_path; mutating shell/pwsh/git
      // commands have their target paths extracted from the command text.
      // Anything unparseable falls back to the session-wide window (the full
      // scan) so agent work is never silently folded.
      let attributed = false
      if (name === 'write' || name === 'edit') {
        const raw = args && typeof args.file_path === 'string' ? args.file_path : ''
        const rel = normalizeRelPath(st.root, raw)
        if (rel) {
          st.touched.add(rel)
          // v1.33 (F1): the write tool reports the operation it performed, and
          // 'create' is the ONLY positive proof that this path did not exist
          // before the agent touched it. doReject consults this set before it
          // deletes anything (see assertDeletable). The edit tool can never
          // create a file, so it contributes nothing; a result without a usable
          // value (blocked/errored call) proves nothing either — the safe
          // direction is to refuse rather than to delete.
          if (name === 'write' && result && result.isError === false
              && result.value && result.value.operation === 'create') {
            st.created.add(rel)
          }
          addTarget(st, rel)
          attributed = true
        } else fallbackWindow(st)
      } else {
        // shell / pwsh / git: extract precise targets from the command text.
        // Both extractors run (a command can mix `git ... ; Set-Content ...`):
        // their targets UNION into the precise set. If EITHER extractor
        // cannot locate its targets (git reset --hard, wildcards, variables),
        // the whole command falls back to the session-wide window — a git
        // reset followed by a Set-Content still rewrote unknown files.
        const isGit = MUTATING_GIT_RE.test(cmd)
        const isShell = MUTATING_SHELL_RE.test(cmd)
        let rels = null
        let needFallback = false
        if (isGit) {
          const gr = extractGitPaths(cmd, st.root)
          if (gr) rels = gr
          else needFallback = true
        }
        if (isShell && !needFallback) {
          // A PowerShell cmdlet present → use the cmdlet extractor (it returns
          // null for unparseable targets like wildcards and must then fall
          // back). No cmdlet → try the direct .NET static file APIs; Copy/Move
          // are deliberately left to the fallback (source + destination).
          PS_CMDLET_RE.lastIndex = 0
          const hasCmdlet = PS_CMDLET_RE.test(cmd)
          if (hasCmdlet) {
            const sr = extractCommandPaths(cmd, st.root)
            if (sr) rels = rels ? new Set([...rels, ...sr]) : sr
            else needFallback = true
          } else {
            const dr = extractDotNetPaths(cmd, st.root)
            if (dr) rels = rels ? new Set([...rels, ...dr]) : dr
            else needFallback = true
          }
        }
        if (needFallback || !rels || rels.size === 0) {
          fallbackWindow(st)
        } else {
          for (const rel of rels) {
            const r = normalizeRelPath(st.root, rel)
            if (r) { st.touched.add(r); addTarget(st, r); attributed = true }
            else { attributed = false; break }
          }
          if (!attributed) fallbackWindow(st)
        }
      }
      // Wake any long-polling client right away (bursts of tool results in
      // one agent turn coalesce into a single wake-up). The woken client
      // pulls getModified once: precise targets refresh only those files,
      // fallbacks run exactly one full walk per mutation burst.
      scheduleNotify(sid, 300)
    })
  },
}
