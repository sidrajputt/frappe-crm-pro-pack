/* Campaign Manager: campaign list (grid / list, search, filters, sort). */
(() => {
	const { ref, reactive, computed, watch, onMounted, onBeforeUnmount } = Vue
	const CM = window.CM
	const C = CM.components
	const V = CM.views

	const STATUS_CHIPS = [['', 'All'], ['Draft', 'Draft'], ['Scheduled', 'Scheduled'], ['Running', 'Running'], ['Paused', 'Paused'], ['Completed', 'Completed'], ['Failed', 'Failed'], ['Cancelled', 'Cancelled']]
	const SORTS = [{ value: 'modified', label: 'Recently updated' }, { value: 'created', label: 'Newest first' }, { value: 'name', label: 'Name A-Z' }, { value: 'recipients', label: 'Most recipients' }, { value: 'scheduled', label: 'Schedule date' }]
	const CHANNELS = [{ value: 'Email', label: 'Email', icon: 'mail' }, { value: 'WhatsApp', label: 'WhatsApp', icon: 'whatsapp' }, { value: 'Multi-channel', label: 'Multi-channel', icon: 'layers' }]

	/** Delivery numbers with a tiny progress bar. */
	C.CampStats = {
		props: { s: Object, status: String },
		computed: {
			parts() { const s = this.s; const rest = Math.max(0, s.recipients - s.skipped - s.sent - s.failed); return [{ label: 'Sent', value: Math.max(0, s.sent - s.opened) , color: 'var(--accent)' }, { label: 'Opened or read', value: s.opened, color: 'var(--green)' }, { label: 'Failed', value: s.failed, color: 'var(--red)' }, { label: 'Waiting', value: rest, color: 'var(--border-strong)' }, { label: 'Skipped', value: s.skipped, color: 'var(--amber)' }] },
		},
		methods: { num: CM.num },
		template: `
		<div class="cs">
			<div v-if="s.recipients" class="cs-n"><span><b>{{ num(s.sent) }}</b><i>Sent</i></span><span><b>{{ num(s.delivered) }}</b><i>Delivered</i></span><span><b>{{ num(s.opened) }}</b><i>Opened</i></span><span :class="{ bad: s.failed }"><b>{{ num(s.failed) }}</b><i>Failed</i></span></div>
			<div v-else class="small faint" style="padding:6px 0">{{ status === 'Draft' ? 'Not sent yet' : 'No recipients' }}</div>
			<MiniBar v-if="s.recipients" :parts="parts" />
		</div>`,
	}

	V.CampaignList = {
		setup() {
			const rows = ref([]); const total = ref(0); const loading = ref(true); const error = ref(''); const page = ref(0)
			const PAGE = 12
			const saved = CM.store.json('cm-list-prefs', {})
			const q = reactive({ search: '', status: '', channel: '', sort: saved.sort || 'modified' })
			const dateRange = CM.useRange('cm-list-range', 'any') // when the campaign was created
			const view = ref(saved.view || 'list')
			watch([view, () => q.sort], () => CM.store.set('cm-list-prefs', JSON.stringify({ view: view.value, sort: q.sort })))
			const filtered = computed(() => !!(q.search || q.status || q.channel || dateRange.value.preset !== 'any'))
			let seq = 0
			let busy = 0 // requests still running: the automatic refresh waits for them instead of piling on
			async function load(quiet) {
				const my = ++seq; busy++; if (!quiet) loading.value = true; error.value = ''
				try {
					await CM.loadShared() // the site's own "today" for the date range
					if (my !== seq) return
					const r = await CM.apiLatest('list-campaigns', 'list_campaigns', { search: q.search, status: q.status, channel: q.channel, sort: q.sort, ...CM.rangeArgs(dateRange.value), start: page.value * PAGE, page_length: PAGE })
					if (my !== seq) return
					rows.value = r.rows; total.value = r.total
				} catch (e) { if (my === seq) error.value = e.message } finally { busy = Math.max(0, busy - 1); if (my === seq) loading.value = false }
			}
			const debounced = CM.debounce(() => { page.value = 0; load() }, 300)
			watch(() => q.search, debounced)
			watch(() => [q.status, q.channel, q.sort, dateRange.value.preset, dateRange.value.from, dateRange.value.to], () => { page.value = 0; load() })
			watch(page, () => load())
			let timer
			onMounted(() => { CM.loadShared(); load(); timer = setInterval(() => { if (!document.hidden && !busy && rows.value.some((r) => ['Running', 'Queued'].includes(r.status))) load(true) }, 10000) })
			onBeforeUnmount(() => { clearInterval(timer); debounced.cancel() })
			function reset() { Object.assign(q, { search: '', status: '', channel: '' }); dateRange.value = { preset: 'any', from: '', to: '' } }
			const open = (c) => CM.go('/c/' + encodeURIComponent(c.name))
			async function dup(c) { try { const d = await CM.api('duplicate_campaign', { name: c.name }); CM.toast('Duplicated as a new draft'); CM.go('/campaigns/edit/' + encodeURIComponent(d.name)) } catch (e) { CM.toast(e.message, 'err') } }
			async function del(c) {
				if (!(await CM.confirm({ title: 'Delete "' + c.campaign_name + '"?', message: 'This permanently deletes the campaign. Messages already sent cannot be recalled.', confirmText: 'Delete campaign', danger: true }))) return
				try { await CM.api('delete_campaign', { name: c.name }); CM.toast('Campaign deleted'); load(true) } catch (e) { CM.toast(e.message, 'err') }
			}
			function menu(c) {
				const edit = ['Draft', 'Scheduled'].includes(c.status)
				return [edit ? { label: 'Edit', icon: 'edit', run: () => CM.go('/campaigns/edit/' + encodeURIComponent(c.name)) } : { label: 'Open', icon: 'eye', run: () => open(c) }, { label: 'Duplicate', icon: 'copy', run: () => dup(c) }, ['Draft', 'Cancelled'].includes(c.status) ? { sep: true } : null, ['Draft', 'Cancelled'].includes(c.status) ? { label: 'Delete', icon: 'trash', danger: true, run: () => del(c) } : null]
			}
			const when = (c) => (c.send_mode === 'Trigger' ? 'Automatic: ' + (c.trigger_event === 'Lead status changed' ? 'on status change' : 'on new lead') : c.status === 'Scheduled' && c.scheduled_at ? 'Sends ' + CM.fmt(c.scheduled_at) : !['Draft', 'Scheduled'].includes(c.status) && c.started_at ? 'Started ' + CM.fmt(c.started_at) : c.send_mode === 'Schedule' && c.scheduled_at ? 'Scheduled ' + CM.fmt(c.scheduled_at) : 'Not scheduled')
			return { rows, total, loading, error, page, PAGE, q, dateRange, view, filtered, load, reset, open, menu, when, STATUS_CHIPS, SORTS, CHANNELS, CM, go: CM.go }
		},
		template: `
		<div class="page">
			<div class="pg-head"><div class="grow"><h1>Campaigns</h1><p>Reach your leads on email and WhatsApp, and see exactly what was sent, delivered and opened.</p></div><div class="actions"><Btn variant="primary" icon="plus" @click="go('/campaigns/new')">Create campaign</Btn></div></div>
			<div class="row wrap tool">
				<div v-if="view !== 'calendar'" style="width:260px;max-width:100%"><Inp v-model="q.search" icon="search" placeholder="Search campaigns" clearable aria-label="Search campaigns" /></div>
				<div v-if="view !== 'calendar'" style="width:160px"><Dd v-model="q.channel" :options="CHANNELS" placeholder="All channels" allow-empty="All channels" size="sm" aria-label="Channel" /></div>
				<DateRange v-if="view !== 'calendar'" v-model="dateRange" any aria-label="Created" />
				<span class="grow"></span>
				<div v-if="view !== 'calendar'" style="width:190px"><Dd v-model="q.sort" :options="SORTS" size="sm" prefix="Sort:" aria-label="Sort" /></div>
				<Seg v-model="view" icons :options="[{ value: 'grid', label: 'Grid view', icon: 'grid' }, { value: 'list', label: 'List view', icon: 'rows' }, { value: 'calendar', label: 'Calendar', icon: 'calendar' }]" />
			</div>
			<div v-if="view !== 'calendar'" class="chips" role="group" aria-label="Status"><button v-for="s in STATUS_CHIPS" :key="s[0]" type="button" class="fchip" :class="{ on: q.status === s[0] }" @click="q.status = s[0]">{{ s[1] }}</button></div>

			<CampaignCalendar v-if="view === 'calendar'" />
			<template v-else-if="loading">
				<div v-if="view === 'grid'" class="cgrid"><div v-for="n in 6" :key="n" class="card pad col" style="gap:12px"><Skel w="60%" h="18" /><Skel w="40%" h="14" /><Skel h="46" /><Skel w="70%" h="12" /></div></div>
				<div v-else class="card pad col"><Skel v-for="n in 6" :key="n" h="44" /></div>
			</template>
			<ErrorState v-else-if="error" :message="error" @retry="load" />
			<Empty v-else-if="!rows.length && filtered" icon="search" title="No campaigns match" text="Try removing a filter or searching for something else."><Btn @click="reset">Clear filters</Btn></Empty>
			<Empty v-else-if="!rows.length" icon="send" title="Create your first campaign" text="Send a WhatsApp message or email to a group of leads, schedule it, and follow the results here."><Btn variant="primary" icon="plus" @click="go('/campaigns/new')">Create campaign</Btn></Empty>

			<div v-else-if="view === 'grid'" class="cgrid">
				<article v-for="c in rows" :key="c.name" class="ccard card hover" tabindex="0" @click="open(c)" @keydown.enter="open(c)">
					<div class="row" style="align-items:flex-start"><div class="grow" style="min-width:0"><div class="ccard-t" :title="c.campaign_name">{{ c.campaign_name }}</div><div class="small faint ellipsis">{{ c.audience }}</div></div><Ico v-if="c.health_note" name="alert" class="warn-ico" :title="'Needs attention: ' + c.health_note" /><StatusBadge :value="c.status" /><Menu :items="menu(c)" /></div>
					<ChannelBadges :channels="c.channels" />
					<CampStats :s="c.stats" :status="c.status" />
					<div class="ccard-f"><span class="ellipsis"><Ico name="calendar" size="sm" /> {{ when(c) }}</span><span class="ellipsis" style="text-align:right">{{ c.created_by }} - {{ CM.ago(c.modified) }}</span></div>
				</article>
			</div>
			<div v-else class="card" style="overflow:hidden"><div class="table-wrap"><table class="tbl clist"><thead><tr><th>Campaign</th><th>Channels</th><th>Status</th><th>Audience</th><th>Schedule</th><th style="min-width:230px">Delivery</th><th>Created by</th><th>Updated</th><th></th></tr></thead><tbody>
				<tr v-for="c in rows" :key="c.name" class="click" tabindex="0" @click="open(c)" @keydown.enter="open(c)"><td><b>{{ c.campaign_name }}</b><div class="tiny faint">{{ c.campaign_type }}</div></td><td><ChannelBadges :channels="c.channels" /></td><td><StatusBadge :value="c.status" /><Ico v-if="c.health_note" name="alert" class="warn-ico" :title="'Needs attention: ' + c.health_note" style="margin-left:6px" /></td><td class="small muted">{{ c.audience }}<div class="tiny faint">{{ CM.num(c.total_recipients) }} recipients</div></td><td class="small muted">{{ when(c) }}</td><td><CampStats :s="c.stats" :status="c.status" /></td><td class="small">{{ c.created_by }}</td><td class="small muted">{{ CM.ago(c.modified) }}</td><td @click.stop><Menu :items="menu(c)" /></td></tr></tbody></table></div></div>
			<Pager v-if="view !== 'calendar'" v-model:page="page" :size="PAGE" :total="total" />
		</div>`,
	}
})()
