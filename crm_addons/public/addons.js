/* CRM Pro Pack UI. Loaded into the Frappe CRM page by the app (see inject.py), so CRM's own
 * source is never edited.
 *
 *   - a "Sales Dashboard" button on CRM's own Dashboard page
 *   - floating "Meetings", "Follow-ups" and "Dashboard" buttons on the Kanban view of Leads
 *   - "Meetings" and "Follow-ups" tabs next to CRM's own tabs on a Lead page
 *   - the follow-up form (call attempt, outcome, remark, next follow-up) and the follow-up queue
 *
 * The tabs are added by cloning CRM's own tab buttons (standard role="tablist" / role="tab"
 * markup). If a CRM update changes that markup, the tabs quietly do not appear; the floating
 * buttons and the "Schedule Meeting" header button keep working.
 */
(function () {
	'use strict'
	if (window.__crmAddonsUI) return
	window.__crmAddonsUI = true

	var API = '/api/method/crm_addons.'
	var VER = ((document.currentScript && document.currentScript.src) || '').split('v=')[1] || ''
	var NS = 'http://www.w3.org/2000/svg'

	// ---- icons (Lucide / Feather paths) -------------------------------------------------------
	var ICONS = {
		calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
		'phone-call':
			'<path d="M15.05 5A5 5 0 0 1 19 8.95M15.05 1A9 9 0 0 1 23 8.94"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
		chart: '<path d="M3 3v18h18"/><path d="M8 17v-6M13 17V7M18 17v-3"/>',
		send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
		video: '<path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
		users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
		edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
		trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
		funnel: '<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>',
		'chart-column': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
		ellipsis: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
		alert: '<path d="m10.29 3.86-8.18 14.14A2 2 0 0 0 3.82 21h16.36a2 2 0 0 0 1.71-3l-8.18-14.14a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
	}

	function svg(name, cls) {
		var s = document.createElementNS(NS, 'svg')
		s.setAttribute('viewBox', '0 0 24 24')
		s.setAttribute('fill', 'none')
		s.setAttribute('stroke', 'currentColor')
		s.setAttribute('stroke-width', '2')
		s.setAttribute('stroke-linecap', 'round')
		s.setAttribute('stroke-linejoin', 'round')
		s.setAttribute('class', cls || 'cra-i')
		s.setAttribute('aria-hidden', 'true')
		s.innerHTML = ICONS[name] || ''
		return s
	}

	// ---- small DOM helper (text always goes in as text, never as HTML) -----------------------------
	function h(tag, props, kids) {
		var e = document.createElement(tag)
		Object.keys(props || {}).forEach(function (k) {
			var v = props[k]
			if (v === null || v === undefined || v === false) return
			if (k === 'class') e.className = v
			else if (k === 'text') e.textContent = v
			else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v)
			else e.setAttribute(k, v === true ? '' : v)
		})
		;[].concat(kids === undefined ? [] : kids).forEach(function (c) {
			if (c === null || c === undefined || c === false) return
			e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
		})
		return e
	}

	function clear(node) {
		while (node.firstChild) node.removeChild(node.firstChild)
	}

	// ---- dates --------------------------------------------------------------------------------------
	function parse(s) {
		return s ? new Date(String(s).replace(' ', 'T')) : null
	}
	function fmt(s) {
		var d = parse(s)
		return d ? d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''
	}
	function fmtRange(a, b) {
		var s = parse(a)
		var e = parse(b)
		if (!s) return ''
		var out = fmt(a)
		if (e) {
			out += ' - ' + (s.toDateString() === e.toDateString() ? e.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : fmt(b))
		}
		return out
	}
	function pad(n) {
		return (n < 10 ? '0' : '') + n
	}
	function toLocalInput(d) {
		return d ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : ''
	}
	function toSql(local) {
		return local ? local.replace('T', ' ') + (local.length === 16 ? ':00' : '') : null
	}
	function inFuture(days, hour) {
		var d = new Date()
		d.setDate(d.getDate() + days)
		d.setHours(hour, 0, 0, 0)
		return d
	}

	// ---- server calls ---------------------------------------------------------------------------------
	/** fetch() that gives up after 25 seconds, so a request that never answers cannot leave a button or a
	 * panel waiting for ever. */
	function timedFetch(url, init) {
		init = init || {}
		if (typeof AbortController !== 'function') return fetch(url, init)
		var ctl = new AbortController()
		var timer = setTimeout(function () { ctl.abort() }, 25000)
		init.signal = ctl.signal
		return fetch(url, init).then(
			function (r) { clearTimeout(timer); return r },
			function (e) { clearTimeout(timer); throw e }
		)
	}

	var csrfPromise = null
	function csrf() {
		if (window.csrf_token && String(window.csrf_token).indexOf('{{') < 0) return Promise.resolve(window.csrf_token)
		if (!csrfPromise) {
			csrfPromise = timedFetch(API + 'api.get_csrf_token', { credentials: 'same-origin' })
				.then(function (r) { return r.json() })
				.then(function (j) { return j.message })
				.catch(function (e) { csrfPromise = null; throw e }) // a failed attempt must not be remembered for ever
		}
		return csrfPromise
	}

	function serverMessage(j, status) {
		try {
			var list = JSON.parse(j._server_messages || '[]')
			var msg = list.map(function (m) { return JSON.parse(m).message }).join(' ')
			if (msg) return msg.replace(/<[^>]+>/g, '')
		} catch (e) { /* fall through */ }
		return (j && (j.exception || j.exc_type)) || 'Request failed (' + status + ')'
	}

	function call(method, args) {
		return csrf()
			.then(function (token) {
				return timedFetch(API + method, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Frappe-CSRF-Token': token },
					body: JSON.stringify(args || {}),
				})
			})
			.then(function (r) {
				return r.json().then(
					function (j) {
						if (!r.ok) throw new Error(serverMessage(j, r.status))
						return j.message
					},
					function () { throw new Error('Request failed (' + r.status + ')') }
				)
			})
	}

	var configPromise = null
	function config() {
		if (!configPromise) {
			configPromise = Promise.all([call('api.get_client_config'), call('followups.get_config').catch(function () { return null })])
				.then(function (a) {
					a[0].fu = a[1]
					return a[0]
				})
				.catch(function (e) {
					configPromise = null
					throw e
				})
		}
		return configPromise
	}

	var bridgeLoading = null
	function bridge() {
		if (window.crmAddons) return Promise.resolve(window.crmAddons)
		if (bridgeLoading) return bridgeLoading
		bridgeLoading = new Promise(function (resolve, reject) {
			var s = document.createElement('script')
			var failed = function () {
				bridgeLoading = null // the next click tries again
				s.remove()
				reject(new Error('The meetings screen could not be loaded.'))
			}
			var limit = setTimeout(failed, 15000)
			s.src = '/assets/crm_addons/bridge.js?v=' + VER
			s.onload = function () { clearTimeout(limit); bridgeLoading = null; resolve(window.crmAddons) }
			s.onerror = function () { clearTimeout(limit); failed() }
			document.head.appendChild(s)
		})
		return bridgeLoading
	}

	// ---- toast + modal ----------------------------------------------------------------------------------
	function toast(text, bad) {
		var t = h('div', { class: 'cra-toast' + (bad ? ' cra-bad' : ''), role: 'status', text: text })
		document.body.appendChild(t)
		setTimeout(function () { t.remove() }, bad ? 6000 : 3000)
	}

	var modals = []
	function openModal(title, body, wide) {
		var overlay, dialog
		function close() {
			overlay.remove()
			modals = modals.filter(function (m) { return m !== api })
		}
		var api = { close: close }
		dialog = h('div', { class: 'cra-dialog' + (wide ? ' cra-wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
			h('div', { class: 'cra-dialog-head' }, [
				h('div', { class: 'cra-dialog-title', text: title }),
				h('button', { class: 'cra-icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, [svg('x')]),
			]),
			h('div', { class: 'cra-dialog-body' }, body),
		])
		overlay = h('div', { class: 'cra-overlay', onmousedown: function (e) { if (e.target === overlay) close() } }, [dialog])
		document.body.appendChild(overlay)
		modals.push(api)
		return api
	}
	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && modals.length) modals[modals.length - 1].close()
	})

	// ---- widgets -------------------------------------------------------------------------------------------
	function chip(text, tone) {
		return h('span', { class: 'cra-chip' + (tone ? ' cra-' + tone : ''), text: text })
	}

	function statusTone(status) {
		return { Connected: 'green', 'Did Not Pick': 'red', 'Did Not Connect': 'amber' }[status] || ''
	}

	function outcomeTone(outcome) {
		return {
			'Did Not Pick': 'red',
			'Did Not Connect': 'amber',
			Interested: 'green',
			'Meeting Scheduled': 'green',
			'Not Interested': 'red',
			'Ask for Detail': 'blue',
			'Call Back Later': 'amber',
		}[outcome] || ''
	}

	/** A row of pills where exactly one (or, when ``optional``, at most one) can be picked. */
	function pills(options, value, optional, onChange) {
		var current = value || ''
		var wrap = h('div', { class: 'cra-pills', role: 'group' })
		function draw() {
			clear(wrap)
			options.forEach(function (o) {
				wrap.appendChild(
					h('button', {
						type: 'button',
						class: 'cra-pill' + (o === current ? ' cra-on cra-' + (statusTone(o) || 'plain') : ''),
						'aria-pressed': o === current ? 'true' : 'false',
						text: o,
						onclick: function () {
							current = o === current && optional ? '' : o
							draw()
							if (onChange) onChange(current)
						},
					})
				)
			})
		}
		draw()
		return {
			el: wrap,
			get: function () { return current },
			set: function (v) { current = v || ''; draw() },
		}
	}

	function field(label, control, hint) {
		return h('div', { class: 'cra-field' }, [h('label', { class: 'cra-label', text: label }), control, hint])
	}

	/** Date and time of the next follow-up, with quick buttons. */
	function nextPicker(initial) {
		var input = h('input', { class: 'cra-input', type: 'datetime-local' })
		input.value = toLocalInput(parse(initial))
		function quick(label, getDate) {
			return h('button', { type: 'button', class: 'cra-chip cra-btn-chip', text: label, onclick: function () { input.value = getDate() ? toLocalInput(getDate()) : '' } })
		}
		var el = h('div', {}, [
			input,
			h('div', { class: 'cra-quick' }, [
				quick('In 2 hours', function () { return new Date(Date.now() + 2 * 3600 * 1000) }),
				quick('Tomorrow 10:00', function () { return inFuture(1, 10) }),
				quick('In 3 days', function () { return inFuture(3, 10) }),
				quick('Next week', function () { return inFuture(7, 10) }),
				quick('No next follow-up', function () { return null }),
			]),
		])
		return { el: el, input: input, set: function (d) { input.value = d ? toLocalInput(d) : '' } }
	}

	/** Open the follow-up form (the same window style as Schedule Meeting). */
	function openFollowUp(o) {
		return bridge()
			.then(function (b) { b.openFollowUp({ reference_docname: o.reference_docname, entry: o.entry }) })
			.catch(function (err) { toast(err.message, true) })
	}

	// ---- meeting outcome form ----------------------------------------------------------------------------------
	function openOutcomeForm(meeting, done) {
		var outcome = pills(['Held', 'No Show', 'Rescheduled'], meeting.meeting_outcome, false)
		var notes = h('textarea', { class: 'cra-input', rows: '3', placeholder: 'What was discussed? Any decisions or next steps.' })
		notes.value = meeting.outcome_notes || ''
		var picker = nextPicker(null)
		var error = h('div', { class: 'cra-error', hidden: true })
		var saveBtn = h('button', { type: 'button', class: 'cra-btn cra-primary', text: 'Save outcome' })
		var m = openModal('Meeting outcome - ' + meeting.subject, [
			field('What happened?', outcome.el),
			field('Notes', notes),
			field('Next follow-up (optional)', picker.el),
			error,
			h('div', { class: 'cra-actions' }, [h('button', { type: 'button', class: 'cra-btn', text: 'Cancel', onclick: function () { m.close() } }), saveBtn]),
		])
		saveBtn.addEventListener('click', function () {
			error.hidden = true
			if (!outcome.get()) {
				error.textContent = 'Choose what happened at the meeting.'
				error.hidden = false
				return
			}
			saveBtn.disabled = true
			call('api.record_meeting_outcome', { name: meeting.name, outcome: outcome.get(), notes: notes.value.trim(), next_follow_up_on: toSql(picker.input.value) })
				.then(function () {
					m.close()
					toast('Outcome saved')
					window.dispatchEvent(new CustomEvent('cra:followups-changed'))
					if (done) done()
				})
				.catch(function (err) {
					saveBtn.disabled = false
					error.textContent = err.message
					error.hidden = false
				})
		})
	}

	// ---- campaign activity (a tab on the Lead page) ---------------------------------------------------
	function renderCampaigns(panel, r) {
		clear(panel)
		panel.appendChild(h('div', { class: 'cra-empty', text: 'Loading...' }))
		call('campaigns.api.lead_campaign_history', { lead: r.name })
			.then(function (rows) {
				clear(panel)
				panel.appendChild(h('div', { class: 'cra-panel-head' }, [
					h('div', { class: 'cra-panel-title' }, [svg('send'), h('span', { text: 'Campaign activity' })]),
					h('button', { type: 'button', class: 'cra-btn', onclick: function () { openCampaigns() } }, [svg('send'), h('span', { text: 'Campaign Manager' })]),
				]))
				if (!rows.length) return panel.appendChild(h('div', { class: 'cra-empty', text: 'This lead has not been part of a campaign yet.' }))
				var list = h('div', { class: 'cra-list' })
				rows.forEach(function (x) {
					var when = x.read_at || x.delivered_at || x.sent_at || x.failed_at || x.modified
					var tone = x.status === 'Failed' ? 'red' : x.status === 'Skipped' ? 'amber' : x.status === 'Read' || x.status === 'Delivered' || x.status === 'Sent' ? 'green' : ''
					var detail = x.skip_reason || x.failure_reason
					list.appendChild(h('div', { class: 'cra-card' }, [
						h('div', { class: 'cra-card-top' }, [
							h('div', { class: 'cra-card-title' }, [
								h('a', { href: '#', class: 'cra-link', text: x.campaign_name, onclick: function (e) { e.preventDefault(); openCampaigns('#/c/' + encodeURIComponent(x.campaign)) } }),
								chip(x.channel),
								chip(x.status, tone),
							]),
						]),
						h('div', { class: 'cra-meta' }, [
							when ? h('span', { text: fmt(when) || when }) : null,
							detail ? h('span', { text: detail }) : null,
						]),
					]))
				})
				panel.appendChild(list)
			})
			.catch(function (err) {
				clear(panel)
				panel.appendChild(h('div', { class: 'cra-empty cra-bad', text: err.message }))
			})
	}

	// ---- follow-ups panel (a tab on the Lead page) ---------------------------------------------------
	function renderFollowUps(panel, r) {
		clear(panel)
		panel.appendChild(h('div', { class: 'cra-empty', text: 'Loading...' }))
		call('followups.list_follow_ups', { reference_doctype: r.doctype, reference_name: r.name })
			.then(function (res) { draw(res) })
			.catch(function (err) {
				clear(panel)
				panel.appendChild(h('div', { class: 'cra-empty cra-bad', text: err.message }))
			})

		function refresh() { renderFollowUps(panel, r) }
		function log(entry) {
			openFollowUp({ reference_docname: r.name, entry: entry })
		}
		var last = null

		function draw(res) {
			last = res
			clear(panel)
			var s = res.summary
			var head = h('div', { class: 'cra-panel-head' }, [
				h('div', { class: 'cra-panel-title' }, [svg('phone-call'), h('span', { text: 'Follow-ups' })]),
				h('button', { type: 'button', class: 'cra-btn cra-primary', onclick: function () { log(null) } }, [svg('plus'), h('span', { text: 'Add follow-up' })]),
			])
			var facts = h('div', { class: 'cra-facts' })
			if (s.streak > 0) facts.appendChild(chip(s.streak + (s.streak === 1 ? ' call' : ' calls') + ' in a row not picked / connected', s.streak >= 3 ? 'red' : 'amber'))
			else if (s.last_status === 'Connected') facts.appendChild(chip('Last call connected', 'green'))
			if (s.calls) facts.appendChild(chip(s.calls + (s.calls === 1 ? ' call' : ' calls') + ' logged'))
			if (res.score !== null && res.score !== undefined) facts.appendChild(chip('Score ' + res.score + ' - ' + res.score_band, res.score_band === 'Hot' ? 'green' : res.score_band === 'Warm' ? 'amber' : ''))
			panel.appendChild(head)
			if (s.next) {
				var due = parse(s.next.next_follow_up_on)
				var overdue = due && due < new Date()
				panel.appendChild(
					h('div', { class: 'cra-next' + (overdue ? ' cra-late' : '') }, [
						svg(overdue ? 'alert' : 'clock'),
						h('div', { class: 'cra-next-text' }, [
							h('div', { class: 'cra-strong', text: (overdue ? 'Follow-up overdue: ' : 'Next follow-up: ') + fmt(s.next.next_follow_up_on) }),
							s.next.remark ? h('div', { class: 'cra-muted', text: s.next.remark }) : null,
						]),
						h('button', {
							type: 'button', class: 'cra-btn',
							onclick: function () {
								call('followups.complete_follow_up', { name: s.next.name })
									.then(function (res) { toast('Marked done'); draw(res); window.dispatchEvent(new CustomEvent('cra:followups-changed', { detail: res })) })
									.catch(function (err) { toast(err.message, true) })
							},
						}, [svg('check'), h('span', { text: 'Mark done' })]),
					])
				)
			}
			if (facts.childNodes.length) panel.appendChild(facts)

			if (!res.items.length) {
				panel.appendChild(h('div', { class: 'cra-empty', text: 'No follow-ups yet. Log the first call attempt.' }))
				return
			}
			var list = h('div', { class: 'cra-list' })
			res.items.forEach(function (it) {
				var title = it.mode === 'Call' ? 'Attempt ' + it.attempt_no + ' - ' + (it.outcome || 'Call') : 'Follow-up'
				var actions = []
				if (it.can_edit) {
					actions.push(h('button', { type: 'button', class: 'cra-icon-btn', title: 'Edit', 'aria-label': 'Edit', onclick: function () { log(it) } }, [svg('edit')]))
					if (res.can_delete) {
						actions.push(h('button', {
							type: 'button', class: 'cra-icon-btn', title: 'Delete', 'aria-label': 'Delete',
							onclick: function () {
								if (!window.confirm('Delete this follow-up?')) return
								call('followups.delete_follow_up', { name: it.name })
									.then(function (x) { draw(x); window.dispatchEvent(new CustomEvent('cra:followups-changed', { detail: x })) })
									.catch(function (err) { toast(err.message, true) })
							},
						}, [svg('trash')]))
					}
				}
				list.appendChild(
					h('div', { class: 'cra-card' }, [
						h('div', { class: 'cra-card-top' }, [
							h('div', { class: 'cra-card-title' }, [
								chip(title, outcomeTone(it.outcome)),
							]),
							h('div', { class: 'cra-card-actions' }, actions),
						]),
						it.remark ? h('div', { class: 'cra-remark', text: it.remark }) : null,
						h('div', { class: 'cra-meta' }, [
							h('span', { text: fmt(it.followed_up_on) }),
							h('span', { text: 'by ' + (it.by || '') }),
							it.next_follow_up_on ? h('span', { text: 'Next: ' + fmt(it.next_follow_up_on) + (it.next_closed ? ' (done)' : '') }) : null,
						]),
					])
				)
			})
			panel.appendChild(list)
		}
		panel.__reload = refresh
	}

	// ---- meetings panel (a tab on the Lead page) -------------------------------------------------------
	function renderMeetings(panel, r) {
		clear(panel)
		panel.appendChild(h('div', { class: 'cra-empty', text: 'Loading...' }))

		function schedule() {
			bridge()
				.then(function (b) { b.openEditor({ reference_doctype: r.doctype, reference_docname: r.name, onSaved: function () { renderMeetings(panel, r) } }) })
				.catch(function (err) { toast(err.message, true) })
		}

		call('api.get_meetings', { reference_doctype: r.doctype, reference_name: r.name })
			.then(function (rows) {
				clear(panel)
				panel.appendChild(
					h('div', { class: 'cra-panel-head' }, [
						h('div', { class: 'cra-panel-title' }, [svg('calendar'), h('span', { text: 'Meetings' })]),
						h('button', { type: 'button', class: 'cra-btn cra-primary', onclick: schedule }, [svg('plus'), h('span', { text: 'Schedule meeting' })]),
					])
				)
				if (!rows.length) {
					panel.appendChild(h('div', { class: 'cra-empty', text: 'No meetings yet. Schedule one with a Google Meet link.' }))
					return
				}
				var list = h('div', { class: 'cra-list' })
				rows.forEach(function (m) {
					var tone = m.status === 'Cancelled' ? 'red' : m.status === 'Completed' ? 'green' : 'blue'
					var buttons = []
					if (m.google_meet_link && m.status === 'Scheduled') {
						buttons.push(h('a', { class: 'cra-btn', href: m.google_meet_link, target: '_blank', rel: 'noopener' }, [svg('video'), h('span', { text: 'Join' })]))
					}
					if (m.can_edit && m.status !== 'Cancelled' && (!m.meeting_outcome || m.meeting_outcome === 'Rescheduled')) {
						buttons.push(h('button', { type: 'button', class: 'cra-btn', onclick: function () { openOutcomeForm(m, function () { renderMeetings(panel, r) }) } }, [svg('check'), h('span', { text: 'Record outcome' })]))
					}
					buttons.push(h('button', {
						type: 'button', class: 'cra-btn', text: 'Open',
						onclick: function () { bridge().then(function (b) { b.openMeeting(m.name) }).catch(function (err) { toast(err.message, true) }) },
					}))
					list.appendChild(
						h('div', { class: 'cra-card' }, [
							h('div', { class: 'cra-card-top' }, [
								h('div', { class: 'cra-card-title' }, [h('span', { class: 'cra-strong', text: m.subject }), chip(m.status, tone), m.meeting_outcome ? chip(m.meeting_outcome, m.meeting_outcome === 'Held' ? 'green' : 'amber') : null]),
								h('div', { class: 'cra-card-actions' }, buttons),
							]),
							m.outcome_notes ? h('div', { class: 'cra-remark', text: m.outcome_notes }) : null,
							h('div', { class: 'cra-meta' }, [
								h('span', { text: fmtRange(m.starts_on, m.ends_on) }),
								h('span', { text: (m.attendees || []).length + ' guests' }),
								h('span', { text: 'by ' + (m.organizer_name || '') }),
							]),
						])
					)
				})
				panel.appendChild(list)
			})
			.catch(function (err) {
				clear(panel)
				panel.appendChild(h('div', { class: 'cra-empty cra-bad', text: err.message }))
			})
		panel.__reload = function () { renderMeetings(panel, r) }
	}

	// ---- follow-up queue ---------------------------------------------------------------------------------------
	// The queue is the Follow-ups workspace: a large pop-up over the CRM with an "Open in a new tab" button. Managers
	// see everyone's follow-ups there, sales users their own. `where` may be a tab hash such as '#today'.
	function openQueue(doctype, where) {
		return bridge()
			.then(function (b) { b.openFollowUps(typeof where === 'string' ? where : '') })
			.catch(function (err) { toast(err.message, true) })
	}

	window.crmAddonsUI = { openQueue: openQueue, openFollowUp: openFollowUp, loadBridge: bridge }

	function openDashboard(hash) {
		return bridge()
			.then(function (b) { b.openDashboard(typeof hash === 'string' ? hash : undefined) })
			.catch(function (err) { toast(err.message, true) })
	}

	function openCampaigns(hash) {
		return bridge()
			.then(function (b) { b.openCampaigns(typeof hash === 'string' ? hash : '') })
			.catch(function (err) { toast(err.message, true) })
	}

	// ---- routing ------------------------------------------------------------------------------------------------------
	function route() {
		if (/^\/crm\/dashboard\/?$/.test(location.pathname)) return { kind: 'dashboard' }
		var m = location.pathname.match(/^\/crm\/leads(?:\/(.*))?$/)
		if (!m) return null
		var doctype = 'CRM Lead'
		var rest = (m[1] || '').replace(/\/+$/, '')
		if (!rest || rest === 'view' || rest.indexOf('view/') === 0) {
			return { kind: 'list', doctype: doctype, viewType: rest.indexOf('view/') === 0 ? rest.slice(5).split('/')[0] : '' }
		}
		return { kind: 'record', doctype: doctype, name: decodeURIComponent(rest.split('/')[0]) }
	}

	// ---- floating buttons (every Leads view) ---------------------------------------------------------------
	var fab = null
	var badgeTimer = null
	var badgeListener = null

	function removeFab() {
		if (fab) fab.remove()
		fab = null
		clearInterval(badgeTimer)
		badgeTimer = null
		// every set of floating buttons used to leave its refresh listener behind
		if (badgeListener) window.removeEventListener('cra:followups-changed', badgeListener)
		badgeListener = null
	}

	function ensureFab(r, c) {
		if (fab && fab.__doctype === r.doctype && document.body.contains(fab)) return
		removeFab()
		// same order as the menus: Sales Dashboard, Follow-ups, Meetings, Campaigns
		var kids = [
			h('button', { type: 'button', class: 'cra-fab-btn', title: 'Sales Dashboard', onclick: function () { openDashboard() } }, [svg('chart'), h('span', { text: 'Sales Dashboard' })]),
		]
		var badge = h('span', { class: 'cra-badge', hidden: true })
		if (c.follow_ups_enabled) {
			kids.push(h('button', { type: 'button', class: 'cra-fab-btn', title: 'Follow-ups', onclick: function () { openQueue(r.doctype) } }, [svg('phone-call'), h('span', { text: 'Follow-ups' }), badge]))
		}
		kids.push(
			h('button', {
				type: 'button', class: 'cra-fab-btn', title: 'Meetings',
				onclick: function () { bridge().then(function (b) { b.openCalendar({ reference_doctype: r.doctype, view: 'agenda' }) }).catch(function (err) { toast(err.message, true) }) },
			}, [svg('calendar'), h('span', { text: 'Meetings' })])
		)
		if (c.campaigns_enabled) {
			kids.push(h('button', { type: 'button', class: 'cra-fab-btn', title: 'Campaign Manager', onclick: function () { openCampaigns() } }, [svg('send'), h('span', { text: 'Campaigns' })]))
		}
		if (c.follow_ups_enabled) {
			var refreshBadge = function () {
				if (document.hidden) return // nobody is looking: the next visit refreshes it
				call('followups.get_queue', { scope: 'mine', reference_doctype: r.doctype })
					.then(function (res) {
						var n = res.counts.overdue + res.counts.today
						badge.hidden = !n
						badge.textContent = String(n)
						badge.className = 'cra-badge' + (res.counts.overdue ? ' cra-late' : '')
					})
					.catch(function () {})
			}
			refreshBadge()
			badgeTimer = setInterval(refreshBadge, 180000)
			badgeListener = refreshBadge
			window.addEventListener('cra:followups-changed', refreshBadge)
		}
		fab = h('div', { class: 'cra-fab', 'data-cra': 'fab' }, kids)
		fab.__doctype = r.doctype
		document.body.appendChild(fab)
	}

	// ---- "Sales Dashboard" button on CRM's own Dashboard page ------------------------------------------------------
	var dashLink = null
	var dashSeenAt = 0

	function removeDashLink() {
		if (dashLink) dashLink.remove()
		dashLink = null
		dashSeenAt = 0
	}

	// The same shortcuts are offered in the Dashboard header and in CRM's side menu.
	// Order: the Sales Dashboard first (it also holds the Lead Nurturing view, so that has no link of its own), then
	// Follow-ups, Meetings and the Campaign Manager.
	function shortcuts(c) {
		var list = [{ key: 'dashboard', label: 'Sales Dashboard', icon: 'chart-column', title: 'Sales Dashboard (sales, calls, meetings and lead nurturing)', run: function () { openDashboard() } }]
		if (c.follow_ups_enabled) list.push({ key: 'followups', label: 'Follow-ups', icon: 'phone-call', title: 'Follow-ups', run: function () { openQueue('CRM Lead') } })
		list.push({
			key: 'meetings', label: 'Meetings', icon: 'calendar', title: 'Meetings',
			run: function () { bridge().then(function (b) { b.openCalendar({ reference_doctype: 'CRM Lead', view: 'agenda' }) }).catch(function (err) { toast(err.message, true) }) },
		})
		if (c.campaigns_enabled) list.push({ key: 'campaigns', label: 'Campaigns', icon: 'send', title: 'Campaign Manager', run: function () { openCampaigns() } })
		return list
	}

	/** A copy of CRM's own icon element (same width / height / class / stroke attributes) that holds one of our
	 * Lucide drawings. Nothing is forced: size, colour and stroke come from the element it was copied from. */
	function nativeIcon(protoSvg, name) {
		var el
		if (protoSvg) {
			el = protoSvg.cloneNode(false)
			Array.prototype.slice.call(el.attributes).forEach(function (a) {
				if (/^(data-|id$|fill-rule|clip-rule|xmlns:)/.test(a.name)) el.removeAttribute(a.name)
			})
		} else {
			el = document.createElementNS(NS, 'svg')
			el.setAttribute('class', 'size-4 shrink-0 text-ink-gray-7')
		}
		var stroke = parseFloat(protoSvg && protoSvg.getAttribute('stroke-width'))
		var lucide = protoSvg && /^0 0 24 24$/.test(protoSvg.getAttribute('viewBox') || '')
		el.setAttribute('viewBox', '0 0 24 24')
		el.setAttribute('fill', 'none')
		el.setAttribute('stroke', 'currentColor')
		el.setAttribute('stroke-width', lucide && stroke ? String(stroke) : '1.5')
		el.setAttribute('stroke-linecap', 'round')
		el.setAttribute('stroke-linejoin', 'round')
		el.setAttribute('aria-hidden', 'true')
		el.innerHTML = ICONS[name] || ''
		return el
	}

	/** Turn a deep copy of one of CRM's own rows / buttons into ours: new label, our icon, no ids. */
	function retarget(el, proto, label, iconName) {
		el.removeAttribute('id')
		el.removeAttribute('aria-current')
		el.removeAttribute('data-cra-hidden')
		el.style.removeProperty('display')
		el.className = String(el.className).replace(/router-link-(exact-)?active/g, '')
		Array.prototype.forEach.call(el.querySelectorAll('[id]'), function (n) { n.removeAttribute('id') })
		var old = (proto.textContent || '').trim()
		var nodes = el.querySelectorAll('*')
		var labelEl = null
		if (old) for (var i = 0; i < nodes.length; i++) if (!nodes[i].children.length && nodes[i].textContent.trim() === old) labelEl = nodes[i]
		if (labelEl) { labelEl.textContent = label; labelEl.classList.add('cra-lbl') }
		else if (old) { el.appendChild(h('span', { class: 'cra-lbl', text: label })) }
		var protoSvg = proto.querySelector('svg')
		var icon = nativeIcon(protoSvg, iconName)
		var oldSvg = el.querySelector('svg')
		if (oldSvg) oldSvg.replaceWith(icon)
		else el.insertBefore(icon, el.firstChild)
		return labelEl
	}

	// ---- shortcuts in the Dashboard header -------------------------------------------------------------------------------
	// One compact segmented control built from copies of CRM's own "Refresh" button, so it looks like the
	// rest of the header. Narrower than 1100px it shows icons only; narrower than 800px a single "..." button.
	function headerProto(header) {
		var right = header.lastElementChild
		if (!right) return null
		var want = translated('Refresh')
		var fallback = null
		var btns = right.querySelectorAll('button')
		for (var i = 0; i < btns.length; i++) {
			if (btns[i].closest('[data-cra]')) continue
			fallback = fallback || btns[i]
			if (btns[i].textContent.trim() === want) return btns[i]
		}
		return fallback
	}

	function headerButton(proto, s, iconOnly) {
		var el
		if (proto) {
			el = proto.cloneNode(true)
			el.removeAttribute('disabled')
			var lab = retarget(el, proto, s.label, s.icon)
			if (iconOnly && lab) lab.remove()
			if (!lab && !iconOnly) el.appendChild(h('span', { class: 'cra-lbl', text: s.label }))
		} else {
			el = h('button', { class: 'cra-btn' }, [svg(s.icon), h('span', { class: 'cra-lbl', text: s.label })])
		}
		el.setAttribute('type', 'button')
		el.setAttribute('title', s.title)
		el.setAttribute('aria-label', s.label)
		el.setAttribute('data-cra-shortcut', s.key)
		el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); closeMore(); s.run() })
		return el
	}

	var morePop = null
	function closeMore() {
		if (morePop) morePop.hidden = true
	}
	document.addEventListener('click', function (e) { if (morePop && !morePop.parentElement.contains(e.target)) closeMore() })
	document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMore() })

	function buildHeaderGroup(c, proto) {
		var list = shortcuts(c)
		var seg = h('div', { class: 'cra-seg' }, list.map(function (s) { return headerButton(proto, s, false) }))
		if (proto) {
			var radius = getComputedStyle(proto).borderRadius
			if (radius) seg.style.setProperty('--cra-seg-r', radius)
		}
		var more = h('div', { class: 'cra-more' })
		var trigger = headerButton(proto, { key: 'more', label: 'Pro Pack', icon: 'ellipsis', title: 'Meetings, Follow-ups, Campaigns and dashboards', run: function () {} }, true)
		trigger.setAttribute('aria-haspopup', 'menu')
		var pop = h('div', { class: 'cra-pop', role: 'menu', hidden: true }, list.map(function (s) {
			return h('button', { type: 'button', class: 'cra-pop-item', role: 'menuitem', 'data-cra-shortcut': s.key, onclick: function (e) { e.stopPropagation(); closeMore(); s.run() } },
				[svg(s.icon, 'cra-pop-i'), h('span', { text: s.label })])
		}))
		trigger.addEventListener('click', function (e) { e.stopPropagation(); var open = pop.hidden; closeMore(); pop.hidden = !open; morePop = pop })
		more.appendChild(trigger)
		more.appendChild(pop)
		morePop = pop
		return h('div', { class: 'cra-dash-group', 'data-cra': 'dash-link' }, [seg, more])
	}

	function ensureDashLink(c) {
		if (dashLink && document.body.contains(dashLink)) return
		var header = document.querySelector('header')
		if (!dashSeenAt) dashSeenAt = Date.now()
		var right = header && header.lastElementChild
		if (right && right !== header.firstElementChild) {
			var group = buildHeaderGroup(c, headerProto(header))
			right.insertBefore(group, right.firstChild)
			dashLink = group
		} else if (Date.now() - dashSeenAt > 2500) {
			// the header markup is not what we expect: a floating group keeps them reachable
			var floating = buildHeaderGroup(c, null)
			floating.className += ' cra-fab'
			dashLink = floating
			document.body.appendChild(dashLink)
		}
	}

	// ---- shortcuts in CRM's side menu ---------------------------------------------------------------------------------
	// Copies of CRM's own menu rows, placed in the same list right after the last visible native entry, so the spacing,
	// font, icon size / stroke, hover state and light / dark theme are CRM's own. No heading: one thin divider.
	var sideEls = []
	var sideSig = ''

	function removeSidebar() {
		sideEls.forEach(function (n) { n.remove() })
		sideEls = []
		sideSig = ''
	}

	function visible(el) {
		return !el.hasAttribute('data-cra-hidden') && getComputedStyle(el).display !== 'none'
	}

	/** The first menu list (CRM's "All Views" section) with its native rows, the row to copy, and the last visible row. */
	function sideNative() {
		var links = document.querySelectorAll('nav a[href^="/crm/"], aside a[href^="/crm/"]')
		var nav = null
		for (var i = 0; i < links.length; i++) {
			var a = links[i]
			if (a.closest('[data-cra]') || a.getAttribute('data-cra-side') || !a.closest('nav')) continue
			if (!visible(a) || a.closest('[data-cra-hidden]')) continue
			nav = a.closest('nav')
			break
		}
		if (!nav) return null
		var rows = Array.prototype.filter.call(nav.children, function (r) {
			return !r.hasAttribute('data-cra') && visible(r) && (r.matches('a[href], button') || !!r.querySelector('a[href], button'))
		})
		if (!rows.length) return null
		var proto = rows[0]
		for (var j = 0; j < rows.length; j++) {
			var link = rows[j].matches('a') ? rows[j] : rows[j].querySelector('a')
			if (link && link.getAttribute('aria-current') !== 'page' && !/router-link-(exact-)?active/.test(String(link.className)) && getComputedStyle(link).backgroundColor === 'rgba(0, 0, 0, 0)') { proto = rows[j]; break }
		}
		return { nav: nav, proto: proto, last: rows[rows.length - 1] }
	}

	function sideRow(proto, s) {
		var el = proto.cloneNode(true)
		retarget(el, proto, s.label, s.icon)
		var link = el.matches('a') ? el : el.querySelector('a')
		if (link) {
			link.setAttribute('href', '#')
			link.removeAttribute('aria-current')
		}
		el.setAttribute('data-cra', 'side')
		el.setAttribute('data-cra-side', s.key)
		el.title = s.title
		el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); s.run() })
		return el
	}

	function ensureSidebar(c) {
		if (!c.show_sidebar_links) return removeSidebar()
		var found = sideNative()
		if (!found) return // the menu is not drawn yet: the next change of the page calls this again
		var list = shortcuts(c)
		var labeled = !!(found.proto.textContent || '').trim()
		var sig = list.map(function (s) { return s.key }).join(',') + '|' + (labeled ? 'l' : 'i')
		var intact = sig === sideSig && sideEls.length && sideEls.every(function (n) { return found.nav.contains(n) }) &&
			sideEls[0].previousElementSibling === found.last
		if (intact) return
		removeSidebar()
		found = sideNative()
		if (!found) return
		var sep = h('div', { class: 'cra-side-sep', 'data-cra': 'side', role: 'separator' })
		var rows = list.map(function (s) { return sideRow(found.proto, s) })
		var anchor = found.last
		;[sep].concat(rows).forEach(function (n) {
			anchor.parentNode.insertBefore(n, anchor.nextSibling)
			anchor = n
		})
		sideEls = [sep].concat(rows)
		sideSig = sig
	}

	// ---- tabs on the Lead page --------------------------------------------------------------------------------
	var TABS = [
		{ key: 'meetings', label: 'Meetings', icon: 'calendar', render: renderMeetings },
		{ key: 'followups', label: 'Follow-ups', icon: 'phone-call', render: renderFollowUps },
		{ key: 'campaigns', label: 'Campaigns', icon: 'send', render: renderCampaigns },
	]
	var tabState = { list: null, active: null, panel: null, route: null }

	function findTabList() {
		var lists = document.querySelectorAll('[role="tablist"]')
		for (var i = 0; i < lists.length; i++) {
			if (lists[i].querySelectorAll('[role="tab"]:not([data-cra-tab])').length >= 4) return lists[i]
		}
		return null
	}

	function realTabs(list) {
		return Array.prototype.slice.call(list.querySelectorAll('[role="tab"]:not([data-cra-tab])'))
	}

	function styleTab(btn, meta) {
		btn.setAttribute('data-cra-tab', meta.key)
		btn.removeAttribute('id')
		btn.removeAttribute('aria-controls')
		btn.setAttribute('aria-selected', 'false')
		btn.setAttribute('data-state', 'inactive')
		btn.setAttribute('tabindex', '-1')
		var old = btn.querySelector('svg')
		var icon = svg(meta.icon, (old && old.getAttribute('class')) || 'h-4 w-4')
		if (old) old.replaceWith(icon)
		else btn.insertBefore(icon, btn.firstChild)

		var walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT)
		var nodes = []
		var n
		while ((n = walker.nextNode())) if (n.nodeValue.trim()) nodes.push(n)
		if (nodes.length) {
			nodes[0].nodeValue = meta.label
			nodes.slice(1).forEach(function (x) {
				var p = x.parentElement
				if (p && p !== btn && !p.contains(nodes[0]) && !p.querySelector('svg')) p.remove()
				else x.nodeValue = ''
			})
		} else {
			btn.appendChild(document.createTextNode(meta.label))
		}
	}

	function ensureTabs(r, c) {
		var list = findTabList()
		if (!list) return
		var key = r.doctype + '/' + r.name
		if (list.querySelector('[data-cra-tab]') && list.__craKey === key) return
		if (tabState.list !== list || tabState.route !== key) deactivate(true)
		Array.prototype.forEach.call(list.querySelectorAll('[data-cra-tab]'), function (b) { b.remove() })
		var proto = realTabs(list)[0]
		TABS.forEach(function (meta) {
			if (meta.key === 'followups' && !c.follow_ups_enabled) return
			if (meta.key === 'campaigns' && !c.campaigns_enabled) return
			var btn = proto.cloneNode(true)
			styleTab(btn, meta)
			btn.addEventListener('click', function (e) {
				e.preventDefault()
				activate(meta, list, r, c)
			})
			list.appendChild(btn)
		})
		list.__craKey = key
		tabState.list = list
		tabState.route = key
		if (!list.__craBound) {
			list.__craBound = true
			// CRM's tabs switch on mousedown; leave ours before it does
			list.addEventListener('mousedown', function (e) {
				if (!e.target.closest('[data-cra-tab]') && tabState.active) deactivate(false)
			}, true)
			list.addEventListener('keydown', function (e) {
				if (!e.target.closest('[data-cra-tab]') && tabState.active) deactivate(false)
			}, true)
		}
	}

	function panelsOf(container) {
		return Array.prototype.filter.call(container.querySelectorAll('[role="tabpanel"]'), function (p) { return !p.closest('[data-cra="panel"]') })
	}

	function activate(meta, list, r, c) {
		var container = list.parentElement
		if (!container) return
		if (tabState.active !== meta.key) {
			realTabs(list).forEach(function (t) {
				if (!t.__cra) t.__cra = { ds: t.getAttribute('data-state'), sel: t.getAttribute('aria-selected') }
				t.setAttribute('data-state', 'inactive')
				t.setAttribute('aria-selected', 'false')
			})
			panelsOf(container).forEach(function (p) {
				if (p.__craDisplay === undefined) p.__craDisplay = p.style.display
				p.style.display = 'none'
			})
		}
		Array.prototype.forEach.call(list.querySelectorAll('[data-cra-tab]'), function (b) {
			var on = b.getAttribute('data-cra-tab') === meta.key
			b.setAttribute('data-state', on ? 'active' : 'inactive')
			b.setAttribute('aria-selected', on ? 'true' : 'false')
		})
		if (!tabState.panel || !container.contains(tabState.panel)) {
			tabState.panel = h('div', { class: 'cra-tabpanel', 'data-cra': 'panel', role: 'tabpanel' })
			container.appendChild(tabState.panel)
		}
		tabState.active = meta.key
		meta.render(tabState.panel, r, c)
	}

	function deactivate(dropPanel) {
		var list = tabState.list
		if (list && tabState.active) {
			realTabs(list).forEach(function (t) {
				if (t.__cra) {
					t.setAttribute('data-state', t.__cra.ds)
					t.setAttribute('aria-selected', t.__cra.sel)
					delete t.__cra
				}
			})
			Array.prototype.forEach.call(list.querySelectorAll('[data-cra-tab]'), function (b) {
				b.setAttribute('data-state', 'inactive')
				b.setAttribute('aria-selected', 'false')
			})
			if (list.parentElement) {
				panelsOf(list.parentElement).forEach(function (p) {
					if (p.__craDisplay !== undefined) {
						p.style.display = p.__craDisplay
						delete p.__craDisplay
					}
				})
			}
		}
		if (tabState.panel) {
			tabState.panel.remove()
			tabState.panel = null
		}
		tabState.active = null
		if (dropPanel) {
			tabState.list = null
			tabState.route = null
		}
	}

	// keep an open tab in step with changes made elsewhere (meeting editor, follow-up form)
	function reloadActive() {
		if (tabState.panel && tabState.panel.__reload) tabState.panel.__reload()
	}
	window.addEventListener('crm-addons:changed', reloadActive)
	window.addEventListener('cra:followups-changed', reloadActive)
	window.addEventListener('crm-addons:follow-up-saved', function (e) {
		var d = e.detail || {}
		toast(d.message || 'Follow-up saved', !!d.warn)
		window.dispatchEvent(new CustomEvent('cra:followups-changed'))
		// CRM does not notice a status changed by the server: reload so the page shows it
		if (d.statusChanged) setTimeout(function () { location.reload() }, 900)
	})

	// ---- hide parts of CRM's own screen (UI only) ---------------------------------------------------------------------------
	// "Deals" in the side menu and the "Convert to Deal" button, when the settings ask for it. This
	// only hides them: the pages and the API are still there for anyone who goes to them directly.
	function hide(el) {
		if (el && !el.hasAttribute('data-cra-hidden')) {
			el.setAttribute('data-cra-hidden', '1')
			el.style.setProperty('display', 'none', 'important')
		}
	}

	/** Hide a menu entry together with the wrapper(s) around it that would leave a gap: climb up
	 * while the parent holds nothing else that can be clicked, and stop below the menu itself. */
	function hideItem(el) {
		var node = el
		while (node.parentElement && !/^(NAV|ASIDE|BODY|MAIN|HEADER)$/.test(node.parentElement.tagName)) {
			var inside = node.querySelectorAll('a[href], button').length + (node.matches('a[href], button') ? 1 : 0)
			if (node.parentElement.querySelectorAll('a[href], button').length > inside) break
			node = node.parentElement
		}
		hide(node)
	}

	function translated(text) {
		try { return typeof window.__ === 'function' ? window.__(text) : text } catch (e) { return text }
	}

	function hideCrmParts(c) {
		// every link to one of these pages: the menu entry and any saved views under it; entries that are
		// buttons rather than links are matched by label
		;[
			['hide_deals_menu', '/crm/deals', 'Deals'],
			['hide_notes_menu', '/crm/notes', 'Notes'],
			['hide_tasks_menu', '/crm/tasks', 'Tasks'],
			['hide_call_logs_menu', '/crm/call-logs', 'Call Logs'],
		].forEach(function (m) {
			if (!c[m[0]]) return
			Array.prototype.forEach.call(document.querySelectorAll('nav a[href^="' + m[1] + '"], aside a[href^="' + m[1] + '"]'), function (a) {
				if (!a.closest('[data-cra]')) hideItem(a)
			})
			var label = translated(m[2])
			Array.prototype.forEach.call(document.querySelectorAll('nav button, aside button'), function (b) {
				if (!b.closest('[data-cra]') && b.textContent.trim() === label && b.querySelector('svg')) hideItem(b)
			})
		})
		// tabs of a Lead / Deal page: the button is found by its label, inside the row that also holds Activity
		;[['hide_lead_calls_tab', 'Calls'], ['hide_lead_tasks_tab', 'Tasks'], ['hide_lead_notes_tab', 'Notes']].forEach(function (m) {
			if (!c[m[0]]) return
			var label = translated(m[1]), act = translated('Activity')
			Array.prototype.forEach.call(document.querySelectorAll('button, [role="tab"]'), function (b) {
				if (b.closest('[data-cra], [data-cra-tab], [role="dialog"], nav, aside, header')) return
				var t = b.textContent.trim()
				if (t !== label && t !== m[1]) return
				var row = b.parentElement, depth = 0
				while (row && depth++ < 3 && !Array.prototype.some.call(row.querySelectorAll('button, [role="tab"]'), function (x) { return x.textContent.trim() === act })) row = row.parentElement
				if (row && depth <= 3) hide(b)
			})
		})
		if (c.hide_convert_button) {
			var names = ['Convert to Deal', translated('Convert to Deal')]
			Array.prototype.forEach.call(document.querySelectorAll('button'), function (b) {
				if (b.closest('[role="dialog"]') || b.closest('[data-cra]')) return
				if (names.indexOf(b.textContent.trim()) < 0) return
				// its wrapper (CRM adds a tooltip wrapper around it) would leave an empty gap
				var wrap = b.parentElement
				hide(wrap && wrap.children.length === 1 && wrap !== document.body && /inline-flex|tooltip/i.test(wrap.className || '') ? wrap : b)
			})
		}
	}

	// ---- keep everything in step with CRM's single-page navigation ----------------------------------------------------------
	var timer = null
	var retries = 0 // how many times in a row the Dashboard header was not there yet
	function schedule() {
		if (timer) return
		timer = setTimeout(sync, 200)
	}

	var syncCount = 0
	function sync() {
		syncCount++
		timer = null
		if (/^\/crm(\/|$)/.test(location.pathname)) {
			config().then(function (c) { hideCrmParts(c); ensureSidebar(c) }).catch(function () { /* not signed in: nothing to hide */ })
		}
		var r = route()
		if (!r) {
			removeFab()
			removeDashLink()
			deactivate(true)
			return
		}
		config()
			.then(function (c) {
				var now = route()
				if (!now) return
				if (now.kind === 'dashboard') {
					removeFab()
					deactivate(true)
					ensureDashLink(c)
					// the header is still loading: look again, a few times (never for ever)
					if (!dashLink && retries++ < 8) setTimeout(schedule, 1200)
					if (dashLink) retries = 0
					return
				}
				retries = 0
				removeDashLink()
				// only Kanban needs floating buttons: the list view gets header buttons from CRM's list script
				if (now.kind === 'list' && now.viewType === 'kanban' && c.show_floating_buttons) ensureFab(now, c)
				else removeFab()
				if (now.kind === 'record' && c.show_record_tabs) ensureTabs(now, c)
				else deactivate(true)
			})
			.catch(function () { /* not signed in, or the add-on is not reachable: stay out of the way */ })
	}

	;['pushState', 'replaceState'].forEach(function (name) {
		var original = history[name]
		history[name] = function () {
			var result = original.apply(this, arguments)
			window.dispatchEvent(new Event('cra:route'))
			return result
		}
	})
	window.addEventListener('popstate', schedule)
	window.addEventListener('cra:route', schedule)

	// Our own changes (the menu rows, header buttons, tab panel, toasts, the floating buttons) must not call sync()
	// again, and neither must text updates: only a node CRM itself added or removed can need a look.
	var OWN = '[data-cra], [data-crm-addons], [data-cra-tab], .cra-toast, .cra-overlay, .cra-fab'
	function ours(n) {
		if (!n) return true
		var el = n.nodeType === 1 ? n : n.parentElement
		return !el || !!(el.closest && el.closest(OWN))
	}
	function relevant(records) {
		for (var i = 0; i < records.length; i++) {
			var r = records[i]
			if (ours(r.target)) continue
			var j, n
			for (j = 0; j < r.addedNodes.length; j++) {
				n = r.addedNodes[j]
				if (n.nodeType === 1 && !ours(n)) return true
			}
			for (j = 0; j < r.removedNodes.length; j++) {
				n = r.removedNodes[j]
				// something of ours that CRM's own re-render swept away has to come back
				if (n.nodeType === 1 && (!ours(n) || n.hasAttribute('data-cra') || n.hasAttribute('data-cra-tab'))) return true
			}
		}
		return false
	}
	new MutationObserver(function (records) { if (relevant(records)) schedule() }).observe(document.body, { childList: true, subtree: true })
	window.__crmAddonsStats = function () { return { syncs: syncCount, timer: !!timer, retries: retries } }
	sync()
})()
