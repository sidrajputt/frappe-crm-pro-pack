/* Campaign Manager: the campaign calendar. One month at a time; shows when each campaign starts, runs and sends its
 * follow-up steps, and marks the days on which more than one campaign sends. */
(() => {
	const { ref, reactive, computed, watch, onMounted } = Vue
	const CM = window.CM
	const C = CM.components

	const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
	const MAX_PER_DAY = 3
	const first = (d) => new Date(d.getFullYear(), d.getMonth(), 1)
	const mondayOnOrBefore = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x }
	const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x }
	const TONE = { Draft: 'neutral', Scheduled: 'amber', Queued: 'blue', Running: 'blue', Paused: 'amber', Completed: 'green', Cancelled: 'neutral', Failed: 'red' }

	C.CampaignCalendar = {
		setup() {
			const month = ref(first(new Date()))
			const data = ref(null); const loading = ref(true); const error = ref('')
			const grid = computed(() => { const start = mondayOnOrBefore(first(month.value)); return Array.from({ length: 42 }, (_, i) => addDays(start, i)) })
			let seq = 0
			async function load() {
				const my = ++seq; loading.value = true; error.value = ''
				try {
					await CM.loadShared()
					const r = await CM.apiLatest('calendar', 'get_calendar', { from_date: CM.ymd(grid.value[0]), to_date: CM.ymd(grid.value[41]) })
					if (my === seq) data.value = r
				} catch (e) { if (my === seq && !e.cancelled) error.value = e.message } finally { if (my === seq) loading.value = false }
			}
			onMounted(load)
			watch(month, load)
			const today = computed(() => (data.value && data.value.today) || CM.ymd(new Date()))
			const cells = computed(() => {
				const events = (data.value && data.value.events) || []
				return grid.value.map((d) => {
					const key = CM.ymd(d); const items = []; const sending = new Set()
					events.forEach((ev) => {
						const isStart = key === ev.first; const isStep = ev.step_days.includes(key)
						if (isStart || isStep) sending.add(ev.name)
						if (key < ev.first || key > ev.last) return
						items.push({ ev, kind: isStart ? 'start' : isStep ? 'step' : key === ev.last && !ev.automatic ? 'end' : 'span', key })
					})
					items.sort((a, b) => ({ start: 0, step: 1, end: 2, span: 3 }[a.kind] - { start: 0, step: 1, end: 2, span: 3 }[b.kind]))
					return { key, day: d.getDate(), inMonth: d.getMonth() === month.value.getMonth(), today: key === today.value, items, busy: sending.size > 1, sending: sending.size }
				})
			})
			const title = computed(() => month.value.toLocaleDateString([], { month: 'long', year: 'numeric' }))
			const move = (n) => { month.value = new Date(month.value.getFullYear(), month.value.getMonth() + n, 1) }
			const label = (it) => ({ start: it.ev.status === 'Draft' || it.ev.status === 'Scheduled' ? 'Starts' : 'Started', step: 'Follow-up', end: 'Ends', span: it.ev.automatic ? 'Automatic' : 'Running' }[it.kind])
			const busyDays = computed(() => cells.value.filter((c) => c.busy && c.inMonth).length)
			return { month, data, loading, error, cells, title, move, today: () => { month.value = first(new Date()) }, label, MAX_PER_DAY, DAY_NAMES, TONE, busyDays, load, go: CM.go, open: (n) => CM.go('/c/' + encodeURIComponent(n)) }
		},
		template: `
		<div class="cal card">
			<div class="cal-bar row wrap">
				<h2 class="cal-title">{{ title }}</h2><span v-if="loading" class="spin" style="width:14px;height:14px" role="status" aria-label="Loading"></span>
				<span class="grow"></span>
				<span v-if="busyDays" class="small" style="color:var(--amber)"><Ico name="alert" size="sm" /> {{ busyDays }} busy day{{ busyDays > 1 ? 's' : '' }} this month</span>
				<Btn size="sm" @click="today">Today</Btn><Btn size="sm" icon="chevron-left" aria-label="Previous month" @click="move(-1)" /><Btn size="sm" icon="chevron-right" aria-label="Next month" @click="move(1)" />
			</div>
			<ErrorState v-if="error" :message="error" @retry="load" />
			<template v-else>
				<div class="cal-grid cal-head"><div v-for="d in DAY_NAMES" :key="d">{{ d }}</div></div>
				<div class="cal-grid" :aria-busy="loading">
					<div v-for="c in cells" :key="c.key" class="cal-cell" :class="{ out: !c.inMonth, today: c.today, busy: c.busy }">
						<div class="cal-d"><span>{{ c.day }}</span><Ico v-if="c.busy" name="alert" size="sm" class="cal-warn" :title="c.sending + ' campaigns send on this day'" /></div>
						<button v-for="it in c.items.slice(0, MAX_PER_DAY)" :key="it.ev.name + it.kind" type="button" class="cal-pill" :class="['t-' + (TONE[it.ev.status] || 'neutral'), 'k-' + it.kind]" :title="it.ev.title + ' - ' + label(it) + (it.ev.warning ? ' (needs attention)' : '')" @click="open(it.ev.name)"><Ico v-if="it.ev.warning" name="alert" size="sm" /><span class="ellipsis">{{ it.kind === 'span' ? '' : label(it) + ': ' }}{{ it.ev.title }}</span></button>
						<div v-if="c.items.length > MAX_PER_DAY" class="tiny faint">+{{ c.items.length - MAX_PER_DAY }} more</div>
					</div>
				</div>
				<div class="cal-key small muted"><span><i class="t-amber"></i>Scheduled</span><span><i class="t-blue"></i>Running</span><span><i class="t-green"></i>Completed</span><span><i class="t-neutral"></i>Draft or cancelled</span><span><Ico name="alert" size="sm" style="color:var(--amber)" /> More than one campaign sends that day</span></div>
				<div v-if="data && !data.events.length && !loading" class="small faint" style="padding:14px 18px">No campaigns are planned or running in this period.</div>
			</template>
		</div>`,
	}
})()
