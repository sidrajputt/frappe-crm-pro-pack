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
		plus: '<path d="M12 5v14M5 12h14"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
		video: '<path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
		users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
		edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
		trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
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
	var csrfPromise = null
	function csrf() {
		if (window.csrf_token && String(window.csrf_token).indexOf('{{') < 0) return Promise.resolve(window.csrf_token)
		if (!csrfPromise) {
			csrfPromise = fetch(API + 'api.get_csrf_token', { credentials: 'same-origin' })
				.then(function (r) { return r.json() })
				.then(function (j) { return j.message })
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
				return fetch(API + method, {
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

	function bridge() {
		return new Promise(function (resolve, reject) {
			if (window.crmAddons) return resolve(window.crmAddons)
			var s = document.createElement('script')
			s.src = '/assets/crm_addons/bridge.js?v=' + VER
			s.onload = function () { resolve(window.crmAddons) }
			s.onerror = function () { reject(new Error('The meetings screen could not be loaded.')) }
			document.head.appendChild(s)
		})
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
	function openQueue(doctype) {
		config().then(function (c) {
			var scope = 'mine'
			var bucket = 'overdue'
			var body = h('div', { class: 'cra-queue' })
			var m = openModal('Follow-up queue', [body], true)
			var data = null

			function load() {
				call('followups.get_queue', { scope: scope, reference_doctype: doctype })
					.then(function (res) { data = res; draw() })
					.catch(function (err) { clear(body); body.appendChild(h('div', { class: 'cra-empty cra-bad', text: err.message })) })
			}

			function draw() {
				clear(body)
				var tabs = h('div', { class: 'cra-tabs' })
				;[['overdue', 'Overdue'], ['today', 'Today'], ['upcoming', 'Upcoming']].forEach(function (t) {
					tabs.appendChild(
						h('button', {
							type: 'button', class: 'cra-tab' + (bucket === t[0] ? ' cra-on' : ''),
							onclick: function () { bucket = t[0]; draw() },
						}, [h('span', { text: t[1] }), h('span', { class: 'cra-count' + (t[0] === 'overdue' && data.counts.overdue ? ' cra-late' : ''), text: String(data.counts[t[0]]) })])
					)
				})
				var bar = h('div', { class: 'cra-queue-bar' }, [tabs])
				if (c.is_manager) {
					var sel = h('select', { class: 'cra-input cra-narrow' }, [h('option', { value: 'mine', text: 'My follow-ups' }), h('option', { value: 'all', text: 'Everyone' })])
					sel.value = scope
					sel.addEventListener('change', function () { scope = sel.value; load() })
					bar.appendChild(sel)
				}
				body.appendChild(bar)

				var rows = data.items.filter(function (i) { return i.bucket === bucket })
				if (!rows.length) {
					body.appendChild(h('div', { class: 'cra-empty', text: bucket === 'overdue' ? 'Nothing overdue. Nice.' : 'Nothing here.' }))
					return
				}
				var list = h('div', { class: 'cra-list' })
				rows.forEach(function (it) {
					list.appendChild(
						h('div', { class: 'cra-card' }, [
							h('div', { class: 'cra-card-top' }, [
								h('div', { class: 'cra-card-title' }, [
									h('a', { class: 'cra-link', href: it.reference_url || '#', text: it.reference_title || it.reference_docname }),
									chip(fmt(it.next_follow_up_on), bucket === 'overdue' ? 'red' : bucket === 'today' ? 'amber' : ''),
								]),
								h('div', { class: 'cra-card-actions' }, [
									h('button', {
										type: 'button', class: 'cra-btn cra-primary',
										onclick: function () {
											openFollowUp({ reference_docname: it.reference_docname })
										},
									}, [svg('phone-call'), h('span', { text: 'Log' })]),
									h('button', {
										type: 'button', class: 'cra-btn', title: 'Mark done', 'aria-label': 'Mark done',
										onclick: function () {
											call('followups.complete_follow_up', { name: it.name })
												.then(function () { window.dispatchEvent(new CustomEvent('cra:followups-changed')) })
												.catch(function (err) { toast(err.message, true) })
										},
									}, [svg('check')]),
								]),
							]),
							it.remark ? h('div', { class: 'cra-remark', text: it.remark }) : null,
							h('div', { class: 'cra-meta' }, [
								h('span', { text: it.mode === 'Call' ? 'Last: attempt ' + it.attempt_no + ' - ' + (it.outcome || 'call') : 'Last follow-up' }),
								h('span', { text: 'Owner: ' + (it.assigned_name || '') }),
							]),
						])
					)
				})
				body.appendChild(list)
			}
			body.appendChild(h('div', { class: 'cra-empty', text: 'Loading...' }))
			load()
			// keep the queue current when a follow-up is added, edited or done
			window.addEventListener('cra:followups-changed', function onChange() {
				if (!document.body.contains(body)) return window.removeEventListener('cra:followups-changed', onChange)
				load()
			})
			return m
		}).catch(function (err) { toast(err.message, true) })
	}

	window.crmAddonsUI = { openQueue: openQueue, openFollowUp: openFollowUp, loadBridge: bridge }

	function openDashboard() {
		return bridge()
			.then(function (b) { b.openDashboard() })
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

	function removeFab() {
		if (fab) fab.remove()
		fab = null
		clearInterval(badgeTimer)
	}

	function ensureFab(r, c) {
		if (fab && fab.__doctype === r.doctype && document.body.contains(fab)) return
		removeFab()
		var kids = [
			h('button', {
				type: 'button', class: 'cra-fab-btn', title: 'Meetings',
				onclick: function () { bridge().then(function (b) { b.openCalendar({ reference_doctype: r.doctype, view: 'agenda' }) }).catch(function (err) { toast(err.message, true) }) },
			}, [svg('calendar'), h('span', { text: 'Meetings' })]),
		]
		if (c.follow_ups_enabled) {
			var badge = h('span', { class: 'cra-badge', hidden: true })
			kids.push(
				h('button', { type: 'button', class: 'cra-fab-btn', title: 'Follow-ups', onclick: function () { openQueue(r.doctype) } }, [svg('phone-call'), h('span', { text: 'Follow-ups' }), badge])
			)
			kids.push(
				h('button', {
					type: 'button', class: 'cra-fab-btn', title: 'Sales Dashboard (opens in a new tab)',
					onclick: openDashboard,
				}, [svg('chart'), h('span', { text: 'Sales Dashboard' })])
			)
			var refreshBadge = function () {
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

	function ensureDashLink() {
		if (dashLink && document.body.contains(dashLink)) return
		var header = document.querySelector('header')
		if (!dashSeenAt) dashSeenAt = Date.now()
		var button = h('button', {
			type: 'button', class: 'cra-btn', title: 'Open the Sales Dashboard in a new tab', 'data-cra': 'dash-link', onclick: openDashboard,
		}, [svg('chart'), h('span', { text: 'Sales Dashboard' })])
		var right = header && header.lastElementChild
		if (right && right !== header.firstElementChild) {
			right.insertBefore(button, right.firstChild)
			dashLink = button
		} else if (Date.now() - dashSeenAt > 2500) {
			// the header markup is not what we expect: a floating button keeps it reachable
			dashLink = h('div', { class: 'cra-fab', 'data-cra': 'dash-link' }, [button])
			document.body.appendChild(dashLink)
		}
	}

	// ---- tabs on the Lead page --------------------------------------------------------------------------------
	var TABS = [
		{ key: 'meetings', label: 'Meetings', icon: 'calendar', render: renderMeetings },
		{ key: 'followups', label: 'Follow-ups', icon: 'phone-call', render: renderFollowUps },
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
		if (c.hide_deals_menu) {
			// every link to a Deals page: the menu entry and any saved Deals views under it
			Array.prototype.forEach.call(document.querySelectorAll('nav a[href^="/crm/deals"], aside a[href^="/crm/deals"]'), hideItem)
			// menu entries that are buttons rather than links: match the label
			var label = translated('Deals')
			Array.prototype.forEach.call(document.querySelectorAll('nav button, aside button'), function (b) {
				if (b.textContent.trim() === label && b.querySelector('svg')) hideItem(b)
			})
		}
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
	function schedule() {
		if (timer) return
		timer = setTimeout(sync, 200)
	}

	function sync() {
		timer = null
		if (/^\/crm(\/|$)/.test(location.pathname)) {
			config().then(hideCrmParts).catch(function () { /* not signed in: nothing to hide */ })
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
					ensureDashLink()
					if (!dashLink) setTimeout(schedule, 1200) // the header is still loading: look again
					return
				}
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
	new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
	sync()
})()
