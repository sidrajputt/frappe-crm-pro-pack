/* Campaign Manager: campaign detail (KPIs, funnel, timeline, journey, recipients) and the Reports section. */
(() => {
	const { ref, reactive, computed, watch, onMounted, onBeforeUnmount } = Vue
	const CM = window.CM
	const C = CM.components
	const V = CM.views
	const sum = (an, key, chans) => Object.entries(an.channels || {}).filter(([c]) => !chans || chans.includes(c)).reduce((a, [, ms]) => a + ((ms.find((m) => m.key === key) || {}).value || 0), 0)
	const REC_STATUS = ['Pending', 'Queued', 'Sending', 'Sent', 'Delivered', 'Read', 'Failed', 'Skipped', 'Cancelled']
	const COND = { 'Previous step was sent': 'previous was sent', 'Previous step was read or opened': 'previous was read or opened', 'Previous step was not read or opened': 'previous was not read', 'Previous step failed or was skipped': 'previous failed or skipped' }

	V.CampaignDetail = {
		props: { name: String },
		setup(props) {
			const c = ref(null); const an = ref(null); const loading = ref(true); const error = ref(''); const busy = ref('')
			const tab = ref('overview'); const saveTpl = reactive({ open: false, name: '', desc: '' })
			let timer
			const range = CM.useRange('cm-detail-range', 'any') // limits the numbers, charts and recipient report to these days
			const anBusy = ref(false)
			let aseq = 0
			async function loadAn() {
				const my = ++aseq; anBusy.value = true
				try { await CM.loadShared(); const r = await CM.apiLatest('analytics', 'get_analytics', { name: props.name, ...CM.rangeArgs(range.value) }); if (my === aseq) an.value = r } finally { if (my === aseq) anBusy.value = false }
			}
			async function load(quiet) {
				if (!quiet) loading.value = true
				try { c.value = await CM.api('get_campaign', { name: props.name }); await loadAn(); error.value = '' } catch (e) { if (!e.cancelled && (!quiet || !c.value)) error.value = e.message } finally { loading.value = false }
			}
			// the automatic refresh skips its turn while the last one is still running, so a slow server is never buried in requests
			let polling = false
			onMounted(() => { CM.loadShared(); load(); timer = setInterval(async () => { if (polling || document.hidden || !c.value || !['Running', 'Queued'].includes(c.value.status)) return; polling = true; try { await load(true) } finally { polling = false } }, 8000) })
			onBeforeUnmount(() => clearInterval(timer))
			watch(() => props.name, () => { tab.value = 'overview'; load() })
			const can = (a) => c.value && c.value.allowed_actions.includes(a)
			async function act(kind, opts) {
				if (opts && opts.confirm && !(await CM.confirm(opts.confirm))) return
				busy.value = kind
				try { await CM.api(kind, { name: props.name }); CM.toast(opts.done); await load(true) } catch (e) { CM.toast(e.message, 'err') } finally { busy.value = '' }
			}
			const pause = () => act('pause', { done: 'Campaign paused', confirm: null })
			const resume = () => act('resume', { done: 'Campaign resumed' })
			const cancel = () => act('cancel', { done: 'Campaign cancelled', confirm: { title: 'Cancel this campaign?', message: 'Messages that have not been sent yet will be cancelled. Messages already sent cannot be recalled.', confirmText: 'Cancel campaign', danger: true } })
			const retry = () => act('retry_failed', { done: 'Failed messages were queued again', confirm: { title: 'Retry failed messages?', message: 'Only messages that never reached the provider are sent again. Nobody receives the same message twice.', confirmText: 'Retry failed' } })
			async function dup() { try { const d = await CM.api('duplicate_campaign', { name: props.name }); CM.toast('Duplicated as a new draft'); CM.go('/campaigns/edit/' + encodeURIComponent(d.name)) } catch (e) { CM.toast(e.message, 'err') } }
			async function del() {
				if (!(await CM.confirm({ title: 'Delete this campaign?', message: 'This permanently deletes the campaign and its report.', confirmText: 'Delete campaign', danger: true }))) return
				try { await CM.api('delete_campaign', { name: props.name }); CM.toast('Campaign deleted'); CM.go('/campaigns') } catch (e) { CM.toast(e.message, 'err') }
			}
			async function saveAsTemplate() {
				if (!saveTpl.name.trim()) return CM.toast('Give the template a name.', 'warn')
				try { await CM.api('save_as_template', { name: props.name, template_name: saveTpl.name, description: saveTpl.desc }); saveTpl.open = false; CM.toast('Saved as a campaign template') } catch (e) { CM.toast(e.message, 'err') }
			}
			const menu = computed(() => !c.value ? [] : [can('duplicate') && { label: 'Duplicate', icon: 'copy', run: dup }, CM.shared.config && CM.shared.config.is_manager && { label: 'Save as template', icon: 'bookmark', run: () => Object.assign(saveTpl, { open: true, name: c.value.campaign_name + ' template', desc: '' }) }, can('delete') && { sep: true }, can('delete') && { label: 'Delete', icon: 'trash', danger: true, run: del }].filter(Boolean))

			// ---- numbers (only what the integrations really report)
			const chans = computed(() => (c.value ? c.value.channels : []))
			const k = computed(() => {
				if (!an.value) return []
				const a = an.value; const rec = sum(a, 'total'); const sent = sum(a, 'sent'); const failed = sum(a, 'failed'); const skipped = sum(a, 'skipped')
				const hasWa = chans.value.includes('WhatsApp'); const hasMail = chans.value.includes('Email')
				const opened = sum(a, 'read', ['WhatsApp']) + sum(a, 'opened', ['Email']); const showOpen = hasWa || (hasMail && a.notes.email_open_tracking)
				const replied = (a.replied.Email || 0) + (a.replied.WhatsApp || 0)
				const out = [
					{ l: 'Recipients', v: rec, s: sum(a, 'eligible') + ' eligible', i: 'users', c: 'var(--text-faint)' },
					{ l: 'Sent', v: sent, s: CM.pctText(sent, sum(a, 'eligible')) + ' of eligible', i: 'send', c: 'var(--accent)' },
				]
				if (hasWa) out.push({ l: 'Delivered', v: sum(a, 'delivered'), s: CM.pctText(sum(a, 'delivered'), sent) + ' of sent (WhatsApp)', i: 'check-circle', c: 'var(--green)' })
				if (showOpen) out.push({ l: hasWa && hasMail ? 'Opened / read' : hasWa ? 'Read' : 'Opened', v: opened, s: CM.pctText(opened, sent) + ' of sent', i: 'eye', c: 'var(--green)' })
				if (hasMail && a.clicks && (a.clicks.people || c.value.track_clicks)) out.push({ l: 'Clicked a link', v: a.clicks.people, s: CM.pctText(a.clicks.people, sum(a, 'sent', ['Email'])) + ' of emails sent', i: 'zap', c: 'var(--accent)' })
				out.push({ l: 'Replied', v: replied, s: CM.pctText(replied, sent) + ' reply rate', i: 'inbox', c: 'var(--purple)' })
				out.push({ l: 'Failed', v: failed, s: CM.pctText(failed, rec) + ' of recipients', i: 'alert', c: failed ? 'var(--red)' : 'var(--text-faint)', bad: failed > 0 })
				if (skipped) out.push({ l: 'Skipped', v: skipped, s: 'Not eligible at send time', i: 'ban', c: 'var(--amber)' })
				return out
			})
			const funnels = computed(() => {
				if (!an.value) return []
				return chans.value.filter((ch) => an.value.channels[ch]).map((ch) => {
					const g = (key) => (an.value.channels[ch].find((m) => m.key === key) || {}).value || 0
					const steps = [{ label: 'Recipients', value: g('total'), color: 'var(--border-strong)' }, { label: 'Eligible', value: g('eligible'), color: 'var(--text-faint)' }, { label: 'Sent', value: g('sent'), color: 'var(--accent)' }]
					if (ch === 'WhatsApp') steps.push({ label: 'Delivered', value: g('delivered'), color: 'var(--green)' }, { label: 'Read', value: g('read'), color: 'var(--wa)' })
					else if (an.value.notes.email_open_tracking) steps.push({ label: 'Opened', value: g('opened'), color: 'var(--green)' })
					return { ch, steps, metrics: an.value.channels[ch] }
				})
			})
			const reasons = (list) => (list || []).map((r) => ({ label: `${r.channel}: ${r.reason || 'No reason recorded'}`, value: r.n }))
			const days = computed(() => (an.value ? an.value.timeline : []))
			const deliveryParts = computed(() => {
				const g = (l) => (k.value.find((x) => x.l === l) || { v: 0 }).v
				const rec = g('Recipients'), sent = g('Sent'), failed = g('Failed'), skipped = g('Skipped')
				return [{ label: 'Sent', value: sent, color: 'var(--accent)' }, { label: 'Failed', value: failed, color: 'var(--red)' }, { label: 'Skipped', value: skipped, color: 'var(--amber)' }, { label: 'Waiting', value: Math.max(0, rec - sent - failed - skipped), color: 'var(--border-strong)' }]
			})
			const mode = computed(() => c.value && { Draft: 'draft', Scheduled: 'scheduled' }[c.value.status])
			// a step can be paused and resumed on its own while the campaign is scheduled, running or paused
			const canStep = computed(() => c.value && ['Scheduled', 'Queued', 'Running', 'Paused'].includes(c.value.status) && (can('cancel') || can('pause') || can('resume')))
			const stepBusy = ref(0)
			async function toggleStep(s) {
				stepBusy.value = s.step
				try { await CM.api('set_step_paused', { name: props.name, step_idx: s.step, paused: s.paused ? 0 : 1 }); CM.toast(s.paused ? 'Step ' + s.step + ' resumed' : 'Step ' + s.step + ' paused. Its messages wait until you resume it.'); await load(true) } catch (e) { CM.toast(e.message, 'err') } finally { stepBusy.value = 0 }
			}
			const triggerText = computed(() => (!c.value || c.value.send_mode !== 'Trigger' ? '' : c.value.trigger_event === 'Lead status changed' ? 'when a lead\'s status changes' + (c.value.trigger_status ? ' to ' + c.value.trigger_status : '') : 'when a new lead is created'))
			const hoursText = computed(() => (!c.value || !c.value.window_enabled ? 'Any time' : String(c.value.window_start || '').slice(0, 5).replace(/^(\d):/, '0$1:') + ' to ' + String(c.value.window_end || '').slice(0, 5).replace(/^(\d):/, '0$1:') + (c.value.window_weekdays_only ? ', Monday to Friday' : '') + ' (' + c.value.timezone + ')'))
			const res = computed(() => (an.value && an.value.results) || null)
			const money = (v) => (v == null ? '-' : (res.value && res.value.currency ? res.value.currency.symbol + ' ' : '') + Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }))

			// ---- recipients report
			const rec = reactive({ rows: [], total: 0, page: 0, channel: '', status: '', search: '', loading: false, error: '' })
			let rseq = 0
			async function loadRec() {
				const my = ++rseq; rec.loading = true; rec.error = ''
				try { await CM.loadShared(); const r = await CM.apiLatest('recipients', 'list_recipients', { name: props.name, channel: rec.channel, status: rec.status, search: rec.search, ...CM.rangeArgs(range.value), start: rec.page * 25, page_length: 25 }); if (my === rseq) { rec.rows = r.rows; rec.total = r.total } } catch (e) { if (my === rseq) rec.error = e.message } finally { if (my === rseq) rec.loading = false }
			}
			const recDebounced = CM.debounce(() => { rec.page = 0; loadRec() }, 300)
			watch(() => rec.search, recDebounced)
			watch(() => [rec.channel, rec.status], () => { rec.page = 0; loadRec() })
			watch(() => [range.value.preset, range.value.from, range.value.to], () => { rec.page = 0; loadAn().catch((e) => { if (!e.cancelled) CM.toast(e.message, 'err') }); if (tab.value === 'recipients' || rec.rows.length) loadRec() })
			watch(() => rec.page, loadRec)
			watch(tab, (t) => { if (t === 'recipients' && !rec.rows.length && !rec.loading) loadRec() })
			const exporting = ref(false)
			async function exportCsv() {
				exporting.value = true
				try {
					const all = []; let start = 0
					for (;;) { const r = await CM.api('list_recipients', { name: props.name, channel: rec.channel, status: rec.status, search: rec.search, ...CM.rangeArgs(range.value), start, page_length: 200 }); all.push(...r.rows); start += 200; if (start >= r.total || start >= 50000) break }
					CM.csv([['Lead', 'Name', 'Channel', 'Step', 'Status', 'Email', 'WhatsApp number', 'Sent at', 'Delivered at', 'Read / opened at', 'Failed at', 'Reason'], ...all.map((r) => [r.recipient_id, r.recipient_name, r.channel, r.step_idx, r.status, r.email, r.whatsapp_number, r.sent_at, r.delivered_at, r.read_at, r.failed_at, r.skip_reason || r.failure_reason])], (c.value.campaign_name || 'campaign').replace(/[^\w-]+/g, '-') + '-recipients.csv')
					CM.toast(`Exported ${all.length} rows`)
				} catch (e) { CM.toast(e.message, 'err') } finally { exporting.value = false }
			}
			async function optOut(r) {
				if (!(await CM.confirm({ title: 'Opt this address out?', message: `${r.email || r.whatsapp_number} will not receive any future campaign on ${r.channel}.`, confirmText: 'Opt out', danger: true }))) return
				try { await CM.api('opt_out_recipient', { recipient: r.name }); CM.toast('Added to the opt-out list') } catch (e) { CM.toast(e.message, 'err') }
			}
			const recMenu = (r) => (CM.shared.config && CM.shared.config.is_manager ? [{ label: 'Open lead', icon: 'external', run: () => CM.openCrm(null, CM.leadUrl(r.recipient_id)) }, { label: 'Opt out this address', icon: 'ban', danger: true, run: () => optOut(r) }] : [{ label: 'Open lead', icon: 'external', run: () => CM.openCrm(null, CM.leadUrl(r.recipient_id)) }])
			return { canStep, stepBusy, toggleStep, triggerText, hoursText, res, money, range, anBusy, rangeText: computed(() => CM.rangeText(range.value)), deliveryParts, c, an, loading, error, busy, tab, saveTpl, can, load, pause, resume, cancel, retry, dup, saveAsTemplate, menu, chans, k, funnels, reasons, days, rec, loadRec, exportCsv, exporting, recMenu, REC_STATUS, COND, CM, mode, go: CM.go, open: (n) => CM.go(n), editUrl: () => CM.go('/campaigns/edit/' + encodeURIComponent(props.name)) }
		},
		template: `
		<div class="page">
			<button class="back" @click="go('/campaigns')"><Ico name="arrow-left" size="sm" /> All campaigns</button>
			<template v-if="loading"><div class="row"><Skel w="320" h="30" /></div><div class="kpis"><Skel v-for="n in 5" :key="n" h="104" r="12" /></div><Skel h="260" r="12" /></template>
			<ErrorState v-else-if="error" :message="error" @retry="load" />
			<template v-else-if="c">
				<div class="pg-head">
					<div class="grow">
						<div class="row wrap" style="gap:10px"><h1>{{ c.campaign_name }}</h1><StatusBadge :value="c.status" /></div>
						<div class="row wrap small muted" style="gap:14px;margin-top:6px"><ChannelBadges :channels="c.channels" :multi="false" /><span><Ico name="users" size="sm" /> {{ c.audience_label }}</span><span v-if="c.send_mode === 'Trigger'"><Ico name="refresh" size="sm" /> Automatic: {{ triggerText }}</span><span v-if="c.scheduled_at && c.send_mode === 'Schedule'"><Ico name="calendar" size="sm" /> {{ c.status === 'Scheduled' ? 'Sends' : 'Scheduled for' }} {{ CM.fmt(c.scheduled_at) }}</span><span v-else-if="c.started_at"><Ico name="clock" size="sm" /> Started {{ CM.fmt(c.started_at) }}</span><span><Ico name="user" size="sm" /> {{ c.owner_name }}</span></div>
					</div>
					<div class="actions">
						<Btn v-if="can('launch')" variant="primary" icon="send" @click="go('/campaigns/edit/' + encodeURIComponent(name) + '?step=5')">Review and launch</Btn>
						<Btn v-if="can('edit')" icon="edit" @click="editUrl">Edit</Btn>
						<Btn v-if="can('pause')" icon="pause" :loading="busy === 'pause'" @click="pause">Pause</Btn>
						<Btn v-if="can('resume')" variant="primary" icon="play" :loading="busy === 'resume'" @click="resume">Resume</Btn>
						<Btn v-if="can('retry') && an && an.channels && k.some((x) => x.l === 'Failed' && x.v)" icon="retry" :loading="busy === 'retry_failed'" @click="retry">Retry failed</Btn>
						<Btn v-if="can('cancel')" variant="danger" icon="ban" :loading="busy === 'cancel'" @click="cancel">Cancel</Btn>
						<Menu v-if="menu.length" :items="menu"><Btn aria-label="More actions" icon="more" /></Menu>
					</div>
				</div>
				<div v-if="c.health_note && ['Running', 'Paused'].includes(c.status)" class="alert err" role="alert"><Ico name="alert" /><div class="grow"><b>Needs attention.</b> {{ c.health_note }}</div></div>
				<div v-if="c.window_enabled && !c.window_open_now && c.status === 'Running'" class="alert"><Ico name="clock" /><div class="grow">Outside the sending hours ({{ hoursText }}). Sending carries on {{ c.window_next_open ? CM.fmt(c.window_next_open) : 'when the hours open' }}.</div></div>
				<div v-if="c.status_note" class="alert warn"><Ico name="info" /><div class="grow">{{ c.status_note }}</div></div>
				<div v-if="c.status === 'Draft'" class="alert"><Ico name="info" /><div class="grow">This campaign is a draft. Nothing has been sent. <a href="#" @click.prevent="go('/campaigns/edit/' + encodeURIComponent(name) + '?step=5')">Review and launch</a> when you are ready.</div></div>
				<div class="row wrap tabs-row"><Tabs class="grow" v-model="tab" :items="[{ key: 'overview', label: 'Overview', icon: 'chart' }, { key: 'recipients', label: 'Recipients', icon: 'users', count: CM.num(c.total_recipients) }, { key: 'content', label: 'Journey and content', icon: 'layers' }]" /><template v-if="tab !== 'content'"><span v-if="anBusy" class="spin" style="width:14px;height:14px" role="status" aria-label="Updating"></span><DateRange v-model="range" any align="right" aria-label="Report dates" /></template></div>
					<p v-if="tab !== 'content' && range.preset !== 'any'" class="rng-note">Showing messages from <b>{{ rangeText }}</b> only. Choose <b>Any time</b> to see the whole campaign.</p>

				<template v-if="tab === 'overview'">
					<div v-if="!an || !Object.keys(an.channels).length" class="card"><Empty icon="chart" :title="range.preset !== 'any' && c.status !== 'Draft' ? 'No messages in this period' : 'No results yet'" :text="range.preset !== 'any' && c.status !== 'Draft' ? 'Nothing was sent, failed or queued in ' + rangeText + '. Choose Any time to see the whole campaign.' : c.status === 'Draft' ? 'Results appear here after the campaign is launched.' : 'The recipient list is being prepared. This page refreshes by itself.'" /></div>
					<template v-else>
						<div class="kpis"><div v-for="x in k" :key="x.l" class="kpi" :class="{ bad: x.bad }" :style="{ '--kc': x.c }"><div class="l"><Ico :name="x.i" size="sm" />{{ x.l }}</div><div class="v">{{ CM.num(x.v) }}</div><div class="s">{{ x.s }}</div></div></div>
						<div class="grid two-one">
							<div class="card pad"><div class="card-h"><div class="grow"><h3>Messages sent per day</h3><p>Counted by the day each message left.</p></div><div class="legend"><span><i style="background:var(--accent)"></i>Sent</span><span><i style="background:var(--green)"></i>Read / opened</span><span><i style="background:var(--red)"></i>Failed</span></div></div>
								<DayChart v-if="days.length" :days="days" :series="[{ key: 'sent', label: 'Sent', color: 'var(--accent)' }, { key: 'read', label: 'Read or opened', color: 'var(--green)' }, { key: 'failed', label: 'Failed', color: 'var(--red)' }]" />
								<div v-else class="chart-empty">Nothing has been sent yet.</div></div>
							<div class="card pad"><div class="card-h"><div class="grow"><h3>Delivery</h3><p>Where every recipient ended up.</p></div></div><div class="donut-row"><Donut :parts="deliveryParts" :center="CM.num(k[0].v)" sub="recipients" /><ul class="key"><li v-for="p in deliveryParts" :key="p.label"><i :style="{ background: p.color }"></i><span class="k">{{ p.label }}</span><b>{{ CM.num(p.value) }}</b></li></ul></div></div>
						</div>
						<div class="grid" :class="funnels.length > 1 ? 'two' : ''"><div v-for="f in funnels" :key="f.ch" class="card pad"><div class="card-h"><ChannelBadge :value="f.ch" /><div class="grow"><h3 style="margin-left:2px">{{ f.ch }} funnel</h3></div></div><Funnel :steps="f.steps" /><p v-if="f.ch === 'Email'" class="small faint" style="margin:12px 0 0">{{ (an.notes.email_open_tracking ? 'Opens are reported by the email provider and can be under-counted. ' : 'Delivery and opens are not reported by this site\\'s mail setup, so they are not shown. ') + 'Clicks are counted from the links in the email; some mail scanners open links, which can add a few.' }}</p></div></div>
						<div v-if="an.clicks && an.clicks.links.length || res" class="grid" :class="an.clicks && an.clicks.links.length && res ? 'two' : ''">
							<div v-if="an.clicks && an.clicks.links.length" class="card pad"><div class="card-h"><div class="grow"><h3>Most clicked links</h3><p>{{ CM.num(an.clicks.clicks) }} clicks from {{ CM.num(an.clicks.people) }} people.</p></div></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Link</th><th class="num">Clicks</th><th class="num">People</th></tr></thead><tbody><tr v-for="l in an.clicks.links" :key="l.url"><td class="small" style="max-width:360px"><a :href="l.url" target="_blank" rel="noopener noreferrer" class="ellipsis" style="display:block">{{ l.url }}</a></td><td class="num">{{ CM.num(l.clicks) }}</td><td class="num">{{ CM.num(l.people) }}</td></tr></tbody></table></div></div>
							<div v-if="res" class="card pad"><div class="card-h"><div class="grow"><h3>Cost and results</h3><p>What the messages cost and what came from the leads they reached.</p></div></div>
								<dl class="dl"><dt>Leads reached</dt><dd>{{ CM.num(res.reached) }}</dd><dt>Cost</dt><dd><template v-if="res.prices_set">{{ money(res.cost) }}<span v-if="res.cost_per_lead != null" class="muted small"> ({{ money(res.cost_per_lead) }} per lead reached)</span></template><span v-else class="muted">Set message prices in CRM Addons Settings to see the cost.</span></dd><dt>Deals created since</dt><dd>{{ CM.num(res.deals) }}</dd><dt>Deals won</dt><dd>{{ CM.num(res.won) }}<span v-if="res.cost_per_deal != null" class="muted small"> ({{ money(res.cost_per_deal) }} per won deal)</span></dd><dt>Revenue won</dt><dd>{{ money(res.revenue) }}</dd><dt v-if="res.roi_percent != null">Return on spend</dt><dd v-if="res.roi_percent != null"><b :style="{ color: res.roi_percent >= 0 ? 'var(--green)' : 'var(--red)' }">{{ res.roi_percent }}%</b></dd></dl>
								<p class="small faint" style="margin:10px 0 0">Deals count when they were created, from a lead this campaign reached, after it started. Other things that helped are not measured.</p></div>
						</div>
						<div v-if="an.failure_reasons.length || an.skip_reasons.length" class="grid two"><div v-if="an.failure_reasons.length" class="card pad"><div class="card-h"><div class="grow"><h3>Why messages failed</h3><p>Most common reasons first.</p></div></div><HBars :rows="reasons(an.failure_reasons)" color="var(--red)" /></div><div v-if="an.skip_reasons.length" class="card pad"><div class="card-h"><div class="grow"><h3>Why leads were skipped</h3><p>Not sent, by design.</p></div></div><HBars :rows="reasons(an.skip_reasons)" color="var(--amber)" /></div></div>
					</template>
				</template>

				<template v-else-if="tab === 'recipients'">
					<div class="row wrap tool"><div style="width:280px;max-width:100%"><Inp v-model="rec.search" icon="search" placeholder="Search name, email or number" clearable aria-label="Search recipients" /></div><div style="width:150px"><Dd v-model="rec.channel" :options="chans" placeholder="All channels" allow-empty="All channels" size="sm" /></div><div style="width:150px"><Dd v-model="rec.status" :options="REC_STATUS" placeholder="All statuses" allow-empty="All statuses" size="sm" /></div><span class="grow"></span><Btn icon="download" :loading="exporting" @click="exportCsv">Export CSV</Btn></div>
					<div class="card" style="overflow:hidden">
						<div v-if="rec.loading && !rec.rows.length" class="pad col" style="padding:16px"><Skel v-for="n in 6" :key="n" h="38" /></div>
						<ErrorState v-else-if="rec.error" :message="rec.error" @retry="loadRec" />
						<Empty v-else-if="!rec.rows.length" icon="users" title="No recipients" :text="rec.search || rec.status || rec.channel ? 'Nothing matches these filters.' : 'The recipient list appears after the campaign is launched.'" />
						<div v-else class="table-wrap"><table class="tbl"><thead><tr><th>Lead</th><th>Channel</th><th>Step</th><th>Status</th><th>Address</th><th>Sent</th><th>Read / opened</th><th>Reason</th><th></th></tr></thead><tbody>
							<tr v-for="r in rec.rows" :key="r.name"><td><a :href="CM.leadUrl(r.recipient_id)" target="_blank" rel="noopener" @click="CM.openCrm($event, CM.leadUrl(r.recipient_id))">{{ r.recipient_name || r.recipient_id }}</a></td><td><ChannelBadge :value="r.channel" /></td><td class="small muted">{{ r.step_idx }}</td><td><StatusBadge :value="r.status" /></td><td class="small">{{ r.email || r.whatsapp_number || '-' }}</td><td class="small muted">{{ r.sent_at ? CM.fmt(r.sent_at) : '-' }}</td><td class="small muted">{{ r.read_at ? CM.fmt(r.read_at) : '-' }}</td><td class="small" style="max-width:260px"><span v-if="r.failure_reason" style="color:var(--red)">{{ r.failure_reason }}</span><span v-else-if="r.skip_reason" class="muted">{{ r.skip_reason }}</span><span v-else-if="r.due_at && r.status === 'Pending'" class="muted">Due {{ CM.fmt(r.due_at) }}</span></td><td><Menu :items="recMenu(r)" /></td></tr></tbody></table></div>
						<div style="padding:4px 14px 10px"><Pager v-model:page="rec.page" :size="25" :total="rec.total" /></div>
					</div>
				</template>

				<template v-else>
					<div v-if="an && an.steps.length" class="card" style="overflow:hidden"><div class="card-h" style="margin:0;padding:16px 18px 6px"><div class="grow"><h3>Journey</h3><p>Each step, when it runs and how it went.</p></div></div><div class="table-wrap"><table class="tbl"><thead><tr><th>Step</th><th>Channel</th><th>Runs on</th><th>Only if</th><th>Template</th><th class="num">Recipients</th><th class="num">Sent</th><th class="num">Read / opened</th><th class="num">Failed</th><th class="num">Skipped</th><th class="num">Waiting</th><th v-if="canStep"></th></tr></thead><tbody>
						<tr v-for="s in an.steps" :key="s.step" :class="{ 'is-paused': s.paused }"><td><b>{{ s.step }}</b> <span v-if="s.paused" class="badge neutral nodot">Paused</span></td><td><ChannelBadge :value="s.channel" /></td><td>{{ s.day ? 'Day ' + s.day : 'Right away' }}</td><td class="small muted">{{ COND[s.condition] || 'Always' }}</td><td class="small">{{ s.template }}</td><td class="num">{{ CM.num(s.recipients) }}</td><td class="num">{{ CM.num(s.sent) }}</td><td class="num">{{ CM.num(s.read) }}</td><td class="num" :style="s.failed ? 'color:var(--red)' : ''">{{ CM.num(s.failed) }}</td><td class="num">{{ CM.num(s.skipped) }}</td><td class="num">{{ CM.num(s.later) }}</td><td v-if="canStep" style="text-align:right"><Btn size="sm" :icon="s.paused ? 'play' : 'pause'" :loading="stepBusy === s.step" @click="toggleStep(s)">{{ s.paused ? 'Resume step' : 'Pause step' }}</Btn></td></tr></tbody></table></div></div>
					<div class="card pad"><div class="card-h"><div class="grow"><h3>Settings</h3></div></div><dl class="dl"><dt>Audience</dt><dd>{{ c.audience_label }}</dd><dt>Type</dt><dd>{{ c.campaign_type }}</dd><dt>Stop for leads who reply</dt><dd>{{ c.stop_on_reply ? 'Yes' : 'No' }}</dd><dt>Schedule</dt><dd>{{ c.send_mode === 'Trigger' ? 'Automatic, ' + triggerText : c.send_mode === 'Schedule' ? CM.fmt(c.scheduled_at) + ' (' + c.timezone + ')' : 'Sent right after launch' }}</dd><dt>Sending hours</dt><dd>{{ hoursText }}</dd><dt v-if="chans.includes('Email')">Link click tracking</dt><dd v-if="chans.includes('Email')">{{ c.track_clicks ? 'On' : 'Off' }}</dd><dt v-if="c.rules && c.rules.length">Lead updates</dt><dd v-if="c.rules && c.rules.length"><div v-for="r in c.rules" :key="r.name" class="small">When a lead {{ r.event.toLowerCase() }}: {{ r.action.toLowerCase() }}<template v-if="r.value"> ({{ r.value }})</template></div></dd><dt v-if="c.description">Description</dt><dd v-if="c.description">{{ c.description }}</dd><dt v-if="c.tags">Tags</dt><dd v-if="c.tags">{{ c.tags }}</dd></dl></div>
				</template>

				<Modal v-if="saveTpl.open" size="sm" title="Save as a campaign template" subtitle="Keeps the audience settings, channels, steps and content so you can start new campaigns from it." @close="saveTpl.open = false" @submit="saveAsTemplate">
					<Field label="Template name" required><input class="inp" v-model="saveTpl.name" autofocus /></Field><Field label="Description"><textarea class="inp" v-model="saveTpl.desc" rows="2"></textarea></Field>
					<template #foot><Btn @click="saveTpl.open = false">Cancel</Btn><Btn variant="primary" @click="saveAsTemplate">Save template</Btn></template>
				</Modal>
			</template>
		</div>`,
	}

	// ------------------------------------------------------------------ Reports
	V.Reports = {
		setup() {
			const data = ref(null); const prev = ref(null); const loading = ref(true); const busy = ref(false); const error = ref('')
			const range = CM.useRange('cm-report-range', '30d')
			const compare = ref(CM.store.get('cm-report-compare') !== '0')
			const sort = reactive({ key: 'sent', dir: -1 })
			let seq = 0
			// Every number, chart and table on the page comes from these two requests (the range and, if asked, the period before it)
			async function load() {
				const my = ++seq; busy.value = true; error.value = ''
				try {
					await CM.loadShared()
					const before = compare.value ? CM.prevRange(range.value) : null
					const [d, p] = await Promise.all([CM.analyticsLatest('overview', 'get_overview', CM.rangeArgs(range.value)), before ? CM.analyticsLatest('overview-prev', 'get_overview', CM.rangeArgs(before)) : null])
					if (my !== seq) return
					data.value = d; prev.value = p
				} catch (e) { if (my === seq) error.value = e.message } finally { if (my === seq) { loading.value = false; busy.value = false } }
			}
			onMounted(() => { CM.loadShared(); load() })
			watch(() => [range.value.preset, range.value.from, range.value.to, compare.value], () => { CM.store.set('cm-report-compare', compare.value ? '1' : '0'); load() })
			const rangeText = computed(() => CM.rangeText(range.value))
			const prevText = computed(() => (compare.value && prev.value ? CM.rangeText(CM.prevRange(range.value)) : ''))
			const t = computed(() => (data.value ? data.value.totals : null))
			// change against the period before: green when it is better (up for most, down for failures and opt-outs)
			const delta = (key, lowerIsBetter) => {
				if (!prev.value) return null
				const cur = t.value[key], was = prev.value.totals[key]
				if (!cur && !was) return { text: 'no change', cls: 'flat', arrow: '', tip: 'Previous period: 0' }
				const ch = CM.pctChange(cur, was)
				const up = cur > was
				const text = ch === null ? 'new' : (ch === 0 ? 'no change' : Math.abs(ch).toLocaleString() + '%')
				const cls = cur === was ? 'flat' : up !== !!lowerIsBetter ? 'good' : 'bad'
				return { text, cls, arrow: cur === was ? '' : up ? 'arrow-up' : 'arrow-down', tip: 'Previous period: ' + CM.num(was) }
			}
			const kpis = computed(() => {
				if (!t.value) return []; const x = t.value
				return [
					{ l: 'Campaigns', v: x.campaigns, d: delta('campaigns'), s: Object.entries(data.value.status_counts).map(([k, v]) => v + ' ' + k.toLowerCase()).slice(0, 3).join(', ') || ' ', i: 'send', c: 'var(--text-faint)' },
					{ l: 'Messages sent', v: x.sent, d: delta('sent'), s: CM.num(x.recipients) + ' recipients', i: 'zap', c: 'var(--accent)' },
					{ l: 'Delivered', v: x.delivered, d: delta('delivered'), s: CM.pctText(x.delivered, data.value.by_channel.WhatsApp.sent) + ' of WhatsApp sent', i: 'check-circle', c: 'var(--green)' },
					{ l: 'Opened / read', v: x.read_or_opened, d: delta('read_or_opened'), s: CM.pctText(x.read_or_opened, x.sent) + ' of sent', i: 'eye', c: 'var(--green)' },
					{ l: 'Replied', v: x.replied, d: delta('replied'), s: CM.pctText(x.replied, x.sent) + ' reply rate', i: 'inbox', c: 'var(--purple)' },
					{ l: 'Failed', v: x.failed, d: delta('failed', true), s: CM.pctText(x.failed, x.recipients) + ' of recipients', i: 'alert', c: x.failed ? 'var(--red)' : 'var(--text-faint)', bad: x.failed > 0 },
					{ l: 'Opted out', v: x.opted_out, d: delta('opted_out', true), s: 'Unsubscribes and STOP replies', i: 'ban', c: 'var(--amber)' },
				]
			})
			const rows = computed(() => (data.value ? [...data.value.all_campaigns].sort((a, b) => ((a[sort.key] ?? 0) > (b[sort.key] ?? 0) ? 1 : -1) * sort.dir * (typeof a[sort.key] === 'string' ? -1 : 1)) : []))
			const setSort = (k) => { sort.dir = sort.key === k ? -sort.dir : -1; sort.key = k }
			const exportCsv = () => CM.csv([['Period', rangeText.value || 'Any time'], [], ['Campaign', 'Channel', 'Status', 'Recipients', 'Sent', 'Delivered', 'Read or opened', 'Failed', 'Replied', 'Delivery %', 'Read %', 'Reply %', 'Cost'], ...rows.value.map((r) => [r.title, r.channel, r.status, r.recipients, r.sent, r.delivered, r.read, r.failed, r.replied, r.delivery_rate, r.read_rate, r.reply_rate, r.cost == null ? '' : r.cost])], 'campaign-report' + (rangeText.value ? '-' + CM.resolveRange(range.value).from + '-to-' + CM.resolveRange(range.value).to : '') + '.csv')
			const statusParts = computed(() => (data.value ? Object.entries(data.value.status_counts).map(([k, v]) => ({ label: k, value: v, color: { Completed: 'var(--green)', Running: 'var(--accent)', Draft: 'var(--border-strong)', Scheduled: 'var(--amber)', Paused: 'var(--amber)', Failed: 'var(--red)', Cancelled: 'var(--text-faint)', Queued: 'var(--accent)' }[k] || 'var(--text-faint)' })) : []))
			const rate = (v) => (v ? v + '%' : '-')
			const hasCost = computed(() => !!(data.value && data.value.totals && data.value.totals.cost != null))
			return { hasCost, data, loading, busy, error, range, compare, rangeText, prevText, t, kpis, rows, sort, setSort, load, exportCsv, statusParts, rate, CM, go: CM.go }
		},
		template: `
		<div class="page">
			<div class="pg-head"><div class="grow"><h1>Reports</h1><p>How your campaigns perform across email and WhatsApp. Only numbers that email and WhatsApp really report are shown.</p></div><div class="actions"><button v-if="range.preset !== 'any'" type="button" class="fchip" :class="{ on: compare }" :aria-pressed="compare" @click="compare = !compare"><Ico name="refresh" size="sm" />Compare to previous period</button><DateRange v-model="range" any align="right" size="" aria-label="Report dates" /><Btn icon="download" :disabled="!rows.length" @click="exportCsv">Export CSV</Btn></div></div>
				<p class="rng-note" role="status"><template v-if="rangeText">Showing <b>{{ rangeText }}</b><template v-if="prevText"> compared with <b>{{ prevText }}</b></template><template v-else-if="range.preset !== 'any' && compare && loading"> ...</template></template><template v-else>Showing <b>all time</b></template><span v-if="busy && !loading" class="spin" style="width:12px;height:12px;margin-left:8px" aria-label="Updating"></span></p>
			<template v-if="loading"><div class="kpis"><Skel v-for="n in 6" :key="n" h="104" r="12" /></div><Skel h="280" r="12" /></template>
			<ErrorState v-else-if="error" :message="error" @retry="load" />
			<Empty v-else-if="!t.campaigns && !t.sent" icon="chart" title="No campaign results in this period" text="Launch a campaign, or choose a longer date range."><Btn variant="primary" icon="plus" @click="go('/campaigns/new')">Create campaign</Btn></Empty>
			<template v-else>
				<div class="rep" :class="{ busy }">
				<div class="kpis"><div v-for="x in kpis" :key="x.l" class="kpi" :class="{ bad: x.bad }" :style="{ '--kc': x.c }"><div class="l"><Ico :name="x.i" size="sm" />{{ x.l }}</div><div class="v">{{ CM.num(x.v) }}<span v-if="x.d" class="d" :class="x.d.cls" :title="x.d.tip"><Ico v-if="x.d.arrow" :name="x.d.arrow" /> {{ x.d.text }}</span></div><div class="s">{{ x.s }}</div></div></div>
				<div class="grid two-one">
					<div class="card pad"><div class="card-h"><div class="grow"><h3>Messages per day</h3><p>Sent, read or opened, and failed.</p></div><div class="legend"><span><i style="background:var(--accent)"></i>Sent</span><span><i style="background:var(--green)"></i>Read / opened</span><span><i style="background:var(--red)"></i>Failed</span></div></div><DayChart v-if="data.by_day.length" :days="data.by_day" :series="[{ key: 'sent', label: 'Sent', color: 'var(--accent)' }, { key: 'read', label: 'Read or opened', color: 'var(--green)' }, { key: 'failed', label: 'Failed', color: 'var(--red)' }]" /><div v-else class="chart-empty">No messages were sent in this period.</div></div>
					<div class="card pad"><div class="card-h"><div class="grow"><h3>Campaigns by status</h3></div></div><div class="donut-row"><Donut :parts="statusParts" :center="CM.num(statusParts.reduce((a, p) => a + p.value, 0))" sub="campaigns" /><ul class="key"><li v-for="p in statusParts" :key="p.label"><i :style="{ background: p.color }"></i><span class="k">{{ p.label }}</span><b>{{ p.value }}</b></li></ul></div></div>
				</div>
				<div class="grid two">
					<div v-for="ch in ['Email', 'WhatsApp']" :key="ch" class="card pad"><div class="card-h"><ChannelBadge :value="ch" /><div class="grow"><h3 style="margin-left:2px">{{ ch }}</h3></div></div>
						<Funnel :steps="[{ label: 'Recipients', value: data.by_channel[ch].recipients, color: 'var(--border-strong)' }, { label: 'Sent', value: data.by_channel[ch].sent, color: 'var(--accent)' }, ...(ch === 'WhatsApp' ? [{ label: 'Delivered', value: data.by_channel[ch].delivered, color: 'var(--green)' }] : []), { label: ch === 'WhatsApp' ? 'Read' : 'Opened', value: data.by_channel[ch].read_or_opened, color: 'var(--green)' }, { label: 'Replied', value: data.by_channel[ch].replied, color: 'var(--purple)' }]" />
						<p v-if="ch === 'Email'" class="small faint" style="margin:12px 0 0">Email delivery is not reported by the mail system. Opens need open tracking on the email account.</p></div>
				</div>
				<div class="card" style="overflow:hidden"><div class="card-h" style="margin:0;padding:16px 18px 6px"><div class="grow"><h3>Compare campaigns</h3><p>Click a column to sort. Click a row for its full report.</p></div></div>
					<div class="table-wrap"><table class="tbl"><thead><tr><th class="sort" :class="{ on: sort.key === 'title' }" @click="setSort('title')">Campaign</th><th>Channel</th><th>Status</th><th v-for="c in [['recipients', 'Recipients'], ['sent', 'Sent'], ['delivery_rate', 'Delivered %'], ['read_rate', 'Read / opened %'], ['reply_rate', 'Reply %'], ['failed', 'Failed']].concat(hasCost ? [['cost', 'Cost']] : [])" :key="c[0]" class="num sort" :class="{ on: sort.key === c[0] }" @click="setSort(c[0])">{{ c[1] }}<Ico v-if="sort.key === c[0]" :name="sort.dir < 0 ? 'chevron-down' : 'chevron-up'" size="sm" /></th></tr></thead><tbody>
						<tr v-for="r in rows" :key="r.name" class="click" tabindex="0" @click="go('/c/' + encodeURIComponent(r.name))" @keydown.enter="go('/c/' + encodeURIComponent(r.name))"><td><b>{{ r.title }}</b></td><td><ChannelBadge :value="r.channel" /></td><td><StatusBadge :value="r.status" /></td><td class="num">{{ CM.num(r.recipients) }}</td><td class="num">{{ CM.num(r.sent) }}</td><td class="num">{{ rate(r.delivery_rate) }}</td><td class="num">{{ rate(r.read_rate) }}</td><td class="num">{{ rate(r.reply_rate) }}</td><td class="num" :style="r.failed ? 'color:var(--red)' : ''">{{ CM.num(r.failed) }}</td><td v-if="hasCost" class="num">{{ r.cost == null ? '-' : CM.num(r.cost) }}</td></tr></tbody></table></div></div>
				</div>
			</template>
		</div>`,
	}
})()
