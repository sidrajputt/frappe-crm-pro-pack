/* CRM Pro Pack - Sales Dashboard (Vue 3, no build step, charts drawn as SVG).
 * A full-screen page of its own. What it shows follows the roles: managers see everyone (and can
 * look at one person), sales users only their own numbers. */
(() => {
	const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, onErrorCaptured } = Vue

	// ------------------------------------------------------------------ environment
	const params = new URLSearchParams(location.search)
	const EMBED = params.get('embed') === '1'
	const RANGE_KEY = 'crm_addons_dash_range'
	const store = {
		get(k) { try { return localStorage.getItem(k) } catch (e) { return null } },
		set(k, v) { try { localStorage.setItem(k, v) } catch (e) { /* private mode */ } },
	}

	// The theme belongs to the CRM, here as everywhere: ask the page that hosts or opened this one, then the
	// 'theme' the CRM keeps in this browser (same origin), then the URL, then the browser. There is no switch of its own.
	function crmTheme() {
		for (const w of [window.parent !== window ? window.parent : null, window.opener]) {
			try { const t = w && w.document.documentElement.getAttribute('data-theme'); if (t) return t } catch (e) { /* cross-origin */ }
		}
		const saved = store.get('theme')
		return saved === 'dark' || saved === 'light' ? saved : null
	}
	function applyTheme() {
		const t = crmTheme() || params.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
		const v = t === 'dark' ? 'dark' : 'light'
		if (document.documentElement.getAttribute('data-theme') !== v) document.documentElement.setAttribute('data-theme', v)
	}
	applyTheme()
	for (const w of [window.parent !== window ? window.parent : null, window.opener]) {
		try { if (w) new MutationObserver(applyTheme).observe(w.document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }) } catch (e) { /* not reachable */ }
	}
	window.addEventListener('storage', (e) => { if (e.key === 'theme') applyTheme() })
	const tellParent = (type, extra) => { if (window.parent !== window) window.parent.postMessage({ source: 'crm-addons', type, ...(extra || {}) }, location.origin) }

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
	function errorText(body, status) {
		try {
			const msgs = JSON.parse(body._server_messages || '[]').map((m) => JSON.parse(m).message)
			if (msgs.length) return msgs.join(' ').replace(/<[^>]+>/g, '')
		} catch (e) { /* fall through */ }
		if (status === 401 || status === 403) return 'You do not have access to this dashboard, or your session has expired. Open the CRM and log in again.'
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
	const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
	const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
	const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
	const fromSql = (s) => new Date(String(s).replace(' ', 'T'))
	const num = (n) => Number(n || 0).toLocaleString()
	const fmtDate = (d, o) => d.toLocaleDateString([], o || { day: 'numeric', month: 'short' })
	const fmtRange = (a, b) => (ymd(a) === ymd(b) ? fmtDate(a, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : `${fmtDate(a, a.getFullYear() === b.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })} - ${fmtDate(b, { day: 'numeric', month: 'short', year: 'numeric' })}`)
	const fmtWhen = (s) => fromSql(s).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
	const hourLabel = (h) => (h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : h - 12 + 'p')
	const hourName = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })

	const PALETTE = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#dc2626', '#0d9488', '#ca8a04', '#64748b']
	const STATUS_COLORS = { black: '#171717', gray: '#94a3b8', blue: '#2563eb', green: '#16a34a', red: '#dc2626', pink: '#db2777', orange: '#ea580c', amber: '#d97706', yellow: '#ca8a04', cyan: '#0891b2', teal: '#0d9488', violet: '#7c3aed', purple: '#9333ea' }
	const OUTCOME_COLORS = { 'Did Not Pick': '#dc2626', 'Did Not Connect': '#f59e0b', Interested: '#16a34a', 'Not Interested': '#94a3b8', 'Meeting Scheduled': '#2563eb', 'Ask for Detail': '#0891b2', 'Call Back Later': '#ea580c' }

	const ICONS = {
		chart: '<path d="M3 3v18h18"/><path d="M8 17v-6M13 17V7M18 17v-3"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
		refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
		calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
		download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
		sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
		moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
		left: '<path d="m15 18-6-6 6-6"/>',
		right: '<path d="m9 18 6-6-6-6"/>',
		back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
		user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
		send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
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

	// ------------------------------------------------------------------ dropdown with a floating list (people filter)
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
				style.value = { left: Math.min(r.left, window.innerWidth - 240) + 'px', minWidth: Math.max(r.width, 200) + 'px', maxHeight: room + 'px', ...(up ? { bottom: window.innerHeight - r.top + 6 + 'px' } : { top: r.bottom + 6 + 'px' }) }
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

	// ------------------------------------------------------------------ actions menu (Export)
	const Menu = {
		components: { Ico },
		props: { label: String, icon: String, items: Array },
		emits: ['select'],
		setup(props, { emit }) {
			const open = ref(false)
			const btn = ref(null)
			const pop = ref(null)
			const style = ref({})
			function show() {
				const r = btn.value.getBoundingClientRect()
				style.value = { right: Math.max(8, window.innerWidth - r.right) + 'px', top: r.bottom + 6 + 'px' }
				open.value = true
			}
			const choose = (it) => { open.value = false; emit('select', it.key) }
			const onDoc = (e) => { if (open.value && !(pop.value && pop.value.contains(e.target)) && !btn.value.contains(e.target)) open.value = false }
			onMounted(() => document.addEventListener('mousedown', onDoc))
			onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc))
			return { open, btn, pop, style, show, choose }
		},
		template: `
<div class="pick">
	<button type="button" class="btn" ref="btn" @click="open ? (open = false) : show()" aria-haspopup="menu" :aria-expanded="open"><ico :name="icon" /> {{ label }}</button>
	<div class="pick-pop menu" ref="pop" v-if="open" :style="style" role="menu">
		<button v-for="it in items" :key="it.key" type="button" class="pick-opt two" role="menuitem" @mousedown.prevent="choose(it)"><span class="pick-label">{{ it.label }}<small>{{ it.hint }}</small></span></button>
	</div>
</div>`,
	}

	// ------------------------------------------------------------------ date range dropdown
	const PRESETS = [
		['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['week', 'This week'],
		['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year'],
	]
	function presetRange(key) {
		const today = startOfDay(new Date())
		const monday = addDays(today, -((today.getDay() + 6) % 7))
		switch (key) {
			case 'today': return [today, today]
			case 'yesterday': return [addDays(today, -1), addDays(today, -1)]
			case '30d': return [addDays(today, -29), today]
			case 'week': return [monday, today]
			case 'lastweek': return [addDays(monday, -7), addDays(monday, -1)]
			case 'month': return [new Date(today.getFullYear(), today.getMonth(), 1), today]
			case 'lastmonth': return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)]
			case 'quarter': return [new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1), today]
			case 'year': return [new Date(today.getFullYear(), 0, 1), today]
			default: return [addDays(today, -6), today]
		}
	}
	const rangeOf = (r) => (r.preset === 'custom' && r.from && r.to ? [parseDay(r.from), parseDay(r.to)] : presetRange(r.preset === 'custom' ? '7d' : r.preset))

	// the picker itself is shared with the other page: range-picker.js
	const RangePicker = window.CRMRangePicker.create({
		Vue, Ico, presets: PRESETS, presetRange, rangeOf, fmtRange,
		anyLabel: 'Any time', duePrefix: '', compare: true,
	})

	// ------------------------------------------------------------------ charts
	function niceMax(v) {
		if (v <= 4) return 4
		// the axis has four steps: make each one a round whole number, so no two ticks read the same
		const unit = Math.ceil(v / 4)
		const p = Math.pow(10, Math.floor(Math.log10(unit)))
		for (const m of [1, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (Number.isInteger(m * p) && m * p >= unit) return m * p * 4
		return 10 * p * 4
	}

	/** Bars, stacked when there is more than one series. series: [{ name, color, values }] */
	const BarChart = {
		props: { labels: Array, series: Array, height: { type: Number, default: 250 } },
		setup(props) {
			const W = 760
			const L = 40, R = 8, T = 10, B = 30
			const total = computed(() => props.series.reduce((n, s) => n + s.values.reduce((a, b) => a + b, 0), 0))
			const stackTotals = computed(() => props.labels.map((_, i) => props.series.reduce((n, s) => n + (s.values[i] || 0), 0)))
			const max = computed(() => niceMax(Math.max(0, ...stackTotals.value)))
			const H = computed(() => props.height)
			const plotH = computed(() => H.value - T - B)
			const band = computed(() => (W - L - R) / Math.max(1, props.labels.length))
			const barW = computed(() => Math.max(3, Math.min(34, band.value * 0.66)))
			const ticks = computed(() => [0, 1, 2, 3, 4].map((i) => ({ v: (max.value / 4) * i, y: T + plotH.value - (plotH.value * i) / 4 })))
			const every = computed(() => Math.ceil(props.labels.length / 12))
			const bars = computed(() =>
				props.labels.map((label, i) => {
					const x = L + band.value * i + (band.value - barW.value) / 2
					let acc = 0
					const parts = props.series.map((s) => {
						const v = s.values[i] || 0
						const h = (v / max.value) * plotH.value
						const y = T + plotH.value - ((acc + v) / max.value) * plotH.value
						acc += v
						return { name: s.name, color: s.color, v, h, y }
					}).filter((p) => p.v > 0)
					const tip = `${label}: ` + (props.series.length > 1 ? props.series.map((s) => `${s.name} ${s.values[i] || 0}`).join(', ') : stackTotals.value[i])
					return { label, x, parts, tip, show: i % every.value === 0 }
				})
			)
			return { W, L, R, T, H, plotH, ticks, bars, barW, total, band }
		},
		template: `
<div class="chart-wrap">
	<svg v-if="total > 0" class="chart" :viewBox="'0 0 ' + W + ' ' + H" role="img">
		<g class="gridlines"><template v-for="t in ticks" :key="t.y"><line :x1="L" :x2="W - R" :y1="t.y" :y2="t.y" /><text :x="L - 8" :y="t.y + 4" text-anchor="end">{{ Math.round(t.v) }}</text></template></g>
		<g v-for="b in bars" :key="b.label" class="bar">
			<rect class="hit" :x="b.x - (band - barW) / 2" :y="T" :width="band" :height="plotH" fill="transparent"><title>{{ b.tip }}</title></rect>
			<rect v-for="p in b.parts" :key="p.name" :x="b.x" :y="p.y" :width="barW" :height="Math.max(1, p.h)" :fill="p.color" rx="2"><title>{{ b.tip }}</title></rect>
			<text v-if="b.show" :x="b.x + barW / 2" :y="H - 9" text-anchor="middle">{{ b.label }}</text>
		</g>
	</svg>
	<div v-else class="chart-empty">Nothing in this period</div>
</div>`,
	}

	const Donut = {
		props: { items: Array, centre: String, size: { type: Number, default: 168 } },
		setup(props) {
			const R = 62
			const C = 2 * Math.PI * R
			const total = computed(() => props.items.reduce((n, i) => n + i.value, 0))
			const arcs = computed(() => {
				let acc = 0
				return props.items.filter((i) => i.value > 0).map((i) => {
					const len = (i.value / total.value) * C
					const arc = { ...i, dash: `${Math.max(0, len - 1.5)} ${C - Math.max(0, len - 1.5)}`, offset: -acc }
					acc += len
					return arc
				})
			})
			return { R, C, total, arcs }
		},
		template: `
<svg class="donut" :width="size" :height="size" viewBox="0 0 160 160" role="img">
	<circle cx="80" cy="80" :r="R" fill="none" stroke="var(--input)" stroke-width="20" />
	<circle v-for="a in arcs" :key="a.label" cx="80" cy="80" :r="R" fill="none" :stroke="a.color" stroke-width="20" :stroke-dasharray="a.dash" :stroke-dashoffset="a.offset" transform="rotate(-90 80 80)"><title>{{ a.label }}: {{ a.value }}</title></circle>
	<text x="80" y="78" text-anchor="middle" class="donut-num">{{ total }}</text>
	<text x="80" y="96" text-anchor="middle" class="donut-sub">{{ centre }}</text>
</svg>`,
	}

	// ------------------------------------------------------------------ the page
	const App = {
		components: { Ico, Avatar, Pick, VMenu: Menu, RangePicker, BarChart, Donut },
		setup() {
			const data = ref(null)
			const loading = ref(false)
			const fatal = ref('')
			// the range: what the URL says (a new tab opened from the pop-up), else the last one used on this page
			const validRange = (r) => !!(r && (PRESETS.some((p) => p[0] === r.preset) || (r.preset === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(r.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(r.to || ''))))
			const saved = (() => { try { return JSON.parse(store.get(RANGE_KEY) || 'null') } catch (e) { return null } })()
			const fromUrl = { preset: params.get('range') || '', from: params.get('from') || '', to: params.get('to') || '' }
			// a ref, because the picker replaces the whole value (v-model)
			const range = ref(validRange(fromUrl) ? fromUrl : validRange(saved) ? saved : { preset: '7d', from: '', to: '' })
			const user = ref(params.get('user') || '')
			const metric = ref('calls')
			const split = ref('result')
			const sort = reactive({ key: 'calls', dir: -1 })
			const updatedAt = ref('')
			// Lead Nurturing: campaign numbers, fetched only when that tab is opened
			const config = ref(null)
			const nurturingOn = computed(() => !!(config.value && config.value.campaigns_enabled))
			const view = ref(location.hash === '#nurturing' ? 'nurturing' : 'sales')
			const nur = ref(null)
			const nurLoading = ref(false)
			const nurError = ref('')
			const funnelChannel = ref('all')
			let nurKey = ''

			onErrorCaptured((err) => { fatal.value = 'The dashboard could not be drawn (' + (err && err.message ? err.message : err) + '). Reload the page with Ctrl/Cmd+Shift+R.'; return false })

			async function load(quiet) {
				if (!quiet) loading.value = true
				const [a, b] = rangeOf(range.value)
				try {
					data.value = await call('crm_addons.reports.get_sales_report', { from_date: ymd(a), to_date: ymd(b), user: user.value || undefined })
					fatal.value = ''
					updatedAt.value = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
				} catch (e) { fatal.value = e.message } finally { loading.value = false }
			}
			async function loadNurturing(quiet) {
				const [a, b] = rangeOf(range.value)
				const key = [ymd(a), ymd(b), user.value].join('|')
				if (!quiet) nurLoading.value = true
				try {
					nur.value = await call('crm_addons.dashboard.get_nurturing', { from_date: ymd(a), to_date: ymd(b), user: user.value || undefined })
					nurKey = key
					nurError.value = ''
					updatedAt.value = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
				} catch (e) { nurError.value = e.message } finally { nurLoading.value = false }
			}
			function setView(v) {
				if (v === 'nurturing' && !nurturingOn.value) v = 'sales'
				view.value = v
				try { history.replaceState(null, '', v === 'nurturing' ? '#nurturing' : location.pathname + location.search) } catch (e) { /* ignore */ }
				const [a, b] = rangeOf(range.value)
				if (v === 'nurturing' && (!nur.value || nurKey !== [ymd(a), ymd(b), user.value].join('|'))) loadNurturing()
			}
			const refresh = (quiet) => (view.value === 'nurturing' ? loadNurturing(quiet) : load(quiet))
			watch([range, user], () => { store.set(RANGE_KEY, JSON.stringify(range.value)); load(); if (view.value === 'nurturing') loadNurturing() })

			let timer
			const onHash = () => setView(location.hash === '#nurturing' ? 'nurturing' : 'sales')
			onMounted(() => {
				load()
				call('crm_addons.api.get_client_config').then((c) => {
					config.value = c
					if (view.value === 'nurturing') { if (c.campaigns_enabled) loadNurturing(); else view.value = 'sales' }
				}).catch(() => { if (view.value === 'nurturing') view.value = 'sales' })
				window.addEventListener('hashchange', onHash)
				timer = setInterval(() => document.visibilityState === 'visible' && refresh(true), 120000)
				document.addEventListener('keydown', onEsc)
			})
			onBeforeUnmount(() => { clearInterval(timer); document.removeEventListener('keydown', onEsc); window.removeEventListener('hashchange', onHash) })

			// Esc closes the pop-up, but only when nothing inside the page (a dropdown, the date picker) is open:
			// those close themselves first and stop the key
			function onEsc(e) {
				if (e.key !== 'Escape' || !EMBED || e.defaultPrevented) return
				if (document.querySelector('.pick-pop')) return
				tellParent('close')
			}
			// "Open in a new tab": the same tab, range and person, without the pop-up frame; the CRM's theme goes along
			function openFull() {
				const q = new URLSearchParams()
				if (params.get('v')) q.set('v', params.get('v'))
				q.set('theme', document.documentElement.getAttribute('data-theme') || 'light')
				q.set('range', range.value.preset)
				if (range.value.preset === 'custom') { q.set('from', range.value.from); q.set('to', range.value.to) }
				if (user.value) q.set('user', user.value)
				window.open(location.pathname + '?' + q.toString() + (view.value === 'nurturing' ? '#nurturing' : ''), '_blank')
			}

			// ---------- who and when
			const scope = computed(() => (data.value ? data.value.scope : null))
			const isManager = computed(() => !!(scope.value && scope.value.is_manager))
			const everyone = computed(() => isManager.value && !scope.value.user)
			const userOptions = computed(() => [{ value: '', label: 'Everyone' }, ...(scope.value ? scope.value.users.map((u) => ({ value: u.name, label: u.full_name })) : [])])
			const subtitle = computed(() => (!scope.value ? '' : scope.value.user ? (isManager.value ? scope.value.user_name : 'Your numbers') : 'Whole team'))
			const exportItems = [
				{ key: 'xlsx', label: 'Excel workbook (.xlsx)', hint: 'Every section on its own sheet, plus the call log' },
				{ key: 'csv', label: 'Call log (.csv)', hint: 'Every call in this period' },
			]
			function exportFile(format) {
				const [a, b] = rangeOf(range.value)
				const q = new URLSearchParams({ from_date: ymd(a), to_date: ymd(b), format })
				if (user.value) q.set('user', user.value)
				window.location.href = '/api/method/crm_addons.reports.export_report?' + q.toString()
			}

			// ---------- KPI cards
			function delta(cur, prev, points) {
				if (points) { const d = Math.round((cur - prev) * 10) / 10; return d ? { text: `${d > 0 ? '+' : ''}${d} pts`, up: d > 0 } : null }
				if (!prev) return cur ? { text: 'new', up: true } : null
				const d = Math.round(((cur - prev) / prev) * 100)
				return d ? { text: `${d > 0 ? '+' : ''}${d}%`, up: d > 0 } : null
			}
			const cards = computed(() => {
				if (!data.value) return []
				const t = data.value.totals, p = data.value.previous, d = data.value.today
				return [
					{ label: 'Calls today', value: num(d.calls), sub: `${num(d.connected)} connected`, tone: 'blue' },
					{ label: 'Follow-ups due today', value: num(d.due_today), sub: d.overdue ? `${num(d.overdue)} overdue` : 'Nothing overdue', subTone: d.overdue ? 'bad' : 'good', tone: 'amber' },
					{ label: 'Calls', value: num(t.calls), sub: `${num(t.connected)} connected`, delta: delta(t.calls, p.calls) },
					{ label: 'Connect rate', value: t.connect_rate + '%', sub: t.avg_attempts ? `${t.avg_attempts} attempts to connect` : 'No connected calls', delta: delta(t.connect_rate, p.connect_rate, true) },
					{ label: 'Follow-ups added', value: num(t.follow_ups), sub: 'call logs and notes', delta: delta(t.follow_ups, p.follow_ups) },
					{ label: 'Leads added', value: num(t.leads), sub: 'by lead owner', delta: delta(t.leads, p.leads) },
					{ label: 'Meetings', value: num(t.meetings), sub: `${num(t.held)} held`, delta: delta(t.meetings, p.meetings) },
					{ label: 'Converted to deals', value: num(t.converted), sub: 'leads that became deals', delta: delta(t.converted, p.converted) },
					{ label: 'Time to first call', value: data.value.speed_hours === null ? '-' : data.value.speed_hours + ' h', sub: 'after a lead is added' },
					{ label: 'Stale leads', value: num(data.value.stale), sub: data.value.stale_days ? `no activity for ${data.value.stale_days}+ days` : 'alerts are switched off', subTone: data.value.stale ? 'bad' : '' },
				]
			})

			// ---------- daily chart
			const days = computed(() => {
				if (!scope.value) return []
				const out = []
				for (let d = parseDay(scope.value.from), end = parseDay(scope.value.to); d <= end; d = addDays(d, 1)) out.push(ymd(d))
				return out
			})
			const dayLabels = computed(() => days.value.map((d) => (days.value.length <= 7 ? parseDay(d).toLocaleDateString([], { weekday: 'short', day: 'numeric' }) : fmtDate(parseDay(d)))))
			const personOrder = computed(() => (data.value ? data.value.people.filter((p) => p[metric.value] > 0 || data.value.daily.some((r) => r.person === p.user && r[metric.value] > 0)) : []))
			const canSplitByPerson = computed(() => everyone.value && personOrder.value.length > 1)
			watch([metric, canSplitByPerson], () => {
				if (metric.value !== 'calls' && split.value === 'result') split.value = canSplitByPerson.value ? 'person' : 'total'
				if (metric.value === 'calls' && split.value === 'total') split.value = 'result'
				if (!canSplitByPerson.value && split.value === 'person') split.value = metric.value === 'calls' ? 'result' : 'total'
			})
			const seriesData = computed(() => {
				if (!data.value) return []
				const key = metric.value
				const cell = (day, filter) => data.value.daily.filter((r) => r.date === day && filter(r)).reduce((n, r) => n + (r[key] || 0), 0)
				if (split.value === 'person' && canSplitByPerson.value) {
					const top = personOrder.value.slice(0, 7)
					const series = top.map((p, i) => ({ name: p.full_name, color: PALETTE[i], values: days.value.map((d) => cell(d, (r) => r.person === p.user)) }))
					const others = personOrder.value.slice(7).map((p) => p.user)
					if (others.length) series.push({ name: 'Others', color: '#b0b0b0', values: days.value.map((d) => cell(d, (r) => others.includes(r.person))) })
					return series
				}
				if (key === 'calls' && split.value === 'result') {
					const conn = days.value.map((d) => data.value.daily.filter((r) => r.date === d).reduce((n, r) => n + r.connected, 0))
					const all = days.value.map((d) => cell(d, () => true))
					return [{ name: 'Connected', color: '#16a34a', values: conn }, { name: 'Not connected', color: '#f0776a', values: all.map((v, i) => v - conn[i]) }]
				}
				const color = { calls: '#2563eb', follow_ups: '#7c3aed', leads: '#0891b2' }[key]
				return [{ name: { calls: 'Calls', follow_ups: 'Follow-ups', leads: 'Leads added' }[key], color, values: days.value.map((d) => cell(d, () => true)) }]
			})
			const chartTotal = computed(() => seriesData.value.reduce((n, s) => n + s.values.reduce((a, b) => a + b, 0), 0))
			const splitOptions = computed(() => {
				const opts = [metric.value === 'calls' ? ['result', 'Result'] : ['total', 'Total']]
				if (canSplitByPerson.value) opts.push(['person', 'By person'])
				return opts
			})

			// ---------- the rest of the charts
			const outcomeItems = computed(() => (data.value ? data.value.outcomes.map((o) => ({ label: o.outcome, value: o.count, color: OUTCOME_COLORS[o.key] || '#94a3b8' })) : []))
			const outcomeTotal = computed(() => outcomeItems.value.reduce((n, i) => n + i.value, 0))
			const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0)

			const funnel = computed(() => {
				if (!data.value) return []
				const top = Math.max(1, data.value.funnel[0].count)
				return data.value.funnel.map((s, i, all) => ({ ...s, width: Math.max(2, (s.count / top) * 100), of_first: pct(s.count, top), step: i ? pct(s.count, all[i - 1].count) : null }))
			})
			const hourLabels = computed(() => (data.value ? data.value.by_hour.map((h) => hourLabel(h.hour)) : []))
			const hourSeries = computed(() => (data.value ? [
				{ name: 'Connected', color: '#16a34a', values: data.value.by_hour.map((h) => h.connected) },
				{ name: 'Not connected', color: '#f0776a', values: data.value.by_hour.map((h) => h.calls - h.connected) },
			] : []))
			const bestHour = computed(() => {
				if (!data.value) return null
				const ok = data.value.by_hour.filter((h) => h.calls >= 3)
				if (!ok.length) return null
				const best = ok.reduce((a, b) => (b.connected / b.calls > a.connected / a.calls ? b : a))
				return { name: hourName(best.hour), rate: pct(best.connected, best.calls), calls: best.calls }
			})
			const attemptLabels = computed(() => (data.value ? data.value.attempts.map((a) => a.label) : []))
			const attemptSeries = computed(() => (data.value ? [{ name: 'Calls that connected', color: '#2563eb', values: data.value.attempts.map((a) => a.count) }] : []))

			const statusRows = computed(() => (data.value ? data.value.statuses.map((s) => ({ ...s, color: STATUS_COLORS[s.color] || '#94a3b8' })) : []))
			const statusMax = computed(() => Math.max(1, ...statusRows.value.map((s) => s.count)))
			const statusTotal = computed(() => statusRows.value.reduce((n, s) => n + s.count, 0))
			const sourceRows = computed(() => (data.value ? data.value.sources : []))
			const sourceMax = computed(() => Math.max(1, ...sourceRows.value.map((s) => s.leads)))
			const bandItems = computed(() => {
				const b = data.value ? data.value.score_bands : { hot: 0, warm: 0, cold: 0 }
				return [{ label: 'Hot', value: b.hot, color: '#16a34a' }, { label: 'Warm', value: b.warm, color: '#f59e0b' }, { label: 'Cold', value: b.cold, color: '#94a3b8' }]
			})
			const meetingItems = computed(() => (data.value ? data.value.meeting_outcomes.map((m) => ({ label: m.outcome, value: m.count, color: { Held: '#16a34a', 'No Show': '#dc2626', Rescheduled: '#f59e0b', 'Not recorded': '#94a3b8' }[m.outcome] || '#2563eb' })) : []))
			const meetingTotal = computed(() => meetingItems.value.reduce((n, i) => n + i.value, 0))

			// ---------- team
			const showTeam = computed(() => isManager.value && data.value && data.value.people.length > 1)
			const people = computed(() => {
				if (!data.value) return []
				const k = sort.key
				return data.value.people.slice().sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * sort.dir || a.full_name.localeCompare(b.full_name))
			})
			const maxCalls = computed(() => Math.max(1, ...(data.value ? data.value.people.map((p) => p.calls) : [1])))
			const columns = [['calls', 'Calls'], ['connected', 'Connected'], ['connect_rate', 'Connect rate'], ['not_picked', 'Not picked'], ['follow_ups', 'Follow-ups'], ['leads', 'Leads'], ['meetings', 'Meetings'], ['converted', 'Converted'], ['due_today', 'Due today'], ['overdue', 'Overdue']]
			const sortBy = (k) => { if (sort.key === k) sort.dir = -sort.dir; else { sort.key = k; sort.dir = -1 } }
			const rateTone = (r, calls) => (!calls ? '' : r >= 50 ? 'good' : r >= 25 ? 'mid' : 'bad')
			const mixRows = computed(() => (data.value ? data.value.people.filter((p) => p.calls > 0).slice(0, 12).map((p) => ({ name: p.full_name, total: p.calls, parts: Object.keys(OUTCOME_COLORS).filter((k) => p.outcomes[k]).map((k) => ({ key: k, n: p.outcomes[k], color: OUTCOME_COLORS[k] })) })) : []))
			const mixMax = computed(() => Math.max(1, ...mixRows.value.map((r) => r.total)))

			// ---------- lead nurturing (campaigns)
			const NUR = { Email: '#2563eb', WhatsApp: '#16a34a' }
			const CAMPAIGN_COLORS = { Running: '#2563eb', Queued: '#0891b2', Scheduled: '#7c3aed', Paused: '#f59e0b', Completed: '#16a34a', Draft: '#94a3b8', Cancelled: '#64748b', Failed: '#dc2626' }
			const rate = (v) => (v === null || v === undefined ? '-' : v + '%')
			const nDelta = (cur, prev, points, invert) => {
				if (cur === null || cur === undefined || prev === null || prev === undefined) return null
				const d = delta(cur, prev, points)
				return d && invert ? { ...d, up: !d.up, bad: true } : d
			}
			const emailSent = computed(() => (nur.value ? nur.value.channels.Email.sent : 0))
			const emailOpensKnown = computed(() => !!nur.value && (nur.value.tracking.email_open || nur.value.channels.Email.read > 0))
			const nurCards = computed(() => {
				if (!nur.value) return []
				const t = nur.value.totals, p = nur.value.previous
				return [
					{ label: 'Campaigns', value: num(t.campaigns), sub: 'created, started or sent in this period', delta: nDelta(t.campaigns, p.campaigns), tone: 'blue' },
					{ label: 'Recipients reached', value: num(t.reached), sub: `${num(t.sent)} messages sent`, delta: nDelta(t.reached, p.reached) },
					{ label: 'Delivered rate', value: rate(t.delivered_rate), sub: nur.value.channels.WhatsApp.sent ? `${num(t.delivered)} WhatsApp messages delivered` : 'Reported for WhatsApp only', delta: nDelta(t.delivered_rate, p.delivered_rate, true) },
					{ label: 'Read / open rate', value: rate(t.read_rate), sub: emailSent.value && !emailOpensKnown.value ? 'Email opens need open tracking' : `${num(t.read)} read or opened`, delta: nDelta(t.read_rate, p.read_rate, true) },
					{ label: 'Reply rate', value: rate(t.reply_rate), sub: `${num(t.replied)} ${t.replied === 1 ? 'lead' : 'leads'} wrote back within 14 days` },
					{ label: 'Failed', value: num(t.failed), sub: t.sent ? `${pct(t.failed, t.sent + t.failed)}% of attempts` : 'No sends yet', subTone: t.failed ? 'bad' : '', delta: nDelta(t.failed, p.failed, false, true) },
					{ label: 'Opt-outs', value: num(t.optouts), sub: 'unsubscribed or replied STOP' },
				]
			})
			const nurDayLabels = computed(() => (nur.value ? nur.value.by_day.map((d) => (nur.value.by_day.length <= 7 ? parseDay(d.date).toLocaleDateString([], { weekday: 'short', day: 'numeric' }) : fmtDate(parseDay(d.date)))) : []))
			const nurSeries = computed(() => (nur.value ? ['Email', 'WhatsApp'].map((c) => ({ name: c, color: NUR[c], values: nur.value.by_day.map((d) => d[c]) })) : []))
			const nurTotalSent = computed(() => (nur.value ? nur.value.totals.sent : 0))
			const nurFunnel = computed(() => {
				if (!nur.value) return []
				const ch = nur.value.channels, t = nur.value.totals, sel = funnelChannel.value
				const wa = ch.WhatsApp, em = ch.Email
				let sent, delivered, read, replied, readBase, deliveredBase
				if (sel === 'all') {
					sent = t.sent; delivered = wa.delivered; deliveredBase = wa.sent; read = t.read
					readBase = wa.sent + (emailOpensKnown.value ? em.sent : 0); replied = t.replied
				} else {
					const c = ch[sel]
					sent = c.sent; delivered = sel === 'WhatsApp' ? c.delivered : null; deliveredBase = c.sent
					read = sel === 'Email' && !emailOpensKnown.value ? null : c.read; readBase = c.sent; replied = c.replied
				}
				const top = Math.max(1, sent)
				const stages = [
					{ stage: 'Sent', count: sent, base: null },
					{ stage: sel === 'all' ? 'Delivered (WhatsApp)' : 'Delivered', count: delivered, base: deliveredBase, of: sel === 'all' ? 'of WhatsApp sent' : 'of sent', why: 'Email delivery is not reported' },
					{ stage: sel === 'Email' ? 'Opened' : 'Read / opened', count: read, base: readBase, of: sel === 'all' ? 'of sends that report reads' : 'of sent', why: 'Email opens need open tracking' },
					{ stage: 'Replied', count: replied, base: sel === 'all' ? t.reached : sel === 'Email' ? em.reached : wa.reached, of: 'of people reached', why: '' },
				]
				return stages.map((s) => ({ ...s, width: s.count === null ? 0 : Math.max(s.count ? 2 : 0, (s.count / top) * 100), rate: s.count === null || s.base === null ? null : pct(s.count, s.base) }))
			})
			const chanRows = computed(() => {
				if (!nur.value) return []
				return ['Email', 'WhatsApp'].map((name) => {
					const c = nur.value.channels[name]
					const hasDelivery = name === 'WhatsApp'
					const hasRead = name === 'WhatsApp' || emailOpensKnown.value
					return {
						name, color: NUR[name], sent: c.sent, reached: c.reached, failed: c.failed, replied: c.replied,
						delivered: hasDelivery ? c.delivered : null, read: hasRead ? c.read : null,
						deliveredRate: hasDelivery && c.sent ? pct(c.delivered, c.sent) : null, readRate: hasRead && c.sent ? pct(c.read, c.sent) : null,
						replyRate: c.reached ? pct(c.replied, c.reached) : null, failRate: c.sent + c.failed ? pct(c.failed, c.sent + c.failed) : null,
					}
				})
			})
			const chanMax = computed(() => Math.max(1, ...chanRows.value.map((r) => r.sent)))
			const statusDonut = computed(() => (nur.value ? nur.value.status_counts.map((s) => ({ label: s.status, value: s.count, color: CAMPAIGN_COLORS[s.status] || '#94a3b8' })) : []))
			const nurturedItems = computed(() => {
				if (!nur.value) return []
				const n = nur.value.nurtured
				return [{ label: 'Nurtured', value: n.nurtured, color: '#2563eb' }, { label: 'Not nurtured', value: n.not_nurtured, color: '#94a3b8' }]
			})
			const campaignUrl = (hash) => '/assets/crm_addons/campaigns/index.html' + (params.get('v') ? '?v=' + encodeURIComponent(params.get('v')) : '') + (hash || '')
			const pct1 = (v, total) => (total && (v / total) * 100 < 1 && v ? Math.max(0.1, Math.round((v / total) * 1000) / 10) : pct(v, total))
			const nurNoCampaigns = computed(() => !!nur.value && !nur.value.has_campaigns)
			const nurQuiet = computed(() => !!nur.value && nur.value.has_campaigns && !nur.value.totals.sent && !nur.value.totals.campaigns)
			const nurRateTone = (r) => (r === null ? '' : r >= 50 ? 'good' : r >= 20 ? 'mid' : 'bad')

			// ---------- links
			// inside the pop-up a lead / meeting link must move the CRM tab, not the frame
			const open = (url) => { if (!url) return; if (EMBED && window.parent !== window) tellParent('navigate', { url }); else location.href = url }
			const outcomeTone = (o) => ({ 'Did Not Pick': 'red', 'Did Not Connect': 'amber', Interested: 'green', 'Meeting Scheduled': 'green', 'Not Interested': 'red', 'Ask for Detail': 'blue', 'Call Back Later': 'amber' }[o] || '')
			const close = () => tellParent('close')

			return {
				EMBED, openFull, data, loading, fatal, range, user, userOptions, subtitle, updatedAt, exportItems, exportFile, metric, split, splitOptions, scope, isManager, everyone, cards,
				dayLabels, seriesData, chartTotal, outcomeItems, outcomeTotal, pct, funnel, hourLabels, hourSeries, bestHour, attemptLabels, attemptSeries, statusRows, statusMax, statusTotal, sourceRows, sourceMax,
				bandItems, meetingItems, meetingTotal, view, setView, nurturingOn, nur, nurLoading, nurError, refresh, funnelChannel, nurCards, nurDayLabels, nurSeries, nurTotalSent, nurFunnel, chanRows, chanMax, statusDonut, nurturedItems, campaignUrl, pct1, nurNoCampaigns, nurQuiet, nurRateTone, NUR, loadNurturing, showTeam, people, maxCalls, columns, sort, sortBy, rateTone, mixRows, mixMax, load, open, close, fmtWhen, outcomeTone, num, OUTCOME_COLORS,
			}
		},
		template: `
<div class="dash">
	<div class="progress" v-if="loading || nurLoading"></div>
	<header class="dash-bar">
		<div class="dash-brand"><span class="brand-ico"><ico name="chart" size="lg" /></span><div><h1>Sales Dashboard</h1><div class="sub">{{ subtitle }}</div></div></div>
		<div class="seg dash-tabs" role="tablist" aria-label="Dashboard" v-if="nurturingOn">
			<button role="tab" :aria-selected="view === 'sales'" :class="{ on: view === 'sales' }" @click="setView('sales')">Sales</button>
			<button role="tab" :aria-selected="view === 'nurturing'" :class="{ on: view === 'nurturing' }" @click="setView('nurturing')">Lead Nurturing</button>
		</div>
		<div class="dash-controls">
			<range-picker v-model="range" />
			<div class="user-pick" v-if="isManager"><pick v-model="user" :options="userOptions" placeholder="Everyone" icon="user" /></div>
		</div>
		<span class="spacer"></span>
		<span class="sub updated" v-if="updatedAt">Updated {{ updatedAt }}</span>
		<button class="btn ghost icon" @click="refresh()" :title="updatedAt ? 'Refresh (updated ' + updatedAt + ')' : 'Refresh'" aria-label="Refresh"><ico name="refresh" size="lg" /></button>
		<v-menu v-if="view === 'sales'" label="Export" icon="download" :items="exportItems" @select="exportFile" />
		<a class="btn" href="/crm" v-if="!EMBED"><ico name="back" /> CRM</a>
		<button class="btn ghost icon" v-if="EMBED" @click="openFull" title="Open in a new tab" aria-label="Open in a new tab"><ico name="external" size="lg" /></button>
		<button class="btn ghost icon" v-if="EMBED" @click="close" title="Close (Esc)" aria-label="Close"><ico name="x" size="lg" /></button>
	</header>

	<div class="banner error" v-if="view === 'sales' && fatal" style="margin:16px 24px 0">{{ fatal }}</div>
	<div class="banner error" v-if="view === 'nurturing' && nurError" style="margin:16px 24px 0">{{ nurError }}</div>

	<main class="dash-body" v-if="view === 'nurturing'">
		<template v-if="nur">
			<section class="panel nur-empty" v-if="nurNoCampaigns">
				<span class="big"><ico name="send" /></span>
				<h3>No campaigns yet</h3>
				<p>Lead Nurturing shows how your email and WhatsApp campaigns perform: who was reached, what was delivered, read and answered. Create your first campaign to start nurturing leads.</p>
				<a class="btn primary" :href="campaignUrl('#/new')" target="_blank" rel="noopener"><ico name="plus" /> Create campaign</a>
			</section>
			<template v-else>
				<section class="kpis nur-kpis">
					<div class="kpi" v-for="c in nurCards" :key="c.label" :class="c.tone">
						<div class="kpi-label">{{ c.label }}</div>
						<div class="kpi-value">{{ c.value }}<span class="delta" v-if="c.delta" :class="c.delta.up ? 'up' : 'down'">{{ c.delta.up ? '▲' : '▼' }} {{ c.delta.text }}</span></div>
						<div class="kpi-sub" :class="c.subTone">{{ c.sub }}</div>
					</div>
				</section>
				<div class="banner nur-note" v-if="nurQuiet">No campaign was created or sent in this period. Pick a longer date range, or <a :href="campaignUrl('#/new')" target="_blank" rel="noopener">create a campaign</a>.</div>

				<div class="grid two-one">
					<section class="panel">
						<header><div><h3>Messages sent by day</h3><div class="sub">{{ num(nurTotalSent) }} sent in this period</div></div><a class="btn small" :href="campaignUrl('')" target="_blank" rel="noopener"><ico name="external" /> Campaign Manager</a></header>
						<bar-chart :labels="nurDayLabels" :series="nurSeries" />
						<div class="legend"><span v-for="s in nurSeries" :key="s.name"><i :style="{ background: s.color }"></i>{{ s.name }}</span></div>
					</section>
					<section class="panel">
						<header><div><h3>Campaign status</h3><div class="sub">{{ num(nur.totals.campaigns) }} in this period</div></div></header>
						<div class="donut-row" v-if="statusDonut.length">
							<donut :items="statusDonut" centre="campaigns" />
							<ul class="key"><li v-for="o in statusDonut" :key="o.label"><i :style="{ background: o.color }"></i><span class="k">{{ o.label }}</span><b>{{ o.value }}</b></li></ul>
						</div>
						<div class="chart-empty" v-else>No campaigns in this period</div>
					</section>
				</div>

				<div class="grid two">
					<section class="panel">
						<header>
							<div><h3>Engagement funnel</h3><div class="sub">Sent, delivered, read and replied</div></div>
							<div class="seg"><button :class="{ on: funnelChannel === 'all' }" @click="funnelChannel = 'all'">All</button><button :class="{ on: funnelChannel === 'Email' }" @click="funnelChannel = 'Email'">Email</button><button :class="{ on: funnelChannel === 'WhatsApp' }" @click="funnelChannel = 'WhatsApp'">WhatsApp</button></div>
						</header>
						<div class="funnel">
							<div class="frow" v-for="(s, i) in nurFunnel" :key="s.stage">
								<div class="fhead"><span>{{ s.stage }}</span><span v-if="s.count !== null"><b>{{ num(s.count) }}</b><span class="sub" v-if="s.rate !== null"> · {{ s.rate }}% {{ s.of }}</span></span><span class="sub" v-else>{{ s.why }}</span></div>
								<div class="ftrack"><i :style="{ width: s.width + '%', opacity: 1 - i * 0.14 }"></i></div>
							</div>
						</div>
					</section>
					<section class="panel">
						<header><div><h3>Email vs WhatsApp</h3><div class="sub">What each channel delivered in this period</div></div></header>
						<div class="table-wrap">
							<table class="team plain nur-chan">
								<thead><tr><th class="l">Channel</th><th>Sent</th><th>Reached</th><th>Delivered</th><th>Read / opened</th><th>Replied</th><th>Failed</th></tr></thead>
								<tbody><tr v-for="r in chanRows" :key="r.name">
									<td class="l"><span class="who"><i class="dot" :style="{ background: r.color }"></i>{{ r.name }}</span></td>
									<td><b>{{ num(r.sent) }}</b><div class="mini"><i :style="{ width: (r.sent / chanMax) * 100 + '%', background: r.color }"></i></div></td>
									<td>{{ num(r.reached) }}</td>
									<td><template v-if="r.delivered !== null">{{ num(r.delivered) }} <span class="pill-rate" :class="nurRateTone(r.deliveredRate)">{{ r.deliveredRate === null ? '-' : r.deliveredRate + '%' }}</span></template><span class="sub" v-else>n/a</span></td>
									<td><template v-if="r.read !== null">{{ num(r.read) }} <span class="pill-rate" :class="nurRateTone(r.readRate)">{{ r.readRate === null ? '-' : r.readRate + '%' }}</span></template><span class="sub" v-else>n/a</span></td>
									<td>{{ num(r.replied) }} <span class="pill-rate" :class="nurRateTone(r.replyRate)">{{ r.replyRate === null ? '-' : r.replyRate + '%' }}</span></td>
									<td :class="{ late: r.failed }">{{ num(r.failed) }}</td>
								</tr></tbody>
							</table>
						</div>
						<div class="sub nur-foot">Delivery is reported for WhatsApp only. Email opens are shown when open tracking is on for the outgoing email account.</div>
					</section>
				</div>

				<div class="grid two-one">
					<section class="panel">
						<header><div><h3>Top campaigns</h3><div class="sub">Most messages sent in this period. Click one to open it in the Campaign Manager.</div></div></header>
						<div class="table-wrap" v-if="nur.top_campaigns.length">
							<table class="team plain nur-top">
								<thead><tr><th class="l">Campaign</th><th class="l">Status</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Replied</th><th>Failed</th></tr></thead>
								<tbody><tr v-for="c in nur.top_campaigns" :key="c.name">
									<td class="l"><a class="camp-link" :href="campaignUrl('#/c/' + encodeURIComponent(c.name))" target="_blank" rel="noopener">{{ c.campaign_name }}</a><div class="sub">{{ [c.email ? c.email + ' email' : '', c.whatsapp ? c.whatsapp + ' WhatsApp' : ''].filter(Boolean).join(' · ') }}</div></td>
									<td class="l"><span class="chip" :style="{ background: 'color-mix(in srgb, ' + ({ Running: '#2563eb', Queued: '#0891b2', Scheduled: '#7c3aed', Paused: '#f59e0b', Completed: '#16a34a', Draft: '#94a3b8', Cancelled: '#64748b', Failed: '#dc2626' }[c.status] || '#94a3b8') + ' 16%, transparent)' }">{{ c.status }}</span></td>
									<td><b>{{ num(c.sent) }}</b></td><td>{{ num(c.delivered) }}</td><td>{{ num(c.read) }}</td>
									<td>{{ num(c.replied) }} <span class="pill-rate" :class="nurRateTone(c.reply_rate)" v-if="c.reply_rate !== null">{{ c.reply_rate }}%</span></td>
									<td :class="{ late: c.failed }">{{ num(c.failed) }}</td>
								</tr></tbody>
							</table>
						</div>
						<div class="chart-empty" v-else>No messages were sent in this period</div>
					</section>
					<section class="panel">
						<header><div><h3>Leads nurtured</h3><div class="sub">Open leads that received a campaign message in this period</div></div></header>
						<div class="donut-row" v-if="nur.nurtured.open_leads">
							<donut :items="nurturedItems" centre="open leads" :size="150" />
							<ul class="key"><li v-for="o in nurturedItems" :key="o.label"><i :style="{ background: o.color }"></i><span class="k">{{ o.label }}</span><b>{{ num(o.value) }}</b><span class="sub">{{ pct1(o.value, nur.nurtured.open_leads) }}%</span></li></ul>
						</div>
						<div class="chart-empty" v-else>No open leads</div>
					</section>
				</div>
			</template>
		</template>
		<template v-else-if="!nurError">
			<section class="kpis"><div class="kpi skel" v-for="n in 7" :key="n"></div></section>
			<div class="grid two-one"><section class="panel skel tall"></section><section class="panel skel tall"></section></div>
		</template>
	</main>

	<main class="dash-body" v-else-if="data">
		<section class="kpis">
			<div class="kpi" v-for="c in cards" :key="c.label" :class="c.tone">
				<div class="kpi-label">{{ c.label }}</div>
				<div class="kpi-value">{{ c.value }}<span class="delta" v-if="c.delta" :class="c.delta.up ? 'up' : 'down'">{{ c.delta.up ? '▲' : '▼' }} {{ c.delta.text }}</span></div>
				<div class="kpi-sub" :class="c.subTone">{{ c.sub }}</div>
			</div>
		</section>

		<div class="grid two-one">
			<section class="panel">
				<header>
					<div><h3>Daily activity</h3><div class="sub">{{ num(chartTotal) }} in this period</div></div>
					<div class="ctl">
						<div class="seg"><button :class="{ on: metric === 'calls' }" @click="metric = 'calls'">Calls</button><button :class="{ on: metric === 'follow_ups' }" @click="metric = 'follow_ups'">Follow-ups</button><button :class="{ on: metric === 'leads' }" @click="metric = 'leads'">Leads added</button></div>
						<div class="seg" v-if="splitOptions.length > 1"><button v-for="o in splitOptions" :key="o[0]" :class="{ on: split === o[0] }" @click="split = o[0]">{{ o[1] }}</button></div>
					</div>
				</header>
				<bar-chart :labels="dayLabels" :series="seriesData" />
				<div class="legend"><span v-for="s in seriesData" :key="s.name"><i :style="{ background: s.color }"></i>{{ s.name }}</span></div>
			</section>
			<section class="panel">
				<header><div><h3>Call outcomes</h3><div class="sub">{{ num(outcomeTotal) }} calls</div></div></header>
				<div class="donut-row" v-if="outcomeTotal">
					<donut :items="outcomeItems" centre="calls" />
					<ul class="key"><li v-for="o in outcomeItems" :key="o.label"><i :style="{ background: o.color }"></i><span class="k">{{ o.label }}</span><b>{{ o.value }}</b><span class="sub">{{ pct(o.value, outcomeTotal) }}%</span></li></ul>
				</div>
				<div class="chart-empty" v-else>No calls in this period</div>
			</section>
		</div>

		<div class="grid two">
			<section class="panel">
				<header><div><h3>Lead funnel</h3><div class="sub">What became of the leads added in this period</div></div></header>
				<div class="funnel">
					<div class="frow" v-for="(s, i) in funnel" :key="s.stage">
						<div class="fhead"><span>{{ s.stage }}</span><span><b>{{ num(s.count) }}</b><span class="sub" v-if="i"> · {{ s.step }}% of the step before</span></span></div>
						<div class="ftrack"><i :style="{ width: s.width + '%', opacity: 1 - i * 0.14 }"></i></div>
					</div>
				</div>
			</section>
			<section class="panel">
				<header><div><h3>Calls by hour</h3><div class="sub" v-if="bestHour">Best time to call: <b>{{ bestHour.name }}</b> - {{ bestHour.rate }}% connected ({{ bestHour.calls }} calls)</div><div class="sub" v-else>Connected and not connected, by hour of the day</div></div></header>
				<bar-chart :labels="hourLabels" :series="hourSeries" :height="220" />
				<div class="legend"><span><i style="background:#16a34a"></i>Connected</span><span><i style="background:#f0776a"></i>Not connected</span></div>
			</section>
		</div>

		<template v-if="showTeam">
			<section class="panel">
				<header><div><h3>Team performance</h3><div class="sub">Click a column to sort</div></div></header>
				<div class="table-wrap">
					<table class="team">
						<thead><tr><th class="l">Person</th><th v-for="c in columns" :key="c[0]" :class="{ on: sort.key === c[0] }" @click="sortBy(c[0])">{{ c[1] }}<span v-if="sort.key === c[0]">{{ sort.dir < 0 ? ' ↓' : ' ↑' }}</span></th></tr></thead>
						<tbody>
							<tr v-for="p in people" :key="p.user">
								<td class="l"><span class="who"><avatar :name="p.full_name" />{{ p.full_name }}</span></td>
								<td class="bar-cell"><div class="mini"><i :style="{ width: (p.calls / maxCalls) * 100 + '%' }"></i></div><b>{{ p.calls }}</b></td>
								<td>{{ p.connected }}</td>
								<td><span class="pill-rate" :class="rateTone(p.connect_rate, p.calls)">{{ p.calls ? p.connect_rate + '%' : '-' }}</span></td>
								<td>{{ p.not_picked }}</td><td>{{ p.follow_ups }}</td><td>{{ p.leads }}</td><td>{{ p.meetings }}<span class="sub" v-if="p.held"> ({{ p.held }})</span></td><td>{{ p.converted }}</td>
								<td>{{ p.due_today }}</td><td :class="{ late: p.overdue }">{{ p.overdue }}</td>
							</tr>
						</tbody>
					</table>
				</div>
			</section>
			<section class="panel">
				<header><div><h3>Call outcomes by person</h3><div class="sub">How each person's calls ended</div></div></header>
				<div class="hbars" v-if="mixRows.length">
					<div class="hrow wide" v-for="r in mixRows" :key="r.name"><span class="hname">{{ r.name }}</span>
						<div class="htrack"><i v-for="p in r.parts" :key="p.key" :style="{ width: (p.n / mixMax) * 100 + '%', background: p.color }" :title="p.key + ': ' + p.n"></i></div>
						<b>{{ r.total }}</b></div>
					<div class="legend"><span v-for="(c, k) in OUTCOME_COLORS" :key="k"><i :style="{ background: c }"></i>{{ k }}</span></div>
				</div>
				<div class="chart-empty" v-else>No calls in this period</div>
			</section>
		</template>

		<div class="grid two">
			<section class="panel">
				<header><div><h3>Lead pipeline</h3><div class="sub">{{ num(statusTotal) }} open leads, by status</div></div></header>
				<div class="table-wrap" v-if="statusRows.length">
					<table class="team plain">
						<thead><tr><th class="l">Status</th><th>Leads</th><th class="l wide">Share</th><th>Avg age</th></tr></thead>
						<tbody><tr v-for="s in statusRows" :key="s.status">
							<td class="l"><span class="who"><i class="dot" :style="{ background: s.color }"></i>{{ s.status }}</span></td>
							<td><b>{{ s.count }}</b></td>
							<td class="l wide"><div class="mini long"><i :style="{ width: (s.count / statusMax) * 100 + '%', background: s.color }"></i></div></td>
							<td>{{ s.age }} d</td>
						</tr></tbody>
					</table>
				</div>
				<div class="chart-empty" v-else>No open leads</div>
			</section>
			<section class="panel">
				<header><div><h3>Leads by source</h3><div class="sub">Added in this period, and how many became deals</div></div></header>
				<div class="hbars" v-if="sourceRows.length">
					<div class="hrow" v-for="s in sourceRows" :key="s.source"><span class="hname">{{ s.source }}</span><div class="htrack"><i :style="{ width: (s.leads / sourceMax) * 100 + '%', background: '#2563eb' }"></i></div><b>{{ s.leads }}<span class="sub" v-if="s.converted"> · {{ s.converted }} won</span></b></div>
				</div>
				<div class="chart-empty" v-else>No leads added in this period</div>
			</section>
		</div>

		<div class="grid three">
			<section class="panel">
				<header><div><h3>Attempts to connect</h3><div class="sub">Which call reached the person</div></div></header>
				<bar-chart :labels="attemptLabels" :series="attemptSeries" :height="200" />
			</section>
			<section class="panel">
				<header><div><h3>Lead temperature</h3><div class="sub">From the lead score</div></div></header>
				<div class="donut-row" v-if="bandItems.some((b) => b.value)">
					<donut :items="bandItems" centre="leads" :size="140" />
					<ul class="key"><li v-for="b in bandItems" :key="b.label"><i :style="{ background: b.color }"></i><span class="k">{{ b.label }}</span><b>{{ b.value }}</b></li></ul>
				</div>
				<div class="chart-empty" v-else>No scored leads yet</div>
			</section>
			<section class="panel">
				<header><div><h3>Meetings by outcome</h3><div class="sub">{{ num(meetingTotal) }} in this period</div></div></header>
				<div class="donut-row" v-if="meetingTotal">
					<donut :items="meetingItems" centre="meetings" :size="140" />
					<ul class="key"><li v-for="m in meetingItems" :key="m.label"><i :style="{ background: m.color }"></i><span class="k">{{ m.label }}</span><b>{{ m.value }}</b></li></ul>
				</div>
				<div class="chart-empty" v-else>No meetings in this period</div>
			</section>
		</div>

		<div class="grid three">
			<section class="panel">
				<header><div><h3>Follow-up queue</h3><div class="sub">Overdue and due today</div></div></header>
				<div class="rows" v-if="data.queue.length">
					<a class="qrow" v-for="q in data.queue" :key="q.name" href="#" @click.prevent="open(q.url)">
						<span class="qdot" :class="q.bucket"></span>
						<span class="qmain"><b>{{ q.title }}</b><span class="sub" v-if="q.remark">{{ q.remark }}</span></span>
						<span class="qwhen" :class="q.bucket">{{ fmtWhen(q.due) }}</span>
					</a>
				</div>
				<div class="chart-empty" v-else>Nothing overdue or due today</div>
			</section>
			<section class="panel">
				<header><div><h3>Recent calls</h3><div class="sub">Latest in this period</div></div></header>
				<div class="rows" v-if="data.recent.length">
					<a class="qrow" v-for="r in data.recent" :key="r.name" href="#" @click.prevent="open(r.url)">
						<span class="qmain"><b>{{ r.title }}</b><span class="sub">{{ fmtWhen(r.when) }}<template v-if="everyone"> · {{ r.by }}</template></span></span>
						<span class="chip" :class="'t-' + outcomeTone(r.outcome)">{{ r.outcome }}</span>
					</a>
				</div>
				<div class="chart-empty" v-else>No calls in this period</div>
			</section>
			<section class="panel">
				<header><div><h3>Upcoming meetings</h3><div class="sub">Next 7 days</div></div></header>
				<div class="rows" v-if="data.upcoming_meetings.length">
					<a class="qrow" v-for="m in data.upcoming_meetings" :key="m.name" href="#" @click.prevent="open(m.url)">
						<span class="qmain"><b>{{ m.subject }}</b><span class="sub">{{ m.title }}<template v-if="everyone"> · {{ m.by }}</template></span></span>
						<span class="qwhen">{{ fmtWhen(m.when) }}</span>
					</a>
				</div>
				<div class="chart-empty" v-else>No meetings coming up</div>
			</section>
		</div>
	</main>

	<main class="dash-body" v-else-if="!fatal">
		<section class="kpis"><div class="kpi skel" v-for="n in 10" :key="n"></div></section>
		<div class="grid two-one"><section class="panel skel tall"></section><section class="panel skel tall"></section></div>
	</main>
</div>`,
	}

	createApp(App).mount('#app')
})()
