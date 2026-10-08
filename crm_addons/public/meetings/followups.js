/* CRM Pro Pack - Follow-ups workspace (Vue 3, no build step).
 * A full-screen page, built like the Sales Dashboard. Managers see everyone's follow-ups (and can
 * narrow to one person); a sales user only ever gets their own. The form for logging a follow-up is
 * the same one the Lead page uses (index.html?mode=followup), shown in a panel on top of this page.
 * It follows the CRM's light / dark theme and has no switch of its own. */
(() => {
	const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, onErrorCaptured, nextTick } = Vue

	// ------------------------------------------------------------------ environment
	const params = new URLSearchParams(location.search)
	const EMBED = params.get('embed') === '1'
	const VERSION = params.get('v') || String(Date.now())
	const VIEW_KEY = 'crm_addons_fu_view'
	const RANGE_KEY = 'crm_addons_fu_range'
	const store = {
		get(k) { try { return localStorage.getItem(k) } catch (e) { return null } },
		set(k, v) { try { localStorage.setItem(k, v) } catch (e) { /* private mode */ } },
	}

	// The theme belongs to the CRM: ask the page that opened this one (or hosts it), then the URL, then the browser.
	function crmTheme() {
		for (const w of [window.parent !== window ? window.parent : null, window.opener]) {
			try { const t = w && w.document.documentElement.getAttribute('data-theme'); if (t) return t } catch (e) { /* cross-origin */ }
		}
		// the 'theme' the CRM itself keeps in this browser (same origin)
		const saved = store.get('theme')
		return saved === 'dark' || saved === 'light' ? saved : null
	}
	function applyTheme() {
		const t = crmTheme() || params.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
		const v = t === 'dark' ? 'dark' : 'light'
		if (document.documentElement.getAttribute('data-theme') !== v) document.documentElement.setAttribute('data-theme', v)
	}
	applyTheme()
	window.addEventListener('storage', (e) => { if (e.key === 'theme') applyTheme() })
	for (const w of [window.parent !== window ? window.parent : null, window.opener]) {
		try { if (w) new MutationObserver(applyTheme).observe(w.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }) } catch (e) { /* not reachable */ }
	}
	const tellParent = (type, extra) => { if (window.parent !== window) window.parent.postMessage({ source: 'crm-addons', type, ...(extra || {}) }, location.origin) }
	// the CRM tab keeps a badge with the number of follow-ups: tell it something changed
	function tellCrm() {
		if (EMBED) return tellParent('saved', { followup: true })
		try { if (window.opener && !window.opener.closed) window.opener.dispatchEvent(new window.opener.CustomEvent('cra:followups-changed')) } catch (e) { /* closed or cross-origin */ }
	}

	let csrf = null
	async function token() {
		if (csrf) return csrf
		try {
			const t = window.parent !== window && window.parent.csrf_token
			if (t && t !== '{{ csrf_token }}') csrf = t
		} catch (e) { /* ignore */ }
		if (!csrf) csrf = (await (await fetch('/api/method/crm_addons.api.get_csrf_token', { credentials: 'same-origin' })).json()).message
		return csrf
	}
	const stripHtml = (s) => { const d = document.createElement('div'); d.innerHTML = s; return d.textContent || '' }
	function errorText(body, status) {
		try {
			const msgs = JSON.parse(body._server_messages || '[]').map((m) => JSON.parse(m).message)
			if (msgs.length) return stripHtml(msgs.join(' '))
		} catch (e) { /* fall through */ }
		if (status === 401 || status === 403) return 'You do not have access to the follow-ups, or your session has expired. Open the CRM and log in again.'
		return 'Something went wrong (' + status + ').'
	}
	async function call(method, args) {
		const res = await fetch('/api/method/' + method, {
			method: 'POST', credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Frappe-CSRF-Token': await token() },
			body: JSON.stringify(args || {}),
		})
		let body = {}
		try { body = await res.json() } catch (e) { /* not json */ }
		if (!res.ok) throw new Error(errorText(body, res.status))
		return body.message
	}

	// ------------------------------------------------------------------ helpers
	const pad = (n) => String(n).padStart(2, '0')
	const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
	const sql = (d) => `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`
	const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
	const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
	const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
	const fromSql = (s) => new Date(String(s).replace(' ', 'T'))
	const num = (n) => Number(n || 0).toLocaleString()
	const fmtDate = (d, o) => d.toLocaleDateString([], o || { day: 'numeric', month: 'short' })
	const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
	const fmtRange = (a, b) => (ymd(a) === ymd(b) ? fmtDate(a, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : `${fmtDate(a, a.getFullYear() === b.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })} - ${fmtDate(b, { day: 'numeric', month: 'short', year: 'numeric' })}`)
	const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

	/** "in 2 days" / "3 days late". ``ms`` is due minus now. */
	function relative(ms) {
		const late = ms < 0
		const mins = Math.round(Math.abs(ms) / 60000)
		let text
		if (mins < 1) return { text: 'now', late: false }
		if (mins < 60) text = plural(mins, 'min')
		else if (mins < 60 * 24) text = plural(Math.round(mins / 60), 'hour')
		else text = plural(Math.round(mins / 1440), 'day')
		return { text: late ? text + ' late' : 'in ' + text, late }
	}
	const dayLabel = (day, today) => {
		const diff = Math.round((parseDay(day) - today) / 86400000)
		const base = fmtDate(parseDay(day), { weekday: 'long', day: 'numeric', month: 'long' })
		if (diff === 0) return 'Today · ' + base
		if (diff === 1) return 'Tomorrow · ' + base
		if (diff === -1) return 'Yesterday · ' + base
		return base
	}

	const OUTCOME_TONE = { 'Did Not Pick': 'red', 'Did Not Connect': 'amber', Interested: 'green', 'Meeting Scheduled': 'green', 'Not Interested': 'red', 'Ask for Detail': 'blue', 'Call Back Later': 'amber' }
	const STATUS_COLORS = { black: '#171717', gray: '#94a3b8', blue: '#2563eb', green: '#16a34a', red: '#dc2626', pink: '#db2777', orange: '#ea580c', amber: '#d97706', yellow: '#ca8a04', cyan: '#0891b2', teal: '#0d9488', violet: '#7c3aed', purple: '#9333ea' }

	const ICONS = {
		phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
		'phone-call': '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/><path d="M14.05 2a9 9 0 0 1 8 7.94M14.05 6A5 5 0 0 1 18 10"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
		refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
		calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
		left: '<path d="m15 18-6-6 6-6"/>',
		right: '<path d="m9 18 6-6-6-6"/>',
		back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
		user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
		users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		'check-circle': '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="m22 4-10 10-3-3"/>',
		clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
		search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
		list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
		agenda: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h3M8 18h6"/>',
		alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
		inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/>',
		trend: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
	}
	const Ico = {
		props: { name: String, size: String },
		computed: { paths() { return ICONS[this.name] || '' } },
		template: `<svg class="ico" :class="size" viewBox="0 0 24 24" aria-hidden="true" v-html="paths"></svg>`,
	}
	const Avatar = {
		props: { name: String },
		computed: {
			initials() {
				const parts = String(this.name || '?').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
				return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
			},
			color() { let h = 0; for (const c of String(this.name || '')) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 42% 42%)` },
		},
		template: `<span class="avatar" :style="{ background: color }" :title="name">{{ initials }}</span>`,
	}

	// ------------------------------------------------------------------ dropdown with a floating list
	const Pick = {
		components: { Ico },
		props: { modelValue: String, options: Array, placeholder: { type: String, default: 'Select' }, icon: String },
		emits: ['update:modelValue'],
		setup(props, { emit }) {
			const open = ref(false)
			const btn = ref(null)
			const pop = ref(null)
			const hi = ref(-1)
			const style = ref({})
			const selected = computed(() => props.options.find((o) => o.value === props.modelValue))
			function show() {
				const r = btn.value.getBoundingClientRect()
				const below = window.innerHeight - r.bottom - 12
				const wanted = Math.min(340, props.options.length * 36 + 16)
				const up = below < wanted && r.top - 12 > below
				const room = Math.max(140, Math.min(340, up ? r.top - 12 : below))
				style.value = { left: Math.max(8, Math.min(r.left, window.innerWidth - 248)) + 'px', minWidth: Math.max(r.width, 200) + 'px', maxHeight: room + 'px', ...(up ? { bottom: window.innerHeight - r.top + 6 + 'px' } : { top: r.bottom + 6 + 'px' }) }
				hi.value = Math.max(0, props.options.findIndex((o) => o.value === props.modelValue))
				open.value = true
			}
			const choose = (o) => { emit('update:modelValue', o.value); open.value = false }
			const onDoc = (e) => { if (open.value && !(pop.value && pop.value.contains(e.target)) && !btn.value.contains(e.target)) open.value = false }
			function onKey(e) {
				if (!open.value) { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show() } return }
				if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open.value = false }
				else if (e.key === 'ArrowDown') { e.preventDefault(); hi.value = Math.min(hi.value + 1, props.options.length - 1) }
				else if (e.key === 'ArrowUp') { e.preventDefault(); hi.value = Math.max(hi.value - 1, 0) }
				else if (e.key === 'Enter') { e.preventDefault(); if (props.options[hi.value]) choose(props.options[hi.value]) }
			}
			onMounted(() => document.addEventListener('mousedown', onDoc))
			onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc))
			return { open, btn, pop, hi, style, selected, show, choose, onKey }
		},
		template: `
<div class="pick">
	<button type="button" class="pick-btn" ref="btn" :class="{ open }" @click="open ? (open = false) : show()" @keydown="onKey" aria-haspopup="listbox" :aria-expanded="open">
		<ico v-if="icon" :name="icon" class="lead" />
		<span class="pick-label" :class="{ ph: !selected }">{{ selected ? selected.label : placeholder }}</span>
		<svg class="ico chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
	</button>
	<div class="pick-pop" ref="pop" v-if="open" :style="style" role="listbox">
		<button v-for="(o, i) in options" :key="o.value" type="button" class="pick-opt" :class="{ on: o.value === modelValue, hi: i === hi }" role="option" :aria-selected="o.value === modelValue" @mousedown.prevent="choose(o)" @mouseenter="hi = i">
			<span class="pick-label">{{ o.label }}</span>
			<svg v-if="o.value === modelValue" class="ico tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
		</button>
	</div>
</div>`,
	}

	// ------------------------------------------------------------------ due-date range (the Sales Dashboard's picker, plus "Any time" and forward-looking presets)
	const PRESETS = [
		['any', 'Any time'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['tomorrow', 'Tomorrow'], ['next7', 'Next 7 days'], ['next30', 'Next 30 days'],
		['week', 'This week'], ['lastweek', 'Last week'], ['month', 'This month'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['lastmonth', 'Last month'],
	]
	function presetRange(key) {
		const today = startOfDay(new Date())
		const monday = addDays(today, -((today.getDay() + 6) % 7))
		switch (key) {
			case 'today': return [today, today]
			case 'yesterday': return [addDays(today, -1), addDays(today, -1)]
			case 'lastweek': return [addDays(monday, -7), addDays(monday, -1)]
			case 'tomorrow': return [addDays(today, 1), addDays(today, 1)]
			case 'next7': return [today, addDays(today, 6)]
			case 'next30': return [today, addDays(today, 29)]
			case 'week': return [monday, addDays(monday, 6)]
			case 'month': return [new Date(today.getFullYear(), today.getMonth(), 1), new Date(today.getFullYear(), today.getMonth() + 1, 0)]
			case '7d': return [addDays(today, -6), today]
			case '30d': return [addDays(today, -29), today]
			case 'lastmonth': return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)]
			default: return null
		}
	}
	const rangeOf = (r) => (r.preset === 'any' ? null : r.preset === 'custom' && r.from && r.to ? [parseDay(r.from), parseDay(r.to)] : presetRange(r.preset))

	// the picker itself is shared with the other page: range-picker.js
	const RangePicker = window.CRMRangePicker.create({
		Vue, Ico, presets: PRESETS, presetRange, rangeOf, fmtRange,
		anyLabel: 'Due: any time', duePrefix: 'Due: ', compare: false,
	})

	// ------------------------------------------------------------------ "move to another time" popover
	const Reschedule = {
		components: { Ico },
		props: { label: String, compact: Boolean, align: { type: String, default: 'right' }, disabled: Boolean },
		emits: ['pick'],
		setup(props, { emit }) {
			const open = ref(false)
			const btn = ref(null)
			const pop = ref(null)
			const style = ref({})
			const custom = ref('')
			const at = (days, h, m) => { const d = addDays(new Date(), days); d.setHours(h, m || 0, 0, 0); return d }
			const quick = computed(() => {
				const now = new Date()
				const nextMonday = at(((8 - now.getDay()) % 7) || 7, 10)
				return [
					['In 2 hours', new Date(now.getTime() + 2 * 3600 * 1000)],
					['Tomorrow, 10:00 AM', at(1, 10)],
					['In 3 days, 10:00 AM', at(3, 10)],
					['Next Monday, 10:00 AM', nextMonday],
					['In 2 weeks, 10:00 AM', at(14, 10)],
				]
			})
			function show() {
				const r = btn.value.getBoundingClientRect()
				const left = props.align === 'left' ? r.left : r.right - 264
				const down = window.innerHeight - r.bottom > 330
				style.value = { left: Math.max(8, Math.min(left, window.innerWidth - 272)) + 'px', ...(down ? { top: r.bottom + 6 + 'px' } : { bottom: window.innerHeight - r.top + 6 + 'px' }) }
				const d = at(1, 10)
				custom.value = `${ymd(d)}T10:00`
				open.value = true
			}
			const choose = (d) => { open.value = false; emit('pick', sql(d)) }
			const apply = () => { if (custom.value) choose(new Date(custom.value)) }
			const onDoc = (e) => { if (open.value && !(pop.value && pop.value.contains(e.target)) && !btn.value.contains(e.target)) open.value = false }
			const onEsc = (e) => { if (open.value && e.key === 'Escape') { e.stopPropagation(); open.value = false } }
			onMounted(() => { document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onEsc, true) })
			onBeforeUnmount(() => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc, true) })
			return { open, btn, pop, style, quick, custom, show, choose, apply }
		},
		template: `
<span class="resched">
	<button type="button" ref="btn" class="btn" :class="compact ? 'ghost icon small' : 'small'" :disabled="disabled" :title="label || 'Reschedule'" :aria-label="label || 'Reschedule'" aria-haspopup="menu" :aria-expanded="open" @click="open ? (open = false) : show()"><ico name="clock" /><span v-if="!compact">{{ label || 'Reschedule' }}</span></button>
	<div class="pick-pop menu resched-pop" ref="pop" v-if="open" :style="style" role="menu">
		<div class="pick-head">Move to</div>
		<button v-for="q in quick" :key="q[0]" type="button" class="pick-opt" role="menuitem" @mousedown.prevent="choose(q[1])"><span class="pick-label">{{ q[0] }}</span></button>
		<div class="resched-custom">
			<input class="control" type="datetime-local" v-model="custom" aria-label="Pick a date and time" @keydown.enter.prevent="apply" />
			<button type="button" class="btn primary small" :disabled="!custom" @click="apply">Set</button>
		</div>
	</div>
</span>`,
	}

	// ------------------------------------------------------------------ the page
	const TABS = [['overdue', 'Overdue'], ['today', 'Due today'], ['upcoming', 'Upcoming'], ['done', 'Done']]
	const PAGE = 50

	const App = {
		components: { Ico, Avatar, Pick, RangePicker, Reschedule },
		setup() {
			const data = ref(null)
			const items = ref([])
			const loading = ref(false)
			const more = ref(false)
			const fatal = ref('')
			const toasts = ref([])
			const form = ref(null) // the log-a-follow-up panel: { lead, src, height }
			const busy = reactive({}) // row name -> true while a change is on its way
			const selected = reactive({})
			const nowMs = ref(Date.now())

			const hash = location.hash.replace(/^#/, '')
			const hashTab = TABS.find((t) => t[0] === hash)
			const tab = ref(hashTab ? hashTab[0] : 'overdue')
			let autoTab = !hashTab // pick the first tab that has something, once
			const scope = ref(['all', 'mine'].includes(params.get('scope')) ? params.get('scope') : '') // '' = the default the server picks (everyone for managers)
			const owner = ref(params.get('owner') || '')
			const outcome = ref(params.get('outcome') || '')
			const search = ref(params.get('q') || '')
			const view = ref(store.get(VIEW_KEY) === 'agenda' ? 'agenda' : 'table')
			const saved = (() => { try { return JSON.parse(store.get(RANGE_KEY) || 'null') } catch (e) { return null } })()
			const validRange = (r) => !!(r && (PRESETS.some((p) => p[0] === r.preset) || (r.preset === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(r.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(r.to || ''))))
			// what the URL says (a new tab opened from the pop-up), else the last range used on this page
			const fromUrl = { preset: params.get('range') || '', from: params.get('from') || '', to: params.get('to') || '' }
			const range = ref(validRange(fromUrl) ? fromUrl : validRange(saved) ? saved : { preset: 'any', from: '', to: '' })
			const updatedAt = ref('')
			const knownOwners = reactive({}) // every owner seen so far, so a chosen one keeps its name when the filters hide it
			const searchBox = ref(null)

			onErrorCaptured((err) => { fatal.value = 'The page could not be drawn (' + (err && err.message ? err.message : err) + '). Reload it with Ctrl/Cmd+Shift+R.'; return false })

			function toast(text, kind) {
				const t = { id: Date.now() + Math.random(), text, kind }
				toasts.value.push(t)
				setTimeout(() => (toasts.value = toasts.value.filter((x) => x.id !== t.id)), kind ? 6000 : 3000)
			}

			// ---------- loading
			let seq = 0
			let serverOffset = 0
			function query(page) {
				const r = rangeOf(range.value)
				return {
					tab: tab.value, scope: scope.value || undefined, owner: owner.value || undefined, search: search.value.trim() || undefined,
					outcome: outcome.value || undefined, from_date: r ? ymd(r[0]) : undefined, to_date: r ? ymd(r[1]) : undefined,
					page, page_length: PAGE,
				}
			}
			async function load(opts) {
				opts = opts || {}
				const my = ++seq
				if (!opts.quiet) loading.value = true
				try {
					const res = await call('crm_addons.followups.get_workspace', query(1))
					if (my !== seq) return
					// the first time, open the first tab that has something in it
					if (autoTab) {
						autoTab = false
						const first = ['overdue', 'today', 'upcoming'].find((t) => res.counts[t] > 0)
						if (first && first !== tab.value) { tab.value = first; return load(opts) }
					}
					data.value = res
					items.value = res.items
					for (const o of res.owners) knownOwners[o.name] = o.full_name
					for (const k of Object.keys(selected)) delete selected[k]
					serverOffset = fromSql(res.server_now).getTime() - Date.now()
					fatal.value = ''
					updatedAt.value = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
				} catch (e) { if (my === seq) fatal.value = e.message } finally { if (my === seq) loading.value = false }
			}
			async function loadMore() {
				if (!data.value || more.value) return
				more.value = true
				const my = seq
				try {
					const res = await call('crm_addons.followups.get_workspace', query(data.value.page + 1))
					if (my !== seq) return
					const have = new Set(items.value.map((i) => i.name))
					items.value = items.value.concat(res.items.filter((i) => !have.has(i.name)))
					data.value = { ...data.value, page: res.page, counts: res.counts, total: res.total }
				} catch (e) { toast(e.message, 'err') } finally { more.value = false }
			}
			let searchTimer
			watch(search, () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 300) })
			watch([tab, scope, owner, outcome], () => { if (data.value) load() })
			watch(scope, () => { owner.value = '' })
			watch(range, () => { store.set(RANGE_KEY, JSON.stringify(range.value)); if (data.value) load() })
			watch(view, () => store.set(VIEW_KEY, view.value))

			let timer, tick
			function onKey(e) {
				const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target.tagName || '').toUpperCase())
				if (e.key === 'Escape') {
					// a dropdown or the date picker closes first (and stops the key); this is the last line of defence
					if (e.defaultPrevented || document.querySelector('.pick-pop')) return
					if (form.value) return closeForm()
					if (Object.keys(selected).length) { for (const k of Object.keys(selected)) delete selected[k]; return }
					if (typing && e.target === searchBox.value && search.value) { search.value = ''; return }
					if (EMBED) tellParent('close')
				} else if (e.key === '/' && !typing && !form.value) { e.preventDefault(); searchBox.value && searchBox.value.focus() }
			}
			onMounted(() => {
				load()
				timer = setInterval(() => document.visibilityState === 'visible' && !form.value && load({ quiet: true }), 120000)
				tick = setInterval(() => (nowMs.value = Date.now()), 30000)
				document.addEventListener('keydown', onKey)
				window.addEventListener('message', onMessage)
				window.addEventListener('focus', onFocus)
			})
			onBeforeUnmount(() => {
				clearInterval(timer); clearInterval(tick)
				document.removeEventListener('keydown', onKey)
				window.removeEventListener('message', onMessage)
				window.removeEventListener('focus', onFocus)
			})
			// coming back from the CRM tab: the list may have changed
			let blurredAt = 0
			window.addEventListener('blur', () => (blurredAt = Date.now()))
			function onFocus() { if (blurredAt && Date.now() - blurredAt > 20000 && !form.value) load({ quiet: true }) }

			// ---------- who and what
			const isManager = computed(() => !!(data.value && data.value.scope.is_manager))
			const scopeModel = computed({ get: () => scope.value || (data.value ? data.value.scope.value : 'all'), set: (v) => { scope.value = v } })
			const everyone = computed(() => isManager.value && scopeModel.value === 'all')
			const scopeOptions = [{ value: 'all', label: 'Everyone' }, { value: 'mine', label: 'My follow-ups' }]
			const ownerOptions = computed(() => {
				const list = data.value ? data.value.owners.map((o) => ({ value: o.name, label: `${o.full_name} · ${o.open}` })) : []
				if (owner.value && !list.some((o) => o.value === owner.value)) list.push({ value: owner.value, label: knownOwners[owner.value] || owner.value })
				return [{ value: '', label: 'All owners' }, ...list]
			})
			const outcomeOptions = computed(() => [{ value: '', label: 'All outcomes' }, ...(data.value ? data.value.outcomes.map((o) => ({ value: o, label: o })) : [])])
			const subtitle = computed(() => {
				if (!data.value) return ''
				if (!isManager.value) return 'Your follow-ups'
				if (scopeModel.value === 'mine') return 'Your follow-ups'
				return owner.value ? knownOwners[owner.value] || owner.value : 'Everyone on the team'
			})
			const filtered = computed(() => !!(search.value.trim() || outcome.value || owner.value || range.value.preset !== 'any'))
			function clearFilters() { search.value = ''; outcome.value = ''; owner.value = ''; range.value = { preset: 'any', from: '', to: '' } }

			// ---------- cards
			const cards = computed(() => {
				if (!data.value) return []
				const c = data.value.counts, k = data.value.connect, w = data.value.done_window
				const doneLabel = data.value.window.from ? 'Done in range' : 'Done, last 30 days'
				return [
					{ key: 'overdue', label: 'Overdue', value: num(c.overdue), sub: c.overdue ? 'Needs a call today' : 'Nothing overdue', tone: 'red', subTone: c.overdue ? 'bad' : 'good', click: true },
					{ key: 'today', label: 'Due today', value: num(c.today), sub: c.today ? 'Still to do before tomorrow' : 'Nothing else due today', tone: 'amber', click: true },
					{ key: 'upcoming', label: 'Upcoming', value: num(c.upcoming), sub: 'Scheduled for later', tone: 'blue', click: true },
					{ key: 'done', label: doneLabel, value: num(c.done), sub: 'Completed or followed up', tone: 'green', click: true },
					{ key: 'rate', label: 'Connect rate', value: k.rate === null ? '-' : k.rate + '%', sub: k.calls ? `${num(k.connected)} of ${num(k.calls)} calls connected` : 'No calls in this period', tone: 'violet', click: false, hint: `${w.from} to ${w.to}` },
				]
			})
			function pickCard(c) { if (c.click) tab.value = c.key }

			// ---------- rows
			const serverNow = computed(() => nowMs.value + serverOffset)
			const today = computed(() => startOfDay(new Date(serverNow.value)))
			function due(i) {
				const d = fromSql(i.next_follow_up_on)
				const rel = relative(d.getTime() - serverNow.value)
				const abs = `${fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtTime(d)}`
				if (i.bucket === 'done') return { top: fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' }), sub: fmtTime(d), tone: 'done' }
				return { top: rel.text, sub: abs, tone: rel.late ? 'overdue' : i.bucket }
			}
			const statusColor = (c) => STATUS_COLORS[c] || '#94a3b8'
			const outcomeTone = (o) => OUTCOME_TONE[o] || ''
			const rows = computed(() => {
				if (view.value !== 'agenda') return items.value.map((i) => ({ kind: 'row', key: i.name, item: i }))
				const out = []
				let last = ''
				for (const i of items.value) {
					const day = i.next_follow_up_on.slice(0, 10)
					if (day !== last) {
						last = day
						out.push({ kind: 'head', key: 'h' + day, day, label: dayLabel(day, today.value), late: tab.value === 'overdue' || (day < ymd(today.value) && tab.value !== 'done') })
					}
					out.push({ kind: 'row', key: i.name, item: i })
				}
				return out
			})
			const dayCount = (day) => items.value.filter((i) => i.next_follow_up_on.startsWith(day)).length

			const canSelect = computed(() => tab.value !== 'done')
			const selectedNames = computed(() => Object.keys(selected))
			const allSelected = computed(() => items.value.length > 0 && items.value.every((i) => selected[i.name]))
			function toggleAll() {
				if (allSelected.value) for (const k of Object.keys(selected)) delete selected[k]
				else for (const i of items.value) if (i.can_edit) selected[i.name] = true
			}
			function toggle(i) { if (selected[i.name]) delete selected[i.name]; else selected[i.name] = true }

			// ---------- actions
			function drop(names) {
				const gone = new Set(names.map(String))
				items.value = items.value.filter((i) => !gone.has(String(i.name)))
				for (const n of names) delete selected[n]
				if (data.value) data.value = { ...data.value, total: Math.max(0, data.value.total - names.length) }
			}
			async function markDone(i) {
				if (busy[i.name]) return
				busy[i.name] = true
				try {
					await call('crm_addons.followups.complete_follow_up', { name: i.name })
					toast('Marked done: ' + i.reference_title)
					tellCrm()
					await load({ quiet: true })
				} catch (e) { toast(e.message, 'err') } finally { delete busy[i.name] }
			}
			async function reschedule(i, when) {
				if (busy[i.name]) return
				busy[i.name] = true
				try {
					await call('crm_addons.followups.reschedule_follow_up', { name: i.name, next_follow_up_on: when })
					toast(`Moved ${i.reference_title} to ${fmtDate(fromSql(when), { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtTime(fromSql(when))}`)
					tellCrm()
					await load({ quiet: true })
				} catch (e) { toast(e.message, 'err') } finally { delete busy[i.name] }
			}
			async function bulk(action, when) {
				const names = selectedNames.value.slice()
				if (!names.length) return
				loading.value = true
				try {
					const res = await call('crm_addons.followups.bulk_update', { names, action, next_follow_up_on: when })
					const n = res.updated.length
					if (n) toast(`${action === 'done' ? 'Marked done' : 'Rescheduled'}: ${plural(n, 'follow-up')}`)
					if (res.failed.length) toast(`${plural(res.failed.length, 'follow-up')} could not be changed: ${res.failed[0].error}`, 'err')
					tellCrm()
					await load({ quiet: true })
				} catch (e) { toast(e.message, 'err'); loading.value = false }
			}

			function logFor(i) {
				const q = new URLSearchParams({ embed: '1', mode: 'followup', reference_name: i.reference_docname, theme: document.documentElement.getAttribute('data-theme') || '', v: VERSION })
				form.value = { lead: i.reference_title, src: `index.html?${q.toString()}`, height: 560 }
			}
			function closeForm() { form.value = null }
			const frame = ref(null)
			function onMessage(e) {
				if (e.origin !== location.origin || !e.data || e.data.source !== 'crm-addons' || !form.value) return
				if (frame.value && e.source !== frame.value.contentWindow) return
				if (e.data.type === 'close') closeForm()
				else if (e.data.type === 'resize' && e.data.height) form.value.height = Math.min(e.data.height + 2, window.innerHeight - 32)
				else if (e.data.type === 'saved') {
					toast('Follow-up saved' + (e.data.warn ? '. ' + e.data.warn : ''))
					tellCrm()
					load({ quiet: true })
				}
			}

			// links open the lead in the CRM; inside the CRM overlay, the CRM page itself goes there
			function openLead(e, i) {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button > 0) return // the browser's own "new tab" gestures
				if (EMBED && i.reference_url) { e.preventDefault(); tellParent('navigate', { url: i.reference_url }) }
			}
			const closeSelf = () => tellParent('close')
			// "Open in a new tab": the same tab, filters and range, without the pop-up frame; the CRM's theme goes along
			function openFull() {
				const q = new URLSearchParams()
				if (params.get('v')) q.set('v', params.get('v'))
				q.set('theme', document.documentElement.getAttribute('data-theme') || 'light')
				q.set('range', range.value.preset)
				if (range.value.preset === 'custom') { q.set('from', range.value.from); q.set('to', range.value.to) }
				if (scope.value) q.set('scope', scope.value)
				if (owner.value) q.set('owner', owner.value)
				if (outcome.value) q.set('outcome', outcome.value)
				if (search.value.trim()) q.set('q', search.value.trim())
				window.open(location.pathname + '?' + q.toString() + '#' + tab.value, '_blank')
			}
			const emptyText = computed(() => {
				if (filtered.value) return ['Nothing matches these filters', 'Try a different search, or clear the filters.']
				return {
					overdue: ['Nothing overdue', 'Every follow-up is on time. Nice work.'],
					today: ['Nothing else due today', 'Follow-ups scheduled for today will show up here.'],
					upcoming: ['Nothing scheduled', 'Set a next follow-up date when you log a call and it appears here.'],
					done: ['Nothing done yet in this period', 'Follow-ups you complete, or follow up with a newer call, are listed here.'],
				}[tab.value]
			})
			const hasMore = computed(() => !!data.value && items.value.length < data.value.total)

			return {
				EMBED, TABS, data, items, loading, more, fatal, toasts, form, frame, busy, selected, tab, scope, scopeModel, owner, outcome, search, view, range, updatedAt, searchBox,
				isManager, everyone, scopeOptions, ownerOptions, outcomeOptions, subtitle, filtered, clearFilters, cards, pickCard, due, statusColor, outcomeTone,
				rows, dayCount, canSelect, selectedNames, allSelected, toggleAll, toggle, markDone, reschedule, bulk, logFor, closeForm, openLead, closeSelf, openFull, emptyText,
				hasMore, load, loadMore, num, plural,
			}
		},
		template: `
<div class="dash fu">
	<div class="progress" v-if="loading"></div>
	<header class="dash-bar fu-bar">
		<div class="fu-row">
			<div class="dash-brand"><span class="brand-ico"><ico name="phone-call" size="lg" /></span><div><h1>Follow-ups</h1><div class="sub">{{ subtitle }}</div></div></div>
			<label class="fu-search"><ico name="search" /><input ref="searchBox" type="search" v-model="search" placeholder="Search leads, phone numbers, remarks" aria-label="Search follow-ups" /><kbd v-if="!search">/</kbd></label>
			<span class="spacer"></span>
			<span class="sub updated" v-if="updatedAt">Updated {{ updatedAt }}</span>
			<div class="seg" role="group" aria-label="View"><button :class="{ on: view === 'table' }" @click="view = 'table'" title="Table"><ico name="list" /> List</button><button :class="{ on: view === 'agenda' }" @click="view = 'agenda'" title="Grouped by day"><ico name="agenda" /> By day</button></div>
			<button class="btn ghost icon" @click="load()" :title="updatedAt ? 'Refresh (updated ' + updatedAt + ')' : 'Refresh'" aria-label="Refresh"><ico name="refresh" size="lg" /></button>
			<a class="btn" href="/crm" v-if="!EMBED"><ico name="back" /> CRM</a>
			<button class="btn ghost icon" v-if="EMBED" @click="openFull" title="Open in a new tab" aria-label="Open in a new tab"><ico name="external" size="lg" /></button>
			<button class="btn ghost icon" v-if="EMBED" @click="closeSelf" title="Close (Esc)" aria-label="Close"><ico name="x" size="lg" /></button>
		</div>
		<div class="fu-row filters" v-if="data">
			<div class="fu-pick" v-if="isManager"><pick v-model="scopeModel" :options="scopeOptions" icon="users" /></div>
			<div class="fu-pick" v-if="everyone"><pick v-model="owner" :options="ownerOptions" placeholder="All owners" icon="user" /></div>
			<div class="fu-pick"><pick v-model="outcome" :options="outcomeOptions" placeholder="All outcomes" icon="phone" /></div>
			<range-picker v-model="range" />
			<button class="btn ghost small" v-if="filtered" @click="clearFilters"><ico name="x" /> Clear filters</button>
		</div>
	</header>

	<div class="banner error fu-banner" v-if="fatal"><span>{{ fatal }}</span><button class="btn small" @click="load()">Try again</button></div>
	<div class="banner fu-banner" v-if="data && !data.enabled">Follow-ups are switched off in CRM Addons Settings. You can still see the ones already logged.</div>

	<main class="dash-body" v-if="data">
		<section class="kpis fu-kpis">
			<component :is="c.click ? 'button' : 'div'" v-for="c in cards" :key="c.key" class="kpi fu-kpi" :class="[c.tone, { click: c.click, on: c.click && tab === c.key }]" :title="c.hint" @click="pickCard(c)" :type="c.click ? 'button' : null">
				<span class="kpi-label">{{ c.label }}</span>
				<span class="kpi-value">{{ c.value }}</span>
				<span class="kpi-sub" :class="c.subTone">{{ c.sub }}</span>
			</component>
		</section>

		<section class="panel fu-panel" :class="{ busy: loading }">
			<div class="fu-tabs" role="tablist">
				<button v-for="t in TABS" :key="t[0]" role="tab" :aria-selected="tab === t[0]" class="fu-tab" :class="[t[0], { on: tab === t[0] }]" @click="tab = t[0]">{{ t[1] }}<span class="count">{{ num(data.counts[t[0]]) }}</span></button>
				<span class="spacer"></span>
				<span class="sub fu-total" v-if="items.length">{{ items.length < data.total ? 'Showing ' + num(items.length) + ' of ' + num(data.total) : plural(data.total, 'follow-up') }}</span>
			</div>

			<div class="fu-bulk" v-if="selectedNames.length">
				<b>{{ selectedNames.length }} selected</b>
				<button class="btn small primary" @click="bulk('done')"><ico name="check" /> Mark done</button>
				<reschedule label="Reschedule" align="left" @pick="(w) => bulk('reschedule', w)" />
				<span class="spacer"></span>
				<button class="btn ghost small" @click="toggleAll" v-if="!allSelected">Select all {{ items.length }}</button>
				<button class="btn ghost small" @click="Object.keys(selected).forEach((k) => delete selected[k])">Clear</button>
			</div>

			<div class="table-wrap fu-wrap" v-if="rows.length">
				<table class="fu-table" :class="view === 'agenda' ? 'by-day' : 'plain-list'">
					<thead><tr>
						<th class="chk"><input type="checkbox" v-if="canSelect" :checked="allSelected" @change="toggleAll" aria-label="Select all" /></th>
						<th>Lead</th><th>Contact</th><th>Last call</th><th>{{ tab === 'done' ? 'Was due' : 'Due' }}</th><th v-if="everyone || tab === 'done'">Owner</th><th class="remark">Remark</th><th class="act"></th>
					</tr></thead>
					<tbody>
						<template v-for="r in rows" :key="r.key">
							<tr class="day-row" v-if="r.kind === 'head'"><td :colspan="everyone || tab === 'done' ? 8 : 7"><span :class="{ late: r.late }">{{ r.label }}</span><span class="sub"> · {{ dayCount(r.day) }}</span></td></tr>
							<tr v-else class="fu-row-item" :class="{ sel: selected[r.item.name], working: busy[r.item.name] }">
								<td class="chk"><input type="checkbox" v-if="canSelect && r.item.can_edit" :checked="!!selected[r.item.name]" @change="toggle(r.item)" :aria-label="'Select ' + r.item.reference_title" /></td>
								<td class="lead-cell">
									<a class="lead-name" :href="r.item.reference_url || '#'" target="_blank" rel="noopener" @click="openLead($event, r.item)">{{ r.item.reference_title }}</a>
									<span class="lead-sub"><span v-if="r.item.lead_status" class="status"><i :style="{ background: statusColor(r.item.lead_status_color) }"></i>{{ r.item.lead_status }}</span><span v-if="r.item.organization" class="sub">{{ r.item.organization }}</span></span>
								</td>
								<td class="contact"><a v-if="r.item.phone" class="tel" :href="'tel:' + r.item.phone.replace(/\\s+/g, '')" :title="'Call ' + r.item.phone"><ico name="phone" />{{ r.item.phone }}</a><span v-else class="sub">No number</span></td>
								<td class="last">
									<span class="chip" :class="'t-' + outcomeTone(r.item.outcome)" v-if="r.item.outcome">{{ r.item.outcome }}</span><span class="chip" v-else>{{ r.item.mode === 'Call' ? 'Call' : 'Follow-up' }}</span>
									<span class="sub attempt" v-if="r.item.mode === 'Call' && r.item.attempt_no">Attempt {{ r.item.attempt_no }}</span>
								</td>
								<td class="when"><b :class="due(r.item).tone">{{ due(r.item).top }}</b><span class="sub">{{ due(r.item).sub }}</span></td>
								<td class="owner" v-if="everyone || tab === 'done'"><span class="who"><avatar :name="r.item.assigned_name || r.item.assigned_to" /><span class="who-name">{{ r.item.assigned_name || r.item.assigned_to }}</span></span></td>
								<td class="remark"><span class="remark-text" :title="r.item.remark">{{ r.item.remark || '' }}</span></td>
								<td class="act">
									<span class="acts">
										<button class="btn small primary" @click="logFor(r.item)" title="Log a call or follow-up"><ico name="phone-call" /> Log</button>
										<template v-if="r.item.bucket !== 'done' && r.item.can_edit">
											<button class="btn ghost icon small" :disabled="busy[r.item.name]" @click="markDone(r.item)" title="Mark done" aria-label="Mark done"><ico name="check-circle" /></button>
											<reschedule compact :disabled="busy[r.item.name]" @pick="(w) => reschedule(r.item, w)" />
										</template>
										<a class="btn ghost icon small" :href="r.item.reference_url || '#'" target="_blank" rel="noopener" @click="openLead($event, r.item)" title="Open the lead" aria-label="Open the lead"><ico name="external" /></a>
									</span>
								</td>
							</tr>
						</template>
					</tbody>
				</table>
			</div>

			<div class="fu-empty" v-else-if="!loading">
				<span class="big"><ico :name="filtered ? 'search' : tab === 'overdue' ? 'check-circle' : tab === 'done' ? 'trend' : 'inbox'" /></span>
				<h3>{{ emptyText[0] }}</h3>
				<p>{{ emptyText[1] }}</p>
				<button class="btn" v-if="filtered" @click="clearFilters">Clear filters</button>
			</div>
			<div class="fu-more" v-if="hasMore"><button class="btn" :disabled="more" @click="loadMore"><span class="spin" v-if="more"></span> Show {{ Math.min(50, data.total - items.length) }} more</button></div>
		</section>
	</main>

	<main class="dash-body" v-else-if="!fatal">
		<section class="kpis"><div class="kpi skel" v-for="n in 5" :key="n"></div></section>
		<section class="panel fu-panel"><div class="fu-skel" v-for="n in 7" :key="n"><i class="skel"></i><i class="skel w2"></i><i class="skel w3"></i></div></section>
	</main>

	<div class="fu-overlay" v-if="form" @mousedown.self="closeForm">
		<iframe ref="frame" class="fu-frame" :src="form.src" :title="'Log a follow-up for ' + form.lead" :style="{ height: form.height + 'px' }"></iframe>
	</div>
	<div class="toast-wrap"><div class="toast" :class="t.kind" v-for="t in toasts" :key="t.id" role="status">{{ t.text }}</div></div>
</div>`,
	}

	createApp(App).mount('#app')
})()
