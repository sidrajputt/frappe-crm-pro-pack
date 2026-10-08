/* CRM Pro Pack - TEMPORARY browser diagnostics. See docs/DEBUGGING.md.
 *
 * Finds out what freezes or crashes a page. It watches, and reports to the browser console and (through
 * crm_addons.debuglog.client_log) to <bench>/logs/crm_addons_debug.log:
 *
 *   - the main thread being blocked (a heartbeat that stops, and the browser's own "long task" reports)
 *   - a DOM-change storm (something that keeps changing the page, for ever: the usual cause of a frozen tab)
 *   - requests that are slow, failing, or piling up
 *   - script errors and unhandled promise errors
 *   - memory and page size growing, and timers that are never stopped
 *   - what the person did just before (clicks, route changes, messages between the CRM page and its pop-ups)
 *
 * A frozen tab cannot report itself, so the last moments are also kept in localStorage, and the NEXT page load
 * says "the previous page did not close cleanly" and prints them.
 *
 * It never changes what the page does and swallows its own errors. Switch off: localStorage crm_addons_debug = '0'
 * (or __crmDebug.off()), or `bench --site <site> set-config crm_addons_debug_log 0`.
 */
(function () {
	'use strict'
	if (window.__crmDebug) return
	try { if (localStorage.getItem('crm_addons_debug') === '0') return } catch (e) { /* storage blocked: carry on */ }

	var API = '/api/method/crm_addons.debuglog.client_log'
	var TAG = '[crm-addons debug]'
	var SESSION = Math.random().toString(36).slice(2, 10)
	var inFrame = window.parent !== window
	var FRAME = (inFrame ? 'frame:' : 'top:') + location.pathname.split('/').slice(-2).join('/')
	var ALIVE_KEY = 'crm_addons_debug_alive:' + FRAME
	var C = { log: console.log, info: console.info, warn: console.warn, error: console.error }
	var nativeFetch = window.fetch ? window.fetch.bind(window) : null

	var crumbs = [] // what happened, newest last
	var queue = [] // waiting to be sent to the server
	var off = false
	var busy = false // true while this script itself prints, so it never reacts to its own output
	var failures = 0
	var retryAt = 0
	var inflight = 0
	var lastVisible = Date.now() // when the tab last became visible: timers run late right after a tab wakes up
	var counters = { requests: 0, slow: 0, errors: 0 }

	function hhmmss(t) { var d = new Date(t || Date.now()); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0') }
	function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n) + '...' : s }
	function describe(el) {
		if (!el || !el.tagName) return String(el)
		var d = el.tagName.toLowerCase()
		if (el.id) d += '#' + el.id
		if (el.className && typeof el.className === 'string') d += '.' + clip(el.className.trim().split(/\s+/).slice(0, 2).join('.'), 40)
		return d
	}

	// ---- recording ------------------------------------------------------------------------------------------
	function crumb(text) {
		crumbs.push(hhmmss() + ' ' + clip(text, 220))
		if (crumbs.length > 80) crumbs.shift()
	}

	/** level: INFO (kept as a crumb only), WARN and ERROR (also printed and sent to the server). */
	function note(message, level, detail) {
		try {
			level = level || 'INFO'
			crumb((level === 'INFO' ? '' : level + ' ') + message)
			if (level === 'INFO') return
			busy = true
			;(level === 'ERROR' ? C.error : C.warn).call(console, TAG, message, detail ? '\n' + detail : '')
			busy = false
			queue.push({ l: level, m: message, x: detail || '' })
			if (queue.length > 200) queue.shift()
			scheduleFlush(level === 'ERROR' ? 200 : 1500)
		} catch (e) { busy = false }
	}

	var flushTimer = null
	function scheduleFlush(ms) {
		if (flushTimer || off) return
		flushTimer = setTimeout(function () { flushTimer = null; flush(false) }, ms)
	}

	var csrf = null
	function token() {
		if (csrf) return Promise.resolve(csrf)
		try {
			var t = window.csrf_token || (inFrame && window.parent.csrf_token)
			if (t && String(t).indexOf('{{') < 0) { csrf = t; return Promise.resolve(t) }
		} catch (e) { /* cross-origin parent */ }
		return nativeFetch('/api/method/crm_addons.api.get_csrf_token', { credentials: 'same-origin' })
			.then(function (r) { return r.json() }).then(function (j) { csrf = j.message; return csrf })
	}

	function flush(unloading) {
		if (off || !nativeFetch || !queue.length || (Date.now() < retryAt && !unloading)) return
		var entries = queue.splice(0, 100)
		token().then(function (t) {
			return nativeFetch(API, {
				method: 'POST', credentials: 'same-origin', keepalive: !!unloading,
				headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Frappe-CSRF-Token': t },
				body: JSON.stringify({ entries: entries, page: location.pathname + location.search.replace(/[?&]v=\d+/, ''), session: SESSION + ':' + FRAME }),
			})
		}).then(function (r) { return r.json() }).then(function (j) {
			failures = 0
			if (j && j.message && j.message.enabled === false) { off = true; queue = [] } // switched off on the server
			if (queue.length) scheduleFlush(1000)
		}).catch(function () {
			queue = entries.concat(queue).slice(-200)
			if (++failures >= 3) { retryAt = Date.now() + 120000; failures = 0 } // the server is not answering: stop trying for a while
		})
	}

	// ---- the previous page: did it close cleanly? --------------------------------------------------------------
	function saveAlive(clean) {
		try { localStorage.setItem(ALIVE_KEY, JSON.stringify({ t: Date.now(), clean: !!clean, session: SESSION, url: location.href, crumbs: crumbs.slice(-40) })) } catch (e) { /* ignore */ }
	}
	try {
		var previous = JSON.parse(localStorage.getItem(ALIVE_KEY) || 'null')
		// a record written in the last few seconds belongs to another tab that is still running, not to a dead one
		if (previous && !previous.clean && Date.now() - previous.t > 4000 && Date.now() - previous.t < 30 * 60 * 1000) {
			note('PREVIOUS PAGE DID NOT CLOSE CLEANLY - it froze or crashed (or the tab was killed). Its last sign of life was ' + hhmmss(previous.t) + ', ' + Math.round((Date.now() - previous.t) / 1000) + ' s ago, on ' + clip(previous.url, 120) + '. What it was doing:', 'WARN', (previous.crumbs || []).join('\n'))
		}
	} catch (e) { /* ignore */ }

	// ---- events that explain what the person was doing -----------------------------------------------------------
	document.addEventListener('click', function (e) {
		var el = e.target && e.target.closest ? e.target.closest('a,button,[role=tab],[role=button],input,select,summary') || e.target : e.target
		var text = el && el.tagName && !/^(input|textarea|select)$/i.test(el.tagName) ? clip(el.textContent, 30) : ''
		crumb('click ' + describe(el) + (text ? ' "' + text + '"' : ''))
	}, true)
	;['pushState', 'replaceState'].forEach(function (name) {
		var original = history[name]
		history[name] = function () { try { crumb('route ' + name + ' ' + clip(arguments[2], 100)) } catch (e) { /* ignore */ } return original.apply(this, arguments) }
	})
	window.addEventListener('popstate', function () { crumb('route popstate ' + location.pathname) })
	window.addEventListener('hashchange', function () { crumb('route hash ' + location.hash) })
	window.addEventListener('message', function (e) {
		try { if (e.data && e.data.source === 'crm-addons') crumb('message ' + e.data.type + (inFrame ? ' (to the CRM page)' : ' (from a pop-up)')) } catch (err) { /* ignore */ }
	})
	document.addEventListener('visibilitychange', function () {
		if (!document.hidden) lastVisible = Date.now()
		crumb(document.hidden ? 'tab hidden' : 'tab visible')
	})

	// ---- errors -------------------------------------------------------------------------------------------------------
	window.addEventListener('error', function (e) {
		if (busy) return
		counters.errors++
		if (e.target && e.target !== window && (e.target.src || e.target.href)) return note('Could not load ' + (e.target.src || e.target.href), 'ERROR')
		note((e.message || 'Script error') + ' at ' + clip(String(e.filename || '').split('/').slice(-2).join('/'), 60) + ':' + e.lineno + ':' + e.colno, 'ERROR', e.error && e.error.stack)
	}, true)
	window.addEventListener('unhandledrejection', function (e) {
		if (busy) return
		var r = e.reason
		counters.errors++
		note('Unhandled promise error: ' + clip((r && r.message) || r, 200), 'ERROR', r && r.stack)
	})
	var errorBudget = 20 // console.error is noisy in a big app: report at most this many per minute
	setInterval(function () { errorBudget = 20 }, 60000)
	console.error = function () {
		try {
			if (!busy && errorBudget-- > 0) note('console.error: ' + clip(Array.prototype.map.call(arguments, function (a) { return (a && a.message) || a }).join(' '), 250), 'WARN')
		} catch (e) { /* ignore */ }
		return C.error.apply(console, arguments)
	}

	// ---- requests -------------------------------------------------------------------------------------------------------
	if (nativeFetch) {
		window.fetch = function (input, init) {
			var url = typeof input === 'string' ? input : (input && input.url) || ''
			if (url.indexOf('debuglog.client_log') >= 0) return nativeFetch(input, init) // never report on our own reports
			var short = clip(url.split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace('/api/method/', ''), 80)
			var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase()
			var started = performance.now()
			counters.requests++
			inflight++
			if (inflight >= 6) note(inflight + ' requests are in flight at once (latest: ' + short + ')', 'WARN')
			var p = nativeFetch(input, init)
			function done(status, error) {
				inflight = Math.max(0, inflight - 1)
				var took = Math.round(performance.now() - started)
				var line = method + ' ' + short + ' ' + (error || status) + ' ' + took + 'ms'
				if (error && /abort/i.test(error)) return crumb(line + ' (cancelled by the page)')
				if (error || status >= 400) note(line, 'ERROR')
				else if (took > 3000) { counters.slow++; note('SLOW ' + line, 'WARN') }
				else crumb(line)
			}
			p.then(function (r) { done(r.status) }, function (err) { done(0, (err && err.name) || 'failed') })
			return p
		}
	}

	// ---- the main thread: is it blocked? ----------------------------------------------------------------------------------
	var lastBeat = performance.now()
	var longTasks = []
	setInterval(function () {
		var t = performance.now()
		var late = t - lastBeat - 250
		lastBeat = t
		// not while hidden, not just after waking up, and not when the computer slept (a gap of a minute or more)
		if (late > 800 && late < 60000 && !document.hidden && Date.now() - lastVisible > 3000) {
			note('MAIN THREAD WAS BLOCKED for about ' + Math.round(late) + ' ms (the page did not respond)' + (longTasks.length ? '; browser long tasks: ' + longTasks.splice(0, 4).join(' | ') : ''), 'WARN', 'What happened just before:\n' + crumbs.slice(-15).join('\n'))
		}
	}, 250)
	try {
		new PerformanceObserver(function (list) {
			list.getEntries().forEach(function (entry) {
				if (entry.duration < 300) return
				var a = entry.attribution && entry.attribution[0]
				longTasks.push(Math.round(entry.duration) + 'ms' + (a && a.containerType && a.containerType !== 'window' ? ' in ' + a.containerType + ' ' + (a.containerName || a.containerSrc || '') : ''))
				if (longTasks.length > 20) longTasks.shift()
				if (entry.duration >= 1000) crumb('long task ' + Math.round(entry.duration) + 'ms')
			})
		}).observe({ entryTypes: ['longtask'] })
	} catch (e) { /* not supported (Safari, Firefox) */ }

	// ---- a DOM-change storm: something changing the page non-stop ------------------------------------------------------------
	var mutations = 0
	var samples = {}
	var lastStorm = 0
	try {
		new MutationObserver(function (records) {
			mutations += records.length
			if (mutations > 150) { // only look closer once it is already a lot
				for (var i = 0; i < records.length && i < 30; i++) {
					var r = records[i]
					var key = describe(r.target) + (r.type === 'attributes' ? ' [' + r.attributeName + ']' : r.type === 'childList' ? ' [children]' : ' [text]')
					samples[key] = (samples[key] || 0) + 1
				}
			}
		}).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
	} catch (e) { /* ignore */ }
	setInterval(function () {
		var n = mutations
		mutations = 0
		if (n > 800 && Date.now() - lastStorm > 10000) {
			lastStorm = Date.now()
			var top = Object.keys(samples).sort(function (a, b) { return samples[b] - samples[a] }).slice(0, 6).map(function (k) { return samples[k] + 'x ' + k })
			note('DOM CHANGE STORM: ' + n + ' changes in one second. Most changed: ' + top.join(' ; '), 'WARN', 'If this keeps going, something is re-drawing the page in a loop.\nWhat happened just before:\n' + crumbs.slice(-12).join('\n'))
		}
		samples = {}
	}, 1000)

	// ---- timers that are never stopped ------------------------------------------------------------------------------------------
	var intervals = {}
	var originalSet = window.setInterval
	var originalClear = window.clearInterval
	window.setInterval = function (fn, ms) {
		var id = originalSet.apply(this, arguments)
		try {
			intervals[id] = (ms || 0) + 'ms from ' + clip(((new Error().stack || '').split('\n')[2] || '').trim(), 100)
			var count = Object.keys(intervals).length
			if (count === 40 || count === 80) note(count + ' timers (setInterval) are running and never stopped. Newest: ' + intervals[id], 'WARN')
		} catch (e) { /* ignore */ }
		return id
	}
	window.clearInterval = function (id) { delete intervals[id]; return originalClear.apply(this, arguments) }

	// ---- memory and page size -------------------------------------------------------------------------------------------------------
	var lastHeap = 0
	var lastNodes = 0
	var health = 0
	originalSet(function () {
		try {
			var heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0
			var nodes = document.getElementsByTagName('*').length
			if (++health % 12 === 0) crumb('health heap=' + heap + 'MB nodes=' + nodes + ' timers=' + Object.keys(intervals).length + ' inflight=' + inflight)
			if (heap && lastHeap && heap - lastHeap > 150) note('MEMORY grew by ' + (heap - lastHeap) + ' MB in 5 s (now ' + heap + ' MB)', 'WARN', crumbs.slice(-10).join('\n'))
			else if (heap > 1500) note('MEMORY is very high: ' + heap + ' MB (the tab may crash soon)', 'WARN')
			if (lastNodes && nodes - lastNodes > 5000) note('The page grew by ' + (nodes - lastNodes) + ' elements in 5 s (now ' + nodes + ')', 'WARN', crumbs.slice(-10).join('\n'))
			else if (nodes > 30000) note('The page has ' + nodes + ' elements', 'WARN')
			lastHeap = heap
			lastNodes = nodes
		} catch (e) { /* ignore */ }
	}, 5000)

	// ---- keep the "last moments" record fresh, and send what is waiting --------------------------------------------------------------------------
	originalSet(function () { saveAlive(false); if (queue.length) flush(false) }, 1000)
	window.addEventListener('pagehide', function () { saveAlive(true); flush(true) })

	// ---- a handle for the console ------------------------------------------------------------------------------------------------------------------
	window.__crmDebug = {
		session: SESSION,
		frame: FRAME,
		/** Print what the page has been doing, newest last. */
		dump: function (n) { busy = true; C.log(TAG + ' last ' + (n || 60) + ' events (' + FRAME + ', session ' + SESSION + '):\n' + crumbs.slice(-(n || 60)).join('\n')); busy = false; return crumbs.length },
		crumbs: function () { return crumbs.slice() },
		stats: function () { return { requests: counters.requests, slow: counters.slow, errors: counters.errors, inflight: inflight, timers: Object.keys(intervals).length, nodes: document.getElementsByTagName('*').length, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null } },
		note: function (m) { note('manual: ' + m, 'WARN') },
		/** Turn it off for this browser (reload the page). */
		off: function () { try { localStorage.setItem('crm_addons_debug', '0') } catch (e) { /* ignore */ } },
		on: function () { try { localStorage.removeItem('crm_addons_debug') } catch (e) { /* ignore */ } },
	}

	crumb('start ' + location.pathname + location.search.replace(/[?&]v=\d+/, '') + ' (' + FRAME + ')')
	saveAlive(false)
	busy = true
	C.info.call(console, TAG + ' on (' + FRAME + '). Type __crmDebug.dump() for what the page has been doing, __crmDebug.stats() for its health. The server side logs to <bench>/logs/crm_addons_debug.log.')
	busy = false
	// say hello to the server once, so it can switch the browser side off when the server side is off
	queue.push({ l: 'INFO', m: 'page loaded: ' + navigator.userAgent.slice(0, 90) + ' cores=' + (navigator.hardwareConcurrency || '?') + (navigator.deviceMemory ? ' memory=' + navigator.deviceMemory + 'GB' : ''), x: '' })
	scheduleFlush(800)
})()
