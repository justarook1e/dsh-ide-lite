// @justarook1e/dsh-ide-lite — static client bundle (web plugin).
// Loaded by the client module system as a classic script; registers a factory
// via window.__ModuleLoader__.load. The factory body runs at materialization;
// require('react') resolves through the shell's static module table.
// The registration id MUST equal the package name (the client module system
// keys its factory table by the boot-graph entry id, which is the package
// name); the HTTP routes, localStorage keys and slot ids below deliberately
// keep the stable `dsh-file-edit` runtime identifier.
// RPC to the host plugin goes through fetch('/dsh-file-edit/api').
window.__ModuleLoader__.load({
  id: '@justarook1e/dsh-ide-lite',
  factory: (require) => {
    const React = require('react')

    // v1.9.3: optional timeout — the instant-refresh watcher passes it so a
    // wedged long-poll fetch (one that never settles in this environment)
    // cannot freeze the wait loop forever; the abort turns the wedge into a
    // normal { ok:false } and the watcher backs off and retries.
    const call = async (method, args, timeoutMs) => {
      let abort = null
      try {
        const init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: method, args: args || {} }),
        }
        if (timeoutMs) {
          const ctl = new AbortController()
          init.signal = ctl.signal
          abort = setTimeout(() => { try { ctl.abort() } catch (e) {} }, timeoutMs)
        }
        const r = await fetch('/dsh-file-edit/api', init)
        const data = await r.json()
        return data && typeof data === 'object' ? data : { ok: true }
      } catch (e) {
        return { ok: false, error: e && e.message ? String(e.message) : String(e) }
      } finally {
        if (abort) clearTimeout(abort)
      }
    }

    return {
      inject: ['slots', 'timer', 'sessions', 'workspaces'],
      apply(ctx) {
        // No public view-switching API exists (the shell's chatStore is a
        // fiber-private handle). The header tab ring renders one
        // button[role="tab"] per view with its label as text, so a synthetic
        // click on our own tab is the sanctioned way for a view entry to bring
        // itself to the front. Label is registered as the literal '文件'.
        const switchToFilesView = () => {
          try {
            const tabs = document.querySelectorAll('div[role="tablist"] button[role="tab"]')
            for (let i = 0; i < tabs.length; i++) {
              const btn = tabs[i]
              if ((btn.textContent || '').trim() === '文件') { btn.click(); return }
            }
          } catch (e) {}
        }
        // v1.24: same sanctioned synthetic-click trick for the terminal tab.
        const switchToTerminalView = () => {
          try {
            const tabs = document.querySelectorAll('div[role="tablist"] button[role="tab"]')
            for (let i = 0; i < tabs.length; i++) {
              const btn = tabs[i]
              if ((btn.textContent || '').trim() === '终端') { btn.click(); return }
            }
          } catch (e) {}
        }
        const store = {
          sessionId: null,
          tabs: [],
          active: null,
          // v1.13: files with UNSAVED USER EDITS (white dot on the tab). The
          // old `modified` set (yellow dot for pending agent DIFFs) is gone —
          // that indicator collided semantically with the new dirty dot.
          dirtyFiles: new Set(),
          // v1.16.0: dirty changes ride their OWN channel (dirtySubs), not
          // the global emit. The old emit re-rendered FileView + every
          // store subscriber on the FIRST keystroke of each editing session
          // (markTyping → setDirty → emit → thousand-line DiffPane tree),
          // and FileView's white dot was the only consumer of the signal.
          dirtySubs: new Set(),
          setDirty(path, v) {
            const on = !!v
            if (on === this.dirtyFiles.has(path)) return
            if (on) this.dirtyFiles.add(path); else this.dirtyFiles.delete(path)
            const subs = Array.from(this.dirtySubs)
            for (const f of subs) { try { f() } catch (e) {} }
          },
          onDirty(f) { this.dirtySubs.add(f); return () => { this.dirtySubs.delete(f) } },
          // Current session's workspace root (from getModified/getDiff).
          // Used to key per-file edit histories by (root, path).
          root: null,
          setRoot(r) { if (r && r !== this.root) this.root = r },
          // Pending save-confirmation dialog (rendered by FileView):
          // { paths, reason, resolve } — resolved with 'save'|'discard'|'cancel'.
          askSave: null,
          // v1.32.8: reject outcomes that DID something the user must read
          // (files the batch reject refused to touch). The per-panel
          // `setError` row is wiped by the very refresh() that follows the
          // action, so the text only flashed for one frame; a store-held
          // notice survives every re-render/poll and is dismissed explicitly
          // by the user. Shape: { count, items:[{path,error}] } | null.
          rejectNotice: null,
          setRejectNotice(v) { this.rejectNotice = v; this.emit() },
          treeStamp: 0,
          // Cross-view refresh signal: any component that changes review
          // state (hunk accept/reject, file accept/reject, inline edit)
          // bumps this so the modified bar and open file views refetch
          // immediately instead of waiting for their 6s poll.
          refreshTick: 0,
          // v1.8.1: measured heights of the sticky tabs bar and toolbar
          // (px). Used for sticky offsets (CSS vars) and jump scroll math.
          tabH: 32,
          toolH: 35,
          rev: 0,
          subs: new Set(),
          setSessionId(id) { if (id && id !== this.sessionId) { this.sessionId = id; this.emit() } },
          openFile(path) { if (!path) return; if (this.tabs.indexOf(path) < 0) this.tabs.push(path); this.active = path; this.emit(); switchToFilesView() },
          closeTab(path) { const i = this.tabs.indexOf(path); if (i >= 0) this.tabs.splice(i, 1); if (this.active === path) this.active = this.tabs.length ? this.tabs[this.tabs.length - 1] : null; this.emit() },
          closeAll() { if (this.tabs.length === 0) return; this.tabs = []; this.active = null; this.emit() },
          activate(path) { if (this.active !== path) { this.active = path; this.emit() } },
          moveTab(from, to) { if (from === to || from < 0 || to < 0 || from >= this.tabs.length || to >= this.tabs.length) return; const t = this.tabs.splice(from, 1)[0]; this.tabs.splice(to, 0, t); this.emit() },
          setTreeStamp(n) {
            const v = Number(n) || 0
            if (v !== this.treeStamp) { this.treeStamp = v; this.emit() }
          },
          // v1.12: the modified bar floats over the file view's bottom edge
          // ONLY while the file editor is the active conversation view; the
          // chat and trajectory views keep the classic in-flow layout.
          // dockH = measured height of the floating bar (px), published to
          // FileView as --dsh-fe-dock-h so the diff scroll areas reserve
          // clearance for the panel.
          fileViewActive: false,
          setFileViewActive(v) { if (!!v !== this.fileViewActive) { this.fileViewActive = !!v; this.emit() } },
          // v1.12.1: dockH publishes on its OWN channel (dockSubs), not the
          // global store emit. A global emit would re-render DiffPane's
          // thousand-line tree (and every sidebar node) on each bar resize —
          // the CPU spike fixed here. Only the FileView CSS-var writer
          // subscribes.
          dockH: 0,
          dockSubs: new Set(),
          setDockH(n) {
            const v = Math.round(Number(n) || 0)
            if (v === this.dockH) return
            this.dockH = v
            const subs = Array.from(this.dockSubs)
            for (const f of subs) { try { f() } catch (e) {} }
          },
          onDockH(f) { this.dockSubs.add(f); return () => { this.dockSubs.delete(f) } },
          requestRefresh() { this.refreshTick++; this.emit() },
          // v1.24: the run notice — why the open file cannot be run. Rendered by
          // FileView (NOT by the button) because the toolbar is a
          // `position:sticky; z-index:5` stacking context — a fixed layer inside
          // it would paint below the shell's resize handle (z-index 8). Same layer
          // as the save dialog. (v1.32.9: the target PICKER this slot used to hold
          // is gone — there is at most one target now.)
          runMenu: null,
          setRunMenu(v) { this.runMenu = v; this.emit() },
          emit() { this.rev++; const subs = Array.from(this.subs); for (const f of subs) { try { f() } catch (e) {} } },
          subscribe(f) { this.subs.add(f); return () => { this.subs.delete(f) } },
        }
        // v1.20: pinned sessions (置顶) — a module-level set persisted to
        // localStorage so pins survive page reloads and are shared by every
        // workspace node. Sorting happens in WorkspaceNode: pinned sessions
        // float to the top, each group ordered by last activity (updatedAt).
        const pinStore = {
          KEY: 'dsh-file-edit.pins.v1',
          pins: new Set(),
          subs: new Set(),
          load() {
            try {
              const raw = localStorage.getItem(this.KEY)
              if (!raw) return
              const arr = JSON.parse(raw)
              if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string') this.pins.add(id)
            } catch (e) {}
          },
          save() {
            try { localStorage.setItem(this.KEY, JSON.stringify(Array.from(this.pins))) } catch (e) {}
          },
          has(id) { return this.pins.has(id) },
          toggle(id) {
            if (this.pins.has(id)) this.pins.delete(id); else this.pins.add(id)
            this.save()
            this.emit()
          },
          clear(ids) {
            let changed = false
            for (const id of ids || []) if (this.pins.delete(id)) changed = true
            if (changed) { this.save(); this.emit() }
          },
          subscribe(f) { this.subs.add(f); return () => { this.subs.delete(f) } },
          emit() { for (const f of Array.from(this.subs)) { try { f() } catch (e) {} } },
        }
        pinStore.load()
        // ---------- v1.24: integrated terminal (client model) ----------
        // The host runs each command as its own process and streams raw output
        // (SGR colors, \r progress rewrites, cursor moves, erase-to-EOL). This
        // is a deliberately small terminal emulator: it folds that stream into
        // line/run structures so the view re-renders incrementally instead of
        // re-parsing the whole scrollback on every poll. The 16 ANSI colors are
        // CSS variables so they follow the light/dark theme.
        const TERM_T256 = (() => {
          const a = []
          for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
            a.push('rgb(' + (r ? 55 + r * 40 : 0) + ',' + (g ? 55 + g * 40 : 0) + ',' + (b ? 55 + b * 40 : 0) + ')')
          }
          return a
        })()
        const term256 = (n) => {
          if (n < 16) return 'var(--dsh-fe-a' + n + ')'
          if (n < 232) return TERM_T256[n - 16]
          const v = 8 + (n - 232) * 10
          return 'rgb(' + v + ',' + v + ',' + v + ')'
        }
        const TERM_STYLE_CACHE = new Map()
        const termStyleObj = (s) => {
          const key = (s.fg || '') + '|' + (s.bg || '') + '|' + (s.b ? 'b' : '') + (s.d ? 'd' : '') + (s.i ? 'i' : '') + (s.u ? 'u' : '') + (s.r ? 'r' : '')
          let obj = TERM_STYLE_CACHE.get(key)
          if (!obj) {
            obj = {}
            if (s.fg) obj.color = s.fg
            if (s.bg) obj.backgroundColor = s.bg
            if (s.b) obj.fontWeight = 600
            if (s.d) obj.opacity = 0.62
            if (s.i) obj.fontStyle = 'italic'
            if (s.u) obj.textDecoration = 'underline'
            if (s.r) {
              const f = obj.color
              obj.color = obj.backgroundColor || 'var(--dsw-alias-bg-layer-1)'
              obj.backgroundColor = f || 'var(--dsw-alias-label-primary)'
            }
            TERM_STYLE_CACHE.set(key, obj)
          }
          return obj
        }
        const termNewStyle = () => ({ fg: null, bg: null, b: false, d: false, i: false, u: false, r: false })
        const TERM_MAX_LINES = 3000
        const termNewLine = () => ({ runs: [], rev: 0 })
        const termNewParser = () => ({ lines: [termNewLine()], row: 0, col: 0, style: termNewStyle(), tail: '' })
        const termLineLen = (line) => { let n = 0; for (const r of line.runs) n += r.t.length; return n }
        // Replace/overwrite `text` at column `col` of one line, splitting runs
        // as needed (the operation behind \r progress rewrites and \x1b[K).
        function termPut(line, col, text, style) {
          const len = text.length
          const out = []
          const push = (t, s) => {
            if (!t) return
            const last = out[out.length - 1]
            if (last && last.s === s) last.t += t
            else out.push({ t: t, s: s })
          }
          let pos = 0
          let done = false
          for (const r of line.runs) {
            const start = pos
            const end = pos + r.t.length
            pos = end
            if (end <= col) { push(r.t, r.s); continue }
            if (start >= col + len) {
              if (!done) { push(text, style); done = true }
              push(r.t, r.s)
              continue
            }
            if (start < col) push(r.t.slice(0, col - start), r.s)
            if (!done) { push(text, style); done = true }
            if (end > col + len) push(r.t.slice(col + len - start), r.s)
          }
          if (!done) {
            if (pos < col) push(' '.repeat(col - pos), null)
            push(text, style)
          }
          line.runs = out
          line.rev = (line.rev || 0) + 1
        }
        function termEraseLine(p, mode) {
          const line = p.lines[p.row]
          line.rev = (line.rev || 0) + 1
          if (mode === 2) { line.runs = []; return }
          if (mode === 1) {
            const out = []
            let pos = 0
            for (const r of line.runs) {
              const end = pos + r.t.length
              if (end <= p.col) out.push({ t: r.t, s: r.s })
              else if (pos < p.col) out.push({ t: ' '.repeat(p.col - pos), s: null })
              pos = end
            }
            line.runs = out
            return
          }
          const out = []
          let pos = 0
          for (const r of line.runs) {
            const end = pos + r.t.length
            if (pos >= p.col) break
            out.push({ t: end <= p.col ? r.t : r.t.slice(0, p.col - pos), s: r.s })
            pos = end
          }
          line.runs = out
        }
        function termEnsureRow(p, row) {
          while (p.lines.length <= row) p.lines.push(termNewLine())
          if (p.lines.length > TERM_MAX_LINES) {
            const cut = p.lines.length - TERM_MAX_LINES
            p.lines.splice(0, cut)
            p.row = Math.max(0, p.row - cut)
          }
        }
        function termSgr(p, nums) {
          const st = p.style
          const next = { fg: st.fg, bg: st.bg, b: st.b, d: st.d, i: st.i, u: st.u, r: st.r }
          for (let k = 0; k < nums.length; k++) {
            const c = nums[k]
            if (c === 0) Object.assign(next, termNewStyle())
            else if (c === 1) next.b = true
            else if (c === 2) next.d = true
            else if (c === 3) next.i = true
            else if (c === 4) next.u = true
            else if (c === 7) next.r = true
            else if (c === 22) { next.b = false; next.d = false }
            else if (c === 23) next.i = false
            else if (c === 24) next.u = false
            else if (c === 27) next.r = false
            else if (c >= 30 && c <= 37) next.fg = 'var(--dsh-fe-a' + (c - 30) + ')'
            else if (c === 39) next.fg = null
            else if (c >= 40 && c <= 47) next.bg = 'var(--dsh-fe-a' + (c - 40) + ')'
            else if (c === 49) next.bg = null
            else if (c >= 90 && c <= 97) next.fg = 'var(--dsh-fe-a' + (c - 90 + 8) + ')'
            else if (c >= 100 && c <= 107) next.bg = 'var(--dsh-fe-a' + (c - 100 + 8) + ')'
            else if (c === 38 || c === 48) {
              const target = c === 38 ? 'fg' : 'bg'
              const mode = nums[k + 1]
              if (mode === 5) { next[target] = term256(nums[k + 2] || 0); k += 2 }
              else if (mode === 2) {
                next[target] = 'rgb(' + (nums[k + 2] || 0) + ',' + (nums[k + 3] || 0) + ',' + (nums[k + 4] || 0) + ')'
                k += 4
              }
            }
          }
          p.style = next
        }
        function termCsi(p, params, final) {
          const nums = params.replace(/^[?>!=]+/, '').split(';').map((x) => (x === '' ? 0 : parseInt(x, 10) || 0))
          const a = nums[0] === undefined ? 0 : nums[0]
          if (final === 'm') { termSgr(p, nums); return }
          if (final === 'K') { termEraseLine(p, a); return }
          if (final === 'J') {
            if (a === 2) { p.lines = [{ runs: [] }]; p.row = 0; p.col = 0 }
            else if (a === 0) { termEraseLine(p, 0); p.lines.length = Math.max(p.row + 1, 1) }
            else termEraseLine(p, 1)
            return
          }
          if (final === 'A') { p.row = Math.max(0, p.row - Math.max(1, a)); termEnsureRow(p, p.row); return }
          if (final === 'B') { p.row += Math.max(1, a); termEnsureRow(p, p.row); return }
          if (final === 'C') { p.col += Math.max(1, a); return }
          if (final === 'D') { p.col = Math.max(0, p.col - Math.max(1, a)); return }
          if (final === 'G') { p.col = Math.max(0, (a || 1) - 1); return }
          if (final === 'H' || final === 'f') { p.row = Math.max(0, (nums[0] || 1) - 1); p.col = Math.max(0, (nums[1] || 1) - 1); termEnsureRow(p, p.row); return }
          if (final === 'd') { p.row = Math.max(0, (a || 1) - 1); termEnsureRow(p, p.row); return }
          // Cursor visibility, scroll regions, device queries: intentionally ignored.
        }
        // Returns the index just past the sequence, or -1 when the buffer ends
        // mid-sequence (the remainder is kept in parser.tail for the next chunk).
        function termEscape(p, s, i) {
          const n = s.length
          if (i + 1 >= n) return -1
          const c = s[i + 1]
          if (c === '[') {
            let j = i + 2
            while (j < n && !(s[j] >= '\u0040' && s[j] <= '\u007e')) j++
            if (j >= n) return -1
            termCsi(p, s.slice(i + 2, j), s[j])
            return j + 1
          }
          if (c === ']') {
            let j = i + 2
            while (j < n) {
              if (s[j] === '\u0007') return j + 1
              if (s[j] === '\u001b' && s[j + 1] === '\\') return j + 2
              j++
            }
            return -1
          }
          if (c === 'P' || c === '^' || c === '_') {
            let j = i + 2
            while (j < n && !(s[j] === '\u001b' && s[j + 1] === '\\')) j++
            return j >= n ? -1 : j + 2
          }
          if ('()*+-./#%'.indexOf(c) >= 0) return i + 3 <= n ? i + 3 : -1
          return i + 2
        }
        function termFeed(p, text) {
          if (!text && !p.tail) return false
          const s = p.tail + (text || '')
          p.tail = ''
          const n = s.length
          let i = 0
          while (i < n) {
            const ch = s[i]
            if (ch === '\u001b') {
              const next = termEscape(p, s, i)
              if (next === -1) { p.tail = s.slice(i); break }
              i = next
              continue
            }
            if (ch === '\n') { p.row++; p.col = 0; termEnsureRow(p, p.row); i++; continue }
            if (ch === '\r') { p.col = 0; i++; continue }
            if (ch === '\b') { if (p.col > 0) p.col--; i++; continue }
            if (ch === '\t') {
              const next = (Math.floor(p.col / 8) + 1) * 8
              termPut(p.lines[p.row], p.col, ' '.repeat(next - p.col), null)
              p.col = next
              i++
              continue
            }
            if (ch === '\u0007' || ch === '\u000e' || ch === '\u000f') { i++; continue }
            if (ch < ' ') { i++; continue }
            let j = i
            while (j < n && s[j] >= ' ' && s[j] !== '\u001b' && s[j] !== '\u007f') j++
            const line = p.lines[p.row]
            const cur = termLineLen(line)
            if (p.col > cur) termPut(line, cur, ' '.repeat(p.col - cur), null)
            termPut(line, p.col, s.slice(i, j), termStyleObj(p.style))
            p.col += j - i
            i = j
          }
          return true
        }
        // Shared per-session terminal state. Kept module-level so the view, the
        // run button and the polling loop survive view switches (the shell only
        // mounts the ACTIVE conversation view).
        const termStore = {
          bySid: new Map(),
          rec(sid) {
            let t = this.bySid.get(sid)
            if (!t) {
              t = {
                sid, parser: termNewParser(), version: 0,
                cursor: 0, total: 0, started: false, busy: false, command: null,
                exitCode: null, cwd: '', root: '', shell: '', motd: '', error: null,
                history: [], histIdx: -1, subs: new Set(), timer: null, pulling: false,
              }
              this.bySid.set(sid, t)
            }
            return t
          },
          subscribe(sid, fn) {
            const t = this.rec(sid)
            t.subs.add(fn)
            this.start(sid)
            return () => {
              t.subs.delete(fn)
              if (t.subs.size === 0) this.stop(sid)
            }
          },
          emit(sid) {
            const t = this.rec(sid)
            for (const f of Array.from(t.subs)) { try { f() } catch (e) {} }
          },
          start(sid) {
            const t = this.rec(sid)
            if (t.timer) return
            const tick = () => {
              t.timer = null
              if (t.subs.size === 0) return
              void this.pull(sid).then(() => {
                if (t.subs.size === 0 || t.timer) return
                // busy: fast follow; hard error: slow retry; idle: relaxed.
                t.timer = ctx.timeout(tick, t.busy ? 200 : (t.error ? 3000 : 650))
              })
            }
            tick()
          },
          stop(sid) {
            const t = this.rec(sid)
            if (t.timer) { try { t.timer() } catch (e) {} t.timer = null }
          },
          async pull(sid) {
            const t = this.rec(sid)
            if (t.pulling) return
            t.pulling = true
            try {
              const r = t.started
                ? await call('termRead', { sessionId: sid, after: t.cursor })
                : await call('termStart', { sessionId: sid })
              this.merge(sid, r)
            } finally { t.pulling = false }
          },
          merge(sid, r) {
            const t = this.rec(sid)
            if (!r || r.ok === false) {
              const raw = r && r.error ? String(r.error) : '终端不可用'
              // The running host module is loaded at DSH start; a newer client
              // bundle can therefore outrun it. Say so instead of leaking the
              // raw RPC error.
              t.error = /no such method|not found/i.test(raw)
                ? '宿主插件仍是旧版本（终端 RPC 不存在）：请重启 DSH 后重试。'
                : raw
              this.emit(sid)
              return
            }
            t.error = null
            t.started = true
            if (r.motd) t.motd = String(r.motd)
            if (r.shell) t.shell = String(r.shell)
            if (r.cwd) t.cwd = String(r.cwd)
            if (r.root) t.root = String(r.root)
            if (r.eol) t.eol = String(r.eol)
            t.busy = !!r.busy
            t.command = r.command ? String(r.command) : null
            if (r.exitCode !== undefined) t.exitCode = r.exitCode
            let changed = false
            if (r.reset) {
              t.parser = termNewParser()
              t.cursor = 0
              changed = true
            }
            if (r.text) { if (termFeed(t.parser, String(r.text))) changed = true }
            if (typeof r.total === 'number' && r.total !== t.total) { t.total = r.total; changed = true }
            t.cursor = typeof r.total === 'number' ? r.total : t.cursor
            if (changed || r.reset) { t.version++; this.emit(sid) }
          },
          async run(sid, command, source) {
            const t = this.rec(sid)
            const r = await call('termRun', { sessionId: sid, command: command, source: source || 'user' })
            if (r && r.ok === false) {
              t.error = String(r.error || '无法执行')
              this.emit(sid)
              return false
            }
            this.merge(sid, r)
            this.start(sid)
            return true
          },
          async write(sid, text) {
            const t = this.rec(sid)
            const r = await call('termWrite', { sessionId: sid, text: text })
            if (r && r.ok === false) { t.error = String(r.error || '写入失败'); this.emit(sid); return false }
            return true
          },
          async signal(sid) {
            const r = await call('termSignal', { sessionId: sid, signal: 'SIGINT' })
            if (r && r.ok === false) { const t = this.rec(sid); t.error = String(r.error || '无法中断'); this.emit(sid) }
            return r && r.ok === true
          },
          async clear(sid) {
            const t = this.rec(sid)
            await call('termClear', { sessionId: sid })
            t.parser = termNewParser()
            t.cursor = 0
            t.version++
            this.emit(sid)
          },
          async restart(sid) {
            const t = this.rec(sid)
            await call('termClose', { sessionId: sid })
            t.parser = termNewParser()
            t.cursor = 0
            t.total = 0
            t.started = false
            t.busy = false
            t.command = null
            t.exitCode = null
            t.error = null
            t.version++
            this.emit(sid)
            await this.pull(sid)
          },
          async detect(sid, path) {
            const r = await call('termDetect', { sessionId: sid, path: path || '' })
            if (!r || r.ok === false) {
              const raw = r && r.error ? String(r.error) : '检测失败'
              return {
                ok: false,
                candidates: [],
                reason: null,
                error: /no such method|not found/i.test(raw) ? '宿主插件仍是旧版本：请重启 DSH 后重试（也可在终端中手动输入命令）。' : raw,
              }
            }
            return {
              ok: true,
              candidates: Array.isArray(r.candidates) ? r.candidates : [],
              // v1.32.9: the host explains why a file cannot be run; the greyed
              // button shows it as its tooltip and as a notice on click.
              reason: r.reason ? String(r.reason) : null,
            }
          },
        }
        // v1.22 search box: ESC must close it from anywhere in the view, not
        // only while the input itself has focus. DiffPanes register a closer
        // here; the capture-phase listener below owns the key.
        const searchClosers = new Set()
        const range = (a, b) => { const r = []; for (let i = a; i < b; i++) r.push(i); return r }
        const useStore = () => {
          const [, force] = React.useState(0)
          React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
        }
        // v1.16.0: narrow store channel for dirty-file changes. setDirty no
        // longer emits globally (the white tab dot was its only consumer),
        // so FileView subscribes here and force-re-renders itself — DiffPane
        // is memo'd and props are unchanged, so only the tab strip updates.
        const useDirty = () => {
          const [, force] = React.useState(0)
          React.useEffect(() => store.onDirty(() => force((n) => n + 1)), [])
        }
        // v1.13.3: NO fast arm. The old 1.5s running-cadence poll fired
        // getModified/getDiff every 1.5s while the agent was mid-turn and
        // caused jank when browsing files during RUNNING — it is gone.
        // Instant updates now ride the long-poll `wait` watcher exclusively
        // (the host wakes it the moment a mutating tool result lands); this
        // fixed 20s arm is only the failsafe for what the watcher cannot
        // cover (external/manual edits, a dead long-poll chain).
        const pollDelayFor = (sid) => 20000
        const usePoll = (fn, delayOf) => {
          const ref = React.useState({ fn: fn, delayOf: delayOf })[0]
          ref.fn = fn
          ref.delayOf = delayOf
          React.useEffect(() => {
            let disposed = false
            let running = false
            let handle = null
            const arm = () => {
              if (disposed) return
              handle = ctx.timeout(() => { handle = null; tick() }, ref.delayOf())
            }
            const tick = () => {
              if (disposed || running) return
              running = true
              Promise.resolve().then(() => ref.fn()).catch(() => {}).then(() => {
                running = false
                arm()
              })
            }
            // No immediate first tick: initial loads are explicit effects in
            // the consumers (ModifiedBar/DiffPane refetch on sid/path), and
            // mid-turn updates come from the long-poll watcher, not this arm.
            arm()
            return () => { disposed = true; if (handle) handle() }
          }, [])
        }

        // v1.13.3: all instant channels used to gate on store.sessionId,
        // which is only written when the ModifiedBar/FileView components
        // mount — on views where neither is mounted every channel went
        // silently dormant (no sse open, no activity wake). Resolve the
        // current session from the sessions list snapshot instead (the same
        // source the guard uses), heal the store, and fall back to it.
        const sidNow = () => {
          try {
            const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null
            const cur = snap && snap.current ? String(snap.current) : ''
            if (cur && snap.byId && snap.byId[cur]) return cur
          } catch (e) {}
          return store.sessionId || null
        }

        // -------- instant refresh watcher (long-poll against host `wait`) --------
        // The host resolves `wait` the instant a mutating tool result lands
        // (write/edit, or a shell/pwsh command matching the host's mutating-
        // command list — v1.13.3 narrowed the trigger from "any shell call"),
        // so the modified bar and open diff panes refresh right away instead
        // of waiting for the poll. requestRefresh() makes both the ModifiedBar
        // and every open DiffPane refetch, so a single wake-up covers all
        // surfaces.
        //
        // v1.9.3 hardening (this environment has shown it can silently kill
        // apply-time loops, so the watcher must be unable to die or wedge):
        //  * started lazily from the session-change signal (no apply-time
        //    "no session yet" sleep that could strand the first iteration);
        //  * every iteration is fault-contained (an unexpected throw backs
        //    off and re-runs instead of killing the loop);
        //  * the `wait` fetch carries a 20s abort timeout, so a wedged
        //    request cannot freeze the loop forever;
        //  * a token invalidates an in-flight iteration when the session
        //    changes, so a new session starts its own loop immediately.
        // v1.13.3: this chain is now the PRIMARY instant channel (the 1.5s
        // fast poll is gone); the fixed 20s poll is only the failsafe.
        let watcherDisposed = false
        let watcherToken = 0
        let watcherSid = null
        let watcherTimer = null
        const watcherLoop = async (token) => {
          // sidNow(): the store may not be healed yet when the loop first
          // starts — resolve from the snapshot like every other channel.
          const sid = sidNow()
          if (!sid || token !== watcherToken) return
          try {
            const r = await call('wait', { sessionId: sid }, 20000)
            if (watcherDisposed || token !== watcherToken) return
            if (r && r.ok && r.changed) {
              // Several mutations in one agent turn wake us repeatedly:
              // debounce so one refresh covers the burst.
              if (watcherTimer) clearTimeout(watcherTimer)
              watcherTimer = setTimeout(() => { watcherTimer = null; store.requestRefresh() }, 250)
            } else if (!r || !r.ok) {
              // Carrier trouble (fetch failure, aborted wedge, server busy):
              // give the regular poll room before reconnecting.
              await new Promise((res) => setTimeout(res, 6000))
              if (watcherDisposed || token !== watcherToken) return
            }
          } catch (e) {
            await new Promise((res) => setTimeout(res, 6000))
            if (watcherDisposed || token !== watcherToken) return
          }
          void watcherLoop(token)
        }
        const ensureWatcher = () => {
          if (watcherDisposed) return
          const sid = sidNow()
          if (!sid || sid === watcherSid) return
          watcherSid = sid
          watcherToken++
          void watcherLoop(watcherToken)
        }
        const offWatcherSub = store.subscribe(ensureWatcher)
        ensureWatcher()
        ctx.effect(() => () => {
          watcherDisposed = true
          if (watcherTimer) { clearTimeout(watcherTimer); watcherTimer = null }
          offWatcherSub()
        }, 'dsh-file-edit: instant refresh watcher')

        // -------- SSE push channel (primary instant refresh, v1.13.3) --------
        // The long-poll watcher above has proven unreliable in this
        // environment (its self-managed async loop can silently die), so the
        // host now ALSO pushes mutation wakes over Server-Sent Events. The
        // browser's EventSource reconnects natively — no loop of ours has to
        // stay alive — and onmessage drives the same requestRefresh() wake as
        // the watcher, so one host wake = one getModified per mutation burst.
        let sseConn = null
        let sseSid = null
        let sseWarned = false
        let sseErrLog = 0
        const closeSse = () => { if (sseConn) { try { sseConn.close() } catch (e) {} } sseConn = null; sseSid = null }
        const ensureSse = () => {
          if (typeof EventSource === 'undefined') {
            if (!sseWarned) { sseWarned = true; console.warn('[dsh-file-edit] sse unavailable: EventSource is not defined in this page') }
            return
          }
          const sid = sidNow()
          if (!sid) {
            if (!sseWarned) { sseWarned = true; console.warn('[dsh-file-edit] sse skip: no current session id (snapshot + store both empty)') }
            return
          }
          if (sid !== store.sessionId) store.setSessionId(sid) // heal the store for other consumers
          if (sid === sseSid) return
          closeSse()
          try {
            sseConn = new EventSource('/dsh-file-edit/events?sessionId=' + encodeURIComponent(sid))
            sseSid = sid
            sseErrLog = 0
            sseConn.onmessage = () => { store.requestRefresh() }
            sseConn.onopen = () => { sseErrLog = 0; console.info('[dsh-file-edit] sse open: ' + sid) }
            sseConn.onerror = () => { if (sseErrLog < 2) { sseErrLog++; console.warn('[dsh-file-edit] sse error (browser will retry)') } }
          } catch (e) {
            console.warn('[dsh-file-edit] sse open failed: ' + (e && e.message ? e.message : String(e)))
            closeSse()
          }
        }
        const offSseSub = store.subscribe(ensureSse)
        ensureSse()
        ctx.effect(() => () => { closeSse(); offSseSub() }, 'dsh-file-edit: sse channel')

        // -------- session-activity refresh (event-driven backbone, v1.13.3) ----
        // This environment has proven hostile to timer chains and long-held
        // connections (the poll arms and the wait watcher can silently die),
        // but the shell's OWN session list store notifies synchronously on
        // every session activity frame — running flips, tool results, new
        // messages (the sidebar's relative-time labels ride the same feed).
        // Ride that signal: each notification that touches the current
        // session while it is running requests ONE refresh, clock-throttled
        // (no timers involved, so nothing of ours can die).
        let lastActRefresh = 0
        let actWakeLog = 0
        const onSessionsChanged = () => {
          try {
            const sid = sidNow()
            if (!sid) return
            if (sid !== store.sessionId) store.setSessionId(sid) // heal the store
            const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null
            const entry = snap && snap.byId ? snap.byId[sid] : null
            if (!entry || !entry.running) return
            const now = Date.now()
            if (now - lastActRefresh < 1200) return
            lastActRefresh = now
            if (actWakeLog < 3) { actWakeLog++; console.info('[dsh-file-edit] activity wake: ' + sid) }
            store.requestRefresh()
          } catch (e) {}
        }
        let offSessSub = null
        try {
          if (ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.subscribe === 'function') {
            offSessSub = ctx.sessions.list.subscribe(onSessionsChanged)
          }
        } catch (e) {}
        ctx.effect(() => () => {
          if (offSessSub) { try { offSessSub() } catch (e) {} offSessSub = null }
        }, 'dsh-file-edit: session activity refresh')

        // ---------- new-session guard ----------
        // Every New Session entry point in the shell (sidebar top button,
        // wordmark, workspace rows, agent-preset flows) funnels into
        // workspace session creation — v1.23 (DSH 0.1.5-alpha.1 compat):
        // on new DSH that is ctx.uiWorkspace.startSession, on 0.1.1-rc.2 it
        // is ctx.workspaces.startSession. The shell closures read the method
        // LIVE at click time, so shadowing the instance method here guards
        // both layouts with one seam. When the current session still has
        // unreviewed revisions, toast and swallow the action; otherwise —
        // and on any check failure (fail-open) — hand off to the original.
        let toastEl = null
        let toastTimer = null
        const showToast = (message) => {
          if (!toastEl) {
            toastEl = document.createElement('div')
            toastEl.setAttribute('data-plugin', 'dsh-file-edit')
            toastEl.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 16px;font-size:13px;line-height:1.5;max-width:min(440px,calc(100vw - 40px));box-shadow:0 8px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);'
            document.body.append(toastEl)
          }
          toastEl.textContent = message
          toastEl.style.display = 'block'
          if (toastTimer) clearTimeout(toastTimer)
          toastTimer = setTimeout(() => { if (toastEl) toastEl.style.display = 'none' }, 6000)
        }
        // v1.23 (DSH 0.1.5-alpha.1 compat): the Workspace Controller's client
        // service dropped startSession/pickDirectory/refresh — session
        // creation and directory picking moved to the ui-workspace package's
        // own `uiWorkspace` service (startSession(workspaceId?),
        // pickDirectory(), archiveSession). Probe it lazily via ctx.get
        // (never a hard inject, so an old DSH without the service cannot
        // block this plugin's activation) and accept late activation.
        const getUiWorkspace = () => {
          try { return ctx.get ? ctx.get('uiWorkspace') : null } catch (e) { return null }
        }
        const hasUiStartSession = () => {
          const uw = getUiWorkspace()
          return !!(uw && typeof uw.startSession === 'function')
        }
        const origStartSession = ctx.workspaces && typeof ctx.workspaces.startSession === 'function'
          ? ctx.workspaces.startSession
          : null
        const wsInstance = ctx.workspaces || null
        const currentSessionId = () => {
          try {
            const snap = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null
            if (snap && snap.current) return snap.current
          } catch (e) {}
          return store.sessionId || null
        }
        const checkThen = (sid, allow) => {
          void call('getModified', { sessionId: sid }).then((r) => {
            if (r && r.ok && Array.isArray(r.files) && r.files.length > 0) {
              if (typeof console !== 'undefined' && console.info) {
                console.info('[dsh-file-edit] new session blocked: ' + r.files.length + ' pending file(s), session ' + sid)
              }
              showToast('当前会话还有 ' + r.files.length + ' 个文件的修订未处理，请先接受或拒绝后再新建会话。')
              return
            }
            allow()
          }).catch(allow)
        }
        // Guarded entry used by the plugin's own 新建会话 button directly,
        // and installed over the service method when the instance accepts it.
        const guardedStartSession = function () {
          const args = arguments
          const allow = () => {
            // Call the PRE-SHADOW original every time: the instance methods
            // may carry our own shadow (tryShadow below), and calling through
            // the wrapper would re-enter this guard forever. `__wrapped` is
            // set by our wrapper only, so its presence means "unwrap first".
            const unwrap = (fn) => (fn && fn.__wrapped ? fn.__wrapped : fn)
            // 1) old service (0.1.1-rc.2): ctx.workspaces.startSession
            if (origStartSession && wsInstance) { origStartSession.apply(wsInstance, args); return }
            // 2) new service (0.1.5-alpha.1): ctx.uiWorkspace.startSession —
            //    the shell sidebars hold the uiWorkspace instance and read
            //    the method at click time, so a live lookup sees a shadow.
            const uw = getUiWorkspace()
            if (uw && typeof uw.startSession === 'function') {
              unwrap(uw.startSession).apply(uw, args)
              return
            }
            // 3) late-bound old service (arrived after apply): live lookup.
            const live = ctx.workspaces
            if (live && typeof live.startSession === 'function') {
              unwrap(live.startSession).apply(live, args)
            }
          }
          const sid = currentSessionId()
          if (!sid || (!origStartSession && !hasUiStartSession())) { allow(); return }
          checkThen(sid, allow)
        }
        // Mechanism 1 — method shadow (covers every service-level entry
        // point that creates a session: the old rc.2 ctx.workspaces.startSession
        // and the new ctx.uiWorkspace.startSession). The service is delivered
        // through Cordis's traceable proxy, so a raw identity compare always
        // fails (method reads return shadow proxies) — verify through a
        // marker on the wrapped function instead. Probed lazily: uiWorkspace
        // may activate after apply.
        let wrapOk = false
        const shadowPairs = []
        const tryShadow = (inst, orig) => {
          if (!inst || typeof orig !== 'function') return false
          try {
            if (inst.startSession && inst.startSession.__wrapped) return true
            const g = function () { guardedStartSession.apply(undefined, arguments) }
            g.__wrapped = orig
            inst.startSession = g
            if (inst.startSession && inst.startSession.__wrapped === orig) {
              shadowPairs.push([inst, orig])
              return true
            }
            return false
          } catch (e) { return false }
        }
        if (wsInstance && origStartSession) wrapOk = tryShadow(wsInstance, origStartSession) || wrapOk
        {
          const uwInst = getUiWorkspace()
          if (uwInst && typeof uwInst.startSession === 'function') {
            wrapOk = tryShadow(uwInst, uwInst.startSession) || wrapOk
          }
        }
        // Mechanism 2 — DOM capture interception for the native sidebar
        // buttons, ALWAYS installed: it does not depend on the service
        // instance at all, so it covers the observed case where the native
        // button bypasses the shadowed method. Alongside a working shadow it
        // is harmless: a blocked click never reaches the wrapper; an allowed
        // click is forwarded and at most re-checked once by the wrapper.
        let forwarding = false
        const dispatchForward = (btn, original) => {
          forwarding = true
          try {
            const ev2 = new MouseEvent('click', {
              bubbles: true, cancelable: true, view: window,
              clientX: original ? original.clientX : 0, clientY: original ? original.clientY : 0,
            })
            ev2.__dshFbHandled = 'forwarded'
            btn.dispatchEvent(ev2)
          } finally { forwarding = false }
        }
        const isNativeNewSessionButton = (btn) => {
          if (!btn || btn.disabled) return false
          if (btn.getAttribute('data-dsh-fe-guarded')) return false
          const aria = (btn.getAttribute('aria-label') || '').trim()
          const text = (btn.textContent || '').trim()
          return /新建会话|新会话|New Session|New session/i.test(aria + ' ' + text)
        }
        // Find the clicked button across event retargeting (shadow DOM,
        // portals, re-rendered targets): composedPath sees the full path.
        const buttonFromEvent = (ev) => {
          try {
            if (ev.composedPath) {
              const path = ev.composedPath()
              for (let i = 0; i < path.length; i++) {
                const el = path[i]
                if (el && el.tagName === 'BUTTON') return el
              }
            }
          } catch (e) {}
          if (ev.target && typeof ev.target.closest === 'function') return ev.target.closest('button')
          return null
        }
        // Installed at BOTH window and document capture (window runs first
        // and survives any document-level stopImmediatePropagation); the
        // __dshFbHandled mark makes the second registration a no-op.
        const onDocClick = (ev) => {
          if (ev.__dshFbHandled) return
          ev.__dshFbHandled = true
          if (forwarding) return
          const btn = buttonFromEvent(ev)
          if (!btn || !isNativeNewSessionButton(btn)) return
          ev.preventDefault()
          ev.stopPropagation()
          ev.stopImmediatePropagation()
          const sid = currentSessionId()
          if (!sid) { dispatchForward(btn, ev); return }
          checkThen(sid, () => { dispatchForward(btn, ev) })
        }
        document.addEventListener('click', onDocClick, true)
        try { window.addEventListener('click', onDocClick, true) } catch (e) {}
        // Direct per-button attachment: property handlers live on the
        // elements themselves and ride the SAME event React uses, so they
        // fire even when addEventListener/capture delivery is broken in this
        // page. stopPropagation at target prevents React's root listener.
        let attachRuns = 0
        const attachDirect = () => {
          if (guardDisposed) return
          attachRuns++
          try {
            document.querySelectorAll('button').forEach((b) => {
              if (b.__dshFbDirect || !isNativeNewSessionButton(b)) return
              b.__dshFbDirect = true
              const allowStartSession = () => {
                try {
                  // v1.23: uiWorkspace first (0.1.5-alpha.1), old service second.
                  // Unwrap our own shadow (__wrapped) before calling, or the
                  // wrapper re-enters the guard.
                  const unwrap = (fn) => (fn && fn.__wrapped ? fn.__wrapped : fn)
                  const uw = getUiWorkspace()
                  if (uw && typeof uw.startSession === 'function') { unwrap(uw.startSession).apply(uw, [undefined]); return }
                  const live = ctx.workspaces
                  if (live && typeof live.startSession === 'function') unwrap(live.startSession).apply(live, [undefined])
                } catch (e) {}
              }
              b.onclick = function (ev) {
                if (ev.__dshFbHandled) return
                ev.__dshFbHandled = true
                ev.preventDefault()
                ev.stopPropagation()
                const sid = currentSessionId()
                if (!sid) { allowStartSession(); return }
                checkThen(sid, () => { allowStartSession() })
              }
            })
          } catch (e) {}
        }
        // Self-rescheduling setTimeout loop: this environment has proven
        // setTimeout works (inventory/probe/toast all run) while setInterval
        // results never materialized — never trust setInterval here.
        let guardDisposed = false
        const attachLoop = () => {
          if (guardDisposed) return
          attachDirect()
          if (attachRuns < 30) setTimeout(attachLoop, 2000)
        }
        attachLoop()
        if (typeof console !== 'undefined' && console.info) {
          console.info('[dsh-file-edit] guard v1.32.0: wrapOk=' + wrapOk + ', sid=' + currentSessionId() + ', listeners installed (window+document, click) + direct button attach (setTimeout loop)')
        }
        ctx.effect(() => () => {
          guardDisposed = true
          document.removeEventListener('click', onDocClick, true)
          try { window.removeEventListener('click', onDocClick, true) } catch (e) {}
          try {
            document.querySelectorAll('button').forEach((b) => { if (b.__dshFbDirect) { b.onclick = null; b.__dshFbDirect = false } })
          } catch (e) {}
          // Restore only when our wrapper is really the one installed (the
          // proxy wraps method reads, so compare via the marker, not identity).
          for (const pair of shadowPairs) {
            const inst = pair[0], orig = pair[1]
            if (inst && inst.startSession && inst.startSession.__wrapped === orig) {
              inst.startSession = orig
            }
          }
          if (toastTimer) clearTimeout(toastTimer)
          if (toastEl) { toastEl.remove(); toastEl = null }
        }, 'dsh-file-edit: new-session guard')

        // Package-owned stylesheet (manual lifecycle — no styles builtin in
        // static client plugins). All colors come from DSH theme tokens.
        let styleEl = null
        const EXTRA_CSS = [
          '.dsh-fe-secbtn { border:none; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; padding:0; border-radius:4px; display:inline-flex; width:18px; height:18px; align-items:center; justify-content:center; flex:none; }',
          '.dsh-fe-secbtn:hover { color:var(--dsw-alias-label-primary); background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); }',
          // Session search: left edge aligned with the session rows' text
          // (they indent 40px via .dsh-fe-sess padding).
          '.dsh-fe-search { background:transparent; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; color:inherit; font-size:12px; padding:2px 8px; width:calc(100% - 40px); box-sizing:border-box; margin:2px 0 5px 40px; }',
          '.dsh-fe-search:focus { outline:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 40%, transparent); }',
          // v1.13: white dot = unsaved USER edits (white in the dark theme —
          // it rides the primary label token so it stays visible in light
          // themes too). The old DIFF-pending yellow dot is removed entirely.
          '.dsh-fe-tab-dirty { display:inline-block; width:7px; height:7px; border-radius:50%; margin-left:2px; background:var(--dsw-alias-label-primary); opacity:.9; vertical-align:middle; }',
          // v1.13: save-confirmation dialog (fixed overlay inside FileView).
          // v1.20.4: the scrim DIMS the page (dark mix — no more whitening)
          // and BLURS what is behind the dialog via backdrop-filter.
          // v1.21.0: the v1.20.4 mix (bg-base 38% + #000 62%) was a near-
          // opaque flat wash on the dark theme — the page behind the dialog
          // vanished and the whole background read as ONE solid color.
          // Replaced with the shell's own mask recipe, the exact one the
          // Modal / settings / image-lightbox dialogs use:
          //   --dsw-alias-bg-mask-1 = rgba(0,0,0,.24) (light) / .50 (dark)
          //   --dsw-mask-blur      = blur(2px)
          // So the page is only slightly dimmed and stays recognizable
          // through the gaussian blur — acrylic veil, not a color wash.
          '.dsh-fe-ask-mask { position:fixed; inset:0; z-index:60; background:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.32)); backdrop-filter:var(--dsw-mask-blur, blur(2px)); -webkit-backdrop-filter:var(--dsw-mask-blur, blur(2px)); display:flex; align-items:flex-start; justify-content:center; padding-top:18vh; }',
          '.dsh-fe-ask-card { background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:12px; box-shadow:var(--dsw-shadow-lv2, 0 12px 32px rgba(0,0,0,.18)); padding:14px 16px; min-width:min(420px, calc(100vw - 48px)); max-width:calc(100vw - 48px); color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-ask-title { font-size:14px; font-weight:650; margin-bottom:8px; }',
          '.dsh-fe-ask-body { font-size:12.5px; color:var(--dsw-alias-label-secondary); line-height:1.55; }',
          '.dsh-fe-ask-path { font-family:ui-monospace,Consolas,monospace; color:var(--dsw-alias-label-primary); margin:3px 0 0 6px; word-break:break-all; }',
          '.dsh-fe-ask-actions { display:flex; gap:8px; margin-top:14px; justify-content:flex-end; }',
          '.dsh-fe-ask-actions .dsh-fe-btn { padding:4px 14px; font-size:12.5px; }',
          '.dsh-fe-tab-drag { opacity:.5; }',
          '.dsh-fe-tab-closeall { margin-left:auto; flex:none; }',
          // Modified bar matches the composer card width (token shared with
          // InputBar), centered in the full-width dock row.
          '.dsh-fe-bar { width:100%; max-width:var(--dsh-composer-card-max-width); margin:0 auto; box-sizing:border-box; }',
          // Inline line editor: context + hunk-new lines are editable; hunk
          // old (deleted) lines are read-only but selectable for copy.
          // v1.32.0: no row hover tint and no click focus ring any more — the
          // editor should look identical whether or not the pointer/caret is
          // on a line (the caret itself is the only editing affordance). The
          // row hover highlight and the clicked line's inset border are gone;
          // text selection is drawn by .dsh-fe-sel instead.
          '.dsh-fe-tx-edit { cursor:text; outline:none; min-height:1.35em; border-radius:2px; }',
          '.dsh-fe-tx-ro { user-select:text; opacity:.85; }',
          // ---- v1.4 UI pass: decision glyphs + workbench detailing ----
          // Square icon buttons: the accept/reject gesture language.
          '.dsh-fe-iconbtn { width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center; padding:0; border:none; background:transparent; border-radius:5px; color:var(--dsw-alias-label-secondary); cursor:pointer; flex:none; transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-iconbtn:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-iconbtn-ok { color:var(--dsw-alias-state-success-primary); }',
          '.dsh-fe-iconbtn-ok:hover { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); color:var(--dsw-alias-state-success-primary); }',
          '.dsh-fe-iconbtn-no { color:var(--dsw-alias-state-error-primary); }',
          '.dsh-fe-iconbtn-no:hover { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); color:var(--dsw-alias-state-error-primary); }',
          '.dsh-fe-iconbtn-sm { width:18px; height:18px; border-radius:4px; }',
          '.dsh-fe-iconbtn:focus-visible, .dsh-fe-btn:focus-visible, .dsh-fe-secbtn:focus-visible, .dsh-fe-newbtn:focus-visible { outline:2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); outline-offset:1px; }',
          // Paired gesture buttons (accept/reject): the second button pulls
          // closer so the pair reads as one control group.
          '.dsh-fe-pair { margin-left:-4px; }',
          // Added/removed line counters carry the decision colors.
          '.dsh-fe-stat-add { color:var(--dsw-alias-state-success-primary); }',
          '.dsh-fe-stat-del { color:var(--dsw-alias-state-error-primary); }',
          // The lower/back check of the accept-all glyph (left check, faded).
          '.dsh-fe-ic-sub { opacity:.42; }',
          // Chevron slot: svg icon, rotates when its row is open.
          '.dsh-fe-chev { width:12px; display:inline-flex; justify-content:center; color:var(--dsw-alias-label-secondary); transition:transform .12s ease; }',
          '.dsh-fe-open .dsh-fe-chev { transform:rotate(90deg); }',
          // Fixed-width glyph slot (folder/file/section icons).
          '.dsh-fe-ic { width:15px; flex:none; display:inline-flex; justify-content:center; color:var(--dsw-alias-label-secondary); }',
          // Diff tint sits on the WHOLE row (full width, gutter column keeps
          // its own surface via .dsh-fe-ln's solid background) — v1.8.1.
          '.dsh-fe-line.dsh-fe-old { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }',
          '.dsh-fe-line.dsh-fe-new { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }',
          '.dsh-fe-line.dsh-fe-old .dsh-fe-tx, .dsh-fe-line.dsh-fe-new .dsh-fe-tx { background:none; }',
          '.dsh-fe-ln { position:sticky; left:0; background:var(--dsw-alias-bg-layer-1); border-right:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); }',
          '.dsh-fe-hunk:hover { border-radius:4px; outline-offset:-1px; }',
          '.dsh-fe-hunk-head { border-radius:4px; }',
          // Text buttons carry a leading glyph (＋ 添加 / ＋ 新建会话).
          '.dsh-fe-btn { display:inline-flex; align-items:center; gap:4px; transition:background .12s ease; }',
          '.dsh-fe-newbtn { display:inline-flex; align-items:center; gap:4px; transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-stats { font-family:ui-monospace,Consolas,monospace; }',
          '.dsh-fe-tb-name { font-family:ui-monospace,Consolas,monospace; font-weight:500; color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-bar-head { color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-bar-title { display:inline-flex; align-items:center; gap:6px; }',
          '.dsh-fe-bar-count { color:var(--dsw-alias-label-secondary); font-weight:500; font-size:11.5px; font-family:ui-monospace,Consolas,monospace; }',
          // Tabs: file glyph slot; active tab gets a firmer border.
          '.dsh-fe-filetab { transition:color .12s ease; }',
          '.dsh-fe-filetab-on { border-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, transparent); }',
          '.dsh-fe-tab-ic { display:inline-flex; color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-filetab-on .dsh-fe-tab-ic { color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-tab-x { color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-tab-x:hover { color:var(--dsw-alias-label-primary); }',
          // Tree / sidebar rhythm: guide lines, hover easing, current markers.
          '.dsh-fe-children { margin-left:11px; padding-left:5px; border-left:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent); }',
          // v1.30: inline placeholder rows inside the lazy tree ("加载中…" /
          // "（空）" / a failed level). Same muted voice as .dsh-fe-msg, but
          // sized and padded for a nested tree row.
          '.dsh-fe-dirmsg { padding:2px 8px; color:var(--dsw-alias-label-secondary); font-size:12px; opacity:.75; }',
          '.dsh-fe-row { border-radius:5px; transition:background .12s ease; }',
          '.dsh-fe-ws-row { transition:background .12s ease; }',
          '.dsh-fe-ws-row-cur .dsh-fe-ws-name { color:var(--dsw-alias-label-primary); font-weight:600; }',
          '.dsh-fe-sec { transition:background .12s ease; }',
          '.dsh-fe-sess { transition:background .12s ease; }',
          '.dsh-fe-sess-cur { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent); }',
          '.dsh-fe-railbtn { color:var(--dsw-alias-label-secondary); transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-railbtn:hover { color:var(--dsw-alias-label-primary); }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-iconbtn,.dsh-fe-btn,.dsh-fe-chev,.dsh-fe-secbtn,.dsh-fe-row,.dsh-fe-sess,.dsh-fe-sec,.dsh-fe-ws-row,.dsh-fe-file-row,.dsh-fe-filetab,.dsh-fe-newbtn,.dsh-fe-railbtn { transition:none; } }',
          // Reject-undo toast row inside the modified-files bar.
          '.dsh-fe-undo { display:flex; align-items:center; gap:8px; padding:0 2px; font-size:12px; color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-undo .dsh-fe-btn { padding:1px 8px; }',
          // ---- v1.7.1: composer shadow directly on the bar; the collapse
          // toggle is an icon in the bar head row (no separate handle) ----
          '.dsh-fe-bar { box-shadow:var(--dsw-shadow-lv2, 0 4px 12px 0 rgba(0,0,0,.03), 0 2px 8px 0 rgba(0,0,0,.05)); }',
          // ---- v1.8.3: modified-bar animations ----
          // Bar mount: subtle fade + rise. Body: grid-rows 1fr↔0fr transition
          // for expand/collapse (inner wrapper clips). Rows: enter/leave.
          '.dsh-fe-bar { animation:dsh-fe-bar-in .18s ease-out; }',
          '.dsh-fe-body { display:grid; grid-template-rows:1fr; transition:grid-template-rows .26s ease, opacity .2s ease; }',
          '.dsh-fe-bar-collapsed .dsh-fe-body { grid-template-rows:0fr; opacity:0; }',
          '.dsh-fe-body-inner { overflow:hidden; min-height:0; }',
          '.dsh-fe-row-enter { animation:dsh-fe-row-in .18s ease-out; }',
          '.dsh-fe-row-leave { animation:dsh-fe-row-out .2s ease-in forwards; }',
          '@keyframes dsh-fe-bar-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }',
          '@keyframes dsh-fe-row-in { from { opacity:0; transform:translateY(-5px); } to { opacity:1; transform:none; } }',
          '@keyframes dsh-fe-row-out { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(-5px); } }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-bar, .dsh-fe-row-enter, .dsh-fe-row-leave { animation:none; } .dsh-fe-body { transition:none; } }',
          // ---- v1.7: diff pane scroll architecture + jump controls ----
          '.dsh-fe-pane { display:flex; flex-direction:column; flex:1; min-height:0; }',
          '.dsh-fe-pane > .dsh-fe-diff, .dsh-fe-diffwrap .dsh-fe-diff { flex:1; min-height:0; }',
          '.dsh-fe-diffwrap { position:relative; flex:1; min-height:0; display:flex; flex-direction:column; }',
          // v1.8.1: the tabs bar and toolbar stay pinned while the page (or
          // the diff viewport) scrolls; heights are measured at runtime and
          // published as CSS vars by FileView/DiffPane effects.
          '.dsh-fe-filetabs { position:sticky; top:0; z-index:6; background:var(--dsw-alias-bg-layer-1); border-radius:10px 10px 0 0; }',
          '.dsh-fe-toolbar { position:sticky; top:var(--dsh-fe-tabs-h, 32px); z-index:5; background:var(--dsw-alias-bg-layer-1); }',
          // Zero-height sticky strip: the jump pill rides it, staying just
          // below the sticky header stack for the whole diff (near the
          // scrollbar side). Absent entirely when there are no hunks.
          // align-items:flex-start — the default stretch would collapse the
          // pill to the strip's 0 height and its text would overflow.
          '.dsh-fe-jumprow { position:sticky; top:calc(var(--dsh-fe-tabs-h, 32px) + var(--dsh-fe-toolbar-h, 35px)); z-index:4; display:flex; justify-content:flex-end; align-items:flex-start; height:0; }',
          '.dsh-fe-jump { display:flex; flex:none; align-items:center; gap:2px; padding:4px 4px 4px 9px; margin:8px 12px 0 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-shadow-lv1, 0 2px 4px 0 rgba(0,0,0,.05)); font-size:11.5px; font-family:ui-monospace,Consolas,monospace; color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-jump-count { padding:0 5px; white-space:nowrap; line-height:1; }',
          '.dsh-fe-jump-btn { display:inline-flex; align-items:center; gap:3px; padding:2px 6px; border:none; background:transparent; border-radius:6px; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1; cursor:pointer; }',
          '.dsh-fe-jump-btn:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-hunk-cur { outline:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 55%, transparent); outline-offset:-1px; border-radius:4px; }',
          // ---- v1.7: syntax highlighting ----
          // Editable lines render a transparent caret layer ABOVE a
          // pointer-events:none highlight layer with identical text, so the
          // contentEditable inline editor keeps working untouched.
          '.dsh-fe-txwrap { position:relative; flex:1; min-width:0; padding-right:16px; }',
          '.dsh-fe-txwrap .dsh-fe-tx { display:inline-block; min-height:1.35em; white-space:pre; padding-right:0; }',
          '.dsh-fe-hl { position:absolute; top:0; left:0; white-space:pre; pointer-events:none; user-select:none; color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-txwrap .dsh-fe-tx-edit { color:transparent; caret-color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-txwrap .dsh-fe-tx-edit::selection { background:color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 32%, transparent); }',
          // Token palette: all hues derive from theme tokens (light/dark
          // safe, no hard-coded colors).
          '.dsh-fe-tk { color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-tk-kw { color:color-mix(in srgb, var(--dsw-alias-state-business-primary, #3964fe) 55%, var(--dsw-alias-state-error-primary) 45%); font-weight:600; }',
          '.dsh-fe-tk-builtin { color:color-mix(in srgb, var(--dsw-alias-state-business-primary, #3964fe) 55%, var(--dsw-alias-state-error-primary) 45%); }',
          '.dsh-fe-tk-fn { color:var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary)); }',
          '.dsh-fe-tk-cls { color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 70%, var(--dsw-alias-state-error-primary) 30%); font-weight:600; }',
          '.dsh-fe-tk-const { color:var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary)); font-weight:600; }',
          '.dsh-fe-tk-str { color:var(--dsw-alias-state-success-primary); }',
          '.dsh-fe-tk-num { color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 75%, var(--dsw-alias-state-error-primary) 25%); }',
          '.dsh-fe-tk-com { color:var(--dsw-alias-label-secondary); font-style:italic; }',
          '.dsh-fe-tk-op { color:color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 45%, var(--dsw-alias-label-secondary)); }',
          '.dsh-fe-tk-var { color:color-mix(in srgb, var(--dsw-alias-state-business-primary, #3964fe) 55%, var(--dsw-alias-state-error-primary) 45%); }',
          '.dsh-fe-tk-tag { color:var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary)); font-weight:600; }',
          '.dsh-fe-tk-attr { color:color-mix(in srgb, var(--dsw-alias-state-business-primary, #3964fe) 55%, var(--dsw-alias-state-error-primary) 45%); }',
          '.dsh-fe-tk-key { color:var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary)); }',
          '.dsh-fe-tk-pp { color:var(--dsw-alias-state-error-primary); font-weight:600; }',
          '.dsh-fe-tk-code { color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-tk-codei { color:var(--dsw-alias-label-secondary); background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); border-radius:3px; padding:0 2px; }',
          // ---- v1.9: rendered markdown document ----
          '.dsh-fe-mdwrap { flex:1; min-height:0; overflow:auto; padding:10px 18px 48px; }',
          '.dsh-fe-md { max-width:86ch; margin:0 auto; font-size:14px; line-height:1.7; color:var(--dsw-alias-label-primary); overflow-wrap:break-word; }',
          '.dsh-fe-md > :first-child { margin-top:0; }',
          '.dsh-fe-md h1, .dsh-fe-md h2, .dsh-fe-md h3, .dsh-fe-md h4, .dsh-fe-md h5, .dsh-fe-md h6 { margin:1.1em 0 .5em; line-height:1.3; font-weight:650; color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-md h1 { font-size:1.65em; padding-bottom:.25em; border-bottom:1px solid var(--dsw-alias-border-l1); }',
          '.dsh-fe-md h2 { font-size:1.35em; padding-bottom:.2em; border-bottom:1px solid var(--dsw-alias-border-l1); }',
          '.dsh-fe-md h3 { font-size:1.15em; }',
          '.dsh-fe-md h4 { font-size:1.02em; }',
          '.dsh-fe-md p { margin:.65em 0; }',
          '.dsh-fe-md a { color:var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary)); text-decoration:none; }',
          '.dsh-fe-md a:hover { text-decoration:underline; }',
          '.dsh-fe-md ul, .dsh-fe-md ol { margin:.6em 0; padding-left:1.7em; }',
          '.dsh-fe-md li { margin:.18em 0; }',
          '.dsh-fe-md li > p { margin:.2em 0; }',
          '.dsh-fe-md blockquote { margin:.8em 0; padding:.15em 1em; border-left:3px solid var(--dsw-alias-border-l1); border-radius:0 6px 6px 0; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 5%, transparent); color:var(--dsw-alias-label-secondary); }',
          '.dsh-fe-md code { font-family:ui-monospace,Consolas,monospace; font-size:.9em; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); border-radius:4px; padding:.1em .35em; }',
          '.dsh-fe-md pre { margin:.8em 0; padding:10px 14px; overflow:auto; background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); border-radius:8px; line-height:1.5; }',
          '.dsh-fe-md pre code { background:none; padding:0; font-size:12.5px; }',
          '.dsh-fe-md table { border-collapse:collapse; margin:.8em 0; max-width:100%; overflow:auto; display:block; font-size:13px; }',
          '.dsh-fe-md th, .dsh-fe-md td { border:1px solid var(--dsw-alias-border-l1); padding:5px 11px; }',
          '.dsh-fe-md th { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent); font-weight:600; }',
          '.dsh-fe-md tr:nth-child(2n) td { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 3%, transparent); }',
          '.dsh-fe-md hr { border:none; border-top:1px solid var(--dsw-alias-border-l1); margin:1.3em 0; }',
          '.dsh-fe-md img { max-width:100%; border-radius:6px; }',
          // ---- v1.11: sidebar vertical rhythm (taller rows + gaps) and
          // session recency labels ----
          // The workspace column was too dense: rows grow a couple of px and
          // gain a small vertical gap so the tree breathes (workspace blocks,
          // section headers, session rows and file rows alike).
          '.dsh-fe-wslist { padding:6px 0; }',
          '.dsh-fe-ws-item { margin-bottom:2px; }',
          '.dsh-fe-ws-item:last-child { margin-bottom:0; }',
          '.dsh-fe-ws-row { padding:6px 8px; }',
          '.dsh-fe-sec { padding:5px 8px 5px 22px; margin:2px 0; }',
          '.dsh-fe-sess { padding:5px 8px 5px 40px; margin:1px 0; }',
          '.dsh-fe-row { padding:4px 8px; margin:1px 0; }',
          '.dsh-fe-newbtn { margin:3px 8px 3px 40px; padding:3px 10px; }',
          '.dsh-fe-search { margin:4px 0 8px 40px; padding:3px 8px; }',
          // Session time labels sit at the right edge of each history row
          // (the name span's flex:1 already pushes them there). v1.11.1: font
          // matches the WebUI body stack (--dsw-font-family, declared on
          // :root by the shell's theme base.css) instead of a code/mono font —
          // Latin glyphs render in the same system UI face as the
          // conversation text (Segoe UI etc.), CJK falls back to the stack's
          // PingFang SC / Microsoft YaHei entries.
          '.dsh-fe-sess-time { flex:none; margin-left:6px; font-size:11px; color:var(--dsw-alias-label-secondary); font-family:var(--dsw-font-family); white-space:nowrap; }',
          // ---- v1.11.1: unified hover transitions ----
          // Every hover highlight now fades on the same .12s ease curve
          // (matching the icon buttons) instead of snapping on. Covers the
          // modified-files bar rows plus the remaining plugin controls that
          // highlighted instantly: tree refresh, tab close, diff jump and the
          // hunk hover outline. The inline editor's own hover/focus chrome was
          // removed in v1.32.0, so its rule now only carries the text color
          // fade used by the selection layer.
          '.dsh-fe-file-row { transition:background .12s ease; }',
          '.dsh-fe-secbtn { transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-tab-x { transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-jump-btn { transition:background .12s ease,color .12s ease; }',
          '.dsh-fe-tx-edit { transition:color .12s ease; }',
          // Hunk outline: transparent at rest, fades to the hover tint. The
          // current-hunk marker needs a two-class selector to win over the
          // rest-state transparent outline (same-specificity single-class
          // rules would let the later base rule erase it).
          '.dsh-fe-hunk { outline:1px solid transparent; transition:outline-color .12s ease; }',
          '.dsh-fe-hunk:hover { outline-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 40%, transparent); }',
          '.dsh-fe-hunk.dsh-fe-hunk-cur { outline-color:color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 55%, transparent); }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-tab-x,.dsh-fe-jump-btn,.dsh-fe-tx-edit,.dsh-fe-hunk { transition:none; } }',
          // ---- v1.12: floating modified bar over the file view ----
          // With the file editor active, the bar overlays the editor's bottom
          // edge (absolute inside the sticky composer seat; the bottom offset
          // is measured at runtime against the zero-height dock anchor) so
          // toggling it never reflows the view area: the seat keeps the
          // input-card height and the shell's 36px fade band stays pinned
          // above the InputBar. Chat/trajectory views never get this class
          // and keep the classic in-flow layout.
          '.dsh-fe-dock-anchor { display:block; height:0; }',
          '.dsh-fe-bar-overlay { position:absolute; left:0; right:0; margin:0 auto; z-index:8; max-height:40vh; }',
          '.dsh-fe-bar-overlay .dsh-fe-body { min-height:0; }',
          '.dsh-fe-bar-overlay .dsh-fe-body-inner { overflow-y:auto; }',
          // The editor's scroll areas reserve the floating bar's height so
          // the last lines scroll clear of the panel. dockH is published as
          // --dsh-fe-dock-h by FileView (debounced to settle after the
          // collapse animation) and is 0 outside the file view.
          '.dsh-fe-diff { padding-bottom:var(--dsh-fe-dock-h, 0px); }',
          '.dsh-fe-mdwrap { padding-bottom:calc(48px + var(--dsh-fe-dock-h, 0px)); }',
          // ---- v1.12.1: cheap editor reflows ----
          // Offscreen code lines and markdown block children skip layout &
          // paint entirely: the bar's clearance updates (dockH) then only
          // relayout the ~visible lines instead of the whole file — the other
          // half of the toggle CPU spike. 19px matches the 12.5px/1.5 code
          // line box; the estimates keep the scrollbar stable for content
          // that has never rendered.
          '.dsh-fe-line { content-visibility:auto; contain-intrinsic-size:auto 19px; }',
          '.dsh-fe-md > * { content-visibility:auto; contain-intrinsic-size:auto 24px; }',
          // ---- v1.12.3: shell StateDot "ongoing" chase, replicated ----
          // Same color token, keyframe steps and per-cell delays as
          // ui-primitives/StateDot.module.css (blue --dsw-static-deepseek-450).
          '.dsh-fe-run-matrix { flex:none; color:var(--dsw-static-deepseek-450, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary))); }',
          '.dsh-fe-run-cell { fill:currentColor; opacity:.15; animation:dsh-fe-run-chase 1s infinite; }',
          '@keyframes dsh-fe-run-chase { 0%,12.4% { opacity:1 } 12.5%,24.9% { opacity:.6 } 25%,37.4% { opacity:.35 } 37.5%,100% { opacity:.15 } }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-run-cell { animation:none; opacity:.6 } }',
          // ---- v1.14: sticky scope bar (VSCode-style sticky scroll) ----
          // A zero-height sticky strip (the same pattern as the jump row)
          // whose body hangs below the sticky header stack. In the bounded
          // layout it simply sits above the internal diff viewport; when the
          // chat column scrolls it sticks below tabs+toolbar. The body
          // overlays the first code line while a definition scope is active
          // and hides (strip stays zero-height, so no layout shift) when
          // there is nothing to show. Segments reuse the token palette
          // classes for fn/cls/tag/key coloring; a dim keyword label (class/
          // def/func/...) prefixes each level. The bar sits FLUSH against
          // the toolbar (no gap) and is shorter + visually distinct from
          // the two header rows above it.
          '.dsh-fe-scope { position:sticky; top:calc(var(--dsh-fe-tabs-h, 32px) + var(--dsh-fe-toolbar-h, 35px)); z-index:3; height:0; display:flex; align-items:flex-start; }',
          '.dsh-fe-scope-body { display:flex; align-items:center; gap:1px; width:100%; max-width:100%; overflow:hidden; white-space:nowrap; padding:1px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); font-size:11px; line-height:1.35; font-family:ui-monospace,Consolas,monospace; color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-scope-body:empty { display:none; }',
          '.dsh-fe-scope-sep { flex:none; margin:0 3px; color:var(--dsw-alias-label-secondary); opacity:.75; }',
          '.dsh-fe-scope-seg { flex:none; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border:none; background:transparent; padding:0 6px; border-radius:4px; font-size:11px; font-family:inherit; cursor:pointer; line-height:1.35; transition:background .12s ease; }',
          '.dsh-fe-scope-seg:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); }',
          '.dsh-fe-scope-seg:focus-visible { outline:1px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)); outline-offset:-1px; }',
          '.dsh-fe-scope-kw { color:var(--dsw-alias-label-secondary); font-style:italic; margin-right:4px; }',
          '@keyframes dsh-fe-scope-flash { from { background:color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 26%, transparent); } to { background:transparent; } }',
          '.dsh-fe-line.dsh-fe-scope-flash { animation:dsh-fe-scope-flash .9s ease-out; }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-scope-seg { transition:none; } .dsh-fe-line.dsh-fe-scope-flash { animation:none; } }',
          // ---- v1.15: git VCS annotations + ignored-file graying ----
          // The host decorates tree nodes with a git letter (M modified /
          // U untracked / A added / D deleted / R renamed) and an ignored
          // flag from git check-ignore. The letter badge pins to the row's
          // right edge (the name grows into the gap via flex:1 so long names
          // keep ellipsizing) and is tinted with the plugin's decision
          // palette: M=warn yellow, A/U=success green, D=error red,
          // R=business blue — each with a soft 16% tinted pill background.
          // Ignored files/folders fade to gray (secondary label at 55%).
          // The host also sorts directories before files, each group
          // alphabetically, so the client renders the tree as-is.
          '.dsh-fe-name { flex:1; min-width:0; }',
          '.dsh-fe-git { margin-left:auto; flex:none; font-family:ui-monospace,Consolas,monospace; font-size:10.5px; font-weight:700; line-height:1.5; padding:0 4px; border-radius:4px; letter-spacing:.03em; }',
          '.dsh-fe-git-m { color:var(--dsw-alias-state-warn-primary); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); }',
          '.dsh-fe-git-a, .dsh-fe-git-u { color:var(--dsw-alias-state-success-primary); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); }',
          '.dsh-fe-git-d { color:var(--dsw-alias-state-error-primary); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }',
          '.dsh-fe-git-r { color:var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)); background:color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 16%, transparent); }',
          '.dsh-fe-row-ignored .dsh-fe-name { color:color-mix(in srgb, var(--dsw-alias-label-secondary) 55%, transparent); }',
          '.dsh-fe-row-ignored .dsh-fe-ic, .dsh-fe-row-ignored .dsh-fe-chev { color:color-mix(in srgb, var(--dsw-alias-label-secondary) 55%, transparent); }',
          // ---- v1.15.2: hunk summary rows never paint above sticky rows ----
          // The per-diff summary row (line range + accept/reject) stays in
          // normal document flow — its position relative to the code lines
          // is fixed and it scrolls away naturally, no pinning. The only
          // guarantee added here is paint order: the row is positioned
          // (sticky left:0 keeps the horizontal gutter stickiness) and now
          // carries an explicit z-index:1, which keeps it above the plain
          // scrolling lines but strictly BELOW the sticky rows — scope
          // strip (3), jump pill (4), toolbar (5), file tabs (6) — so it
          // can never accidentally be displayed on top of the sticky-scroll
          // row. The background keeps the original translucent tint.
          '.dsh-fe-hunk-head { z-index:1; }',
          // ---- v1.15.3: modified-bar 5-row cap + MD edit/read switch ----
          // More than five modified files: the bar body scrolls inside the
          // 5-row cap (measured per-row height via --dsh-fe-row-h, set by
          // ModifiedBar; the +4px slack peeks the sixth row as a scroll
          // affordance). The MD-only switch is a segmented slider in the
          // file toolbar's far-left slot: 编辑 and 阅读 sit side by side and
          // a neutral (no accent color) light-gray track carries a flat pill
          // — LEFT = 编辑 (checked), RIGHT = 阅读 (unchecked). The pill is
          // optically centered (top:50% + translateY(-50% − 0.5px): the
          // 1px shadow under it would otherwise read as sitting low) with a
          // faint 1px shadow and a thin border for a hint of depth; the
          // active label darkens and the other stays secondary.
          '.dsh-fe-bar-scroll .dsh-fe-body-inner { overflow-y:auto; max-height:calc(5 * var(--dsh-fe-row-h, 25px) + 4px); }',
          '.dsh-fe-mdswitch { display:inline-flex; align-items:center; cursor:pointer; user-select:none; flex:none; margin-left:2px; }',
          '.dsh-fe-mdswitch input { position:absolute; opacity:0; width:0; height:0; pointer-events:none; }',
          '.dsh-fe-mdswitch-track { position:relative; display:inline-flex; align-items:center; padding:2px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 9%, transparent); }',
          '.dsh-fe-mdswitch-pill { position:absolute; top:50%; transform:translateY(calc(-50% - 0.5px)); left:2px; width:calc(50% - 3px); height:calc(100% - 4px); border-radius:6px; background:var(--dsw-alias-bg-layer-1); border:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 20%, transparent); box-shadow:0 1px 1px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); transition:left .12s ease; }',
          '.dsh-fe-mdswitch input:checked + .dsh-fe-mdswitch-track .dsh-fe-mdswitch-pill { left:2px; }',
          '.dsh-fe-mdswitch input:not(:checked) + .dsh-fe-mdswitch-track .dsh-fe-mdswitch-pill { left:calc(50% + 1px); }',
          '.dsh-fe-mdswitch-seg { position:relative; z-index:1; flex:1; text-align:center; font-size:11.5px; line-height:1.4; padding:1px 7px; color:var(--dsw-alias-label-secondary); transition:color .12s ease; }',
          '.dsh-fe-mdswitch input:checked + .dsh-fe-mdswitch-track .dsh-fe-mdswitch-edit { color:var(--dsw-alias-label-primary); font-weight:600; }',
          '.dsh-fe-mdswitch input:not(:checked) + .dsh-fe-mdswitch-track .dsh-fe-mdswitch-read { color:var(--dsw-alias-label-primary); font-weight:600; }',
          '.dsh-fe-mdswitch input:focus-visible + .dsh-fe-mdswitch-track { outline:2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); outline-offset:1px; }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-mdswitch-pill,.dsh-fe-mdswitch-seg { transition:none; } }',
          // ---- v1.19: session history 5-row cap + expand/collapse ----
          // Mirrors the shell's WorkspaceBrowser overflow control
          // (COLLAPSED_SESSION_LIMIT = 5 + .sessionOverflowButton): a
          // workspace's history section renders at most five rows; with
          // more, a full-width quiet button below them shows
          // "展开其余 N 个会话" (Show N more sessions) and toggles to
          // "收起" (Show less) — same height, transparent background,
          // left-aligned 12px text and tertiary → secondary hover as the
          // native button. Text indent = the session-title start point:
          // .dsh-fe-sess padding-left (40px) + .dsh-fe-dot width (7px) +
          // row gap (6px), so the label lines up with the history titles.
          '.dsh-fe-sess-more { width:100%; height:28px; border:none; border-radius:8px; padding:0 12px 0 calc(40px + 7px + 6px); background:transparent; cursor:pointer; text-align:left; font-size:12px; color:var(--dsw-alias-label-tertiary); }',
          '.dsh-fe-sess-more:hover { color:var(--dsw-alias-label-secondary); }',
          // ---- v1.20: session row dot menu + pin + manage mode ----
          // Hovering a history row crossfades the relative-time label into a
          // three-dot control pinned to the row's right edge (the dots have
          // their own soft hover chip). Clicking opens a floating mini
          // dropdown anchored under the dots (fixed-positioned, so the
          // sidebar's scroll container never clips it): two stacked rows,
          // each exactly two Chinese characters wide — 删除 / 置顶, or
          // 删除 / 取消 once pinned. Expand and collapse are animated
          // (scale + fade from the top-right corner).
          '.dsh-fe-sess { position:relative; }',
          '.dsh-fe-sess-time { transition:opacity .12s ease; }',
          '.dsh-fe-sess:hover .dsh-fe-sess-time { opacity:0; }',
          '.dsh-fe-sess-dots { position:absolute; right:6px; top:50%; transform:translateY(-50%); width:24px; height:20px; display:inline-flex; align-items:center; justify-content:center; border:none; background:transparent; border-radius:5px; color:var(--dsw-alias-label-secondary); opacity:0; cursor:pointer; transition:opacity .12s ease, background .12s ease, color .12s ease; }',
          '.dsh-fe-sess:hover .dsh-fe-sess-dots { opacity:1; }',
          '.dsh-fe-sess-dots:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent); color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-sess-dots:focus-visible { opacity:1; outline:2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); outline-offset:1px; }',
          // v1.20.2: the pin badge is clickable — clicking it unpins directly.
          '.dsh-fe-sess-pin { flex:none; display:inline-flex; margin-left:-1px; padding:2px; border-radius:5px; color:var(--dsw-alias-state-warn-primary); cursor:pointer; transition:background .12s ease, color .12s ease; }',
          '.dsh-fe-sess-pin:hover { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color:var(--dsw-alias-state-warn-primary); }',
          '.dsh-fe-sess-pin:focus-visible { outline:2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); outline-offset:1px; }',
          // v1.32.8: one rejected file inside the reject-refused dialog. The
          // path/error pair reuses .dsh-fe-ask-path + .dsh-fe-err so the dialog
          // needs no new colours; only the grouping and the thin separator are
          // new. First item has no rule (the body's own line acts as the head).
          '.dsh-fe-reject-item { margin-top:6px; padding-top:6px; border-top:1px solid var(--dsw-alias-border-l1); }',
          '.dsh-fe-reject-item .dsh-fe-ask-path { margin:0; }',
          '.dsh-fe-reject-item .dsh-fe-err { padding:2px 0 0; }',
          '.dsh-fe-menu-veil { position:fixed; inset:0; z-index:29; }',
          '.dsh-fe-sess-menu { position:fixed; z-index:31; display:flex; flex-direction:column; gap:1px; padding:3px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-shadow-lv2, 0 12px 32px rgba(0,0,0,.18)); transform-origin:top right; animation:dsh-fe-menu-in .14s ease-out; }',
          '.dsh-fe-sess-menu-close { animation:dsh-fe-menu-out .12s ease-in forwards; }',
          '@keyframes dsh-fe-menu-in { from { opacity:0; transform:translateY(-5px) scale(.94); } to { opacity:1; transform:none; } }',
          '@keyframes dsh-fe-menu-out { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(-5px) scale(.94); } }',
          '.dsh-fe-sess-menu-item { min-width:calc(2 * 1em + 10px); height:24px; display:flex; align-items:center; justify-content:center; padding:0 5px; border:none; background:transparent; border-radius:6px; color:var(--dsw-alias-label-secondary); font-size:12px; white-space:nowrap; cursor:pointer; transition:background .12s ease, color .12s ease; }',
          '.dsh-fe-sess-menu-item:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-sess-menu-item-no { color:var(--dsw-alias-state-error-primary); }',
          '.dsh-fe-sess-menu-item-no:hover { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color:var(--dsw-alias-state-error-primary); }',
          '.dsh-fe-sess-menu-item:disabled { opacity:.45; cursor:not-allowed; }',
          // v1.21.0: session history rows animate. Enter: quick fade + rise.
          // Leave: fade + slight slide out while the row's own height
          // collapses (max-height/padding/margin interpolated in the
          // keyframes — the row keeps its place until the mirror drops it,
          // so the list below closes in smoothly instead of jumping).
          '.dsh-fe-sess-in { animation:dsh-fe-sess-in .18s ease-out; }',
          '.dsh-fe-sess-out { overflow:hidden; animation:dsh-fe-sess-out .3s ease-in forwards; }',
          '@keyframes dsh-fe-sess-in { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }',
          '@keyframes dsh-fe-sess-out { from { opacity:1; transform:none; max-height:44px; margin-top:1px; margin-bottom:1px; padding-top:5px; padding-bottom:5px; } to { opacity:0; transform:translateX(-10px); max-height:0; margin-top:0; margin-bottom:0; padding-top:0; padding-bottom:0; } }',
          // Manage mode: the history header reveals a manage button on hover
          // (always visible while managing), where it is replaced by the
          // trash + cancel icon pair.
          '.dsh-fe-mgbtn { opacity:0; transition:opacity .12s ease, background .12s ease, color .12s ease; }',
          '.dsh-fe-sec:hover .dsh-fe-mgbtn, .dsh-fe-mgbtn-on { opacity:1; }',
          '.dsh-fe-mgbtn:focus-visible { opacity:1; outline:2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); outline-offset:1px; }',
          '.dsh-fe-mgbtn-no { color:var(--dsw-alias-state-error-primary); }',
          '.dsh-fe-mgbtn-no:hover { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color:var(--dsw-alias-state-error-primary); }',
          // v1.20.2: rest state is a plain text button「管理」(no icon) that
          // fades in on header hover; the manage state keeps the trash +
          // cancel icon pair. v1.20.3: both states are pinned to the same
          // 18px control height so entering manage mode does NOT grow the
          // section header row.
          '.dsh-fe-iconbtn.dsh-fe-mgbtn { width:18px; height:18px; }',
          '.dsh-fe-mgbtn-txt { display:inline-flex; align-items:center; height:18px; border:none; background:transparent; padding:0 8px; border-radius:6px; font-size:12px; color:var(--dsw-alias-label-secondary); white-space:nowrap; cursor:pointer; }',
          '.dsh-fe-mgbtn-txt:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-mgbtn-txt:focus-visible { outline:2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); outline-offset:1px; }',
          // Checkbox column in manage mode: a small rounded square (v1.20.1
          // shrunk one step: 15 → 13px, mark 12 → 10px); checked = business-
          // blue fill with a light check mark. The warning flash (delete
          // pressed with nothing selected) paints every visible checkbox
          // orange-yellow, shakes it twice and fades back — a single keyframe
          // replayed by remounting the boxes on each warn tick.
          '.dsh-fe-chk { width:13px; height:13px; flex:none; display:inline-flex; align-items:center; justify-content:center; border:1.5px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent); border-radius:3.5px; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent); color:transparent; cursor:pointer; transition:background .18s ease, border-color .18s ease, color .18s ease; }',
          '.dsh-fe-chk:hover { border-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 72%, transparent); }',
          '.dsh-fe-chk-on { background:var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary)); border-color:transparent; color:var(--dsw-alias-bg-base); }',
          '.dsh-fe-chk-dis { opacity:.35; cursor:default; }',
          '.dsh-fe-sess-sel { background:color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 12%, transparent); }',
          '@keyframes dsh-fe-chk-warn { 0% { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent); border-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent); transform:translateX(0); } 10% { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent); border-color:var(--dsw-alias-state-warn-primary); transform:translateX(0); } 20% { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent); border-color:var(--dsw-alias-state-warn-primary); transform:translateX(-4px); } 35% { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent); border-color:var(--dsw-alias-state-warn-primary); transform:translateX(4px); } 50% { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent); border-color:var(--dsw-alias-state-warn-primary); transform:translateX(-4px); } 65% { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent); border-color:var(--dsw-alias-state-warn-primary); transform:translateX(4px); } 78% { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent); border-color:var(--dsw-alias-state-warn-primary); transform:translateX(0); } 100% { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 8%, transparent); border-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent); transform:translateX(0); } }',
          '.dsh-fe-chk-warn { animation:dsh-fe-chk-warn 1.05s ease-in-out; }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-sess-time, .dsh-fe-sess-dots, .dsh-fe-sess-pin, .dsh-fe-sess-menu-item, .dsh-fe-mgbtn, .dsh-fe-mgbtn-txt, .dsh-fe-chk { transition:none; } .dsh-fe-sess-menu { animation:none; } .dsh-fe-sess-menu-close { animation:none; } .dsh-fe-chk-warn { animation:none; background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent); border-color:var(--dsw-alias-state-warn-primary); } .dsh-fe-sess-in { animation:none; } .dsh-fe-sess-out { animation:none; } }',
          // ---- v1.22: explicit selection + in-view search ----
          // Text selection is allowed on every code row (the shell's default
          // styles may restrict it; the contentEditable spans stay selectable
          // regardless, and the explicit rule keeps read-only rows too).
          '.dsh-fe-diff, .dsh-fe-code, .dsh-fe-line, .dsh-fe-txwrap, .dsh-fe-txwrap .dsh-fe-tx { user-select:text; -webkit-user-select:text; }',
          // ---- v1.32.0: editor-grade selection layer ----
          // A per-line contentEditable clamps the browser's own drag gesture
          // to the row it started in, so cross-line selection could never be
          // done natively. The editor now owns the gesture (see selCtl) and
          // paints the result here: one absolutely positioned tint per
          // selected line fragment. The layer is pinned to the scrollport's
          // padding box (left/top 0 inside the positioned `.dsh-fe-diff`), so
          // fragment rects can be written in plain viewport coordinates and
          // horizontal overflow is clipped by the layer itself instead of
          // needing the scroll offsets. Painted above the rows and their
          // sticky gutters, below the sticky header stack (2–6) so scrolling
          // headers still cover it; pointer-events:none keeps clicks and
          // drags on the text underneath.
          // v1.32.1: the layer spans the scrollport, NOT a zero-height strip.
          // With `height:0; overflow:hidden` every fragment painted at
          // top = (rowTop − scrollportTop) fell outside the layer's own clip box
          // and was never drawn — the drag looked like it did nothing even
          // though the model selection was correct. Measured: 0 of the
          // fragments survived the clip.
          // `bottom:0` makes the layer exactly the scrollport's padding box, so
          // a fragment's viewport coordinates can be written to left/top
          // unchanged. pointer-events:none keeps clicks on the text; the
          // scrollport now supplies the containing block (see .dsh-fe-diff).
          '.dsh-fe-sel { position:absolute; top:0; left:0; right:0; bottom:0; z-index:30; overflow:hidden; pointer-events:none; }',
          // The layer now spans the whole scrollport, so it must not inherit
          // layout from .dsh-fe-diff — an auto overflow here would give the
          // layer its own scrollbar. EXTRA_CSS lands after the block above.
          '.dsh-fe-diff > .dsh-fe-sel { display:block; overflow:hidden; }',
          '.dsh-fe-sel-seg { position:absolute; background:color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)) 30%, transparent); border-radius:2px; }',
          // Search pill: input + match counter + up/down arrows share ONE
          // background (the pill) so the controls read as an integrated
          // search box; it pins to the left of the diff jump pill in the
          // same zero-height sticky strip.
          '.dsh-fe-searchbar { display:flex; flex:none; align-items:center; gap:2px; margin:8px 6px 0 12px; padding:2px 3px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-shadow-lv1, 0 2px 4px 0 rgba(0,0,0,.05)); font-family:ui-monospace,Consolas,monospace; font-size:11.5px; color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-searchbox { border:none; outline:none; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; padding:3px 2px; min-width:80px; max-width:240px; }',
          '.dsh-fe-searchbox::placeholder { color:var(--dsw-alias-label-secondary); opacity:.8; }',
          '.dsh-fe-searchcount { flex:none; padding:0 3px; color:var(--dsw-alias-label-secondary); font-size:10.5px; white-space:nowrap; line-height:1; }',
          '.dsh-fe-searchbtn { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; flex:none; border:none; background:transparent; border-radius:6px; color:var(--dsw-alias-label-secondary); cursor:pointer; padding:0; }',
          '.dsh-fe-searchbtn:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); color:var(--dsw-alias-label-primary); }',
          '.dsh-fe-searchbtn:focus-visible { outline:1px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-label-secondary)); outline-offset:-1px; }',
          // Search hit marks (wrapped into the pointer-events:none overlay
          // layer): amber like most editors; the current hit gets the
          // stronger fill + outline.
          '.dsh-fe-hit { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 42%, transparent); border-radius:2px; }',
          '.dsh-fe-hit-cur { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 65%, transparent); outline:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 90%, transparent); border-radius:2px; }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-searchbar { transition:none; } }',
          // ---- v1.24: integrated terminal + project run button ----
          // ANSI palette (VS Code terminal colors) as theme-aware variables, so
          // colored command output stays legible in both color schemes.
          '.dsh-fe-term { --dsh-fe-a0:#3b3b3b; --dsh-fe-a1:#cd3131; --dsh-fe-a2:#107c10; --dsh-fe-a3:#7a6400; --dsh-fe-a4:#0451a5; --dsh-fe-a5:#bc05bc; --dsh-fe-a6:#0598bc; --dsh-fe-a7:#555555; --dsh-fe-a8:#666666; --dsh-fe-a9:#cd3131; --dsh-fe-a10:#107c10; --dsh-fe-a11:#7a6400; --dsh-fe-a12:#0451a5; --dsh-fe-a13:#bc05bc; --dsh-fe-a14:#0598bc; --dsh-fe-a15:#a5a5a5; display:flex; flex-direction:column; height:100%; min-height:0; }',
          'body[data-ds-dark-theme] .dsh-fe-term { --dsh-fe-a0:#666666; --dsh-fe-a1:#cd3131; --dsh-fe-a2:#0dbc79; --dsh-fe-a3:#e5e510; --dsh-fe-a4:#2472c8; --dsh-fe-a5:#bc3fbc; --dsh-fe-a6:#11a8cd; --dsh-fe-a7:#e5e5e5; --dsh-fe-a8:#666666; --dsh-fe-a9:#f14c4c; --dsh-fe-a10:#23d18b; --dsh-fe-a11:#f5f543; --dsh-fe-a12:#3b8eea; --dsh-fe-a13:#d670d6; --dsh-fe-a14:#29b8db; --dsh-fe-a15:#e5e5e5; }',
          '.dsh-fe-term-head { display:flex; align-items:center; gap:8px; padding:6px 10px 6px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); flex:none; font-size:12.5px; }',
          '.dsh-fe-term-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--dsw-alias-label-secondary); opacity:.55; }',
          '.dsh-fe-term-dot-on { background:var(--dsw-alias-state-success-primary); opacity:1; animation:dsh-fe-term-pulse 1.4s ease-in-out infinite; }',
          '@keyframes dsh-fe-term-pulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }',
          '.dsh-fe-term-title { font-weight:650; }',
          '.dsh-fe-term-cwd { font-family:ui-monospace,Consolas,monospace; font-size:11.5px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:46%; }',
          '.dsh-fe-term-cmd { font-family:ui-monospace,Consolas,monospace; font-size:11.5px; color:var(--dsw-alias-state-success-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:30%; }',
          '.dsh-fe-term-body { position:relative; flex:1; min-height:0; overflow:auto; padding:8px 12px 12px; background:var(--dsw-alias-bg-layer-2); font-family:ui-monospace,Consolas,"Cascadia Mono",monospace; font-size:12.5px; line-height:1.5; color:var(--dsw-alias-label-primary); white-space:pre; user-select:text; }',
          '.dsh-fe-term-line { min-height:1.5em; }',
          '.dsh-fe-term-motd { color:var(--dsw-alias-label-secondary); border-bottom:1px dashed var(--dsw-alias-border-l1); padding-bottom:6px; margin-bottom:6px; white-space:pre-wrap; }',
          '.dsh-fe-term-jump { position:sticky; bottom:0; float:right; margin-top:6px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:12px; font-size:11px; padding:2px 10px; cursor:pointer; }',
          '.dsh-fe-term-inputrow { display:flex; align-items:center; gap:6px; flex:none; padding:6px 10px; border-top:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); }',
          '.dsh-fe-term-prompt { font-family:ui-monospace,Consolas,monospace; font-size:13px; color:var(--dsw-alias-label-secondary); flex:none; }',
          '.dsh-fe-term-prompt-on { color:var(--dsw-alias-state-success-primary); }',
          '.dsh-fe-term-input { flex:1; min-width:0; border:none; outline:none; background:transparent; color:var(--dsw-alias-label-primary); font-family:ui-monospace,Consolas,monospace; font-size:12.5px; padding:3px 0; }',
          '.dsh-fe-term-input::placeholder { color:var(--dsw-alias-label-secondary); opacity:.7; }',
          // v1.29: icon-only run control — the label is the tooltip and the button
          // is a 22px square matching the toolbar's IconBtns, so the whole run
          // affordance is one glyph.
          // v1.32.9: that glyph has ONE meaning — run the file that is open. The
          // project-entry scanner and its right-click picker are gone with it. The
          // button probes on mount and on every tab switch so its tooltip names the
          // exact command BEFORE it runs, and a file that cannot be run is greyed,
          // with the reason as its tooltip and as a notice on click.
          '.dsh-fe-runbtn { display:inline-flex; align-items:center; justify-content:center; gap:0; flex:none; margin-left:6px; width:22px; height:22px; padding:0; border:1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); background:transparent; color:var(--dsw-alias-state-success-primary); border-radius:6px; font-size:12px; cursor:pointer; transition:background .12s ease,color .12s ease,border-color .12s ease; }',
          '.dsh-fe-runbtn:hover { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }',
          '.dsh-fe-runbtn:focus-visible { outline:1px solid var(--dsw-alias-state-success-primary); outline-offset:1px; }',
          // Detecting: the glyph fades while termDetect runs (no text label any
          // more, and no disabled attribute — a re-click just re-detects).
          '.dsh-fe-runbtn-wait { opacity:.55; }',
          '.dsh-fe-runbtn-busy { border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); color:var(--dsw-alias-state-error-primary); }',
          '.dsh-fe-runbtn-busy:hover { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }',
          // v1.32.9: the open file cannot be run (not a runnable extension, binary,
          // missing…). Greyed instead of hidden so the affordance stays put, and it
          // stays clickable so the click can explain WHY (a disabled button cannot).
          '.dsh-fe-runbtn-off { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); cursor:not-allowed; opacity:.9; }',
          '.dsh-fe-runbtn-off:hover { background:transparent; }',
          '.dsh-fe-runmenu { position:fixed; z-index:31; min-width:280px; max-width:min(520px, calc(100vw - 32px)); display:flex; flex-direction:column; gap:1px; padding:4px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); box-shadow:var(--dsw-shadow-lv2, 0 12px 32px rgba(0,0,0,.18)); transform-origin:top right; animation:dsh-fe-menu-in .14s ease-out; }',
          // The picker layer is rendered by FileView (RunMenuLayer), NOT by the
          // toolbar button: the toolbar is a sticky z-index:5 stacking context,
          // so a fixed menu inside it would paint below the shell resize handle
          // (z-index 8) and never receive the click.
          '.dsh-fe-runmenu-head { font-size:11px; font-weight:650; color:var(--dsw-alias-label-secondary); padding:4px 8px 5px; }',
          '.dsh-fe-runmenu-empty { font-size:12px; color:var(--dsw-alias-label-secondary); padding:6px 8px 8px; line-height:1.5; }',
          '.dsh-fe-runmenu-item { display:flex; align-items:center; gap:8px; text-align:left; width:100%; border:none; background:transparent; color:inherit; border-radius:6px; padding:5px 8px; cursor:pointer; font-size:12.5px; }',
          '.dsh-fe-runmenu-item:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); }',
          '.dsh-fe-runmenu-label { font-family:ui-monospace,Consolas,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:none; max-width:60%; }',
          '.dsh-fe-runmenu-src { font-size:10.5px; padding:0 6px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); flex:none; }',
          '.dsh-fe-runmenu-src-local { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }',
          '.dsh-fe-runmenu-detail { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
          '.dsh-fe-runmenu-foot { font-size:10.5px; color:var(--dsw-alias-label-secondary); padding:5px 8px 3px; border-top:1px solid var(--dsw-alias-border-l1); margin-top:2px; }',
          '.dsh-fe-runmenu-ok { align-self:flex-end; margin:5px 6px 3px; padding:3px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:transparent; color:var(--dsw-alias-label-primary); font-size:12px; cursor:pointer; }',
          '.dsh-fe-runmenu-ok:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); }',
          '@media (prefers-reduced-motion: reduce) { .dsh-fe-term-dot-on { animation:none; } }',
          // ---- v1.28: no shell width handles over the 文件/终端 views ----
          // DSH 0.1.5-rc.1's ConversationRoot renders two 40px col-resize strips
          // (data-width-handle, z-index 8) that drag the transcript content
          // width (--dsh-chat-user-width). They are meaningful for the
          // centered 对话 transcript and for the ledger-style 轨迹 view (which
          // suppresses them itself via data-conversation-composer-overlay),
          // but the 文件/终端 panes are full-width app surfaces: the strips
          // only hover a col-resize cursor and an out-of-place glow over the
          // editor and the terminal, and dragging one silently shifts the
          // transcript width from a view that never shows a transcript.
          //
          // Only the strip itself is hidden — never the width axis — so
          // switching back to 对话 keeps whatever width was configured, and a
          // drag started in 对话 may still continue while the view switches
          // (the handle stays mounted and only stops painting/hit-testing).
          // Keyed on the panes' own roots (.dsh-fe-viewer / .dsh-fe-term)
          // under the shell's scrollport anchor ([data-conversation-scroll],
          // ConversationRoot's .scrollBody, a SIBLING of the handles, so this
          // has() sees the live view). The shell's own stacking context is
          // untouched, so the fixed-width-dependent chrome (e.g. the run menu
          // layer) still reads the same column box it did before.
          'body:has([data-conversation-scroll] .dsh-fe-viewer) [data-width-handle], body:has([data-conversation-scroll] .dsh-fe-term) [data-width-handle] { display:none !important; }',
        ].join('\n')
        const ensureStyle = () => {
          if (styleEl) return
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-plugin', 'dsh-file-edit')
          styleEl.textContent = `\n.dsh-fe-btn { border:1px solid var(--dsw-alias-border-l1); background:transparent; border-radius:6px; padding:2px 8px; font-size:12px; cursor:pointer; color:inherit; }\n.dsh-fe-btn:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); }\n.dsh-fe-btn-ok { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }\n.dsh-fe-btn-ok:hover { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }\n.dsh-fe-btn-no { color:var(--dsw-alias-state-error-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }\n.dsh-fe-btn-no:hover { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }\n.dsh-fe-bar { display:flex; flex-direction:column; gap:4px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-2); }\n.dsh-fe-bar-head { display:flex; align-items:center; gap:8px; font-weight:600; font-size:13px; flex-wrap:wrap; }\n.dsh-fe-spacer { flex:1; }\n.dsh-fe-file-row { display:flex; align-items:center; gap:8px; padding:3px 6px; border-radius:6px; font-size:12.5px; }\n.dsh-fe-file-row:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-path { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; font-family:ui-monospace,Consolas,monospace; }\n.dsh-fe-chip { font-size:11px; padding:1px 6px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); white-space:nowrap; }\n.dsh-fe-chip-add { color:var(--dsw-alias-state-success-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 55%, transparent); }\n.dsh-fe-chip-del { color:var(--dsw-alias-state-error-primary); border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }\n.dsh-fe-stats { color:var(--dsw-alias-label-secondary); font-size:11.5px; white-space:nowrap; }\n.dsh-fe-viewer { display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); height:100%; }\n.dsh-fe-filetabs { display:flex; align-items:center; gap:4px; padding:4px 6px; border-bottom:1px solid var(--dsw-alias-border-l1); overflow-x:auto; flex:none; }\n.dsh-fe-filetab { display:flex; align-items:center; gap:5px; padding:3px 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:7px; font-size:12px; color:var(--dsw-alias-label-secondary); white-space:nowrap; cursor:pointer; }\n.dsh-fe-filetab:hover { color:var(--dsw-alias-label-primary); }\n.dsh-fe-filetab-on { background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }\n.dsh-fe-tab-x { border:none; background:transparent; cursor:pointer; color:var(--dsw-alias-label-secondary); border-radius:4px; padding:0 4px; font-size:11px; }\n.dsh-fe-tab-x:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 18%, transparent); color:var(--dsw-alias-label-primary); }\n.dsh-fe-diff { overflow:auto; position:relative; flex:1; font-family:ui-monospace,'Cascadia Code',Consolas,monospace; font-size:12.5px; line-height:1.5; }\n.dsh-fe-toolbar { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); font-size:12.5px; flex-wrap:wrap; }\n.dsh-fe-code { display:flex; flex-direction:column; min-width:max-content; }\n.dsh-fe-line { display:flex; }\n.dsh-fe-ln { width:4ch; flex:none; text-align:right; padding-right:8px; color:var(--dsw-alias-label-secondary); user-select:none; background:color-mix(in srgb, var(--dsw-alias-label-secondary) 6%, transparent); }\n.dsh-fe-tx { white-space:pre; padding-right:16px; }\n.dsh-fe-old { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }\n.dsh-fe-new { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); }\n.dsh-fe-hunk { position:relative; margin:2px 0; border-radius:4px; }\n.dsh-fe-hunk:hover { outline:1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 40%, transparent); }\n.dsh-fe-hunk-head { position:sticky; left:0; display:flex; align-items:center; gap:6px; padding:2px 8px; font-size:11.5px; color:var(--dsw-alias-label-secondary); background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-msg { padding:10px; color:var(--dsw-alias-label-secondary); font-size:12.5px; }\n.dsh-fe-err { padding:4px 10px; color:var(--dsw-alias-state-error-primary); font-size:12px; }\n.dsh-fe-wsroot { display:flex; flex-direction:column; height:100%; overflow:hidden; background:var(--dsw-specific-sidebar-fill); }\n.dsh-fe-wshead { display:flex; align-items:center; gap:8px; padding:6px 10px; font-weight:600; font-size:13px; border-bottom:1px solid var(--dsw-alias-border-l1); }\n.dsh-fe-wslist { flex:1; overflow:auto; padding:4px 0; }\n.dsh-fe-ws-item { padding:3px 4px; border-radius:6px; }\n.dsh-fe-ws-row { display:flex; align-items:center; gap:5px; padding:4px 8px; cursor:pointer; border-radius:6px; font-size:13px; white-space:nowrap; }\n.dsh-fe-ws-row:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-ws-row-open { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent); }\n.dsh-fe-chev { width:14px; flex:none; text-align:center; color:var(--dsw-alias-label-secondary); }\n.dsh-fe-ws-name { flex:1; overflow:hidden; text-overflow:ellipsis; }\n.dsh-fe-sec { display:flex; align-items:center; gap:5px; padding:3px 8px 3px 22px; cursor:pointer; font-size:12.5px; color:var(--dsw-alias-label-secondary); border-radius:6px; white-space:nowrap; }\n.dsh-fe-sec:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-sec-open { color:var(--dsw-alias-label-primary); font-weight:600; }\n.dsh-fe-sess { display:flex; align-items:center; gap:6px; padding:3px 8px 3px 40px; cursor:pointer; font-size:12.5px; border-radius:6px; white-space:nowrap; }\n.dsh-fe-sess:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-sess-cur { font-weight:600; }\n.dsh-fe-sess-name { flex:1; overflow:hidden; text-overflow:ellipsis; }\n.dsh-fe-dot { width:7px; height:7px; border-radius:50%; flex:none; background:transparent; }\n.dsh-fe-dot-run { background:var(--dsw-alias-state-warn-primary); }\n.dsh-fe-dot-done { background:var(--dsw-alias-state-success-primary); }\n.dsh-fe-newbtn { border:1px dashed var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary); border-radius:6px; margin:2px 8px 2px 40px; padding:2px 8px; font-size:12px; cursor:pointer; }\n.dsh-fe-newbtn:hover { color:var(--dsw-alias-label-primary); background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-children { margin-left:14px; }\n.dsh-fe-row { display:flex; align-items:center; gap:4px; padding:2px 8px; cursor:pointer; white-space:nowrap; font-size:12.5px; }\n.dsh-fe-row:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent); }\n.dsh-fe-dir { font-weight:600; }\n.dsh-fe-name { overflow:hidden; text-overflow:ellipsis; }\n.dsh-fe-rail { display:flex; flex-direction:column; align-items:center; gap:6px; padding:8px 0; background:var(--dsw-specific-sidebar-fill); }\n.dsh-fe-railbtn { width:34px; height:34px; display:flex; align-items:center; justify-content:center; font-size:17px; border:none; background:transparent; border-radius:8px; cursor:pointer; }\n.dsh-fe-railbtn:hover { background:color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); }\n`
          document.head.append(styleEl)
          styleEl.textContent += EXTRA_CSS
        }
        const removeStyle = () => { if (styleEl) { styleEl.remove(); styleEl = null } }

        // ---------- icon glyphs (inline svg, currentColor strokes) ----------
        const svgBase = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
        const I = (size, vb, children, extra) => React.createElement('svg', { ...svgBase, ...(extra || {}), width: size, height: size, viewBox: vb }, children)
        const P = (d, extra) => React.createElement('path', { d: d, ...(extra || {}) })
        // Decision glyphs share one drawing basis (14-height band, optically
        // centered) so check/cross/accept-all/reject-all sit on one line
        // wherever they render. Stroke 1.8, round caps.
        const CHECK_D = 'M3.1 7.5 L5.9 10.1 L10.9 3.9'
        const IconCheck = () => I(14, '0 0 14 14', [P(CHECK_D)], { strokeWidth: 1.8 })
        const IconCross = () => I(14, '0 0 14 14', [P('M4.3 4.3 L9.7 9.7'), P('M9.7 4.3 L4.3 9.7')], { strokeWidth: 1.8 })
        // Accept-all: the SAME check shape twice, tightly nested but with a
        // touch more air than v1.4.6 — the right check overlaps the left
        // box slightly so the pair reads as one gesture, while a small gap
        // between the legs keeps both ticks distinguishable. Left one fades
        // back (.dsh-fe-ic-sub).
        const IconDoubleCheck = () => I(22, '0 0 22 14', [
          P(CHECK_D, { className: 'dsh-fe-ic-sub' }),
          P('M8.4 7.5 L11.2 10.1 L15.8 4.1'),
        ], { strokeWidth: 1.8 })
        // Reject-all: one cross with a WIDE, round-capped gap across the
        // bottom-left → top-right diagonal (the gap spans the middle third
        // and then some), so the top-left → bottom-right stroke clearly reads
        // as woven over it.
        const IconRejectAll = () => I(14, '0 0 14 14', [
          P('M4.3 9.7 L5.1 8.9'),
          P('M8.9 5.1 L9.7 4.3'),
          P('M4.3 4.3 L9.7 9.7'),
        ], { strokeWidth: 1.8 })
        const IconRefresh = () => I(14, '0 0 14 14', [
          P('M12.5 7 a5.5 5.5 0 1 1 -5.5 -5.5 c1.6 0 3.1 .7 4.1 1.9 L12.5 4.9'),
          P('M12.5 1.5 v3.4 h-3.4'),
        ])
        const IconFolder = () => I(14, '0 0 14 14', [P('M2 4.3 a1 1 0 0 1 1 -1 h2.6 L7 4.7 h4 a1 1 0 0 1 1 1 V10 a1 1 0 0 1 -1 1 H3 a1 1 0 0 1 -1 -1 Z')])
        const IconFile = () => I(14, '0 0 14 14', [P('M4.5 2.5 h4 L11 5 v6 a1 1 0 0 1 -1 1 h-5.5 a1 1 0 0 1 -1 -1 v-7.5 a1 1 0 0 1 1 -1 Z'), P('M8.5 2.5 V5 H11')])
        const IconChevron = () => I(12, '0 0 14 14', [P('M5.5 3.5 L9 7 L5.5 10.5')])
        // v1.8.1: wide, slightly taller chevrons for the collapse toggle
        // (the old 11px glyphs read too small/narrow).
        const IconChevUp = () => React.createElement('svg', { ...svgBase, width: 16, height: 12, viewBox: '0 0 16 12', strokeWidth: 2 }, [P('M2.5 8.5 L8 3 L13.5 8.5')])
        const IconChevDown = () => React.createElement('svg', { ...svgBase, width: 16, height: 12, viewBox: '0 0 16 12', strokeWidth: 2 }, [P('M2.5 3.5 L8 9 L13.5 3.5')])
        const IconClock = () => I(14, '0 0 14 14', [React.createElement('circle', { cx: 7, cy: 7, r: 5.3 }), P('M7 4.2 V7 L9.2 8.4')])
        // v1.12.3: the shell's own running indicator — StateDot state="ongoing"
        // (packages/client/ui-primitives/src/StateDot.tsx + StateDot.module.css):
        // a 3x3 pixel matrix whose 8 outer cells chase clockwise with a stepped
        // brightness trail. Static client bundles cannot import shell packages,
        // so this is a faithful replica: same 10x10 viewBox, crispEdges, cell
        // geometry, keyframe steps and per-rect negative delays
        // ((index - 8) * 125ms), blue via the same --dsw-static-deepseek-450.
        const IconRunning = () => React.createElement('svg', {
          width: 10, height: 10, viewBox: '0 0 10 10',
          shapeRendering: 'crispEdges', 'aria-hidden': true,
          className: 'dsh-fe-run-matrix',
        }, [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4]].map((c, index) =>
          React.createElement('rect', {
            key: c[0] + '-' + c[1],
            className: 'dsh-fe-run-cell',
            x: c[0], y: c[1], width: 2, height: 2,
            style: { animationDelay: ((index - 8) * 125) + 'ms' },
          })))
        const IconPencil = () => I(14, '0 0 14 14', [P('M12 3.6 L10.4 2 a1.1 1.1 0 0 0 -1.6 0 L3.4 7.4 V10.6 H6.6 L12 5.2 a1.1 1.1 0 0 0 0 -1.6 Z'), P('M8.6 2.8 L11.2 5.4')])
        // v1.24: run/stop glyphs for the project run button.
        const IconPlay = () => React.createElement('svg', { ...svgBase, width: 11, height: 11, viewBox: '0 0 12 12', fill: 'currentColor', stroke: 'none', 'aria-hidden': true }, React.createElement('path', { d: 'M3 1.8 L10 6 L3 10.2 Z' }))
        const IconStop = () => React.createElement('svg', { ...svgBase, width: 11, height: 11, viewBox: '0 0 12 12', fill: 'currentColor', stroke: 'none', 'aria-hidden': true }, React.createElement('rect', { x: 2.6, y: 2.6, width: 6.8, height: 6.8, rx: 1.2 }))
        const IconPlus = () => I(12, '0 0 14 14', [P('M7 2.5 V11.5'), P('M2.5 7 H11.5')])
        const IconClose = () => I(11, '0 0 14 14', [P('M4 4 L10 10'), P('M10 4 L4 10')])
        // v1.20: session-history controls. Dots = three steady dots on the
        // row baseline; pin = ball-head pin (ringed head + center dot +
        // needle — clickable to unpin, v1.20.2); trash = bin with lid and
        // handle; check = the checkbox mark (reuses the decision-glyph
        // geometry, drawn small and bold for a 13px box).
        // v1.20.1: dots at 20px field. v1.20.2: back down to a compact 16px
        // field (smaller dots, narrower button) per user feedback.
        // v1.20.3: a touch more air between the dots (6px pitch, 18px field).
        const IconDots = () => React.createElement('svg', { ...svgBase, width: 18, height: 14, viewBox: '0 0 18 14' }, [
          React.createElement('circle', { cx: 3, cy: 7, r: 1.4, fill: 'currentColor', stroke: 'none' }),
          React.createElement('circle', { cx: 9, cy: 7, r: 1.4, fill: 'currentColor', stroke: 'none' }),
          React.createElement('circle', { cx: 15, cy: 7, r: 1.4, fill: 'currentColor', stroke: 'none' }),
        ])
        // v1.20.2: redrawn pin — a ball-head pin seen from the front: ring
        // head with a solid center dot and a clean needle. Reads brighter and
        // friendlier than the old pentagon pushpin at 14px.
        const IconPin = () => React.createElement('svg', { ...svgBase, width: 14, height: 14, viewBox: '0 0 14 14' }, [
          React.createElement('circle', { cx: 7, cy: 4.2, r: 2.35 }),
          React.createElement('circle', { cx: 7, cy: 4.2, r: 0.8, fill: 'currentColor', stroke: 'none' }),
          P('M7 6.55 V12'),
        ])
        const IconTrash = () => I(14, '0 0 14 14', [
          P('M2.8 3.8 H11.2'),
          P('M5.3 3.8 V2.6 a.9 .9 0 0 1 .9 -.9 h1.6 a.9 .9 0 0 1 .9 .9 V3.8'),
          P('M4.1 3.8 L4.6 10.9 a1 1 0 0 0 1 .9 h2.8 a1 1 0 0 0 1 -.9 L9.9 3.8'),
        ])
        const IconChk = () => I(10, '0 0 14 14', [P('M3.4 7.2 L6 9.6 L10.8 4.4')], { strokeWidth: 2.4 })
        const IconBtn = (props) => React.createElement('button', {
          type: 'button',
          title: props.title,
          className: 'dsh-fe-iconbtn' + (props.tone === 'ok' ? ' dsh-fe-iconbtn-ok' : props.tone === 'no' ? ' dsh-fe-iconbtn-no' : '') + (props.small ? ' dsh-fe-iconbtn-sm' : '') + (props.className ? ' ' + props.className : ''),
          onClick: props.onClick,
        }, props.icon ? props.icon() : null)

        // ---------- file tree node ----------
        // v1.15: the host decorates tree nodes with git VCS letters
        // (node.git: M/U/A/D/R) and an ignored flag (node.ignored, from
        // git check-ignore). The badge sits at the row's right edge; ignored
        // files/folders gray out. Titles explain the letter on hover.
        //
        // v1.30: the tree is LAZY. A directory row asks the host for its
        // immediate children the first time it is expanded (`listDir`) and the
        // answer lives in the per-workspace cache — the root listing no longer
        // drags the whole workspace (dependency folders included) into one
        // payload before the first row can render. `props.lazy === false` marks
        // the fallback: the host module had no listDir (a hot-reloaded client
        // bundle against a not-yet-restarted host), so the whole tree came from
        // `listTree` and every node already carries its children — behaviour is
        // then exactly the pre-v1.30 one.
        const GIT_TITLES = {
          M: 'Modified — 已修改（未提交）',
          U: 'Untracked — 未跟踪',
          A: 'Added — 已暂存的新增',
          D: 'Deleted — 已删除',
          R: 'Renamed — 已重命名',
        }
        function TreeNode(props) {
          const node = props.node
          const depth = props.depth || 0
          const lazy = props.lazy === true
          const [open, setOpen] = React.useState(depth < 1)
          const badge = node.git
            ? React.createElement('span', { className: 'dsh-fe-git dsh-fe-git-' + String(node.git).toLowerCase(), title: GIT_TITLES[node.git] || node.git }, node.git)
            : null
          const rowCls = 'dsh-fe-row' + (node.type === 'directory' ? ' dsh-fe-dir' : ' dsh-fe-file') +
            (node.type === 'directory' && open ? ' dsh-fe-open' : '') +
            (node.ignored ? ' dsh-fe-row-ignored' : '')
          const ignoredNote = node.ignored ? '（被 .gitignore 排除）\n' : ''
          const entry = lazy && node.type === 'directory' ? props.cache.get(node.path) : undefined
          // Ask for this level once it is open and the cache holds no answer
          // yet (including right after a treeStamp reload cleared the cache).
          // The host call is guarded by the cache entry itself: a loaded or
          // in-flight level is a no-op, so this effect may run every render.
          React.useEffect(() => {
            if (!lazy || !open || node.type !== 'directory') return
            if (entry && (entry.loaded || entry.loading)) return
            props.onLoadDir(node.path)
          })
          if (node.type === 'directory') {
            const kids = lazy ? ((entry && entry.children) || []) : (node.children || [])
            const loading = !!(lazy && entry && entry.loading)
            const dirErr = lazy && entry && entry.error ? entry.error : null
            // Before the first load there is no way to know whether a folder is
            // empty, so the chevron is drawn optimistically — except for a
            // wholly gitignored folder, which the whole-tree path also treated
            // as a leaf. Once an empty listing arrives the chevron goes away.
            const knownEmpty = lazy ? !!(entry && entry.loaded && kids.length === 0) : kids.length === 0
            const canExpand = !node.ignored && !knownEmpty
            return React.createElement('div', null,
              React.createElement('div', {
                className: rowCls,
                // v1.32.4: closing a folder tells the owner to evict its cached
                // level (see evictDir) — in lazy mode only, since the eager
                // fallback has no per-level cache.
                onClick: () => { if (open && lazy) props.onCloseDir(node.path); setOpen(!open) },
                title: ignoredNote + (node.path || node.name),
              },
                React.createElement('span', { className: 'dsh-fe-chev' }, canExpand ? IconChevron() : null),
                React.createElement('span', { className: 'dsh-fe-ic' }, IconFolder()),
                React.createElement('span', { className: 'dsh-fe-name' }, node.name),
                badge,
              ),
              open ? React.createElement('div', { className: 'dsh-fe-children' },
                loading ? React.createElement('div', { className: 'dsh-fe-msg dsh-fe-dirmsg' }, '加载中…') : null,
                dirErr ? React.createElement('div', { className: 'dsh-fe-msg dsh-fe-dirmsg' }, String(dirErr)) : null,
                lazy && entry && entry.loaded && kids.length === 0 && !node.ignored
                  ? React.createElement('div', { className: 'dsh-fe-msg dsh-fe-dirmsg' }, '（空）') : null,
                lazy && entry && entry.truncated
                  ? React.createElement('div', { className: 'dsh-fe-msg dsh-fe-dirmsg' }, '（目录过大，仅显示前 ' + (entry.limit || 4000) + ' 项）') : null,
                kids.map((c) => React.createElement(TreeNode, { key: c.name, node: c, depth: depth + 1, onOpen: props.onOpen, lazy: lazy, cache: props.cache, onLoadDir: props.onLoadDir, onCloseDir: props.onCloseDir })),
              ) : null,
            )
          }
          return React.createElement('div', {
            className: rowCls,
            title: ignoredNote + node.path,
            onClick: () => props.onOpen(node.path),
            onDoubleClick: () => props.onOpen(node.path),
          },
            React.createElement('span', { className: 'dsh-fe-chev' }, null),
            React.createElement('span', { className: 'dsh-fe-ic' }, IconFile()),
            React.createElement('span', { className: 'dsh-fe-name' }, node.name),
            badge,
          )
        }

        // v1.11: compact relative-age label for session rows ("2 min",
        // "1 hr", "1 day" — bucket style matching the user's requested
        // format; no plural suffixes by design).
        const timeAgo = (ts, now) => {
          const t = Number(ts)
          if (!t) return ''
          const MIN = 60000, HOUR = 3600000, DAY = 86400000
          const diff = Math.max(0, now - t)
          if (diff < MIN) return 'now'
          if (diff < HOUR) return Math.floor(diff / MIN) + ' min'
          if (diff < DAY) return Math.floor(diff / HOUR) + ' hr'
          if (diff < 30 * DAY) return Math.floor(diff / DAY) + ' day'
          if (diff < 365 * DAY) return Math.floor(diff / (30 * DAY)) + ' mo'
          return Math.floor(diff / (365 * DAY)) + ' yr'
        }

        // v1.19: session-history overflow cap, mirroring the shell's own
        // WorkspaceBrowser overflow control (COLLAPSED_SESSION_LIMIT = 5).
        const SESSION_HISTORY_LIMIT = 5

        // ---------- sidebar workspace tree ----------
        function WorkspaceNode(props) {
          const ws = props.ws
          const byId = props.byId
          const currentId = props.currentId
          const sid = store.sessionId
          const [open, setOpen] = React.useState(false)
          // v1.8.3: the two sections collapse/expand INDEPENDENTLY (the old
          // single `section` state made them mutually exclusive).
          const [secHistory, setSecHistory] = React.useState(false)
          const [secFiles, setSecFiles] = React.useState(false)
          const [tree, setTree] = React.useState(null)
          const [treeError, setTreeError] = React.useState(null)
          const [treeLoading, setTreeLoading] = React.useState(false)
          // v1.30: lazy-tree bookkeeping. `dirRef.cache` maps a workspace-
          // relative directory path to its listing state
          // ({children, loaded, loading, error, truncated}); `dirRef.mode` is
          // 'lazy' | 'eager' | 'unknown' (eager = the host had no listDir, see
          // loadFiles). The Map is mutated in place and `dirTick` forces the
          // re-render — same shape as the other transient caches in this file.
          const dirRef = React.useState(() => ({ mode: 'unknown', cache: new Map() }))[0]
          const [dirTick, setDirTick] = React.useState(0)
          // v1.32.4: per-path generation counter for EVICTED levels. The cache
          // used to keep a level alive after it was collapsed, so the 20s silent
          // poll went on re-listing every folder the user had ever opened — a
          // single wide folder (measured: ~470ms for 4000 entries, plus ~65ms of
          // git) then cost that much on every 20s tick, forever, even after it
          // was collapsed and even from another Session in the same Workspace.
          // Dropping the cache entry is not enough on its own: fetchDir writes
          // through putDir after its await, so an in-flight response would
          // resurrect the entry and the poll would keep hitting it. A request
          // therefore captures this counter before it is sent and discards its
          // own late answer once the counter has moved (evicted, or superseded
          // by the re-expand that followed).
          const dirGen = React.useState(() => new Map())[0]
          const [query, setQuery] = React.useState('')
          // v1.19: whether the session-history overflow control has been
          // expanded (transient per-mount state, same as the shell's
          // expandedSessionGroups — no persistence by design).
          const [histExpanded, setHistExpanded] = React.useState(false)
          // v1.20: session-row dot menu (which session's action card is open),
          // manage mode (batch select/delete), selected ids, warning flash
          // state, confirm dialog and the in-flight delete flag.
          // v1.20.1: the menu is a fixed-position floating mini dropdown
          // anchored under the dots — menuPos holds the viewport anchor from
          // the dots' bounding rect, menuClosing runs the collapse animation
          // before unmount.
          const [menuFor, setMenuFor] = React.useState(null)
          const [menuPos, setMenuPos] = React.useState(null)
          const [menuClosing, setMenuClosing] = React.useState(false)
          const menuTimer = React.useState({ h: null })[0]
          const [managing, setManaging] = React.useState(false)
          const [sel, setSel] = React.useState(null)
          const [warnOn, setWarnOn] = React.useState(false)
          const [warnTick, setWarnTick] = React.useState(0)
          const warnRef = React.useState({ c: null })[0]
          const [confirmDel, setConfirmDel] = React.useState(null)
          const [delErr, setDelErr] = React.useState(null)
          const [deleting, setDeleting] = React.useState(false)
          const [pinTick, setPinTick] = React.useState(0)
          // v1.21.0: enter/leave animation mirror for session history rows
          // (same pattern as the modified-bar rows). `sessRows` is the
          // RENDERED list; the derived `shownSessions` stays the logical one.
          // Rows that vanish from the derived list (deletion, search
          // filtering, overflow collapse) stay mounted with the -out class
          // until the animation finishes; new rows enter with -in.
          const [sessRows, setSessRows] = React.useState(null)
          const sessAnimRef = React.useState({ t: null, sig: null })[0]
          React.useEffect(() => pinStore.subscribe(() => setPinTick((n) => n + 1)), [])
          React.useEffect(() => () => {
            if (warnRef.c) { try { warnRef.c() } catch (e) {} }
            if (menuTimer.h) { try { menuTimer.h() } catch (e) {} }
            if (sessAnimRef.t) { try { sessAnimRef.t() } catch (e) {} }
          }, [])
          const openMenu = (id, rect) => {
            if (menuFor === id) { closeMenu(); return }
            if (menuTimer.h) { try { menuTimer.h() } catch (e) {} }
            setMenuClosing(false)
            setMenuFor(id)
            if (rect) {
              setMenuPos({ top: rect.bottom + 4, right: (window.innerWidth || 0) - rect.right })
            }
          }
          const closeMenu = () => {
            if (menuFor === null) return
            setMenuClosing(true)
            if (menuTimer.h) { try { menuTimer.h() } catch (e) {} }
            menuTimer.h = ctx.timeout(() => { setMenuFor(null); setMenuClosing(false); menuTimer.h = null }, 130)
          }
          // Delete pressed with nothing selected: repaint every visible
          // checkbox orange-yellow, shake twice, fade back. The tick remounts
          // the boxes so the CSS keyframe replays on each press; the timeout
          // drops the class so expanding the section later does NOT replay.
          const flashWarn = () => {
            setWarnTick((n) => n + 1)
            setWarnOn(true)
            if (warnRef.c) { try { warnRef.c() } catch (e) {} }
            warnRef.c = ctx.timeout(() => { setWarnOn(false); warnRef.c = null }, 1150)
          }
          const toggleSel = (id) => {
            setSel((prev) => {
              const next = new Set(prev || [])
              if (next.has(id)) next.delete(id); else next.add(id)
              return next
            })
          }
          const refreshSessions = async () => {
            // Re-pull both baselines so the deleted ids vanish from the sidebar
            // groups immediately (Host workspace.list + session.list reconcile
            // against the JSONL store on request).
            try { if (ctx.workspaces && ctx.workspaces.refresh) await ctx.workspaces.refresh() } catch (e) {}
            try { if (ctx.sessions && ctx.sessions.refresh) await ctx.sessions.refresh() } catch (e) {}
          }
          const doDelete = async (ids) => {
            if (!ids || ids.length === 0) return
            setDeleting(true)
            setDelErr(null)
            const payload = ids.map((id) => ({ sessionId: id, cwd: (byId[id] && byId[id].cwd) || ws.path }))
            try {
              const r = await call('deleteSessions', { sessions: payload })
              if (!r.ok) { setDelErr(r.error || '删除失败'); return }
              const failed = (r.results || []).filter((x) => !x.ok)
              if (failed.length > 0) {
                const live = failed.some((x) => x.error === 'session-live')
                const gone = failed.some((x) => x.error === 'not-found')
                const names = failed.map((x) => (byId[x.sessionId] && byId[x.sessionId].displayTitle) || x.sessionId).join('、')
                // v1.20.4: explain the live case — a session stays attached to
                // the DSH host for the whole process run once opened/resumed;
                // running=False only means no turn is active right now.
                let why = ''
                if (live) {
                  const running = failed.some((x) => byId[x.sessionId] && byId[x.sessionId].running)
                  why = running
                    ? '（该会话的 agent 正在运行，暂不能删除）'
                    : '（该会话仍被 DSH 保持打开——可能仍在浏览器标签页中；重启 DSH 后即可删除）'
                } else if (gone) {
                  why = '（会话记录不存在）'
                }
                setDelErr('无法删除：' + names + why)
              }
              // v1.20.4: clear pins ONLY for the sessions actually deleted —
              // a failed delete must not silently drop the pin.
              const okIds = (r.results || []).filter((x) => x.ok).map((x) => x.sessionId)
              pinStore.clear(okIds)
              setSel(null)
              await refreshSessions()
            } finally {
              setDeleting(false)
            }
          }
          const confirmAndDel = (ids) => setConfirmDel({ ids: ids.slice() })
          const selectedCount = sel ? sel.size : 0
          // v1.30: record one directory listing in the cache and repaint.
          const putDir = (path, patch) => {
            const prev = dirRef.cache.get(path)
            dirRef.cache.set(path, Object.assign({ children: [], loaded: false, loading: false, error: null, truncated: false }, prev, patch))
            setDirTick((n) => n + 1)
          }
          // Fetch ONE level into the cache. `keep` leaves the current children
          // in place while the request is in flight (the 20s silent poll must
          // not blank out folders the user has open).
          const fetchDir = async (path, keep) => {
            const cur = dirRef.cache.get(path)
            if (cur && cur.loading) return
            const gen = dirGen.get(path) || 0
            putDir(path, keep ? { loading: true } : { children: [], loaded: false, loading: true, error: null })
            const r = await call('listDir', { sessionId: sid, root: ws.path, path: path })
            // v1.32.4: the level was evicted (collapsed) or superseded while this
            // request was in flight — drop the answer instead of resurrecting a
            // cache entry that would put the folder back on the 20s poll. This
            // also fixes a pre-existing race where a stale response could land
            // on top of the request the re-expand had already started.
            if ((dirGen.get(path) || 0) !== gen) return
            if (r && r.ok) putDir(path, { children: r.children || [], loaded: true, loading: false, error: null, truncated: !!r.truncated, limit: Number(r.limit) || 0 })
            else putDir(path, { children: keep && cur ? cur.children : [], loaded: true, loading: false, error: (r && r.error) || '加载失败' })
          }
          // A directory row asks for its level when it opens. Already loaded or
          // in-flight → no-op, which is what makes TreeNode's render-time
          // effect safe to run on every render.
          const loadDir = (path) => {
            const cur = dirRef.cache.get(path)
            if (cur && (cur.loaded || cur.loading)) return
            void fetchDir(path, false)
          }
          // v1.32.4: collapsing a folder EVICTS its level, so it stops being
          // polled and its next expand re-reads the directory. Only this one
          // level needs dropping — collapsing unmounts the whole subtree, so no
          // descendant row survives to be refreshed on its own, and B's own
          // entry (A→B both open when A closed) is inert once nothing renders
          // it. The generation bump is the part that makes the eviction hold
          // against an in-flight response; see dirGen above.
          const evictDir = (path) => {
            if (!dirRef.cache.has(path) && !dirGen.has(path)) return
            dirGen.set(path, (dirGen.get(path) || 0) + 1)
            dirRef.cache.delete(path)
            setDirTick((n) => n + 1)
          }
          // v1.15.1: `silent` reloads skip the '…' busy indicator — the 20s
          // background re-check below must not flash the refresh button.
          // v1.30: the tree loads ONE level at a time. The root listing comes
          // from `listDir('')`; each expansion fetches its own level on demand
          // (see loadDir). A host module that predates v1.30 has no listDir —
          // its client bundle is hot-reloaded while the host is not — so the
          // first 'no such method' switches this workspace to the pre-v1.30
          // whole-tree `listTree` path instead of showing an error.
          const listWholeTree = async () => {
            const r = await call('listTree', { sessionId: sid, root: ws.path })
            if (r.ok) { setTree(r.tree); setTreeError(null) }
            else setTreeError(r.error || '加载失败')
          }
          const loadFiles = async (force, silent) => {
            if (!force && (tree || treeError)) return
            if (!sid) { setTreeError('打开会话后可用'); return }
            if (!silent) setTreeLoading(true)
            try {
              if (dirRef.mode === 'eager') { await listWholeTree(); return }
              // Background re-check with a warm cache: refresh exactly the
              // levels already on screen (root included) and leave the cache
              // intact, so nothing collapses and no row flashes.
              if (silent && dirRef.mode === 'lazy' && dirRef.cache.size > 0) {
                for (const p of Array.from(dirRef.cache.keys())) await fetchDir(p, true)
                return
              }
              const r = await call('listDir', { sessionId: sid, root: ws.path, path: '' })
              if (r && r.ok) {
                dirRef.mode = 'lazy'
                dirRef.cache.clear()
                dirRef.cache.set('', { children: r.children || [], loaded: true, loading: false, error: null, truncated: !!r.truncated })
                setTree({ name: '.', type: 'directory', path: '', children: r.children || [] })
                setTreeError(null)
                setDirTick((n) => n + 1)
                return
              }
              if (r && r.error && /no such method/i.test(String(r.error))) {
                dirRef.mode = 'eager'
                await listWholeTree()
                return
              }
              setTreeError((r && r.error) || '加载失败')
            } finally {
              if (!silent) setTreeLoading(false)
            }
          }
          // v1.11: history ordered by recency — newest session on top (the
          // host's sessionIds order reflects creation/attachment, not
          // activity). Equal timestamps keep the host order (stable sort).
          // v1.20: pinned sessions float above everything, and each group
          // (pinned / rest) sorts by last activity — "多个被置顶的会话按
          // 最后时间排序".
          const sessions = (ws.sessionIds || [])
            .map(id => byId[id])
            .filter(s => s !== undefined)
            .filter(s => !query || (s.displayTitle || '').toLowerCase().indexOf(query.toLowerCase()) >= 0 || s.id.toLowerCase().indexOf(query.toLowerCase()) >= 0)
            .sort((a, b) => {
              const pa = pinStore.has(a.id) ? 1 : 0
              const pb = pinStore.has(b.id) ? 1 : 0
              if (pa !== pb) return pb - pa
              return ((Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0))
            })
          // v1.19: at most SESSION_HISTORY_LIMIT history rows render at once;
          // the overflow control below expands the rest (mirrors the shell's
          // COLLAPSED_SESSION_LIMIT + sessionOverflowButton). An active
          // search lifts the cap — matching results are the way to reach
          // older sessions, exactly like the shell's search surface.
          const searching = query !== ''
          const shownSessions = histExpanded || searching
            ? sessions
            : sessions.slice(0, SESSION_HISTORY_LIMIT)
          // v1.21.0: reconcile the rendered mirror with the derived list.
          // Keyed on the id signature so search keystrokes / overflow
          // collapse / post-delete refreshes all animate rows in and out
          // instead of snapping. A row that left stays for the animation
          // (320ms > the .3s leave animation), then the timer drops it.
          const sessSig = shownSessions.map((s) => s.id).join('\u0001')
          React.useEffect(() => {
            if (sessAnimRef.sig === sessSig) return
            sessAnimRef.sig = sessSig
            setSessRows((prev) => {
              const prevMap = new Map((prev || []).map((p) => [p.key, p]))
              const nextSet = new Set(shownSessions.map((s) => s.id))
              const merged = shownSessions.map((s) => {
                const old = prevMap.get(s.id)
                return { key: s.id, s: s, leaving: false, enter: !old }
              })
              const leaving = (prev || []).filter((p) => !nextSet.has(p.key)).map((p) => ({ key: p.key, s: p.s, leaving: true, enter: false }))
              return merged.concat(leaving)
            })
            if (sessAnimRef.t) { try { sessAnimRef.t() } catch (e) {} }
            sessAnimRef.t = null
            const reduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
            sessAnimRef.t = ctx.timeout(() => {
              sessAnimRef.t = null
              setSessRows((prev) => (prev || []).filter((p) => !p.leaving))
            }, reduced ? 0 : 320)
          }, [sessSig])
          const toggleFiles = () => {
            const next = !secFiles
            setSecFiles(next)
            // v1.15.1: expanding ALWAYS forces a fresh load (walk + git
            // status): "glancing at it means it is fresh" — external commits
            // or edits made while the section was closed show up immediately.
            if (next) void loadFiles(true)
          }
          // v1.15.1: periodic silent re-check while the files section is
          // open. The tool channel cannot see external git commits or
          // external-editor writes (they change .git or bypass every event),
          // so a low-frequency re-ask of git status is the only way the
          // badges stay eventually consistent — bounded to ≤20s. Gated on
          // the section being open AND the tab being visible: hidden tabs
          // pay nothing, opening the section re-checks anyway.
          const pollRef = React.useState({ cancel: null })[0]
          React.useEffect(() => {
            const stop = () => { if (pollRef.cancel) { try { pollRef.cancel() } catch (e) {} pollRef.cancel = null } }
            if (open && secFiles) {
              const loop = () => {
                pollRef.cancel = ctx.timeout(() => {
                  pollRef.cancel = null
                  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
                  if (!hidden) void loadFiles(true, true)
                  loop()
                }, 20000)
              }
              loop()
            } else stop()
            return stop
          }, [open, secFiles])
          // Auto-refresh: the host bumps a per-session treeStamp whenever the
          // file SET changes (create/delete — including agent tool calls and
          // reject-deletions). The ModifiedBar poll publishes it into the
          // store; each open workspace reloads its tree once per new stamp.
          useStore()
          const stampRef = React.useState({ seen: 0, open: false, filesOpen: false, loading: false })[0]
          stampRef.open = open
          stampRef.filesOpen = secFiles
          stampRef.loading = treeLoading
          React.useEffect(() => {
            const stamp = store.treeStamp
            if (stamp !== undefined && stamp !== null && stamp !== stampRef.seen) {
              stampRef.seen = stamp
              if (stampRef.open && stampRef.filesOpen && !stampRef.loading) {
                // v1.30: a new stamp means the file SET changed; the level
                // cache is dropped so every open directory re-asks on its next
                // render (its TreeNode effect refetches a missing entry). The
                // root reload below repopulates the top level immediately.
                if (dirRef.mode !== 'eager') { dirRef.cache.clear(); setDirTick((n) => n + 1) }
                void loadFiles(true)
              }
            }
          })
          const isCurrentWs = (ws.sessionIds || []).indexOf(currentId) >= 0
          return React.createElement('div', { className: 'dsh-fe-ws-item' },
            React.createElement('div', {
              className: 'dsh-fe-ws-row' + (open ? ' dsh-fe-ws-row-open dsh-fe-open' : '') + (isCurrentWs ? ' dsh-fe-ws-row-cur' : ''),
              onClick: () => setOpen(!open),
              title: ws.path,
            },
              React.createElement('span', { className: 'dsh-fe-chev' }, IconChevron()),
              React.createElement('span', { className: 'dsh-fe-ic' }, IconFolder()),
              React.createElement('span', { className: 'dsh-fe-ws-name' }, ws.title),
            ),
            open ? React.createElement('div', null,
              React.createElement('div', {
                className: 'dsh-fe-sec' + (secHistory ? ' dsh-fe-sec-open dsh-fe-open' : ''),
                onClick: () => setSecHistory(!secHistory),
              },
                React.createElement('span', { className: 'dsh-fe-chev' }, IconChevron()),
                React.createElement('span', { className: 'dsh-fe-ic' }, IconClock()),
                React.createElement('span', null, '会话历史'),
                React.createElement('span', { className: 'dsh-fe-stats' }, '(' + sessions.length + ')'),
                React.createElement('span', { className: 'dsh-fe-spacer' }, null),
                // v1.20: hover-revealed manage button; while managing the
                // header swaps it for the trash (batch delete) + cancel pair.
                managing
                  ? React.createElement('button', {
                      className: 'dsh-fe-iconbtn dsh-fe-mgbtn dsh-fe-mgbtn-on dsh-fe-mgbtn-no',
                      title: deleting ? '正在删除…' : '删除选中的会话' + (selectedCount > 0 ? '（' + selectedCount + ' 个）' : ''),
                      onClick: (ev) => { ev.stopPropagation(); if (deleting) return; if (selectedCount > 0) confirmAndDel(Array.from(sel)); else flashWarn() },
                    }, IconTrash())
                  : null,
                managing
                  ? React.createElement('button', {
                      className: 'dsh-fe-iconbtn dsh-fe-mgbtn dsh-fe-mgbtn-on',
                      title: '取消管理',
                      onClick: (ev) => { ev.stopPropagation(); closeMenu(); setManaging(false); setSel(null); setDelErr(null) },
                    }, IconClose())
                  : React.createElement('button', {
                      className: 'dsh-fe-mgbtn dsh-fe-mgbtn-txt',
                      title: '管理会话（勾选后批量删除）',
                      onClick: (ev) => { ev.stopPropagation(); closeMenu(); setManaging(true); setSel(null); setDelErr(null) },
                    }, '管理'),
              ),
              secHistory ? React.createElement('div', null,
                React.createElement('input', {
                  className: 'dsh-fe-search',
                  placeholder: '搜索会话…',
                  value: query,
                  onChange: (ev) => setQuery(ev.target.value),
                }),
                delErr ? React.createElement('div', { className: 'dsh-fe-err' }, String(delErr)) : null,
                (sessRows || []).map(r => {
                  // Live data for rows still present (fresh time/title
                  // labels); the snapshot keeps a leaving row alive while
                  // it animates out (byId no longer has it).
                  const s = byId[r.key] || r.s
                  const pinned = pinStore.has(s.id)
                  const isCur = s.id === currentId
                  const chkOn = managing && sel !== null && sel.has(s.id)
                  const chkDis = managing && isCur
                  return React.createElement('div', {
                    key: r.key,
                    className: 'dsh-fe-sess' + (isCur ? ' dsh-fe-sess-cur' : '') + (chkOn ? ' dsh-fe-sess-sel' : '') + (r.leaving ? ' dsh-fe-sess-out' : (r.enter ? ' dsh-fe-sess-in' : '')),
                    onClick: () => ctx.sessions.open(s.id),
                    title: s.id + (s.updatedAt ? '\n' + new Date(s.updatedAt).toLocaleString() : ''),
                  },
                    // v1.20: manage mode swaps the status glyph slot for the
                    // selection checkbox (current session's box is disabled —
                    // a live session cannot be deleted).
                    managing
                      ? React.createElement('span', {
                          key: s.id + ':' + warnTick,
                          className: 'dsh-fe-chk' + (chkOn ? ' dsh-fe-chk-on' : '') + (chkDis ? ' dsh-fe-chk-dis' : '') + (warnOn ? ' dsh-fe-chk-warn' : ''),
                          title: chkDis ? '当前会话，不能删除' : (chkOn ? '取消选择' : '选择此会话'),
                          onClick: (ev) => { ev.stopPropagation(); if (!chkDis) toggleSel(s.id) },
                        }, IconChk())
                      : (s.running
                          ? IconRunning()
                          : React.createElement('span', { className: 'dsh-fe-dot' + (s.completed ? ' dsh-fe-dot-done' : '') })),
                    React.createElement('span', { className: 'dsh-fe-sess-name' }, s.displayTitle),
                    // v1.20.2: the pin badge is itself the unpin control —
                    // clicking it unpins right away (the dot menu no longer
                    // carries a 取消 row once pinned).
                    pinned ? React.createElement('span', {
                      className: 'dsh-fe-sess-pin',
                      role: 'button',
                      tabIndex: 0,
                      title: '点击取消置顶',
                      onClick: (ev) => { ev.stopPropagation(); pinStore.toggle(s.id); closeMenu() },
                    }, IconPin()) : null,
                    React.createElement('span', { className: 'dsh-fe-sess-time' }, timeAgo(s.updatedAt, Date.now())),
                    React.createElement('button', {
                      className: 'dsh-fe-sess-dots',
                      title: '更多操作',
                      onClick: (ev) => {
                        ev.stopPropagation()
                        let rect = null
                        try { rect = ev.currentTarget.getBoundingClientRect() } catch (e) {}
                        openMenu(s.id, rect)
                      },
                    }, IconDots()),
                    // v1.20.1: floating mini dropdown (fixed-positioned so the
                    // sidebar's scroll container never clips it), anchored
                    // under the dots and right-aligned to them. Text-only
                    // items, each two Chinese characters wide. v1.20.2: once
                    // pinned the menu shows ONLY 删除 — unpinning happens by
                    // clicking the pin badge itself; expand/collapse animate.
                    menuFor === s.id
                      ? React.createElement('div', {
                          className: 'dsh-fe-sess-menu' + (menuClosing ? ' dsh-fe-sess-menu-close' : ''),
                          style: menuPos ? { top: menuPos.top, right: menuPos.right } : null,
                          onClick: (ev) => ev.stopPropagation(),
                        },
                          React.createElement('button', {
                            className: 'dsh-fe-sess-menu-item dsh-fe-sess-menu-item-no',
                            disabled: isCur,
                            title: isCur ? '当前会话，不能删除' : '删除此会话（不可恢复）',
                            onClick: (ev) => { ev.stopPropagation(); if (isCur) return; closeMenu(); confirmAndDel([s.id]) },
                          }, '删除'),
                          pinned ? null : React.createElement('button', {
                            className: 'dsh-fe-sess-menu-item',
                            title: '置顶到最上方',
                            onClick: (ev) => { ev.stopPropagation(); pinStore.toggle(s.id); closeMenu() },
                          }, '置顶'),
                        )
                      : null,
                  )
                }),
                // v1.20: click-away veil for the open dot menu (a plain React
                // overlay — no global listeners, which are unreliable in this
                // shell; the menu card itself sits a level above it). Both
                // directions animate through closeMenu().
                menuFor ? React.createElement('div', { className: 'dsh-fe-menu-veil', onClick: () => closeMenu() }) : null,
                // v1.19: overflow control — same semantics, texts and
                // visual language as the shell's sessionOverflowButton
                // (locales: sessions.expand = "展开其余 {n} 个会话" /
                // sessions.collapse = "收起"). Hidden while searching.
                !searching && sessions.length > SESSION_HISTORY_LIMIT
                  ? React.createElement('button', {
                      className: 'dsh-fe-sess-more',
                      'aria-expanded': histExpanded ? 'true' : 'false',
                      onClick: () => setHistExpanded(!histExpanded),
                    },
                    histExpanded
                      ? '收起'
                      : '展开其余 ' + (sessions.length - SESSION_HISTORY_LIMIT) + ' 个会话',
                  )
                  : null,
                React.createElement('button', { className: 'dsh-fe-newbtn', 'data-dsh-fe-guarded': '1', onClick: () => guardedStartSession(ws.workspaceId) }, IconPlus(), '新建会话'),
              ) : null,
              React.createElement('div', {
                className: 'dsh-fe-sec' + (secFiles ? ' dsh-fe-sec-open dsh-fe-open' : ''),
                onClick: () => toggleFiles(),
              },
                React.createElement('span', { className: 'dsh-fe-chev' }, IconChevron()),
                React.createElement('span', { className: 'dsh-fe-ic' }, IconFolder()),
                React.createElement('span', null, '项目文件'),
                React.createElement('span', { className: 'dsh-fe-spacer' }, null),
                React.createElement('button', {
                  className: 'dsh-fe-secbtn',
                  title: '刷新文件树',
                  onClick: (ev) => { ev.stopPropagation(); void loadFiles(true) },
                }, treeLoading ? '…' : IconRefresh()),
              ),
              secFiles ? React.createElement('div', null,
                treeError ? React.createElement('div', { className: 'dsh-fe-msg' }, String(treeError)) : null,
                tree ? React.createElement('div', { className: 'dsh-fe-children' },
                  React.createElement(TreeNode, {
                    node: tree,
                    depth: 0,
                    onOpen: (p) => store.openFile(p),
                    lazy: dirRef.mode !== 'eager',
                    cache: dirRef.cache,
                    onLoadDir: loadDir,
                    onCloseDir: evictDir,
                  })) : null,
              ) : null,
            ) : null,
            // v1.20: destructive-action confirm (single delete from the dot
            // menu or a manage-mode batch delete). Same overlay/card visual
            // language as the file-view save prompt (dsh-fe-ask-*).
            confirmDel ? React.createElement('div', {
              className: 'dsh-fe-ask-mask',
              onClick: () => setConfirmDel(null),
            },
              React.createElement('div', { className: 'dsh-fe-ask-card', onClick: (ev) => ev.stopPropagation() },
                React.createElement('div', { className: 'dsh-fe-ask-title' }, '确认删除会话'),
                React.createElement('div', { className: 'dsh-fe-ask-body' },
                  '会话删除后不可恢复，请确认。',
                  confirmDel.ids.length > 1 ? '（共 ' + confirmDel.ids.length + ' 个会话）' : null,
                ),
                React.createElement('div', { className: 'dsh-fe-ask-actions' },
                  React.createElement('button', { className: 'dsh-fe-btn', onClick: () => setConfirmDel(null) }, '取消'),
                  React.createElement('button', {
                    className: 'dsh-fe-btn dsh-fe-btn-no',
                    disabled: deleting,
                    onClick: () => { const ids = confirmDel.ids.slice(); setConfirmDel(null); void doDelete(ids) },
                  }, deleting ? '删除中…' : '确认删除'),
                ),
              ),
            ) : null,
          )
        }

        function WorkspaceSidebar(props) {
          const wide = !!(props && props.wide)
          const expandSidebar = props && props.expandSidebar
          const wsState = props.useWorkspaces ? props.useWorkspaces(s => s) : null
          const sesState = props.useSessions ? props.useSessions(s => s) : null
          const [error, setError] = React.useState(null)
          const items = wsState ? wsState.items : []
          const addWorkspace = async () => {
            try {
              // v1.23: pickDirectory moved to the uiWorkspace service
              // (DSH 0.1.5-alpha.1); fall back to ctx.workspaces.pickDirectory()
              // on the old 0.1.1-rc.2 layout where the service is absent.
              const uw = getUiWorkspace()
              const path = uw && typeof uw.pickDirectory === 'function'
                ? await uw.pickDirectory()
                : (ctx.workspaces && typeof ctx.workspaces.pickDirectory === 'function'
                  ? await ctx.workspaces.pickDirectory()
                  : null)
              if (path) await ctx.workspaces.create({ path: path })
              setError(null)
            } catch (e) {
              setError(e && e.message ? String(e.message) : String(e))
            }
          }
          if (!wide) {
            return React.createElement('div', { className: 'dsh-fe-rail' },
              React.createElement('button', { className: 'dsh-fe-railbtn', title: '添加工作区', onClick: () => addWorkspace() }, IconPlus()),
              items.map(ws => React.createElement('button', {
                key: ws.workspaceId,
                className: 'dsh-fe-railbtn',
                title: ws.title,
                onClick: () => { if (expandSidebar) expandSidebar() },
              }, IconFolder())),
            )
          }
          const byId = sesState ? sesState.byId : {}
          const currentId = sesState ? sesState.current : undefined
          return React.createElement('div', { className: 'dsh-fe-wsroot' },
            React.createElement('div', { className: 'dsh-fe-wshead' },
              React.createElement('span', null, '工作区'),
              React.createElement('span', { className: 'dsh-fe-spacer' }, null),
              React.createElement('button', { className: 'dsh-fe-btn', onClick: () => addWorkspace() }, IconPlus(), '添加'),
            ),
            error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
            React.createElement('div', { className: 'dsh-fe-wslist' },
              items.map(ws => React.createElement(WorkspaceNode, {
                key: ws.workspaceId,
                ws: ws,
                byId: byId,
                currentId: currentId,
              })),
              items.length === 0 ? React.createElement('div', { className: 'dsh-fe-msg' }, '暂无工作区，点击右上角 ＋ 添加') : null,
            ),
          )
        }

        // ---------- modified files bar ----------
        function FileRow(props) {
          const item = props.item
          const chip = item.status === 'added'
            ? React.createElement('span', { className: 'dsh-fe-chip dsh-fe-chip-add' }, '新增')
            : item.status === 'deleted'
              ? React.createElement('span', { className: 'dsh-fe-chip dsh-fe-chip-del' }, '删除')
              : React.createElement('span', { className: 'dsh-fe-chip' }, '修改')
          const stats = item.note
            ? React.createElement('span', { className: 'dsh-fe-stats' }, item.note === 'binary' ? '二进制' : (item.note === 'unreadable' ? '不可读' : '超出上限'))
            : React.createElement('span', { className: 'dsh-fe-stats' },
              React.createElement('span', { className: 'dsh-fe-stat-add' }, '+' + item.added),
              ' ',
              React.createElement('span', { className: 'dsh-fe-stat-del' }, '−' + item.removed),
              item.pending > 1 ? ' · ' + item.pending + ' 处' : '')
          const go = async (method) => {
            const r = await call(method, { sessionId: props.sid, path: item.path })
            if (!r.ok && props.onError) props.onError(r.error || r.message || '操作失败')
            props.onDone()
            store.requestRefresh()
          }
          return React.createElement('div', { className: 'dsh-fe-file-row' },
            React.createElement('span', { className: 'dsh-fe-ic' }, IconFile()),
            React.createElement('span', { className: 'dsh-fe-path', title: item.path, onClick: () => store.openFile(item.path) }, item.path),
            chip,
            stats,
            React.createElement(IconBtn, { tone: 'ok', title: '接受此文件的修改', onClick: () => go('acceptFile'), icon: IconCheck }),
            React.createElement(IconBtn, { tone: 'no', className: 'dsh-fe-pair', title: '拒绝此文件的修改', onClick: () => go('rejectFile'), icon: IconCross }),
          )
        }

        function ModifiedBar(props) {
          const sid = props && props.sessionId
          React.useEffect(() => { if (sid) store.setSessionId(sid) }, [sid])
          // v1.8.4: explicit initial load (first scan builds the baseline);
          // the poll no longer runs an immediate first tick.
          React.useEffect(() => { if (sid) void refresh() }, [sid])
          const [files, setFiles] = React.useState(null)
          const [error, setError] = React.useState(null)
          const [undo, setUndo] = React.useState(null)
          const [dismissed, setDismissed] = React.useState(null)
          // v1.7: the bar collapses to its one-line header; the chevron
          // handle sits centered above the bar and toggles it back.
          const [collapsed, setCollapsed] = React.useState(false)
          // v1.8.3: animation layer. `files` stays the logical list; `rowSet`
          // mirrors it with per-row flags so entering rows animate in and
          // removed rows animate out before unmounting.
          const [rowSet, setRowSet] = React.useState([])
          const animRef = React.useState({ t: null })[0]
          React.useEffect(() => () => { if (animRef.t) clearTimeout(animRef.t); if (scrollTimer.t) clearTimeout(scrollTimer.t) }, [])
          // v1.16.0: the 5-row scroll mode must not fight the grid-rows
          // expand/collapse transition. While the body animates, the inner
          // keeps plain overflow:hidden (clipped, no scrollbar relayout per
          // frame — the v1.15.3 jank on every toggle); the scroll class is
          // applied only once the expansion has settled (300ms > the 260ms
          // transition), removed synchronously on collapse, and applied
          // immediately when no animation is running (mount / threshold
          // crossings).
          const [scrollClass, setScrollClass] = React.useState(false)
          const scrollTimer = React.useState({ t: null })[0]
          React.useEffect(() => {
            const need = !collapsed && rowSet.length > 5
            if (!need) {
              if (scrollTimer.t) clearTimeout(scrollTimer.t)
              scrollTimer.t = null
              if (scrollClass) setScrollClass(false)
              return
            }
            if (scrollClass) return
            // An expand animation is in flight (the toggle armed the settle
            // timer): let the timer apply the scroller once the grid-rows
            // transition has finished. Otherwise (mount / threshold crossed
            // with no animation running) apply immediately — no 6-row-then-
            // 5-row jump.
            if (scrollTimer.t) return
            setScrollClass(true)
          }, [collapsed, rowSet.length])
          const onToggle = () => {
            const next = !collapsed
            setCollapsed(next)
            if (next) {
              // collapsing: drop the scroller up front so the shrink animates
              // with a clipped overflow (no scrollbar mid-animation).
              if (scrollTimer.t) clearTimeout(scrollTimer.t)
              scrollTimer.t = null
              setScrollClass(false)
            } else if (rowSet.length > 5) {
              // expanding: arm the settle timer (300ms > the 260ms
              // transition); the effect above skips while it is pending.
              if (scrollTimer.t) clearTimeout(scrollTimer.t)
              scrollTimer.t = setTimeout(() => { scrollTimer.t = null; setScrollClass(true) }, 300)
            }
          }
          // v1.12: overlay posture plumbing. The anchor is a zero-height
          // in-flow span that keeps the dock row measurable; the bar root
          // gets position:absolute (class) + a measured `bottom` offset so it
          // floats above the InputBar without occupying seat flow space.
          const barRef = React.useState({ node: null })[0]
          const anchorRef = React.useState({ node: null })[0]
          const [overlayBottom, setOverlayBottom] = React.useState(null)
          // v1.15.3: the modified-file list is capped at 5 visible rows;
          // more files scroll inside the bar body (.dsh-fe-bar-scroll). The
          // cap is computed from a REAL row's height (fonts differ across
          // platforms) and stored as a CSS var on the bar root.
          React.useLayoutEffect(() => {
            const bar = barRef.node
            if (!bar) return
            const row = bar.querySelector('.dsh-fe-file-row')
            if (row && row.offsetHeight > 0) bar.style.setProperty('--dsh-fe-row-h', row.offsetHeight + 'px')
          }, [rowSet])
          // v1.11.2: background refreshes are SILENT — no busy state, no
          // flickering "…" next to the file count. The old busy span toggled
          // on every poll tick (every 1.5s while the agent runs), and its
          // insert/remove shifted the flex layout so the centered collapse
          // button visibly jumped in sync.
          const refresh = async () => {
            if (!sid) return
            const r = await call('getModified', { sessionId: sid })
            if (r.ok) {
              const next = r.files || []
              setFiles(next)
              setError(null)
              store.setRoot(r.root ?? null)
              store.setTreeStamp(r.treeStamp ?? 0)
              setUndo(r.undo ?? null)
              setRowSet((prev) => {
                const prevMap = new Map((prev || []).map((p) => [p.path, p]))
                const merged = next.map((item) => ({ path: item.path, item: item, leaving: false, enter: !prevMap.has(item.path) }))
                const nextSet = new Set(next.map((f) => f.path))
                const leaving = (prev || []).filter((p) => !nextSet.has(p.path)).map((p) => ({ path: p.path, item: p.item, leaving: true, enter: false }))
                return merged.concat(leaving)
              })
              if (animRef.t) clearTimeout(animRef.t)
              animRef.t = setTimeout(() => {
                animRef.t = null
                setRowSet((prev) => (prev || []).filter((p) => !p.leaving))
              }, 260)
            } else {
              setError(r.error || '加载失败')
              setUndo(null)
            }
          }
          usePoll(refresh, () => pollDelayFor(sid))
          // Immediate refresh when the file view changes review state (hunk
          // or file accept/reject, inline edits): refetch now instead of
          // waiting for the next poll.
          useStore()
          const refreshTick = store.refreshTick
          React.useEffect(() => { if (refreshTick) void refresh() }, [refreshTick])
          const doUndo = async () => {
            if (!sid) return
            setError(null)
            const r = await call('undoReject', { sessionId: sid })
            if (!r.ok) setError(r.error || r.message || '撤销失败')
            else if (r.skipped && r.skipped.length > 0) setError(r.kept ? '撤销被文件策略拒绝（' + r.skipped.length + ' 个），撤销记录已保留：切换文件策略后可直接重试' : '部分文件未撤销：已被再次修改（' + r.skipped.length + ' 个）')
            await refresh()
          }
          const actAll = async (method) => {
            if (!sid) return
            const r = await call(method, { sessionId: sid })
            if (!r.ok) setError(r.error || r.message || '操作失败')
            // v1.33 (F1): a batch reject reports the files it REFUSED to touch
            // (no proof the agent created them, or they changed on disk since
            // the review last saw them) — the row list keeps them, so say so
            // instead of skipping them silently. Same pattern as the
            // undoReject skipped list above.
            // v1.32.8: this MUST NOT go through setError. The refresh() two
            // lines below (and every 6s poll after it) re-renders this panel
            // with error=-null, so the message survived exactly one frame —
            // the "闪一下就没" report. `r.failed` carries the FULL message per
            // file (host rejectAll pushes {path, error}), so the dialog can
            // show the real reason instead of the summary line it used to.
            else if (r.failed && r.failed.length > 0) store.setRejectNotice({ count: r.failed.length, items: r.failed })
            await refresh()
            store.requestRefresh()
          }
          const list = files || []
          const undoFresh = undo && (undo.kept === true || (undo.opId !== dismissed && Date.now() - undo.ts < 30000))
          // The bar stays mounted while leaving rows animate out (rowSet may
          // still hold them when the logical list is already empty).
          const visible = !!(sid && (rowSet.length > 0 || undoFresh))
          const overlay = store.fileViewActive
          // v1.12: overlay measurement. The bar's bottom offset = seat bottom
          // − anchor bottom (the anchor rides the zero-height dock row right
          // above the InputBar). The dock height publication is DEBOUNCED:
          // the collapse animation resizes the bar every frame; publishing
          // per frame would animate the editor's bottom padding (a layout
          // pass) in lockstep — the exact jank this design removes. Publish
          // once after the size settles. useLayoutEffect so the offset lands
          // before paint (no in-flow flash on the first overlay frame).
          React.useLayoutEffect(() => {
            if (!overlay || !visible) { setOverlayBottom(null); store.setDockH(0); return }
            const bar = barRef.node
            const anchor = anchorRef.node
            const seat = bar ? bar.offsetParent : null
            if (!bar || !anchor || !seat) return
            const measure = () => {
              const seatRect = seat.getBoundingClientRect()
              const anchorRect = anchor.getBoundingClientRect()
              setOverlayBottom(Math.max(0, Math.round(seatRect.bottom - anchorRect.bottom)))
            }
            let dockTimer = null
            let ro = null
            if (typeof ResizeObserver === 'function') {
              ro = new ResizeObserver((entries) => {
                // The bottom offset depends only on the SEAT (input card)
                // height; bar resizes (the collapse animation) only refresh
                // the dock clearance after the size settles. Filtering skips
                // per-frame measuring during the animation entirely.
                for (let k = 0; k < entries.length; k++) {
                  if (entries[k].target === seat) { measure(); break }
                }
                if (dockTimer) clearTimeout(dockTimer)
                dockTimer = setTimeout(() => {
                  dockTimer = null
                  store.setDockH(Math.round(bar.getBoundingClientRect().height))
                }, 150)
              })
              ro.observe(seat)
              ro.observe(bar)
            }
            measure()
            store.setDockH(Math.round(bar.getBoundingClientRect().height))
            window.addEventListener('resize', measure)
            return () => {
              if (dockTimer) clearTimeout(dockTimer)
              if (ro) ro.disconnect()
              window.removeEventListener('resize', measure)
              store.setDockH(0)
            }
          }, [overlay, visible])
          if (!visible) return null
          const head = React.createElement('div', { className: 'dsh-fe-bar-head' },
            React.createElement('span', { className: 'dsh-fe-bar-title' }, IconPencil(), '修改的文件'),
            React.createElement('span', { className: 'dsh-fe-bar-count' }, String(list.length)),
            React.createElement('span', { className: 'dsh-fe-spacer' }, null),
            // v1.8.1: centered between the left group and the action buttons;
            // the glyph shows what CLICKING will do (expanded → collapse down,
            // collapsed → expand up), not the current state.
            React.createElement(IconBtn, { title: collapsed ? '展开修改文件列表' : '收起修改文件列表（折叠为一行）', onClick: onToggle, icon: collapsed ? IconChevUp : IconChevDown }),
            React.createElement('span', { className: 'dsh-fe-spacer' }, null),
            React.createElement(IconBtn, { tone: 'ok', title: '全部接受', onClick: () => actAll('acceptAll'), icon: IconDoubleCheck }),
            React.createElement(IconBtn, { tone: 'no', className: 'dsh-fe-pair', title: '全部拒绝', onClick: () => actAll('rejectAll'), icon: IconRejectAll }),
            React.createElement(IconBtn, { title: '刷新', onClick: () => refresh(), icon: IconRefresh }),
          )
          // v1.8.3: the body stays mounted; collapse/expand animates via the
          // grid-rows transition (.dsh-fe-body / .dsh-fe-bar-collapsed).
          const bodyInner = [
            undoFresh ? React.createElement('div', { key: 'undo', className: 'dsh-fe-undo' },
              React.createElement('span', null, '已拒绝 ' + undo.count + ' 个文件'),
              React.createElement('button', { className: 'dsh-fe-btn', title: '撤销上次拒绝（恢复拒绝前的内容）', onClick: () => doUndo() }, '撤销'),
              React.createElement('span', { className: 'dsh-fe-spacer' }, null),
              React.createElement(IconBtn, { small: true, title: '关闭提示', onClick: () => setDismissed(undo.opId), icon: IconClose }),
            ) : null,
            error ? React.createElement('div', { key: 'err', className: 'dsh-fe-err' }, String(error)) : null,
            React.createElement('div', { key: 'rows' },
              rowSet.map((r) => React.createElement('div', {
                key: r.path,
                className: 'dsh-fe-anim' + (r.leaving ? ' dsh-fe-row-leave' : (r.enter ? ' dsh-fe-row-enter' : '')),
              }, React.createElement(FileRow, {
                item: r.item,
                sid: sid,
                onDone: refresh,
                // v1.32.8: a refused reject carries the per-file reason in
                // `r.error`; a batch/other failure still uses the inline row.
                onError: (msg) => store.setRejectNotice({ count: 1, items: [{ path: r.item.path, error: msg }] }),
              })))),
          ]
          const barStyle = overlay && overlayBottom !== null ? { bottom: overlayBottom + 'px' } : null
          // v1.32.8: the per-file ✗ (FileRow `onError`) used to land in the
          // transient `setError` row and was wiped by the `onDone()` refetch
          // that FileRow runs immediately after — the same flash-then-vanish as
          // the batch path. Route rejects through the store notice instead, and
          // render the dialog HERE so it works even when 文件 view was never
          // opened (the dialog must not depend on FileView being mounted).
          const rejectDialog = store.rejectNotice ? React.createElement('div', { className: 'dsh-fe-ask-mask' },
            React.createElement('div', { className: 'dsh-fe-ask-card' },
              React.createElement('div', { className: 'dsh-fe-ask-title' }, '拒绝未完全生效'),
              React.createElement('div', { className: 'dsh-fe-ask-body' },
                '有 ' + store.rejectNotice.count + ' 个文件未被拒绝，原文件已保留：',
                store.rejectNotice.items.map((it) => React.createElement('div', {
                  key: it.path,
                  className: 'dsh-fe-reject-item',
                },
                  React.createElement('div', { className: 'dsh-fe-ask-path' }, it.path),
                  it.error ? React.createElement('div', { className: 'dsh-fe-err' }, String(it.error)) : null,
                )),
              ),
              React.createElement('div', { className: 'dsh-fe-ask-actions' },
                React.createElement('button', {
                  className: 'dsh-fe-btn dsh-fe-btn-ok',
                  onClick: () => store.setRejectNotice(null),
                }, '知道了'),
              ),
            ),
          ) : null
          return React.createElement(React.Fragment, null,
            React.createElement('span', { ref: (node) => { anchorRef.node = node }, className: 'dsh-fe-dock-anchor' }),
            React.createElement('div', {
              ref: (node) => { barRef.node = node },
              className: 'dsh-fe-bar' + (collapsed ? ' dsh-fe-bar-collapsed' : '') + (overlay ? ' dsh-fe-bar-overlay' : '') + (rowSet.length > 5 && scrollClass ? ' dsh-fe-bar-scroll' : ''),
              style: barStyle,
            },
              head,
              React.createElement('div', { className: 'dsh-fe-body' },
                React.createElement('div', { className: 'dsh-fe-body-inner' }, bodyInner)),
            ),
            rejectDialog,
          )
        }

        // ---------- syntax highlighting (v1.7) ----------
        // A lightweight per-line tokenizer for 24 languages. It is a
        // highlighter, not a compiler: strings, comments, numbers, operators,
        // keywords, built-ins, constants and declaration-driven function/
        // class names are colored; genuinely ambiguous corners (regex
        // literals, nested interpolations) degrade to plain text instead of
        // mis-coloring. Keyword sets follow the official references
        // (cpython, ECMA-262, JLS, C11, C++23, C# spec, Go spec, Rust
        // reference, PHP, Ruby, Swift, Kotlin, R, Bash, PowerShell, SQL,
        // WHATWG HTML, CSS Syntax, JSON, YAML 1.2, TOML 1.0, XML,
        // CommonMark).
        const S = (words) => {
          const o = Object.create(null)
          const parts = words.split(' ')
          for (let i = 0; i < parts.length; i++) if (parts[i]) o[parts[i]] = 1
          return o
        }
        const Q = (pairs) => pairs
        const OP_DEFAULT = ['>>>=', '===', '!==', '**=', '<<=', '>>=', '>>>', '**', '...', '<=>', '->', '=>', '::', '++', '--', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '~=', '?.']
        const DEF_BLOCK = ['/*', '*/']
        const DEF_LINE = ['//']
        const CC_QUOTES = [['"', '"'], ["'", "'"]]

        const tokenize = (text, cfg, state) => {
          const out = []
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          const push = (t, c) => out.push({ t: t, c: c })
          state.mode = state.mode || null
          let prevSig = state.prevSig || ''
          let i = 0
          if (state.mode === 'block') {
            const end = text.indexOf(cfg.block[1])
            if (end < 0) { push(text, 'com'); return out }
            push(text.slice(0, end + cfg.block[1].length), 'com')
            i = end + cfg.block[1].length
            state.mode = null
            prevSig = ''
          } else if (state.mode === 'mlstr') {
            const q = state.mlq
            const end = text.indexOf(q)
            if (end < 0) { push(text, 'str'); return out }
            push(text.slice(0, end + q.length), 'str')
            i = end + q.length
            state.mode = null
            state.mlq = null
          }
          // Preprocessor line (C/C++): #include/#define/... — the directive
          // head gets its own color, the rest of the line tokenizes normally.
          // (Runs once per line: tokenize is called once per rendered line.)
          if (cfg.pre) {
            const lead = text.match(/^\s*/)[0]
            if (text[lead.length] === '#') {
              const dm = /^#\s*([A-Za-z_]\w*)/.exec(text.slice(lead.length))
              if (dm) {
                plain(lead)
                push(text.slice(lead.length, lead.length + dm[0].length), 'pp')
                i = lead.length + dm[0].length
                prevSig = 'pp'
              }
            }
          }
          while (i < n) {
            const ch = text[i]
            // Block comment.
            if (cfg.block && text.startsWith(cfg.block[0], i)) {
              const end = text.indexOf(cfg.block[1], i + cfg.block[0].length)
              if (end < 0) { push(text.slice(i), 'com'); state.mode = 'block'; return out }
              push(text.slice(i, end + cfg.block[1].length), 'com')
              i = end + cfg.block[1].length
              prevSig = 'com'
              continue
            }
            // Line comments. A '#'-style comment optionally only counts when
            // it starts a word (bash / PowerShell): foo#bar is not a comment.
            let hitLine = false
            const lc = cfg.line || []
            for (let li = 0; li < lc.length; li++) {
              const c = lc[li]
              if (!text.startsWith(c, i)) continue
              if (c === '#' && cfg.hashWord && i > 0 && !/\s/.test(text[i - 1])) continue
              push(text.slice(i), 'com')
              i = n
              hitLine = true
              break
            }
            if (hitLine) break
            // Strings (longest delimiters first).
            let hitStr = false
            const quotes = cfg.quotes || []
            for (let qi = 0; qi < quotes.length; qi++) {
              const q = quotes[qi]
              const o = q[0]
              if (!text.startsWith(o, i)) continue
              // Rust lifetime: 'ident with no closing quote on the line.
              if (cfg.lifetimes && o === "'" && /^'[A-Za-z_]\w*/.test(text.slice(i)) && text.indexOf("'", i + 1) < 0) break
              const multiline = o.length >= 3 || cfg.ml === true
              let end = -1
              if (o.length === 1) {
                let k = i + 1
                while (k < n) {
                  if (cfg.quoteDoubleEscape && text[k] === q[1] && text[k + 1] === q[1]) { k += 2; continue }
                  if (cfg.esc && text[k] === cfg.esc) { k += 2; continue }
                  if (text[k] === q[1]) { end = k; break }
                  k++
                }
              } else {
                end = text.indexOf(q[1], i + o.length)
              }
              if (end < 0) {
                push(text.slice(i), 'str')
                if (multiline) { state.mode = 'mlstr'; state.mlq = q[1] }
                i = n
                hitStr = true
                break
              }
              let cls = 'str'
              if (cfg.keyStrings) {
                let k = end + q[1].length
                while (k < n && /\s/.test(text[k])) k++
                if (text[k] === ':') cls = 'key'
              }
              push(text.slice(i, end + q[1].length), cls)
              i = end + q[1].length
              hitStr = true
              break
            }
            if (hitStr) { prevSig = 'str'; continue }
            // Numbers.
            const nm = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
            if (nm) {
              let end = i + nm[0].length
              if (cfg.numSuffix) {
                const sm = cfg.numSuffix.exec(text.slice(end))
                if (sm && (end + sm[0].length >= n || !/[\w]/.test(text[end + sm[0].length]))) end += sm[0].length
              }
              push(text.slice(i, end), 'num')
              i = end
              prevSig = 'num'
              continue
            }
            // Identifiers (with optional prefix chars such as $ or @).
            if (/[A-Za-z_]/.test(ch) || (cfg.idPrefix && cfg.idPrefix.indexOf(ch) >= 0)) {
              let j = i
              if (cfg.idPrefix && cfg.idPrefix.indexOf(ch) >= 0) {
                j++
                while (j < n && /[\w]/.test(text[j])) j++
              } else if (cfg.cmdlet) {
                // PowerShell cmdlets contain hyphens (Verb-Noun).
                while (j < n && /[\w-]/.test(text[j])) j++
              } else {
                while (j < n && /[\w]/.test(text[j])) j++
              }
              const word = text.slice(i, j)
              const lower = word.toLowerCase()
              // Strip the leading id-prefix ($ / @) for dictionary lookups so
              // PHP's $_SERVER matches the 'builtin' list entry _SERVER.
              const baseWord = (cfg.idPrefix && cfg.idPrefix.indexOf(word[0]) >= 0) ? word.slice(1) : word
              // PowerShell cmdlet heuristic: Verb-Noun casing (word boundary,
              // not line-end — the identifier was already isolated above).
              if (cfg.cmdlet && /^[A-Z][a-z]+(-[A-Za-z][\w-]*)+(?![A-Za-z0-9_-])/.test(word)) {
                push(word, 'fn')
                i = j
                prevSig = 'fn'
                continue
              }
              const kwCls = cfg.kwExact ? cfg.kw[word] : (cfg.kw[lower] || cfg.kw[baseWord.toLowerCase()])
              if (kwCls) {
                push(word, 'kw')
                prevSig = cfg.decl[lower] ? 'decl' : 'kw'
                i = j
                continue
              }
              // Case-insensitive languages get pre-computed lowercase
              // dictionaries once per config (their keys may be mixed case).
              if (cfg.caseInsensitive && !cfg._lc) {
                const c = Object.create(null)
                const bl = Object.create(null)
                for (const k of Object.keys(cfg.const)) c[k.toLowerCase()] = 1
                for (const k of Object.keys(cfg.builtin)) bl[k.toLowerCase()] = 1
                cfg._lc = { c: c, b: bl }
              }
              const lookLower = cfg.caseInsensitive ? baseWord.toLowerCase() : null
              const cnCls = cfg.caseInsensitive ? cfg._lc.c[lookLower] : (cfg.const[word] || cfg.const[baseWord])
              if (cnCls) { push(word, 'const'); prevSig = 'const'; i = j; continue }
              const bnCls = cfg.caseInsensitive ? cfg._lc.b[lookLower] : (cfg.builtin[word] || cfg.builtin[baseWord])
              if (bnCls) { push(word, 'builtin'); prevSig = 'builtin'; i = j; continue }
              // A prefixed identifier that matched nothing (Ruby @ivar,
              // PHP $local) reads as a variable.
              if (baseWord !== word) { push(word, 'var'); prevSig = 'var'; i = j; continue }
              if (prevSig === 'decl') {
                push(word, /^[A-Z]/.test(word) ? 'cls' : 'fn')
                prevSig = 'fn'
                i = j
                continue
              }
              // Call position (ident + '(') beats the capitalized-type rule:
              // PascalCase method calls read as functions, while type
              // references (Foo<T>, Foo.Bar, `Foo x`) stay class names.
              let k = j
              while (k < n && /\s/.test(text[k])) k++
              if (text[k] === '(') { push(word, 'fn'); prevSig = 'fn'; i = j; continue }
              if (cfg.capitalClass && /^[A-Z]/.test(word)) { push(word, 'cls'); prevSig = 'cls'; i = j; continue }
              push(word, null)
              prevSig = 'plain'
              i = j
              continue
            }
            // Variables: $x, ${x}, $1, $?, $# ... (bash / PowerShell / PHP).
            if (ch === '$') {
              let j = i + 1
              if (text[j] === '{') {
                const end = text.indexOf('}', j)
                j = end < 0 ? n : end + 1
              } else if (/[A-Za-z_]/.test(text[j] || '')) {
                while (j < n && /[\w]/.test(text[j])) j++
              } else if (text[j] !== undefined && !/\s/.test(text[j])) {
                j++
              }
              const word = text.slice(i, j)
              const base = word.slice(1)
              push(word, (cfg.const[word] || cfg.const[base]) ? 'const' : 'var')
              i = j
              prevSig = 'var'
              continue
            }
            // Ruby symbol: :sym
            if (cfg.symbol && ch === ':' && /[A-Za-z_]/.test(text[i + 1] || '')) {
              let j = i + 1
              while (j < n && /[\w!?=]/.test(text[j])) j++
              push(text.slice(i, j), 'const')
              i = j
              prevSig = 'const'
              continue
            }
            // Operators (longest first).
            let hitOp = false
            const opl = cfg.opList || OP_DEFAULT
            for (let oi = 0; oi < opl.length; oi++) {
              const op = opl[oi]
              if (text.startsWith(op, i)) { push(op, 'op'); i += op.length; hitOp = true; break }
            }
            if (hitOp) { prevSig = 'op'; continue }
            if ('+-*/%=<>!&|^~?.,;'.indexOf(ch) >= 0) { push(ch, 'op'); i++; prevSig = 'op'; continue }
            if (/\s/.test(ch)) {
              let j = i
              while (j < n && /\s/.test(text[j])) j++
              plain(text.slice(i, j))
              i = j
              continue
            }
            plain(ch)
            i++
            prevSig = 'other'
          }
          state.prevSig = prevSig
          return out
        }

        // ---------- per-language configs ----------
        const HL_LANGS = {}

        HL_LANGS.python = {
          line: ['#'], block: null,
          quotes: [['"""', '"""'], ["'''", "'''"], ['"', '"'], ["'", "'"]],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false,
          kw: S('and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield'),
          const: S('True False None NotImplemented Ellipsis'),
          builtin: S('abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__'),
          decl: S('def class'),
        }
        HL_LANGS.java = {
          line: DEF_LINE, block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false,
          numSuffix: /^[lLfFdD]/,
          kw: S('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield'),
          const: S('true false null'),
          builtin: S('System out err println print printf String StringBuilder Math Integer Long Double Float Boolean Character Arrays List Map Set HashMap ArrayList Collections Optional Stream Thread Runnable Exception RuntimeException'),
          decl: S('class interface enum record'),
        }
        HL_LANGS.javascript = {
          line: DEF_LINE, block: DEF_BLOCK,
          quotes: [['"', '"'], ["'", "'"], ['`', '`']],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, ml: true,
          numSuffix: /^n/,
          kw: S('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await'),
          const: S('true false null undefined NaN Infinity'),
          builtin: S('console document window globalThis Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp Map Set WeakMap WeakSet Promise Proxy Reflect Error TypeError RangeError parseInt parseFloat isNaN isFinite decodeURIComponent encodeURIComponent decodeURI encodeURI structuredClone fetch setTimeout setInterval clearTimeout clearInterval queueMicrotask ArrayBuffer DataView Uint8Array Int32Array Float64Array require module exports process Buffer'),
          decl: S('function class'),
        }
        HL_LANGS.typescript = {
          line: DEF_LINE, block: DEF_BLOCK,
          quotes: [['"', '"'], ["'", "'"], ['`', '`']],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, ml: true,
          numSuffix: /^n/,
          kw: S('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await type interface namespace module declare abstract implements private protected public readonly enum keyof infer is as satisfies unknown never any string number boolean symbol object bigint void override unique assert asserts using accessor'),
          const: S('true false null undefined NaN Infinity'),
          builtin: S('console log warn error info debug dir table document window globalThis Object Array String Number Boolean Symbol BigInt Math JSON Date RegExp Map Set WeakMap WeakSet Promise Proxy Reflect Error TypeError RangeError parseInt parseFloat isNaN isFinite structuredClone fetch setTimeout setInterval clearTimeout clearInterval Record Partial Required Readonly Pick Omit Exclude Extract NonNullable ReturnType Parameters InstanceType Awaited PromiseLike'),
          decl: S('function class interface type enum namespace'),
        }
        HL_LANGS.c = {
          line: DEF_LINE, block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: true,
          numSuffix: /^[uUlL]{1,3}/,
          kw: S('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local'),
          const: S('NULL true false'),
          builtin: S('printf scanf fprintf sprintf snprintf malloc calloc realloc free memcpy memset memcmp strcmp strlen strcpy strcat fopen fclose fread fwrite getchar putchar puts exit atoi atof abs labs qsort bsearch assert errno stdin stdout stderr FILE size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t'),
          decl: S('struct union enum typedef'),
        }
        HL_LANGS.cpp = {
          line: DEF_LINE, block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: true,
          numSuffix: /^[uUlLfF]{1,3}/,
          kw: S('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local alignas alignof and and_eq asm bitand bitor bool catch char8_t char16_t char32_t class compl concept consteval constexpr constinit const_cast co_await co_return co_yield decltype delete dynamic_cast explicit export false friend mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public reinterpret_cast requires static_assert static_cast template this thread_local throw true try typeid typename using virtual wchar_t xor xor_eq'),
          const: S('nullptr NULL true false'),
          builtin: S('printf scanf fprintf sprintf snprintf malloc calloc realloc free memcpy memset memcmp strcmp strlen strcpy strcat fopen fclose fread fwrite getchar putchar puts exit atoi atof abs labs qsort bsearch assert errno stdin stdout stderr FILE size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t cout cin cerr endl string vector map set unordered_map unordered_set pair tuple unique_ptr shared_ptr weak_ptr make_unique make_shared move forward optional variant std begin end size push_back emplace_back find sort'),
          decl: S('class struct enum union template typename using'),
        }
        HL_LANGS.csharp = {
          line: DEF_LINE, block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, kwExact: true,
          numSuffix: /^[uUlLfFdDmM]/,
          kw: S('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while add alias and ascending async await by descending dynamic equals file from get global group init into join let managed nameof nint not notnull nuint on or orderby partial record remove required scoped select set unmanaged value var when where with yield'),
          const: S('true false null'),
          // No builtin list: C# types and members are both PascalCase, so the
          // capitalized-type rule colors type references and the call rule
          // colors method invocations (Console.WriteLine → cls + fn).
          builtin: S(''),
          decl: S('class struct interface enum record delegate'),
        }
        HL_LANGS.go = {
          line: DEF_LINE, block: DEF_BLOCK,
          quotes: [['"', '"'], ['`', '`'], ["'", "'"]],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, ml: true,
          kw: S('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
          const: S('true false nil iota'),
          builtin: S('append cap clear close complex copy delete imag len make max min new panic print println real recover bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable fmt os io strings strconv errors time context sync math sort bytes bufio net http json log regexp path filepath runtime reflect'),
          decl: S('func type var const struct interface'),
        }
        HL_LANGS.rust = {
          line: DEF_LINE, block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, lifetimes: true,
          numSuffix: /^(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64)/,
          kw: S('as break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await macro'),
          const: S('true false'),
          builtin: S('Some None Ok Err println print format panic assert assert_eq assert_ne vec env args i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str'),
          decl: S('fn struct enum trait impl mod type const static use'),
        }
        HL_LANGS.php = {
          line: ['//', '#'], block: DEF_BLOCK, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: true, capitalClass: true, pre: false, idPrefix: '$',
          kw: S('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'),
          const: S('true false null'),
          builtin: S('echo print printf sprintf strlen str_replace substr explode implode count array_push array_pop in_array isset empty die exit header json_encode json_decode array_map array_filter array_reduce intval floatval strval boolval is_array is_string is_int is_float is_null is_numeric is_bool define defined class_exists function_exists method_exists property_exists get_class gettype settype var_dump print_r _GET _POST _REQUEST _SERVER _SESSION _COOKIE _FILES _ENV GLOBALS this self parent static __construct __destruct __call __get __set __isset __unset __toString __invoke __clone __CLASS__ __METHOD__ __FUNCTION__ __NAMESPACE__ __DIR__ __FILE__ __LINE__ __TRAIT__'),
          decl: S('function class interface trait enum'),
        }
        HL_LANGS.ruby = {
          line: ['#'], block: null, quotes: [['"', '"'], ["'", "'"], ['`', '`']],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false, symbol: true, idPrefix: '@',
          kw: S('BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'),
          const: S('true false nil'),
          builtin: S('puts print p pp gets require require_relative raise fail loop attr_accessor attr_reader attr_writer include extend prepend private protected public module_function lambda proc map each select reject reduce inject collect find filter flatten uniq sort join split gsub sub match scan length size empty nil hash keys values fetch merge to_s to_i to_f to_a to_h is_a kind_of respond_to class superclass ancestors freeze dup clone instance_variable_get instance_variable_set'),
          decl: S('def class module'),
        }
        HL_LANGS.swift = {
          line: DEF_LINE, block: DEF_BLOCK,
          quotes: [['"""', '"""'], ['"', '"'], ["'", "'"]],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false,
          kw: S('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as Any await false is nil self Self super throws true try actor async borrowing consuming distributed macro nonisolated package isolated some any'),
          const: S('true false nil'),
          builtin: S('print dump fatalError assert precondition String Int Double Float Bool Array Dictionary Set Optional Result Range ClosedRange stride map filter reduce compactMap flatMap first last count isEmpty append insert remove contains sorted joined split enumerated zip forEach AnyObject Never Void Character Substring'),
          decl: S('class struct enum protocol extension func var let typealias actor'),
        }
        HL_LANGS.kotlin = {
          line: DEF_LINE, block: DEF_BLOCK,
          quotes: [['"""', '"""'], ['"', '"'], ["'", "'"]],
          esc: '\\', caseInsensitive: false, capitalClass: true, pre: false,
          numSuffix: /^[uUlLfF]/,
          kw: S('as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg value'),
          const: S('true false null'),
          builtin: S('println print readLine listOf mutableListOf setOf mutableSetOf mapOf mutableMapOf arrayOf intArrayOf arrayListOf sequenceOf emptyList emptySet emptyMap require check error TODO run let apply also with use lazy repeat rangeTo until downTo step first last filter map flatMap forEach groupBy associateBy any all none count sum sortedBy distinct joinToString split toInt toDouble toString'),
          decl: S('class interface object enum fun val var typealias'),
        }
        HL_LANGS.r = {
          line: ['#'], block: null, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: false, pre: false,
          opList: ['%>%', '<-', '->', '<<-', ':::', '::', '==', '!=', '<=', '>=', '&&', '||', '&', '|', '!', '~', '+', '-', '*', '/', '^', '%%', '%/%', '**', '$', '@'],
          kw: S('if else repeat while function for in next break'),
          const: S('TRUE FALSE NULL Inf NaN NA NA_integer_ NA_real_ NA_complex_ NA_character_'),
          builtin: S('c list matrix array data.frame factor as.numeric as.character as.integer as.logical as.factor as.data.frame length names nrow ncol dim sum mean median sd var min max range seq rep paste paste0 print cat library require install.packages setwd getwd read.csv read.table write.csv write.table str summary head tail table sort order unique duplicated which match grep sub gsub substr nchar toupper tolower lapply sapply apply tapply mapply do.call source assign get exists rm ls class typeof attributes attr'),
          decl: S('function'),
        }
        HL_LANGS.bash = {
          line: ['#'], block: null, quotes: CC_QUOTES,
          esc: '\\', caseInsensitive: false, capitalClass: false, pre: false, hashWord: true,
          opList: ['&&', '||', ';;', ';&', ';;&', '<<<', '<<', '>>', '==', '!=', '<=', '>=', '+=', '-=', '2>', '2>&1', '|&', '|', '&', '>', '<', ';', '!'],
          kw: S('if then else elif fi case esac for while until do done in function select time coproc'),
          const: S(''),
          builtin: S('echo printf cd pwd export readonly unset shift getopts source alias unalias hash type ulimit umask return break continue eval exec exit trap wait kill jobs bg fg disown test let declare typeset local read readarray mapfile set shopt help pushd popd dirs builtin command enable true false'),
          decl: S('function'),
        }
        HL_LANGS.powershell = {
          line: ['#'], block: ['<#', '#>'], quotes: CC_QUOTES,
          esc: '`', caseInsensitive: true, capitalClass: true, pre: false, hashWord: true, cmdlet: true,
          kw: S('begin break catch class continue data define do dynamicparam else elseif end enum exit filter finally for foreach from function hidden if in param process return static switch throw trap try until using var while workflow'),
          const: S('true false null'),
          builtin: S('Write-Output Write-Host Write-Error Write-Warning Write-Verbose Write-Debug Read-Host Get-Content Set-Content Add-Content Out-File Get-ChildItem Get-Item Remove-Item New-Item Copy-Item Move-Item Rename-Item Set-Item Get-Location Set-Location Push-Location Pop-Location Get-Process Start-Process Stop-Process Get-Service Start-Service Stop-Service Get-Command Get-Help Get-Member Where-Object ForEach-Object Select-Object Sort-Object Group-Object Measure-Object Format-Table Format-List Export-Csv Import-Csv ConvertTo-Json ConvertFrom-Json Invoke-WebRequest Invoke-RestMethod Test-Path Join-Path Split-Path Resolve-Path New-Object Set-Variable Get-Variable Clear-Variable Remove-Variable Start-Sleep Get-Date Set-Date Add-Type'),
          decl: S('function class enum param'),
        }
        HL_LANGS.sql = {
          line: ['--'], block: DEF_BLOCK, quotes: [["'", "'"], ['"', '"'], ['`', '`']],
          esc: '\\', quoteDoubleEscape: true, caseInsensitive: true, capitalClass: false, pre: false,
          kw: S('select from where insert update delete create alter drop table index view join inner left right full outer cross on as and or not null is in exists between like group by order having limit offset union all distinct case when then else end primary key foreign references unique constraint default values into set add column begin commit rollback transaction with over partition desc asc check if return function procedure trigger execute grant revoke truncate merge explain use database schema intersect except'),
          const: S('true false null'),
          builtin: S('coalesce nullif cast count sum avg min max abs round floor ceil lower upper length substr substring trim ltrim rtrim concat replace now current_date current_timestamp dateadd datediff datepart row_number rank dense_rank lead lag first_value last_value ntile'),
          decl: S(''),
        }
        // JSON rides the generic scanner: strings followed by ':' become keys.
        HL_LANGS.json = {
          line: [], block: null, quotes: [['"', '"']],
          esc: '\\', caseInsensitive: false, capitalClass: false, pre: false, keyStrings: true,
          kw: S(''), const: S('true false null'), builtin: S(''), decl: S(''),
        }

        // ---------- markup / data / prose scanners ----------
        const scanHtml = (text, state) => {
          const out = []
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          let i = 0
          state.mode = state.mode || null
          if (state.mode === 'comment') {
            const end = text.indexOf('-->')
            if (end < 0) { out.push({ t: text, c: 'com' }); return out }
            out.push({ t: text.slice(0, end + 3), c: 'com' })
            i = end + 3
            state.mode = null
          }
          // Text runs: split out &entities; for a distinct color.
          const plainText = (s) => {
            if (!s) return
            const parts = s.split(/(&[A-Za-z][A-Za-z0-9]*;|&#\d+;|&#x[0-9a-fA-F]+;)/)
            for (const p of parts) {
              if (!p) continue
              if (/^&/.test(p)) out.push({ t: p, c: 'const' })
              else out.push({ t: p, c: null })
            }
          }
          while (i < n) {
            const lt = text.indexOf('<', i)
            if (lt < 0) { plainText(text.slice(i)); i = n; break }
            plainText(text.slice(i, lt))
            if (text.startsWith('<!--', lt)) {
              const end = text.indexOf('-->', lt + 4)
              if (end < 0) { out.push({ t: text.slice(lt), c: 'com' }); state.mode = 'comment'; return out }
              out.push({ t: text.slice(lt, end + 3), c: 'com' })
              i = end + 3
              continue
            }
            let j = lt + 1
            let close = false
            if (text[j] === '/') { close = true; j++ }
            const m = /^[A-Za-z][\w:-]*/.exec(text.slice(j))
            if (m) {
              if (close) out.push({ t: text.slice(lt, j), c: 'tag' })
              out.push({ t: m[0], c: 'tag' })
              j += m[0].length
            } else {
              // <!DOCTYPE ...>, <?xml ...?>
              const m2 = /^[!?][A-Za-z][\w:-]*/.exec(text.slice(j))
              if (m2) {
                out.push({ t: text.slice(lt, j) + m2[0], c: 'pp' })
                j += m2[0].length
              } else {
                plain(text[lt])
                i = lt + 1
                continue
              }
            }
            let expectValue = false
            while (j < n) {
              const ch = text[j]
              if (ch === '>') { plain('>'); j++; break }
              if (ch === '/' && text[j + 1] === '>') { plain('/>'); j += 2; break }
              if (/\s/.test(ch)) { plain(ch); j++; continue }
              if (ch === '=') { out.push({ t: '=', c: 'op' }); j++; expectValue = true; continue }
              if (expectValue) {
                const q = (ch === '"' || ch === "'") ? ch : ''
                if (q) {
                  const end = text.indexOf(q, j + 1)
                  if (end < 0) { out.push({ t: text.slice(j), c: 'str' }); j = n; break }
                  out.push({ t: text.slice(j, end + 1), c: 'str' })
                  j = end + 1
                } else {
                  const vm = /^[^\s>]+/.exec(text.slice(j))
                  if (vm) { out.push({ t: vm[0], c: 'str' }); j += vm[0].length }
                  else { plain(ch); j++ }
                }
                expectValue = false
                continue
              }
              const am = /^[^\s=/>]+/.exec(text.slice(j))
              if (am) { out.push({ t: am[0], c: 'attr' }); j += am[0].length; continue }
              plain(ch); j++
            }
            i = j
          }
          return out
        }

        const scanCss = (text, state) => {
          const out = []
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          let i = 0
          state.depth = state.depth || 0
          state.mode = state.mode || null
          if (state.mode === 'block') {
            const end = text.indexOf('*/')
            if (end < 0) { out.push({ t: text, c: 'com' }); return out }
            out.push({ t: text.slice(0, end + 2), c: 'com' })
            i = end + 2
            state.mode = null
          }
          while (i < n) {
            const ch = text[i]
            if (ch === '/' && text[i + 1] === '*') {
              const end = text.indexOf('*/', i + 2)
              if (end < 0) { out.push({ t: text.slice(i), c: 'com' }); state.mode = 'block'; return out }
              out.push({ t: text.slice(i, end + 2), c: 'com' })
              i = end + 2
              continue
            }
            if (ch === '"' || ch === "'") {
              const end = text.indexOf(ch, i + 1)
              if (end < 0) { out.push({ t: text.slice(i), c: 'str' }); i = n; break }
              out.push({ t: text.slice(i, end + 1), c: 'str' })
              i = end + 1
              continue
            }
            if (ch === '@') {
              const m = /^@[\w-]+/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'kw' }); i += m[0].length; continue }
            }
            if (ch === '#' && /[0-9a-fA-F]/.test(text[i + 1] || '')) {
              const m = /^#[0-9a-fA-F]{3,8}\b/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'const' }); i += m[0].length; continue }
            }
            if (/[0-9]/.test(ch)) {
              const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|rad|turn|fr|ch|ex|pt|pc|cm|mm|in|dpi|dppx|Hz|kHz)?/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'num' }); i += m[0].length; continue }
            }
            if (ch === '{') { plain('{'); i++; state.depth++; continue }
            if (ch === '}') { plain('}'); i++; state.depth = Math.max(0, state.depth - 1); continue }
            // property name inside a declaration block: ident/--custom : value
            if (state.depth > 0 && (i === 0 || /[\s{;]/.test(text[i - 1]))) {
              const pm = /^(?:--[\w-]+|-?[A-Za-z_][\w-]*)\s*:(?=\s|[^\w-]|$)/.exec(text.slice(i))
              if (pm) {
                out.push({ t: pm[0].slice(0, pm[0].lastIndexOf(':')), c: 'attr' })
                out.push({ t: ':', c: 'op' })
                i += pm[0].length
                continue
              }
            }
            // function call name: var( calc( url( ...
            const fm = /^(-?[A-Za-z_][\w-]*)\s*\(/.exec(text.slice(i))
            if (fm) { out.push({ t: fm[1], c: 'fn' }); plain('('); i += fm[0].length; continue }
            // pseudo-classes / pseudo-elements: :hover ::before :root
            if (ch === ':') {
              const sm = /^::?[A-Za-z_-][\w-]*/.exec(text.slice(i))
              if (sm) { out.push({ t: sm[0], c: 'cls' }); i += sm[0].length; continue }
            }
            // class / id selectors
            if (ch === '.' || ch === '#') {
              const sm2 = /^[.#][A-Za-z_-][\w-]*/.exec(text.slice(i))
              if (sm2) { out.push({ t: sm2[0], c: 'cls' }); i += sm2[0].length; continue }
            }
            if (/[A-Za-z_-]/.test(ch)) {
              const wm = /^[A-Za-z_-][\w-]*/.exec(text.slice(i))
              if (wm) {
                const w = wm[0].toLowerCase()
                const c = (w === 'important' || w === 'inherit' || w === 'initial' || w === 'unset' || w === 'revert' || w === 'auto' || w === 'none') ? 'kw' : null
                out.push({ t: wm[0], c: c })
                i += wm[0].length
                continue
              }
            }
            if ('{},;:()>+~*='.indexOf(ch) >= 0) { out.push({ t: ch, c: 'op' }); i++; continue }
            if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(text[j])) j++; plain(text.slice(i, j)); i = j; continue }
            plain(ch); i++
          }
          return out
        }

        const scanYaml = (text, state) => {
          const out = []
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          let i = 0
          const dm = /^(---|\.\.\.)(?:\s|$)/.exec(text)
          if (dm) { out.push({ t: dm[1], c: 'kw' }); i = dm[1].length }
          while (i < n) {
            const ch = text[i]
            if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) { out.push({ t: text.slice(i), c: 'com' }); i = n; break }
            if (ch === '"' || ch === "'") {
              const end = text.indexOf(ch, i + 1)
              if (end < 0) { out.push({ t: text.slice(i), c: 'str' }); i = n; break }
              let cls = 'str'
              if (/^\s*:(\s|$)/.test(text.slice(end + 1))) cls = 'key'
              out.push({ t: text.slice(i, end + 1), c: cls })
              i = end + 1
              continue
            }
            if (ch === '&' || ch === '*') {
              const m = /^[&*][A-Za-z0-9_-]+/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'const' }); i += m[0].length; continue }
            }
            if ((ch === '|' || ch === '>') && /^[|>][+-]?\d*[+-]?(?:\s|$)/.test(text.slice(i))) {
              out.push({ t: text[i], c: 'op' }); i++; continue
            }
            if (/[A-Za-z_]/.test(ch)) {
              const km = /^[A-Za-z_][\w-]*(?:\s+[A-Za-z_][\w-]*)*\s*:/.exec(text.slice(i))
              if (km) {
                const colonAt = km[0].lastIndexOf(':')
                const pre = km[0].slice(0, colonAt)
                const sm = /^(.*?)(\s*)$/.exec(pre)
                out.push({ t: sm[1], c: 'key' })
                if (sm[2]) plain(sm[2])
                out.push({ t: ':', c: 'op' })
                i += km[0].length
                continue
              }
            }
            const sm = /^(true|false|null|~|yes|no|on|off)(?=\s|$)/.exec(text.slice(i))
            if (sm) { out.push({ t: sm[0], c: 'const' }); i += sm[0].length; continue }
            const nm = /^-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))
            if (nm) { out.push({ t: nm[0], c: 'num' }); i += nm[0].length; continue }
            if (ch === '-') {
              if (/^-\s/.test(text.slice(i))) { out.push({ t: '-', c: 'op' }); i++; continue }
              // negative number fallback
            }
            if (ch === ':') { out.push({ t: ':', c: 'op' }); i++; continue }
            if ('{}[],'.indexOf(ch) >= 0) { out.push({ t: ch, c: 'op' }); i++; continue }
            if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(text[j])) j++; plain(text.slice(i, j)); i = j; continue }
            // tag prefix !tag
            if (ch === '!') {
              const m = /^![\w-]*/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'op' }); i += m[0].length; continue }
            }
            plain(ch); i++
          }
          return out
        }

        const scanToml = (text, state) => {
          const out = []
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          let i = 0
          state.mode = state.mode || null
          if (state.mode === 'str3') {
            const end = text.indexOf(state.delim)
            if (end < 0) { out.push({ t: text, c: 'str' }); return out }
            out.push({ t: text.slice(0, end + state.delim.length), c: 'str' })
            i = end + state.delim.length
            state.mode = null
            state.delim = null
          }
          while (i < n) {
            const ch = text[i]
            if (ch === '#') { out.push({ t: text.slice(i), c: 'com' }); i = n; break }
            if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
              const delim = text.slice(i, i + 3)
              const end = text.indexOf(delim, i + 3)
              if (end < 0) { out.push({ t: text.slice(i), c: 'str' }); state.mode = 'str3'; state.delim = delim; return out }
              out.push({ t: text.slice(i, end + 3), c: 'str' })
              i = end + 3
              continue
            }
            if (ch === '"' || ch === "'") {
              const end = text.indexOf(ch, i + 1)
              let cls = 'str'
              if (end >= 0 && /^\s*=/.test(text.slice(end + 1))) cls = 'key'
              if (end < 0) { out.push({ t: text.slice(i), c: cls }); i = n; break }
              out.push({ t: text.slice(i, end + 1), c: cls })
              i = end + 1
              continue
            }
            if (ch === '[') {
              const m = /^\[\[?[A-Za-z0-9_.\-\s]+\]?\]/.exec(text.slice(i))
              if (m) { out.push({ t: m[0], c: 'key' }); i += m[0].length; continue }
              out.push({ t: '[', c: 'op' }); i++; continue
            }
            if (/[A-Za-z_]/.test(ch)) {
              const km = /^[A-Za-z_][\w-]*(\s*\.\s*[A-Za-z_][\w-]*)*\s*=/.exec(text.slice(i))
              if (km) {
                const eq = km[0].lastIndexOf('=')
                const pre = km[0].slice(0, eq)
                const sm = /^(.*?)(\s*)$/.exec(pre)
                out.push({ t: sm[1], c: 'key' })
                if (sm[2]) plain(sm[2])
                out.push({ t: '=', c: 'op' })
                i += km[0].length
                continue
              }
            }
            const dtm = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/.exec(text.slice(i))
            if (dtm) { out.push({ t: dtm[0], c: 'num' }); i += dtm[0].length; continue }
            const nm = /^[+-]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
            if (nm) { out.push({ t: nm[0], c: 'num' }); i += nm[0].length; continue }
            const bm = /^(true|false)(?=\s|$)/.exec(text.slice(i))
            if (bm) { out.push({ t: bm[0], c: 'const' }); i += bm[0].length; continue }
            if ('=,{}]'.indexOf(ch) >= 0) { out.push({ t: ch, c: 'op' }); i++; continue }
            if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(text[j])) j++; plain(text.slice(i, j)); i = j; continue }
            if (/[A-Za-z_]/.test(ch)) {
              const wm = /^[A-Za-z_][\w-]*/.exec(text.slice(i))
              const w = wm[0]
              out.push({ t: w, c: (w === 'inf' || w === 'nan') ? 'const' : null })
              i += w.length
              continue
            }
            plain(ch); i++
          }
          return out
        }

        const mdInline = (text, out) => {
          const n = text.length
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          let i = 0
          while (i < n) {
            const ch = text[i]
            if (ch === '`') {
              const end = text.indexOf('`', i + 1)
              if (end < 0) { plain(text.slice(i)); break }
              out.push({ t: text.slice(i, end + 1), c: 'codei' })
              i = end + 1
              continue
            }
            if (ch === '*' && text[i + 1] === '*') {
              const end = text.indexOf('**', i + 2)
              if (end < 0) { plain(text.slice(i)); break }
              out.push({ t: '**', c: 'op' })
              if (end > i + 2) out.push({ t: text.slice(i + 2, end), c: 'strong' })
              out.push({ t: '**', c: 'op' })
              i = end + 2
              continue
            }
            if ((ch === '*' || ch === '_') && text[i + 1] !== ch) {
              const end = text.indexOf(ch, i + 1)
              if (end > i + 1 && end < i + 80) {
                out.push({ t: ch, c: 'op' })
                out.push({ t: text.slice(i + 1, end), c: 'strong' })
                out.push({ t: ch, c: 'op' })
                i = end + 1
                continue
              }
            }
            if (ch === '[') {
              const mm = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(text.slice(i))
              if (mm) {
                out.push({ t: '[', c: 'op' })
                out.push({ t: mm[1], c: 'str' })
                out.push({ t: '](', c: 'op' })
                out.push({ t: mm[2], c: 'fn' })
                out.push({ t: ')', c: 'op' })
                i += mm[0].length
                continue
              }
            }
            plain(ch); i++
          }
        }
        const MD_ALIAS = { py: 'python', js: 'javascript', ts: 'typescript', cpp: 'cpp', 'c++': 'cpp', cs: 'csharp', sh: 'bash', ps1: 'powershell', rb: 'ruby', kt: 'kotlin', yml: 'yaml' }
        const scanMd = (text, state) => {
          const out = []
          const plain = (s, c) => { if (s) out.push({ t: s, c: c || null }) }
          state.mode = state.mode || null
          if (state.mode === 'code') {
            if (/^(```|~~~)/.test(text)) { out.push({ t: text, c: 'kw' }); state.mode = null; state.codeLang = null; state.innerState = null; return out }
            const inner = state.codeLang ? lineTokens(text, state.codeLang, state.innerState) : null
            if (inner) { for (const t of inner) out.push(t) }
            else out.push({ t: text, c: 'code' })
            return out
          }
          const fence = /^(```|~~~)\s*([\w.+-]*)(.*)$/.exec(text)
          if (fence) {
            out.push({ t: fence[1] + fence[2], c: 'kw' })
            if (fence[3]) out.push({ t: fence[3], c: 'com' })
            state.mode = 'code'
            let info = (fence[2] || '').toLowerCase()
            if (MD_ALIAS[info]) info = MD_ALIAS[info]
            state.codeLang = (HL_LANGS[info] || HL_SCANNERS[info]) ? info : null
            state.innerState = state.codeLang ? { mode: null } : null
            return out
          }
          const hd = /^(#{1,6})(\s+)(.*)$/.exec(text)
          if (hd) { out.push({ t: hd[1] + hd[2], c: 'kw' }); mdInline(hd[3], out); return out }
          const bq = /^(\s*>\s?)(.*)$/.exec(text)
          if (bq) { out.push({ t: bq[1], c: 'op' }); mdInline(bq[2], out); return out }
          if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) { out.push({ t: text, c: 'op' }); return out }
          const li = /^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/.exec(text)
          if (li) { plain(li[1]); out.push({ t: li[2], c: 'num' }); plain(li[3]); mdInline(li[4], out); return out }
          mdInline(text, out)
          return out
        }

        const HL_SCANNERS = { html: scanHtml, xml: scanHtml, css: scanCss, yaml: scanYaml, toml: scanToml, markdown: scanMd }
        const lineTokens = (text, langId, state) => {
          const sp = HL_SCANNERS[langId]
          if (sp) return sp(text, state)
          const cfg = HL_LANGS[langId]
          return cfg ? tokenize(text, cfg, state) : null
        }
        // Small cache for state-clean lines: renders happen on every hunk
        // hover, so re-tokenizing each line every time would be wasteful.
        const HL_CACHE = new Map()
        const lineTokensCached = (text, langId, state) => {
          if (!langId) return null
          const cleanIn = !state.mode
          const ck = langId + '\u0001' + text
          if (cleanIn && HL_CACHE.has(ck)) return HL_CACHE.get(ck)
          const toks = lineTokens(text, langId, state)
          if (cleanIn && !state.mode) {
            if (HL_CACHE.size > 4000) HL_CACHE.delete(HL_CACHE.keys().next().value)
            HL_CACHE.set(ck, toks)
          }
          return toks
        }
        // Live-editing sync: after the browser mutates a contentEditable line,
        // the pointer-events:none highlight layer below must mirror the new
        // text (imperative, no React render involved).
        // v1.16.0: input bursts are coalesced through requestAnimationFrame —
        // fast typing used to run one full re-tokenize + span rebuild per
        // keystroke (the editable line's text changes every time, so the
        // token cache always missed). Now at most one rebuild per frame, and
        // the callback re-reads the LIVE text so no keystroke is skipped.
        const hlPending = new Set()
        let hlRaf = 0
        const hlRafReq = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16)
        const hlRafCancel = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout
        const paintHlNow = (el) => {
          hlPending.delete(el)
          if (!el || !el.parentNode) return
          try {
            const wrap = el.parentNode
            const hl = wrap.querySelector('.dsh-fe-hl')
            if (!hl) return
            const text = (el.textContent || '').replace(/\n/g, '')
            const langId = hl.getAttribute('data-lang') || ''
            const toks = langId ? lineTokensCached(text, langId, { mode: null }) : null
            hl.textContent = ''
            if (toks) {
              for (const t of toks) {
                const s = document.createElement('span')
                s.className = 'dsh-fe-tk' + (t.c ? ' dsh-fe-tk-' + t.c : '')
                s.textContent = t.t
                hl.append(s)
              }
            } else {
              hl.textContent = text
            }
            // v1.22: search marks ride the overlay (module state, row = the
            // editable's model index).
            applySearchMarks(hl, 'm' + (el.getAttribute('data-m') || ''))
          } catch (e) {}
        }
        const syncHl = (el) => {
          if (!el) return
          hlPending.add(el)
          if (hlRaf) return
          hlRaf = hlRafReq(() => {
            hlRaf = 0
            const els = Array.from(hlPending)
            for (const e of els) paintHlNow(e)
          })
        }

        // ---------- v1.22: in-view search (Ctrl+F) ----------
        // Shared search state between DiffPane (bar + navigation) and the two
        // highlight painters. Marks are wrapped into the pointer-events:none
        // overlay layer (`.dsh-fe-hl`) only — React never owns those nodes
        // after the shell fills them, so imperative wrapping is safe (same
        // rule as v1.13.2). Corpus = the edit model's rows in display order
        // (current content incl. hunk-new rows; deleted rows are not
        // searched). matches: flat list in display order, one entry per
        // (hit × row-segment); byRow maps row key -> that row's entries.
        const searchState = { on: false, query: '', matches: [], byRow: new Map(), cur: -1, dirty: false, lastModel: null, lastVersion: -1 }
        // Wrap every occurrence of the current query inside a freshly painted
        // highlight overlay. Occurrence ranges are row-local; the walk uses a
        // cumulative offset over the overlay's text nodes (tokens) and splits
        // any node overlapping a range into pre/hit/post pieces.
        function applySearchMarks(hl, rowKey) {
          if (!searchState.on || !searchState.query) return
          const occ = searchState.byRow.get(rowKey)
          if (!occ || occ.length === 0) return
          const cursor = { at: 0 }
          const walk = (parent) => {
            let child = parent.firstChild
            while (child) {
              const nxt = child.nextSibling
              if (child.nodeType === 3) {
                const start = cursor.at
                const end = start + child.textContent.length
                cursor.at = end
                for (const o of occ) {
                  const os = Math.max(o.pos, start)
                  const oe = Math.min(o.pos + o.len, end)
                  if (os >= oe) continue
                  const isCur = searchState.matches[searchState.cur] === o
                  const parent = child.parentNode
                  if (!parent) break
                  const pre = document.createTextNode(child.textContent.slice(0, os - start))
                  const hit = document.createElement('span')
                  hit.className = 'dsh-fe-hit' + (isCur ? ' dsh-fe-hit-cur' : '')
                  hit.textContent = child.textContent.slice(os - start, oe - start)
                  const post = document.createTextNode(child.textContent.slice(oe - start))
                  parent.replaceChild(pre, child)
                  parent.insertBefore(hit, pre.nextSibling)
                  parent.insertBefore(post, hit.nextSibling)
                  break
                }
              } else if (child.nodeType === 1 && child.firstChild) {
                walk(child)
              }
              child = nxt
            }
          }
          walk(hl)
        }
        // Model-based text of the current selection (row texts joined with
        // \n) — the browser's own toString() concatenates the per-line spans
        // without newlines. Returns null when the selection is not on the
        // model (single-row model selections ARE included) so callers can
        // fall back to the browser default (old read-only rows etc.).
        function selectedModelText(mm) {
          try {
            const sel = window.getSelection && window.getSelection()
            if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
            const a = rowOfNodeEl(sel.anchorNode)
            const f = rowOfNodeEl(sel.focusNode)
            if (!a || !f) return null
            const anchor = { row: a.row, pos: offsetInEl(a.el, sel.anchorNode, sel.anchorOffset) }
            const focus = { row: f.row, pos: offsetInEl(f.el, sel.focusNode, sel.focusOffset) }
            const p1 = (anchor.row < focus.row || (anchor.row === focus.row && anchor.pos <= focus.pos)) ? anchor : focus
            const p2 = p1 === anchor ? focus : anchor
            let text = ''
            for (let r = p1.row; r <= p2.row && r < mm.lines.length; r++) {
              if (r > p1.row) text += '\n'
              const from = r === p1.row ? p1.pos : 0
              const to = r === p2.row ? p2.pos : mm.lines[r].length
              text += mm.lines[r].slice(from, to)
            }
            return text
          } catch (e) { return null }
        }

        const LANG_BY_EXT = {
          py: 'python', pyw: 'python',
          java: 'java',
          js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
          ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
          c: 'c', h: 'c',
          cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', inl: 'cpp',
          cs: 'csharp', go: 'go', rs: 'rust',
          php: 'php', rb: 'ruby', swift: 'swift',
          kt: 'kotlin', kts: 'kotlin',
          r: 'r',
          sh: 'bash', bash: 'bash', zsh: 'bash',
          ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
          sql: 'sql',
          html: 'html', htm: 'html',
          css: 'css',
          json: 'json',
          yaml: 'yaml', yml: 'yaml',
          toml: 'toml',
          xml: 'xml', svg: 'xml', xhtml: 'xml',
          md: 'markdown', markdown: 'markdown',
        }
        const langOf = (path) => {
          if (!path) return null
          const base = path.split('/').pop() || ''
          const dot = base.lastIndexOf('.')
          if (dot < 0) {
            if (base === 'Makefile' || base === 'Rakefile' || base === 'Gemfile') return 'bash'
            return null
          }
          const ext = base.slice(dot + 1).toLowerCase()
          return LANG_BY_EXT[ext] || null
        }

        // ---------- sticky scope bar (v1.14) ----------
        // Definition-line detectors + a one-pass outline builder, shared by
        // the code view and the large-file preview. The bar shows the chain
        // of enclosing definitions for the first visible line; clicking a
        // segment scrolls to its definition. Heuristics, not parsers: rare
        // false positives are acceptable for a navigation aid and never
        // touch the document.
        const CF_CTRL = S('if for while switch return do else case default goto throw new delete sizeof using try catch break continue with when where')
        const MOD_LISTS = {
          c: ['static', 'extern', 'inline', 'const', 'volatile', 'register'],
          cpp: ['static', 'extern', 'inline', 'virtual', 'constexpr', 'const', 'friend', 'public', 'private', 'protected', 'final', 'override', 'explicit', 'noexcept', 'template', 'typename'],
          java: ['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'default', 'strictfp', 'transient', 'volatile'],
          csharp: ['public', 'private', 'protected', 'internal', 'static', 'virtual', 'override', 'abstract', 'sealed', 'extern', 'unsafe', 'partial', 'readonly', 'new', 'async', 'const', 'ref', 'in', 'out', 'file', 'required'],
          javascript: ['static', 'async', 'get', 'set', 'public', 'private', 'protected', 'readonly', 'abstract', 'declare', 'override'],
          typescript: ['static', 'async', 'get', 'set', 'public', 'private', 'protected', 'readonly', 'abstract', 'declare', 'override'],
          kotlin: ['public', 'private', 'protected', 'internal', 'final', 'open', 'abstract', 'sealed', 'data', 'annotation', 'companion', 'const', 'lateinit', 'override', 'suspend', 'operator', 'infix', 'inline', 'external', 'tailrec', 'crossinline', 'noinline', 'reified', 'value', 'expect', 'actual', 'inner', 'vararg'],
          swift: ['public', 'private', 'fileprivate', 'internal', 'open', 'final', 'static', 'override', 'required', 'convenience', 'mutating', 'nonmutating', 'lazy', 'indirect', 'dynamic', 'nonisolated'],
          php: ['public', 'private', 'protected', 'static', 'final', 'abstract', 'readonly'],
        }
        // C-family rule: [modifiers] (decl-keyword name | type-seq name()).
        // Keyword/control-flow/builtin guards plus a trailing-brace or
        // declaration-shape requirement keep plain call statements out.
        const cStyleDef = (t, cfg, mods, extraDecl) => {
          if (!t) return null
          let s = t
          let guard = 0
          while (guard++ < 10) {
            const mm = /^([A-Za-z_][\w]*)\s+/.exec(s)
            if (mm && mods && mods.indexOf(mm[1]) >= 0) { s = s.slice(mm[0].length); continue }
            break
          }
          if (/^typedef\b/.test(s)) {
            let m = /\}\s*([A-Za-z_]\w*)\s*;?\s*$/.exec(s)
            if (!m) m = /^typedef\s+[^;{}]*\s([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;?\s*$/.exec(s)
            if (m) return { name: m[1], kind: 'cls', kw: 'typedef' }
            return null
          }
          const declSet = {}
          for (const k of Object.keys(cfg.decl || {})) declSet[k.toLowerCase()] = 1
          for (const k of Object.keys(extraDecl || {})) declSet[k.toLowerCase()] = 1
          const dm = /^([A-Za-z_]\w*)(?=\s)/.exec(s)
          if (dm && declSet[dm[1].toLowerCase()]) {
            if (dm[1] === 'val' || dm[1] === 'var' || dm[1] === 'let' || dm[1] === 'const') return null
            let rest = s.slice(dm[0].length).replace(/^\s+/, '')
            const m2 = /^([A-Za-z_~]\w*)(?=\s|\()/.exec(rest)
            let name = m2 ? m2[1] : null
            if (m2 && declSet[m2[1].toLowerCase()]) {
              rest = rest.slice(m2[0].length).replace(/^\s+/, '')
              const m3 = /^([A-Za-z_~]\w*)/.exec(rest)
              name = m3 ? m3[1] : null
            }
            if (!name || !/^[A-Za-z_~]/.test(name)) return null
            const w = dm[1].toLowerCase()
            return { name: name, kind: (w === 'fun' || w === 'func' || w === 'function' || w === 'def' || w === 'fn') ? 'fn' : 'cls', kw: dm[1] }
          }
          const mm = /^([A-Za-z_~]\w*(?:[&*<>\s:.]+[A-Za-z_~:.]\w*)*)\s*\(/.exec(s)
          if (!mm) return null
          const seq = mm[1]
          const nm = /([A-Za-z_~]\w*)\s*$/.exec(seq)
          if (!nm) return null
          const name = nm[1].replace(/^~+/, '')
          const fw = /^([A-Za-z_]\w*)/.exec(seq)
          if (fw && CF_CTRL[fw[1].toLowerCase()]) return null
          const kw = cfg.kw || {}
          if (kw[name] || kw[name.toLowerCase()]) return null
          if (cfg.builtin && (cfg.builtin[name] || cfg.builtin[name.toLowerCase()])) return null
          if (cfg.const && (cfg.const[name] || cfg.const[name.toLowerCase()])) return null
          const multiWord = /[\s:&*<>]/.test(seq)
          if (/\{\s*$/.test(s)) return { name: name, kind: 'fn' }
          if (multiWord && /\)\s*$/.test(s)) return { name: name, kind: 'fn' }
          return null
        }
        const DEF_RULES = {
          python: (t) => {
            let m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(t)
            if (m) return { name: m[1], kind: 'fn', kw: 'def' }
            m = /^class\s+([A-Za-z_]\w*)/.exec(t)
            if (m) return { name: m[1], kind: 'cls', kw: 'class' }
            return null
          },
          java: (t) => cStyleDef(t, HL_LANGS.java, MOD_LISTS.java),
          c: (t) => cStyleDef(t, HL_LANGS.c, MOD_LISTS.c),
          cpp: (t) => {
            const u = /^using\s+([A-Za-z_]\w*)\s*=/.exec(t)
            if (u) return { name: u[1], kind: 'cls' }
            return cStyleDef(t, HL_LANGS.cpp, MOD_LISTS.cpp, { namespace: 1 })
          },
          csharp: (t) => cStyleDef(t, HL_LANGS.csharp, MOD_LISTS.csharp, { namespace: 1 }),
          javascript: (t) => {
            let s = t
            const ex = /^export\s+(?:default\s+)?/.exec(s)
            if (ex) s = s.slice(ex[0].length)
            let m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(s)
            if (m) return { name: m[1], kind: 'fn', kw: 'function' }
            m = /^class\s+([A-Za-z_$][\w$]*)/.exec(s)
            if (m) return { name: m[1], kind: 'cls', kw: 'class' }
            m = /^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(s)
            if (m) return { name: m[2], kind: 'fn', kw: m[1] }
            return cStyleDef(s, HL_LANGS.javascript, MOD_LISTS.javascript)
          },
          typescript: (t) => {
            let s = t
            const ex = /^export\s+(?:default\s+)?/.exec(s)
            if (ex) s = s.slice(ex[0].length)
            let m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(s)
            if (m) return { name: m[1], kind: 'fn', kw: 'function' }
            m = /^(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(s)
            if (m) return { name: m[1], kind: 'cls', kw: 'class' }
            m = /^(interface|namespace|enum|type)\s+([A-Za-z_$][\w$]*)/.exec(s)
            if (m) return { name: m[2], kind: 'cls', kw: m[1] }
            m = /^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(s)
            if (m) return { name: m[2], kind: 'fn', kw: m[1] }
            return cStyleDef(s, HL_LANGS.typescript, MOD_LISTS.typescript)
          },
          go: (t) => {
            let m = /^func\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(t)
            if (m) return { name: m[1], kind: 'fn', kw: 'func' }
            m = /^type\s+([A-Za-z_]\w*)/.exec(t)
            if (m) return { name: m[1], kind: 'cls', kw: 'type' }
            return null
          },
          rust: (t) => {
            let s = t
            const pm = /^pub\s*(?:\([^)]*\))?\s*/.exec(s)
            if (pm) s = s.slice(pm[0].length)
            let m = /^(?:(?:async|unsafe|const|extern)\s+)?(fn|struct|enum|trait|mod|type|const|static)\s+([A-Za-z_]\w*)/.exec(s)
            if (m) return { name: m[2], kind: m[1] === 'fn' ? 'fn' : 'cls', kw: m[1] }
            m = /^(?:unsafe\s+)?impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/.exec(s)
            if (m) return { name: m[1], kind: 'cls', kw: 'impl' }
            return null
          },
          php: (t) => cStyleDef(t, HL_LANGS.php, MOD_LISTS.php),
          ruby: (t) => {
            let m = /^class\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)/.exec(t)
            if (m) return { name: m[1], kind: 'cls', kw: 'class' }
            m = /^module\s+([A-Za-z_]\w*)/.exec(t)
            if (m) return { name: m[1], kind: 'cls', kw: 'module' }
            m = /^def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/.exec(t)
            if (m) return { name: m[1], kind: 'fn', kw: 'def' }
            return null
          },
          r: (t) => {
            const m = /^([A-Za-z.][\w.]*)\s*(?:<-|=)\s*function\s*\(/.exec(t)
            return m ? { name: m[1], kind: 'fn', kw: 'function' } : null
          },
          bash: (t) => {
            let m = /^function\s+([A-Za-z_][\w.-]*)/.exec(t)
            if (m) return { name: m[1], kind: 'fn', kw: 'function' }
            m = /^([A-Za-z_][\w.-]*)\s*\(\)\s*\{?/.exec(t)
            if (m) return { name: m[1], kind: 'fn' }
            return null
          },
          powershell: (t) => {
            let m = /^(workflow|filter|function)\s+([\w-]+)/i.exec(t)
            if (m) return { name: m[2], kind: 'fn', kw: m[1].toLowerCase() }
            m = /^(class|enum)\s+([\w-]+)/i.exec(t)
            if (m) return { name: m[2], kind: 'cls', kw: m[1].toLowerCase() }
            return null
          },
          swift: (t) => {
            const m = /^(?:override\s+|public\s+|private\s+|fileprivate\s+|internal\s+|open\s+|final\s+|required\s+|convenience\s+)*(init|deinit|subscript)\b/.exec(t)
            if (m) return { name: m[1], kind: 'fn', kw: m[1] }
            // `class` doubles as a member modifier (class func/var) — strip it
            // only in that position so `class Foo {` still reads as a type.
            const m1 = /^class\s+(?=var\b|let\b|func\b)/.exec(t)
            const s = m1 ? t.slice(m1[0].length) : t
            return cStyleDef(s, HL_LANGS.swift, MOD_LISTS.swift)
          },
          kotlin: (t) => cStyleDef(t, HL_LANGS.kotlin, MOD_LISTS.kotlin),
          sql: (t) => {
            const m = /^(?:create\s+(?:or\s+replace\s+)?)?(function|procedure|trigger|view|table)\s+([\w"`.[\]]+)/i.exec(t)
            if (!m) return null
            const w = m[1].toLowerCase()
            return { name: m[2], kind: (w === 'function' || w === 'procedure' || w === 'trigger') ? 'fn' : 'cls', kw: w }
          },
          json: (t) => {
            const m = /^"([^"]+)"\s*:\s*[{\[]\s*$/.exec(t)
            return m ? { name: m[1], kind: 'key' } : null
          },
          yaml: (t) => {
            const m = /^(?:-\s+)?([A-Za-z0-9_-]+|"[^"]*"|'[^']*')\s*:\s*(?:#.*)?$/.exec(t)
            return m ? { name: m[1].replace(/^["']|["']$/g, ''), kind: 'key' } : null
          },
          toml: (t) => {
            const m = /^(\[\[?)([A-Za-z0-9._"-]+)\]\]?\s*(?:#.*)?$/.exec(t)
            return m ? { name: m[2], kind: 'key', kw: m[1] === '[[' ? 'array' : 'table' } : null
          },
          css: (t) => {
            if (!/\{\s*$/.test(t) || /^@(?:charset|import)\b/.test(t)) return null
            const cut = t.lastIndexOf('{')
            const name = t.slice(0, cut < 0 ? t.length : cut).trim()
            return name ? { name: name.length > 80 ? name.slice(0, 80) + '…' : name, kind: 'sel' } : null
          },
          markdown: (t, ctx) => {
            if (/^(```|~~~)/.test(t)) { ctx.mdFence = !ctx.mdFence; return null }
            if (ctx.mdFence) return null
            const m = /^(#{1,6})\s+(.*)$/.exec(t)
            if (!m) return null
            const name = m[2].replace(/\s*\{#[^}]*\}\s*$/, '').trim() || m[2].trim()
            return { name: name, kind: 'head', level: m[1].length }
          },
        }
        const VOID_TAGS = S('br img input hr meta link area base col embed source track wbr param')
        // Segment keyword labels when a detector did not capture the source
        // keyword (markdown headings use the hashes of their level instead).
        const KIND_LABEL = { fn: 'fn', cls: 'class', tag: 'tag', key: 'key', sel: 'rule' }
        // One pass over the lines: per-language detectors decide definition
        // lines; a scope stack (brace depth * 4 + leading whitespace as the
        // effective indent, tag stack for HTML/XML, heading level for
        // markdown) assigns each definition its parent and end line.
        const buildOutline = (lines, langId) => {
          if (!langId || !lines || !lines.length) return []
          const isHtml = langId === 'html' || langId === 'xml'
          const rule = isHtml ? null : DEF_RULES[langId]
          if (!isHtml && !rule) return []
          const defs = []
          const stack = []
          let braceDepth = 0
          const hlState = { mode: null }
          const ctx = { cfg: HL_LANGS[langId] || null, mdFence: false, tagStack: [] }
          const pushDef = (def, indent) => {
            def.parent = stack.length ? stack[stack.length - 1].def : null
            def.end = null
            defs.push(def)
            stack.push({ indent: indent, def: def })
          }
          const popTo = (indent, lineIdx) => {
            while (stack.length && stack[stack.length - 1].indent >= indent) {
              const top = stack.pop()
              if (top.def.end === null) top.def.end = lineIdx
            }
          }
          for (let i = 0; i < lines.length; i++) {
            const raw = lines[i]
            const ws = (raw.match(/^\s*/) || [''])[0].length
            const t = raw.trim()
            if (isHtml) {
              const re = /<(\/?)([A-Za-z][\w-]*)\b([^<>]*?)(\/?)>/g
              let m
              while ((m = re.exec(raw))) {
                const name = m[2].toLowerCase()
                if (m[1] === '/') {
                  for (let k = ctx.tagStack.length - 1; k >= 0; k--) {
                    if (ctx.tagStack[k].name === name) {
                      const d = ctx.tagStack[k].def
                      if (d && d.end === null) d.end = i
                      ctx.tagStack.length = k
                      break
                    }
                  }
                } else if (m[4] !== '/' && !VOID_TAGS[name]) {
                  const def = { line: i, name: m[2], kind: 'tag', kw: null, lvl: 0 }
                  def.parent = ctx.tagStack.length ? ctx.tagStack[ctx.tagStack.length - 1].def : null
                  def.end = null
                  defs.push(def)
                  ctx.tagStack.push({ name: name, def: def })
                }
              }
              continue
            }
            let toks = lineTokensCached(raw, langId, hlState)
            let opens = 0
            let closes = 0
            const countBrackets = langId === 'json'
            if (toks) {
              for (const tk of toks) {
                if (tk.c === 'str' || tk.c === 'com') continue
                for (let c = 0; c < tk.t.length; c++) {
                  if (tk.t[c] === '{' || (countBrackets && tk.t[c] === '[')) opens++
                  else if (tk.t[c] === '}' || (countBrackets && tk.t[c] === ']')) closes++
                }
              }
            }
            const startsClose = countBrackets ? /^[ \t]*[}\]]/.test(raw) : /^[ \t]*\}/.test(raw)
            const effIndent = (startsClose ? Math.max(0, braceDepth - 1) : braceDepth) * 4 + ws
            braceDepth = Math.max(0, braceDepth + opens - closes)
            if (t === '') continue
            let isComment = false
            if (toks) {
              for (const tk of toks) {
                if (tk.t.trim() === '') continue
                isComment = tk.c === 'com'
                break
              }
            }
            if (isComment) continue
            const d = rule(t, ctx, i, lines)
            if (d && d.level) {
              popTo(d.level, i)
              pushDef({ line: i, name: d.name, kind: d.kind, kw: d.kw || null, lvl: d.level }, d.level)
            } else if (d) {
              popTo(effIndent, i)
              pushDef({ line: i, name: d.name, kind: d.kind, kw: d.kw || null, lvl: 0 }, effIndent)
            } else if (langId !== 'markdown' && langId !== 'toml') {
              popTo(effIndent, i)
            }
          }
          popTo(-1, lines.length)
          return defs
        }
        // Innermost enclosing definition at display line F (0-based), then
        // walk parents for the chain. A tiny backward scan: chains are short
        // and updates are key-compared, so this stays cheap per scroll tick.
        const resolveChain = (defs, F) => {
          if (!defs || !defs.length) return []
          let d = null
          for (let k = defs.length - 1; k >= 0; k--) {
            const dd = defs[k]
            if (dd.line >= F) continue
            if (dd.end !== null && dd.end <= F) continue
            d = dd
            break
          }
          if (!d) return []
          const chain = []
          let p = d
          while (p && chain.length < 8) { chain.push(p); p = p.parent }
          chain.reverse()
          return chain
        }

        // ---------- markdown rendering (v1.9) ----------
        // markdown-it v15.0.0 (MIT, https://github.com/markdown-it/markdown-it) —
        // vendored browser UMD build; linkify-it/mdurl/uc.micro bundled inside.
        // Loaded fully offline: zero network requests, no CDN, no external
        // service. The default preset adds GFM tables + strikethrough.
        // ==== markdown-it vendored (do not edit) ====
        // markdown-it v15.0.0 — Copyright (c) 2014 Vitaly Puzrin, Alex Kocharin.
        // MIT License — https://github.com/markdown-it/markdown-it/blob/master/LICENSE
        // Bundled inside this UMD build: linkify-it (c) 2015 Vitaly Puzrin,
        // mdurl (c) 2015 Vitaly Puzrin, Alex Kocharin, uc.micro (c) 2015
        // Vitaly Puzrin — all MIT. Full license texts: THIRD_PARTY_LICENSES.md.
        const MarkdownIt = (() => {
          // Local CommonJS shim: the vendored UMD build picks its CommonJS
          // branch only when it SEES `module` — without this shim the browser
          // (no module global) routes it to the `globalThis.markdownit`
          // branch and the `return module.exports` below throws
          // "module is not defined", killing the loader entry.
          const module = { exports: {} }
          const exports = module.exports
          ;(function(e,t){typeof exports==`object`&&typeof module<`u`?module.exports=t():typeof define==`function`&&define.amd?define([],t):(e=typeof globalThis<`u`?globalThis:e||self,e.markdownit=t())})(this,function(){var e=Object.defineProperty,t=(t,n)=>{let r={};for(var i in t)e(r,i,{get:t[i],enumerable:!0});return n||e(r,Symbol.toStringTag,{value:`Module`}),r},n={};function r(e){let t=n[e];if(t)return t;t=n[e]=[];for(let e=0;e<128;e++){let n=String.fromCharCode(e);t.push(n)}for(let n=0;n<e.length;n++){let r=e.charCodeAt(n);t[r]=`%`+(`0`+r.toString(16).toUpperCase()).slice(-2)}return t}function i(e,t){typeof t!=`string`&&(t=i.defaultChars);let n=r(t);return e.replace(/(%[a-f0-9]{2})+/gi,function(e){let t=``;for(let r=0,i=e.length;r<i;r+=3){let a=parseInt(e.slice(r+1,r+3),16);if(a<128){t+=n[a];continue}if((a&224)==192&&r+3<i){let n=parseInt(e.slice(r+4,r+6),16);if((n&192)==128){let e=a<<6&1984|n&63;t+=e<128?`��`:String.fromCharCode(e),r+=3;continue}}if((a&240)==224&&r+6<i){let n=parseInt(e.slice(r+4,r+6),16),i=parseInt(e.slice(r+7,r+9),16);if((n&192)==128&&(i&192)==128){let e=a<<12&61440|n<<6&4032|i&63;t+=e<2048||e>=55296&&e<=57343?`���`:String.fromCharCode(e),r+=6;continue}}if((a&248)==240&&r+9<i){let n=parseInt(e.slice(r+4,r+6),16),i=parseInt(e.slice(r+7,r+9),16),o=parseInt(e.slice(r+10,r+12),16);if((n&192)==128&&(i&192)==128&&(o&192)==128){let e=a<<18&1835008|n<<12&258048|i<<6&4032|o&63;e<65536||e>1114111?t+=`����`:(e-=65536,t+=String.fromCharCode(55296+(e>>10),56320+(e&1023))),r+=9;continue}}t+=`�`}return t})}i.defaultChars=`;/?:@&=+$,#`,i.componentChars=``;var a={};function o(e){let t=a[e];if(t)return t;t=a[e]=[];for(let e=0;e<128;e++){let n=String.fromCharCode(e);/^[0-9a-z]$/i.test(n)?t.push(n):t.push(`%`+(`0`+e.toString(16).toUpperCase()).slice(-2))}for(let n=0;n<e.length;n++)t[e.charCodeAt(n)]=e[n];return t}function s(e,t,n){typeof t!=`string`&&(n=t,t=s.defaultChars),n===void 0&&(n=!0);let r=o(t),i=``;for(let t=0,a=e.length;t<a;t++){let o=e.charCodeAt(t);if(n&&o===37&&t+2<a&&/^[0-9a-f]{2}$/i.test(e.slice(t+1,t+3))){i+=e.slice(t,t+3),t+=2;continue}if(o<128){i+=r[o];continue}if(o>=55296&&o<=57343){if(o>=55296&&o<=56319&&t+1<a){let n=e.charCodeAt(t+1);if(n>=56320&&n<=57343){i+=encodeURIComponent(e[t]+e[t+1]),t++;continue}}i+=`%EF%BF%BD`;continue}i+=encodeURIComponent(e[t])}return i}s.defaultChars=`;/?:@&=+$,-_.!~*'()#`,s.componentChars=`-_.!~*'()`;function c(e){let t=``;return t+=e.protocol||``,t+=e.slashes?`//`:``,t+=e.auth?e.auth+`@`:``,e.hostname&&e.hostname.indexOf(`:`)!==-1?t+=`[`+e.hostname+`]`:t+=e.hostname||``,t+=e.port?`:`+e.port:``,t+=e.pathname||``,t+=e.search||``,t+=e.hash||``,t}function l(){this.protocol=null,this.slashes=null,this.auth=null,this.port=null,this.hostname=null,this.hash=null,this.search=null,this.pathname=null}var u=/^([a-z0-9.+-]+:)/i,d=/:[0-9]*$/,f=/^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/,p=[`%`,`/`,`?`,`;`,`#`,`'`,`{`,`}`,`|`,`\\`,`^`,"`",`<`,`>`,`"`,"`",` `,`\r`,`
`,`	`],m=[`/`,`?`,`#`],h=255,g=/^[+a-z0-9A-Z_-]{0,63}$/,_=/^([+a-z0-9A-Z_-]{0,63})(.*)$/,v={javascript:!0,"javascript:":!0},y={http:!0,https:!0,ftp:!0,gopher:!0,file:!0,"http:":!0,"https:":!0,"ftp:":!0,"gopher:":!0,"file:":!0};function b(e,t){if(e&&e instanceof l)return e;let n=new l;return n.parse(e,t),n}l.prototype.parse=function(e,t){let n,r,i,a=e;if(a=a.trim(),!t&&e.split(`#`).length===1){let e=f.exec(a);if(e)return this.pathname=e[1],e[2]&&(this.search=e[2]),this}let o=u.exec(a);if(o&&(o=o[0],n=o.toLowerCase(),this.protocol=o,a=a.substr(o.length)),(t||o||a.match(/^\/\/[^@\/]+@[^@\/]+/))&&(i=a.substr(0,2)===`//`,i&&!(o&&v[o])&&(a=a.substr(2),this.slashes=!0)),!v[o]&&(i||o&&!y[o])){let e=-1;for(let t=0;t<m.length;t++)r=a.indexOf(m[t]),r!==-1&&(e===-1||r<e)&&(e=r);let t,n;n=e===-1?a.lastIndexOf(`@`):a.lastIndexOf(`@`,e),n!==-1&&(t=a.slice(0,n),a=a.slice(n+1),this.auth=t),e=-1;for(let t=0;t<p.length;t++)r=a.indexOf(p[t]),r!==-1&&(e===-1||r<e)&&(e=r);e===-1&&(e=a.length),a[e-1]===`:`&&e--;let i=a.slice(0,e);a=a.slice(e),this.parseHost(i),this.hostname=this.hostname||``;let o=this.hostname[0]===`[`&&this.hostname[this.hostname.length-1]===`]`;if(!o){let e=this.hostname.split(/\./);for(let t=0,n=e.length;t<n;t++){let n=e[t];if(n&&!n.match(g)){let r=``;for(let e=0,t=n.length;e<t;e++)n.charCodeAt(e)>127?r+=`x`:r+=n[e];if(!r.match(g)){let r=e.slice(0,t),i=e.slice(t+1),o=n.match(_);o&&(r.push(o[1]),i.unshift(o[2])),i.length&&(a=i.join(`.`)+a),this.hostname=r.join(`.`);break}}}}this.hostname.length>h&&(this.hostname=``),o&&(this.hostname=this.hostname.substr(1,this.hostname.length-2))}let s=a.indexOf(`#`);s!==-1&&(this.hash=a.substr(s),a=a.slice(0,s));let c=a.indexOf(`?`);return c!==-1&&(this.search=a.substr(c),a=a.slice(0,c)),a&&(this.pathname=a),y[n]&&this.hostname&&!this.pathname&&(this.pathname=``),this},l.prototype.parseHost=function(e){let t=d.exec(e);t&&(t=t[0],t!==`:`&&(this.port=t.substr(1)),e=e.substr(0,e.length-t.length)),e&&(this.hostname=e)};var ee=t({decode:()=>i,encode:()=>s,format:()=>c,parse:()=>b}),te=t({Any:()=>x,Cc:()=>ne,Cf:()=>re,P:()=>S,S:()=>ie,Z:()=>ae}),x=/[\0-\uD7FF\uE000-\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/,ne=/[\0-\x1F\x7F-\x9F]/,re=/[\xAD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]|\uD804[\uDCBD\uDCCD]|\uD80D[\uDC30-\uDC3F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|\uDB40[\uDC01\uDC20-\uDC7F]/,S=/[!-#%-\*,-\/:;\?@\[-\]_\{\}\xA1\xA7\xAB\xB6\xB7\xBB\xBF\u037E\u0387\u055A-\u055F\u0589\u058A\u05BE\u05C0\u05C3\u05C6\u05F3\u05F4\u0609\u060A\u060C\u060D\u061B\u061D-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B\u169C\u16EB-\u16ED\u1735\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944\u1945\u1A1E\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B4E\u1B4F\u1B5A-\u1B60\u1B7D-\u1B7F\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D\u207E\u208D\u208E\u2308-\u230B\u2329\u232A\u2768-\u2775\u27C5\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC\u29FD\u2CF9-\u2CFC\u2CFE\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E\uA92F\uA95F\uA9C1-\uA9CD\uA9DE\uA9DF\uAA5C-\uAA5F\uAADE\uAADF\uAAF0\uAAF1\uABEB\uFD3E\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A\uFF1B\uFF1F\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65]|\uD800[\uDD00-\uDD02\uDF9F\uDFD0]|\uD801\uDD6F|\uD802[\uDC57\uDD1F\uDD3F\uDE50-\uDE58\uDE7F\uDEF0-\uDEF6\uDF39-\uDF3F\uDF99-\uDF9C]|\uD803[\uDD6E\uDEAD\uDED0\uDF55-\uDF59\uDF86-\uDF89]|\uD804[\uDC47-\uDC4D\uDCBB\uDCBC\uDCBE-\uDCC1\uDD40-\uDD43\uDD74\uDD75\uDDC5-\uDDC8\uDDCD\uDDDB\uDDDD-\uDDDF\uDE38-\uDE3D\uDEA9\uDFD4\uDFD5\uDFD7\uDFD8]|\uD805[\uDC4B-\uDC4F\uDC5A\uDC5B\uDC5D\uDCC6\uDDC1-\uDDD7\uDE41-\uDE43\uDE60-\uDE6C\uDEB9\uDF3C-\uDF3E]|\uD806[\uDC3B\uDD44-\uDD46\uDDE2\uDE3F-\uDE46\uDE9A-\uDE9C\uDE9E-\uDEA2\uDF00-\uDF09\uDFE1]|\uD807[\uDC41-\uDC45\uDC70\uDC71\uDEF7\uDEF8\uDF43-\uDF4F\uDFFF]|\uD809[\uDC70-\uDC74]|\uD80B[\uDFF1\uDFF2]|\uD81A[\uDE6E\uDE6F\uDEF5\uDF37-\uDF3B\uDF44]|\uD81B[\uDD6D-\uDD6F\uDE97-\uDE9A\uDFE2]|\uD82F\uDC9F|\uD836[\uDE87-\uDE8B]|\uD839\uDDFF|\uD83A[\uDD5E\uDD5F]/,ie=/[\$\+<->\^`\|~\xA2-\xA6\xA8\xA9\xAC\xAE-\xB1\xB4\xB8\xD7\xF7\u02C2-\u02C5\u02D2-\u02DF\u02E5-\u02EB\u02ED\u02EF-\u02FF\u0375\u0384\u0385\u03F6\u0482\u058D-\u058F\u0606-\u0608\u060B\u060E\u060F\u06DE\u06E9\u06FD\u06FE\u07F6\u07FE\u07FF\u0888\u09F2\u09F3\u09FA\u09FB\u0AF1\u0B70\u0BF3-\u0BFA\u0C7F\u0D4F\u0D79\u0E3F\u0F01-\u0F03\u0F13\u0F15-\u0F17\u0F1A-\u0F1F\u0F34\u0F36\u0F38\u0FBE-\u0FC5\u0FC7-\u0FCC\u0FCE\u0FCF\u0FD5-\u0FD8\u109E\u109F\u1390-\u1399\u166D\u17DB\u1940\u19DE-\u19FF\u1B61-\u1B6A\u1B74-\u1B7C\u1FBD\u1FBF-\u1FC1\u1FCD-\u1FCF\u1FDD-\u1FDF\u1FED-\u1FEF\u1FFD\u1FFE\u2044\u2052\u207A-\u207C\u208A-\u208C\u20A0-\u20C1\u2100\u2101\u2103-\u2106\u2108\u2109\u2114\u2116-\u2118\u211E-\u2123\u2125\u2127\u2129\u212E\u213A\u213B\u2140-\u2144\u214A-\u214D\u214F\u218A\u218B\u2190-\u2307\u230C-\u2328\u232B-\u2429\u2440-\u244A\u249C-\u24E9\u2500-\u2767\u2794-\u27C4\u27C7-\u27E5\u27F0-\u2982\u2999-\u29D7\u29DC-\u29FB\u29FE-\u2B73\u2B76-\u2BFF\u2CE5-\u2CEA\u2E50\u2E51\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u2FF0-\u2FFF\u3004\u3012\u3013\u3020\u3036\u3037\u303E\u303F\u309B\u309C\u3190\u3191\u3196-\u319F\u31C0-\u31E5\u31EF\u3200-\u321E\u322A-\u3247\u3250\u3260-\u327F\u328A-\u32B0\u32C0-\u33FF\u4DC0-\u4DFF\uA490-\uA4C6\uA700-\uA716\uA720\uA721\uA789\uA78A\uA828-\uA82B\uA836-\uA839\uAA77-\uAA79\uAB5B\uAB6A\uAB6B\uFB29\uFBB2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDCF\uFDFC-\uFDFF\uFE62\uFE64-\uFE66\uFE69\uFF04\uFF0B\uFF1C-\uFF1E\uFF3E\uFF40\uFF5C\uFF5E\uFFE0-\uFFE6\uFFE8-\uFFEE\uFFFC\uFFFD]|\uD800[\uDD37-\uDD3F\uDD79-\uDD89\uDD8C-\uDD8E\uDD90-\uDD9C\uDDA0\uDDD0-\uDDFC]|\uD802[\uDC77\uDC78\uDEC8]|\uD803[\uDD8E\uDD8F\uDED1-\uDED8]|\uD805\uDF3F|\uD807[\uDFD5-\uDFF1]|\uD81A[\uDF3C-\uDF3F\uDF45]|\uD82F\uDC9C|\uD833[\uDC00-\uDCEF\uDCFA-\uDCFC\uDD00-\uDEB3\uDEBA-\uDED0\uDEE0-\uDEF0\uDF50-\uDFC3]|\uD834[\uDC00-\uDCF5\uDD00-\uDD26\uDD29-\uDD64\uDD6A-\uDD6C\uDD83\uDD84\uDD8C-\uDDA9\uDDAE-\uDDEA\uDE00-\uDE41\uDE45\uDF00-\uDF56]|\uD835[\uDEC1\uDEDB\uDEFB\uDF15\uDF35\uDF4F\uDF6F\uDF89\uDFA9\uDFC3]|\uD836[\uDC00-\uDDFF\uDE37-\uDE3A\uDE6D-\uDE74\uDE76-\uDE83\uDE85\uDE86]|\uD838[\uDD4F\uDEFF]|\uD83B[\uDCAC\uDCB0\uDD2E\uDEF0\uDEF1]|\uD83C[\uDC00-\uDC2B\uDC30-\uDC93\uDCA0-\uDCAE\uDCB1-\uDCBF\uDCC1-\uDCCF\uDCD1-\uDCF5\uDD0D-\uDDAD\uDDE6-\uDE02\uDE10-\uDE3B\uDE40-\uDE48\uDE50\uDE51\uDE60-\uDE65\uDF00-\uDFFF]|\uD83D[\uDC00-\uDED8\uDEDC-\uDEEC\uDEF0-\uDEFC\uDF00-\uDFD9\uDFE0-\uDFEB\uDFF0]|\uD83E[\uDC00-\uDC0B\uDC10-\uDC47\uDC50-\uDC59\uDC60-\uDC87\uDC90-\uDCAD\uDCB0-\uDCBB\uDCC0\uDCC1\uDCD0-\uDCD8\uDD00-\uDE57\uDE60-\uDE6D\uDE70-\uDE7C\uDE80-\uDE8A\uDE8E-\uDEC6\uDEC8\uDECD-\uDEDC\uDEDF-\uDEEA\uDEEF-\uDEF8\uDF00-\uDF92\uDF94-\uDFEF\uDFFA]/,ae=/[ \xA0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/,oe=new Map([[0,65533],[128,8364],[130,8218],[131,402],[132,8222],[133,8230],[134,8224],[135,8225],[136,710],[137,8240],[138,352],[139,8249],[140,338],[142,381],[145,8216],[146,8217],[147,8220],[148,8221],[149,8226],[150,8211],[151,8212],[152,732],[153,8482],[154,353],[155,8250],[156,339],[158,382],[159,376]]);function se(e){var t;return e>=55296&&e<=57343||e>1114111?65533:(t=oe.get(e))==null?e:t}function ce(e){let t=atob(e),n=t.length&-2,r=new Uint16Array(n/2);for(let e=0,i=0;e<n;e+=2){let n=t.charCodeAt(e),a=t.charCodeAt(e+1);r[i++]=n|a<<8}return r}var le=ce(`QR08ALkAAgH6AYsDNQR2BO0EPgXZBQEGLAbdBxMISQrvCmQLfQurDKQNLw4fD4YPpA+6D/IPAAAAAAAAAAAAAAAAKhBMEY8TmxUWF2EYLBkxGuAa3RsJHDscWR8YIC8jSCSIJcMl6ie3Ku8rEC0CLjoupS7kLgAIRU1hYmNmZ2xtbm9wcnN0dVQAWgBeAGUAaQBzAHcAfgCBAIQAhwCSAJoAoACsALMAbABpAGcAO4DGAMZAUAA7gCYAJkBjAHUAdABlADuAwQDBQHIiZXZlAAJhAAFpeW0AcgByAGMAO4DCAMJAEGRyAADgNdgE3XIAYQB2AGUAO4DAAMBA8CFoYZFj4SFjcgBhZAAAoFMqAAFncIsAjgBvAG4ABGFmAADgNdg43fAlbHlGdW5jdGlvbgCgYSBpAG4AZwA7gMUAxUAAAWNzpACoAHIAAOA12Jzc6SFnbgCgVCJpAGwAZABlADuAwwDDQG0AbAA7gMQAxEAABGFjZWZvcnN1xQDYANoA7QDxAPYA+QD8AAABY3LJAM8AayNzbGFzaAAAoBYidgHTANUAAKDnKmUAZAAAoAYjeQARZIABY3J0AOAA5QDrAGEidXNlAACgNSLuI291bGxpcwCgLCFhAJJjcgAA4DXYBd1wAGYAAOA12Dnd5SF2ZdhiYwDyAOoAbSJwZXEAAKBOIgAHSE9hY2RlZmhpbG9yc3UXARoBHwE6AVIBVQFiAWQBZgGCAakB6QHtAfIBYwB5ACdkUABZADuAqQCpQIABY3B5ACUBKAE1AfUhdGUGYWmg0iJ0KGFsRGlmZmVyZW50aWFsRAAAoEUhbCJleXMAAKAtIQACYWVpb0EBRAFKAU0B8iFvbgxhZABpAGwAO4DHAMdAcgBjAAhhbiJpbnQAAKAwIm8AdAAKYQABZG5ZAV0BaSJsbGEAuGB0I2VyRG90ALdg8gA5AWkAp2NyImNsZQAAAkRNUFRwAXQBeQF9AW8AdAAAoJkiaSJudXMAAKCWIuwhdXMAoJUiaSJtZXMAAKCXIm8AAAFjc4cBlAFrKndpc2VDb250b3VySW50ZWdyYWwAAKAyImUjQ3VybHkAAAFEUZwBpAFvJXVibGVRdW90ZQAAoB0gdSJvdGUAAKAZIAACbG5wdbABtgHNAdgBbwBuAGWgNyIAoHQqgAFnaXQAvAHBAcUB8iJ1ZW50AKBhIm4AdAAAoC8i7yV1ckludGVncmFsAKAuIgABZnLRAdMBAKACIe8iZHVjdACgECJuLnRlckNsb2Nrd2lzZUNvbnRvdXJJbnRlZ3JhbAAAoDMi7yFzcwCgLypjAHIAAOA12J7ccABDoNMiYQBwAACgTSKABURKU1phY2VmaW9zAAsCEgIVAhgCGwIsAjQCOQI9AnMCfwNvoEUh9CJyYWhkAKARKWMAeQACZGMAeQAFZGMAeQAPZIABZ3JzACECJQIoAuchZXIAoCEgcgAAoKEhaAB2AACg5CoAAWF5MAIzAvIhb24OYRRkbAB0oAciYQCUY3IAAOA12AfdAAFhZkECawIAAWNtRQJnAvIjaXRpY2FsAAJBREdUUAJUAl8CYwJjInV0ZQC0YG8AdAFZAloC2WJiJGxlQWN1dGUA3WJyImF2ZQBgYGkibGRlANxi7yFuZACgxCJmJWVyZW50aWFsRAAAoEYhcAR9AgAAAAAAAIECjgIAABoDZgAA4DXYO91EoagAhQKJAm8AdAAAoNwgcSJ1YWwAAKBQIuIhbGUAA0NETFJVVpkCqAK1Au8C/wIRA28AbgB0AG8AdQByAEkAbgB0AGUAZwByAGEA7ADEAW8AdAKvAgAAAACwAqhgbiNBcnJvdwAAoNMhAAFlb7kC0AJmAHQAgAFBUlQAwQLGAs0CciJyb3cAAKDQIekkZ2h0QXJyb3cAoNQhZQDlACsCbgBnAAABTFLWAugC5SFmdAABQVLcAuECciJyb3cAAKD4J+kkZ2h0QXJyb3cAoPon6SRnaHRBcnJvdwCg+SdpImdodAAAAUFU9gL7AnIicm93AACg0iFlAGUAAKCoInAAQQIGAwAAAAALA3Iicm93AACg0SFvJHduQXJyb3cAAKDVIWUlcnRpY2FsQmFyAACgJSJuAAADQUJMUlRhJAM2AzoDWgNxA3oDciJyb3cAAKGTIUJVLAMwA2EAcgAAoBMpcCNBcnJvdwAAoPUhciJldmUAEWPlIWZ00gJDAwAASwMAAFIDaSVnaHRWZWN0b3IAAKBQKWUkZVZlY3RvcgAAoF4p5SJjdG9yQqC9IWEAcgAAoFYpaSJnaHQA1AFiAwAAaQNlJGVWZWN0b3IAAKBfKeUiY3RvckKgwSFhAHIAAKBXKWUAZQBBoKQiciJyb3cAAKCnIXIAcgBvAPcAtAIAAWN0gwOHA3IA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YwAAoN8i4SFycnCgtiEAoD0pgKIqImJjZG9zACsVMBU6FT4VQRVyImNhcAAAoEgqAAFhdTQVNxVwAACgRipwAACgSipvAHQAAKCNInIAAKBFKgDgKiIA/gACYWxydksVURVuFXMVcgByAG2gtyEAoDwpeQCAAWV2dwBYFWUVaRVxAHACXxUAAAAAYxVyAGUA4wAXFXUA4wAZFWUAZQAAoM4iZSJkZ2UAAKDPImUAbgA7gKQApEBlI2Fycm93AAABbHJ7FX8V5SFmdACgtiFpImdodAAAoLchZQDkAG0VAAFjaYsVkRVvAG4AaQBuAPQAkwFuAHQAAKAxImwiY3R5AACgLSOACUFIYWJjZGVmaGlqbG9yc3R1d3oAuBW7Fb8V1RXgFegV+RUKFhUWHxZUFlcWZRbFFtsW7xb7FgUXChdyAPIAtAJhAHIAAKBlKQACZ2xyc8YVyhXOFdAV5yFlcgCgICDlIXRoAKA4IfIA9QxoAHagECAAoKMiawHZFd4VYSJyb3cAAKAPKWEA4wBfAgABYXnkFecV8iFvbg9hNGQAoUYhYW/tFfQVAAFnciEC8RVyAACgyiF0InNlcQAAoHcqgAFnbG0A/xUCFgUWO4CwALBAdABhALRjcCJ0eXYAAKCxKQABaXIOFhIW8yFodACgfykA4DXYId1hAHIAAAFschsWHRYAoMMhAKDCIYACYWVnc3YAKBauAjYWOhY+Fm0AAKHEIm9zLhY0Fm4AZABzoMQi9SFpdACgZiZhIm1tYQDdY2kAbgAAoPIiAKH3AGlvQxZRFmQAZQAAgfcAO29KFksW90BuI3RpbWVzAACgxyJuAPgAUBZjAHkAUmRjAG8CXhYAAAAAYhZyAG4AAKAeI28AcAAAoA0jgAJscHR1dwBuFnEWdRaSFp4W7CFhciRgZgAA4DXYVd0AotkCZW1wc30WhBaJFo0WcQBkoFAibwB0AACgUSJpIm51cwAAoDgi7CF1cwCgFCLxInVhcmUAoKEiYgBsAGUAYgBhAHIAdwBlAGQAZwDlANcAbgCAAWFkaAClFqoWtBZyAHIAbwD3APUMbwB3AG4AYQByAHIAbwB3APMA8xVhI3Jwb29uAAABbHK8FsAWZQBmAPQAHBZpAGcAaAD0AB4WYgHJFs8WawBhAHIAbwD3AJILbwLUFgAAAADYFnIAbgAAoB8jbwBwAACgDCOAAWNvdADhFukW7BYAAXJ55RboFgDgNdi53FVkbAAAoPYp8iFvaxFhAAFkcvMW9xZvAHQAAKDxImkA5qC/JVsSAAFhaP8WAhdyAPIANQNhAPIA1wvhIm5nbGUAoKYpAAFjaQ4XEBd5AF9k5yJyYXJyAKD/JwAJRGFjZGVmZ2xtbm9wcXJzdHV4MRc4F0YXWxcyBF4XaRd5F40XrBe0F78X2RcVGCEYLRg1GEAYAAFEbzUXgRZvAPQA+BUAAWNzPBdCF3UAdABlADuA6QDpQPQhZXIAoG4qAAJhaW95TRdQF1YXWhfyIW9uG2FyAGOgViI7gOoA6kDsIW9uAKBVIk1kbwB0ABdhAAFEcmIXZhdvAHQAAKBSIgDgNdgi3XKhmipuF3QXYQB2AGUAO4DoAOhAZKCWKm8AdAAAoJgqgKGZKmlscwCAF4UXhxfuInRlcnMAoOcjAKATIWSglSpvAHQAAKCXKoABYXBzAJMXlheiF2MAcgATYXQAeQBzogUinxcAAAAAoRdlAHQAAKAFInAAMaADIDMBqRerFwCgBCAAoAUgAAFnc7AXsRdLYXAAAKACIAABZ3C4F7sXbwBuABlhZgAA4DXYVt2AAWFscwDFF8sXzxdyAHOg1SJsAACg4yl1AHMAAKBxKmkAAKG1A2x21RfYF28AbgC1Y/VjAAJjc3V24BfoF/0XEBgAAWlv5BdWF3IAYwAAoFYiaQLuFwAAAADwF+0ADQThIW50AAFnbPUX+Rd0AHIAAKCWKuUhc3MAoJUqgAFhZWkAAxgGGAoYbABzAD1gcwB0AACgXyJ2AESgYSJEAACgeCrwImFyc2wAoOUpAAFEYRkYHRhvAHQAAKBTInIAcgAAoHEpgAFjZGkAJxgqGO0XcgAAoC8hbwD0AIwCAAFhaDEYMhi3YzuA8ADwQAABbXI5GD0YbAA7gOsA60BvAACgrCCAAWNpcABGGEgYSxhsACFgcwD0ACwEAAFlb08YVxhjAHQAYQB0AGkAbwDuABoEbgBlAG4AdABpAGEAbADlADME4Ql1GAAAgRgAAIMYiBgAAAAAoRilGAAAqhgAALsYvhjRGAAA1xgnGWwAbABpAG4AZwBkAG8AdABzAGUA8QBlF3kARGRtImFsZQAAoEAmgAFpbHIAjRiRGJ0Y7CFpZwCgA/tpApcYAAAAAJoYZwAAoAD7aQBnAACgBPsA4DXYI93sIWlnAKAB++whaWcA4GYAagCAAWFsdACvGLIYthh0AACgbSZpAGcAAKAC+24AcwAAoLElbwBmAJJh8AHCGAAAxhhmAADgNdhX3QABYWvJGMwYbADsAGsEdqDUIgCg2SphI3J0aW50AACgDSoAAWFv2hgiGQABY3PeGB8ZsQPnGP0YBRkSGRUZAAAdGbID7xjyGPQY9xj5GAAA+xg7gL0AvUAAoFMhO4C8ALxAAKBVIQCgWSEAoFshswEBGQAAAxkAoFQhAKBWIbQCCxkOGQAAAAAQGTuAvgC+QACgVyEAoFwhNQAAoFghtgEZGQAAGxkAoFohAKBdITgAAKBeIWwAAKBEIHcAbgAAoCIjYwByAADgNdi73IAIRWFiY2RlZmdpamxub3JzdHYARhlKGVoZXhlmGWkZkhmWGZkZnRmgGa0ZxhnLGc8Z4BkjGmygZyIAoIwqgAFjbXAAUBlTGVgZ9SF0ZfVhbQBhAOSgswM6FgCghipyImV2ZQAfYQABaXliGWUZcgBjAB1hM2RvAHQAIWGAoWUibHFzAMYEcBl6GfGhZSLOBAAAdhlsAGEAbgD0AN8EgKF+KmNkbACBGYQZjBljAACgqSpvAHQAb6CAKmyggioAoIQqZeDbIgD+cwAAoJQqcgAA4DXYJN3noGsirATtIWVsAKA3IWMAeQBTZIChdyJFYWoApxmpGasZAKCSKgCgpSoAoKQqAAJFYWVztBm2Gb0ZwhkAoGkicABwoIoq8iFveACgiipxoIgq8aCIKrUZaQBtAACg5yJwAGYAAOA12FjdYQB2AOUAYwIAAWNp0xnWGXIAAKAKIW0AAKFzImVs3BneGQCgjioAoJAqAIM+ADtjZGxxco0E6xn0GfgZ/BkBGgABY2nvGfEZAKCnKnIAAKB6Km8AdAAAoNci0CFhcgCglSl1ImVzdAAAoHwqgAJhZGVscwAKGvQZFhrVBCAa8AEPGgAAFBpwAHIAbwD4AFkZcgAAoHgpcQAAAWxxxAQbGmwAZQBzAPMASRlpAO0A5AQAAWVuJxouGnIjdG5lcXEAAOBpIgD+xQAsGgAFQWFiY2Vma29zeUAaQxpmGmoabRqDGocalhrCGtMacgDyAMwCAAJpbG1yShpOGlAaVBpyAHMA8ABxD2YAvWBpAGwA9AASBQABZHJYGlsaYwB5AEpkAKGUIWN3YBpkGmkAcgAAoEgpAKCtIWEAcgAAoA8h6SFyYyVhgAFhbHIAcxp7Gn8a8iF0c3WgZSZpAHQAAKBlJuwhaXAAoCYg4yFvbgCguSJyAADgNdgl3XMAAAFld4wakRphInJvdwAAoCUpYSJyb3cAAKAmKYACYW1vcHIAnxqjGqcauhq+GnIAcgAAoP8h9CFodACgOyJrAAABbHKsGrMaZSRmdGFycm93AACgqSHpJGdodGFycm93AKCqIWYAAOA12Fnd4iFhcgCgFSCAAWNsdADIGswa0BpyAADgNdi93GEAcwDoAGka8iFvaydhAAFicNca2xr1IWxsAKBDIOghZW4AoBAg4Qr2GgAA/RoAAAgbExsaGwAAIRs7GwAAAAA+G2IbmRuVG6sbAACyG80b0htjAHUAdABlADuA7QDtQAChYyBpeQEbBhtyAGMAO4DuAO5AOGQAAWN4CxsNG3kANWRjAGwAO4ChAKFAAAFmcssCFhsA4DXYJt1yAGEAdgBlADuA7ADsQIChSCFpbm8AJxsyGzYbAAFpbisbLxtuAHQAAKAMKnQAAKAtIuYhaW4AoNwpdABhAACgKSHsIWlnM2GAAWFvcABDG1sbXhuAAWNndABJG0sbWRtyACthgAFlbHAAcQVRG1UbaQBuAOUAyAVhAHIA9AByBWgAMWFmAACgtyJlAGQAtWEAoggiY2ZvdGkbbRt1G3kb4SFyZQCgBSFpAG4AdKAeImkAZQAAoN0pZABvAPQAWxsAoisiY2VscIEbhRuPG5QbYQBsAACguiIAAWdyiRuNG2UAcgDzACMQ4wCCG2EicmhrAACgFyryIW9kAKA8KgACY2dwdJ8boRukG6gbeQBRZG8AbgAvYWYAAOA12FrdYQC5Y3UAZQBzAHQAO4C/AL9AAAFjabUbuRtyAADgNdi+3G4AAKIIIkVkc3bCG8QbyBvQAwCg+SJvAHQAAKD1Inag9CIAoPMiaaBiIOwhZGUpYesB1hsAANkbYwB5AFZkbAA7gO8A70AAA2NmbW9zdeYb7hvyG/Ub+hsFHAABaXnqG+0bcgBjADVhOWRyAADgNdgn3eEhdGg3YnAAZgAA4DXYW93jAf8bAAADHHIAAOA12L/c8iFjeVhk6yFjeVRkAARhY2ZnaGpvcxUcGhwiHCYcKhwtHDAcNRzwIXBhdqC6A/BjAAFleR4cIRzkIWls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ZmdobG1vcHJzdHV3CiwNLBEsHSwnLDEsQCxLLFIsYix6LIQsjyzLLOgs7Sz/LAotcgDyAAkDYQByAACgYykAAWNyFSwbLHUAdABlADuA+gD6QPIACQ1yAOMBIywAACUseQBeZHYAZQBtYQABaXkrLDAscgBjADuA+wD7QENkgAFhYmgANyw6LD0scgDyANEO7CFhY3FhYQDyAOAOAAFpckQsSCzzIWh0AKB+KQDgNdgy3XIAYQB2AGUAO4D5APlAYQFWLF8scgAAAWxyWixcLACgvyEAoL4hbABrAACggCUAAWN0Zix2LG8CbCwAAAAAcyxyAG4AZaAcI3IAAKAcI28AcAAAoA8jcgBpAACg+CUAAWFsfiyBLGMAcgBrYTuAqACoQAABZ3CILIssbwBuAHNhZgAA4DXYZt0AA2FkaGxzdZksniynLLgsuyzFLHIAcgBvAPcACQ1vAHcAbgBhAHIAcgBvAPcA2A5hI3Jwb29uAAABbHKvLLMsZQBmAPQAWyxpAGcAaAD0AF0sdQDzAKYOaQAAocUDaGzBLMIs0mNvAG4AxWPwI2Fycm93cwCgyCGAAWNpdADRLOEs5CxvAtcsAAAAAN4scgBuAGWgHSNyAACgHSNvAHAAAKAOI24AZwBvYXIAaQAAoPklYwByAADgNdjK3IABZGlyAPMs9yz6LG8AdAAAoPAi7CFkZWlhaQBmoLUlAKC0JQABYW0DLQYtcgDyAMosbAA7gPwA/EDhIm5nbGUAoKcpgAdBQkRhY2RlZmxub3Byc3oAJy0qLTAtNC2bLZ0toS2/LcMtxy3TLdgt3C3gLfwtcgDyABADYQByAHag6CoAoOkqYQBzAOgA/gIAAW5yOC08LechcnQAoJwpgANla25wcnN0AJkpSC1NLVQtXi1iLYItYQBwAHAA4QAaHG8AdABoAGkAbgDnAKEXgAFoaXIAoSmzJFotbwBwAPQAdCVooJUh7wD4JgABaXVmLWotZwBtAOEAuygAAWJwbi14LXMjZXRuZXEAceCKIgD+AODLKgD+cyNldG5lcQBx4IsiAP4A4MwqAP4AAWhyhi2KLWUAdADhABIraSNhbmdsZQAAAWxyki2WLeUhZnQAoLIiaSJnaHQAAKCzInkAMmThIXNoAKCiIoABZWxyAKcttC24LWKiKCKuLQAAAACyLWEAcgAAoLsicQAAoFoi7CFpcACg7iIAAWJ0vC1eD2EA8gBfD3IAAOA12DPddAByAOkAlS1zAHUAAAFicM0t0C0A4IIi0iAA4IMi0iBwAGYAAOA12GfdcgBvAPAAWQt0AHIA6QCaLQABY3XkLegtcgAA4DXYy9wAAWJw7C30LW4AAAFFZXUt8S0A4IoiAP5uAAABRWV/LfktAOCLIgD+6SJnemFnAKCaKYADY2Vmb3BycwANLhAuJS4pLiMuLi40LukhcmN1YQABZGkULiEuAAFiZxguHC5hAHIAAKBfKmUAcaAnIgCgWSLlIXJwAKAYIXIAAOA12DTdcABmAADgNdho3WWgQCJhAHQA6ABqD2MAcgAA4DXYzNzjCuQRUC4AAFQuAABYLmIuAAAAAGMubS5wLnQuAAAAAIguki4AAJouJxIqEnQAcgDpAB0ScgAA4DXYNd0AAUFhWy5eLnIA8gDnAnIA8gCTB75jAAFBYWYuaS5yAPIA4AJyAPIAjAdhAPAAeh5pAHMAAKD7IoABZHB0APgReS6DLgABZmx9LoAuAOA12GnddQDzAP8RaQBtAOUABBIAAUFhiy6OLnIA8gDuAnIA8gCaBwABY3GVLgoScgAA4DXYzdwAAXB0nS6hLmwAdQDzACUScgDpACASAARhY2VmaW9zdbEuvC7ELsguzC7PLtQu2S5jAAABdXm2LrsudABlADuA/QD9QE9kAAFpecAuwy5yAGMAd2FLZG4AO4ClAKVAcgAA4DXYNt1jAHkAV2RwAGYAAOA12GrdYwByAADgNdjO3AABY23dLt8ueQBOZGwAO4D/AP9AAAVhY2RlZmhpb3N38y73Lv8uAi8MLxAvEy8YLx0vIi9jInV0ZQB6YQABYXn7Lv4u8iFvbn5hN2RvAHQAfGEAAWV0Bi8KL3QAcgDmAB8QYQC2Y3IAAOA12DfdYwB5ADZk5yJyYXJyAKDdIXAAZgAA4DXYa91jAHIAAOA12M/cAAFqbiYvKC8AoA0gagAAoAwg`),C;(function(e){e[e.VALUE_LENGTH=49152]=`VALUE_LENGTH`,e[e.FLAG13=8192]=`FLAG13`,e[e.BRANCH_LENGTH=8064]=`BRANCH_LENGTH`,e[e.JUMP_TABLE=127]=`JUMP_TABLE`})(C||(C={}));function w(e){"@babel/helpers - typeof";return w=typeof Symbol==`function`&&typeof Symbol.iterator==`symbol`?function(e){return typeof e}:function(e){return e&&typeof Symbol==`function`&&e.constructor===Symbol&&e!==Symbol.prototype?`symbol`:typeof e},w(e)}function ue(e,t){if(w(e)!=`object`||!e)return e;var n=e[Symbol.toPrimitive];if(n!==void 0){var r=n.call(e,t||`default`);if(w(r)!=`object`)return r;throw TypeError(`@@toPrimitive must return a primitive value.`)}return(t===`string`?String:Number)(e)}function de(e){var t=ue(e,`string`);return w(t)==`symbol`?t:t+``}function T(e,t,n){return(t=de(t))in e?Object.defineProperty(e,t,{value:n,enumerable:!0,configurable:!0,writable:!0}):e[t]=n,e}var E;(function(e){e[e.NUM=35]=`NUM`,e[e.SEMI=59]=`SEMI`,e[e.EQUALS=61]=`EQUALS`,e[e.ZERO=48]=`ZERO`,e[e.NINE=57]=`NINE`,e[e.LOWER_A=97]=`LOWER_A`,e[e.LOWER_F=102]=`LOWER_F`,e[e.LOWER_X=120]=`LOWER_X`,e[e.LOWER_Z=122]=`LOWER_Z`,e[e.UPPER_A=65]=`UPPER_A`,e[e.UPPER_F=70]=`UPPER_F`,e[e.UPPER_Z=90]=`UPPER_Z`})(E||(E={}));var fe=32;function D(e){return e>=E.ZERO&&e<=E.NINE}function pe(e){return e>=E.UPPER_A&&e<=E.UPPER_F||e>=E.LOWER_A&&e<=E.LOWER_F}function me(e){return e>=E.UPPER_A&&e<=E.UPPER_Z||e>=E.LOWER_A&&e<=E.LOWER_Z||D(e)}function he(e){return e===E.EQUALS||me(e)}var O;(function(e){e[e.EntityStart=0]=`EntityStart`,e[e.NumericStart=1]=`NumericStart`,e[e.NumericDecimal=2]=`NumericDecimal`,e[e.NumericHex=3]=`NumericHex`,e[e.NamedEntity=4]=`NamedEntity`})(O||(O={}));var k;(function(e){e[e.Legacy=0]=`Legacy`,e[e.Strict=1]=`Strict`,e[e.Attribute=2]=`Attribute`})(k||(k={}));var ge=class{constructor(e,t,n){T(this,`decodeTree`,void 0),T(this,`emitCodePoint`,void 0),T(this,`errors`,void 0),T(this,`state`,O.EntityStart),T(this,`consumed`,1),T(this,`result`,0),T(this,`treeIndex`,0),T(this,`excess`,1),T(this,`decodeMode`,k.Strict),T(this,`runConsumed`,0),this.decodeTree=e,this.emitCodePoint=t,this.errors=n}startEntity(e){this.decodeMode=e,this.state=O.EntityStart,this.result=0,this.treeIndex=0,this.excess=1,this.consumed=1,this.runConsumed=0}write(e,t){switch(this.state){case O.EntityStart:return e.charCodeAt(t)===E.NUM?(this.state=O.NumericStart,this.consumed+=1,this.stateNumericStart(e,t+1)):(this.state=O.NamedEntity,this.stateNamedEntity(e,t));case O.NumericStart:return this.stateNumericStart(e,t);case O.NumericDecimal:return this.stateNumericDecimal(e,t);case O.NumericHex:return this.stateNumericHex(e,t);case O.NamedEntity:return this.stateNamedEntity(e,t)}}stateNumericStart(e,t){return t>=e.length?-1:(e.charCodeAt(t)|fe)===E.LOWER_X?(this.state=O.NumericHex,this.consumed+=1,this.stateNumericHex(e,t+1)):(this.state=O.NumericDecimal,this.stateNumericDecimal(e,t))}stateNumericHex(e,t){for(;t<e.length;){let n=e.charCodeAt(t);if(D(n)||pe(n)){let e=n<=E.NINE?n-E.ZERO:(n|fe)-E.LOWER_A+10;this.result=this.result*16+e,this.consumed++,t++}else return this.emitNumericEntity(n,3)}return-1}stateNumericDecimal(e,t){for(;t<e.length;){let n=e.charCodeAt(t);if(D(n))this.result=this.result*10+(n-E.ZERO),this.consumed++,t++;else return this.emitNumericEntity(n,2)}return-1}emitNumericEntity(e,t){if(this.consumed<=t){var n;return(n=this.errors)==null||n.absenceOfDigitsInNumericCharacterReference(this.consumed),0}if(e===E.SEMI)this.consumed+=1;else if(this.decodeMode===k.Strict)return 0;return this.emitCodePoint(se(this.result),this.consumed),this.errors&&(e!==E.SEMI&&this.errors.missingSemicolonAfterCharacterReference(),this.errors.validateNumericCharacterReference(this.result)),this.consumed}stateNamedEntity(e,t){let{decodeTree:n}=this,r=n[this.treeIndex],i=(r&C.VALUE_LENGTH)>>14;for(;t<e.length;){if(i===0&&(r&C.FLAG13)!==0){let a=(r&C.BRANCH_LENGTH)>>7;if(this.runConsumed===0){let n=r&C.JUMP_TABLE;if(e.charCodeAt(t)!==n)return this.result===0?0:this.emitNotTerminatedNamedEntity();t++,this.excess++,this.runConsumed++}for(;this.runConsumed<a;){if(t>=e.length)return-1;let r=this.runConsumed-1,i=n[this.treeIndex+1+(r>>1)],a=r%2==0?i&255:i>>8&255;if(e.charCodeAt(t)!==a)return this.runConsumed=0,this.result===0?0:this.emitNotTerminatedNamedEntity();t++,this.excess++,this.runConsumed++}this.runConsumed=0,this.treeIndex+=1+(a>>1),r=n[this.treeIndex],i=(r&C.VALUE_LENGTH)>>14}if(t>=e.length)break;let a=e.charCodeAt(t);if(a===E.SEMI&&i!==0&&(r&C.FLAG13)!==0)return this.emitNamedEntityData(this.treeIndex,i,this.consumed+this.excess);if(this.treeIndex=ve(n,r,this.treeIndex+Math.max(1,i),a),this.treeIndex<0)return this.result===0||this.decodeMode===k.Attribute&&(i===0||he(a))?0:this.emitNotTerminatedNamedEntity();if(r=n[this.treeIndex],i=(r&C.VALUE_LENGTH)>>14,i!==0){if(a===E.SEMI)return this.emitNamedEntityData(this.treeIndex,i,this.consumed+this.excess);this.decodeMode!==k.Strict&&(r&C.FLAG13)===0&&(this.result=this.treeIndex,this.consumed+=this.excess,this.excess=0)}t++,this.excess++}return-1}emitNotTerminatedNamedEntity(){var e;let{result:t,decodeTree:n}=this,r=(n[t]&C.VALUE_LENGTH)>>14;return this.emitNamedEntityData(t,r,this.consumed),(e=this.errors)==null||e.missingSemicolonAfterCharacterReference(),this.consumed}emitNamedEntityData(e,t,n){let{decodeTree:r}=this;return this.emitCodePoint(t===1?r[e]&~(C.VALUE_LENGTH|C.FLAG13):r[e+1],n),t===3&&this.emitCodePoint(r[e+2],n),n}end(){switch(this.state){case O.NamedEntity:return this.result!==0&&(this.decodeMode!==k.Attribute||this.result===this.treeIndex)?this.emitNotTerminatedNamedEntity():0;case O.NumericDecimal:return this.emitNumericEntity(0,2);case O.NumericHex:return this.emitNumericEntity(0,3);case O.NumericStart:var e;return(e=this.errors)==null||e.absenceOfDigitsInNumericCharacterReference(this.consumed),0;case O.EntityStart:return 0}}};function _e(e){let t=``,n=new ge(e,e=>t+=String.fromCodePoint(e));return function(e,r){let i=0,a=0;for(;(a=e.indexOf(`&`,a))>=0;){t+=e.slice(i,a),n.startEntity(r);let o=n.write(e,a+1);if(o<0){i=a+n.end();break}i=a+o,a=o===0?i+1:i}let o=t+e.slice(i);return t=``,o}}function ve(e,t,n,r){let i=(t&C.BRANCH_LENGTH)>>7,a=t&C.JUMP_TABLE;if(i===0)return a!==0&&r===a?n:-1;if(a){let t=r-a;return t<0||t>=i?-1:e[n+t]-1}let o=i+1>>1,s=0,c=i-1;for(;s<=c;){let t=s+c>>>1,i=e[n+(t>>1)]>>(t&1)*8&255;if(i<r)s=t+1;else if(i>r)c=t-1;else return e[n+o+t]}return-1}var ye=_e(le);function be(e){return ye(e,k.Strict)}var xe=t({arrayReplaceAt:()=>Ce,asciiTrim:()=>R,callable:()=>Se,escapeHtml:()=>M,escapeRE:()=>Fe,fromCodePoint:()=>A,isMdAsciiPunct:()=>I,isPunctChar:()=>Ie,isPunctCharCode:()=>F,isSpace:()=>N,isValidEntityCode:()=>we,isWhiteSpace:()=>P,lib:()=>Re,normalizeReference:()=>L,unescapeAll:()=>j,unescapeMd:()=>ke});function Se(e){let t=function(...n){return Reflect.construct(e,n,new.target&&new.target!==t?new.target:e)};return Object.defineProperty(t,"name",{value:e.name}),Object.setPrototypeOf(t,e),t.prototype=e.prototype,t}function Ce(e,t,n){return[].concat(e.slice(0,t),n,e.slice(t+1))}function we(e){return!(e>=55296&&e<=57343||e>=64976&&e<=65007||(e&65535)==65535||(e&65535)==65534||e>=0&&e<=8||e===11||e>=14&&e<=31||e>=127&&e<=159||e>1114111)}function A(e){if(e>65535){e-=65536;let t=55296+(e>>10),n=56320+(e&1023);return String.fromCharCode(t,n)}return String.fromCharCode(e)}var Te=/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g,Ee=RegExp(`${Te.source}|&([a-z#][a-z0-9]{1,31});`,`gi`),De=/^#((?:x[a-f0-9]{1,8}|[0-9]{1,8}))$/i;function Oe(e,t){if(t.charCodeAt(0)===35&&De.test(t)){let n=t[1].toLowerCase()===`x`?parseInt(t.slice(2),16):parseInt(t.slice(1),10);return we(n)?A(n):e}let n=be(e);return n===e?e:n}function ke(e){return e.indexOf(`\\`)<0?e:e.replace(Te,`$1`)}function j(e){return e.indexOf(`\\`)<0&&e.indexOf(`&`)<0?e:e.replace(Ee,function(e,t,n){return t||Oe(e,n)})}var Ae=/[&<>"]/,je=/[&<>"]/g,Me={"&":`&amp;`,"<":`&lt;`,">":`&gt;`,'"':`&quot;`};function Ne(e){return Me[e]}function M(e){return Ae.test(e)?e.replace(je,Ne):e}var Pe=/[.?*+^$[\]\\(){}|-]/g;function Fe(e){return e.replace(Pe,`\\$&`)}function N(e){switch(e){case 9:case 32:return!0}return!1}function P(e){if(e>=8192&&e<=8202)return!0;switch(e){case 9:case 10:case 11:case 12:case 13:case 32:case 160:case 5760:case 8239:case 8287:case 12288:return!0}return!1}function Ie(e){return S.test(e)||ie.test(e)}function F(e){return Ie(A(e))}function I(e){switch(e){case 33:case 34:case 35:case 36:case 37:case 38:case 39:case 40:case 41:case 42:case 43:case 44:case 45:case 46:case 47:case 58:case 59:case 60:case 61:case 62:case 63:case 64:case 91:case 92:case 93:case 94:case 95:case 96:case 123:case 124:case 125:case 126:return!0;default:return!1}}function L(e){return e=e.trim().replace(/\s+/g,` `),e.toLowerCase().toUpperCase()}function Le(e){return e===32||e===9||e===10||e===13}function R(e){let t=0;for(;t<e.length&&Le(e.charCodeAt(t));t++);let n=e.length-1;for(;n>=t&&Le(e.charCodeAt(n));n--);return e.slice(t,n+1)}var Re={mdurl:ee,ucmicro:te};function ze(e,t,n){let r,i,a,o,s=e.posMax,c=e.pos;for(e.pos=t+1,r=1;e.pos<s;){if(a=e.src.charCodeAt(e.pos),a===93&&(r--,r===0)){i=!0;break}if(o=e.pos,e.md.inline.skipToken(e),a===91){if(o===e.pos-1)r++;else if(n)return e.pos=c,-1}}let l=-1;return i&&(l=e.pos),e.pos=c,l}function Be(e,t,n){let r,i=t,a={ok:!1,pos:0,str:``};if(e.charCodeAt(i)===60){for(i++;i<n;){if(r=e.charCodeAt(i),r===10||r===60)return a;if(r===62)return a.pos=i+1,a.str=j(e.slice(t+1,i)),a.ok=!0,a;if(r===92&&i+1<n){i+=2;continue}i++}return a}let o=0;for(;i<n&&(r=e.charCodeAt(i),!(r===32||r<32||r===127));){if(r===92&&i+1<n){if(e.charCodeAt(i+1)===32){i++;continue}i+=2;continue}if(r===40&&(o++,o>32))return a;if(r===41){if(o===0)break;o--}i++}return t===i||o!==0?a:(a.str=j(e.slice(t,i)),a.pos=i,a.ok=!0,a)}function Ve(e,t,n,r){let i,a=t,o={ok:!1,can_continue:!1,pos:0,str:``,marker:0};if(r)o.str=r.str,o.marker=r.marker;else{if(a>=n)return o;let r=e.charCodeAt(a);if(r!==34&&r!==39&&r!==40)return o;t++,a++,r===40&&(r=41),o.marker=r}for(;a<n;){if(i=e.charCodeAt(a),i===o.marker)return o.pos=a+1,o.str+=j(e.slice(t,a)),o.ok=!0,o;if(i===40&&o.marker===41)return o;i===92&&a+1<n&&a++,a++}return o.can_continue=!0,o.str+=j(e.slice(t,a)),o}var He=t({parseLinkDestination:()=>Be,parseLinkLabel:()=>ze,parseLinkTitle:()=>Ve}),z=class{constructor(e,t,n){T(this,`map`,null),T(this,`level`,0),T(this,`children`,null),T(this,`content`,``),T(this,`markup`,``),T(this,`info`,``),T(this,`block`,!1),T(this,`hidden`,!1),this.type=e,this.tag=t,this.attrs=null,this.nesting=n,this.meta=null}attrIndex(e){if(!this.attrs)return-1;let t=this.attrs;for(let n=0,r=t.length;n<r;n++)if(t[n][0]===e)return n;return-1}attrPush(e){this.attrs?this.attrs.push(e):this.attrs=[e]}attrSet(e,t){let n=this.attrIndex(e),r=[e,t];n<0?this.attrPush(r):this.attrs[n]=r}attrGet(e){let t=this.attrIndex(e),n=null;return t>=0&&(n=this.attrs[t][1]),n}attrJoin(e,t){let n=this.attrIndex(e);n<0?this.attrPush([e,t]):this.attrs[n][1]=`${this.attrs[n][1]} ${t}`}},B=class{constructor(){T(this,`__rules__`,[]),T(this,`__cache__`,null)}__find__(e){for(let t=0;t<this.__rules__.length;t++)if(this.__rules__[t].name===e)return t;return-1}__compile__(){let e=new Set;this.__rules__.forEach(t=>{t.enabled&&t.alt.forEach(t=>{t&&e.add(t)})}),this.__cache__=Object.create(null),this.__cache__[``]=[],this.__rules__.forEach(e=>{e.enabled&&this.__cache__[``].push(e.fn)}),e.forEach(e=>{this.__cache__[e]=[],this.__rules__.forEach(t=>{t.enabled&&t.alt.indexOf(e)>=0&&this.__cache__[e].push(t.fn)})})}at(e,t,n={}){let r=this.__find__(e);if(r===-1)throw Error(`Parser rule not found: ${e}`);this.__rules__[r].fn=t,this.__rules__[r].alt=n.alt||[],this.__cache__=null}before(e,t,n,r={}){let i=this.__find__(e);if(i===-1)throw Error(`Parser rule not found: ${e}`);this.__rules__.splice(i,0,{name:t,enabled:!0,fn:n,alt:r.alt||[]}),this.__cache__=null}after(e,t,n,r={}){let i=this.__find__(e);if(i===-1)throw Error(`Parser rule not found: ${e}`);this.__rules__.splice(i+1,0,{name:t,enabled:!0,fn:n,alt:r.alt||[]}),this.__cache__=null}push(e,t,n={}){this.__rules__.push({name:e,enabled:!0,fn:t,alt:n.alt||[]}),this.__cache__=null}enable(e,t=!1){Array.isArray(e)||(e=[e]);let n=[];return e.forEach(e=>{let r=this.__find__(e);if(r<0){if(t)return;throw Error(`Rules manager: invalid rule name ${e}`)}this.__rules__[r].enabled=!0,n.push(e)}),this.__cache__=null,n}enableOnly(e,t=!1){Array.isArray(e)||(e=[e]),this.__rules__.forEach(e=>{e.enabled=!1}),this.enable(e,t)}disable(e,t=!1){Array.isArray(e)||(e=[e]);let n=[];return e.forEach(e=>{let r=this.__find__(e);if(r<0){if(t)return;throw Error(`Rules manager: invalid rule name ${e}`)}this.__rules__[r].enabled=!1,n.push(e)}),this.__cache__=null,n}getRules(e){return this.__cache__||this.__compile__(),this.__cache__[e]||[]}},V={};V.code_inline=function(e,t,n,r,i){let a=e[t];return`<code${i.renderAttrs(a)}>${M(a.content)}</code>`},V.code_block=function(e,t,n,r,i){let a=e[t];return`<pre${i.renderAttrs(a)}><code>${M(e[t].content)}</code></pre>\n`},V.fence=function(e,t,n,r,i){let a=e[t],o=a.info?j(a.info).trim():``,s=``,c=``;if(o){let e=o.split(/(\s+)/g);s=e[0],c=e.slice(2).join(``)}let l;if(l=n.highlight&&n.highlight(a.content,s,c)||M(a.content),l.indexOf(`<pre`)===0)return l+`
`;if(o){let e=a.attrIndex(`class`),t=a.attrs?a.attrs.slice():[];e<0?t.push([`class`,`${n.langPrefix}${s}`]):(t[e]=[t[e][0],t[e][1]],t[e][1]+=` ${n.langPrefix}${s}`);let r={attrs:t};return`<pre><code${i.renderAttrs(r)}>${l}</code></pre>\n`}return`<pre><code${i.renderAttrs(a)}>${l}</code></pre>\n`},V.image=function(e,t,n,r,i){let a=e[t];return a.attrs[a.attrIndex(`alt`)][1]=i.renderInlineAsText(a.children,n,r),i.renderToken(e,t,n)},V.hardbreak=function(e,t,n){return n.xhtmlOut?`<br />
`:`<br>
`},V.softbreak=function(e,t,n){return n.breaks?n.xhtmlOut?`<br />
`:`<br>
`:`
`},V.text=function(e,t){return M(e[t].content)},V.html_block=function(e,t){return e[t].content},V.html_inline=function(e,t){return e[t].content};var Ue=class{constructor(){T(this,`rules`,Object.assign({},V))}renderAttrs(e){let t,n,r;if(!e.attrs)return``;for(r=``,t=0,n=e.attrs.length;t<n;t++)r+=` ${M(e.attrs[t][0])}="${M(String(e.attrs[t][1]))}"`;return r}renderToken(e,t,n){let r=e[t],i=``;if(r.hidden)return``;let a=t-1;for(;a>=0&&e[a].hidden&&e[a].nesting===0;)a--;r.block&&r.nesting!==-1&&a>=0&&e[a].hidden&&e[a].nesting===-1&&(i+=`
`),i+=(r.nesting===-1?`</`:`<`)+r.tag,i+=this.renderAttrs(r),r.nesting===0&&n.xhtmlOut&&(i+=` /`);let o=!1;if(r.block&&(o=!0,r.nesting===1)){let n=t+1;for(;n<e.length&&e[n].hidden&&e[n].nesting===0;)n++;if(n<e.length){let t=e[n];(t.type===`inline`||t.hidden||t.nesting===-1&&t.tag===r.tag)&&(o=!1)}}return i+=o?`>
`:`>`,i}renderInline(e,t,n){let r=``,i=this.rules;for(let a=0,o=e.length;a<o;a++){let o=e[a].type;i[o]===void 0?r+=this.renderToken(e,a,t):r+=i[o](e,a,t,n,this)}return r}renderInlineAsText(e,t,n){let r=``;for(let i=0,a=e.length;i<a;i++)switch(e[i].type){case`text`:case`code_inline`:r+=e[i].content;break;case`image`:r+=this.renderInlineAsText(e[i].children,t,n);break;case`html_inline`:case`html_block`:r+=e[i].content;break;case`softbreak`:case`hardbreak`:r+=`
`}return r}render(e,t,n){let r=``,i=this.rules;for(let a=0,o=e.length;a<o;a++){let o=e[a].type;o===`inline`?r+=this.renderInline(e[a].children,t,n):i[o]===void 0?r+=this.renderToken(e,a,t):r+=i[o](e,a,t,n,this)}return r}},We=class{constructor(e,t,n){T(this,`tokens`,[]),T(this,`inlineMode`,!1),T(this,`Token`,z),this.src=e,this.env=n,this.md=t}},Ge=/\r\n?|\n/g,Ke=/\0/g;function qe(e){let t;t=e.src.replace(Ge,`
`),t=t.replace(Ke,`�`),e.src=t}function Je(e){let t;e.inlineMode?(t=new e.Token(`inline`,``,0),t.content=e.src,t.map=[0,1],t.children=[],e.tokens.push(t)):e.md.block.parse(e.src,e.md,e.env,e.tokens)}function Ye(e){let t=e.tokens,n=0;for(let e=0;e<t.length;e++)t[e].type!==`reference_definition`&&(e!==n&&(t[n]=t[e]),n++);t.length!==n&&(t.length=n)}function Xe(e){let t=e.tokens;for(let n=0,r=t.length;n<r;n++){let r=t[n];r.type===`inline`&&e.md.inline.parse(r.content,e.md,e.env,r.children)}}function Ze(e){return/^<a[>\s]/i.test(e)}function Qe(e){return/^<\/a\s*>/i.test(e)}function $e(e){let t=e.tokens;if(e.md.options.linkify)for(let n=0,r=t.length;n<r;n++){if(t[n].type!==`inline`||!e.md.linkify.test(t[n].content))continue;let r=t[n].children,i=0;for(let a=r.length-1;a>=0;a--){let o=r[a];if(o.type===`link_close`){for(a--;r[a].level!==o.level&&r[a].type!==`link_open`;)a--;continue}if(o.type===`html_inline`&&(Ze(o.content)&&i>0&&i--,Qe(o.content)&&i++),!(i>0)&&o.type===`text`&&e.md.linkify.test(o.content)){let i=o.content,s=e.md.linkify.match(i),c=[],l=o.level,u=0;s.length>0&&s[0].index===0&&a>0&&r[a-1].type===`text_special`&&(s=s.slice(1));for(let t=0;t<s.length;t++){let n=s[t].url,r=e.md.normalizeLink(n);if(!e.md.validateLink(r))continue;let a=s[t].text;a=s[t].schema?s[t].schema===`mailto:`&&!/^mailto:/i.test(a)?e.md.normalizeLinkText(`mailto:${a}`).replace(/^mailto:/,``):e.md.normalizeLinkText(a):e.md.normalizeLinkText(`http://${a}`).replace(/^http:\/\//,``);let o=s[t].index;if(o>u){let t=new e.Token(`text`,``,0);t.content=i.slice(u,o),t.level=l,c.push(t)}let d=new e.Token(`link_open`,`a`,1);d.attrs=[[`href`,r]],d.level=l++,d.markup=`linkify`,d.info=`auto`,c.push(d);let f=new e.Token(`text`,``,0);f.content=a,f.level=l,c.push(f);let p=new e.Token(`link_close`,`a`,-1);p.level=--l,p.markup=`linkify`,p.info=`auto`,c.push(p),u=s[t].lastIndex}if(u<i.length){let t=new e.Token(`text`,``,0);t.content=i.slice(u),t.level=l,c.push(t)}t[n].children=r=Ce(r,a,c)}}}}var et=/\+-|\.\.|\?\?\?\?|!!!!|,,|--/,tt=/\((c|tm|r)\)/i,nt=/\((c|tm|r)\)/gi,rt={c:`©`,r:`®`,tm:`™`};function it(e,t){return rt[t.toLowerCase()]}function at(e){let t=0;for(let n=e.length-1;n>=0;n--){let r=e[n];r.type===`text`&&!t&&(r.content=r.content.replace(nt,it)),r.type===`link_open`&&r.info===`auto`&&t--,r.type===`link_close`&&r.info===`auto`&&t++}}function ot(e){let t=0;for(let n=e.length-1;n>=0;n--){let r=e[n];r.type===`text`&&!t&&et.test(r.content)&&(r.content=r.content.replace(/\+-/g,`±`).replace(/\.{2,}/g,`…`).replace(/([?!])…/g,`$1..`).replace(/([?!]){4,}/g,`$1$1$1`).replace(/,{2,}/g,`,`).replace(/(^|[^-])---(?=[^-]|$)/gm,`$1—`).replace(/(^|\s)--(?=\s|$)/gm,`$1–`).replace(/(^|[^-\s])--(?=[^-\s]|$)/gm,`$1–`)),r.type===`link_open`&&r.info===`auto`&&t--,r.type===`link_close`&&r.info===`auto`&&t++}}function st(e){let t;if(e.md.options.typographer)for(t=e.tokens.length-1;t>=0;t--)e.tokens[t].type===`inline`&&(tt.test(e.tokens[t].content)&&at(e.tokens[t].children),et.test(e.tokens[t].content)&&ot(e.tokens[t].children))}var ct=/['"]/,lt=/['"]/g,ut=`’`;function H(e,t,n,r){e[t]||(e[t]=[]),e[t].push({pos:n,ch:r})}function dt(e,t){let n=``,r=0;t.sort((e,t)=>e.pos-t.pos);for(let i=0;i<t.length;i++){let a=t[i];n+=e.slice(r,a.pos)+a.ch,r=a.pos+1}return n+e.slice(r)}function ft(e,t){let n,r=[],i={};for(let a=0;a<e.length;a++){let o=e[a],s=e[a].level;for(n=r.length-1;n>=0&&!(r[n].level<=s);n--);if(r.length=n+1,o.type!==`text`)continue;let c=o.content,l=0,u=c.length;OUTER:for(;l<u;){lt.lastIndex=l;let o=lt.exec(c);if(!o)break;let d=!0,f=!0;l=o.index+1;let p=o[0]===`'`,m=32;if(o.index-1>=0)m=c.charCodeAt(o.index-1);else for(n=a-1;n>=0&&e[n].type!==`softbreak`&&e[n].type!==`hardbreak`;n--)if(e[n].content){m=e[n].content.charCodeAt(e[n].content.length-1);break}let h=32;if(l<u)h=c.charCodeAt(l);else for(n=a+1;n<e.length&&e[n].type!==`softbreak`&&e[n].type!==`hardbreak`;n++)if(e[n].content){h=e[n].content.charCodeAt(0);break}let g=I(m)||F(m),_=I(h)||F(h),v=P(m),y=P(h);if(y?d=!1:_&&(v||g||(d=!1)),v?f=!1:g&&(y||_||(f=!1)),h===34&&o[0]===`"`&&m>=48&&m<=57&&(f=d=!1),d&&f&&(d=g,f=_),!d&&!f){p&&H(i,a,o.index,ut);continue}if(f)for(n=r.length-1;n>=0;n--){let e=r[n];if(r[n].level<s)break;if(e.single===p&&r[n].level===s){e=r[n];let s,c;p?(s=t.md.options.quotes[2],c=t.md.options.quotes[3]):(s=t.md.options.quotes[0],c=t.md.options.quotes[1]),H(i,a,o.index,c),H(i,e.token,e.pos,s),r.length=n;continue OUTER}}d?r.push({token:a,pos:o.index,single:p,level:s}):f&&p&&H(i,a,o.index,ut)}}Object.keys(i).forEach(function(t){let n=Number(t);e[n].content=dt(e[n].content,i[t])})}function pt(e){if(e.md.options.typographer)for(let t=e.tokens.length-1;t>=0;t--)e.tokens[t].type!==`inline`||!ct.test(e.tokens[t].content)||ft(e.tokens[t].children,e)}function mt(e){let t,n,r=e.length;for(t=0;t<r;t++)e[t].type===`text_special`&&(e[t].type=`text`);for(t=n=0;t<r;t++)e[t].type===`text`&&t+1<r&&e[t+1].type===`text`?e[t+1].content=e[t].content+e[t+1].content:(t!==n&&(e[n]=e[t]),n++);t!==n&&(e.length=n)}function ht(e){let t,n,r=e.tokens,i=r.length;for(let e=0;e<i;e++){if(r[e].type!==`inline`)continue;let i=r[e].children,a=i.length;for(t=0;t<a;t++)i[t].type===`text_special`&&(i[t].type=`text`),i[t].children&&mt(i[t].children);for(t=n=0;t<a;t++)i[t].type===`text`&&t+1<a&&i[t+1].type===`text`?i[t+1].content=i[t].content+i[t+1].content:(t!==n&&(i[n]=i[t]),n++);t!==n&&(i.length=n)}}var U=[[`normalize`,qe],[`block`,Je],[`strip_references`,Ye],[`inline`,Xe],[`linkify`,$e],[`replacements`,st],[`smartquotes`,pt],[`text_join`,ht]],gt=class{constructor(){T(this,`ruler`,new B),T(this,`State`,We);for(let e=0;e<U.length;e++)this.ruler.push(U[e][0],U[e][1])}process(e){let t=this.ruler.getRules(``);for(let n=0,r=t.length;n<r;n++)t[n](e)}},_t=class{constructor(e,t,n,r){T(this,`bMarks`,[]),T(this,`eMarks`,[]),T(this,`tShift`,[]),T(this,`sCount`,[]),T(this,`bsCount`,[]),T(this,`blkIndent`,0),T(this,`line`,0),T(this,`lineMax`,0),T(this,`tight`,!1),T(this,`listIndent`,-1),T(this,`parentType`,`root`),T(this,`level`,0),T(this,`Token`,z),this.src=e,this.md=t,this.env=n,this.tokens=r;let i=this.src;for(let e=0,t=0,n=0,r=0,a=i.length,o=!1;t<a;t++){let s=i.charCodeAt(t);if(!o)if(N(s)){n++,s===9?r+=4-r%4:r++;continue}else o=!0;(s===10||t===a-1)&&(s!==10&&t++,this.bMarks.push(e),this.eMarks.push(t),this.tShift.push(n),this.sCount.push(r),this.bsCount.push(0),o=!1,n=0,r=0,e=t+1)}this.bMarks.push(i.length),this.eMarks.push(i.length),this.tShift.push(0),this.sCount.push(0),this.bsCount.push(0),this.lineMax=this.bMarks.length-1}push(e,t,n){let r=new z(e,t,n);return r.block=!0,n<0&&this.level--,r.level=this.level,n>0&&this.level++,this.tokens.push(r),r}isEmpty(e){return this.bMarks[e]+this.tShift[e]>=this.eMarks[e]}skipEmptyLines(e){for(let t=this.lineMax;e<t&&!(this.bMarks[e]+this.tShift[e]<this.eMarks[e]);e++);return e}skipSpaces(e){for(let t=this.src.length;e<t&&N(this.src.charCodeAt(e));e++);return e}skipSpacesBack(e,t){if(e<=t)return e;for(;e>t;)if(!N(this.src.charCodeAt(--e)))return e+1;return e}skipChars(e,t){for(let n=this.src.length;e<n&&this.src.charCodeAt(e)===t;e++);return e}skipCharsBack(e,t,n){if(e<=n)return e;for(;e>n;)if(t!==this.src.charCodeAt(--e))return e+1;return e}getLines(e,t,n,r){if(e>=t)return``;let i=Array(t-e);for(let a=0,o=e;o<t;o++,a++){let e=0,s=this.bMarks[o],c=s,l;for(l=o+1<t||r?this.eMarks[o]+1:this.eMarks[o];c<l&&e<n;){let t=this.src.charCodeAt(c);if(N(t))t===9?e+=4-(e+this.bsCount[o])%4:e++;else if(c-s<this.tShift[o])e++;else break;c++}e>n?i[a]=Array(e-n+1).join(` `)+this.src.slice(c,l):i[a]=this.src.slice(c,l)}return i.join(``)}},vt=65536;function W(e,t){let n=e.bMarks[t]+e.tShift[t],r=e.eMarks[t];return e.src.slice(n,r)}function yt(e){let t=[],n=e.length,r=0,i=e.charCodeAt(r),a=!1,o=0,s=``;for(;r<n;)i===124&&(a?(s+=e.substring(o,r-1),o=r):(t.push(s+e.substring(o,r)),s=``,o=r+1)),a=i===92,r++,i=e.charCodeAt(r);return t.push(s+e.substring(o)),t}function bt(e,t,n,r){if(t+2>n)return!1;let i=t+1;if(e.sCount[i]<e.blkIndent||e.sCount[i]-e.blkIndent>=4)return!1;let a=e.bMarks[i]+e.tShift[i];if(a>=e.eMarks[i])return!1;let o=e.src.charCodeAt(a++);if(o!==124&&o!==45&&o!==58||a>=e.eMarks[i])return!1;let s=e.src.charCodeAt(a++);if(s!==124&&s!==45&&s!==58&&!N(s)||o===45&&N(s))return!1;for(;a<e.eMarks[i];){let t=e.src.charCodeAt(a);if(t!==124&&t!==45&&t!==58&&!N(t))return!1;a++}let c=W(e,t+1),l=c.split(`|`),u=[];for(let e=0;e<l.length;e++){let t=l[e].trim();if(!t){if(e===0||e===l.length-1)continue;return!1}if(!/^:?-+:?$/.test(t))return!1;t.charCodeAt(t.length-1)===58?u.push(t.charCodeAt(0)===58?`center`:`right`):t.charCodeAt(0)===58?u.push(`left`):u.push(``)}if(c=W(e,t).trim(),c.indexOf(`|`)===-1||e.sCount[t]-e.blkIndent>=4)return!1;l=yt(c),l.length&&l[0]===``&&l.shift(),l.length&&l[l.length-1]===``&&l.pop();let d=l.length;if(d===0||d!==u.length)return!1;if(r)return!0;let f=e.parentType;e.parentType=`table`;let p=e.md.block.ruler.getRules(`blockquote`),m=e.push(`table_open`,`table`,1),h=[t,0];m.map=h;let g=e.push(`thead_open`,`thead`,1);g.map=[t,t+1];let _=e.push(`tr_open`,`tr`,1);_.map=[t,t+1];for(let t=0;t<l.length;t++){let n=e.push(`th_open`,`th`,1);u[t]&&(n.attrs=[[`style`,`text-align:${u[t]}`]]);let r=e.push(`inline`,``,0);r.content=l[t].trim(),r.children=[],e.push(`th_close`,`th`,-1)}e.push(`tr_close`,`tr`,-1),e.push(`thead_close`,`thead`,-1);let v,y=0;for(i=t+2;i<n&&!(e.sCount[i]<e.blkIndent);i++){let r=!1;for(let t=0,a=p.length;t<a;t++)if(p[t](e,i,n,!0)){r=!0;break}if(r||(c=W(e,i).trim(),!c)||e.sCount[i]-e.blkIndent>=4||(l=yt(c),l.length&&l[0]===``&&l.shift(),l.length&&l[l.length-1]===``&&l.pop(),y+=d-l.length,y>vt))break;if(i===t+2){let n=e.push(`tbody_open`,`tbody`,1);n.map=v=[t+2,0]}let a=e.push(`tr_open`,`tr`,1);a.map=[i,i+1];for(let t=0;t<d;t++){let n=e.push(`td_open`,`td`,1);u[t]&&(n.attrs=[[`style`,`text-align:${u[t]}`]]);let r=e.push(`inline`,``,0);r.content=l[t]?l[t].trim():``,r.children=[],e.push(`td_close`,`td`,-1)}e.push(`tr_close`,`tr`,-1)}return v&&(e.push(`tbody_close`,`tbody`,-1),v[1]=i),e.push(`table_close`,`table`,-1),h[1]=i,e.parentType=f,e.line=i,!0}function xt(e,t,n){if(e.sCount[t]-e.blkIndent<4)return!1;let r=t+1,i=r;for(;r<n;){if(e.isEmpty(r)){r++;continue}if(e.sCount[r]-e.blkIndent>=4){r++,i=r;continue}break}e.line=i;let a=e.push(`code_block`,`code`,0);return a.content=e.getLines(t,i,4+e.blkIndent,!1)+`
`,a.map=[t,e.line],!0}function St(e,t,n,r){let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t];if(e.sCount[t]-e.blkIndent>=4||i+3>a)return!1;let o=e.src.charCodeAt(i);if(o!==126&&o!==96)return!1;let s=i;i=e.skipChars(i,o);let c=i-s;if(c<3)return!1;let l=e.src.slice(s,i),u=e.src.slice(i,a);if(o===96&&u.indexOf(String.fromCharCode(o))>=0)return!1;if(r)return!0;let d=t,f=!1;for(;d++,!(d>=n||(i=s=e.bMarks[d]+e.tShift[d],a=e.eMarks[d],i<a&&e.sCount[d]<e.blkIndent));)if(e.src.charCodeAt(i)===o&&!(e.sCount[d]-e.blkIndent>=4)&&(i=e.skipChars(i,o),!(i-s<c)&&(i=e.skipSpaces(i),!(i<a)))){f=!0;break}c=e.sCount[t],e.line=d+ +!!f;let p=e.push(`fence`,`code`,0);return p.info=u,p.content=e.getLines(t+1,d,c,!0),p.markup=l,p.map=[t,e.line],!0}function Ct(e,t,n,r){let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t],o=e.lineMax;if(e.sCount[t]-e.blkIndent>=4||e.src.charCodeAt(i)!==62)return!1;if(r)return!0;let s=[],c=[],l=[],u=[],d=e.md.block.ruler.getRules(`blockquote`),f=e.parentType;e.parentType=`blockquote`;let p=!1,m;for(m=t;m<n;m++){let t=e.sCount[m]<e.blkIndent;if(i=e.bMarks[m]+e.tShift[m],a=e.eMarks[m],i>=a)break;if(e.src.charCodeAt(i++)===62&&!t){let t=e.sCount[m]+1,n,r;e.src.charCodeAt(i)===32?(i++,t++,r=!1,n=!0):e.src.charCodeAt(i)===9?(n=!0,(e.bsCount[m]+t)%4==3?(i++,t++,r=!1):r=!0):n=!1;let o=t;for(s.push(e.bMarks[m]),e.bMarks[m]=i;i<a;){let t=e.src.charCodeAt(i);if(N(t))t===9?o+=4-(o+e.bsCount[m]+ +!!r)%4:o++;else break;i++}p=i>=a,c.push(e.bsCount[m]),e.bsCount[m]=e.sCount[m]+1+ +!!n,l.push(e.sCount[m]),e.sCount[m]=o-t,u.push(e.tShift[m]),e.tShift[m]=i-e.bMarks[m];continue}if(p)break;let r=!1;for(let t=0,i=d.length;t<i;t++)if(d[t](e,m,n,!0)){r=!0;break}if(r){e.lineMax=m,e.blkIndent!==0&&(s.push(e.bMarks[m]),c.push(e.bsCount[m]),u.push(e.tShift[m]),l.push(e.sCount[m]),e.sCount[m]-=e.blkIndent);break}s.push(e.bMarks[m]),c.push(e.bsCount[m]),u.push(e.tShift[m]),l.push(e.sCount[m]),e.sCount[m]=-1}let h=e.blkIndent;e.blkIndent=0;let g=e.push(`blockquote_open`,`blockquote`,1);g.markup=`>`;let _=[t,0];g.map=_,e.md.block.tokenize(e,t,m);let v=e.push(`blockquote_close`,`blockquote`,-1);v.markup=`>`,e.lineMax=o,e.parentType=f,_[1]=e.line;for(let n=0;n<u.length;n++)e.bMarks[n+t]=s[n],e.tShift[n+t]=u[n],e.sCount[n+t]=l[n],e.bsCount[n+t]=c[n];return e.blkIndent=h,!0}function wt(e,t,n,r){let i=e.eMarks[t];if(e.sCount[t]-e.blkIndent>=4)return!1;let a=e.bMarks[t]+e.tShift[t],o=e.src.charCodeAt(a++);if(o!==42&&o!==45&&o!==95)return!1;let s=1;for(;a<i;){let t=e.src.charCodeAt(a++);if(t!==o&&!N(t))return!1;t===o&&s++}if(s<3)return!1;if(r)return!0;e.line=t+1;let c=e.push(`hr`,`hr`,0);return c.map=[t,e.line],c.markup=Array(s+1).join(String.fromCharCode(o)),!0}function Tt(e,t){let n=e.eMarks[t],r=e.bMarks[t]+e.tShift[t],i=e.src.charCodeAt(r++);return i!==42&&i!==45&&i!==43||r<n&&!N(e.src.charCodeAt(r))?-1:r}function Et(e,t){let n=e.bMarks[t]+e.tShift[t],r=e.eMarks[t],i=n;if(i+1>=r)return-1;let a=e.src.charCodeAt(i++);if(a<48||a>57)return-1;for(;;){if(i>=r)return-1;if(a=e.src.charCodeAt(i++),a>=48&&a<=57){if(i-n>=10)return-1;continue}if(a===41||a===46)break;return-1}return i<r&&(a=e.src.charCodeAt(i),!N(a))?-1:i}function Dt(e,t){let n=e.level+2;for(let r=t+2,i=e.tokens.length-2;r<i;r++)e.tokens[r].level===n&&e.tokens[r].type===`paragraph_open`&&(e.tokens[r+2].hidden=!0,e.tokens[r].hidden=!0,r+=2)}function Ot(e,t,n,r){let i,a,o,s,c=t,l=!0;if(e.sCount[c]-e.blkIndent>=4||e.listIndent>=0&&e.sCount[c]-e.listIndent>=4&&e.sCount[c]<e.blkIndent)return!1;let u=!1;r&&e.parentType===`paragraph`&&e.sCount[c]>=e.blkIndent&&(u=!0);let d,f,p;if((p=Et(e,c))>=0){if(d=!0,o=e.bMarks[c]+e.tShift[c],f=Number(e.src.slice(o,p-1)),u&&f!==1)return!1}else if((p=Tt(e,c))>=0)d=!1;else return!1;if(u&&e.skipSpaces(p)>=e.eMarks[c])return!1;if(r)return!0;let m=e.src.charCodeAt(p-1),h=e.tokens.length;d?(s=e.push(`ordered_list_open`,`ol`,1),f!==1&&(s.attrs=[[`start`,f]])):s=e.push(`bullet_list_open`,`ul`,1);let g=[c,0];s.map=g,s.markup=String.fromCharCode(m);let _=!1,v=e.md.block.ruler.getRules(`list`),y=e.parentType;for(e.parentType=`list`;c<n;){a=p,i=e.eMarks[c];let t=e.sCount[c]+p-(e.bMarks[c]+e.tShift[c]),r=t;for(;a<i;){let t=e.src.charCodeAt(a);if(t===9)r+=4-(r+e.bsCount[c])%4;else if(t===32)r++;else break;a++}let u=a,f;f=u>=i?1:r-t,f>4&&(f=1);let h=t+f;s=e.push(`list_item_open`,`li`,1),s.markup=String.fromCharCode(m);let g=[c,0];s.map=g,d&&(s.info=e.src.slice(o,p-1));let y=e.tight,b=e.tShift[c],ee=e.sCount[c],te=e.listIndent;if(e.listIndent=e.blkIndent,e.blkIndent=h,e.tight=!0,e.tShift[c]=u-e.bMarks[c],e.sCount[c]=r,u>=i&&e.isEmpty(c+1)?e.line=Math.min(e.line+2,n):e.md.block.tokenize(e,c,n),(!e.tight||_)&&(l=!1),_=e.line-c>1&&e.isEmpty(e.line-1),e.blkIndent=e.listIndent,e.listIndent=te,e.tShift[c]=b,e.sCount[c]=ee,e.tight=y,s=e.push(`list_item_close`,`li`,-1),s.markup=String.fromCharCode(m),c=e.line,g[1]=c,c>=n||e.sCount[c]<e.blkIndent||e.sCount[c]-e.blkIndent>=4)break;let x=!1;for(let t=0,r=v.length;t<r;t++)if(v[t](e,c,n,!0)){x=!0;break}if(x)break;if(d){if(p=Et(e,c),p<0)break;o=e.bMarks[c]+e.tShift[c]}else if(p=Tt(e,c),p<0)break;if(m!==e.src.charCodeAt(p-1))break}return s=d?e.push(`ordered_list_close`,`ol`,-1):e.push(`bullet_list_close`,`ul`,-1),s.markup=String.fromCharCode(m),g[1]=c,e.line=c,e.parentType=y,l&&Dt(e,h),!0}function kt(e,t,n,r){let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t],o=t+1;if(e.sCount[t]-e.blkIndent>=4||e.src.charCodeAt(i)!==91)return!1;function s(t){let n=e.lineMax;if(t>=n||e.isEmpty(t))return null;let r=!1;if(e.sCount[t]-e.blkIndent>3&&(r=!0),e.sCount[t]<0&&(r=!0),!r){let r=e.md.block.ruler.getRules(`reference`),i=e.parentType;e.parentType=`reference`;let a=!1;for(let i=0,o=r.length;i<o;i++)if(r[i](e,t,n,!0)){a=!0;break}if(e.parentType=i,a)return null}let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t];return e.src.slice(i,a+1)}let c=e.src.slice(i,a+1);a=c.length;let l=-1;for(i=1;i<a;i++){let e=c.charCodeAt(i);if(e===91)return!1;if(e===93){l=i;break}if(e===10){let e=s(o);e!==null&&(c+=e,a=c.length,o++)}else if(e===92&&(i++,i<a&&c.charCodeAt(i)===10)){let e=s(o);e!==null&&(c+=e,a=c.length,o++)}}if(l<0||c.charCodeAt(l+1)!==58)return!1;for(i=l+2;i<a;i++){let e=c.charCodeAt(i);if(e===10){let e=s(o);e!==null&&(c+=e,a=c.length,o++)}else if(!N(e))break}let u=e.md.helpers.parseLinkDestination(c,i,a);if(!u.ok)return!1;let d=e.md.normalizeLink(u.str);if(!e.md.validateLink(d))return!1;i=u.pos;let f=i,p=o,m=i;for(;i<a;i++){let e=c.charCodeAt(i);if(e===10){let e=s(o);e!==null&&(c+=e,a=c.length,o++)}else if(!N(e))break}let h=e.md.helpers.parseLinkTitle(c,i,a);for(;h.can_continue;){let t=s(o);if(t===null)break;c+=t,i=a,a=c.length,o++,h=e.md.helpers.parseLinkTitle(c,i,a,h)}let g;for(i<a&&m!==i&&h.ok?(g=h.str,i=h.pos):(g=``,i=f,o=p);i<a&&N(c.charCodeAt(i));)i++;if(i<a&&c.charCodeAt(i)!==10&&g)for(g=``,i=f,o=p;i<a&&N(c.charCodeAt(i));)i++;if(i<a&&c.charCodeAt(i)!==10)return!1;let _=L(c.slice(1,l));if(!_)return!1;if(r)return!0;e.env.references===void 0&&(e.env.references={}),e.env.references[_]===void 0&&(e.env.references[_]={title:g,href:d});let v=e.push(`reference_definition`,``,0);v.map=[t,o],v.hidden=!0;let y=Object.create(null);return y.label=_,v.meta=y,e.line=o,!0}var At=`address.article.aside.base.basefont.blockquote.body.caption.center.col.colgroup.dd.details.dialog.dir.div.dl.dt.fieldset.figcaption.figure.footer.form.frame.frameset.h1.h2.h3.h4.h5.h6.head.header.hr.html.iframe.legend.li.link.main.menu.menuitem.nav.noframes.ol.optgroup.option.p.param.search.section.summary.table.tbody.td.tfoot.th.thead.title.tr.track.ul`.split(`.`),jt=`<[A-Za-z][A-Za-z0-9\\-]*(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?)*\\s*\\/?>`,Mt=`<\\/[A-Za-z][A-Za-z0-9\\-]*\\s*>`,Nt=RegExp(`^(?:${jt}|${Mt}|<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z][^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)`),Pt=RegExp(`^(?:${jt}|${Mt})`),G=[[/^<(script|pre|style|textarea)(?=(\s|>|$))/i,/<\/(script|pre|style|textarea)>/i,!0],[/^<!--/,/-->/,!0],[/^<\?/,/\?>/,!0],[/^<![A-Za-z]/,/>/,!0],[/^<!\[CDATA\[/,/\]\]>/,!0],[RegExp(`^</?(${At.join(`|`)})(?=(\\s|/?>|$))`,`i`),/^$/,!0],[RegExp(`${Pt.source}\\s*$`),/^$/,!1]];function Ft(e,t,n,r){let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t];if(e.sCount[t]-e.blkIndent>=4||!e.md.options.html||e.src.charCodeAt(i)!==60)return!1;let o=e.src.slice(i,a),s=0;for(;s<G.length&&!G[s][0].test(o);s++);if(s===G.length)return!1;if(r)return G[s][2];let c=t+1,l=G[s][1].test(``);if(!G[s][1].test(o)){for(;c<n&&!(e.sCount[c]<e.blkIndent&&(l||!e.isEmpty(c)));c++)if(i=e.bMarks[c]+e.tShift[c],a=e.eMarks[c],o=e.src.slice(i,a),G[s][1].test(o)){o.length!==0&&c++;break}}e.line=c;let u=e.push(`html_block`,``,0);return u.map=[t,c],u.content=e.getLines(t,c,e.blkIndent,!0),!0}function It(e,t,n,r){let i=e.bMarks[t]+e.tShift[t],a=e.eMarks[t];if(e.sCount[t]-e.blkIndent>=4)return!1;let o=e.src.charCodeAt(i);if(o!==35||i>=a)return!1;let s=1;for(o=e.src.charCodeAt(++i);o===35&&i<a&&s<=6;)s++,o=e.src.charCodeAt(++i);if(s>6||i<a&&!N(o))return!1;if(r)return!0;a=e.skipSpacesBack(a,i);let c=e.skipCharsBack(a,35,i);c>i&&N(e.src.charCodeAt(c-1))&&(a=c),e.line=t+1;let l=e.push(`heading_open`,`h${s}`,1);l.markup=`########`.slice(0,s),l.map=[t,e.line];let u=e.push(`inline`,``,0);u.content=R(e.src.slice(i,a)),u.map=[t,e.line],u.children=[];let d=e.push(`heading_close`,`h${s}`,-1);return d.markup=`########`.slice(0,s),!0}function Lt(e,t,n){let r=e.md.block.ruler.getRules(`paragraph`);if(e.sCount[t]-e.blkIndent>=4)return!1;let i=e.parentType;e.parentType=`paragraph`;let a=0,o,s=t+1;for(;s<n&&!e.isEmpty(s);s++){if(e.sCount[s]-e.blkIndent>3)continue;if(e.sCount[s]>=e.blkIndent){let t=e.bMarks[s]+e.tShift[s],n=e.eMarks[s];if(t<n&&(o=e.src.charCodeAt(t),(o===45||o===61)&&(t=e.skipChars(t,o),t=e.skipSpaces(t),t>=n))){a=o===61?1:2;break}}if(e.sCount[s]<0)continue;let t=!1;for(let i=0,a=r.length;i<a;i++)if(r[i](e,s,n,!0)){t=!0;break}if(t)break}if(!a)return e.parentType=i,!1;let c=R(e.getLines(t,s,e.blkIndent,!1));e.line=s+1;let l=e.push(`heading_open`,`h${a}`,1);l.markup=String.fromCharCode(o),l.map=[t,e.line];let u=e.push(`inline`,``,0);u.content=c,u.map=[t,e.line-1],u.children=[];let d=e.push(`heading_close`,`h${a}`,-1);return d.markup=String.fromCharCode(o),e.parentType=i,!0}function Rt(e,t,n){let r=e.md.block.ruler.getRules(`paragraph`),i=e.parentType,a=t+1;for(e.parentType=`paragraph`;a<n&&!e.isEmpty(a);a++){if(e.sCount[a]-e.blkIndent>3||e.sCount[a]<0)continue;let t=!1;for(let i=0,o=r.length;i<o;i++)if(r[i](e,a,n,!0)){t=!0;break}if(t)break}let o=R(e.getLines(t,a,e.blkIndent,!1));e.line=a;let s=e.push(`paragraph_open`,`p`,1);s.map=[t,e.line];let c=e.push(`inline`,``,0);return c.content=o,c.map=[t,e.line],c.children=[],e.push(`paragraph_close`,`p`,-1),e.parentType=i,!0}var K=[[`table`,bt,[`paragraph`,`reference`]],[`code`,xt],[`fence`,St,[`paragraph`,`reference`,`blockquote`,`list`]],[`blockquote`,Ct,[`paragraph`,`reference`,`blockquote`,`list`]],[`hr`,wt,[`paragraph`,`reference`,`blockquote`,`list`]],[`list`,Ot,[`paragraph`,`reference`,`blockquote`]],[`reference`,kt],[`html_block`,Ft,[`paragraph`,`reference`,`blockquote`]],[`heading`,It,[`paragraph`,`reference`,`blockquote`]],[`lheading`,Lt],[`paragraph`,Rt]],zt=class{constructor(){T(this,`ruler`,new B),T(this,`State`,_t);for(let e=0;e<K.length;e++)this.ruler.push(K[e][0],K[e][1],{alt:(K[e][2]||[]).slice()})}tokenize(e,t,n){let r=this.ruler.getRules(``),i=r.length,a=e.md.options.maxNesting,o=t,s=!1;for(;o<n&&(e.line=o=e.skipEmptyLines(o),!(o>=n||e.sCount[o]<e.blkIndent));){if(e.level>=a){e.line=n;break}let t=e.line,c=!1;for(let a=0;a<i;a++)if(c=r[a](e,o,n,!1),c){if(t>=e.line)throw Error(`block rule didn't increment state.line`);break}if(!c)throw Error(`none of the block rules matched`);e.tight=!s,e.isEmpty(e.line-1)&&(s=!0),o=e.line,o<n&&e.isEmpty(o)&&(s=!0,o++,e.line=o)}}parse(e,t,n,r){if(!e)return;let i=new this.State(e,t,n,r);this.tokenize(i,i.line,i.lineMax)}},Bt=class{constructor(e,t,n,r){T(this,`pos`,0),T(this,`level`,0),T(this,`pending`,``),T(this,`pendingLevel`,0),T(this,`cache`,{}),T(this,`backticks`,{}),T(this,`backticksScanned`,!1),T(this,`linkLevel`,0),T(this,`delimiters`,[]),T(this,`_prev_delimiters`,[]),T(this,`Token`,z),this.src=e,this.env=n,this.md=t,this.tokens=r,this.tokens_meta=Array(r.length),this.posMax=this.src.length}pushPending(){let e=new z(`text`,``,0);return e.content=this.pending,e.level=this.pendingLevel,this.tokens.push(e),this.pending=``,e}push(e,t,n){this.pending&&this.pushPending();let r=new z(e,t,n),i;return n<0&&(this.level--,this.delimiters=this._prev_delimiters.pop()),r.level=this.level,n>0&&(this.level++,this._prev_delimiters.push(this.delimiters),this.delimiters=[],i={delimiters:this.delimiters}),this.pendingLevel=this.level,this.tokens.push(r),this.tokens_meta.push(i),r}scanDelims(e,t){let n=this.posMax,r=this.src.charCodeAt(e),i;if(e===0)i=32;else if(e===1)i=this.src.charCodeAt(0),(i&63488)==55296&&(i=65533);else if(i=this.src.charCodeAt(e-1),(i&64512)==56320){let t=this.src.charCodeAt(e-2);i=(t&64512)==55296?65536+(t-55296<<10)+(i-56320):65533}else(i&64512)==55296&&(i=65533);let a=e;for(;a<n&&this.src.charCodeAt(a)===r;)a++;let o=a-e,s=a<n?this.src.charCodeAt(a):32;if((s&64512)==55296){let e=this.src.charCodeAt(a+1);s=(e&64512)==56320?65536+(s-55296<<10)+(e-56320):65533}else(s&64512)==56320&&(s=65533);let c=I(i)||F(i),l=I(s)||F(s),u=P(i),d=P(s),f=!d&&(!l||u||c),p=!u&&(!c||d||l);return{can_open:f&&(t||!p||c),can_close:p&&(t||!f||l),length:o}}};function Vt(e){switch(e){case 10:case 33:case 35:case 36:case 37:case 38:case 42:case 43:case 45:case 58:case 60:case 61:case 62:case 64:case 91:case 92:case 93:case 94:case 95:case 96:case 123:case 125:case 126:return!0;default:return!1}}function Ht(e,t){let n=e.pos;for(;n<e.posMax&&!Vt(e.src.charCodeAt(n));)n++;return n!==e.pos&&(t||(e.pending+=e.src.slice(e.pos,n)),e.pos=n,!0)}var Ut=/(?:^|[^a-z0-9.+-])([a-z][a-z0-9.+-]*)$/i;function Wt(e,t){if(!e.md.options.linkify||e.linkLevel>0)return!1;let n=e.pos,r=e.posMax;if(n+3>r||e.src.charCodeAt(n)!==58||e.src.charCodeAt(n+1)!==47||e.src.charCodeAt(n+2)!==47)return!1;let i=e.pending.match(Ut);if(!i)return!1;let a=i[1],o=e.md.linkify.matchAtStart(e.src.slice(n-a.length));if(!o)return!1;let s=o.url;if(s.length<=a.length)return!1;let c=s.length;for(;c>0&&s.charCodeAt(c-1)===42;)c--;c!==s.length&&(s=s.slice(0,c));let l=e.md.normalizeLink(s);if(!e.md.validateLink(l))return!1;if(!t){e.pending=e.pending.slice(0,-a.length);let t=e.push(`link_open`,`a`,1);t.attrs=[[`href`,l]],t.markup=`linkify`,t.info=`auto`;let n=e.push(`text`,``,0);n.content=e.md.normalizeLinkText(s);let r=e.push(`link_close`,`a`,-1);r.markup=`linkify`,r.info=`auto`}return e.pos+=s.length-a.length,!0}function Gt(e,t){let n=e.pos;if(e.src.charCodeAt(n)!==10)return!1;let r=e.pending.length-1,i=e.posMax;if(!t)if(r>=0&&e.pending.charCodeAt(r)===32)if(r>=1&&e.pending.charCodeAt(r-1)===32){let t=r-1;for(;t>=1&&e.pending.charCodeAt(t-1)===32;)t--;e.pending=e.pending.slice(0,t),e.push(`hardbreak`,`br`,0)}else e.pending=e.pending.slice(0,-1),e.push(`softbreak`,`br`,0);else e.push(`softbreak`,`br`,0);for(n++;n<i&&N(e.src.charCodeAt(n));)n++;return e.pos=n,!0}var Kt=[];for(let e=0;e<256;e++)Kt.push(0);`\\!"#$%&'()*+,./:;<=>?@[]^_\`{|}~-`.split(``).forEach(function(e){Kt[e.charCodeAt(0)]=1});function qt(e,t){let n=e.pos,r=e.posMax;if(e.src.charCodeAt(n)!==92||(n++,n>=r))return!1;let i=e.src.charCodeAt(n);if(i===10){for(t||e.push(`hardbreak`,`br`,0),n++;n<r&&(i=e.src.charCodeAt(n),N(i));)n++;return e.pos=n,!0}if(i===32){if(!t){let t=e.push(`text_special`,``,0);t.content=`\\`,t.markup=`\\`,t.info=`escape`}return e.pos=n,!0}let a=e.src[n];if(i>=55296&&i<=56319&&n+1<r){let t=e.src.charCodeAt(n+1);t>=56320&&t<=57343&&(a+=e.src[n+1],n++)}let o=`\\`+a;if(!t){let t=e.push(`text_special`,``,0);t.content=i<256&&Kt[i]!==0?a:o,t.markup=o,t.info=`escape`}return e.pos=n+1,!0}function Jt(e,t){let n=e.pos;if(e.src.charCodeAt(n)!==96)return!1;let r=n;n++;let i=e.posMax;for(;n<i&&e.src.charCodeAt(n)===96;)n++;let a=e.src.slice(r,n),o=a.length;if(e.backticksScanned&&(e.backticks[o]||0)<=r)return t||(e.pending+=a),e.pos+=o,!0;let s=n,c;for(;(c=e.src.indexOf("`",s))!==-1;){for(s=c+1;s<i&&e.src.charCodeAt(s)===96;)s++;let r=s-c;if(r===o){if(!t){let t=e.push(`code_inline`,`code`,0);t.markup=a,t.content=e.src.slice(n,c).replace(/\n/g,` `).replace(/^ (.+) $/,`$1`)}return e.pos=s,!0}e.backticks[r]=c}return e.backticksScanned=!0,t||(e.pending+=a),e.pos+=o,!0}function Yt(e,t){let n=e.pos,r=e.src.charCodeAt(n);if(t||r!==126)return!1;let i=e.scanDelims(e.pos,!0),a=i.length,o=String.fromCharCode(r);if(a<2)return!1;let s;a%2&&(s=e.push(`text`,``,0),s.content=o,a--);for(let t=0;t<a;t+=2)s=e.push(`text`,``,0),s.content=o+o,e.delimiters.push({marker:r,length:0,token:e.tokens.length-1,end:-1,open:i.can_open,close:i.can_close});return e.pos+=i.length,!0}function Xt(e,t){let n,r=[],i=t.length;for(let a=0;a<i;a++){let i=t[a];if(i.marker!==126||i.end===-1)continue;let o=t[i.end];n=e.tokens[i.token],n.type=`s_open`,n.tag=`s`,n.nesting=1,n.markup=`~~`,n.content=``,n=e.tokens[o.token],n.type=`s_close`,n.tag=`s`,n.nesting=-1,n.markup=`~~`,n.content=``,e.tokens[o.token-1].type===`text`&&e.tokens[o.token-1].content===`~`&&r.push(o.token-1)}for(;r.length;){let t=r.pop(),i=t+1;for(;i<e.tokens.length&&e.tokens[i].type===`s_close`;)i++;i--,t!==i&&(n=e.tokens[i],e.tokens[i]=e.tokens[t],e.tokens[t]=n)}}function Zt(e){let t=e.tokens_meta,n=e.tokens_meta.length;Xt(e,e.delimiters);for(let i=0;i<n;i++){var r;let n=(r=t[i])==null?void 0:r.delimiters;n&&Xt(e,n)}}var Qt={tokenize:Yt,postProcess:Zt};function $t(e,t){let n=e.pos,r=e.src.charCodeAt(n);if(t||r!==95&&r!==42)return!1;let i=e.scanDelims(e.pos,r===42);for(let t=0;t<i.length;t++){let t=e.push(`text`,``,0);t.content=String.fromCharCode(r),e.delimiters.push({marker:r,length:i.length,token:e.tokens.length-1,end:-1,open:i.can_open,close:i.can_close})}return e.pos+=i.length,!0}function en(e,t){let n=t.length;for(let r=n-1;r>=0;r--){let n=t[r];if(n.marker!==95&&n.marker!==42||n.end===-1)continue;let i=t[n.end],a=r>0&&t[r-1].end===n.end+1&&t[r-1].marker===n.marker&&t[r-1].token===n.token-1&&t[n.end+1].token===i.token+1,o=String.fromCharCode(n.marker),s=e.tokens[n.token];s.type=a?`strong_open`:`em_open`,s.tag=a?`strong`:`em`,s.nesting=1,s.markup=a?o+o:o,s.content=``;let c=e.tokens[i.token];c.type=a?`strong_close`:`em_close`,c.tag=a?`strong`:`em`,c.nesting=-1,c.markup=a?o+o:o,c.content=``,a&&(e.tokens[t[r-1].token].content=``,e.tokens[t[n.end+1].token].content=``,r--)}}function tn(e){let t=e.tokens_meta,n=e.tokens_meta.length;en(e,e.delimiters);for(let i=0;i<n;i++){var r;let n=(r=t[i])==null?void 0:r.delimiters;n&&en(e,n)}}var nn={tokenize:$t,postProcess:tn};function rn(e,t){let n,r,i,a,o=``,s=``,c=e.pos,l=!0;if(e.src.charCodeAt(e.pos)!==91)return!1;let u=e.pos,d=e.posMax,f=e.pos+1,p=e.md.helpers.parseLinkLabel(e,e.pos,!0);if(p<0)return!1;let m=p+1;if(m<d&&e.src.charCodeAt(m)===40){for(l=!1,m++;m<d&&(n=e.src.charCodeAt(m),!(!N(n)&&n!==10));m++);if(m>=d)return!1;if(c=m,i=e.md.helpers.parseLinkDestination(e.src,m,e.posMax),i.ok){for(o=e.md.normalizeLink(i.str),e.md.validateLink(o)?m=i.pos:o=``,c=m;m<d&&(n=e.src.charCodeAt(m),!(!N(n)&&n!==10));m++);if(i=e.md.helpers.parseLinkTitle(e.src,m,e.posMax),m<d&&c!==m&&i.ok)for(s=i.str,m=i.pos;m<d&&(n=e.src.charCodeAt(m),!(!N(n)&&n!==10));m++);}(m>=d||e.src.charCodeAt(m)!==41)&&(l=!0),m++}if(l){if(e.env.references===void 0)return!1;if(m<d&&e.src.charCodeAt(m)===91?(c=m+1,m=e.md.helpers.parseLinkLabel(e,m),m>=0?r=e.src.slice(c,m++):m=p+1):m=p+1,r||(r=e.src.slice(f,p)),r=L(r),a=e.env.references[r],!a)return e.pos=u,!1;o=a.href,s=a.title}if(!t){e.pos=f,e.posMax=p;let t=e.push(`link_open`,`a`,1),n=[[`href`,o]];if(t.attrs=n,s&&n.push([`title`,s]),r){let e=Object.create(null);e.label=r,t.meta=e}e.linkLevel++,e.md.inline.tokenize(e),e.linkLevel--,e.push(`link_close`,`a`,-1)}return e.pos=m,e.posMax=d,!0}function an(e,t){let n,r,i,a,o,s,c,l,u=``,d=e.pos,f=e.posMax;if(e.src.charCodeAt(e.pos)!==33||e.src.charCodeAt(e.pos+1)!==91)return!1;let p=e.pos+2,m=e.md.helpers.parseLinkLabel(e,e.pos+1,!1);if(m<0)return!1;if(a=m+1,a<f&&e.src.charCodeAt(a)===40){for(a++;a<f&&(n=e.src.charCodeAt(a),!(!N(n)&&n!==10));a++);if(a>=f)return!1;for(l=a,s=e.md.helpers.parseLinkDestination(e.src,a,e.posMax),s.ok&&(u=e.md.normalizeLink(s.str),e.md.validateLink(u)?a=s.pos:u=``),l=a;a<f&&(n=e.src.charCodeAt(a),!(!N(n)&&n!==10));a++);if(s=e.md.helpers.parseLinkTitle(e.src,a,e.posMax),a<f&&l!==a&&s.ok)for(c=s.str,a=s.pos;a<f&&(n=e.src.charCodeAt(a),!(!N(n)&&n!==10));a++);else c=``;if(a>=f||e.src.charCodeAt(a)!==41)return e.pos=d,!1;a++}else{if(e.env.references===void 0)return!1;if(a<f&&e.src.charCodeAt(a)===91?(l=a+1,a=e.md.helpers.parseLinkLabel(e,a),a>=0?i=e.src.slice(l,a++):a=m+1):a=m+1,i||(i=e.src.slice(p,m)),i=L(i),o=e.env.references[i],!o)return e.pos=d,!1;u=o.href,c=o.title}if(!t){r=e.src.slice(p,m);let t=[];e.md.inline.parse(r,e.md,e.env,t);let n=e.push(`image`,`img`,0),a=[[`src`,u],[`alt`,``]];if(n.attrs=a,n.children=t,n.content=r,c&&a.push([`title`,c]),i){let e=Object.create(null);e.label=i,n.meta=e}}return e.pos=a,e.posMax=f,!0}var on=/^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)$/,sn=/^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):([^<>\x00-\x20]*)$/;function cn(e,t){let n=e.pos;if(e.src.charCodeAt(n)!==60)return!1;let r=e.pos,i=e.posMax;for(;;){if(++n>=i)return!1;let t=e.src.charCodeAt(n);if(t===60)return!1;if(t===62)break}let a=e.src.slice(r+1,n);if(sn.test(a)){let n=e.md.normalizeLink(a);if(!e.md.validateLink(n))return!1;if(!t){let t=e.push(`link_open`,`a`,1);t.attrs=[[`href`,n]],t.markup=`autolink`,t.info=`auto`;let r=e.push(`text`,``,0);r.content=e.md.normalizeLinkText(a);let i=e.push(`link_close`,`a`,-1);i.markup=`autolink`,i.info=`auto`}return e.pos+=a.length+2,!0}if(on.test(a)){let n=e.md.normalizeLink(`mailto:${a}`);if(!e.md.validateLink(n))return!1;if(!t){let t=e.push(`link_open`,`a`,1);t.attrs=[[`href`,n]],t.markup=`autolink`,t.info=`auto`;let r=e.push(`text`,``,0);r.content=e.md.normalizeLinkText(a);let i=e.push(`link_close`,`a`,-1);i.markup=`autolink`,i.info=`auto`}return e.pos+=a.length+2,!0}return!1}function ln(e){return/^<a[>\s]/i.test(e)}function un(e){return/^<\/a\s*>/i.test(e)}function dn(e){let t=e|32;return t>=97&&t<=122}function fn(e,t){if(!e.md.options.html)return!1;let n=e.posMax,r=e.pos;if(e.src.charCodeAt(r)!==60||r+2>=n)return!1;let i=e.src.charCodeAt(r+1);if(i!==33&&i!==63&&i!==47&&!dn(i))return!1;let a=e.src.slice(r).match(Nt);if(!a)return!1;if(!t){let t=e.push(`html_inline`,``,0);t.content=a[0],ln(t.content)&&e.linkLevel++,un(t.content)&&e.linkLevel--}return e.pos+=a[0].length,!0}var pn=/^&#((?:x[a-f0-9]{1,6}|[0-9]{1,7}));/i,mn=/^&([a-z][a-z0-9]{1,31});/i;function hn(e,t){let n=e.pos,r=e.posMax;if(e.src.charCodeAt(n)!==38||n+1>=r)return!1;if(e.src.charCodeAt(n+1)===35){let r=e.src.slice(n).match(pn);if(r){if(!t){let t=r[1][0].toLowerCase()===`x`?parseInt(r[1].slice(1),16):parseInt(r[1],10),n=e.push(`text_special`,``,0);n.content=we(t)?A(t):A(65533),n.markup=r[0],n.info=`entity`}return e.pos+=r[0].length,!0}}else{let r=e.src.slice(n).match(mn);if(r){let n=be(r[0]);if(n!==r[0]){if(!t){let t=e.push(`text_special`,``,0);t.content=n,t.markup=r[0],t.info=`entity`}return e.pos+=r[0].length,!0}}}return!1}function gn(e){let t={},n=e.length;if(!n)return;let r=0,i=-2,a=[];for(let o=0;o<n;o++){let n=e[o];if(a.push(0),(e[r].marker!==n.marker||i!==n.token-1)&&(r=o),i=n.token,n.length=n.length||0,!n.close)continue;t.hasOwnProperty(n.marker)||(t[n.marker]=[-1,-1,-1,-1,-1,-1]);let s=t[n.marker][(n.open?3:0)+n.length%3],c=r-a[r]-1,l=c;for(;c>s;c-=a[c]+1){let t=e[c];if(t.marker===n.marker&&t.open&&t.end<0){let r=!1;if((t.close||n.open)&&(t.length+n.length)%3==0&&(t.length%3!=0||n.length%3!=0)&&(r=!0),!r){let r=c>0&&!e[c-1].open?a[c-1]+1:0;a[o]=o-c+r,a[c]=r,n.open=!1,t.end=o,t.close=!1,l=-1,i=-2;break}}}l!==-1&&(t[n.marker][(n.open?3:0)+(n.length||0)%3]=l)}}function _n(e){let t=e.tokens_meta,n=e.tokens_meta.length;gn(e.delimiters);for(let e=0;e<n;e++){var r;let n=(r=t[e])==null?void 0:r.delimiters;n&&gn(n)}}function vn(e){let t,n,r=0,i=e.tokens,a=e.tokens.length;for(t=n=0;t<a;t++)i[t].nesting<0&&r--,i[t].level=r,i[t].nesting>0&&r++,i[t].type===`text`&&t+1<a&&i[t+1].type===`text`?i[t+1].content=i[t].content+i[t+1].content:(t!==n&&(i[n]=i[t]),n++);t!==n&&(i.length=n)}var yn=[[`text`,Ht],[`linkify`,Wt],[`newline`,Gt],[`escape`,qt],[`backticks`,Jt],[`strikethrough`,Qt.tokenize],[`emphasis`,nn.tokenize],[`link`,rn],[`image`,an],[`autolink`,cn],[`html_inline`,fn],[`entity`,hn]],bn=[[`balance_pairs`,_n],[`strikethrough`,Qt.postProcess],[`emphasis`,nn.postProcess],[`fragments_join`,vn]],xn=class{constructor(){T(this,`ruler`,new B),T(this,`ruler2`,new B),T(this,`State`,Bt);for(let e=0;e<yn.length;e++)this.ruler.push(yn[e][0],yn[e][1]);for(let e=0;e<bn.length;e++)this.ruler2.push(bn[e][0],bn[e][1])}skipToken(e){let t=e.pos,n=this.ruler.getRules(``),r=n.length,i=e.md.options.maxNesting,a=e.cache;if(a[t]!==void 0){e.pos=a[t];return}let o=!1;if(e.level<i){for(let i=0;i<r;i++)if(e.level++,o=n[i](e,!0),e.level--,o){if(t>=e.pos)throw Error(`inline rule didn't increment state.pos`);break}}else e.pos=e.posMax;o||e.pos++,a[t]=e.pos}tokenize(e){let t=this.ruler.getRules(``),n=t.length,r=e.posMax,i=e.md.options.maxNesting;for(;e.pos<r;){let a=e.pos,o=!1;if(e.level<i){for(let r=0;r<n;r++)if(o=t[r](e,!1),o){if(a>=e.pos)throw Error(`inline rule didn't increment state.pos`);break}}if(o){if(e.pos>=r)break;continue}e.pending+=e.src[e.pos++]}e.pending&&e.pushPending()}parse(e,t,n,r){let i=new this.State(e,t,n,r);this.tokenize(i);let a=this.ruler2.getRules(``),o=a.length;for(let e=0;e<o;e++)a[e](i)}};function Sn(e,t){var n=Object.keys(e);if(Object.getOwnPropertySymbols){var r=Object.getOwnPropertySymbols(e);t&&(r=r.filter(function(t){return Object.getOwnPropertyDescriptor(e,t).enumerable})),n.push.apply(n,r)}return n}function q(e){for(var t=1;t<arguments.length;t++){var n=arguments[t]==null?{}:arguments[t];t%2?Sn(Object(n),!0).forEach(function(t){T(e,t,n[t])}):Object.getOwnPropertyDescriptors?Object.defineProperties(e,Object.getOwnPropertyDescriptors(n)):Sn(Object(n)).forEach(function(t){Object.defineProperty(e,t,Object.getOwnPropertyDescriptor(n,t))})}return e}function Cn(e,t){if(e==null)return{};var n={};for(var r in e)if({}.hasOwnProperty.call(e,r)){if(t.includes(r))continue;n[r]=e[r]}return n}function wn(e,t){if(e==null)return{};var n,r,i=Cn(e,t);if(Object.getOwnPropertySymbols){var a=Object.getOwnPropertySymbols(e);for(r=0;r<a.length;r++)n=a[r],t.includes(n)||{}.propertyIsEnumerable.call(e,n)&&(i[n]=e[n])}return i}var Tn=[`rebuilder`],En=class{constructor(e={}){T(this,`src_Any`,x.source),T(this,`src_Cc`,ne.source),T(this,`src_Z`,ae.source),T(this,`src_P`,S.source),T(this,`src_ZPCc`,[this.src_Z,this.src_P,this.src_Cc].join(`|`)),T(this,`src_ZCc`,[this.src_Z,this.src_Cc].join(`|`)),T(this,`cache`,{}),T(this,`opts`,{maxLength:1e4,urlAuth:!1,schema_names:[]}),this.opts=q(q({},this.opts),e)}set(e={}){return this.opts=q(q({},this.opts),e),this.cache={},this}escapeRE(e){return e.replace(/[.?*+^$[\]\\(){}|-]/g,`\\$&`)}nestedPairRE(e,t,n=4){let r=this.escapeRE(e),i=this.escapeRE(t),a=`(?:(?!${this.src_ZCc}|${r}|${i}).)`,o=`${r}${a}{0,1000}${i}`;for(let e=2;e<=n;e++)o=`${r}(?:${a}|${o}){0,1000}${i}`;return o}get_text_separators(){var e,t;return(t=(e=this.cache).text_separators)==null?e.text_separators=/[><\uff5c]/:t}get_pseudo_letter(){var e,t;return(t=(e=this.cache).src_pseudo_letter)==null?e.src_pseudo_letter=RegExp(`(?:(?!${this.get_text_separators().source}|${this.src_ZPCc})${this.src_Any})`):t}get_ipv4_addr(){var e,t;return(t=(e=this.cache).src_ip4)==null?e.src_ip4=RegExp(`(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])[.]){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])`):t}get_ipv6_addr(){var e,t;let n=`[0-9A-Fa-f]{1,4}`,r=`(?:(?:${n}:${n})|${this.get_ipv4_addr().source})`;return(t=(e=this.cache).src_ip6_addr)==null?e.src_ip6_addr=RegExp(`(?:(?:${n}:){6}${r}|::(?:${n}:){5}${r}|(?:${n})?::(?:${n}:){4}${r}|(?:(?:${n}:){0,1}${n})?::(?:${n}:){3}${r}|(?:(?:${n}:){0,2}${n})?::(?:${n}:){2}${r}|(?:(?:${n}:){0,3}${n})?::${n}:${r}|(?:(?:${n}:){0,4}${n})?::${r}|(?:(?:${n}:){0,5}${n})?::${n}|(?:(?:${n}:){0,6}${n})?::)`):t}get_ipv6_url_host(){var e,t;return(t=(e=this.cache).src_ip6_host)==null?e.src_ip6_host=RegExp(`\\[${this.get_ipv6_addr().source}\\]`):t}get_ipv6_mail_host(){var e,t;return(t=(e=this.cache).src_ipv6_mail_host)==null?e.src_ipv6_mail_host=RegExp(`\\[IPv6:${this.get_ipv6_addr().source}\\]`):t}get_auth(){var e,t;return(t=(e=this.cache).src_auth)==null?e.src_auth=RegExp(`(?:(?:(?!${this.src_ZCc}|[@/\\[\\]()]).){1,50}@)?`):t}get_port(){var e,t;return(t=(e=this.cache).src_port)==null?e.src_port=RegExp(`(?::(?:6(?:[0-4]\\d{3}|5(?:[0-4]\\d{2}|5(?:[0-2]\\d|3[0-5])))|[1-5]?\\d{1,4}))?`):t}get_host_terminator(){var e,t;return(t=(e=this.cache).src_host_terminator)==null?e.src_host_terminator=RegExp(`(?=$|${this.get_text_separators().source}|${this.src_ZPCc})(?!${this.opts[`---`]?`-(?!--)|`:`-|`}_|:\\d|\\.-|\\.(?!$|${this.src_ZPCc}))`):t}get_path_terminator(){var e,t;return(t=(e=this.cache).src_path_terminator)==null?e.src_path_terminator=RegExp(`${this.src_ZPCc}|${this.get_text_separators().source}`):t}get_path(){var e,t;return(t=(e=this.cache).src_path)==null?e.src_path=RegExp(`(?:[/?#](?:${this.nestedPairRE(`[`,`]`)}|${this.nestedPairRE(`(`,`)`)}|${this.nestedPairRE(`{`,`}`)}|\\"(?:(?!${this.src_ZCc}|["]).){1,100}\\"|\\'(?:(?!${this.src_ZCc}|[']).){1,100}\\'|\\'(?=${this.get_pseudo_letter().source}|[-])|\\.{2,20}[:]?[a-zA-Z0-9%/&]|\\.(?!${this.src_ZCc}|[.]|$)|`+(this.opts[`---`]?`\\-(?!--(?:[^-]|$))(?:-{0,19})|`:`\\-{1,20}|`)+`,(?!${this.src_ZCc}|$)|;(?!${this.src_ZCc}|$)|\\!{1,20}(?!${this.src_ZCc}|[!]|$)|\\?(?!${this.src_ZCc}|[?]|$)|`+this.get_path_extra().source+`[\\\\/:%@#&=_~*]|(?!${this.get_path_terminator().source}).){1,${this.opts.maxLength}}|\\/)?`):t}get_mail_name(){var e,t;return(t=(e=this.cache).src_mail_name)==null?e.src_mail_name=RegExp("[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9](?:[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9]|[.](?=[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9])){0,63}"):t}get_xn(){var e,t;return(t=(e=this.cache).src_xn)==null?e.src_xn=RegExp(`xn--[a-z0-9\\-]{1,59}`):t}get_tld(){if(this.cache.tld)return this.cache.tld;let e=[...new Set(this.opts.tlds||[])].sort().reverse().join(`|`);return this.cache.tld=RegExp(`${e||`$#none#$`}|${this.get_xn().source}`),this.cache.tld}get_domain_root(){var e,t;return(t=(e=this.cache).src_domain_root)==null?e.src_domain_root=RegExp(`(?:`+this.get_xn().source+`|${this.get_pseudo_letter().source}{1,63})`):t}get_domain(){var e,t;return(t=(e=this.cache).src_domain)==null?e.src_domain=RegExp(`(?:`+this.get_xn().source+`|(?:${this.get_pseudo_letter().source})|(?:${this.get_pseudo_letter().source}(?:-|${this.get_pseudo_letter().source}){0,61}${this.get_pseudo_letter().source}))`):t}get_url_host_port(){var e,t;return(t=(e=this.cache).url_host_port)==null?e.url_host_port=RegExp(`(?:`+this.get_ipv6_url_host().source+`|(?:(?:(?:${this.get_domain().source})\\.){0,10}${this.get_domain().source}))`+this.get_port().source+this.get_host_terminator().source):t}get_fuzzy_url_host_port(){var e,t;return(t=(e=this.cache).fuzzy_url_host_port)==null?e.fuzzy_url_host_port=RegExp(`(?:`+(this.opts.fuzzyIP?this.get_ipv4_addr().source+`|`:``)+`(?:(?:(?:${this.get_domain().source})\\.){1,10}(?:${this.get_tld().source})))`+this.get_host_terminator().source):t}get_mail_host(){var e,t;return(t=(e=this.cache).src_mail_host)==null?e.src_mail_host=RegExp(`(?:`+this.get_ipv6_mail_host().source+`|(?:(?:(?:${this.get_domain().source})\\.){0,4}${this.get_domain().source}))`+this.get_host_terminator().source):t}get_fuzzy_mail_host(){var e,t;return(t=(e=this.cache).src_fuzzy_mail_host)==null?e.src_fuzzy_mail_host=RegExp(`(?:`+this.get_ipv6_mail_host().source+`|(?:(?:(?:${this.get_domain().source})[.]){1,4}${this.get_domain_root().source}))`+this.get_host_terminator().source):t}get_path_extra(){var e,t;return(t=(e=this.cache).src_path_extra)==null?e.src_path_extra=RegExp(``):t}get_fuzzy_mail_host_search(){var e,t;return(t=(e=this.cache).mail_fuzzy_host_search)==null?e.mail_fuzzy_host_search=RegExp(`@${this.get_fuzzy_mail_host().source}`,`ig`):t}get_fuzzy_link_search(){var e,t;return(t=(e=this.cache).link_fuzzy_search)==null?e.link_fuzzy_search=RegExp(`(^|(?![.:/\\-_@])(?:[$+<=>^\`|\uff5c]|${this.src_ZPCc}))(?:(?![$+<=>^\`|\uff5c])${this.get_fuzzy_url_host_port().source}${this.get_path().source})`,`ig`):t}get_http_validator(){var e,t;return(t=(e=this.cache).http_validator)==null?e.http_validator=RegExp(`\\/\\/`+(this.opts.urlAuth?this.get_auth().source:``)+this.get_url_host_port().source+this.get_path().source,`iy`):t}get_relative_proto_validator(){var e,t;return(t=(e=this.cache).relative_proto_validator)==null?e.relative_proto_validator=RegExp((this.opts.urlAuth?this.get_auth().source:``)+`(?:localhost|${this.get_ipv6_url_host().source}|(?:(?:${this.get_domain().source})[.]){1,10}${this.get_domain_root().source})`+this.get_port().source+this.get_host_terminator().source+this.get_path().source,`iy`):t}get_mail_name_validator(){var e,t;return(t=(e=this.cache).mail_name_validator)==null?e.mail_name_validator=RegExp(`(?:^|${this.get_text_separators().source}|"|\\(|${this.src_ZCc})(${this.get_mail_name().source})$`):t}get_mailto_validator(){var e,t;return(t=(e=this.cache).mailto_validator)==null?e.mailto_validator=RegExp(`${this.get_mail_name().source}@${this.get_mail_host().source}`,`iy`):t}get_schema_names(){var e,t;return(t=(e=this.cache).schema_names)==null?e.schema_names=new RegExp((this.opts.schema_names||[]).map(e=>this.escapeRE(e)).join(`|`)):t}get_schema_search(){var e,t;return(t=(e=this.cache).schema_search)==null?e.schema_search=RegExp(`(^|(?!_)(?:[><\uff5c]|${this.src_ZPCc}))(${this.get_schema_names().source})`,`ig`):t}get_schema_at_start(){var e,t;return(t=(e=this.cache).schema_at_start)==null?e.schema_at_start=RegExp(`^${this.get_schema_search().source}`,`i`):t}},Dn={validate:(e,t,n)=>{let r=n.re.get_http_validator();r.lastIndex=t;let i=r.exec(e);return i?i[0].length:0},normalize:(e,t)=>t.normalize(e)},On={"http:":Dn,"https:":Dn,"ftp:":Dn,"//":{validate:function(e,t,n){let r=n.re.get_relative_proto_validator();r.lastIndex=t;let i=r.exec(e);return i?t>=3&&e[t-3]===`:`||t>=3&&e[t-3]===`/`?0:i[0].length:0},normalize:(e,t)=>t.normalize(e)},"mailto:":{validate:function(e,t,n){let r=n.re.get_mailto_validator();r.lastIndex=t;let i=r.exec(e);return i?i[0].length:0},normalize:(e,t)=>t.normalize(e)}},kn=`a:cdefgilmnoqrstuwxz|b:abdefghijmnorstvwyz|c:acdfghiklmnoruvwxyz|d:ejkmoz|e:cegrstu|f:ijkmor|g:abdefghilmnpqrstuwy|h:kmnrtu|i:delmnoqrst|j:emop|k:eghimnprwyz|l:abcikrstuvy|m:acdeghklmnopqrstuvwxyz|n:acefgilopruz|o:m|p:aefghklmnrstwy|q:a|r:eosuw|s:abcdeghijklmnortuvxyz|t:cdfghjklmnortvwz|u:agksyz|v:aceginu|w:fs|y:et|z:amw`,An=`biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф`;function jn(){let e=An.split(`|`);return kn.split(`|`).forEach(t=>{let n=t.indexOf(`:`),r=t.slice(0,n);for(let i of t.slice(n+1))e.push(r+i)}),e}var Mn={fuzzyLink:!1,fuzzyEmail:!0,fuzzyIP:!1,"---":!1,tlds:jn(),urlAuth:!1,maxLength:1e4},Nn=class{constructor(e,t,n,r){T(this,`schema`,void 0),T(this,`index`,void 0),T(this,`lastIndex`,void 0),T(this,`raw`,void 0),T(this,`text`,void 0),T(this,`url`,void 0);let i=e.slice(n,r);this.schema=t.toLowerCase(),this.index=n,this.lastIndex=r,this.raw=i,this.text=i,this.url=i}},Pn=class{constructor(e={}){T(this,`__opts__`,void 0),T(this,`__schemas__`,void 0),T(this,`re`,void 0);let{rebuilder:t}=e,n=wn(e,Tn);this.__opts__=q(q({},Mn),n),this.__schemas__=q({},On),this.re=t||new En,this.re.set(q(q({},this.__opts__),{},{schema_names:Object.keys(this.__schemas__)}))}add(e,t=null){if(!t)delete this.__schemas__[e];else{let n=q({normalize:(e,t)=>t.normalize(e)},t);this.__schemas__[e]=n}return this.re.set(q(q({},this.__opts__),{},{schema_names:Object.keys(this.__schemas__)})),this}set(e={}){return this.__opts__=q(q({},this.__opts__),e),this.re.set(q(q({},this.__opts__),{},{schema_names:Object.keys(this.__schemas__)})),this}test(e){if(!e.length)return!1;let t,n;for(n=this.re.get_schema_search(),n.lastIndex=0;(t=n.exec(e))!==null;)if(this.testSchemaAt(e,t[2],n.lastIndex))return!0;if(this.__opts__.fuzzyLink&&this.__schemas__[`http:`]&&(n=this.re.get_fuzzy_link_search(),n.lastIndex=0,n.exec(e)!==null))return!0;if(this.__opts__.fuzzyEmail&&this.__schemas__[`mailto:`]&&e.indexOf(`@`)>=0){let n=this.re.get_fuzzy_mail_host_search(),r=this.re.get_mail_name_validator();for(n.lastIndex=0;(t=n.exec(e))!==null;){let n=e.slice(Math.max(0,t.index-65),t.index);if(r.test(n))return!0}}return!1}testSchemaAt(e,t,n){return this.__schemas__[t.toLowerCase()]?this.__schemas__[t.toLowerCase()].validate(e.slice(0,n+this.__opts__.maxLength),n,this):0}match(e){let t=[],n=this.re.get_schema_search(),r,i,a,o,s,c,l=!1,u=!1,d=!1,f=0;if(!e.length)return null;for(n.lastIndex=0,this.__opts__.fuzzyLink&&this.__schemas__[`http:`]&&(r=this.re.get_fuzzy_link_search(),r.lastIndex=0),this.__opts__.fuzzyEmail&&this.__schemas__[`mailto:`]&&(i=this.re.get_fuzzy_mail_host_search(),i.lastIndex=0,a=this.re.get_mail_name_validator());;){let p=Math.max(f-1,0);if(i&&a&&!d&&(!s||s.index<f))for(i.lastIndex<p&&(i.lastIndex=p);;){let t=i.exec(e);if(!t){d=!0,s=void 0;break}let n=a.exec(e.slice(Math.max(0,t.index-65),t.index));if(n){if(s={schema:`mailto:`,index:t.index-n[1].length,lastIndex:t.index+t[0].length},s.index>=f)break;i.lastIndex<p&&(i.lastIndex=p)}}if(r&&!u&&(!o||o.index<f))for(r.lastIndex<p&&(r.lastIndex=p);;){let t=r.exec(e);if(!t){u=!0,o=void 0;break}if(o={schema:``,index:t.index+t[1].length,lastIndex:t.index+t[0].length},o.index>=f)break;r.lastIndex<p&&(r.lastIndex=p)}let m=s;(!m||o&&(o.index<m.index||o.index===m.index&&o.lastIndex>m.lastIndex))&&(m=o);let h;if(!l)for(;;){if(!c){n.lastIndex<p&&(n.lastIndex=p);let t=n.exec(e);if(!t){l=!0;break}c={schema:t[2],index:t.index+t[1].length,lastIndex:t.index+t[0].length}}if(c.index<f){c=void 0;continue}if(m&&c.index>m.index)break;let t=c;c=void 0;let r=this.testSchemaAt(e,t.schema,t.lastIndex);if(r){h={schema:t.schema,index:t.index,lastIndex:t.lastIndex+r};break}}let g=h;if((!g||s&&(s.index<g.index||s.index===g.index&&s.lastIndex>g.lastIndex))&&(g=s),(!g||o&&(o.index<g.index||o.index===g.index&&o.lastIndex>g.lastIndex))&&(g=o),!g)break;g===s?s=void 0:g===o&&(o=void 0);let _=new Nn(e,g.schema,g.index,g.lastIndex);_.schema?this.__schemas__[_.schema].normalize(_,this):this.normalize(_),t.push(_),f=g.lastIndex}return t.length?t:null}matchAtStart(e){if(!e.length)return null;let t=this.re.get_schema_at_start().exec(e);if(!t)return null;let n=this.testSchemaAt(e,t[2],t[0].length);if(!n)return null;let r=new Nn(e,t[2],t.index+t[1].length,t.index+t[0].length+n);return this.__schemas__[r.schema].normalize(r,this),r}tlds(e,t=!1){return e=Array.isArray(e)?e:[e],t?this.__opts__.tlds=this.__opts__.tlds.concat(e):this.__opts__.tlds=e,this.re.set(q(q({},this.__opts__),{},{schema_names:Object.keys(this.__schemas__)})),this}normalize(e){e.schema||(e.url=`http://${e.url}`),e.schema===`mailto:`&&!/^mailto:/i.test(e.url)&&(e.url=`mailto:${e.url}`)}},J=2147483647,Y=36,Fn=1,X=26,In=38,Ln=700,Rn=72,zn=128,Bn=`-`,Vn=/^xn--/,Hn=/[^\0-\x7F]/,Un=/[\x2E\u3002\uFF0E\uFF61]/g,Wn={overflow:`Overflow: input needs wider integers to process`,"not-basic":`Illegal input >= 0x80 (not a basic code point)`,"invalid-input":`Invalid input`},Gn=35,Z=Math.floor,Kn=String.fromCharCode;function Q(e){throw RangeError(Wn[e])}function qn(e,t){let n=[],r=e.length;for(;r--;)n[r]=t(e[r]);return n}function Jn(e,t){let n=e.split(`@`),r=``;n.length>1&&(r=n[0]+`@`,e=n[1]),e=e.replace(Un,`.`);let i=qn(e.split(`.`),t).join(`.`);return r+i}function Yn(e){let t=[],n=0,r=e.length;for(;n<r;){let i=e.charCodeAt(n++);if(i>=55296&&i<=56319&&n<r){let r=e.charCodeAt(n++);(r&64512)==56320?t.push(((i&1023)<<10)+(r&1023)+65536):(t.push(i),n--)}else t.push(i)}return t}var Xn=e=>String.fromCodePoint(...e),Zn=function(e){return e>=48&&e<58?26+(e-48):e>=65&&e<91?e-65:e>=97&&e<123?e-97:Y},Qn=function(e,t){return e+22+75*(e<26)-((t!=0)<<5)},$n=function(e,t,n){let r=0;for(e=n?Z(e/Ln):e>>1,e+=Z(e/t);e>455;r+=Y)e=Z(e/Gn);return Z(r+36*e/(e+In))},er=function(e){let t=[],n=e.length,r=0,i=zn,a=Rn,o=e.lastIndexOf(Bn);o<0&&(o=0);for(let n=0;n<o;++n)e.charCodeAt(n)>=128&&Q(`not-basic`),t.push(e.charCodeAt(n));for(let s=o>0?o+1:0;s<n;){let o=r;for(let t=1,i=Y;;i+=Y){s>=n&&Q(`invalid-input`);let o=Zn(e.charCodeAt(s++));o>=Y&&Q(`invalid-input`),o>Z((J-r)/t)&&Q(`overflow`),r+=o*t;let c=i<=a?Fn:i>=a+X?X:i-a;if(o<c)break;let l=Y-c;t>Z(J/l)&&Q(`overflow`),t*=l}let c=t.length+1;a=$n(r-o,c,o==0),Z(r/c)>J-i&&Q(`overflow`),i+=Z(r/c),r%=c,t.splice(r++,0,i)}return String.fromCodePoint(...t)},tr=function(e){let t=[];e=Yn(e);let n=e.length,r=zn,i=0,a=Rn;for(let n of e)n<128&&t.push(Kn(n));let o=t.length,s=o;for(o&&t.push(Bn);s<n;){let n=J;for(let t of e)t>=r&&t<n&&(n=t);let c=s+1;n-r>Z((J-i)/c)&&Q(`overflow`),i+=(n-r)*c,r=n;for(let n of e)if(n<r&&++i>J&&Q(`overflow`),n===r){let e=i;for(let n=Y;;n+=Y){let r=n<=a?Fn:n>=a+X?X:n-a;if(e<r)break;let i=e-r,o=Y-r;t.push(Kn(Qn(r+i%o,0))),e=Z(i/o)}t.push(Kn(Qn(e,0))),a=$n(i,c,s===o),i=0,++s}++i,++r}return t.join(``)},nr={version:`2.3.1`,ucs2:{decode:Yn,encode:Xn},decode:er,encode:tr,toASCII:function(e){return Jn(e,function(e){return Hn.test(e)?`xn--`+tr(e):e})},toUnicode:function(e){return Jn(e,function(e){return Vn.test(e)?er(e.slice(4).toLowerCase()):e})}},rr={default:{options:{html:!1,xhtmlOut:!1,breaks:!1,langPrefix:`language-`,linkify:!1,typographer:!1,quotes:`“”‘’`,highlight:null,maxNesting:100},components:{core:{},block:{},inline:{}}},zero:{options:{html:!1,xhtmlOut:!1,breaks:!1,langPrefix:`language-`,linkify:!1,typographer:!1,quotes:`“”‘’`,highlight:null,maxNesting:20},components:{core:{rules:[`normalize`,`block`,`strip_references`,`inline`,`text_join`]},block:{rules:[`paragraph`]},inline:{rules:[`text`],rules2:[`balance_pairs`,`fragments_join`]}}},commonmark:{options:{html:!0,xhtmlOut:!0,breaks:!1,langPrefix:`language-`,linkify:!1,typographer:!1,quotes:`“”‘’`,highlight:null,maxNesting:20},components:{core:{rules:[`normalize`,`block`,`strip_references`,`inline`,`text_join`]},block:{rules:[`blockquote`,`code`,`fence`,`heading`,`hr`,`html_block`,`lheading`,`list`,`reference`,`paragraph`]},inline:{rules:[`autolink`,`backticks`,`emphasis`,`entity`,`escape`,`html_inline`,`image`,`link`,`newline`,`text`],rules2:[`balance_pairs`,`emphasis`,`fragments_join`]}}}},ir=/^(vbscript|javascript|file|data):/,ar=/^data:image\/(gif|png|jpeg|webp);/,or=[`http:`,`https:`,`mailto:`],$=class{validateLink(e){let t=e.trim().toLowerCase();return!ir.test(t)||ar.test(t)}normalizeLink(e){let t=b(e,!0);if(t.hostname&&(!t.protocol||or.indexOf(t.protocol)>=0))try{t.hostname=nr.toASCII(t.hostname)}catch(e){}return s(c(t))}normalizeLinkText(e){let t=b(e,!0);if(t.hostname&&(!t.protocol||or.indexOf(t.protocol)>=0))try{t.hostname=nr.toUnicode(t.hostname)}catch(e){}return i(c(t),i.defaultChars+`%`)}constructor(...e){T(this,`inline`,new xn),T(this,`block`,new zt),T(this,`core`,new gt),T(this,`renderer`,new Ue),T(this,`linkify`,new Pn),T(this,`utils`,xe),T(this,`helpers`,Object.assign({},He));let[t,n]=e;typeof t==`string`?(this.configure(t),n&&this.set(n)):(this.configure(`default`),this.set(t||{}))}set(e){return Object.assign(this.options,e),this}configure(e){let t;if(typeof e==`string`){let n=e;if(t=rr[n],!t)throw Error(`Wrong 'markdown-it' preset "${n}", check name`)}else t=e;if(!t)throw Error("Wrong `markdown-it` preset, can't be empty");t.options&&(this.options=q({},t.options));let n=t.components;if(n){var r;[`core`,`block`,`inline`].forEach(e=>{var t;let r=(t=n[e])==null?void 0:t.rules;r&&this[e].ruler.enableOnly(r)});let e=(r=n.inline)==null?void 0:r.rules2;e&&this.inline.ruler2.enableOnly(e)}return this}enable(e,t=!1){let n=[];Array.isArray(e)||(e=[e]),[`core`,`block`,`inline`].forEach(t=>{n=n.concat(this[t].ruler.enable(e,!0))}),n=n.concat(this.inline.ruler2.enable(e,!0));let r=e.filter(e=>n.indexOf(e)<0);if(r.length&&!t)throw Error(`MarkdownIt. Failed to enable unknown rule(s): ${r}`);return this}disable(e,t=!1){let n=[];Array.isArray(e)||(e=[e]),[`core`,`block`,`inline`].forEach(t=>{n=n.concat(this[t].ruler.disable(e,!0))}),n=n.concat(this.inline.ruler2.disable(e,!0));let r=e.filter(e=>n.indexOf(e)<0);if(r.length&&!t)throw Error(`MarkdownIt. Failed to disable unknown rule(s): ${r}`);return this}use(e,...t){return e.apply(e,[this,...t]),this}parse(e,t){if(typeof e!=`string`)throw Error(`Input data should be a String`);let n=new this.core.State(e,this,t);return this.core.process(n),n.tokens}render(e,t={}){return this.renderer.render(this.parse(e,t),this.options,t)}parseInline(e,t){let n=new this.core.State(e,this,t);return n.inlineMode=!0,this.core.process(n),n.tokens}renderInline(e,t={}){return this.renderer.render(this.parseInline(e,t),this.options,t)}};return T($,`Token`,z),T($,`Ruler`,B),T($,`Renderer`,Ue),T($,`ParserCore`,gt),T($,`StateCore`,We),T($,`ParserBlock`,zt),T($,`StateBlock`,_t),T($,`ParserInline`,xn),T($,`StateInline`,Bt),Se($)});
//# sourceMappingURL=markdown-it.umd.min.js.map
          return module.exports
        })()
        // ==== end markdown-it vendored ====
        // Fenced-code languages: aliases users actually write in ```info
        // strings, mapped onto the shared LANG_BY_EXT ids.
        const MD_LANG_ALIAS = { python:'python', py:'python', javascript:'javascript', js:'javascript', typescript:'typescript', ts:'typescript', 'c++':'cpp', cpp:'cpp', csharp:'csharp', cs:'csharp', 'c#':'csharp', golang:'go', go:'go', rust:'rust', rs:'rust', ruby:'ruby', rb:'ruby', php:'php', swift:'swift', kotlin:'kotlin', kt:'kotlin', bash:'bash', shell:'bash', sh:'bash', zsh:'bash', powershell:'powershell', ps1:'powershell', sql:'sql', json:'json', yaml:'yaml', yml:'yaml', toml:'toml', xml:'xml', html:'html', css:'css', markdown:'markdown', md:'markdown', java:'java', r:'r' }
        const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
        // Code fences reuse the code view's line tokenizer (24 languages,
        // theme-token palette) — no second highlighter to maintain.
        const mdHighlight = (str, lang) => {
          const l = (lang && (MD_LANG_ALIAS[String(lang).toLowerCase()] || LANG_BY_EXT[String(lang).toLowerCase()])) || null
          if (!l) return '' // markdown-it falls back to its default escaped <pre><code>
          const state = { mode: null }
          const lines = String(str).replace(/\n$/, '').split('\n')
          let out = ''
          for (const line of lines) {
            const toks = lineTokensCached(line, l, state)
            if (toks) out += toks.map((t) => '<span class="dsh-fe-tk' + (t.c ? ' dsh-fe-tk-' + t.c : '') + '">' + escHtml(t.t) + '</span>').join('')
            else out += escHtml(line)
            out += '\n'
          }
          return '<pre class="dsh-fe-md-pre"><code class="dsh-fe-md-code">' + out + '</code></pre>'
        }
        const mdParser = new MarkdownIt({ html: false, linkify: true, highlight: mdHighlight })
        const renderMarkdown = (text) => mdParser.render(text || '')

        // ---------- user edit engine (v1.13) ----------
        // Line-based edit model with its OWN undo/redo stacks, fully isolated
        // from the browser's native undo: ctrl+z / ctrl+y / ctrl+shift+z are
        // intercepted with preventDefault + stopPropagation, so page/dialog
        // text is never affected. Edits are minimal text patches
        // {line, start, removed, inserted} applied in order; rebuild replays
        // them over the origin lines into a renderable row list whose rows
        // keep their origin-line attribution, so diff hunks keep interleaving
        // correctly even after the user inserted/deleted lines. The model is
        // keyed by (workspace root, relative path) and persisted to
        // localStorage — closing/reopening a tab, switching sessions and
        // restarting the harness all resume undo/redo (requirement 4).
        const EDIT_KEY_PREFIX = 'dsh-fe-edit-v1:'
        const MAX_PERSIST_BYTES = 2600000
        const MAX_UNDO_ENTRIES = 400
        const persistTimers = new Map()
        const editModels = new Map()

        function fpOf(lines) {
          // 32-bit FNV-1a over the joined text — cheap content fingerprint
          // for external-change detection and persistence reconciliation.
          let h = 0x811c9dc5
          const s = lines.join('\n')
          for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i)
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
          }
          return h >>> 0
        }
        function editKeyOf(root, path) {
          return EDIT_KEY_PREFIX + String(root || '') + '\u0001' + String(path || '')
        }
        function nameOf(path) {
          return String(path || '').split('/').pop()
        }

        // Apply one patch to a row list (rows = {origin, text}; origin = the
        // origin-line index a row stems from, -1 for the empty-file
        // placeholder). `verify` fails the application when the removed text
        // is not at the position — used by the merge-after-AI-edit replay.
        function applyPatchToRows(rows, p, verify) {
          if (!Number.isInteger(p.line) || p.line < 0 || p.line >= rows.length) return false
          const row = rows[p.line]
          const start = Math.max(0, Math.min(row.text.length, Number.isInteger(p.start) ? p.start : row.text.length))
          const removed = String(p.removed || '')
          const inserted = String(p.inserted || '')
          const head = row.text.slice(0, start)
          const firstTake = Math.min(removed.length, row.text.length - start)
          const consumed = [row.text.slice(start, start + firstTake)]
          let remaining = removed.length - firstTake
          let endIdx = p.line
          let tail = remaining === 0 ? row.text.slice(start + removed.length) : ''
          let valid = true
          while (remaining > 0) {
            if (endIdx + 1 >= rows.length) { remaining = 0; valid = false; break }
            consumed.push('\n')
            remaining--
            endIdx++
            const r2 = rows[endIdx]
            const take = Math.min(remaining, r2.text.length)
            consumed.push(r2.text.slice(0, take))
            remaining -= take
            tail = take < r2.text.length ? r2.text.slice(take) : ''
          }
          if (verify && (consumed.join('') !== removed || !valid)) return false
          const parts = (head + inserted + tail).split('\n')
          const originIdx = row.origin
          rows.splice(p.line, endIdx - p.line + 1, ...parts.map((t) => ({ origin: originIdx, text: t })))
          return true
        }

        function rebuildModel(m) {
          let rows = (m.origin || []).map((t, i) => ({ origin: i, text: String(t) }))
          if (rows.length === 0) rows.push({ origin: -1, text: '' })
          // Verify every patch too: a malformed entry must be SKIPPED, never
          // corrupt the document (replay uses the same rule).
          for (const e of m.undo) for (const p of e.patches) applyPatchToRows(rows, p, true)
          const lines = rows.map((r) => r.text)
          const map = new Array(m.origin.length).fill(-1)
          for (let k = 0; k < rows.length; k++) {
            const r = rows[k]
            r.model = k
            if (r.origin >= 0 && r.origin < map.length && map[r.origin] < 0) map[r.origin] = k
          }
          m.lines = lines
          m.rows = rows
          m.map = map
        }

        function createModel(root, path, origin) {
          const m = {
            root: root || '', path: path, key: editKeyOf(root, path),
            origin: (origin || []).slice(),
            undo: [], redo: [],
            savedFp: fpOf(origin || []), savedLines: (origin || []).slice(), savedUndoLen: 0,
            diskFp: fpOf(origin || []), hostRev: null,
            version: 0, dirty: false, persistable: true,
            lines: [], rows: [], map: [],
            rowEls: new Map(), activeIdx: null, pendingCaret: null, lastCol: 0,
            subs: new Set(),
          }
          rebuildModel(m)
          return m
        }

        function persistNow(m) {
          if (!m.persistable) return
          try {
            const s = JSON.stringify({
              v: 1, origin: m.origin, originLen: m.origin.length,
              originBytes: m.origin.join('\n').length,
              savedUndoLen: m.savedUndoLen || 0,
              undo: m.undo, redo: m.redo,
            })
            if (s.length > MAX_PERSIST_BYTES) { m.persistable = false; return }
            localStorage.setItem(m.key, s)
          } catch (e) {}
        }
        function persistSoon(m) {
          const h = persistTimers.get(m.key)
          if (h) { try { h() } catch (e) {} }
          persistTimers.set(m.key, ctx.timeout(() => { persistTimers.delete(m.key); persistNow(m) }, 800))
        }
        function loadPersisted(key) {
          try {
            const raw = localStorage.getItem(key)
            if (!raw) return null
            const d = JSON.parse(raw)
            if (!d || d.v !== 1 || !Array.isArray(d.origin)) return null
            return d
          } catch (e) { return null }
        }
        function removePersisted(key) {
          try { localStorage.removeItem(key) } catch (e) {}
          const h = persistTimers.get(key)
          if (h) { try { h() } catch (e) {} }
          persistTimers.delete(key)
        }
        function restoreModel(root, path, origin, stored) {
          const m = createModel(root, path, origin)
          const valid = (e) => e && Array.isArray(e.patches) && e.patches.length > 0
          m.undo = Array.isArray(stored.undo) ? stored.undo.filter(valid).slice(-MAX_UNDO_ENTRIES) : []
          m.redo = Array.isArray(stored.redo) ? stored.redo.filter(valid) : []
          m.savedUndoLen = typeof stored.savedUndoLen === 'number' ? Math.max(0, Math.min(m.undo.length, stored.savedUndoLen)) : 0
          // Reconstruct the save-point content from the entries below the save
          // marker, then re-derive the fingerprint (self-consistent).
          const tmp = replayWithConflicts(origin, m.undo.slice(0, m.savedUndoLen))
          m.savedLines = tmp.lines
          m.savedFp = fpOf(m.savedLines)
          rebuildModel(m)
          m.dirty = fpOf(m.lines) !== m.savedFp
          return m
        }

        function afterModelChange(m) {
          rebuildModel(m)
          m.dirty = fpOf(m.lines) !== m.savedFp
          m.version++
          store.setDirty(m.path, m.dirty)
          persistSoon(m)
          notifyModelSubs(m)
        }
        function notifyModelSubs(m) {
          m.version++
          const subs = Array.from(m.subs)
          for (const f of subs) { try { f() } catch (e) {} }
        }

        // Requirement 5: a new edit after undo abandons the redo branch.
        function pushEntry(m, patches, line, pos) {
          if (!patches || patches.length === 0) return
          m.redo = []
          m.undo.push({ patches: patches, line: line, pos: pos })
          if (m.undo.length > MAX_UNDO_ENTRIES) {
            m.undo.shift()
            if (m.savedUndoLen !== undefined && m.savedUndoLen > 0) m.savedUndoLen--
          }
          afterModelChange(m)
        }

        // ---------- DOM / caret helpers ----------
        function offsetInEl(el, node, offset) {
          if (!el) return 0
          if (node === el) {
            let pos = 0
            const cn = el.childNodes
            const upto = Math.min(offset, cn.length)
            for (let k = 0; k < upto; k++) pos += (cn[k].textContent || '').length
            return pos
          }
          let pos = 0
          let found = false
          const walk = (n) => {
            if (found) return
            if (n === node) { pos += offset; found = true; return }
            if (n.nodeType === 3) pos += n.textContent.length
            else { for (const c of n.childNodes) { walk(c); if (found) return } }
          }
          for (const c of el.childNodes) { walk(c); if (found) break }
          return pos
        }
        function selectionOffsetIn(el) {
          try {
            const sel = window.getSelection && window.getSelection()
            if (!sel || sel.rangeCount === 0) return 0
            return offsetInEl(el, sel.anchorNode, sel.anchorOffset)
          } catch (e) { return 0 }
        }
        function setCaretEl(el, pos) {
          try {
            el.focus({ preventScroll: true })
            const sel = window.getSelection && window.getSelection()
            if (!sel) return
            sel.removeAllRanges()
            const range = document.createRange()
            let remaining = Math.max(0, pos)
            let node = null
            let offset = 0
            const walk = (n) => {
              if (node) return
              if (n.nodeType === 3) {
                if (n.textContent.length >= remaining) { node = n; offset = remaining }
                else remaining -= n.textContent.length
              } else { for (const c of n.childNodes) { walk(c); if (node) return } }
            }
            for (const c of el.childNodes) { walk(c); if (node) break }
            if (node) { range.setStart(node, offset); range.collapse(true) }
            else { range.selectNodeContents(el); range.collapse(false) }
            sel.addRange(range)
          } catch (e) {}
        }
        function caretModelPos(m) {
          try {
            const sel = window.getSelection && window.getSelection()
            if (!sel || sel.rangeCount === 0) return null
            const anchor = sel.anchorNode
            let el = anchor
            if (el && el.nodeType !== 1) el = el.parentElement
            if (!el || !el.getAttribute || el.getAttribute('data-m') === null) return null
            const rowIdx = Number(el.getAttribute('data-m'))
            if (!Number.isInteger(rowIdx)) return null
            return { row: rowIdx, pos: offsetInEl(el, anchor, sel.anchorOffset) }
          } catch (e) { return null }
        }
        function rowOfNodeEl(node) {
          let el = node
          if (el && el.nodeType !== 1) el = el.parentElement
          if (!el || !el.getAttribute || el.getAttribute('data-m') === null) return null
          const v = Number(el.getAttribute('data-m'))
          return Number.isInteger(v) ? { el: el, row: v } : null
        }
        function rowSelection(m) {
          const info = caretModelPos(m)
          if (!info) return null
          try {
            const sel = window.getSelection && window.getSelection()
            if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
              const a = rowOfNodeEl(sel.anchorNode)
              const f = rowOfNodeEl(sel.focusNode)
              if (a && f && a.row !== f.row) {
                return { start: Math.min(a.row, f.row), end: Math.max(a.row, f.row), caret: info }
              }
            }
          } catch (e) {}
          return { start: info.row, end: info.row, caret: info }
        }

        // Commit the DOM text of one row into the model as a minimal patch.
        function flushLine(m, idx) {
          const el = m.rowEls.get(idx)
          if (!el) return null
          const text = String(el.textContent || '').replace(/\r/g, '')
          const cur = idx >= 0 && idx < m.lines.length ? m.lines[idx] : ''
          if (text === cur) return null
          let p = 0
          const max = Math.min(text.length, cur.length)
          while (p < max && text[p] === cur[p]) p++
          let s1 = text.length
          let s2 = cur.length
          while (s1 > p && s2 > p && text[s1 - 1] === cur[s2 - 1]) { s1--; s2-- }
          return { line: idx, start: p, removed: cur.slice(p, s2), inserted: text.slice(p, s1) }
        }
        function flushActive(m) {
          const idx = m.activeIdx
          if (idx === null || idx === undefined) return
          const patch = flushLine(m, idx)
          if (patch) pushEntry(m, [patch], idx, selectionOffsetIn(m.rowEls.get(idx)))
        }

        // ---------- editing operations ----------
        function undoModel(m) {
          flushActive(m)
          const e = m.undo.pop()
          if (!e) return
          m.redo.push(e)
          // v1.13.2: the render that follows must repaint the row's text
          // (React renders code rows as empty shells filled imperatively via
          // refs; the ACTIVE row is skipped to protect in-progress typing).
          m.activeIdx = null
          afterModelChange(m)
          m.pendingCaret = { line: Math.max(0, Math.min(m.lines.length - 1, e.line)), pos: e.pos }
        }
        function redoModel(m) {
          flushActive(m)
          const e = m.redo.pop()
          if (!e) return
          m.undo.push(e)
          m.activeIdx = null
          afterModelChange(m)
          m.pendingCaret = { line: Math.max(0, Math.min(m.lines.length - 1, e.line)), pos: e.pos }
        }
        function indentModel(m) {
          flushActive(m)
          const sel = rowSelection(m)
          if (!sel) return
          const patches = []
          for (let k = sel.start; k <= sel.end; k++) {
            if (k >= 0 && k < m.lines.length && m.lines[k] !== '') patches.push({ line: k, start: 0, removed: '', inserted: '  ' })
          }
          if (patches.length) {
            m.activeIdx = null
            pushEntry(m, patches, sel.caret.row, sel.caret.pos + 2)
            m.pendingCaret = { line: sel.caret.row, pos: sel.caret.pos + 2 }
          }
        }
        function outdentModel(m) {
          flushActive(m)
          const sel = rowSelection(m)
          if (!sel) return
          const patches = []
          for (let k = sel.start; k <= sel.end; k++) {
            const t = k >= 0 && k < m.lines.length ? m.lines[k] : ''
            if (t.startsWith('  ')) patches.push({ line: k, start: 0, removed: '  ', inserted: '' })
            else if (t.startsWith('\t')) patches.push({ line: k, start: 0, removed: '\t', inserted: '' })
          }
          if (patches.length) {
            const first = patches[0].removed.length
            m.activeIdx = null
            pushEntry(m, patches, sel.caret.row, Math.max(0, sel.caret.pos - first))
            m.pendingCaret = { line: sel.caret.row, pos: Math.max(0, sel.caret.pos - first) }
          }
        }
        function newlineModel(m) {
          const info = caretModelPos(m)
          if (!info) return
          const flush = flushLine(m, info.row)
          const patches = []
          if (flush) patches.push(flush)
          patches.push({ line: info.row, start: info.pos, removed: '', inserted: '\n' })
          m.activeIdx = null
          pushEntry(m, patches, info.row + 1, 0)
          m.pendingCaret = { line: info.row + 1, pos: 0 }
        }
        function mergeBackwardModel(m) {
          const info = caretModelPos(m)
          if (!info || info.pos !== 0 || info.row <= 0) return
          const prev = info.row - 1 < m.lines.length ? m.lines[info.row - 1] : ''
          const patches = []
          const flush = flushLine(m, info.row)
          if (flush) patches.push(flush)
          // Removing ONLY the newline joins the two rows (both texts survive).
          patches.push({ line: info.row - 1, start: prev.length, removed: '\n', inserted: '' })
          m.activeIdx = null
          pushEntry(m, patches, info.row - 1, prev.length)
          m.pendingCaret = { line: info.row - 1, pos: prev.length }
        }
        function mergeForwardModel(m) {
          const info = caretModelPos(m)
          if (!info || info.row < 0 || info.row >= m.lines.length - 1) return
          const cur = m.lines[info.row]
          if (info.pos < cur.length) return
          const patches = []
          const flush = flushLine(m, info.row)
          if (flush) patches.push(flush)
          patches.push({ line: info.row, start: cur.length, removed: '\n', inserted: '' })
          m.activeIdx = null
          pushEntry(m, patches, info.row, cur.length)
          m.pendingCaret = { line: info.row, pos: cur.length }
        }
        function moveCaretRow(m, targetRow, col) {
          if (targetRow < 0 || targetRow >= m.lines.length) return
          m.lastCol = col
          m.pendingCaret = { line: targetRow, pos: Math.min(col, m.lines[targetRow].length) }
          notifyModelSubs(m)
        }

        // Replay user patches onto NEW content (after an agent edit), keeping
        // patches whose removed text still matches; the first conflict aborts
        // the replay (later patches reference indices that no longer align)
        // and is reported so the caller can tell the user.
        function replayWithConflicts(theirs, entries) {
          let rows = (theirs || []).map((t, i) => ({ origin: i, text: String(t) }))
          if (rows.length === 0) rows.push({ origin: -1, text: '' })
          let conflicts = 0
          let aborted = false
          for (const e of entries) {
            for (const p of e.patches) {
              if (!applyPatchToRows(rows, p, true)) { conflicts++; aborted = true; break }
            }
            if (aborted) break
          }
          return { lines: rows.map((r) => r.text), conflicts }
        }

        function discardModel(m) {
          m.undo = m.undo.slice(0, m.savedUndoLen || 0)
          m.redo = []
          m.activeIdx = null
          afterModelChange(m)
          persistNow(m)
        }
        function markTyping(m) {
          if (m.dirty) return
          m.dirty = true
          store.setDirty(m.path, true)
          persistSoon(m)
        }

        // Full-content save: flush in-progress typing, write the model lines
        // to disk through the host, and mark the save point. The undo history
        // is KEPT (saving does not clear it); the white dot clears.
        async function saveModel(m, sid, path) {
          flushActive(m)
          const r = await call('saveUserFile', { sessionId: sid, path: path, rev: m.hostRev, lines: m.lines })
          if (!r || !r.ok) return r
          m.savedFp = fpOf(m.lines)
          m.savedLines = m.lines.slice()
          m.savedUndoLen = m.undo.length
          m.hostRev = r.rev
          m.diskFp = fpOf(m.lines)
          m.dirty = false
          store.setDirty(path, false)
          persistNow(m)
          return r
        }

        // ---------- file view ----------
        // v1.16.0: DiffPane is memo'd. FileView re-renders on every global
        // store emit (tab opens, dirty flips, refresh ticks); without memo
        // that forced the whole thousand-line pane tree to re-render each
        // time — the typing jank on ~1000-line files. Props are only
        // { sid, path }, so memo blocks re-renders while the same file is
        // open; the pane's own narrow subscriptions (refreshTick, dockH)
        // still update it.
        const DiffPane = React.memo(function DiffPane(props) {
          const sid = props.sid
          const path = props.path
          const [diff, setDiff] = React.useState(null)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState(null)
          // v1.7.1: hunk heads (行号范围 + 接受/拒绝) are PERMANENT — the
          // old hover-show/hover-hide made adjacent hunks jitter while the
          // pointer moved between them.
          // v1.7: diff jump controls — index of the currently focused hunk
          // (null = none yet; the counter then reads the first hunk).
          const [focusIdx, setFocusIdx] = React.useState(null)
          const hunkRefs = React.useState({})[0]
          const diffRef = React.useState({ node: null })[0]
          const scrollGate = React.useState({ pending: false })[0]
          const editingRef = React.useState({ idx: null })[0]
          // v1.32.0: the selection engine's state + layer handles live with
          // the other per-pane refs (see selState / selLayerRef below, right
          // before `saveCurrent`); the old per-drag `dragSel` scratch object
          // is gone with the native-range hack it served.
          // v1.15.3: MD edit/read toggle. null = automatic (the legacy
          // behavior): pending diffs show the editable review view, clean
          // files show the rendered document. Explicit true/false force the
          // source/rendered view respectively and persist until the tab
          // switches. mdEditRef mirrors the EFFECTIVE mode for applyPayload
          // (async fetches must see the latest value regardless of closure
          // age); it is cleared on tab switch so a stale "edit" cannot leak
          // into the next file's model creation.
          const [mdEdit, setMdEdit] = React.useState(null)
          const mdEditRef = React.useState({ v: null })[0]
          // v1.22: in-view search. searchTick re-renders the pane (the ref
          // painters re-run and re-wrap overlay marks) whenever the module-
          // level searchState changes.
          const [searchTick, setSearchTick] = React.useState(0)
          const inpRef = React.useState({ el: null })[0]
          const focusSearchRef = React.useState({ n: 0 })[0]
          const bumpSearch = () => setSearchTick((n) => n + 1)
          // v1.24: register this pane's "close the search box" action so the
          // document-level ESC handler can close it while focus is anywhere
          // else (editor rows, toolbar, the diff scroller). The ref keeps the
          // latest closure without re-subscribing on every render.
          const closeSearchRef = React.useState({ fn: null })[0]
          React.useEffect(() => {
            const fn = () => { if (searchState.on && closeSearchRef.fn) closeSearchRef.fn() }
            searchClosers.add(fn)
            return () => { searchClosers.delete(fn) }
          }, [])
          const resetSearch = () => {
            searchState.on = false
            searchState.query = ''
            searchState.matches = []
            searchState.byRow = new Map()
            searchState.cur = -1
            searchState.dirty = true
          }
          React.useEffect(() => {
            setMdEdit(null)
            mdEditRef.v = null
            // v1.22: search state is module-level — reset on file/session switch.
            resetSearch()
            setSearchTick((n) => n + 1)
          }, [path, sid])
          // v1.22: focus the search box after Ctrl+F opens it.
          React.useEffect(() => {
            if (focusSearchRef.n > 0 && inpRef.el) {
              focusSearchRef.n = 0
              try { inpRef.el.focus(); inpRef.el.select() } catch (e) {}
            }
          }, [searchTick])
          // v1.13: the per-file edit model drives the code area. modelKey
          // identifies the model in the module-level registry; modelVersion
          // re-renders after every structural model change (undo/redo/Enter/
          // paste/indent — NOT per keystroke; typing mutates the DOM and is
          // committed into the model on blur/undo/save).
          const [modelKey, setModelKey] = React.useState(null)
          const [modelVersion, setModelVersion] = React.useState(0)
          const modelRef = React.useState({ m: null })[0]
          const m = modelKey ? editModels.get(modelKey) : null
          modelRef.m = m
          const subRef = React.useState({ fn: null })[0]
          React.useEffect(() => {
            if (!m) return
            subRef.fn = () => setModelVersion((n) => n + 1)
            m.subs.add(subRef.fn)
            return () => { m.subs.delete(subRef.fn) }
          }, [m])
          // Caret restore after structural changes (Enter split, undo/redo,
          // paste, indent, line merges, arrows). Typing never lands here —
          // it mutates the DOM in place. Also re-establishes the engine's
          // active-row pointer (the ops clear it so the repaint refs run).
          React.useEffect(() => {
            if (!m || !m.pendingCaret) return
            const pc = m.pendingCaret
            m.pendingCaret = null
            const t = setTimeout(() => {
              const el = m.rowEls.get(pc.line)
              if (el) {
                m.activeIdx = pc.line
                setCaretEl(el, pc.pos)
              }
            }, 0)
            return () => clearTimeout(t)
          }, [m, modelVersion])
          // Payload deferred while a line is being edited (applied on blur
          // commit so the poll never clobbers in-progress DOM typing).
          const deferredPayloadRef = React.useState({ p: null })[0]
          // v1.12.5: timer for the post-jump caret placement (smooth scroll
          // must settle before the range is moved onto the target line).
          const jumpTimer = React.useState({ t: null })[0]
          React.useEffect(() => () => {
            if (jumpTimer.t) clearTimeout(jumpTimer.t)
            if (scopeState.flashTimer) clearTimeout(scopeState.flashTimer)
            if (scopeState.caretTimer) clearTimeout(scopeState.caretTimer)
          }, [])
          // v1.9.4: the CURRENT path, mirrored every render. fetch responses
          // are dropped when the user has since switched tabs — a late
          // response for the previous file must never overwrite the view of
          // the newly selected one.
          const pathRef = React.useState({ path: null })[0]
          pathRef.path = path
          const lang = langOf(path)
          // v1.8.1: sticky header measurements — the toolbar pins below the
          // tabs bar; its height feeds the jump control's sticky offset
          // (CSS var) and the jump scroll math (store).
          const paneRef = React.useState({ node: null })[0]
          const toolbarRef = React.useState({ node: null })[0]
          React.useEffect(() => {
            const el = toolbarRef.node
            if (el && el.offsetHeight > 0) {
              store.toolH = el.offsetHeight
              if (paneRef.node) paneRef.node.style.setProperty('--dsh-fe-toolbar-h', el.offsetHeight + 'px')
            }
          })
          // ---------- sticky scope bar (v1.14) ----------
          // VSCode-style sticky scroll: the definition chain enclosing the
          // first visible line sticks below the header stack; clicking a
          // segment scrolls to that definition (and lands the caret when
          // the line is editable). The bar is filled imperatively — the
          // thousands-of-lines diff must not re-render on every scroll tick.
          const scopeRef = React.useState({ node: null })[0]
          const scopeState = React.useState({ key: '', flashTimer: null, caretTimer: null })[0]
          const scopeGate = React.useState({ pending: false })[0]
          const outlineRef = React.useState({ list: [] })[0]
          // v1.32.0 selection engine state. It MUST be allocated here, with
          // the other refs: this component has early returns further down
          // (deleted file / binary / oversized payloads), and a hook declared
          // after one of them would make the hook count differ between
          // renders — React then throws "Rendered fewer hooks than expected"
          // and unmounts the whole pane. The engine's functions live far
          // below (see selCtl); they only close over these objects.
          const selState = React.useState({ a: null, f: null, same: true, active: false, dragging: false })[0]
          const selLayerRef = React.useState({ node: null, scroll: null })[0]
          const selWasRef = React.useState({ v: -1 })[0]
          const selRafRef = React.useState({ h: 0 })[0]
          // v1.32.1: a paint that disagrees with the settled layout is retried
          // once (see scheduleDraw). The flag is a ref, not state: it must not
          // re-render, and it must be readable from the rAF callback.
          const selRedrawRef = React.useState({ retried: false })[0]
          // v1.32.0: drop a standing selection when the model revision moves
          // for a reason other than the selection's own replacement write
          // (undo/redo, Enter, an agent payload landing, accept/reject). A file
          // switch re-runs this effect against the new model. Typing is NOT a
          // structural change, so a live drag is never disturbed by it.
          // These two effects belong HERE, with the other hooks, rather than
          // next to the engine they reason about: everything below `if (!diff)`
          // sits past an early return, and a hook there makes the hook count
          // differ between the loading render and the payload render — React
          // then unmounts the whole pane (the blank 文件 view). Their callbacks
          // only run after a render, so referencing clearSel/selCtl (declared
          // further down) is safe, not a TDZ error.
          React.useEffect(() => {
            if (!m) return
            if (selWasRef.v === m.version) return
            if (selState.dragging) return
            if (selState.a && selState.f && !selState.same) clearSel()
          }, [m, modelVersion])
          // A drag whose mouseup lands outside the window never reaches the
          // pane's own handler — the release still has to end the gesture, or
          // the editor would keep extending the selection on the next hover.
          React.useEffect(() => {
            const onBlur = () => { if (selState.dragging) selCtl.finish(null) }
            window.addEventListener('blur', onBlur)
            return () => window.removeEventListener('blur', onBlur)
          }, [])
          const outline = React.useMemo(() => {
            if (diff && diff.note === 'large' && Array.isArray(diff.preview)) return buildOutline(diff.preview, lang)
            if (!m || !Array.isArray(m.lines)) return []
            return buildOutline(m.lines, lang)
          }, [m, modelVersion, diff, lang])
          outlineRef.list = outline
          // First-visible-line probe → scope chain → imperative bar update.
          // The 25ms gate collapses scroll bursts; the key comparison skips
          // no-op updates entirely. v1.14 fix: the bar's sticky offset and
          // the probe line are taken from the toolbar's LIVE rect every tick
          // (the measured CSS vars can go stale when the toolbar wraps after
          // a window resize and then covers the bar); the probe also tries
          // several points and falls back to uniform-row math.
          const updateScopeBar = () => {
            const bar = scopeRef.node
            const code = diffRef.node
            if (!bar || !code) return
            const body = bar.firstElementChild
            if (!body) return
            const defs = outlineRef.list
            const crect = code.getBoundingClientRect()
            const vw = window.innerWidth || 1200
            const vh = window.innerHeight || 800
            const internal = code.scrollHeight > code.clientHeight + 1
            if (crect.bottom <= 0 || crect.top >= vh) return
            // Sticky offset: pin right below the toolbar's REAL bottom,
            // expressed relative to the actual scrollport (chat column in
            // page mode; in internal mode the strip never sticks and the
            // inline top is inert).
            const tb = toolbarRef.node
            let headerBottom = (store.tabH || 32) + (store.toolH || 35)
            if (tb && bar.style) {
              const r = tb.getBoundingClientRect()
              if (r.bottom > 0 && r.bottom < vh + 40) {
                headerBottom = Math.max(headerBottom, r.bottom)
                if (!internal) {
                  let spTop = 0
                  let p = code
                  while (p && p !== document.body) {
                    const oy = getComputedStyle(p).overflowY
                    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight + 1) { spTop = p.getBoundingClientRect().top; break }
                    p = p.parentElement
                  }
                  const wanted = Math.max(0, r.bottom - spTop)
                  if (bar.style.top !== wanted + 'px') bar.style.top = wanted + 'px'
                }
              }
            }
            let F = -1
            let deletedTop = false
            try {
              let probeTop = headerBottom + 2
              if (body.childElementCount > 0) {
                const br = body.getBoundingClientRect()
                if (br.bottom > 0) probeTop = br.bottom + 2
              }
              // Probe candidates: the primary point, then a few offsets —
              // the first hit on a code line wins.
              const candidates = [
                [Math.min(Math.max(crect.left + 60, 4), vw - 4), probeTop],
                [Math.min(Math.max(crect.left + 220, 4), vw - 4), probeTop],
                [Math.min(Math.max(crect.left + 60, 4), vw - 4), probeTop + 14],
                [Math.min(Math.max(crect.left + 60, 4), vw - 4), probeTop + 30],
              ]
              for (const cand of candidates) {
                const x = cand[0]
                const y = Math.min(cand[1], vh - 2)
                if (y <= 0) continue
                const hit = document.elementFromPoint(x, y)
                if (!hit || !hit.closest) continue
                const lineEl = hit.closest('.dsh-fe-line')
                if (!lineEl) continue
                // Deleted (old) rows get no scope bar — the feature does not
                // apply to deleted diff regions.
                if (lineEl.classList.contains('dsh-fe-old')) { deletedTop = true; break }
                const n = Number(lineEl.getAttribute('data-n'))
                if (n > 0) { F = n - 1 }
                break
              }
            } catch (e) {}
            // Last resort: uniform ~19px rows from scroll geometry (code
            // rows are white-space:pre and never wrap). Slightly approximate
            // around hunk heads, but only runs when the DOM probe finds
            // nothing at all.
            if (F < 0 && !deletedTop) {
              F = internal
                ? Math.max(0, Math.floor((code.scrollTop || 0) / 19))
                : Math.max(0, Math.floor((headerBottom + 4 - crect.top) / 19))
            }
            const chain = deletedTop ? [] : resolveChain(defs, F)
            const key = chain.map((d) => d.line + ':' + d.name).join('|')
            if (key === scopeState.key) return
            scopeState.key = key
            body.textContent = ''
            if (chain.length === 0) return
            let show = chain
            let ellipsis = false
            if (show.length > 3) { show = show.slice(show.length - 3); ellipsis = true }
            const frag = document.createDocumentFragment()
            if (ellipsis) {
              const ell = document.createElement('span')
              ell.className = 'dsh-fe-scope-sep'
              ell.textContent = '…'
              frag.append(ell)
            }
            show.forEach((d, k) => {
              if (k > 0) {
                const sep = document.createElement('span')
                sep.className = 'dsh-fe-scope-sep'
                sep.textContent = '›'
                frag.append(sep)
              }
              const b = document.createElement('button')
              b.type = 'button'
              b.className = 'dsh-fe-scope-seg dsh-fe-tk-' + (d.kind === 'cls' ? 'cls' : d.kind === 'tag' ? 'tag' : d.kind === 'fn' ? 'fn' : 'key')
              const kw = d.kw || (d.kind === 'head' ? '#'.repeat(d.lvl || 1) : (KIND_LABEL[d.kind] || ''))
              if (kw) {
                const ks = document.createElement('span')
                ks.className = 'dsh-fe-scope-kw'
                ks.textContent = kw
                b.append(ks)
              }
              b.append(document.createTextNode(d.name.length > 60 ? d.name.slice(0, 57) + '…' : d.name))
              b.title = '第 ' + (d.line + 1) + ' 行 — 点击跳转到定义'
              b.setAttribute('data-line', String(d.line))
              frag.append(b)
            })
            body.append(frag)
          }
          // Scroll to a definition line: the same scroller walk as jumpTo
          // (the diff viewport itself when bounded, else the chat column),
          // aligned just below the sticky headers + bar, with a brief flash
          // on the landed line and a caret drop when it is editable.
          const jumpToLine = (idx) => {
            const code = diffRef.node
            if (!code) return
            const el = code.querySelector('.dsh-fe-line:not(.dsh-fe-old)[data-n="' + (idx + 1) + '"]')
            if (!el) return
            let scroller = null
            // v1.14 fix: walk from the TARGET LINE so the bounded diff
            // viewport itself is a candidate (the old walk started at the
            // code element's parent and could never detect internal mode).
            let p = el
            while (p && p !== document.body) {
              const oy = getComputedStyle(p).overflowY
              if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight + 1) { scroller = p; break }
              p = p.parentElement
            }
            if (!scroller) scroller = document.scrollingElement || document.documentElement
            const barH = (scopeRef.node && scopeRef.node.firstElementChild && scopeRef.node.firstElementChild.offsetHeight) || 0
            const internal = scroller === code
            const box = el.getBoundingClientRect()
            const sb = scroller.getBoundingClientRect()
            let headerH = internal ? barH + 1 : ((store.tabH || 32) + (store.toolH || 35) + barH + 2)
            // Prefer the toolbar's live bottom over the measured vars (same
            // staleness fix as the bar's sticky offset).
            if (!internal && toolbarRef.node) {
              const r = toolbarRef.node.getBoundingClientRect()
              if (r.bottom > 0 && r.bottom - sb.top > 0) headerH = Math.max(headerH, r.bottom - sb.top + barH + 2)
            }
            const target = scroller.scrollTop + (box.top - sb.top) - headerH
            try {
              scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
            } catch (e) {
              try { scroller.scrollTop = Math.max(0, target) } catch (e2) { try { el.scrollIntoView() } catch (e3) {} }
            }
            el.classList.add('dsh-fe-scope-flash')
            if (scopeState.flashTimer) clearTimeout(scopeState.flashTimer)
            scopeState.flashTimer = setTimeout(() => { scopeState.flashTimer = null; el.classList.remove('dsh-fe-scope-flash') }, 900)
            if (scopeState.caretTimer) clearTimeout(scopeState.caretTimer)
            scopeState.caretTimer = setTimeout(() => {
              scopeState.caretTimer = null
              const ed = el.querySelector('.dsh-fe-tx-edit')
              if (!ed) return
              try {
                ed.focus({ preventScroll: true })
                const sel = window.getSelection()
                if (sel) {
                  sel.removeAllRanges()
                  const range = document.createRange()
                  range.selectNodeContents(ed)
                  range.collapse(true)
                  sel.addRange(range)
                }
              } catch (e) {}
            }, 300)
          }
          const onScopeClick = (ev) => {
            if (!ev.target || !ev.target.closest) return
            const seg = ev.target.closest('.dsh-fe-scope-seg')
            if (!seg) return
            const line = Number(seg.getAttribute('data-line'))
            if (isNaN(line) || line < 0) return
            jumpToLine(line)
          }
          React.useEffect(() => {
            const bar = scopeRef.node
            const code = diffRef.node
            if (!bar || !code) return
            if (bar.firstElementChild) bar.firstElementChild.textContent = ''
            scopeState.key = ''
            const tick = () => {
              if (scopeGate.pending) return
              scopeGate.pending = true
              setTimeout(() => {
                scopeGate.pending = false
                updateScopeBar()
              }, 25)
            }
            // Capture-phase scroll: element scroll events (the bounded diff
            // viewport) and page scrolls (the chat column) both arrive here.
            window.addEventListener('scroll', tick, true)
            window.addEventListener('resize', tick)
            updateScopeBar()
            return () => {
              window.removeEventListener('scroll', tick, true)
              window.removeEventListener('resize', tick)
            }
          }, [diff, path, lang])
          React.useEffect(() => { updateScopeBar() }, [outline])
          const scopeBar = React.createElement('div', {
            className: 'dsh-fe-scope',
            ref: (node) => { scopeRef.node = node },
            onClick: onScopeClick,
          }, React.createElement('div', { className: 'dsh-fe-scope-body' }))
          // v1.13: reconcile a full payload with the per-file edit model.
          // * fingerprint unchanged → keep the model, refresh the host rev;
          // * changed + dirty → external change with unsaved edits: reject/
          //   undo-reject resets (toast), agent edits AUTO-SAVE the user's
          //   edits replayed onto the new content (conflicts keep AI text);
          // * changed + clean → reset the history (requirement 3) or restore
          //   the persisted history when the fingerprints match (req 4).
          const applyPayload = async (r, depth) => {
            const d = depth || 0
            if (pathRef.path !== path) return
            editingRef.idx = null
            // v1.13.1: the model reconciliation replaces rows, so the engine's
            // active-row pointer must not survive into the new DOM.
            const mAny = editModels.get(editKeyOf(r.root || store.root, path))
            if (mAny) mAny.activeIdx = null
            // Clean markdown renders read-only (no model) UNLESS the user
            // explicitly toggled 编辑 (mdEditRef); PENDING markdown keeps the
            // diff/审阅 view whose lines stay editable.
            const editable = !r.deleted && !r.zero && !r.note && (lang !== 'markdown' || r.changed === true || mdEditRef.v === true)
            if (!editable) {
              if (r.deleted || r.zero) {
                const key = editKeyOf(store.root, path)
                if (editModels.has(key)) { editModels.delete(key); removePersisted(key) }
                store.setDirty(path, false)
              }
              setDiff(r)
              setError(null)
              return
            }
            if (!Array.isArray(r.current)) { setDiff(r); setError(null); return }
            const key = r.root ? editKeyOf(r.root, path) : editKeyOf(store.root, path)
            const curFp = fpOf(r.current)
            const m0 = editModels.get(key)
            if (m0 && m0.diskFp === curFp) {
              m0.hostRev = r.rev
              setModelKey(key)
              store.setDirty(path, m0.dirty)
              setDiff(r)
              setError(null)
              return
            }
            if (m0 && m0.dirty) {
              if (r.justRejected) {
                showToast('「' + nameOf(path) + '」已被还原，未保存的编辑已丢弃')
                // Reset to a FRESH model right away (history reset per
                // requirement 3) — the view stays editable without waiting
                // for the next poll to re-create it.
                const nm = createModel(r.root || store.root, path, r.current)
                nm.hostRev = r.rev
                nm.diskFp = fpOf(nm.origin)
                editModels.set(key, nm)
                persistNow(nm)
                store.setDirty(path, false)
                setModelKey(key)
                setDiff(r)
                setError(null)
                return
              }
              // Agent edit while the user had unsaved edits: auto-save.
              const merged = replayWithConflicts(r.current, m0.undo)
              const r2 = await call('saveUserFile', { sessionId: sid, path: path, rev: r.rev, lines: merged.lines })
              if (r2 && r2.ok) {
                if (merged.conflicts > 0) showToast('「' + nameOf(path) + '」被 AI 修改：' + merged.conflicts + ' 处编辑与 AI 的修改冲突，已保留 AI 的版本')
                else showToast('已自动保存对「' + nameOf(path) + '」的修改')
                const nm = createModel(r.root || store.root, path, r2.current || merged.lines)
                nm.hostRev = r2.rev
                nm.diskFp = fpOf(nm.origin)
                editModels.set(key, nm)
                persistNow(nm)
                store.setDirty(path, false)
                setModelKey(key)
                setDiff(r2)
                setError(null)
                return
              }
              if (r2 && r2.code === 'stale' && r2.payload && d < 2) {
                await applyPayload(r2.payload, d + 1)
                return
              }
              showToast('自动保存失败：' + ((r2 && (r2.message || r2.error)) || '未知错误'))
              const nm = createModel(r.root || store.root, path, r.current)
              nm.hostRev = r.rev
              nm.diskFp = curFp
              editModels.set(key, nm)
              persistNow(nm)
              store.setDirty(path, false)
              setModelKey(key)
              setDiff(r)
              setError(null)
              return
            }
            const stored = loadPersisted(key)
            let nm = null
            if (stored && fpOf(stored.origin) === curFp
                && stored.originLen === r.current.length
                && stored.originBytes === r.current.join('\n').length) {
              nm = restoreModel(r.root || store.root, path, r.current, stored)
            } else {
              nm = createModel(r.root || store.root, path, r.current)
            }
            if (stored && nm.undo.length === 0 && nm.redo.length === 0 && stored.undo && stored.undo.length > 0) removePersisted(key)
            nm.hostRev = r.rev
            nm.diskFp = curFp
            editModels.set(key, nm)
            store.setDirty(path, nm.dirty)
            setModelKey(key)
            setDiff(r)
            setError(null)
          }
          // v1.9.4: `forceFull` (tab switch / path change) ignores the stale
          // rev and fetches the whole payload. The rev short-circuit is only
          // valid when the rev belongs to the SAME file: the pane is ONE
          // component instance reused across tabs, so after a switch the old
          // rev is the PREVIOUS file's counter — the host would answer `same`
          // for the new path and stale content would stick forever. v1.13:
          // the rev rides the edit model (hostRev) instead of the payload.
          const fetch = async (forceFull) => {
            if (!sid || !path) return
            const reqPath = path
            setBusy(true)
            const mm = modelRef.m
            const rev = forceFull ? null : (mm ? mm.hostRev : (diff ? diff.rev : null))
            const r = await call('getDiff', { sessionId: sid, path: reqPath, rev: rev })
            // Stale response guard: the user switched tabs while this request
            // was in flight — drop it entirely (its setBusy(false) would also
            // race the newer request's spinner).
            if (pathRef.path !== reqPath) return
            if (r.ok) {
              if (r.same) { setError(null); setBusy(false); return }
              if (r.root) store.setRoot(r.root)
              // While a line is being edited, defer payload application so the
              // poll cannot clobber in-progress DOM typing; the blur commit
              // applies it afterwards.
              if (editingRef.idx !== null && modelRef.m && modelRef.m.dirty) {
                deferredPayloadRef.p = r
                setBusy(false)
                return
              }
              await applyPayload(r)
              setBusy(false)
            } else if (r.missing) {
              setDiff(null)
              setModelKey(null)
              setBusy(false)
            } else {
              setError(r.error || r.message || '加载失败')
              setBusy(false)
            }
          }
          usePoll(fetch, () => pollDelayFor(sid))
          // v1.9.4: on path change, clear the previous file's payload FIRST
          // (the pane shows 加载中… instead of the wrong file's content) and
          // force a full fetch without the stale rev.
          // v1.13: session switches first offer to SAVE the previous file's
          // unsaved edits (requirement 6) — via the FileView-rendered prompt.
          const prevSessionRef = React.useState({ sid: null, path: null })[0]
          React.useEffect(() => {
            const prev = { sid: prevSessionRef.sid, path: prevSessionRef.path }
            prevSessionRef.sid = sid
            prevSessionRef.path = path
            void (async () => {
              if (prev.sid && prev.sid !== sid && prev.path) {
                const key0 = editKeyOf(store.root, prev.path)
                const m0 = editModels.get(key0)
                if (m0 && m0.dirty) {
                  const choice = await new Promise((resolve) => {
                    store.askSave = { paths: [prev.path], reason: '切换会话', resolve: resolve }
                    store.emit()
                  })
                  if (choice === 'save') {
                    const r = await saveModel(m0, prev.sid, prev.path)
                    if (r && r.ok) store.requestRefresh()
                    else if (!r || !(r.code === 'stale' && r.payload)) showToast('保存失败：' + ((r && (r.message || r.error)) || '未知错误'))
                  } else if (choice === 'discard') {
                    discardModel(m0)
                  }
                }
              }
              setDiff(null)
              setModelKey(null)
              deferredPayloadRef.p = null
              await fetch(true)
            })()
          }, [path, sid])
          // Bar-side accept/reject bumps the shared tick: refetch right away
          // so this pane's toolbar stats stay in sync with the modified bar.
          // v1.16.0: a NARROW subscription replaces useStore() here. The old
          // global subscription force-re-rendered the whole thousand-line
          // pane tree on every store emit; now a refreshTick change only
          // calls fetch() directly and the pane re-renders solely when the
          // fetch lands new data (setDiff). The ref box keeps the latest
          // fetch closure (same pattern as usePoll) since the effect runs
          // once.
          const refreshRef = React.useState({ fn: null })[0]
          refreshRef.fn = fetch
          const tickRef = React.useState({ v: store.refreshTick })[0]
          React.useEffect(() => store.subscribe(() => {
            const t = store.refreshTick
            if (t !== tickRef.v) {
              tickRef.v = t
              void refreshRef.fn()
            }
          }), [])
          if (!diff) {
            return React.createElement('div', { className: 'dsh-fe-msg' }, busy ? '加载中…' : '文件不存在或无法读取')
          }
          // v1.9: markdown files render directly (no preview cap).
          // v1.15.3: the edit/read toggle overrides the automatic mode —
          // pending diffs default to the editable review view, clean files
          // to the rendered document; an explicit toggle sticks until the
          // tab switches. Read mode renders the CURRENT content, so pending
          // changes stay visible in the rendered doc and the toolbar keeps
          // its accept-all/reject-all actions.
          const isMd = lang === 'markdown'
          const mdEditOn = mdEdit === null ? (diff.changed === true) : mdEdit
          mdEditRef.v = mdEditOn
          const mdRender = isMd && !diff.deleted && !diff.zero && !mdEditOn && diff.current && diff.current.length > 0
          // v1.13: review actions flush + save unsaved user edits FIRST so
          // the host computes hunks over the up-to-date content (a reject
          // then legitimately resets the history via justRejected).
          const ensureSaved = async () => {
            const mm = modelRef.m
            if (!mm || !mm.dirty) return true
            const r = await saveModel(mm, sid, path)
            if (r && r.ok) { if (r.root) store.setRoot(r.root); setDiff(r); setError(null); return true }
            if (r && r.code === 'stale' && r.payload) { await applyPayload(r.payload); return false }
            setError((r && (r.message || r.error)) || '保存失败')
            return false
          }
          const onHunk = async (h, action) => {
            if (!(await ensureSaved())) return
            const revNow = modelRef.m ? modelRef.m.hostRev : diff.rev
            const r = await call('applyHunk', { sessionId: sid, path: path, rev: revNow, hunkId: h.id, action: action })
            if (r.ok) { setDiff(r); setError(null); store.requestRefresh() }
            else { setError(r.message || r.error || '操作失败'); await fetch(true) }
          }
          const onFile = async (method) => {
            if (!(await ensureSaved())) return
            const r = await call(method, { sessionId: sid, path: path })
            if (!r.ok) setError(r.error || r.message || '操作失败')
            else setError(null)
            await fetch(true)
            if (r.ok) store.requestRefresh()
          }
          const statusText = mdRender ? 'Markdown' : (diff.status === 'added' ? '新增' : diff.status === 'deleted' ? '删除' : '修改')
          // v1.15.3: MD-only edit/read switch (slider) at the far-left edge
          // of the toolbar row. Checked = 编辑 (source + inline editing),
          // unchecked = 阅读 (rendered markdown). Switching to 编辑 pulls a
          // full payload so the edit model materializes; switching back to
          // 阅读 flushes unsaved edits first so the rendered document
          // reflects them (a failed save keeps the edit view).
          const onMdToggle = async () => {
            const next = !mdEditOn
            if (!next) {
              if (!(await ensureSaved())) return
            }
            setMdEdit(next)
            if (next) void fetch(true)
          }
          const mdToggle = isMd && !diff.deleted && !diff.zero ? React.createElement('label', {
            className: 'dsh-fe-mdswitch',
            title: mdEditOn ? '当前：编辑模式（源代码，可编辑）。点击切换到阅读模式（渲染的 Markdown）' : '当前：阅读模式（渲染的 Markdown）。点击切换到编辑模式（源代码，可编辑）',
          },
            React.createElement('input', { type: 'checkbox', checked: mdEditOn, onChange: onMdToggle }),
            React.createElement('span', { className: 'dsh-fe-mdswitch-track' },
              React.createElement('span', { className: 'dsh-fe-mdswitch-pill' }),
              React.createElement('span', { className: 'dsh-fe-mdswitch-seg dsh-fe-mdswitch-edit' }, '编辑'),
              React.createElement('span', { className: 'dsh-fe-mdswitch-seg dsh-fe-mdswitch-read' }, '阅读'),
            ),
          ) : null
          // Accept-all / reject-all / refresh only exist while there is a
          // reviewable diff (the host stamps `changed` on the payload).
          const showActions = diff.changed === true
          const actionButtons = showActions ? [
            React.createElement(IconBtn, { key: 'ok', tone: 'ok', title: diff.deleted ? '确认删除' : '接受全部', onClick: () => onFile('acceptFile'), icon: IconDoubleCheck }),
            React.createElement(IconBtn, { key: 'no', tone: 'no', className: 'dsh-fe-pair', title: diff.deleted ? '恢复文件（还原基线内容）' : '拒绝全部', onClick: () => onFile('rejectFile'), icon: IconRejectAll }),
            React.createElement(IconBtn, { key: 'rf', title: '刷新', onClick: () => fetch(), icon: IconRefresh }),
          ] : null
          const toolbar = React.createElement('div', { className: 'dsh-fe-toolbar', ref: (node) => { toolbarRef.node = node } },
            mdToggle,
            React.createElement('span', { className: 'dsh-fe-tb-name', title: path }, path.split('/').pop()),
            React.createElement('span', { className: 'dsh-fe-chip' }, statusText),
            React.createElement('span', { className: 'dsh-fe-stats' },
              mdRender
                ? ('渲染视图 · ' + diff.current.length + ' 行' + (showActions ? ' · ' + (diff.hunks ? diff.hunks.length : 0) + ' 处未决定' : ''))
                : (diff.deleted ? '文件已删除' : (diff.note ? (diff.note === 'binary' ? '二进制文件' : '文件过大') : (diff.hunks && diff.hunks.length > 0
                  ? [
                    React.createElement('span', { key: 'a', className: 'dsh-fe-stat-add' }, '+' + diff.hunks.reduce((s, h) => s + h.newLen, 0)),
                    ' ',
                    React.createElement('span', { key: 'd', className: 'dsh-fe-stat-del' }, '−' + diff.hunks.reduce((s, h) => s + h.oldLen, 0)),
                    ' · ' + diff.hunks.length + ' 处未决定',
                  ]
                  : '无未决定修改')))),
            React.createElement('span', { className: 'dsh-fe-spacer' }, null),
            actionButtons,
            // v1.24: project run button lives at the right end of the row under
            // the file tab strip (this toolbar).
            React.createElement(RunButton, { key: 'run', sid: sid, path: path, beforeRun: ensureSaved }),
          )
          // Deleted files: banner instead of a misleading red-line diff. The
          // toolbar still offers accept (confirm deletion) / reject (restore).
          if (diff.deleted) {
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              React.createElement('div', { className: 'dsh-fe-msg' },
                '此文件已被删除。点工具栏的 ✓ 确认删除，或点 ✗ 从基线恢复文件内容。'),
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
            )
          }
          // Created then deleted within the session: net zero vs the baseline.
          if (diff.zero) {
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              React.createElement('div', { className: 'dsh-fe-msg' },
                '此文件在会话中新增后又被删除，相对基线没有净变化。'),
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
            )
          }
          // v1.9: rendered markdown view (read-only document). The toolbar
          // stays; accept/reject are hidden because nothing is pending.
          if (mdRender) {
            const html = renderMarkdown(diff.current.join('\n'))
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
              React.createElement('div', { className: 'dsh-fe-mdwrap' },
                React.createElement('div', { className: 'dsh-fe-md', dangerouslySetInnerHTML: { __html: html } }),
              ),
            )
          }
          // v1.13: the code area renders from the edit model. commitRow
          // flushes a line's DOM text into the model on blur; typing itself
          // never re-renders (the highlight layer syncs imperatively).
          const commitRow = (el) => {
            const idx = Number(el.getAttribute('data-m'))
            if (!Number.isInteger(idx)) return
            const mm = modelRef.m
            if (!mm) return
            editingRef.idx = null
            mm.activeIdx = null
            const caret = selectionOffsetIn(el)
            const patch = flushLine(mm, idx)
            if (patch) pushEntry(mm, [patch], idx, caret)
            if (deferredPayloadRef.p) {
              const r = deferredPayloadRef.p
              deferredPayloadRef.p = null
              void applyPayload(r)
            }
          }
          // v1.13 keyboard handling at the code container: every editing key
          // from the requirements, intercepted with preventDefault +
          // stopPropagation so nothing outside the editor ever sees them
          // (undo/redo run the model's OWN stack — page/dialog undo stacks
          // are untouched).
          const onCodeKeyDown = (ev) => {
            const t = ev.target
            if (!t || !t.closest || !t.closest('.dsh-fe-line')) return
            const mm = modelRef.m
            if (!mm) return
            const mod = ev.ctrlKey || ev.metaKey
            const key = (ev.key || '').toLowerCase()
            const stop = () => { ev.preventDefault(); ev.stopPropagation() }
            // v1.32.0: with a standing selection the capture handler has
            // already consumed everything it owns (typing, delete, copy/cut,
            // Shift+arrows, Esc, Ctrl+A). What is left reaches the editor
            // handlers as a collapsed caret — but the DOM selection is gone,
            // so caretModelPos would read a stale/foreign range: use the
            // selection's focus position instead.
            if (mod && key === 'z') { stop(); if (ev.shiftKey) redoModel(mm); else undoModel(mm); return }
            if (mod && key === 'y') { stop(); redoModel(mm); return }
            if (mod && key === 's') { stop(); void saveCurrent(); return }
            if (key === 'tab') { stop(); if (ev.shiftKey) outdentModel(mm); else indentModel(mm); return }
            if (key === 'enter') { stop(); newlineModel(mm); return }
            if (key === 'backspace') {
              const info = modelCaret(mm)
              if (info && info.pos === 0 && info.row > 0) { stop(); mergeBackwardModel(mm); return }
            }
            if (key === 'delete') {
              const info = modelCaret(mm)
              if (info && info.row >= 0 && info.row < mm.lines.length - 1 && info.pos >= mm.lines[info.row].length) {
                stop(); mergeForwardModel(mm); return
              }
            }
            if (key === 'arrowup') {
              const info = modelCaret(mm)
              if (info && info.pos === 0 && info.row > 0) { stop(); moveCaretRow(mm, info.row - 1, mm.lastCol); return }
            }
            if (key === 'arrowdown') {
              const info = modelCaret(mm)
              if (info && info.row >= 0 && info.row < mm.lines.length - 1 && info.pos >= mm.lines[info.row].length) {
                stop(); moveCaretRow(mm, info.row + 1, Math.max(mm.lastCol, info.pos)); return
              }
            }
            if (mod && key === 'c') {
              // Copy: the browser concatenates the per-line spans without
              // newlines — build the exact selected text from the model.
              // Single-line model selections are handled here too (the text
              // is identical); non-model selections (old rows) fall through
              // to the browser default.
              const txt = selectedModelText(mm)
              if (txt === null) return
              stop()
              try {
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(() => {})
              } catch (e2) {}
              return
            }
            if (mod && key === 'f') {
              // v1.22: open the in-view search bar (pre-filled with the
              // current selection, if it lies on the model).
              stop()
              openSearch()
              return
            }
          }
          // v1.22 paste: the keydown event has NO clipboardData (that is a
          // paste-event field), which is why the old Ctrl+V branch always saw
          // an empty clipboard. Handle the real `paste` event instead — it
          // fires for Ctrl+V and context-menu paste alike; preventDefault
          // there cancels the native insertion into the contentEditable span
          // while this handler inserts through the model instead.
          const onCodePaste = (ev) => {
            const t = ev.target
            if (!t || !t.closest || !t.closest('.dsh-fe-line')) return
            const mm = modelRef.m
            if (!mm) return
            const ed = t.closest('.dsh-fe-tx-edit')
            if (!ed) return
            ev.preventDefault()
            ev.stopPropagation()
            // v1.32.0: pasting over a standing selection replaces it.
            if (selCtl.active()) {
              let pt = ''
              try {
                const cd0 = ev.clipboardData
                if (cd0) pt = cd0.getData('text/plain') || ''
              } catch (e3) {}
              pt = pt.replace(/\r\n/g, '\n').replace(/\r/g, '')
              replaceSelModel(mm, pt)
              return
            }
            const info = caretModelPos(mm)
            if (!info) return
            let text = ''
            try {
              const cd = ev.clipboardData
              if (cd) text = cd.getData('text/plain') || ''
            } catch (e2) {}
            if (text === '') return
            text = text.replace(/\r\n/g, '\n').replace(/\r/g, '')
            const flush = flushLine(mm, info.row)
            const patches = []
            if (flush) patches.push(flush)
            patches.push({ line: info.row, start: info.pos, removed: '', inserted: text })
            if (patches.length) {
              const nl = text.lastIndexOf('\n')
              const lastRow = nl < 0 ? info.row : info.row + text.split('\n').length - 1
              const lastPos = nl < 0 ? info.pos + text.length : text.length - nl - 1
              mm.activeIdx = null
              pushEntry(mm, patches, lastRow, lastPos)
              mm.pendingCaret = { line: lastRow, pos: lastPos }
            }
          }
          // ---------- v1.32.0: editor-grade selection ----------
          // Each code row is its own per-line contentEditable, and the browser
          // CLAMPS a drag gesture to the editing host it started in: a range
          // built by hand across two such hosts is replaced by the native
          // in-row selection on the very next mousemove. Cross-line selection
          // therefore cannot be delegated to the browser — the editor claims
          // the whole gesture instead:
          //
          //   mousedown  → no native selection at all (preventDefault); the
          //                press point becomes a model coordinate {row, pos}
          //   mousemove  → the drag endpoint is re-resolved from the pointer
          //                and a tint per line fragment is painted by `draw`
          //   mouseup    → a click (never moved) drops the caret exactly like
          //                before; a real drag keeps the selection standing
          //   keys       → Ctrl+C/X read the range off the MODEL, typing,
          //                Backspace/Delete, Enter, Tab and paste REPLACE it,
          //                Shift+arrows expand it, Ctrl+A selects the file
          //
          // The model (not the DOM) is the source of truth for offsets: one
          // line may be up to three DOM copies (editable layer, highlight
          // layer, selection spans), so every offset is resolved through the
          // row's text span and clamped to the model line's length.
          // The engine's state lives with the other pane refs, far above —
          // see the selState block next to outlineRef.

          // v1.32.1: `plan` holds BLOCKS, not rows — the entries are
          // { kind: 'ctx', rows } and { kind: 'hunk', h, oldRows, newRows }, so
          // a test for 'model'/'ro' never matched and this map stayed empty.
          // Every press then failed its lookup in pointAt and the whole
          // selection gesture was dead (no tint, no caret on click). Walk the
          // block shape instead, keying each row exactly as the DOM does:
          // 'm'+model for editable rows, 'o'+hunkId+':'+n for deleted ones.
          // Deleted rows get a `model` too: the ordinal of the model line they
          // occupy visually (a hunk of M new lines shows N old ones in the same
          // M slots), so row ordinals stay a single coordinate space.
          const rowsByKeyNow = () => {
            const map = new Map()
            for (const b of plan) {
              if (b.kind === 'ctx') {
                for (const r of b.rows) map.set('m' + r.model, r)
              } else {
                for (const r of b.oldRows) {
                  const slot = Math.min(b.h.newStart + (r.n - b.h.oldStart - 1), b.h.newStart + Math.max(0, b.h.newLen - 1))
                  map.set('o' + b.h.id + ':' + r.n, { n: r.n, text: r.text, model: Math.max(0, slot), ro: true })
                }
                for (const r of b.newRows) map.set('m' + r.model, r)
              }
            }
            return map
          }
          // row → { key, rec, el } for the two row kinds that can be selected
          // (editable model rows and read-only deleted rows). `el` is null
          // while React has not committed the row.
          // v1.32.1: like rowsByKeyNow, this walked `blocks` — the RANGE
          // descriptors, which carry no row list at all — so `b.rows` was
          // undefined, paint() threw "b.rows is not iterable" and no tint was
          // ever drawn. Walk the plan's block shape instead.
          const byModel = () => {
            const map = new Map()
            for (const b of plan) {
              if (b.kind === 'ctx') {
                for (const r of b.rows) map.set(r.model, { key: 'm' + r.model, rec: r, el: m ? m.rowEls.get(r.model) : null })
              } else {
                for (const r of b.newRows) map.set(r.model, { key: 'm' + r.model, rec: r, el: m ? m.rowEls.get(r.model) : null })
              }
            }
            return map
          }
          // Character offset of a pointer x inside one row's text span.
          // Measured per GLYPH with a live Range so token spans, tabs, CJK
          // and wide glyphs all land on the real nearest boundary; the right
          // half of a glyph rounds to the next boundary. Returns null when
          // the span has no box yet (row never rendered) and the caller falls
          // back to treating the point as end-of-line.
          const offsetAtX = (span, clientX) => {
            if (!span) return null
            const text = span.firstChild
            if (!text || text.nodeType !== 3) return 0
            const len = text.length
            if (len === 0) return 0
            const rng = document.createRange()
            const p1 = span.getBoundingClientRect()
            const wide = document.createRange()
            wide.selectNodeContents(span)
            const p2 = wide.getBoundingClientRect()
            if (p1.width <= 0 && p2.width <= 0) return null
            const left = p1.width > 0 ? p1.left : p2.left
            if (clientX <= left) return 0
            const right = p2.width > 0 ? p2.right : p1.right
            if (clientX >= right) return len
            // Rightmost glyph whose LEFT edge is at or left of the pointer
            // (box i = [i, i+1), which has a real width even for the last
            // glyph). Then the boundary is picked by that glyph's midpoint:
            // left half → before it, right half → after it. Probing with
            // single-glyph ranges keeps the search truthful regardless of
            // kerning or wide glyphs.
            let lo = 0
            let hi = len - 1
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1
              rng.setStart(text, mid)
              rng.setEnd(text, mid + 1)
              if (rng.getBoundingClientRect().left <= clientX) lo = mid
              else hi = mid - 1
            }
            rng.setStart(text, lo)
            rng.setEnd(text, lo + 1)
            const cr = rng.getBoundingClientRect()
            if (cr.width <= 1e-6) return clientX <= cr.left ? lo : lo + 1
            return clientX < cr.left + cr.width / 2 ? lo : lo + 1
          }
          // Resolve a viewport point to a {key, pos} target once: the row is
          // found by geometry (elementFromPoint, then a nearest-row scan for
          // slices that hit no row box at all — the gutter gap above the
          // first row, the empty strip right of a short line), the offset by
          // the row's text span and the pointer x.
          const pointAt = (clientX, clientY) => {
            const scroller = diffRef.node
            if (!scroller) return null
            const sr = scroller.getBoundingClientRect()
            let rowEl = null
            try {
              const hit = document.elementFromPoint(clientX, clientY)
              if (hit && scroller.contains(hit) && hit.closest) rowEl = hit.closest('.dsh-fe-line')
            } catch (e) {}
            let bestD = Infinity
            let bestC = null
            for (const cand of scroller.querySelectorAll('.dsh-fe-line')) {
              const r = cand.getBoundingClientRect()
              if (r.height <= 0) continue
              const d = clientY < r.top ? r.top - clientY : (clientY > r.bottom ? clientY - r.bottom : 0)
              if (d < bestD) { bestD = d; bestC = cand }
              if (d === 0 && rowEl) break
            }
            if (!rowEl) rowEl = bestC
            if (!rowEl) return null
            // Row identity: the editable layer carries the model index; the
            // read-only deleted rows carry their own key (data-rk). The
            // data-n gutter number is only a fallback (hunk rows number the
            // NEW file, so it cannot identify a context row reliably).
            const ed = rowEl.querySelector('.dsh-fe-tx-edit')
            const rk = rowEl.getAttribute('data-rk')
            const key = rk || (ed ? 'm' + ed.getAttribute('data-m') : (rowEl.getAttribute('data-n') ? 'm' + (Number(rowEl.getAttribute('data-n')) - 1) : null))
            if (!key) return null
            const rec = rowsByKeyNow().get(key)
            if (!rec) return null
            // The row ordinal the engine reasons in is the MODEL line index.
            // Editable rows carry it; the deleted ones were given theirs when
            // the map was built (see rowsByKeyNow).
            const row = rec.model
            if (row === null || row === undefined) return null
            const span = rowEl.querySelector('.dsh-fe-txwrap .dsh-fe-tx')
            const raw = offsetAtX(span, clientX)
            const len = String(rec.text == null ? '' : rec.text).length
            // No box for this row yet (content-visibility keeps offscreen
            // rows boxless until painted): treat the point as the line's end
            // or start depending on which side of the row it fell.
            let pos
            if (raw === null) {
              const rb = rowEl.getBoundingClientRect()
              pos = clientX < rb.left + rb.width / 2 ? 0 : len
            } else {
              pos = raw
            }
            return { key: key, row: row, pos: Math.max(0, Math.min(len, pos)) }
          }
          const ensureLayer = () => {
            const scroller = diffRef.node
            if (!scroller) return null
            let layer = selLayerRef.node
            if (layer && layer.isConnected && layer.parentNode === scroller) return layer
            layer = document.createElement('div')
            layer.className = 'dsh-fe-sel'
            selLayerRef.node = layer
            scroller.insertBefore(layer, scroller.firstChild)
            if (selLayerRef.scroll) { try { selLayerRef.scroll() } catch (e) {} }
            selLayerRef.scroll = () => drawSel()
            scroller.addEventListener('scroll', selLayerRef.scroll)
            return layer
          }
          const dropLayer = () => {
            const layer = selLayerRef.node
            const scroller = layer && layer.parentNode
            if (scroller && selLayerRef.scroll) scroller.removeEventListener('scroll', selLayerRef.scroll)
            selLayerRef.scroll = null
            if (layer && layer.remove) layer.remove()
            selLayerRef.node = null
          }
          const clearSelDom = () => {
            const layer = selLayerRef.node
            if (layer) layer.textContent = ''
          }
          // One tint per selected line fragment, measured against the rows'
          // own boxes. Rects are placed in the layer's VIEWPORT coordinate
          // space (the scrollport's padding box), so they automatically track
          // the text while scrolling and need no scroll offset at all; the
          // freshly painted head is dropped and redrawn on the next paint.
          // Every paint re-measures from the live DOM, so a re-render that
          // replaces row elements never leaves stale rects behind.
          //
          // The x of a range boundary inside one row is measured the same way
          // `offsetAtX` measures it (a live Range around the partial text),
          // so the tint starts and ends exactly where the caret would sit.
          // Fragment boxes span the row's full line box, which is what makes
          // the selection read like a plain-text editor instead of like a
          // text-node selection.
          const xAtPos = (span, pos) => {
            if (!span) return null
            const text = span.firstChild
            if (!text || text.nodeType !== 3) return null
            const len = text.length
            const p = Math.max(0, Math.min(len, pos))
            const rng = document.createRange()
            rng.setStart(text, p)
            rng.setEnd(text, p)
            let r = rng.getBoundingClientRect()
            if (r.width <= 0 && r.height <= 0 && p > 0) {
              // Fully collapsed rects are unreliable in some engines — fall
              // back to the END of the preceding glyph.
              rng.setStart(text, p - 1)
              rng.setEnd(text, p)
              r = rng.getBoundingClientRect()
              return r.right
            }
            return r.left
          }
          const paint = (s) => {
            const layer = selLayerRef.node
            const scroller = diffRef.node
            if (!layer || !scroller) return
            const a = s.a.row < s.f.row || (s.a.row === s.f.row && s.a.pos <= s.f.pos) ? s.a : s.f
            const b = a === s.a ? s.f : s.a
            const byRow = byModel()
            const sr = scroller.getBoundingClientRect()
            const frags = []
            for (let r = a.row; r <= b.row; r++) {
              const entry = byRow.get(r)
              // rowEls holds the editable SPAN (the editing host), not the row
              // element: measuring it directly gave a 117px-wide box instead of
              // the full line, and reading its children threw. Climb to the
              // .dsh-fe-line and use the row's own box, exactly as
              // pointAt does.
              const rowEl = entry && entry.el && entry.el.closest ? entry.el.closest('.dsh-fe-line') : null
              if (!rowEl || !rowEl.getBoundingClientRect) continue
              const box = rowEl.getBoundingClientRect()
              if (box.height <= 0) continue
              const span = rowEl.querySelector('.dsh-fe-txwrap .dsh-fe-tx')
              const sbox = span && span.getBoundingClientRect ? span.getBoundingClientRect() : null
              // Whole-row fragments run from the first glyph to the last one
              // (a line-wise selection stops at the text, not at the pane
              // edge); the fragment where the drag STARTED begins at the
              // anchor glyph and the one it ENDS in stops at the focus glyph.
              let x1 = sbox && sbox.width > 0 ? sbox.left : box.left + 3
              let x2 = sbox && sbox.width > 0 ? sbox.right : box.right - 6
              if (span) {
                if (r === a.row) {
                  const xa = xAtPos(span, a.pos)
                  if (typeof xa === 'number') x1 = xa
                }
                if (r === b.row) {
                  const xb = xAtPos(span, b.pos)
                  if (typeof xb === 'number') x2 = xb
                }
              }
              if (x2 < x1) x2 = x1
              frags.push({ x1: x1, x2: x2, top: box.top, bottom: box.bottom })
            }
            clearSelDom()
            if (frags.length === 0) return
            const frag = document.createDocumentFragment()
            for (const g of frags) {
              const el = document.createElement('div')
              el.className = 'dsh-fe-sel-seg'
              el.style.left = (g.x1 - sr.left) + 'px'
              el.style.top = (g.top - sr.top) + 'px'
              el.style.width = Math.max(2, g.x2 - g.x1) + 'px'
              el.style.height = Math.max(1, g.bottom - g.top) + 'px'
              frag.appendChild(el)
            }
            layer.appendChild(frag)
          }
          const drawSel = () => {
            const s = selState
            if (!s.a || !s.f || s.same) {
              dropLayer()
              return
            }
            ensureLayer()
            paint(s)
          }
          // v1.32.1: never trust the frame the gesture handed us. Drawing from a
          // mousemove means measuring rows while React may still be committing
          // them, and the fragments then come out in a coordinate space that no
          // longer matches the scrollport (measured live: fragments written for
          // a scrollport at top 0 while the settled one sat at top 171). Rather
          // than guess a frame count, verify the paint against the live layout
          // and redraw once if it disagrees.
          const paintMatchesLayout = (s) => {
            const scroller = diffRef.node
            const layer = selLayerRef.node
            if (!scroller || !layer || !s.a || !s.f || s.same) return true
            const far = Math.max(s.a.row, s.f.row)
            const entry = byModel().get(far)
            const rowEl = entry && entry.el && entry.el.closest ? entry.el.closest('.dsh-fe-line') : null
            if (!rowEl) return true
            const box = rowEl.getBoundingClientRect()
            if (box.height <= 0) return true
            const sr = scroller.getBoundingClientRect()
            const want = box.top - sr.top
            const segs = layer.querySelectorAll('.dsh-fe-sel-seg')
            if (segs.length === 0) return false
            let bestD = Infinity
            for (const seg of segs) {
              const t = parseFloat(seg.style.top)
              if (isFinite(t)) bestD = Math.min(bestD, Math.abs(t - want))
            }
            // A row is ~19px tall; anything beyond a line means the paint belongs
            // to a different layout, not merely to a rounding difference.
            return bestD <= 24
          }
          const scheduleDraw = () => {
            if (selRafRef.h) return
            const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null
            const run = () => {
              const settle = () => {
                selRafRef.h = 0
                drawSel()
                // Re-verify against the layout that actually committed. One
                // retry only: a second disagreement means the rows are still
                // moving, and a later scroll/render redraws anyway.
                if (!selRedrawRef.retried) {
                  selRedrawRef.retried = true
                  if (!paintMatchesLayout(selState)) scheduleDraw()
                } else {
                  selRedrawRef.retried = false
                }
              }
              if (raf) selRafRef.h = raf(settle)
              else selRafRef.h = setTimeout(settle, 16)
            }
            selRafRef.h = raf ? raf(run) : setTimeout(run, 16)
          }
          const setSel = (mdl, p1, p2) => {
            selState.a = p1
            selState.f = p2
            selState.same = p1.row === p2.row && p1.pos === p2.pos
            // A selection is only meaningful for the revision it was made on.
            selWasRef.v = mdl ? mdl.version : -1
            scheduleDraw()
          }
          const clearSel = () => {
            selState.a = null
            selState.f = null
            selState.same = true
            selState.dragging = false
            dropLayer()
          }
          // Ordered selection in model terms (start/focus), with keys.
          const selRange = () => {
            const s = selState
            if (!s.a || !s.f || s.same) return null
            const a = s.a
            const f = s.f
            return a.row < f.row || (a.row === f.row && a.pos <= f.pos)
              ? { start: { row: a.row, pos: a.pos }, end: { row: f.row, pos: f.pos }, a: a, f: f }
              : { start: { row: f.row, pos: f.pos }, end: { row: a.row, pos: a.pos }, a: a, f: f }
          }
          // The model-side text of the selection (rows joined with '\n').
          const selText = () => {
            const r = selRange()
            const mm = modelRef.m
            if (!r || !mm) return ''
            let text = ''
            for (let row = r.start.row; row <= r.end.row && row < mm.lines.length; row++) {
              if (row > r.start.row) text += '\n'
              const from = row === r.start.row ? r.start.pos : 0
              const to = row === r.end.row ? r.end.pos : mm.lines[row].length
              text += mm.lines[row].slice(from, to)
            }
            return text
          }
          const writeClipboard = (text) => {
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {})
              else {
                const ta = document.createElement('textarea')
                ta.value = text
                ta.style.position = 'fixed'
                ta.style.opacity = '0'
                document.body.appendChild(ta)
                ta.select()
                try { document.execCommand('copy') } catch (e) {}
                ta.remove()
              }
            } catch (e) {}
          }
          // Is the pressed node part of a code row (text, gutter number,
          // highlight layer)? Used only to decide whether a press that could
          // not be resolved to a model position (a row that has no box yet)
          // should keep a standing selection.
          const isRowTarget = (target) => {
            try { return !!(target && target.closest && target.closest('.dsh-fe-line')) } catch (e) { return false }
          }
          const modelCaret = (mm) => {
            if (selState.a && selState.f) {
              const c = selState.f
              return { row: Math.max(0, Math.min(mm.lines.length - 1, c.row)), pos: c.pos }
            }
            return caretModelPos(mm)
          }
          // Drop the caret at a model position. Deleted (read-only) rows carry
          // no editable element, so the request snaps to the nearest editable
          // row — up first, then down — and clamps the column to that line.
          // Used by click resolution, selection collapse and the
          // Shift+arrow expander.
          const setModelCaret = (p) => {
            const mm = modelRef.m
            if (!mm || !p) return
            const last = mm.lines.length - 1
            let row = Math.max(0, Math.min(last, p.row))
            if (!mm.rowEls.get(row)) {
              let up = row - 1
              let down = row + 1
              let found = -1
              while (found < 0 && (up >= 0 || down <= last)) {
                if (up >= 0) { if (mm.rowEls.get(up)) { found = up; break } up-- }
                if (down <= last) { if (mm.rowEls.get(down)) { found = down; break } down++ }
              }
              if (found < 0) return
              row = found
            }
            const el = mm.rowEls.get(row)
            if (!el) return
            mm.activeIdx = row
            const pos = Math.max(0, Math.min((mm.lines[row] || '').length, p.pos))
            try { el.focus({ preventScroll: true }) } catch (e) {}
            setCaretEl(el, pos)
          }
          // Model patches that delete a selection range. The engine treats a
          // patch's `removed` as ONE contiguous slice of the file text and
          // re-joins the rows it spans, so a multi-line range needs its end
          // row prepared first:
          //   1. the end row's remainder (text after the range) is REMOVED —
          //      deleting a prefix on its own row never touches a row index;
          //   2. the range itself is deleted, from the start caret across every
          //      newline to the end row's caret, which merges the start row's
          //      head with the (now trimmed) end row;
          //   3. that remainder is written back at the caret — which is the
          //      head/remainder boundary of the merged row, so the text after
          //      the selection lands exactly where a plain editor puts it.
          // The one shape this cannot express is a range that starts at its
          // row's very beginning AND ends at column 0 of an EMPTY later row:
          // joining those leaves the emptied end row behind as one blank line
          // (the engine's own Backspace-at-column-0 merge does the same, so the
          // editor stays self-consistent). Every other shape — including a
          // range that reaches the end of the file — comes out exactly as a
          // plain text editor would leave it.
          // Everything rides a single undo entry, and no index can go stale:
          // only step 1 touches the end row, and it only shortens it.
          const selDeletePatches = (mm, s, e) => {
            const patches = []
            const line = (i) => (i >= 0 && i < mm.lines.length ? mm.lines[i] : '')
            if (s.row === e.row) {
              if (e.pos > s.pos) patches.push({ line: s.row, start: s.pos, removed: line(s.row).slice(s.pos, e.pos), inserted: '' })
              return patches
            }
            const endLine = line(e.row)
            const after = endLine.slice(e.pos)
            if (after.length > 0) patches.push({ line: e.row, start: e.pos, removed: after, inserted: '' })
            // Cross every newline up to (and including) the end row's own
            // remaining text; the rows this spans are spliced out.
            let spanned = line(s.row).slice(s.pos)
            for (let r = s.row + 1; r <= e.row; r++) {
              spanned += '\n' + (r === e.row ? endLine.slice(0, e.pos) : line(r))
            }
            // Selecting from the very start of a line leaves the joined row
            // empty; when the line AFTER the range has text, take that text
            // too and put it back at the caret, which splices the emptied row
            // away instead of leaving a blank line behind (the same result
            // Delete-at-line-end has in every editor). An empty following line
            // cannot express this, and there the blank line stays.
            let carry = ''
            if (s.pos === 0 && after.length === 0 && e.row < mm.lines.length - 1) {
              const nxt = line(e.row + 1)
              if (nxt.length > 0) {
                carry = nxt
                spanned += '\n' + nxt
              }
            }
            if (spanned.length > 0) patches.push({ line: s.row, start: s.pos, removed: spanned, inserted: '' })
            if (after.length > 0) patches.push({ line: s.row, start: s.pos, removed: '', inserted: after })
            if (carry.length > 0) patches.push({ line: s.row, start: s.pos, removed: '', inserted: carry })
            return patches
          }
          // Typing / paste / Backspace over a standing selection: flush the
          // line being typed, replace the whole range in one undoable entry,
          // then let the pendingCaret effect re-anchor the engine on the
          // caret it lands on (rowEls is stale until React commits).
          const replaceSelModel = (mm, insert) => {
            const r = selRange()
            if (!r) return false
            flushActive(mm)
            let base = selDeletePatches(mm, r.start, r.end)
            if (insert) base = base.concat([{ line: r.start.row, start: r.start.pos, removed: '', inserted: insert }])
            if (base.length === 0) { clearSel(); return true }
            const nl = insert ? insert.lastIndexOf('\n') : -1
            const rowsAdded = nl < 0 ? 0 : insert.split('\n').length - 1
            const caretRow = r.start.row + rowsAdded
            const caretPos = nl < 0 ? r.start.pos + insert.length : insert.length - nl - 1
            clearSel()
            mm.activeIdx = null
            pushEntry(mm, base, caretRow, caretPos)
            mm.pendingCaret = { line: caretRow, pos: caretPos }
            // The write is this selection's own doing: mark it as belonging
            // to the revision it just created so the model-version guard
            // below leaves it alone.
            selWasRef.v = mm.version
            return true
          }
          const selectAll = () => {
            const mm = modelRef.m
            if (!mm || mm.lines.length === 0) return
            const a = byModel().get(0)
            const b = byModel().get(mm.lines.length - 1)
            if (!a || !b) return
            setSel(mm, { key: a.key, row: 0, pos: 0 }, { key: b.key, row: mm.lines.length - 1, pos: mm.lines[mm.lines.length - 1].length })
          }
          const wordAt = (mm, row, pos) => {
            const line = mm.lines[row] || ''
            const isW = (ch) => /[A-Za-z0-9_$\u00c0-\uffff]/.test(ch)
            if (line.length === 0) return { s: 0, e: 0 }
            let i = Math.max(0, Math.min(line.length, pos))
            if (i >= line.length || !isW(line[i])) {
              if (i > 0 && isW(line[i - 1])) i -= 1
              else return { s: i, e: i }
            }
            let s = i
            let e = i
            while (s > 0 && isW(line[s - 1])) s--
            while (e < line.length && isW(line[e])) e++
            return { s: s, e: e }
          }
          const shiftExpand = (dir, word) => {
            const mm = modelRef.m
            if (!mm) return
            let a = selState.a
            let f = selState.f
            if (!a || !f) {
              const c = caretModelPos(mm) || { row: 0, pos: 0 }
              const rec = byModel().get(c.row)
              a = { key: rec ? rec.key : null, row: c.row, pos: c.pos }
              f = a
            }
            let target = null
            if (dir === 'left' || dir === 'right') {
              const line = mm.lines[f.row] || ''
              if (word) {
                if (dir === 'left') {
                  let i = f.pos
                  while (i > 0 && !/[A-Za-z0-9_$\u00c0-\uffff]/.test(line[i - 1])) i--
                  while (i > 0 && /[A-Za-z0-9_$\u00c0-\uffff]/.test(line[i - 1])) i--
                  target = { row: f.row, pos: i }
                } else {
                  let i = f.pos
                  while (i < line.length && !/[A-Za-z0-9_$\u00c0-\uffff]/.test(line[i])) i++
                  while (i < line.length && /[A-Za-z0-9_$\u00c0-\uffff]/.test(line[i])) i++
                  target = { row: f.row, pos: i }
                }
              } else if (dir === 'left') {
                target = f.pos > 0 ? { row: f.row, pos: f.pos - 1 } : (f.row > 0 ? { row: f.row - 1, pos: (mm.lines[f.row - 1] || '').length } : { row: f.row, pos: 0 })
              } else {
                target = f.pos < line.length ? { row: f.row, pos: f.pos + 1 } : (f.row < mm.lines.length - 1 ? { row: f.row + 1, pos: 0 } : { row: f.row, pos: line.length })
              }
            } else {
              const up = dir === 'up'
              const row = up ? f.row - 1 : f.row + 1
              if (row < 0 || row >= mm.lines.length) return
              const col = mm.lastCol || f.pos
              target = { row: row, pos: Math.min(col, (mm.lines[row] || '').length) }
            }
            if (!target) return
            const rec = byModel().get(target.row)
            setSel(mm, a, { key: rec ? rec.key : null, row: target.row, pos: target.pos })
            mm.lastCol = f.pos
          }
          const selCtl = {
            st: selState,
            begin: (p, shift) => {
              const mm = modelRef.m
              selState.dragging = false
              if (!mm) return
              selWasRef.v = mm.version
              if (shift && selState.a) {
                // Shift+click: the standing anchor is the pivot.
                selState.f = p
                selState.same = selState.a.row === p.row && selState.a.pos === p.pos
                scheduleDraw()
                selState.dragging = true
                return
              }
              selState.a = p
              selState.f = { key: p.key, row: p.row, pos: p.pos }
              selState.same = true
              selState.dragging = true
              dropLayer()
            },
            detail: (p, n) => {
              const mm = modelRef.m
              if (!mm || !p) return false
              if (n >= 3) {
                const rec = byModel().get(p.row)
                setSel(mm, { key: rec ? rec.key : p.key, row: p.row, pos: 0 }, { key: rec ? rec.key : p.key, row: p.row, pos: (mm.lines[p.row] || '').length })
                selState.dragging = false
                return true
              }
              if (n === 2) {
                const r = wordAt(mm, p.row, p.pos)
                const rec = byModel().get(p.row)
                const key = rec ? rec.key : p.key
                setSel(mm, { key: key, row: p.row, pos: r.s }, { key: key, row: p.row, pos: r.e })
                selState.dragging = false
                return true
              }
              return false
            },
            move: (p) => {
              if (!selState.dragging || !selState.a) return
              selState.f = p
              selState.same = selState.a.row === p.row && selState.a.pos === p.pos
              scheduleDraw()
            },
            finish: (p) => {
              if (!selState.dragging) return
              selState.dragging = false
              const mm = modelRef.m
              const drop = p || selState.f
              if (!mm || !drop) return
              if (selState.same) {
                clearSel()
                setModelCaret(drop)
              }
            },
            clear: clearSel,
            caret: modelCaret,
            range: selRange,
            text: selText,
            replace: replaceSelModel,
            all: selectAll,
            draw: drawSel,
            expand: shiftExpand,
            active: () => !!(selState.a && selState.f && !selState.same),
          }
          // v1.32.0 selection keys. Capture phase, so an active selection is
          // handled BEFORE the row's own keydown (revert-this-line on ESC)
          // and before the container's editing keys. Returns nothing: it only
          // stops the event when it acted on it.
          const onCodeKeyDownCapture = (ev) => {
            const mod = ev.ctrlKey || ev.metaKey
            const key = (ev.key || '').toLowerCase()
            const stop = () => { ev.preventDefault(); ev.stopPropagation() }
            const mm = modelRef.m
            // Esc always drops a standing selection first.
            if (key === 'escape' && selCtl.active()) { stop(); clearSel(); return }
            if (!mm) return
            if (mod && key === 'a') {
              // Select the whole editable file (deleted/read-only rows are
              // not part of the model, so they are never included).
              stop()
              selectAll()
              return
            }
            if (!selCtl.active()) return
            if (mod && key === 'c') { stop(); writeClipboard(selText()); return }
            if (mod && key === 'x') {
              stop()
              writeClipboard(selText())
              replaceSelModel(mm, '')
              return
            }
            if (key === 'backspace' || key === 'delete') { stop(); replaceSelModel(mm, ''); return }
            if (key === 'tab') { stop(); if (ev.shiftKey) outdentModel(mm); else indentModel(mm); return }
            if (ev.shiftKey && (key === 'arrowleft' || key === 'arrowright' || key === 'arrowup' || key === 'arrowdown')) {
              stop()
              const dir = key === 'arrowleft' ? 'left' : key === 'arrowright' ? 'right' : key === 'arrowup' ? 'up' : 'down'
              shiftExpand(dir, mod)
              return
            }
            if (key === 'arrowleft' || key === 'arrowright' || key === 'arrowup' || key === 'arrowdown'
              || key === 'home' || key === 'end' || key === 'pageup' || key === 'pagedown') {
              // Any other navigation collapses to the caret first (exactly
              // like a plain editor), then the existing handlers do the move.
              stop()
              const r = selRange()
              const focus = selState.f
              const c = r ? (key === 'arrowleft' || key === 'arrowup' || key === 'home' || key === 'pageup' ? r.start : r.end) : focus
              clearSel()
              // The container handlers own Enter/arrows only inside a line;
              // for a cross-line collapse we place the caret ourselves.
              if (c) setModelCaret(c)
              return
            }
            if (ev.altKey) return
            if (key.length === 1 && !mod) {
              // Typing replaces the selection, like any editor.
              stop()
              if (replaceSelModel(mm, ev.key)) return
            }
            if (key === 'enter') { stop(); replaceSelModel(mm, '\n'); return }
          }
          const saveCurrent = async () => {
            const mm = modelRef.m
            if (!mm || !mm.dirty) return
            const r = await saveModel(mm, sid, path)
            if (r && r.ok) {
              if (r.root) store.setRoot(r.root)
              setDiff(r)
              setError(null)
              store.requestRefresh()
            } else if (r && r.code === 'stale' && r.payload) {
              await applyPayload(r.payload)
            } else {
              setError((r && (r.message || r.error)) || '保存失败')
            }
          }
          // Per-line highlight state for the three line domains. Multiline
          // strings/comments carry their mode across rows in render order.
          const hlStateCur = { mode: null }
          const hlStateBase = { mode: null }
          const tokSpans = (text, hlState) => {
            const toks = lineTokensCached(text, lang, hlState)
            if (!toks) return text
            return toks.map((t, i) => React.createElement('span', { key: i, className: 'dsh-fe-tk' + (t.c ? ' dsh-fe-tk-' + t.c : '') }, t.t))
          }
          const renderRoRow = (key, cls, n, text, hlState) => {
            const isOld = cls.indexOf('dsh-fe-old') >= 0
            return React.createElement('div', { key: key, className: 'dsh-fe-line ' + cls, 'data-n': String(n), 'data-rk': isOld ? key : undefined },
              React.createElement('span', { className: 'dsh-fe-ln' }, String(n)),
              React.createElement('span', { className: 'dsh-fe-txwrap' },
                React.createElement('span', {
                  className: 'dsh-fe-tx' + (isOld ? ' dsh-fe-tx-ro' : ''),
                  title: isOld ? '已删除的行：可复制，不可编辑' : undefined,
                }, tokSpans(text, hlState))),
            )
          }
          // Model row: editable span on top of the pointer-events:none
          // highlight layer. v1.13.2: React renders BOTH as EMPTY shells and
          // fills them imperatively through refs — React never owns the text
          // or token nodes inside a code row. The browser's contentEditable
          // (and our syncHl) mutate that DOM behind React's back; letting
          // React reconcile those nodes threw "The node to be removed is not
          // a child of this node" during commits, which unmounted the whole
          // root (the file view "disappearing" on Ctrl+S) and silently
          // updated detached text nodes (Ctrl+Z looking like a no-op).
          const paintHl = (node, text, hlState, rowKey) => {
            const langId = node.getAttribute('data-lang') || ''
            const toks = langId ? lineTokensCached(text, langId, hlState) : null
            node.textContent = ''
            if (toks) {
              for (const t of toks) {
                const s = document.createElement('span')
                s.className = 'dsh-fe-tk' + (t.c ? ' dsh-fe-tk-' + t.c : '')
                s.textContent = t.t
                node.append(s)
              }
            } else {
              node.textContent = text
            }
            // v1.22: search marks ride the overlay layer (display-only).
            applySearchMarks(node, rowKey)
          }
          const renderModelRow = (r, cls, hlState) => {
            const text = r.text
            if (!m) {
              return React.createElement('div', { key: 'm' + r.model, className: 'dsh-fe-line ' + cls, 'data-n': String(r.model + 1) },
                React.createElement('span', { className: 'dsh-fe-ln' }, String(r.model + 1)),
                React.createElement('span', { className: 'dsh-fe-txwrap' },
                  React.createElement('span', { className: 'dsh-fe-tx' }, tokSpans(text, hlState))))
            }
            return React.createElement('div', { key: 'm' + r.model, className: 'dsh-fe-line ' + cls, 'data-n': String(r.model + 1) },
              React.createElement('span', { className: 'dsh-fe-ln' }, r.origin >= 0 ? String(r.origin + 1) : String(r.model + 1)),
              React.createElement('span', {
                className: 'dsh-fe-txwrap',
                onClick: (ev) => {
                  if (ev.target !== ev.currentTarget) return
                  // Click in the empty tail of a line: land the caret at the
                  // end of THAT line (a plain editor puts it after the last
                  // glyph, not wherever the span happened to keep its focus).
                  const ed = ev.currentTarget.querySelector('.dsh-fe-tx-edit')
                  if (!ed || !ed.focus) return
                  if (selCtl.active()) return
                  const mm = modelRef.m
                  const row = Number(ed.getAttribute('data-m'))
                  if (mm && Number.isInteger(row)) setModelCaret({ row: row, pos: (mm.lines[row] || '').length })
                  else ed.focus()
                },
              },
                React.createElement('span', {
                  className: 'dsh-fe-hl', 'data-hl': '1', 'data-lang': lang || '', 'aria-hidden': 'true',
                  ref: (node) => { if (node && m.activeIdx !== r.model) paintHl(node, text, hlState, 'm' + r.model) },
                }),
                React.createElement('span', {
                  className: 'dsh-fe-tx dsh-fe-tx-edit',
                  contentEditable: true,
                  suppressContentEditableWarning: true,
                  spellCheck: false,
                  'data-m': String(r.model),
                  title: '可编辑：Ctrl+S 保存 · Ctrl+Z/Y 撤销/重做 · Tab/Shift+Tab 缩进 · Enter 换行',
                  ref: (node) => {
                    if (!node) { m.rowEls.delete(r.model); return }
                    m.rowEls.set(r.model, node)
                    // The ACTIVE row (being typed) keeps its DOM text; every
                    // other row syncs to the model text.
                    if (m.activeIdx !== r.model && node.textContent !== text) node.textContent = text
                  },
                  // v1.13.1: BOTH flags — editingRef guards payload deferral
                  // (DiffPane-local); m.activeIdx drives the engine's
                  // flushActive (undo/save commit the line being typed).
                  onFocus: () => { editingRef.idx = r.model; m.activeIdx = r.model },
                  onBlur: (ev) => { commitRow(ev.currentTarget) },
                  onInput: (ev) => { syncHl(ev.currentTarget); markTyping(m) },
                  onKeyDown: (ev) => {
                    if (ev.key === 'Escape') { ev.preventDefault(); ev.currentTarget.textContent = m.lines[r.model]; syncHl(ev.currentTarget); ev.currentTarget.blur() }
                  },
                })))
          }
          // v1.31: the host no longer sends a size-capped "preview" banner — a
          // text file past the 512KB in-memory window is loaded on demand and
          // reviewed by hunks like any other. The only note-bearing payload left
          // is binary / past-MAX_SIG_BYTES content, plus a read failure.
          if (diff.note) {
            const noteMsg = diff.note === 'binary'
              ? '二进制文件无法预览，可在修改列表中直接接受或拒绝'
              : (diff.note === 'unreadable'
                ? '文件内容读取失败（可能已被删除或权限不足），可在修改列表中直接接受或拒绝'
                : '文件超出可加载上限（64MB），无法逐块审阅，可在修改列表中直接接受或拒绝')
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              React.createElement('div', { className: 'dsh-fe-msg' }, noteMsg),
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
            )
          }
          // v1.31: a file too large to ship whole. The hunks themselves are
          // always computed (that is what makes per-hunk accept/reject possible
          // at any size); only the surrounding context is omitted, replaced by a
          // head/tail preview and explicit "hidden lines" markers.
          if (diff.windowed) {
            const hlW = { mode: null }
            const wHunks = diff.hunks || []
            const total = diff.lineCount || 0
            const headRows = (diff.preview || []).map((t, i) => renderRoRow('wh' + i, '', i + 1, t, hlW))
            const tailRows = (diff.previewTail || []).map((t, i) => renderRoRow('wt' + i, '', (diff.previewTailStart || 0) + i, t, hlW))
            const headEnd = (diff.preview || []).length
            const tailStart = diff.previewTailStart || 0
            const rows = []
            rows.push(React.createElement('div', { key: 'wmsg', className: 'dsh-fe-msg' },
              '文件过大（共 ' + total + ' 行），此处只渲染改动块本身与首尾预览；每一块仍可单独接受 / 拒绝。'))
            rows.push(React.createElement('div', { key: 'whead', className: 'dsh-fe-code' }, headRows))
            if (wHunks.length > 0 && wHunks[0].newStart > headEnd) {
              rows.push(React.createElement('div', { key: 'wgap0', className: 'dsh-fe-msg' },
                '⋯ 中间省略 ' + (wHunks[0].newStart - headEnd) + ' 行 ⋯'))
            }
            for (let k = 0; k < wHunks.length; k++) {
              const h = wHunks[k]
              rows.push(React.createElement('div', { key: 'wh' + k, className: 'dsh-fe-hunk' },
                React.createElement('div', { className: 'dsh-fe-hunk-head' },
                  React.createElement('span', null,
                    (h.oldLen === 0 ? ('第 ' + (h.oldStart + 1) + ' 行前') : ('第 ' + (h.oldStart + 1) + '–' + (h.oldStart + h.oldLen) + ' 行'))
                    + ' → ' +
                    (h.newLen === 0 ? ('第 ' + (h.newStart + 1) + ' 行前') : ('第 ' + (h.newStart + 1) + '–' + (h.newStart + h.newLen) + ' 行'))),
                  React.createElement('span', { className: 'dsh-fe-spacer' }, null),
                  React.createElement(IconBtn, { tone: 'ok', small: true, title: '接受此块修改', onClick: () => onHunk(h, 'accept'), icon: IconCheck }),
                  React.createElement(IconBtn, { tone: 'no', small: true, className: 'dsh-fe-pair', title: '拒绝此块修改', onClick: () => onHunk(h, 'reject'), icon: IconCross }),
                ),
                React.createElement('div', { className: 'dsh-fe-code' },
                  (h.newLines || []).map((t, i) => renderRoRow('wn' + k + ':' + i, 'dsh-fe-new', h.newStart + i + 1, t, hlW)),
                ),
              ))
            }
            if (tailRows.length > 0) {
              const lastEnd = wHunks.length > 0 ? wHunks[wHunks.length - 1].newStart + wHunks[wHunks.length - 1].newLen : headEnd
              if (tailStart > lastEnd) {
                rows.push(React.createElement('div', { key: 'wgap1', className: 'dsh-fe-msg' },
                  '⋯ 省略 ' + (tailStart - lastEnd) + ' 行 ⋯'))
              }
              rows.push(React.createElement('div', { key: 'wtail', className: 'dsh-fe-code' }, tailRows))
            }
            if (wHunks.length === 0) {
              rows.push(React.createElement('div', { key: 'wnone', className: 'dsh-fe-msg' }, '没有未决定的修改'))
            }
            return React.createElement('div', { className: 'dsh-fe-pane' },
              toolbar,
              error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
              scopeBar,
              React.createElement('div', { className: 'dsh-fe-diff' },
                React.createElement('div', { className: 'dsh-fe-pane' }, rows),
              ),
            )
          }
          const current = diff.current || []
          const baseline = diff.baseline || []
          const hunks = diff.hunks || []
          const hunkOrdinal = {}
          for (let hi = 0; hi < hunks.length; hi++) hunkOrdinal[hunks[hi].id] = hi
          // v1.13: ctx/hunk ranges are described in ORIGIN coordinates while
          // the rows come from the edit model (which may have inserted and
          // deleted lines). A single pointer walks the model's ordered row
          // list once and buckets rows into the block they belong to; rows
          // keep their origin attribution so hunks stay aligned even after
          // user insertions/deletions above them.
          const blocks = []
          let cursor = 0
          for (const h of hunks) {
            if (h.newStart > cursor) blocks.push({ kind: 'ctx', from: cursor, to: h.newStart })
            blocks.push({ kind: 'hunk', h: h })
            cursor = h.newStart + h.newLen
          }
          if (cursor < current.length) blocks.push({ kind: 'ctx', from: cursor, to: current.length })
          if (current.length === 0) blocks.push({ kind: 'ctx', from: 0, to: 0 })
          const rowList = m ? m.rows : []
          const plan = []
          let ri = 0
          for (let bi = 0; bi < blocks.length; bi++) {
            const b = blocks[bi]
            if (b.kind === 'ctx') {
              const items = []
              while (ri < rowList.length && rowList[ri].origin < b.to) {
                if (rowList[ri].origin >= b.from || rowList[ri].origin < 0) items.push(rowList[ri])
                ri++
              }
              plan.push({ kind: 'ctx', rows: items })
            } else {
              const h = b.h
              const newRows = []
              while (ri < rowList.length && rowList[ri].origin < h.newStart + h.newLen) {
                if (rowList[ri].origin >= h.newStart || rowList[ri].origin < 0) newRows.push(rowList[ri])
                ri++
              }
              plan.push({
                kind: 'hunk', h: h,
                oldRows: range(0, h.oldLen).map((i) => ({ n: h.oldStart + i + 1, text: baseline[h.oldStart + i] })),
                newRows: newRows,
              })
            }
          }
          // v1.7: diff jump controls. The counter follows manual scrolling
          // as well.
          // v1.8.2: landing strategy = the hunk's FIRST line, scrolled by the
          // element that ACTUALLY scrolls. The shell's chat scroller — not
          // window — owns page scrolling, so the ancestor walk finds it; the
          // internal diff viewport is preferred when the pane is bounded.
          // v1.12.5: prev/next resolve the EDIT AREA'S INSERTION POINT (the
          // selection anchor line) and jump to the first hunk strictly BELOW
          // it (next) / strictly ABOVE it (prev), wrapping around; after the
          // jump the caret is moved onto the landed line so the next click
          // continues from there. No insertion point → treat as "before the
          // first line" (next → first hunk, prev → last hunk). The tracked
          // focus index drives the counter + current-hunk highlight only.
          const pickHunkFromTop = (positions, topLine, dir) => {
            const total = positions.length
            if (total === 0) return -1
            if (dir === 'next') {
              for (let k = 0; k < total; k++) if (positions[k] > topLine) return k
              return 0
            }
            for (let k = total - 1; k >= 0; k--) if (positions[k] < topLine) return k
            return total - 1
          }
          // v1.12.5: pure insertion-point semantics (user-chosen over the
          // v1.12.4 scroll-probe). The jump position is the edit area's
          // selection anchor line — the caret of an editable row, or a text
          // selection on a read-only row (both live inside the diff scroller).
          // Scrolling alone does NOT move this position. No anchor inside the
          // edit area returns 0; jumpRel then treats the position as "before
          // the first line" (next → first hunk, prev → wrap to the last).
          const caretLineAt = () => {
            const sc = diffRef.node
            if (!sc || typeof window === 'undefined') return 0
            // v1.32.0: a standing editor selection has no DOM selection of its
            // own — its focus row IS the insertion point for 上一处/下一处.
            if (selState.f && selState.a) return selState.f.row + 1
            let sel = null
            try { sel = window.getSelection && window.getSelection() } catch (e) {}
            if (!sel || sel.rangeCount === 0) return 0
            const anchor = sel.anchorNode
            let el = anchor
            if (el && el.nodeType !== 1) el = el.parentElement
            if (!el || typeof el.closest !== 'function') return 0
            if (!sc.contains(el)) return 0
            const line = el.closest('.dsh-fe-line')
            if (!line) return 0
            // The model row is the truth: the hunk rows number the NEW file,
            // so data-n cannot identify a context row reliably.
            const ed = line.querySelector('.dsh-fe-tx-edit')
            if (ed) {
              const mm = Number(ed.getAttribute('data-m'))
              if (Number.isInteger(mm)) return mm + 1
            }
            const n = Number(line.getAttribute('data-n'))
            return n > 0 ? n : 0
          }
          const jumpTo = (k) => {
            const total = hunks.length
            if (total === 0) return
            const idx = ((k % total) + total) % total
            setFocusIdx(idx)
            const node = hunkRefs[idx]
            if (!node) return
            let scroller = null
            let el = node.parentElement
            while (el && el !== document.body) {
              const oy = getComputedStyle(el).overflowY
              if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1) { scroller = el; break }
              el = el.parentElement
            }
            if (!scroller) scroller = document.scrollingElement || document.documentElement
            const box = node.getBoundingClientRect()
            const sb = scroller.getBoundingClientRect()
            // v1.15.3: the target hunk's summary row (line range + accept/
            // reject buttons) must land FULLY VISIBLE — below the stuck tabs
            // and toolbar (their LIVE heights: the measured vars go stale
            // when the toolbar wraps) AND below the sticky scope strip when
            // it is showing (it overlays the first code strip), plus a small
            // reserved margin. Inside the diff's own viewport the header
            // stack lives OUTSIDE the scroller, so only the hanging scope
            // strip needs room.
            const internal = scroller === diffRef.node
            const barH = (scopeRef.node && scopeRef.node.firstElementChild && scopeRef.node.firstElementChild.childElementCount > 0
              ? scopeRef.node.firstElementChild.offsetHeight : 0) || 0
            let headerH
            if (internal) {
              headerH = barH + 4
            } else {
              headerH = (store.tabH || 32) + (store.toolH || 35) + barH + 8
              if (toolbarRef.node) {
                const r = toolbarRef.node.getBoundingClientRect()
                if (r.bottom > 0 && r.bottom - sb.top > 0) headerH = Math.max(headerH, r.bottom - sb.top + barH + 8)
              }
            }
            const target = scroller.scrollTop + (box.top - sb.top) - headerH
            try {
              scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
            } catch (e) {
              try { scroller.scrollTop = Math.max(0, target) } catch (e2) { try { node.scrollIntoView() } catch (e3) {} }
            }
            // v1.12.5: after the smooth scroll settles, move the edit-area
            // insertion point onto the target hunk's first editable line
            // (deletion-only hunks have none — land on the first editable
            // line right after the hunk instead) so the next prev/next
            // click continues from the landed position.
            if (jumpTimer.t) clearTimeout(jumpTimer.t)
            jumpTimer.t = setTimeout(() => {
              jumpTimer.t = null
              const targetNode = hunkRefs[idx]
              if (!targetNode) return
              let editable = targetNode.querySelector('.dsh-fe-tx-edit')
              if (!editable && targetNode.nextElementSibling) {
                editable = targetNode.nextElementSibling.querySelector('.dsh-fe-tx-edit')
              }
              // Deletion at the very end of the file: no following block —
              // land on the last editable line BEFORE the hunk instead.
              if (!editable && targetNode.previousElementSibling) {
                const prevs = targetNode.previousElementSibling.querySelectorAll('.dsh-fe-tx-edit')
                if (prevs.length > 0) editable = prevs[prevs.length - 1]
              }
              if (!editable) return
              try {
                editable.focus({ preventScroll: true })
                const sel = window.getSelection()
                if (sel) {
                  sel.removeAllRanges()
                  const range = document.createRange()
                  range.selectNodeContents(editable)
                  range.collapse(true)
                  sel.addRange(range)
                }
              } catch (e) {}
            }, 300)
          }
          const jumpRel = (dir) => {
            if (hunks.length === 0) return
            // v1.13: positions = the RENDERED (model) line number of each
            // hunk's first NEW row — user insertions shift the model, so
            // origin coordinates would mislocate hunks.
            const positions = hunks.map((h, k) => {
              const node = hunkRefs[k]
              const el = node && node.querySelector('.dsh-fe-line.dsh-fe-new[data-n]')
              if (el) { const n = Number(el.getAttribute('data-n')); if (n > 0) return n }
              const mm = modelRef.m
              if (mm && mm.map[h.newStart] >= 0) return mm.map[h.newStart] + 1
              return h.newStart + 1
            })
            const caret = caretLineAt()
            // No insertion point in the edit area: position = "before the
            // first line" → next lands on the first hunk, prev wraps to the
            // last (user-confirmed behavior).
            const t = pickHunkFromTop(positions, caret > 0 ? caret : 0, dir)
            if (t >= 0) jumpTo(t)
          }
          const onDiffScroll = () => {
            if (scrollGate.pending) return
            scrollGate.pending = true
            setTimeout(() => {
              scrollGate.pending = false
              const el = diffRef.node
              if (!el || hunks.length === 0) return
              const cbox = el.getBoundingClientRect()
              const mid = el.scrollTop + el.clientHeight * 0.35
              let best = -1
              for (let k = 0; k < hunks.length; k++) {
                const node = hunkRefs[k]
                if (!node) continue
                const top = node.getBoundingClientRect().top - cbox.top + el.scrollTop
                if (top <= mid) best = k
                else break
              }
              if (best >= 0 && best !== focusIdx) setFocusIdx(best)
            }, 30)
          }
          const curFocus = hunks.length > 0 ? Math.min(focusIdx === null ? 0 : focusIdx, hunks.length - 1) : 0
          // ---------- v1.22: in-view search ----------
          // Corpus = the edit model's rows in display order (context + hunk-
          // new rows). Matches re-run only when the model/query changed; each
          // render afterwards merely re-wraps overlay marks through the ref
          // painters. Multi-line queries match the rows joined by '\n' and
          // yield one segment entry per covered row.
          const searchRows = searchState.on && m ? m.rows : []
          if (searchState.on) {
            if (searchState.lastModel !== m || searchState.lastVersion !== modelVersion) {
              searchState.lastModel = m
              searchState.lastVersion = modelVersion
              searchState.dirty = true
            }
            if (searchState.dirty) {
              searchState.dirty = false
              const q = searchState.query
              const flat = []
              const byRow = new Map()
              if (q) {
                const starts = []
                const joined = []
                let acc = 0
                for (const r of searchRows) { starts.push(acc); joined.push(r.text); acc += r.text.length + 1 }
                const body = joined.join('\n')
                const ql = q.toLowerCase()
                const bl = body.toLowerCase()
                let k = 0
                for (;;) {
                  const hit = bl.indexOf(ql, k)
                  if (hit < 0) break
                  k = hit + Math.max(1, ql.length)
                  const end = hit + q.length
                  for (let ri = 0; ri < searchRows.length; ri++) {
                    const rs = starts[ri]
                    const re = rs + searchRows[ri].text.length
                    if (re <= hit) continue
                    if (rs >= end) break
                    const segStart = Math.max(hit, rs)
                    const segEnd = Math.min(end, re)
                    const mc = { key: 'm' + searchRows[ri].model, row: searchRows[ri].model, pos: segStart - rs, len: segEnd - segStart }
                    flat.push(mc)
                    let arr = byRow.get(mc.key)
                    if (!arr) { arr = []; byRow.set(mc.key, arr) }
                    arr.push(mc)
                  }
                }
              }
              searchState.matches = flat
              searchState.byRow = byRow
              if (searchState.cur >= flat.length) searchState.cur = flat.length > 0 ? 0 : -1
            }
          }
          const jumpToMatch = (mc) => {
            const code = diffRef.node
            if (!code || !mc) return
            let ed = null
            if (mc.key.charAt(0) === 'm') {
              ed = code.querySelector('.dsh-fe-tx-edit[data-m="' + mc.row + '"]')
            } else {
              const parts = mc.key.split(':')
              const hnode = hunkRefs[Number(parts[0])]
              ed = hnode ? hnode.querySelector('.dsh-fe-old[data-n="' + parts[1] + '"]') : null
            }
            if (!ed) return
            const lineEl = ed.closest('.dsh-fe-line') || ed
            let scroller = null
            let p = lineEl
            while (p && p !== document.body) {
              const oy = getComputedStyle(p).overflowY
              if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight + 1) { scroller = p; break }
              p = p.parentElement
            }
            if (!scroller) scroller = document.scrollingElement || document.documentElement
            const box = lineEl.getBoundingClientRect()
            const sb = scroller.getBoundingClientRect()
            const internal = scroller === code
            const barH = (scopeRef.node && scopeRef.node.firstElementChild && scopeRef.node.firstElementChild.offsetHeight) || 0
            let headerH = internal ? barH + 1 : ((store.tabH || 32) + (store.toolH || 35) + barH + 2)
            if (!internal && toolbarRef.node) {
              const r = toolbarRef.node.getBoundingClientRect()
              if (r.bottom > 0 && r.bottom - sb.top > 0) headerH = Math.max(headerH, r.bottom - sb.top + barH + 2)
            }
            const target = scroller.scrollTop + (box.top - sb.top) - headerH
            try { scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' }) }
            catch (e) { try { scroller.scrollTop = Math.max(0, target) } catch (e2) { try { lineEl.scrollIntoView() } catch (e3) {} } }
            lineEl.classList.add('dsh-fe-scope-flash')
            if (scopeState.flashTimer) clearTimeout(scopeState.flashTimer)
            scopeState.flashTimer = setTimeout(() => { scopeState.flashTimer = null; lineEl.classList.remove('dsh-fe-scope-flash') }, 900)
            // Land the caret on the match start when the row is editable.
            const editable = ed.classList && ed.classList.contains('dsh-fe-tx-edit') ? ed : ed.querySelector('.dsh-fe-tx-edit')
            if (editable) {
              try {
                editable.focus({ preventScroll: true })
                setCaretEl(editable, mc.pos)
              } catch (e) {}
            }
          }
          const searchNav = (dir) => {
            const ms = searchState.matches
            if (!searchState.on || ms.length === 0) return
            const prev = searchState.cur
            let next
            if (dir === 'next') next = prev < 0 ? 0 : (prev + 1) % ms.length
            else next = prev < 0 ? ms.length - 1 : (prev - 1 + ms.length) % ms.length
            searchState.cur = next
            bumpSearch()
            jumpToMatch(ms[next])
          }
          const clearSearchState = () => {
            searchState.on = false
            searchState.query = ''
            searchState.matches = []
            searchState.byRow = new Map()
            searchState.cur = -1
            searchState.dirty = true
          }
          const openSearch = () => {
            const txt = selectedModelText(modelRef.m)
            if (txt !== null && txt !== '') searchState.query = txt
            searchState.on = true
            searchState.dirty = true
            if (searchState.cur >= searchState.matches.length) searchState.cur = -1
            focusSearchRef.n = 1
            bumpSearch()
          }
          const closeSearch = () => {
            clearSearchState()
            bumpSearch()
          }
          // v1.24: hand the ESC handler the live closer for this render.
          closeSearchRef.fn = closeSearch
          const searchBar = searchState.on ? React.createElement('div', { className: 'dsh-fe-searchbar' },
            React.createElement('input', {
              className: 'dsh-fe-searchbox',
              ref: (node) => { inpRef.el = node },
              placeholder: '在文件中搜索…',
              spellCheck: false,
              value: searchState.query,
              onChange: (ev) => {
                searchState.query = String(ev.target.value || '').replace(/\r/g, '')
                searchState.dirty = true
                if (searchState.cur >= searchState.matches.length) searchState.cur = -1
                bumpSearch()
              },
              onKeyDown: (ev) => {
                if ((ev.ctrlKey || ev.metaKey) && (ev.key || '').toLowerCase() === 'f') {
                  // Stay inside the plugin's search box — never the browser's.
                  ev.preventDefault(); ev.stopPropagation()
                  try { inpRef.el && inpRef.el.select() } catch (e) {}
                  return
                }
                if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); searchNav(ev.shiftKey ? 'prev' : 'next') }
                else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeSearch() }
                else if (ev.key === 'ArrowUp') { ev.preventDefault(); searchNav('prev') }
                else if (ev.key === 'ArrowDown') { ev.preventDefault(); searchNav('next') }
              },
            }),
            searchState.matches.length > 0 ? React.createElement('span', { className: 'dsh-fe-searchcount' }, (searchState.cur < 0 ? 1 : searchState.cur + 1) + '/' + searchState.matches.length) : null,
            React.createElement('button', { type: 'button', className: 'dsh-fe-searchbtn', title: '上一处匹配（Shift+Enter）', onClick: () => searchNav('prev') }, IconChevUp()),
            React.createElement('button', { type: 'button', className: 'dsh-fe-searchbtn', title: '下一处匹配（Enter / ↓）', onClick: () => searchNav('next') }, IconChevDown()),
          ) : null
          // Only exists while the file has diff changes; disappears with them.
          const jump = hunks.length > 0 ? React.createElement('div', { className: 'dsh-fe-jump' },
            React.createElement('span', { className: 'dsh-fe-jump-count' }, (curFocus + 1) + ' / ' + hunks.length),
            React.createElement('button', { type: 'button', className: 'dsh-fe-jump-btn', title: '上一处变更（以编辑区插入点所在行为基准向上查找，循环；无插入点时到最后一块）', onClick: () => jumpRel('prev') }, IconChevUp(), '上一处'),
            React.createElement('button', { type: 'button', className: 'dsh-fe-jump-btn', title: '下一处变更（以编辑区插入点所在行为基准向下查找，循环；无插入点时到第一块）', onClick: () => jumpRel('next') }, '下一处', IconChevDown()),
          ) : null
          return React.createElement('div', { className: 'dsh-fe-pane', ref: (node) => { paneRef.node = node } },
            toolbar,
            error ? React.createElement('div', { className: 'dsh-fe-err' }, String(error)) : null,
            React.createElement('div', { className: 'dsh-fe-diffwrap' },
              // v1.8.1: zero-height sticky strip — the jump pill stays pinned
              // below the sticky header stack while the page scrolls, and is
              // simply absent when the file has no hunks. v1.22: the search
              // bar rides the same strip, pinned LEFT of the jump pill.
              (jump || searchState.on) ? React.createElement('div', { className: 'dsh-fe-jumprow' }, searchBar, jump) : null,
              scopeBar,
              React.createElement('div', {
                className: 'dsh-fe-diff',
                ref: (node) => { diffRef.node = node },
                onScroll: (ev) => { onDiffScroll(ev); drawSel() },
                onKeyDown: onCodeKeyDown,
                onKeyDownCapture: onCodeKeyDownCapture,
                onPaste: onCodePaste,
                onMouseDown: (ev) => {
                  if (ev.button !== 0) return
                  const p = pointAt(ev.clientX, ev.clientY)
                  // v1.32.0: the editor owns the whole gesture — no native
                  // selection (which the per-line contentEditable would clamp
                  // to one row), no native focus juggling. The click point
                  // becomes a model coordinate and the drag paints it.
                  if (p) {
                    try { ev.preventDefault() } catch (e) {}
                    selCtl.begin(p, ev.shiftKey)
                    if (ev.detail > 1) selCtl.detail(p, ev.detail)
                  } else if (!isRowTarget(ev.target)) {
                    // Pressed outside the code (hunk head, toolbar gap…):
                    // drop a standing selection rather than leave it behind.
                    clearSel()
                  }
                },
                onMouseMove: (ev) => {
                  if (!selState.dragging) return
                  if ((ev.buttons & 1) !== 1) { selCtl.finish(null); return }
                  const p = pointAt(ev.clientX, ev.clientY)
                  if (p) selCtl.move(p)
                },
                onMouseUp: (ev) => { selCtl.finish(pointAt(ev.clientX, ev.clientY)) },
              },
                plan.map((b, i) => {
                  if (b.kind === 'ctx') {
                    return React.createElement('div', { key: 'c' + i, className: 'dsh-fe-code' },
                      b.rows.map((r) => renderModelRow(r, '', hlStateCur)))
                  }
                  const hIdx = hunkOrdinal[b.h.id]
                  const isFocus = focusIdx !== null && hIdx === curFocus
                  return React.createElement('div', {
                    key: 'h' + i,
                    className: 'dsh-fe-hunk' + (isFocus ? ' dsh-fe-hunk-cur' : ''),
                    ref: (node) => { hunkRefs[hIdx] = node },
                  },
                    React.createElement('div', { className: 'dsh-fe-hunk-head' },
                      React.createElement('span', null,
                        (b.h.oldLen === 0 ? ('第 ' + (b.h.oldStart + 1) + ' 行前') : ('第 ' + (b.h.oldStart + 1) + '–' + (b.h.oldStart + b.h.oldLen) + ' 行'))
                        + ' → ' +
                        (b.h.newLen === 0 ? ('第 ' + (b.h.newStart + 1) + ' 行前') : ('第 ' + (b.h.newStart + 1) + '–' + (b.h.newStart + b.h.newLen) + ' 行'))),
                      React.createElement('span', { className: 'dsh-fe-spacer' }, null),
                      React.createElement(IconBtn, { tone: 'ok', small: true, title: '接受此块修改', onClick: () => onHunk(b.h, 'accept'), icon: IconCheck }),
                      React.createElement(IconBtn, { tone: 'no', small: true, className: 'dsh-fe-pair', title: '拒绝此块修改', onClick: () => onHunk(b.h, 'reject'), icon: IconCross }),
                    ),
                    React.createElement('div', { className: 'dsh-fe-code' },
                      b.oldRows.map((r) => renderRoRow('o' + i + ':' + r.n, 'dsh-fe-old', r.n, r.text, hlStateBase)),
                      b.newRows.map((r) => renderModelRow(r, 'dsh-fe-new', hlStateCur)),
                    ),
                  )
                }),
                blocks.length === 0 ? React.createElement('div', { className: 'dsh-fe-msg' }, '没有未决定的修改') : null,
              ),
            ),
          )
        })

        function FileView(props) {
          const sid = props.sessionId
          useStore()
          // v1.16.0: white-dot updates ride the narrow dirty channel.
          useDirty()
          React.useEffect(() => { if (sid) store.setSessionId(sid) }, [sid])
          // v1.12: the shell renders ONLY the active conversation view
          // (ConversationSession's renderSlot passes `only: active.id`), so
          // this component's mount ⟺ the 文件 view is active. The flag drives
          // the modified bar's overlay posture — floating over the editor's
          // bottom edge here, classic in-flow layout on 对话/轨迹.
          React.useEffect(() => {
            // v1.13: a prompt orphaned by a view switch mid-question must not
            // linger — clear it ('cancel' = keep the edits as they are).
            if (store.askSave) {
              const q = store.askSave
              store.askSave = null
              try { q.resolve('cancel') } catch (e) {}
            }
            store.setFileViewActive(true)
            return () => store.setFileViewActive(false)
          }, [])
          const [dragIdx, setDragIdx] = React.useState(null)
          // v1.8.1: sticky header heights. The tabs bar pins to the top of
          // the scrollport; its measured height feeds the toolbar/jump
          // sticky offsets (CSS var on the viewer root + store for JS math).
          const viewerRef = React.useState({ node: null })[0]
          const tabsRef = React.useState({ node: null })[0]
          React.useEffect(() => {
            const el = tabsRef.node
            if (el && el.offsetHeight > 0) {
              store.tabH = el.offsetHeight
              if (viewerRef.node) viewerRef.node.style.setProperty('--dsh-fe-tabs-h', el.offsetHeight + 'px')
            }
          })
          // v1.12.1: write the clearance var directly from the dockH channel
          // — no React re-render of this thousand-line view involved. The
          // v1.12.0 render-driven effect made every bar resize reconcile the
          // whole DiffPane tree (and the padding change reflow the editor),
          // which is the toggle CPU spike being fixed.
          React.useEffect(() => {
            const apply = () => { if (viewerRef.node) viewerRef.node.style.setProperty('--dsh-fe-dock-h', (store.dockH || 0) + 'px') }
            apply()
            return store.onDockH(apply)
          }, [])
          // v1.13: save-confirmation dialog (requirement 6), rendered as a
          // fixed overlay here so tab close, close-all and session switches
          // all ask through the shared store slot.
          const answerAsk = (choice) => {
            if (!store.askSave) return
            const q = store.askSave
            store.askSave = null
            store.emit()
            try { q.resolve(choice) } catch (e) {}
          }
          const askOverlay = store.askSave ? React.createElement('div', {
            className: 'dsh-fe-ask-mask',
            onClick: () => answerAsk('cancel'),
          },
            React.createElement('div', { className: 'dsh-fe-ask-card', onClick: (ev) => ev.stopPropagation() },
              React.createElement('div', { className: 'dsh-fe-ask-title' }, '保存修改？'),
              React.createElement('div', { className: 'dsh-fe-ask-body' },
                '以下文件有未保存的编辑（' + store.askSave.reason + '）：',
                store.askSave.paths.map((p) => React.createElement('div', { key: p, className: 'dsh-fe-ask-path' }, p)),
              ),
              React.createElement('div', { className: 'dsh-fe-ask-actions' },
                React.createElement('button', { className: 'dsh-fe-btn dsh-fe-btn-ok', onClick: () => answerAsk('save') }, '保存'),
                React.createElement('button', { className: 'dsh-fe-btn', onClick: () => answerAsk('discard') }, '不保存'),
                React.createElement('button', { className: 'dsh-fe-btn', onClick: () => answerAsk('cancel') }, '取消'),
              ),
            ),
          ) : null
          // v1.32.8: reject-refused dialog. Deliberately NOT dismissible by
          // clicking the mask or with Escape (the save dialog is): this is the
          // outcome of an explicit destructive action and the only place the
          // per-file reason is ever shown, so it stays until acknowledged.
          // Same layer + classes as the save dialog (fixed overlay, z-index 60)
          // because it must paint above the sticky toolbar and the file view.
          // v1.13: closing a tab with unsaved edits asks first (req 6).
          const closeTabWithPrompt = async (t) => {
            const m = editModels.get(editKeyOf(store.root, t))
            if (m && m.dirty) {
              const choice = await new Promise((resolve) => {
                store.askSave = { paths: [t], reason: '关闭标签', resolve: resolve }
                store.emit()
              })
              if (choice === 'cancel') return
              if (choice === 'save') {
                const r = await saveModel(m, sid, t)
                if (r && r.ok) store.requestRefresh()
                else if (!r || !(r.code === 'stale' && r.payload)) showToast('保存失败：' + ((r && (r.message || r.error)) || '未知错误'))
              } else {
                discardModel(m)
              }
            }
            store.closeTab(t)
          }
          const closeAllWithPrompt = async () => {
            const dirtyTabs = store.tabs.filter((t) => {
              const m = editModels.get(editKeyOf(store.root, t))
              return m && m.dirty
            })
            if (dirtyTabs.length > 0) {
              const choice = await new Promise((resolve) => {
                store.askSave = { paths: dirtyTabs, reason: '关闭全部标签', resolve: resolve }
                store.emit()
              })
              if (choice === 'cancel') return
              if (choice === 'save') {
                for (const t of dirtyTabs) {
                  const m = editModels.get(editKeyOf(store.root, t))
                  if (m) await saveModel(m, sid, t)
                }
                store.requestRefresh()
              } else {
                for (const t of dirtyTabs) {
                  const m = editModels.get(editKeyOf(store.root, t))
                  if (m) discardModel(m)
                }
              }
            }
            store.closeAll()
          }
          const tabs = store.tabs
          const active = store.active
          const dirty = store.dirtyFiles
          if (tabs.length === 0) {
            // v1.32.8: the save dialog is a sibling of the viewer, NOT a member
            // of the tabbed branch — closing a tab needs no open tab, so
            // returning the bare empty state here dropped it. Both branches
            // therefore carry `askOverlay`.
            // NOTE: the reject dialog deliberately does NOT live here — it is
            // rendered by ModifiedBar (the component whose buttons raise it),
            // because the bar is always mounted and this view is not; rendering
            // it in both slots would stack two identical masks.
            return React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'dsh-fe-viewer' },
                React.createElement('div', { className: 'dsh-fe-msg' }, '没有打开的文件：在左侧工作区的「项目文件」中点击/双击文件，或点击修改文件列表中的路径。')),
              askOverlay,
            )
          }
          return React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dsh-fe-viewer', ref: (node) => { viewerRef.node = node } },
              React.createElement('div', { className: 'dsh-fe-filetabs', ref: (node) => { tabsRef.node = node } },
                tabs.map((t, i) => React.createElement('span', {
                  key: t,
                  className: 'dsh-fe-filetab' + (t === active ? ' dsh-fe-filetab-on' : '') + (dragIdx === i ? ' dsh-fe-tab-drag' : ''),
                  title: t,
                  draggable: true,
                  onClick: () => store.activate(t),
                  onDragStart: (ev) => { setDragIdx(i); if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move' },
                  onDragEnter: (ev) => { ev.preventDefault(); if (dragIdx !== null && dragIdx !== i) { store.moveTab(dragIdx, i); setDragIdx(i) } },
                  onDragOver: (ev) => ev.preventDefault(),
                  onDragEnd: () => setDragIdx(null),
                },
                  React.createElement('span', { className: 'dsh-fe-tab-ic' }, IconFile()),
                  t.split('/').pop(),
                  // v1.13: WHITE dot = unsaved user edits (replaces the old
                  // DIFF-pending yellow dot, which is removed entirely).
                  dirty.has(t) ? React.createElement('span', { className: 'dsh-fe-tab-dirty', title: '有未保存的编辑' }, null) : null,
                  React.createElement(IconBtn, {
                    small: true,
                    className: 'dsh-fe-tab-x',
                    title: '关闭标签',
                    onClick: (ev) => { ev.stopPropagation(); void closeTabWithPrompt(t) },
                    icon: IconClose,
                  }),
                )),
                React.createElement(IconBtn, {
                  className: 'dsh-fe-tab-closeall',
                  title: '关闭全部',
                  onClick: () => void closeAllWithPrompt(),
                  icon: IconClose,
                }),
              ),
              React.createElement(DiffPane, { sid: sid, path: active }),
            ),
            askOverlay,
            // v1.24: run-target picker (fixed layer outside the toolbar's
            // sticky stacking context — see store.runMenu).
            React.createElement(RunMenuLayer, null),
          )
        }

        // ---------- v1.24: terminal view + run button ----------
        // One memoized line per parser line: the parser mutates only the lines
        // it touches, so unchanged lines keep their object identity and React
        // skips them while a command streams output.
        const TermLine = React.memo(function TermLine(props) {
          const runs = props.line.runs
          if (runs.length === 0) return React.createElement('div', { className: 'dsh-fe-term-line' }, '\u00a0')
          return React.createElement('div', { className: 'dsh-fe-term-line' },
            runs.map((r, i) => (r.s ? React.createElement('span', { key: i, style: r.s }, r.t) : r.t)))
        })
        function TerminalView(props) {
          const sid = props && props.sessionId
          const [, force] = React.useState(0)
          React.useEffect(() => {
            if (!sid) return undefined
            return termStore.subscribe(sid, () => force((n) => n + 1))
          }, [sid])
          const t = sid ? termStore.rec(sid) : null
          const bodyRef = React.useState({ el: null })[0]
          const inpRef = React.useState({ el: null })[0]
          const [draft, setDraft] = React.useState('')
          const [stick, setStick] = React.useState(true)
          const version = t ? t.version : 0
          const busy = !!(t && t.busy)
          // Follow the tail unless the user scrolled up to read history.
          React.useEffect(() => {
            const el = bodyRef.el
            if (el && stick) el.scrollTop = el.scrollHeight
          }, [version, stick])
          if (!sid) return null
          const histMove = (dir) => {
            if (!t || t.history.length === 0) return
            let idx = t.histIdx
            if (dir < 0) idx = idx < 0 ? t.history.length - 1 : Math.max(0, idx - 1)
            else idx = idx < 0 ? -1 : Math.min(t.history.length - 1, idx + 1)
            t.histIdx = idx
            setDraft(idx < 0 ? '' : t.history[idx])
          }
          const submit = () => {
            if (!t) return
            const text = draft
            setDraft('')
            if (t.busy) {
              // A running command owns stdin: the line answers its prompt.
              void termStore.write(sid, text + (t.eol || '\r\n'))
              return
            }
            if (text.trim() === '') return
            t.history = t.history.filter((x) => x !== text).concat([text]).slice(-100)
            t.histIdx = -1
            void termStore.run(sid, text)
          }
          const lines = t ? t.parser.lines : []
          return React.createElement('div', { className: 'dsh-fe-term' },
            React.createElement('div', { className: 'dsh-fe-term-head' },
              React.createElement('span', { className: 'dsh-fe-term-dot' + (busy ? ' dsh-fe-term-dot-on' : '') }),
              React.createElement('span', { className: 'dsh-fe-term-title' }, '终端'),
              t && t.shell ? React.createElement('span', { className: 'dsh-fe-chip' }, t.shell) : null,
              React.createElement('span', { className: 'dsh-fe-term-cwd', title: t ? t.cwd : '' }, t ? t.cwd : ''),
              React.createElement('span', { className: 'dsh-fe-spacer' }, null),
              busy && t && t.command ? React.createElement('span', { className: 'dsh-fe-term-cmd', title: t.command }, '▶ ' + t.command) : null,
              busy ? React.createElement('button', { type: 'button', className: 'dsh-fe-btn dsh-fe-btn-no', title: '中断当前进程（Ctrl+C）', onClick: () => { void termStore.signal(sid) } }, '中断') : null,
              React.createElement('button', { type: 'button', className: 'dsh-fe-btn', title: '清空输出（Ctrl+L）', onClick: () => { void termStore.clear(sid) } }, '清空'),
              React.createElement('button', { type: 'button', className: 'dsh-fe-btn', title: '结束并重新建立终端会话', onClick: () => { void termStore.restart(sid) } }, '重启'),
            ),
            t && t.error ? React.createElement('div', { className: 'dsh-fe-err' }, t.error) : null,
            React.createElement('div', {
              className: 'dsh-fe-term-body',
              ref: (node) => { bodyRef.el = node },
              onClick: () => { if (inpRef.el) { try { inpRef.el.focus() } catch (e) {} } },
              onScroll: (ev) => {
                const el = ev.currentTarget
                const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
                if (atBottom !== stick) setStick(atBottom)
              },
            },
              t && t.motd ? React.createElement('div', { className: 'dsh-fe-term-motd' }, t.motd) : null,
              lines.map((line, i) => React.createElement(TermLine, { key: i, line: line, rev: line.rev })),
              !stick ? React.createElement('button', {
                type: 'button',
                className: 'dsh-fe-term-jump',
                onClick: () => setStick(true),
              }, '跳到最新') : null,
            ),
            React.createElement('div', { className: 'dsh-fe-term-inputrow' },
              React.createElement('span', { className: 'dsh-fe-term-prompt' + (busy ? ' dsh-fe-term-prompt-on' : '') }, busy ? '›' : '$'),
              React.createElement('input', {
                className: 'dsh-fe-term-input',
                ref: (node) => { inpRef.el = node },
                value: draft,
                spellCheck: false,
                autoComplete: 'off',
                placeholder: busy ? '输入内容并回车 → 发送给运行中的进程' : '输入命令，回车执行（↑↓ 历史 · Ctrl+L 清空）',
                onChange: (ev) => setDraft(ev.target.value),
                onKeyDown: (ev) => {
                  const k = ev.key || ''
                  if (k === 'Enter') { ev.preventDefault(); submit(); return }
                  if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'c') { ev.preventDefault(); if (busy) void termStore.signal(sid); return }
                  if ((ev.ctrlKey || ev.metaKey) && k.toLowerCase() === 'l') { ev.preventDefault(); void termStore.clear(sid); return }
                  if (k === 'ArrowUp') { ev.preventDefault(); histMove(-1); return }
                  if (k === 'ArrowDown') { ev.preventDefault(); histMove(1) }
                },
              }),
            ),
          )
        }
        // Project run button (file-view toolbar, right end): detects the run
        // target, prefers the project-local environment, and drives the
        // terminal view. A single unambiguous target runs on the first click;
        // several targets open a picker.
        function RunButton(props) {
          // DiffPane passes `sid`; accept `sessionId` too so the button keeps
          // working if it is ever mounted from a session-scoped slot.
          const sid = props && (props.sessionId || props.sid)
          const path = String((props && props.path) || '')
          // v1.32.9: unsaved edits are flushed before the run (IDE behaviour) —
          // DiffPane hands its own ensureSaved() down, and a refused save aborts
          // the run instead of silently executing the bytes on disk.
          const beforeRun = props && props.beforeRun
          const [, force] = React.useState(0)
          React.useEffect(() => {
            if (!sid) return undefined
            return termStore.subscribe(sid, () => force((n) => n + 1))
          }, [sid])
          const t = sid ? termStore.rec(sid) : null
          const btnRef = React.useState({ el: null })[0]
          const [detecting, setDetecting] = React.useState(false)
          // Latest probe: null until the first one lands. The tooltip is the ONLY
          // place the target is named before the click, so this runs on mount and on
          // every tab switch (cheap: the host resolves the one open file).
          const [probe, setProbe] = React.useState(null)
          const busy = !!(t && t.busy)
          const place = () => {
            const el = btnRef.el
            const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null
            return {
              top: (rect ? rect.bottom + 4 : 80) + 'px',
              right: Math.max(8, rect ? (window.innerWidth || 0) - rect.right : 16) + 'px',
            }
          }
          const detect = async () => {
            if (!sid) return null
            setDetecting(true)
            const r = await termStore.detect(sid, path)
            setDetecting(false)
            setProbe(r)
            return r
          }
          React.useEffect(() => { setProbe(null); void detect() }, [sid, path])
          const cand = probe && probe.ok !== false && probe.candidates && probe.candidates.length > 0 ? probe.candidates[0] : null
          const why = !probe
            ? '检测中…'
            : (probe.ok === false ? (probe.error || '检测失败') : (probe.reason || '当前文件不可运行'))
          // The greyed state keeps its click: a disabled button cannot explain
          // itself (and its title may never be shown at all).
          const notice = () => { store.setRunMenu({ ...place(), reason: why }) }
          const onMain = async () => {
            if (!sid) return
            if (busy) { void termStore.signal(sid); return }
            if (!cand) { notice(); return }
            if (typeof beforeRun === 'function' && !(await beforeRun())) return
            // Re-probe: the runtime may have been provisioned, or the file replaced,
            // since the mount probe — that answer only ever fed the tooltip.
            const r = await detect()
            const go = r && r.ok !== false && r.candidates && r.candidates[0] ? r.candidates[0] : null
            if (!go) { notice(); return }
            switchToTerminalView()
            await termStore.run(sid, go.command, 'run')
          }
          return React.createElement('button', {
            type: 'button',
            ref: (node) => { btnRef.el = node },
            className: 'dsh-fe-runbtn' + (busy ? ' dsh-fe-runbtn-busy' : (detecting ? ' dsh-fe-runbtn-wait' : '')) + (!busy && !cand ? ' dsh-fe-runbtn-off' : ''),
            title: busy
              ? '停止：中断当前运行的进程'
              : (cand ? ('运行 ' + cand.label + (cand.detail ? '  ·  ' + cand.detail : '')) : why),
            'aria-label': busy ? '停止运行' : (cand ? '运行当前文件' : '当前文件不可运行'),
            'aria-disabled': (!busy && !cand) ? 'true' : undefined,
            'aria-busy': detecting || undefined,
            onClick: () => { void onMain() },
          }, busy ? IconStop() : IconPlay())
        }
        // v1.32.9: with at most one target there is nothing to pick, so the old
        // picker is gone. Its layer stays, reused as the NOTICE that explains a
        // greyed button (still rendered by FileView — see store.runMenu).
        const closeRunMenu = () => { if (store.runMenu) store.setRunMenu(null) }
        function RunMenuLayer() {
          const menu = store.runMenu
          if (!menu) return null
          return React.createElement('div', { className: 'dsh-fe-runmenu-layer' },
            React.createElement('div', { className: 'dsh-fe-menu-veil', onClick: () => closeRunMenu() }),
            React.createElement('div', { className: 'dsh-fe-runmenu', style: { top: menu.top, right: menu.right } },
              React.createElement('div', { className: 'dsh-fe-runmenu-head' }, '无法运行'),
              React.createElement('div', { className: 'dsh-fe-runmenu-empty' }, menu.reason || '当前文件不可运行'),
              React.createElement('div', { className: 'dsh-fe-runmenu-foot' }, '可运行的文件：.py / .js / .mjs / .cjs / .ts / .ps1 / .sh；其它命令请在「终端」中输入'),
              React.createElement('button', { type: 'button', className: 'dsh-fe-runmenu-ok', onClick: () => closeRunMenu() }, '知道了'),
            ),
          )
        }
        // ---------- registrations ----------
        ensureStyle()
        ctx.effect(() => removeStyle, 'dsh-file-edit: stylesheet')
        // v1.24: ESC closes the plugin's own in-view search box from anywhere
        // (the box keeps focus-independent state, so the key must be observed
        // document-wide). Capture phase + stopPropagation so an editor row's
        // own ESC (revert this line) does not also fire on the same keypress.
        ctx.effect(() => {
          const onKeyDown = (ev) => {
            if (ev.key !== 'Escape' || searchClosers.size === 0) return
            if (!searchState.on) return
            for (const fn of Array.from(searchClosers)) { try { fn() } catch (e) {} }
            try { ev.preventDefault(); ev.stopPropagation() } catch (e) {}
          }
          window.addEventListener('keydown', onKeyDown, true)
          return () => window.removeEventListener('keydown', onKeyDown, true)
        }, 'dsh-file-edit: escape closes search')
        // v1.13: flush pending edit-history persists on teardown and on page
        // unload (best effort — the debounced persist already covers normal
        // flows; this closes the shutdown window).
        ctx.effect(() => {
          const flush = () => {
            for (const [, h] of persistTimers) { try { h() } catch (e) {} }
            persistTimers.clear()
            for (const mm of editModels.values()) persistNow(mm)
            // v1.16.0: drop any pending coalesced highlight repaints; their
            // elements are being detached.
            if (hlRaf) { hlRafCancel(hlRaf); hlRaf = 0 }
            hlPending.clear()
          }
          let off = null
          try { window.addEventListener('beforeunload', flush); off = () => window.removeEventListener('beforeunload', flush) } catch (e) {}
          return () => { flush(); if (off) off() }
        }, 'dsh-file-edit: edit engine cleanup')
        // Static (non-dynamic) client plugins use the raw slots service, which
        // does NOT auto-assign a shadowing priority — pass one explicitly so
        // this entry renders instead of the shipped sidebar browser (lower
        // priority wins in a single cell).
        ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
          { name: 'sidebar.workspaces', priority: -100 },
          WorkspaceSidebar,
        ))
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
          { name: 'conversation.input.dock', id: 'dsh-file-edit-bar', order: 30 },
          ModifiedBar,
        ))
        ctx.slots.inject('conversation.view', () => ctx.slots.register(
          { name: 'conversation.view', id: 'dsh-file-edit', order: 20, label: '文件' },
          FileView,
        ))
        // v1.24: terminal view tab — order 30 places it to the right of 文件.
        ctx.slots.inject('conversation.view', () => ctx.slots.register(
          { name: 'conversation.view', id: 'dsh-file-edit-term', order: 30, label: '终端' },
          TerminalView,
        ))
      },
    }
  },
})
