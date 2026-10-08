/* CRM Pro Pack - Campaign Manager: core (environment, theme, server calls, helpers, icons, toasts, dialogs).
 * Every file of the page shares one namespace: window.CM. No build step. */
(() => {
	const { reactive, ref } = Vue
	const CM = (window.CM = { components: {}, views: {} })

	// ------------------------------------------------------------------ theme (follows CRM, never toggled here)
	const params = new URLSearchParams(location.search)
	const store = {
		get(k) { try { return localStorage.getItem(k) } catch (e) { return null } },
		set(k, v) { try { localStorage.setItem(k, v) } catch (e) { /* private mode */ } },
		json(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d } catch (e) { return d } },
	}
	CM.store = store
	/** Opened as a pop-up over CRM (iframe, ?embed=1)? Then the page fills the frame and offers Open-in-new-tab and Close. */
	CM.embed = params.get('embed') === '1' && window.parent !== window
	if (CM.embed) document.documentElement.classList.add('embed')
	/** Tell the CRM page that opened us something (the bridge listens for {source:'crm-addons'}). */
	CM.post = (type, extra) => { try { window.parent.postMessage({ source: 'crm-addons', type, ...(extra || {}) }, location.origin) } catch (e) { /* no parent */ } }
	function readTheme() {
		let t = params.get('theme')
		try { if (window.parent !== window) t = window.parent.document.documentElement.getAttribute('data-theme') || t } catch (e) { /* cross-origin parent */ }
		// CRM keeps its own choice under "theme" (same origin); the dashboard keeps "crm_addons_theme".
		if (!t) { const v = (store.get('theme') || '').replace(/"/g, ''); if (v === 'dark' || v === 'light') t = v }
		if (!t) { const v = store.get('crm_addons_theme'); if (v === 'dark' || v === 'light') t = v }
		if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
		return t
	}
	// Only write when the value changes: setAttribute always queues a mutation record, and in a standalone tab the page
	// 'parent' is the page itself, so an unconditional write fed its own observer in an endless loop (a frozen tab).
	function applyTheme() { const t = readTheme(); if (document.documentElement.getAttribute('data-theme') !== t) document.documentElement.setAttribute('data-theme', t) }
	applyTheme()
	window.addEventListener('storage', applyTheme)
	try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme) } catch (e) { /* old browser */ }
	try { if (window.parent !== window) new MutationObserver(applyTheme).observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }) } catch (e) { /* not embedded */ }
	document.addEventListener('visibilitychange', () => { if (!document.hidden) applyTheme() })

	// ------------------------------------------------------------------ server calls
	let csrf = null; let csrfP = null
	// One token fetch at a time: the page starts several calls at once and a second fetch could invalidate the first token.
	function token() {
		if (csrf) return Promise.resolve(csrf)
		try {
			const t = window.parent !== window && window.parent.csrf_token
			if (t && t !== '{{ csrf_token }}') { csrf = t; return Promise.resolve(csrf) }
		} catch (e) { /* ignore */ }
		if (!csrfP) csrfP = fetch('/api/method/crm_addons.api.get_csrf_token', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => (csrf = j.message)).finally(() => { csrfP = null })
		return csrfP
	}
	const stripHtml = (s) => { const d = document.createElement('div'); d.innerHTML = s; return d.textContent || '' }
	function errorText(body, status) {
		try {
			const msgs = JSON.parse(body._server_messages || '[]').map((m) => JSON.parse(m).message)
			if (msgs.length) return stripHtml(msgs.join(' '))
		} catch (e) { /* fall through */ }
		if (status === 401 || (status === 403 && !body.exception)) return 'Your session has expired. Please log in to the CRM again.'
		if (body.exception) return stripHtml(String(body.exception).replace(/^[\w.]+:\s*/, ''))
		return 'Something went wrong (' + status + ').'
	}
	// Every request settles: a hung server or dropped connection ends in an error after CALL_TIMEOUT instead of leaving a
	// spinner, a disabled button or a "saving" flag on forever.
	const CALL_TIMEOUT = 60000
	async function call(method, args, timeout = CALL_TIMEOUT, signal) {
		const ctl = new AbortController()
		const timer = setTimeout(() => ctl.abort(), timeout)
		const onAbort = () => ctl.abort(); let cancelled = false
		if (signal) { if (signal.aborted) { cancelled = true; ctl.abort() } else signal.addEventListener('abort', () => { cancelled = true; onAbort() }) }
		try {
			const res = await fetch('/api/method/' + method, {
				method: 'POST', credentials: 'same-origin', signal: ctl.signal,
				headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Frappe-CSRF-Token': await token() },
				body: JSON.stringify(args || {}),
			})
			let body = {}
			try { body = await res.json() } catch (e) { /* not json (or aborted while reading) */ }
			if (!res.ok) throw new Error(errorText(body, res.status))
			return body.message
		} catch (e) {
			if (e && e.name === 'AbortError') throw Object.assign(new Error(cancelled ? 'Replaced by a newer request.' : 'The server took too long to answer. Please try again.'), { cancelled })
			throw e
		} finally { clearTimeout(timer) }
	}
	// "Latest wins": starting a request with a key cancels the one still running under that key. Heavy reads (audience counts, lists,
	// previews, reports) are fired again on every keystroke or click; the superseded ones must not pile up and occupy the browser's few
	// connections to the server, or the next click (Save, Continue) would queue behind them and the page would feel stuck.
	const inflight = new Map()
	function latest(key, method, args) {
		const prev = inflight.get(key); if (prev) prev.abort()
		const ctl = new AbortController(); inflight.set(key, ctl)
		return call(method, args, CALL_TIMEOUT, ctl.signal).finally(() => { if (inflight.get(key) === ctl) inflight.delete(key) })
	}
	CM.cancel = (key) => { const c = inflight.get(key); if (c) c.abort(); inflight.delete(key) }
	CM.call = call
	CM.api = (m, a) => call('crm_addons.campaigns.api.' + m, a)
	CM.apiLatest = (key, m, a) => latest(key, 'crm_addons.campaigns.api.' + m, a)
	CM.auto = (m, a) => call('crm_addons.campaigns.automation.' + m, a)
	CM.analytics = (m, a) => call('crm_addons.campaigns.analytics.' + m, a)
	CM.analyticsLatest = (key, m, a) => latest(key, 'crm_addons.campaigns.analytics.' + m, a)

	/** Upload one file to Frappe (private by default) with progress. Resolves to {name, file_url, file_name, file_size}. */
	CM.upload = (file, { isPrivate = true, onProgress, doctype, docname } = {}) =>
		new Promise(async (resolve, reject) => {
			const fd = new FormData()
			fd.append('file', file, file.name)
			fd.append('is_private', isPrivate ? '1' : '0')
			fd.append('folder', 'Home/Attachments')
			if (doctype && docname) { fd.append('doctype', doctype); fd.append('docname', docname) }
			const xhr = new XMLHttpRequest()
			xhr.open('POST', '/api/method/upload_file')
			xhr.setRequestHeader('X-Frappe-CSRF-Token', await token())
			xhr.setRequestHeader('Accept', 'application/json')
			xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)) }
			xhr.onerror = () => reject(new Error('The upload failed. Check your connection and try again.'))
			xhr.onload = () => {
				let body = {}
				try { body = JSON.parse(xhr.responseText) } catch (e) { /* not json */ }
				if (xhr.status >= 200 && xhr.status < 300 && body.message) resolve({ name: body.message.name, file_url: body.message.file_url, file_name: body.message.file_name, file_size: body.message.file_size || file.size })
				else reject(new Error(errorText(body, xhr.status)))
			}
			xhr.send(fd)
		})

	// ------------------------------------------------------------------ shared server data (loaded once)
	const shared = (CM.shared = reactive({ config: null, fields: null, error: '', loading: false }))
	let sharedP = null
	// Resolves when the config is in (or failed). Callers can all await it; it is never started twice at once.
	CM.loadShared = (force) => {
		if (sharedP && !force) return sharedP
		if (shared.config && !force) return Promise.resolve()
		shared.loading = true
		sharedP = (async () => {
			try {
				;[shared.config, shared.fields] = await Promise.all([CM.api('get_config'), CM.api('get_audience_fields')])
				shared.error = ''
				if (shared.config.now) CM.skew = new Date(shared.config.now.replace(' ', 'T')).getTime() - Date.now()
			} catch (e) { shared.error = e.message; sharedP = null } finally { shared.loading = false }
		})()
		return sharedP
	}
	/** The site's "today" (its own time zone, from the server clock), not the browser's. */
	CM.skew = null
	CM.today = () => { const d = CM.skew == null ? new Date() : new Date(Date.now() + CM.skew); return new Date(d.getFullYear(), d.getMonth(), d.getDate()) }

	// ------------------------------------------------------------------ helpers
	const pad = (n) => String(n).padStart(2, '0')
	CM.ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
	const toDate = (s) => (s instanceof Date ? s : /^\d{4}-\d\d-\d\d$/.test(String(s)) ? new Date(+String(s).slice(0, 4), +String(s).slice(5, 7) - 1, +String(s).slice(8, 10)) : new Date(String(s).replace(' ', 'T'))) // a bare day is local, not UTC midnight
	CM.fmt = (s) => (s ? toDate(s).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-')
	CM.fmtDate = (s) => (s ? toDate(s).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '-')
	CM.fmtShort = (s) => (s ? toDate(s).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '-')
	CM.ago = (s) => {
		if (!s) return '-'
		const sec = Math.max(0, (Date.now() - toDate(s).getTime()) / 1000)
		if (sec < 60) return 'just now'
		if (sec < 3600) return Math.floor(sec / 60) + ' min ago'
		if (sec < 86400) return Math.floor(sec / 3600) + ' h ago'
		if (sec < 86400 * 7) return Math.floor(sec / 86400) + ' d ago'
		return CM.fmtDate(s)
	}
	CM.num = (n) => Number(n || 0).toLocaleString()
	CM.pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0)
	CM.pctText = (a, b) => (b ? (Math.round((a / b) * 1000) / 10).toString().replace(/\.0$/, '') + '%' : '-')
	CM.size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')
	CM.leadUrl = (name) => '/crm/leads/' + encodeURIComponent(name)
	CM.initials = (s) => String(s || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?'
	CM.escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
	CM.debounce = (fn, ms) => { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }; d.cancel = () => clearTimeout(t); return d }
	CM.uid = () => Math.random().toString(36).slice(2, 9)
	CM.clone = (o) => JSON.parse(JSON.stringify(o))
	CM.csv = (rows, filename) => {
		const cell = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v }
		const blob = new Blob(['﻿' + rows.map((r) => r.map(cell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' })
		const a = document.createElement('a')
		a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove()
		setTimeout(() => URL.revokeObjectURL(a.href), 2000)
	}
	CM.STATUS_TONE = {
		Draft: 'neutral', Scheduled: 'amber', Queued: 'blue', Running: 'blue', Paused: 'amber', Completed: 'green', Cancelled: 'neutral', Failed: 'red',
		Pending: 'neutral', Sending: 'blue', Sent: 'blue', Delivered: 'green', Read: 'green', Skipped: 'amber',
		APPROVED: 'green', PENDING: 'amber', REJECTED: 'red', DISABLED: 'neutral', PAUSED: 'amber', Active: 'green', Archived: 'neutral',
	}

	// ------------------------------------------------------------------ routing (hash based; #/c/NAME stays valid for links from CRM)
	const route = (CM.route = reactive({ path: '', parts: [], query: {} }))
	function parseHash() {
		const raw = location.hash.replace(/^#/, '') || '/campaigns'
		const [path, qs] = raw.split('?')
		route.path = path
		route.parts = path.split('/').filter(Boolean).map(decodeURIComponent)
		route.query = Object.fromEntries(new URLSearchParams(qs || ''))
	}
	parseHash()
	window.addEventListener('hashchange', parseHash)
	CM.go = (path) => { location.hash = '#' + path }
	CM.replace = (path) => { history.replaceState(null, '', '#' + path); parseHash() }

	// ------------------------------------------------------------------ pop-up (embed) helpers
	/** Open a CRM page (a lead). Inside the CRM pop-up the CRM tab itself goes there; otherwise a new tab, as before. */
	CM.openCrm = (e, url) => {
		if (e && (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1)) return // let the browser open its own tab
		if (e) e.preventDefault()
		if (CM.embed) CM.post('navigate', { url })
		else window.open(url, '_blank', 'noopener')
	}
	/** Overlays that must get Escape (and clicks) before the pop-up's own Close does. */
	CM.overlays = { dialogs: 0, pops: 0 }
	CM.overlayOpen = () => CM.overlays.dialogs > 0 || CM.overlays.pops > 0 || !!document.querySelector('.te')
	/** Closers that may veto closing the pop-up (unsaved work). Each returns true / a promise of true to allow. */
	CM.closeGuards = new Set()
	CM.requestClose = async () => {
		for (const g of [...CM.closeGuards]) { let ok = true; try { ok = await g() } catch (e) { ok = true } if (ok === false) return }
		CM.post('close')
	}
	/** The same page without ?embed (keeping ?v) and with the current route, in a new tab; the pop-up stays open. */
	CM.openInTab = () => {
		const q = new URLSearchParams(location.search); const v = q.get('v')
		window.open(location.pathname + (v ? '?v=' + encodeURIComponent(v) : '') + location.hash, '_blank')
	}
	/** Scroll the page (its own pane) back to the top. */
	CM.scrollTop = (smooth) => { const m = document.querySelector('.main'); if (m && m.scrollTo) m.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'instant' }); window.scrollTo({ top: 0 }) }

	// ------------------------------------------------------------------ toasts and confirm dialogs
	const toasts = (CM.toasts = reactive([]))
	CM.toast = (message, type = 'ok', ms = 4200) => {
		const t = { id: CM.uid(), message, type }
		toasts.push(t)
		setTimeout(() => { const i = toasts.findIndex((x) => x.id === t.id); if (i >= 0) toasts.splice(i, 1) }, type === 'err' ? Math.max(ms, 7000) : ms)
	}
	const confirmState = (CM.confirmState = reactive({ open: false, title: '', message: '', confirmText: 'Confirm', danger: false, resolve: null, detail: '' }))
	CM.confirm = (opts) => new Promise((resolve) => {
		if (confirmState.resolve) { const prev = confirmState.resolve; confirmState.resolve = null; prev(false) } // never leave an earlier question hanging
		Object.assign(confirmState, { open: true, title: '', message: '', confirmText: 'Confirm', danger: false, detail: '' }, opts, { resolve })
	})

	// ------------------------------------------------------------------ icons (24px grid, stroke)
	CM.ICONS = {
		send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.5.5 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
		mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-10 6L2 7"/>',
		whatsapp: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/><path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1"/>',
		layers: '<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
		users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
		user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
		chart: '<path d="M3 3v18h18"/><path d="M7 16V9"/><path d="M12 16V5"/><path d="M17 16v-4"/>',
		settings: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.8v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
		plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
		search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
		x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
		'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
		'chevron-down': '<path d="m6 9 6 6 6-6"/>',
		'chevron-up': '<path d="m18 15-6-6-6 6"/>',
		'chevron-right': '<path d="m9 18 6-6-6-6"/>',
		'chevron-left': '<path d="m15 18-6-6 6-6"/>',
		'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
		'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
		'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
		'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
		more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
		star: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z"/>',
		copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
		edit: '<path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
		trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
		eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
		upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
		download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
		paperclip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
		file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><path d="M14 2v6h6"/>',
		image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
		heading: '<path d="M6 12h12"/><path d="M6 4v16"/><path d="M18 4v16"/>',
		text: '<path d="M21 6H3"/><path d="M15 12H3"/><path d="M17 18H3"/>',
		link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
		minus: '<path d="M5 12h14"/>',
		spacer: '<path d="M12 3v18"/><path d="m8 7 4-4 4 4"/><path d="m8 17 4 4 4-4"/>',
		columns: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',
		banner: '<rect width="20" height="12" x="2" y="6" rx="2"/><path d="M6 12h6"/>',
		share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4"/><path d="m15.4 6.5-6.8 4"/>',
		code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
		bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
		italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
		underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/>',
		list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
		'list-ol': '<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
		'align-center': '<path d="M21 6H3"/><path d="M17 12H7"/><path d="M19 18H5"/>',
		clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
		calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
		alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
		info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
		shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
		refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.7 2.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.7-2.7L3 16"/><path d="M8 16H3v5"/>',
		grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
		rows: '<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="18" height="7" x="3" y="14" rx="1"/>',
		filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5Z"/>',
		play: '<path d="m6 3 14 9-14 9Z"/>',
		pause: '<rect width="4" height="16" x="6" y="4"/><rect width="4" height="16" x="14" y="4"/>',
		ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
		retry: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
		external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
		sparkles: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
		monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
		phone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
		maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
		target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
		zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9Z"/>',
		inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.2a2 2 0 0 0-1.7 1.1Z"/>',
		save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
		grip: '<circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/>',
		variable: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
		bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z"/>',
		globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10Z"/>',
		undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
		flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><path d="M4 22v-7"/>',
		hash: '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="M16 3l-2 18"/>',
		sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>',
	}
}) ()
