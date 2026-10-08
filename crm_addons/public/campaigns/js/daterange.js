/* Campaign Manager: the one date-range picker (presets + calendar with range selection + From / To) shared by the
 * campaign list, the campaign page, the recipient report and Reports, plus the helpers that turn a chosen range into
 * the from_date / to_date arguments of the API. Days are always the *site's* days (CM.today()), never the browser's. */
(() => {
	const { ref, reactive, computed, watch, nextTick } = Vue
	const CM = window.CM
	const C = CM.components

	// ------------------------------------------------------------------ range maths (day strings 'YYYY-MM-DD')
	CM.parseDay = (s) => { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null }
	const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
	const dayDiff = (a, b) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5)

	CM.RANGE_PRESETS = [
		['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['week', 'This week'],
		['lastweek', 'Last week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year'],
	]
	function presetDates(key) {
		const today = CM.today()
		const monday = addDays(today, -((today.getDay() + 6) % 7))
		const y = today.getFullYear(), m = today.getMonth()
		switch (key) {
			case 'today': return [today, today]
			case 'yesterday': return [addDays(today, -1), addDays(today, -1)]
			case '30d': return [addDays(today, -29), today]
			case 'week': return [monday, today]
			case 'lastweek': return [addDays(monday, -7), addDays(monday, -1)]
			case 'month': return [new Date(y, m, 1), today]
			case 'lastmonth': return [new Date(y, m - 1, 1), new Date(y, m, 0)]
			case 'quarter': return [new Date(y, Math.floor(m / 3) * 3, 1), today]
			case 'year': return [new Date(y, 0, 1), today]
			default: return [addDays(today, -6), today] // 7d
		}
	}
	/** {from, to} day strings for a range value; both '' for "Any time". Presets are re-resolved against today every time. */
	CM.resolveRange = (r) => {
		if (!r || r.preset === 'any') return { from: '', to: '' }
		if (r.preset === 'custom') { const a = CM.parseDay(r.from), b = CM.parseDay(r.to || r.from); if (!a) return { from: '', to: '' }; return a <= b ? { from: CM.ymd(a), to: CM.ymd(b) } : { from: CM.ymd(b), to: CM.ymd(a) } }
		const [a, b] = presetDates(r.preset); return { from: CM.ymd(a), to: CM.ymd(b) }
	}
	/** The from_date / to_date arguments of the API ({} for "Any time"). Both ends are whole days, the end day included. */
	CM.rangeArgs = (r) => { const x = CM.resolveRange(r); const o = {}; if (x.from) o.from_date = x.from; if (x.to) o.to_date = x.to; return o }
	const short = (d, year) => d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) })
	/** "7 Sep - 6 Oct 2026" (one date for a single day); '' for any time. */
	CM.rangeText = (r) => {
		const x = CM.resolveRange(r); if (!x.from) return ''
		const a = CM.parseDay(x.from), b = CM.parseDay(x.to || x.from)
		if (x.from === x.to) return short(a, true)
		return a.getFullYear() === b.getFullYear() ? short(a) + ' - ' + short(b, true) : short(a, true) + ' - ' + short(b, true)
	}
	CM.rangeTitle = (r) => { if (!r || r.preset === 'any') return 'Any time'; const p = CM.RANGE_PRESETS.find((x) => x[0] === r.preset); return p ? p[1] : 'Custom range' }
	/** The period of the same length right before the range ({preset:'custom'}), or null for any time. */
	CM.prevRange = (r) => {
		const x = CM.resolveRange(r); if (!x.from || !x.to) return null
		const a = CM.parseDay(x.from), b = CM.parseDay(x.to); const n = dayDiff(a, b) + 1
		return { preset: 'custom', from: CM.ymd(addDays(a, -n)), to: CM.ymd(addDays(a, -1)) }
	}
	/** Last chosen range of a screen, from this browser's storage (understands the old "7" / "30" / "" values). */
	CM.loadRange = (key, fallback) => {
		const v = CM.store.json(key, null)
		const ok = (p) => p === 'any' || p === 'custom' || CM.RANGE_PRESETS.some((x) => x[0] === p)
		if (v && typeof v === 'object' && ok(v.preset) && (v.preset !== 'custom' || CM.parseDay(v.from))) return { preset: v.preset, from: v.from || '', to: v.to || '' }
		const legacy = { 7: '7d', 30: '30d' }
		if (typeof v === 'number' && legacy[v]) return { preset: legacy[v], from: '', to: '' }
		return { preset: fallback, from: '', to: '' }
	}
	CM.saveRange = (key, r) => CM.store.set(key, JSON.stringify({ preset: r.preset, from: r.from || '', to: r.to || '' }))
	/** A ref holding a screen's range that remembers itself in storage. */
	CM.useRange = (key, fallback) => {
		const r = ref(CM.loadRange(key, fallback))
		watch(r, (v) => CM.saveRange(key, v), { deep: true })
		return r
	}
	CM.pctChange = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null)

	// ------------------------------------------------------------------ the component
	const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
	C.DateRange = {
		props: { modelValue: Object, any: Boolean, size: { type: String, default: 'sm' }, align: { type: String, default: 'left' }, ariaLabel: { type: String, default: 'Date range' } },
		emits: ['update:modelValue', 'change'],
		setup(props, { emit }) {
			const btn = ref(null)
			const months = ref(2); const narrow = ref(false)
			const cursor = ref(CM.today())   // first day of the left month
			const focusDay = ref('')
			const hover = ref('')
			const draft = reactive({ from: '', to: '' })
			const W = () => (narrow.value ? Math.min(innerWidth - 16, 360) : months.value === 2 ? 700 : 450)
			const p = CM.usePop(() => btn.value, {
				layout(r) {
					narrow.value = innerWidth < 640; months.value = !narrow.value && innerWidth >= 840 ? 2 : 1
					const w = W(), h = narrow.value ? 470 : 400
					let left = props.align === 'right' ? r.right - w : r.left
					left = Math.max(8, Math.min(left, innerWidth - w - 8))
					const below = innerHeight - r.bottom - 14, above = r.top - 14
					const st = { left: left + 'px', width: w + 'px' }
					if (below >= h || below >= above) { st.top = r.bottom + 6 + 'px'; st.maxHeight = Math.max(220, below) + 'px' }
					else { st.bottom = innerHeight - r.top + 6 + 'px'; st.maxHeight = Math.max(220, above) + 'px' }
					return st
				},
				onClose: () => nextTick(() => btn.value && btn.value.focus()),
			})
			const cur = computed(() => CM.resolveRange(props.modelValue))
			const title = computed(() => CM.rangeTitle(props.modelValue))
			const sub = computed(() => (props.modelValue && props.modelValue.preset === 'custom' ? '' : CM.rangeText(props.modelValue)))
			const custom = computed(() => (props.modelValue && props.modelValue.preset === 'custom' ? CM.rangeText(props.modelValue) : ''))
			const presets = computed(() => (props.any ? [['any', 'Any time'], ...CM.RANGE_PRESETS] : CM.RANGE_PRESETS))

			function show() {
				draft.from = cur.value.from; draft.to = cur.value.to; hover.value = ''
				const anchor = CM.parseDay(cur.value.to) || CM.today()
				const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
				cursor.value = new Date(first.getFullYear(), first.getMonth() - (innerWidth >= 840 && innerWidth >= 640 ? 1 : 0), 1)
				focusDay.value = CM.ymd(CM.parseDay(cur.value.to) || CM.today())
				p.openIt()
				nextTick(() => { const el = p.pop.value && (p.pop.value.querySelector('.opt.on') || p.pop.value.querySelector('.opt')); if (el) el.focus() })
			}
			const toggle = () => (p.open.value ? p.close() : show())
			// Tab out of the picker closes it (the focus is never left behind an open popover)
			function leave(e) { const to = e.relatedTarget; if (to && p.pop.value && !p.pop.value.contains(to) && to !== btn.value) p.close() }
			function choose(key) {
				const r = key === 'any' ? { preset: 'any', from: '', to: '' } : { preset: key, ...CM.resolveRange({ preset: key }) }
				emit('update:modelValue', r); emit('change', r); p.close()
			}
			function apply() {
				if (!draft.from) return
				let a = draft.from, b = draft.to || draft.from
				if (b < a) [a, b] = [b, a]
				// a range that equals a preset is shown (and re-resolved tomorrow) as that preset
				const hit = CM.RANGE_PRESETS.find((x) => { const t = CM.resolveRange({ preset: x[0] }); return t.from === a && t.to === b })
				const r = hit ? { preset: hit[0], from: a, to: b } : { preset: 'custom', from: a, to: b }
				emit('update:modelValue', r); emit('change', r); p.close()
			}
			// calendar
			const monthDates = computed(() => Array.from({ length: months.value }, (_, i) => new Date(cursor.value.getFullYear(), cursor.value.getMonth() + i, 1)))
			function cells(first) {
				const lead = (first.getDay() + 6) % 7; const total = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
				return [...Array.from({ length: lead }, () => null), ...Array.from({ length: total }, (_, i) => { const d = new Date(first.getFullYear(), first.getMonth(), i + 1); return { d, s: CM.ymd(d), n: i + 1 } })]
			}
			const grids = computed(() => monthDates.value.map((m) => ({ key: CM.ymd(m), title: m.toLocaleDateString([], { month: 'long', year: 'numeric' }), cells: cells(m) })))
			const step = (n) => { cursor.value = new Date(cursor.value.getFullYear(), cursor.value.getMonth() + n, 1) }
			const bounds = computed(() => {
				const a = draft.from, b = draft.to || (hover.value && draft.from ? hover.value : '')
				return a && b ? (a <= b ? [a, b] : [b, a]) : [a, a]
			})
			const todayS = computed(() => CM.ymd(CM.today()))
			const dayCls = (s) => { const [lo, hi] = bounds.value; return { on: !!lo && (s === lo || s === hi), mid: s > lo && s < hi, today: s === todayS.value, start: s === lo && lo !== hi, end: s === hi && lo !== hi } }
			function pickDay(s) {
				focusDay.value = s
				if (!draft.from || draft.to) { draft.from = s; draft.to = '' } else if (s < draft.from) { draft.to = draft.from; draft.from = s } else draft.to = s
			}
			function moveFocus(n, months_) {
				const d = CM.parseDay(focusDay.value) || CM.today()
				const t = months_ ? new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate())) : addDays(d, n)
				focusDay.value = CM.ymd(t)
				const first = monthDates.value[0], last = monthDates.value[monthDates.value.length - 1]
				if (t < first) cursor.value = new Date(t.getFullYear(), t.getMonth(), 1)
				else if (t >= new Date(last.getFullYear(), last.getMonth() + 1, 1)) cursor.value = new Date(t.getFullYear(), t.getMonth() - (months.value - 1), 1)
				nextTick(() => { const el = p.pop.value && p.pop.value.querySelector(`[data-d="${focusDay.value}"]`); if (el) el.focus() })
			}
			function calKey(e) {
				const k = e.key; const map = { ArrowLeft: [-1], ArrowRight: [1], ArrowUp: [-7], ArrowDown: [7], PageUp: [-1, true], PageDown: [1, true] }
				if (map[k]) { e.preventDefault(); moveFocus(...map[k]) }
				else if (k === 'Home' || k === 'End') { e.preventDefault(); const d = CM.parseDay(focusDay.value) || CM.today(); moveFocus(k === 'Home' ? -((d.getDay() + 6) % 7) : 6 - ((d.getDay() + 6) % 7)) }
			}
			// the From / To boxes drive the calendar too
			watch(() => [draft.from, draft.to], ([f]) => { const d = CM.parseDay(f); if (d && p.open.value) { const first = monthDates.value[0], last = monthDates.value[monthDates.value.length - 1]; if (d < first || d >= new Date(last.getFullYear(), last.getMonth() + 1, 1)) cursor.value = new Date(d.getFullYear(), d.getMonth(), 1) } })
			const hint = computed(() => (draft.from && !draft.to ? 'Now pick the last day' : draft.from ? CM.rangeText({ preset: 'custom', from: draft.from, to: draft.to }) : 'Pick the first day'))
			return { btn, ...p, toggle, leave, choose, apply, presets, cur, title, sub, custom, months, narrow, grids, step, dayCls, pickDay, hover, draft, focusDay, calKey, DOW, hint, canApply: computed(() => !!draft.from) }
		},
		template: `
		<div class="dr">
			<button ref="btn" type="button" class="dd-btn dr-btn" :class="[size, { open }]" aria-haspopup="dialog" :aria-expanded="open" :aria-label="ariaLabel + ': ' + title + (sub ? ', ' + sub : custom ? ', ' + custom : '')" @click="toggle" @keydown.down.prevent="!open && toggle()">
				<Ico name="calendar" size="sm" class="dr-ico" />
				<span class="lab"><b>{{ title }}</b><span v-if="sub || custom" class="dr-sub">{{ sub || custom }}</span></span>
				<Ico name="chevron-down" size="sm" class="chev" />
			</button>
			<Teleport to="body">
				<div v-if="open" ref="pop" class="pop dr-pop" :class="{ narrow, two: months === 2 }" :style="style" role="dialog" aria-label="Choose a date range" @focusout="leave">
					<div class="dr-presets" role="group" aria-label="Quick ranges">
						<button v-for="p in presets" :key="p[0]" type="button" class="opt" :class="{ on: modelValue && modelValue.preset === p[0] }" @click="choose(p[0])">{{ p[1] }}</button>
					</div>
					<div class="dr-main">
						<div class="dr-cal" @keydown="calKey" @mouseleave="hover = ''">
							<div class="dr-months">
								<div v-for="(g, gi) in grids" :key="g.key" class="dr-month">
									<div class="dr-head"><button v-if="gi === 0" type="button" class="btn ghost icon sm" aria-label="Previous month" @click="step(-1)"><Ico name="chevron-left" /></button><span v-else class="dr-gap"></span><b aria-live="polite">{{ g.title }}</b><button v-if="gi === grids.length - 1" type="button" class="btn ghost icon sm" aria-label="Next month" @click="step(1)"><Ico name="chevron-right" /></button><span v-else class="dr-gap"></span></div>
									<div class="dr-grid dow" aria-hidden="true"><span v-for="d in DOW" :key="d">{{ d[0] }}</span></div>
									<div class="dr-grid" role="grid">
										<template v-for="(c, i) in g.cells" :key="i">
											<span v-if="!c"></span>
											<button v-else type="button" class="dr-day" :class="dayCls(c.s)" :data-d="c.s" :tabindex="c.s === focusDay ? 0 : -1" :aria-label="c.d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })" :aria-pressed="dayCls(c.s).on || dayCls(c.s).mid" @click="pickDay(c.s)" @mouseenter="hover = c.s">{{ c.n }}</button>
										</template>
									</div>
								</div>
							</div>
						</div>
						<div class="dr-foot">
							<div class="dr-inputs"><input class="inp" type="date" v-model="draft.from" aria-label="From date" /><span class="faint small">to</span><input class="inp" type="date" v-model="draft.to" :min="draft.from || undefined" aria-label="To date" /></div>
							<div class="dr-act"><span class="small faint dr-hint" role="status">{{ hint }}</span><button type="button" class="btn sm" @click="close()">Cancel</button><button type="button" class="btn sm primary" :disabled="!canApply" @click="apply">Apply</button></div>
						</div>
					</div>
				</div>
			</Teleport>
		</div>`,
	}
})()
