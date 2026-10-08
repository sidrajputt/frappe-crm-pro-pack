/* Campaign Manager: list clean-up. Addresses that failed for good (a bounce, a number that is not on WhatsApp) are taken
 * off the sending list automatically; this page shows them and lets a manager put one back. */
(() => {
	const { ref, reactive, watch, onMounted, onBeforeUnmount } = Vue
	const CM = window.CM
	const V = CM.views
	const SOURCES = [{ value: 'Bounce', label: 'Email bounced' }, { value: 'Invalid Number', label: 'Not on WhatsApp' }]
	const CHANNELS = [{ value: 'Email', label: 'Email', icon: 'mail' }, { value: 'WhatsApp', label: 'WhatsApp', icon: 'whatsapp' }]

	V.ListHealth = {
		setup() {
			const q = reactive({ search: '', channel: '', source: '' })
			const rows = ref([]); const total = ref(0); const counts = ref({}); const page = ref(0)
			const loading = ref(true); const error = ref(''); const scanning = ref(false)
			const PAGE = 25
			let seq = 0
			async function load() {
				const my = ++seq; loading.value = true; error.value = ''
				try {
					const r = await CM.apiLatest('suppressed', 'list_suppressed', { channel: q.channel, source: q.source, search: q.search, start: page.value * PAGE, page_length: PAGE })
					if (my === seq) { rows.value = r.rows; total.value = r.total; counts.value = r.counts || {} }
				} catch (e) { if (my === seq && !e.cancelled) error.value = e.message } finally { if (my === seq) loading.value = false }
			}
			const debounced = CM.debounce(() => { page.value = 0; load() }, 300)
			watch(() => q.search, debounced)
			watch(() => [q.channel, q.source], () => { page.value = 0; load() })
			watch(page, load)
			onMounted(load)
			onBeforeUnmount(() => debounced.cancel())
			async function scan() {
				scanning.value = true
				try { const r = await CM.api('scan_failed_addresses', { days: 90 }); CM.toast(r.added ? r.added + ' address' + (r.added > 1 ? 'es were' : ' was') + ' taken off the list' : 'Nothing new found in the last 90 days'); page.value = 0; await load() } catch (e) { CM.toast(e.message, 'err') } finally { scanning.value = false }
			}
			async function restore(r) {
				if (!(await CM.confirm({ title: 'Put this address back?', message: r.value + ' can receive campaigns again. If it still does not work it will be taken off again after the next failure.', confirmText: 'Put back' }))) return
				try { await CM.api('restore_suppressed', { name: r.name }); CM.toast('Put back on the sending list'); await load() } catch (e) { CM.toast(e.message, 'err') }
			}
			const why = (r) => (r.source === 'Bounce' ? 'Email bounced' : 'Not on WhatsApp')
			return { q, rows, total, counts, page, PAGE, loading, error, scanning, load, scan, restore, why, SOURCES, CHANNELS, CM, go: CM.go }
		},
		template: `
		<div class="page">
			<div class="pg-head"><div class="grow"><h1>List clean-up</h1><p>Emails that bounced and numbers that are not on WhatsApp are taken off the sending list automatically, so they are never tried again.</p></div><div class="actions"><Btn icon="refresh" :loading="scanning" @click="scan">Scan past failures</Btn></div></div>
			<div class="kpis two"><div class="kpi" style="--kc:var(--red)"><div class="l"><Ico name="mail" size="sm" />Emails removed</div><div class="v">{{ CM.num(counts.Email || 0) }}</div><div class="s">bounced or rejected</div></div><div class="kpi" style="--kc:var(--wa)"><div class="l"><Ico name="whatsapp" size="sm" />Numbers removed</div><div class="v">{{ CM.num(counts.WhatsApp || 0) }}</div><div class="s">not on WhatsApp</div></div></div>
			<div class="row wrap tool"><div style="width:260px;max-width:100%"><Inp v-model="q.search" icon="search" placeholder="Search an address or number" clearable aria-label="Search" /></div><div style="width:160px"><Dd v-model="q.channel" :options="CHANNELS" placeholder="All channels" allow-empty="All channels" size="sm" aria-label="Channel" /></div><div style="width:170px"><Dd v-model="q.source" :options="SOURCES" placeholder="All reasons" allow-empty="All reasons" size="sm" aria-label="Reason" /></div></div>
			<div class="card" style="overflow:hidden">
				<div v-if="loading && !rows.length" class="col" style="padding:16px"><Skel v-for="n in 5" :key="n" h="38" /></div>
				<ErrorState v-else-if="error" :message="error" @retry="load" />
				<Empty v-else-if="!rows.length" icon="shield" title="Nothing has been removed" :text="q.search || q.channel || q.source ? 'Nothing matches these filters.' : 'When an email bounces or a number is not on WhatsApp it appears here. Use Scan past failures to check earlier campaigns.'" />
				<div v-else class="table-wrap"><table class="tbl"><thead><tr><th>Address</th><th>Channel</th><th>Reason</th><th>Lead</th><th>Removed</th><th></th></tr></thead><tbody>
					<tr v-for="r in rows" :key="r.name"><td><b>{{ r.value }}</b><div v-if="r.reason" class="tiny faint ellipsis" style="max-width:340px" :title="r.reason">{{ r.reason }}</div></td><td><ChannelBadge :value="r.channel" /></td><td><span class="badge neutral nodot">{{ why(r) }}</span></td><td class="small"><a v-if="r.lead" :href="CM.leadUrl(r.lead)" target="_blank" rel="noopener" @click="CM.openCrm($event, CM.leadUrl(r.lead))">{{ r.lead_name }}</a><span v-else class="faint">-</span></td><td class="small muted">{{ CM.fmt(r.creation) }}</td><td style="text-align:right"><Btn size="sm" @click="restore(r)">Put back</Btn></td></tr></tbody></table></div>
				<div style="padding:4px 14px 10px"><Pager v-model:page="page" :size="PAGE" :total="total" /></div>
			</div>
		</div>`,
	}
})()
