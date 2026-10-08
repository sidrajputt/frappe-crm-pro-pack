/* Campaign Manager: WhatsApp Templates section. Templates are created and approved in Meta and synced by the
 * frappe_whatsapp app; this page only reads them (and asks frappe_whatsapp to sync). */
(() => {
	const { ref, reactive, computed, onMounted } = Vue
	const CM = window.CM
	const C = CM.components
	const V = CM.views

	const STATUSES = [['', 'All'], ['APPROVED', 'Approved'], ['PENDING', 'Pending'], ['REJECTED', 'Rejected'], ['DISABLED', 'Disabled']]
	const CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION', 'TRANSACTIONAL', 'OTP']
	const catLabel = (c) => (c ? c.charAt(0) + c.slice(1).toLowerCase() : '')
	const stateTone = (s) => CM.STATUS_TONE[s] || 'neutral'
	const stateLabel = (s) => (s === 'NOT SYNCED' ? 'Not synced' : s.charAt(0) + s.slice(1).toLowerCase())
	CM.waState = { tone: stateTone, label: stateLabel, catLabel }

	/** Shared bubble for a template row (list drawer, wizard content, preview). */
	C.WaTemplateBubble = {
		props: { t: Object, values: [Array, Object], compact: Boolean, mediaUrl: String },
		setup(props) {
			const vals = computed(() => props.values || props.t.samples || [])
			return { vals }
		},
		template: `<WaBubble :header="t.header" :header-type="t.header_type" :body="t.template || t.body" :footer="t.footer" :buttons="t.buttons || []" :values="vals" :compact="compact" :media-url="mediaUrl" />`,
	}

	V.WhatsAppTemplates = {
		setup() {
			const data = ref(null); const loading = ref(true); const error = ref(''); const syncing = ref(false)
			const q = reactive({ search: '', category: '', status: '' }); const detail = ref(null)
			async function load(quiet) { if (!quiet) loading.value = true; error.value = ''; try { data.value = await CM.api('list_whatsapp_templates', {}) } catch (e) { error.value = e.message } finally { loading.value = false } }
			onMounted(() => { CM.loadShared(); load() })
			const rows = computed(() => (data.value ? data.value.rows : []))
			const shown = computed(() => {
				const term = q.search.trim().toLowerCase()
				const rank = { APPROVED: 0, PENDING: 1, REJECTED: 2, PAUSED: 3, DISABLED: 3 }
				return rows.value.slice().sort((x, y) => (rank[x.state] ?? 4) - (rank[y.state] ?? 4) || x.template_name.localeCompare(y.template_name)).filter((r) => (!q.category || r.category === q.category) && (!q.status || r.state === q.status || (q.status === 'DISABLED' && ['PAUSED', 'DISABLED'].includes(r.state))) && (!term || `${r.template_name} ${r.template}`.toLowerCase().includes(term)))
			})
			const count = (s) => (s ? rows.value.filter((r) => r.state === s || (s === 'DISABLED' && r.state === 'PAUSED')).length : rows.value.length)
			async function sync() {
				syncing.value = true
				try { const r = await CM.api('sync_whatsapp_templates', {}); CM.toast(r.message || 'Templates synced'); await load(true) } catch (e) { CM.toast(e.message, 'err', 9000) } finally { syncing.value = false }
			}
			async function refresh() { await load(true); CM.toast('List refreshed') }
			const use = (t) => { if (!t.approved) return CM.toast('Only templates approved by Meta can be used in a campaign.', 'warn'); CM.go('/campaigns/new?wa=' + encodeURIComponent(t.name)) }
			const cats = computed(() => CATEGORIES.filter((c) => rows.value.some((r) => r.category === c)).map((c) => ({ value: c, label: catLabel(c) })))
			return { data, loading, error, syncing, q, shown, rows, count, sync, refresh, detail, use, load, STATUSES, cats, stateTone, stateLabel, catLabel, CM }
		},
		template: `
		<div class="page">
			<div class="pg-head"><div class="grow"><h1>WhatsApp templates</h1><p>Message templates approved by Meta for WhatsApp Business. Pick one when you build a campaign.</p></div>
				<div class="actions"><Btn icon="refresh" :loading="loading && !!data" @click="refresh">Refresh</Btn><Btn v-if="data && data.can_sync" variant="primary" icon="download" :loading="syncing" @click="sync">{{ syncing ? 'Syncing' : 'Sync from Meta' }}</Btn></div></div>
			<div class="alert"><Ico name="info" /><div class="grow"><b>Create and get templates approved in Meta; they appear here after sync.</b> <span class="muted" style="color:inherit;opacity:.85">New templates start as Pending and can be used once Meta approves them.</span> <a href="https://business.facebook.com/wa/manage/message-templates/" target="_blank" rel="noopener">Open WhatsApp Manager <Ico name="external" size="sm" /></a></div></div>
			<div v-if="data && !data.can_sync" class="small faint">Only managers can sync from Meta. Use Refresh to reload this list.</div>
			<div v-if="data && !data.installed"><Empty icon="whatsapp" title="WhatsApp is not set up" text="The frappe_whatsapp app is not installed on this site, so there are no WhatsApp templates. Email campaigns work without it." /></div>
			<template v-else>
				<div class="row wrap tool">
					<div style="width:300px;max-width:100%"><Inp v-model="q.search" icon="search" placeholder="Search templates" clearable aria-label="Search templates" /></div>
					<div style="width:180px"><Dd v-model="q.category" :options="cats" placeholder="All categories" allow-empty="All categories" size="sm" /></div>
					<div class="chips"><button v-for="s in STATUSES" :key="s[0]" type="button" class="fchip" :class="{ on: q.status === s[0] }" @click="q.status = s[0]">{{ s[1] }} <span class="n">{{ count(s[0]) }}</span></button></div>
				</div>
				<div v-if="loading" class="wgrid"><div v-for="n in 6" :key="n" class="card pad"><Skel h="150" r="10" /><Skel w="60%" h="14" style="margin-top:12px" /></div></div>
				<ErrorState v-else-if="error" :message="error" @retry="load" />
				<Empty v-else-if="!shown.length" icon="whatsapp" :title="rows.length ? 'No templates match' : 'No WhatsApp templates yet'" :text="rows.length ? 'Try a different search or status.' : 'Create a template in Meta (WhatsApp Manager), then press Sync from Meta. It appears here once synced.'"><Btn v-if="!rows.length && data && data.can_sync" variant="primary" icon="download" :loading="syncing" @click="sync">Sync from Meta</Btn></Empty>
				<div v-else class="wgrid">
					<article v-for="t in shown" :key="t.name" class="wcard card hover" tabindex="0" @click="detail = t" @keydown.enter="detail = t">
						<div class="wcard-pv"><WaTemplateBubble :t="t" compact /></div>
						<div class="wcard-b">
							<div class="row"><b class="grow ellipsis" :title="t.template_name">{{ t.template_name }}</b><span class="badge" :class="stateTone(t.state)">{{ stateLabel(t.state) }}</span></div>
							<div class="row wrap" style="gap:6px"><span v-if="t.category" class="tchip">{{ catLabel(t.category) }}</span><span class="tchip">{{ t.language_code || 'en' }}</span><span class="tchip" :title="t.synced ? 'Fetched from Meta' : 'Created in this CRM, not synced from Meta'"><Ico :name="t.synced ? 'check-circle' : 'file'" size="sm" style="margin-right:4px" />{{ t.synced ? 'Meta-synced' : 'Local' }}</span><span v-if="t.placeholders.length" class="tchip">{{ t.placeholders.length }} variable{{ t.placeholders.length > 1 ? 's' : '' }}</span></div>
							<div class="row" style="margin-top:6px"><Btn size="sm" :variant="t.approved ? 'primary' : ''" :disabled="!t.approved" :title="t.approved ? '' : 'Only approved templates can be used'" @click.stop="use(t)">Use in campaign</Btn><span class="grow"></span><Btn size="sm" variant="ghost" icon="eye" @click.stop="detail = t">Details</Btn></div>
						</div>
					</article>
				</div>
			</template>
			<Drawer v-if="detail" :title="detail.template_name" :subtitle="stateLabel(detail.state) + ' - ' + catLabel(detail.category)" @close="detail = null">
				<div class="wa-stage"><WaTemplateBubble :t="detail" /></div>
				<dl class="dl"><dt>Status</dt><dd><span class="badge" :class="stateTone(detail.state)">{{ stateLabel(detail.state) }}</span></dd><dt>Source</dt><dd>{{ detail.synced ? 'Synced from Meta' : 'Local (not synced from Meta)' }}</dd><dt>Category</dt><dd>{{ catLabel(detail.category) || '-' }}</dd><dt>Language</dt><dd>{{ detail.language_code || '-' }}</dd><dt>Header</dt><dd>{{ detail.header_type ? detail.header_type.charAt(0) + detail.header_type.slice(1).toLowerCase() : 'None' }}</dd><dt>Variables</dt><dd><span v-if="!detail.placeholders.length">None</span><div v-for="(p, i) in detail.placeholders" :key="p" class="mono small">{{ $wa(p) }} <span class="faint">sample:</span> {{ detail.samples[i] || '-' }}</div></dd><dt>Buttons</dt><dd><span v-if="!detail.buttons.length">None</span><div v-for="b in detail.buttons" :key="b.button_label">{{ b.button_label }} <span class="faint small">({{ b.button_type }})</span></div></dd><dt>Meta name</dt><dd class="mono small">{{ detail.actual_name || detail.name }}</dd><dt>Last updated</dt><dd>{{ CM.fmt(detail.modified) }}</dd></dl>
				<div v-if="!detail.approved" class="alert warn"><Ico name="alert" /><div class="grow">This template is <b>{{ stateLabel(detail.state) }}</b>. Only templates approved by Meta can be sent. Check its status in WhatsApp Manager, then sync.</div></div>
				<template #foot><Btn @click="detail = null">Close</Btn><Btn variant="primary" icon="send" :disabled="!detail.approved" @click="use(detail)">Use in campaign</Btn></template>
			</Drawer>
		</div>`,
	}
})()
