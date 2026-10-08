/* Campaign Manager: audience builder (filters / saved segment / hand-picked leads), live eligibility insight,
 * and the Audiences section. Counts, eligibility and exclusion reasons all come from the server. */
(() => {
	const { ref, reactive, computed, watch, onMounted, onBeforeUnmount } = Vue
	const CM = window.CM
	const C = CM.components
	const V = CM.views

	const TEXT = ['Data', 'Small Text', 'Text', 'Long Text', 'Phone', 'Read Only', 'Autocomplete']
	const NUM = ['Int', 'Float', 'Currency', 'Percent', 'Rating']
	const DATE = ['Date', 'Datetime']
	const kindOf = (f) => (!f ? 'text' : f.fieldtype === 'Select' ? 'select' : f.fieldtype === 'Link' ? 'link' : f.fieldtype === 'Check' ? 'check' : NUM.includes(f.fieldtype) ? 'num' : DATE.includes(f.fieldtype) ? 'date' : 'text')
	const OPS = {
		text: [['=', 'is'], ['!=', 'is not'], ['contains', 'contains'], ['not contains', 'does not contain'], ['starts', 'starts with'], ['set', 'is set'], ['notset', 'is not set']],
		select: [['=', 'is'], ['!=', 'is not'], ['in', 'is any of'], ['not in', 'is none of'], ['set', 'is set'], ['notset', 'is not set']],
		link: [['=', 'is'], ['!=', 'is not'], ['in', 'is any of'], ['set', 'is set'], ['notset', 'is not set']],
		check: [['=', 'is']],
		num: [['=', 'equals'], ['!=', 'does not equal'], ['>', 'is greater than'], ['<', 'is less than'], ['>=', 'is at least'], ['<=', 'is at most'], ['between', 'is between'], ['set', 'is set'], ['notset', 'is not set']],
		date: [['=', 'is on'], ['>', 'is after'], ['<', 'is before'], ['>=', 'is on or after'], ['<=', 'is on or before'], ['between', 'is between'], ['set', 'is set'], ['notset', 'is not set']],
	}
	const opLabel = (kind, op) => ((OPS[kind] || OPS.text).find((o) => o[0] === op) || [0, op])[1]
	const QUICK = [['status', 'Status'], ['source', 'Source'], ['lead_owner', 'Lead owner'], ['email', 'Has email'], ['mobile_no', 'Has phone'], ['creation', 'Created date']]

	// rules <-> the [field, operator, value] triples the server stores
	const A = (CM.audience = {
		rulesToJson(rules) {
			return JSON.stringify(rules.filter((r) => r.field).map((r) => {
				const v = r.value
				if (r.op === 'contains') return [r.field, 'like', `%${v}%`]
				if (r.op === 'not contains') return [r.field, 'not like', `%${v}%`]
				if (r.op === 'starts') return [r.field, 'like', `${v}%`]
				if (r.op === 'set') return [r.field, 'is', 'set']
				if (r.op === 'notset') return [r.field, 'is', 'not set']
				if (r.op === 'in' || r.op === 'not in') return [r.field, r.op, Array.isArray(v) ? v : String(v || '').split(',').map((x) => x.trim()).filter(Boolean)]
				if (r.op === 'between') return [r.field, 'between', Array.isArray(v) ? v : ['', '']]
				return [r.field, r.op, v]
			}))
		},
		rulesFromJson(raw) {
			let list = []
			try { list = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw || [] } catch (e) { list = [] }
			return list.map(([field, op, v]) => {
				op = String(op).toLowerCase(); let value = v
				if (op === 'like') { const s = String(v); if (s.startsWith('%') && s.endsWith('%')) { op = 'contains'; value = s.slice(1, -1) } else if (s.endsWith('%')) { op = 'starts'; value = s.slice(0, -1) } else { op = 'contains'; value = s.replace(/%/g, '') } }
				else if (op === 'not like') { op = 'not contains'; value = String(v).replace(/%/g, '') }
				else if (op === 'is') op = v === 'set' ? 'set' : 'notset'
				return { id: CM.uid(), field, op, value }
			})
		},
		/** Plain-language rule for chips and summaries. */
		describe(rule, fields) {
			const f = (fields || []).find((x) => x.fieldname === rule[0]) || {}; const kind = kindOf(f)
			const label = f.label || rule[0]
			let [, op, v] = rule
			if (op === 'like') { const s = String(v); op = s.startsWith('%') ? 'contains' : 'starts'; v = s.replace(/%/g, '') }
			else if (op === 'not like') { op = 'not contains'; v = String(v).replace(/%/g, '') }
			else if (op === 'is') { op = v === 'set' ? 'set' : 'notset' }
			const shown = op === 'set' || op === 'notset' ? '' : Array.isArray(v) ? v.join(' - ') : v
			return `${label} ${opLabel(kind, op)} ${shown}`.trim()
		},
		definition(a) {
			if (a.mode === 'Saved Segment') return { mode: 'Saved Segment', saved_view: a.saved_view }
			if (a.mode === 'Selected Records') return { mode: 'Selected Records', selected: JSON.stringify(a.selected) }
			return { mode: 'CRM Filters', filters: A.rulesToJson(a.rules) }
		},
		/** Is the audience defined well enough to count? (an empty filter list means every lead). */
		ready(a) { return a.mode === 'CRM Filters' ? a.rules.every((r) => r.field && (['set', 'notset'].includes(r.op) || (Array.isArray(r.value) ? r.value.length && r.value.every((x) => x !== '') : r.value !== '' && r.value != null))) : a.mode === 'Saved Segment' ? !!a.saved_view : true },
	})

	// ------------------------------------------------------------------ filter builder
	C.LinkInp = {
		props: { modelValue: [String, Number], field: String },
		emits: ['update:modelValue'],
		setup(props, { emit }) {
			const list = ref([]); const id = 'dl' + CM.uid()
			const load = CM.debounce(async (t) => { try { list.value = await CM.apiLatest('field-values:' + id, 'search_field_values', { fieldname: props.field, txt: t || '' }) } catch (e) { list.value = [] } }, 250)
			onMounted(() => load(''))
			watch(() => props.field, () => load(''))
			return { list, id, input(e) { emit('update:modelValue', e.target.value); load(e.target.value) } }
		},
		template: `<div><input class="inp" :list="id" :value="modelValue" placeholder="Type to search" @input="input" /><datalist :id="id"><option v-for="o in list" :key="o.value" :value="o.value">{{ o.description }}</option></datalist></div>`,
	}
	C.FilterBuilder = {
		props: { rules: Array, hide: Function },
		setup(props) {
			const fields = computed(() => (CM.shared.fields ? CM.shared.fields.fields : []))
			const isHidden = (r) => !!(props.hide && props.hide(r))
			const shownBefore = (i) => props.rules.slice(0, i).some((r) => !isHidden(r))
			const anyShown = computed(() => props.rules.some((r) => !isHidden(r)))
			const fieldOptions = computed(() => fields.value.map((f) => ({ value: f.fieldname, label: f.label, sub: f.fieldname !== f.label ? undefined : undefined })).sort((a, b) => a.label.localeCompare(b.label)))
			const meta = (r) => fields.value.find((f) => f.fieldname === r.field)
			const kind = (r) => kindOf(meta(r))
			const ops = (r) => OPS[kind(r)].map(([value, label]) => ({ value, label }))
			const options = (r) => (meta(r) && meta(r).options ? String(meta(r).options).split('\n').filter(Boolean) : [])
			function add(field) {
				const f = fields.value.find((x) => x.fieldname === field)
				const k = kindOf(f); const r = { id: CM.uid(), field: field || '', op: OPS[k][0][0], value: k === 'check' ? 1 : '' }
				if (field === 'email' || field === 'mobile_no') { r.op = 'set' }
				if (field === 'creation') { r.op = '>='; r.value = CM.ymd(new Date(Date.now() - 30 * 864e5)) }
				props.rules.push(r)
			}
			function changeField(r) { const k = kind(r); r.op = OPS[k][0][0]; r.value = k === 'check' ? 1 : '' }
			function changeOp(r) { if (r.op === 'between') r.value = ['', '']; else if (['in', 'not in'].includes(r.op)) r.value = []; else if (Array.isArray(r.value) || ['set', 'notset'].includes(r.op)) r.value = '' }
			const toggleIn = (r, o) => { const v = Array.isArray(r.value) ? r.value : []; r.value = v.includes(o) ? v.filter((x) => x !== o) : [...v, o] }
			const csv = (r) => (Array.isArray(r.value) ? r.value.join(', ') : r.value)
			const setCsv = (r, s) => { r.value = s.split(',').map((x) => x.trim()).filter(Boolean) }
			const quick = computed(() => QUICK.filter(([f]) => fields.value.some((x) => x.fieldname === f) && !props.rules.some((r) => r.field === f)))
			return { isHidden, shownBefore, anyShown, fields, fieldOptions, meta, kind, ops, options, add, changeField, changeOp, toggleIn, csv, setCsv, quick, QUICK, yn: [{ value: 1, label: 'Yes' }, { value: 0, label: 'No' }] }
		},
		template: `
		<div class="fb">
			<div v-if="!anyShown" class="fb-empty small">No extra filters. Add one for anything the quick filters above do not cover.</div>
			<template v-for="(r, i) in rules" :key="r.id">
				<template v-if="!isHidden(r)">
				<div v-if="shownBefore(i)" class="fb-and"><span>and</span></div>
				<div class="fb-row">
					<Dd v-model="r.field" :options="fieldOptions" searchable placeholder="Choose a field" aria-label="Field" @change="changeField(r)" />
					<Dd v-model="r.op" :options="ops(r)" :disabled="!r.field" aria-label="Condition" @change="changeOp(r)" />
					<div class="fb-val">
						<span v-if="['set', 'notset'].includes(r.op)" class="faint small">No value needed</span>
						<template v-else-if="r.op === 'between'"><input class="inp" :type="kind(r) === 'date' ? 'date' : 'number'" v-model="r.value[0]" aria-label="From" /><span class="faint">and</span><input class="inp" :type="kind(r) === 'date' ? 'date' : 'number'" v-model="r.value[1]" aria-label="To" /></template>
						<div v-else-if="['in', 'not in'].includes(r.op) && kind(r) === 'select'" class="chips"><button v-for="o in options(r)" :key="o" type="button" class="fchip" :class="{ on: (r.value || []).includes(o) }" @click="toggleIn(r, o)">{{ o }}</button></div>
						<input v-else-if="['in', 'not in'].includes(r.op)" class="inp" :value="csv(r)" placeholder="value, value, value" @input="setCsv(r, $event.target.value)" />
						<Dd v-else-if="kind(r) === 'select'" v-model="r.value" :options="options(r)" placeholder="Choose" />
						<Dd v-else-if="kind(r) === 'check'" v-model="r.value" :options="yn" />
						<LinkInp v-else-if="kind(r) === 'link'" v-model="r.value" :field="r.field" />
						<input v-else class="inp" :type="kind(r) === 'date' ? 'date' : kind(r) === 'num' ? 'number' : 'text'" v-model="r.value" :placeholder="r.field ? 'Value' : ''" :disabled="!r.field" aria-label="Value" />
					</div>
					<button type="button" class="btn ghost icon sm" aria-label="Remove filter" @click="rules.splice(i, 1)"><Ico name="x" /></button>
				</div>
				</template>
			</template>
			<div class="row wrap" style="margin-top:10px"><Btn icon="plus" size="sm" @click="add('')">Add a filter</Btn></div>
		</div>`,
	}

	// ------------------------------------------------------------------ quick filters (the usual ones, one click each)
	const QUICK_FIELDS = [['status', 'Status'], ['source', 'Source'], ['industry', 'Organization type'], ['territory', 'Territory'], ['lead_owner', 'Lead owner']]
	/** A rule that one of the quick controls owns: the filter builder does not repeat it. */
	A.quickOwns = (r) => (QUICK_FIELDS.some(([f]) => f === r.field) && r.op === 'in') || (['email', 'mobile_no'].includes(r.field) && r.op === 'set') || (r.field === 'creation' && !!r.preset)
	C.QuickFilter = {
		props: { rules: Array, field: String, label: String },
		setup(props) {
			const open = ref(false); const q = ref(''); const list = ref([]); const busy = ref(false); const root = ref(null)
			const rule = computed(() => props.rules.find((r) => r.field === props.field && r.op === 'in'))
			const picked = computed(() => (rule.value && Array.isArray(rule.value.value) ? rule.value.value : []))
			async function load() { busy.value = true; try { list.value = await CM.apiLatest('qf:' + props.field, 'search_field_values', { fieldname: props.field, txt: q.value, limit: 30 }) } catch (e) { list.value = [] } finally { busy.value = false } }
			const search = CM.debounce(load, 250)
			watch(q, search)
			function toggle(v) {
				let r = rule.value
				if (!r) { r = { id: CM.uid(), field: props.field, op: 'in', value: [] }; props.rules.push(r) }
				r.value = r.value.includes(v) ? r.value.filter((x) => x !== v) : [...r.value, v]
				if (!r.value.length) props.rules.splice(props.rules.indexOf(r), 1)
			}
			const clear = () => { const r = rule.value; if (r) props.rules.splice(props.rules.indexOf(r), 1) }
			function show() { open.value = !open.value; if (open.value) { q.value = ''; load() } }
			const outside = (e) => { if (open.value && root.value && !root.value.contains(e.target)) open.value = false }
			onMounted(() => document.addEventListener('mousedown', outside)); onBeforeUnmount(() => document.removeEventListener('mousedown', outside))
			return { open, q, list, busy, root, picked, toggle, clear, show }
		},
		template: `
		<div ref="root" class="qf">
			<button type="button" class="qf-b" :class="{ on: picked.length }" :aria-expanded="open" @click="show">{{ label }}<span v-if="picked.length" class="qf-n">{{ picked.length > 1 ? picked.length + ' selected' : picked[0] }}</span><Ico name="chevron-down" size="sm" /></button>
			<div v-if="open" class="qf-pop" role="listbox" :aria-label="label">
				<input class="inp" v-model="q" :placeholder="'Search ' + label.toLowerCase()" :aria-label="'Search ' + label" />
				<div class="qf-list"><div v-if="busy && !list.length" class="small faint" style="padding:8px"><span class="spin" style="width:12px;height:12px"></span></div><label v-for="o in list" :key="o.value" class="qf-o"><input type="checkbox" :checked="picked.includes(o.value)" @change="toggle(o.value)" /><span class="grow ellipsis">{{ o.value }}</span><span v-if="o.description" class="tiny faint ellipsis" style="max-width:110px">{{ o.description }}</span></label><div v-if="!busy && !list.length" class="small faint" style="padding:8px">Nothing found.</div></div>
				<div class="qf-f"><button v-if="picked.length" type="button" class="link" @click="clear">Clear</button><span class="grow"></span><button type="button" class="link" @click="open = false">Done</button></div>
			</div>
		</div>`,
	}

	// ------------------------------------------------------------------ segment chooser
	C.SegmentPicker = {
		props: { modelValue: String },
		emits: ['update:modelValue', 'pick'],
		setup(props, { emit }) {
			const rows = ref([]); const loading = ref(true); const error = ref(''); const q = ref('')
			async function load() { loading.value = true; error.value = ''; try { rows.value = await CM.api('list_segments', {}) } catch (e) { error.value = e.message } finally { loading.value = false } }
			onMounted(() => { CM.loadShared(); load() })
			const shown = computed(() => rows.value.filter((s) => !q.value || s.label.toLowerCase().includes(q.value.toLowerCase())))
			const fields = computed(() => (CM.shared.fields ? CM.shared.fields.fields : []))
			return { rows, loading, error, q, shown, load, fields, A }
		},
		template: `
		<div>
			<div v-if="loading" class="seg-grid"><Skel v-for="n in 4" :key="n" h="104" r="12" /></div>
			<ErrorState v-else-if="error" :message="error" @retry="load" />
			<Empty v-else-if="!rows.length" icon="bookmark" title="No saved segments yet" text="Save a set of lead filters as a segment (from Filter CRM leads, or the Audiences section) and it will appear here."><Btn @click="$emit('pick', null)">Build a filter instead</Btn></Empty>
			<template v-else>
				<div style="max-width:320px;margin-bottom:12px"><Inp v-model="q" icon="search" placeholder="Search segments" clearable aria-label="Search segments" /></div>
				<div class="seg-grid"><button v-for="s in shown" :key="s.name" type="button" class="segc card hover" :class="{ on: s.name === modelValue }" @click="$emit('update:modelValue', s.name); $emit('pick', s)"><div class="row"><b class="grow ellipsis">{{ s.label }}</b><Ico v-if="s.name === modelValue" name="check-circle" class="tickc" /></div><div class="segc-n">{{ s.count == null ? '-' : CM.num(s.count) }} <span class="small muted">leads</span></div><div class="row wrap" style="gap:5px"><span v-for="(r, i) in s.rules.slice(0, 2)" :key="i" class="tchip">{{ A.describe(r, fields) }}</span><span v-if="s.rules.length > 2" class="tchip">+{{ s.rules.length - 2 }} more</span><span v-if="!s.rules.length" class="tchip">All leads</span></div></button></div>
				<p v-if="!shown.length" class="muted">No segment matches "{{ q }}".</p>
			</template>
		</div>`,
		data() { return { CM } },
	}

	// ------------------------------------------------------------------ hand-picked leads
	C.LeadPicker = {
		props: { modelValue: Array },
		emits: ['update:modelValue', 'add'],
		setup(props, { emit }) {
			const q = ref(''); const results = ref([]); const open = ref(false); const busy = ref(false); const wrap = ref(null)
			const search = CM.debounce(async () => { busy.value = true; try { results.value = await CM.apiLatest('lead-search', 'search_leads', { txt: q.value }); open.value = true } catch (e) { if (!e.cancelled) CM.toast(e.message, 'err') } finally { busy.value = false } }, 250)
			watch(q, search)
			const picked = (n) => props.modelValue.includes(n)
			function add(l) { if (!picked(l.name)) { emit('update:modelValue', [...props.modelValue, l.name]); emit('add', l) } }
			function outside(e) { if (wrap.value && !wrap.value.contains(e.target)) open.value = false }
			onMounted(() => document.addEventListener('mousedown', outside)); onBeforeUnmount(() => document.removeEventListener('mousedown', outside))
			return { q, results, open, busy, wrap, picked, add, search }
		},
		template: `
		<div ref="wrap" class="lp"><Inp v-model="q" icon="search" placeholder="Search leads by name, then click to add" aria-label="Search leads" @focus="q || search(); open = true" />
			<div v-if="open && (results.length || busy)" class="lp-pop"><div v-if="busy && !results.length" class="pop-empty"><span class="spin"></span></div><button v-for="l in results" :key="l.name" type="button" class="opt" @click="add(l)"><Avatar :name="l.lead_name || l.name" :size="26" /><span class="grow"><span class="ellipsis" style="display:block">{{ l.lead_name || l.name }}</span><span class="sub">{{ l.email || l.mobile_no || l.name }}</span></span><Ico v-if="picked(l.name)" name="check" class="tick" /><Ico v-else name="plus" size="sm" class="faint" /></button></div></div>`,
	}

	// ------------------------------------------------------------------ live insight (count, eligibility, sample, why excluded)
	C.AudienceInsight = {
		props: { definition: Object, ready: { type: Boolean, default: true }, consent: Boolean, removable: Boolean, compact: Boolean },
		emits: ['result', 'remove'],
		setup(props, { emit }) {
			const data = ref(null); const loading = ref(false); const error = ref(''); const page = ref(0); const SIZE = 5; const showSample = ref(true)
			let seq = 0
			async function run(full = true) {
				if (!props.ready) { data.value = null; return }
				const my = ++seq; loading.value = true; error.value = ''
				try {
					const r = await CM.apiLatest('audience', 'audience_insight', { definition: props.definition, channels: ['Email', 'WhatsApp'], consent_confirmed: props.consent ? 1 : 0, start: page.value * SIZE, page_length: SIZE, with_summary: full ? 1 : 0 })
					if (my !== seq) return
					data.value = { ...r, summary: r.summary || (data.value && data.value.summary) }
					if (full) emit('result', { count: r.count, summary: r.summary })
				} catch (e) { if (my === seq) { error.value = e.message; emit('result', null) } } finally { if (my === seq) loading.value = false }
			}
			const debounced = CM.debounce(() => { page.value = 0; run(true) }, 600)
			watch(() => [JSON.stringify(props.definition), props.consent, props.ready], () => { loading.value = true; debounced() })
			watch(page, () => run(false))
			onMounted(() => run(true))
			onBeforeUnmount(() => { debounced.cancel(); seq++ })
			const s = computed(() => data.value && data.value.summary)
			function reasons(ch) {
				if (!s.value || !s.value[ch]) return []
				const r = s.value[ch].reasons || {}; const total = s.value.total
				const out = [{ label: ch === 'Email' ? 'Valid email' : 'Valid WhatsApp number', value: s.value[ch].eligible, tone: 'ok' }]
				Object.entries(r).forEach(([k, v]) => out.push({ label: k.replace(' in this campaign', '').replace('Duplicate email', 'Duplicate emails').replace('Duplicate number', 'Duplicate numbers'), value: v, tone: 'bad' }))
				return out.map((x) => ({ ...x, total }))
			}
			function chip(el) { return el ? (el.ok ? { cls: 'green', text: 'Eligible' } : { cls: 'amber', text: el.reason }) : null }
			return { data, loading, error, page, SIZE, showSample, s, reasons, chip, run, CM }
		},
		template: `
		<div class="ai">
			<div v-if="!ready" class="alert warn"><Ico name="info" /><div class="grow">Finish the filter (choose a field and a value) to see who matches.</div></div>
			<template v-else>
				<div class="ai-bar card">
					<div class="ai-n"><div v-if="data" class="ai-big">{{ CM.num(data.count) }}</div><Skel v-else w="60" h="26" /><div class="tiny muted">{{ loading && data ? 'updating' : 'matching leads' }}</div></div>
					<div v-for="ch in ['Email', 'WhatsApp']" :key="ch" class="ai-c">
						<div class="row" style="gap:8px"><ChannelBadge :value="ch" /><span v-if="s" class="small muted"><b style="color:var(--text)">{{ CM.num(s[ch].eligible) }}</b> can receive</span></div>
						<div v-if="s" class="bar green" style="margin:7px 0 5px"><i :style="{ width: CM.pct(s[ch].eligible, s.total) + '%' }"></i></div><Skel v-else h="6" style="margin:9px 0" />
						<div v-if="s" class="ai-why"><span v-for="r in reasons(ch).slice(1)" :key="r.label" class="tchip">{{ r.label }} {{ CM.num(r.value) }}</span></div>
					</div>
				</div>
				<div v-if="error" class="alert err" style="margin-top:10px"><Ico name="alert" /><div class="grow">{{ error }}</div></div>
				<div v-if="data && data.rows.length" class="card ai-sample">
					<button type="button" class="ai-sh" :aria-expanded="showSample" @click="showSample = !showSample"><Ico :name="showSample ? 'chevron-down' : 'chevron-right'" size="sm" /><b>Sample of matching leads</b><span class="tiny faint">and whether each can receive each channel</span></button>
					<template v-if="showSample"><div class="table-wrap"><table class="tbl compact"><thead><tr><th>Lead</th><th>Email</th><th>WhatsApp</th><th v-if="removable"></th></tr></thead><tbody>
						<tr v-for="r in data.rows" :key="r.name"><td><div class="row" style="gap:8px"><Avatar :name="r.lead_name || r.name" :size="22" /><div style="min-width:0"><a :href="CM.leadUrl(r.name)" target="_blank" rel="noopener" class="ellipsis" style="display:block" @click="CM.openCrm($event, CM.leadUrl(r.name))">{{ r.lead_name || r.name }}</a><span class="tiny faint">{{ r.status }}</span></div></div></td>
							<td><span class="ellipsis small" style="display:inline-block;max-width:190px;vertical-align:middle">{{ r.email || '-' }}</span> <span v-if="chip(r.eligibility.Email)" class="badge sm nodot" :class="chip(r.eligibility.Email).cls">{{ chip(r.eligibility.Email).text }}</span></td>
							<td><span class="ellipsis small" style="display:inline-block;max-width:140px;vertical-align:middle">{{ r.mobile_no || r.phone || '-' }}</span> <span v-if="chip(r.eligibility.WhatsApp)" class="badge sm nodot" :class="chip(r.eligibility.WhatsApp).cls">{{ chip(r.eligibility.WhatsApp).text }}</span></td>
							<td v-if="removable" style="width:34px"><button type="button" class="btn ghost icon sm" :aria-label="'Remove ' + r.name" @click="$emit('remove', r.name)"><Ico name="x" /></button></td></tr></tbody></table></div>
					<div style="padding:2px 12px 8px"><Pager v-model:page="page" :size="SIZE" :total="data.count" /></div></template>
				</div>
				<div v-else-if="data && !data.rows.length && !loading" class="alert warn" style="margin-top:10px"><Ico name="info" /><div class="grow">No lead matches these filters yet.</div></div>
			</template>
		</div>`,
	}

	// ------------------------------------------------------------------ the three-option audience builder
	C.AudienceBuilder = {
		props: { a: Object, consent: Boolean, insight: { type: Boolean, default: true }, modes: { type: Array, default: () => ['CRM Filters', 'Saved Segment', 'Selected Records'] } },
		emits: ['result'],
		setup(props, { emit }) {
			const cards = [
				{ mode: 'CRM Filters', icon: 'filter', title: 'Filter CRM leads', text: 'Describe who you want by status, source, owner or date.' },
				{ mode: 'Saved Segment', icon: 'bookmark', title: 'Saved segment', text: 'Reuse a saved filter from your Leads list or the Audiences section.' },
				{ mode: 'Selected Records', icon: 'user', title: 'Pick leads manually', text: 'Search and hand-pick specific leads.' },
			].filter((c) => props.modes.includes(c.mode))
			const saveOpen = ref(false); const seg = reactive({ label: '', public: false }); const saving = ref(false)
			const definition = computed(() => A.definition(props.a))
			const ready = computed(() => A.ready(props.a))
			const isManager = computed(() => CM.shared.config && CM.shared.config.is_manager)
			const names = computed(() => props.a.selected)
			async function saveSeg() {
				if (!seg.label.trim()) return CM.toast('Give the segment a name.', 'warn')
				saving.value = true
				try { const r = await CM.api('save_segment', { label: seg.label, filters: A.rulesToJson(props.a.rules), public: seg.public ? 1 : 0 }); saveOpen.value = false; seg.label = ''; CM.toast('Segment saved: ' + r.label) } catch (e) { CM.toast(e.message, 'err') } finally { saving.value = false }
			}
			const choose = (m) => { props.a.mode = m }
			const modeOptions = cards.map((c) => ({ value: c.mode, label: c.mode === 'CRM Filters' ? 'Filter leads' : c.mode === 'Saved Segment' ? 'Saved segment' : 'Pick leads', icon: c.icon }))
			const hasField = (f) => (CM.shared.fields ? CM.shared.fields.fields : []).some((x) => x.fieldname === f)
			const quickFields = computed(() => QUICK_FIELDS.filter(([f]) => hasField(f)))
			const hasSet = (f) => props.a.rules.some((r) => r.field === f && r.op === 'set')
			function toggleSet(f) { const i = props.a.rules.findIndex((r) => r.field === f && r.op === 'set'); if (i >= 0) props.a.rules.splice(i, 1); else props.a.rules.push({ id: CM.uid(), field: f, op: 'set', value: '' }) }
			const PRESETS = [{ value: '', label: 'Any time' }, { value: 7, label: 'Last 7 days' }, { value: 30, label: 'Last 30 days' }, { value: 90, label: 'Last 90 days' }]
			const preset = computed(() => { const r = props.a.rules.find((x) => x.field === 'creation' && x.preset); return r ? r.preset : '' })
			function setPreset(v) {
				const i = props.a.rules.findIndex((r) => r.field === 'creation' && r.preset)
				if (i >= 0) props.a.rules.splice(i, 1)
				if (v) props.a.rules.push({ id: CM.uid(), field: 'creation', op: '>=', value: CM.ymd(new Date(Date.now() - v * 864e5)), preset: v })
			}
			const extra = computed(() => props.a.rules.filter((r) => !A.quickOwns(r)).length)
			const more = ref(false)
			watch(extra, (n) => { if (n) more.value = true })
			const removeLead = (n) => { props.a.selected = props.a.selected.filter((x) => x !== n) }
			onMounted(() => CM.loadShared())
			return { modeOptions, quickFields, hasField, hasSet, toggleSet, PRESETS, preset, setPreset, extra, more, quickOwns: A.quickOwns, cards, saveOpen, seg, saving, definition, ready, isManager, saveSeg, choose, removeLead, A }
		},
		template: `
		<div class="ab">
			<div class="ab-top"><Seg v-model="a.mode" :options="modeOptions" /><span class="small muted ab-hint">{{ a.mode === 'CRM Filters' ? 'Pick who should receive it. Leads must match every filter you choose.' : a.mode === 'Saved Segment' ? 'Reuse a saved filter from your Leads list.' : 'Search and hand-pick specific leads.' }}</span></div>
			<div class="card ab-body">
				<template v-if="a.mode === 'CRM Filters'">
					<div class="qf-row">
						<QuickFilter v-for="f in quickFields" :key="f[0]" :rules="a.rules" :field="f[0]" :label="f[1]" />
						<span class="qf-sep"></span>
						<button v-if="hasField('email')" type="button" class="qf-b" :class="{ on: hasSet('email') }" :aria-pressed="hasSet('email')" @click="toggleSet('email')">Has email</button>
						<button v-if="hasField('mobile_no')" type="button" class="qf-b" :class="{ on: hasSet('mobile_no') }" :aria-pressed="hasSet('mobile_no')" @click="toggleSet('mobile_no')">Has phone</button>
						<Dd :model-value="preset" :options="PRESETS" size="sm" prefix="Created:" aria-label="Created" @update:model-value="setPreset" />
					</div>
					<div class="ab-more"><button type="button" class="link" :aria-expanded="more" @click="more = !more"><Ico :name="more ? 'chevron-down' : 'chevron-right'" size="sm" /> More filters<span v-if="extra" class="qf-n">{{ extra }}</span></button><span class="grow"></span><button v-if="a.rules.length" type="button" class="link" @click="a.rules.splice(0)">Clear all</button><Btn size="sm" icon="bookmark" :disabled="!a.rules.length || !ready" @click="saveOpen = true">Save as segment</Btn></div>
					<div v-show="more" class="ab-adv"><FilterBuilder :rules="a.rules" :hide="quickOwns" /></div>
				</template>
				<template v-else-if="a.mode === 'Saved Segment'"><SegmentPicker v-model="a.saved_view" @pick="(s) => s === null ? (a.mode = 'CRM Filters') : null" /></template>
				<template v-else><div class="row" style="margin-bottom:8px"><span class="small muted grow">{{ a.selected.length }} selected</span><Btn v-if="a.selected.length" size="sm" variant="ghost" @click="a.selected = []">Clear all</Btn></div><LeadPicker v-model="a.selected" /></template>
			</div>
			<AudienceInsight v-if="insight && (a.mode !== 'Selected Records' || a.selected.length)" :definition="definition" :ready="ready" :consent="consent" :removable="a.mode === 'Selected Records'" @result="(r) => $emit('result', r)" @remove="removeLead" />
			<Modal v-if="saveOpen" size="sm" title="Save as segment" subtitle="Reuse these filters in any campaign, and see them in your Leads list." @close="saveOpen = false" @submit="saveSeg">
				<Field label="Segment name" required><input class="inp" v-model="seg.label" placeholder="e.g. New leads this month" autofocus /></Field>
				<label v-if="isManager" class="check"><input type="checkbox" v-model="seg.public" /><span>Share with everyone<span class="small muted" style="display:block">Otherwise only you can use it.</span></span></label>
				<template #foot><Btn @click="saveOpen = false">Cancel</Btn><Btn variant="primary" :loading="saving" @click="saveSeg">Save segment</Btn></template>
			</Modal>
		</div>`,
	}

	// ------------------------------------------------------------------ Audiences section
	V.Audiences = {
		setup() {
			const rows = ref([]); const loading = ref(true); const error = ref(''); const q = ref(''); const detail = ref(null); const createOpen = ref(false)
			async function load() { loading.value = true; error.value = ''; try { rows.value = await CM.api('list_segments', {}) } catch (e) { error.value = e.message } finally { loading.value = false } }
			onMounted(() => { CM.loadShared(); load() })
			const shown = computed(() => rows.value.filter((s) => !q.value || s.label.toLowerCase().includes(q.value.toLowerCase())))
			const fields = computed(() => (CM.shared.fields ? CM.shared.fields.fields : []))
			async function remove(s) {
				if (!(await CM.confirm({ title: 'Delete segment "' + s.label + '"?', message: 'It will also disappear from the saved views of your Leads list. Campaigns that already ran are not affected.', confirmText: 'Delete segment', danger: true }))) return
				try { await CM.api('delete_segment', { name: s.name }); CM.toast('Segment deleted'); detail.value = null; load() } catch (e) { CM.toast(e.message, 'err') }
			}
			const a = reactive({ mode: 'CRM Filters', rules: [], saved_view: '', selected: [] })
			const seg = reactive({ label: '', public: false }); const saving = ref(false)
			const isManager = computed(() => CM.shared.config && CM.shared.config.is_manager)
			function openCreate() { a.rules.splice(0); seg.label = ''; seg.public = false; createOpen.value = true }
			async function create() {
				if (!seg.label.trim()) return CM.toast('Give the segment a name.', 'warn')
				saving.value = true
				try { await CM.api('save_segment', { label: seg.label, filters: A.rulesToJson(a.rules), public: seg.public ? 1 : 0 }); createOpen.value = false; CM.toast('Segment saved'); load() } catch (e) { CM.toast(e.message, 'err') } finally { saving.value = false }
			}
			const use = (s) => CM.go('/campaigns/new?segment=' + encodeURIComponent(s.name))
			const defOf = (s) => ({ mode: 'Saved Segment', saved_view: s.name })
			return { rows, loading, error, q, shown, load, detail, createOpen, fields, remove, a, seg, saving, isManager, openCreate, create, use, defOf, A, CM, ready: computed(() => A.ready(a)), defn: computed(() => A.definition(a)) }
		},
		template: `
		<div class="page">
			<div class="pg-head"><div class="grow"><h1>Audiences</h1><p>Saved segments of your leads. They are the same saved filters as in your Leads list, ready to use in any campaign.</p></div><div class="actions"><Btn variant="primary" icon="plus" @click="openCreate">Create segment</Btn></div></div>
			<div class="row wrap tool"><div style="width:300px;max-width:100%"><Inp v-model="q" icon="search" placeholder="Search segments" clearable aria-label="Search segments" /></div></div>
			<div v-if="loading" class="seg-grid"><Skel v-for="n in 6" :key="n" h="132" r="12" /></div>
			<ErrorState v-else-if="error" :message="error" @retry="load" />
			<Empty v-else-if="!shown.length" icon="users" :title="rows.length ? 'No segments match' : 'No saved segments yet'" :text="rows.length ? 'Try a different search.' : 'Save a set of filters as a segment to reuse it across campaigns.'"><Btn v-if="!rows.length" variant="primary" icon="plus" @click="openCreate">Create segment</Btn></Empty>
			<div v-else class="seg-grid">
				<article v-for="s in shown" :key="s.name" class="segc card hover" tabindex="0" @click="detail = s" @keydown.enter="detail = s">
					<div class="row"><b class="grow ellipsis">{{ s.label }}</b><span class="badge nodot" :class="s.public ? 'blue' : 'neutral'">{{ s.public ? 'Shared' : 'Private' }}</span><Menu :items="[{ label: 'Use in a campaign', icon: 'send', run: () => use(s) }, { label: 'View leads', icon: 'eye', run: () => (detail = s) }, { sep: true }, { label: 'Delete', icon: 'trash', danger: true, run: () => remove(s) }]" /></div>
					<div class="segc-n">{{ s.count == null ? '-' : CM.num(s.count) }} <span class="small muted">leads</span></div>
					<div class="row wrap" style="gap:5px"><span v-for="(r, i) in s.rules.slice(0, 3)" :key="i" class="tchip">{{ A.describe(r, fields) }}</span><span v-if="s.rules.length > 3" class="tchip">+{{ s.rules.length - 3 }} more</span><span v-if="!s.rules.length" class="tchip">All leads</span></div>
					<div class="small faint">Updated {{ CM.ago(s.modified) }}<template v-if="!s.mine"> - shared by a colleague</template></div>
				</article>
			</div>
			<Drawer v-if="detail" wide :title="detail.label" :subtitle="CM.num(detail.count) + ' leads'" @close="detail = null">
				<div class="row wrap" style="gap:6px"><span v-for="(r, i) in detail.rules" :key="i" class="tchip">{{ A.describe(r, fields) }}</span><span v-if="!detail.rules.length" class="tchip">All leads</span></div>
				<AudienceInsight :definition="defOf(detail)" />
				<template #foot><Btn variant="danger" icon="trash" @click="remove(detail)">Delete</Btn><span class="grow"></span><Btn variant="primary" icon="send" @click="use(detail)">Use in a campaign</Btn></template>
			</Drawer>
			<Modal v-if="createOpen" size="xl" title="Create segment" subtitle="Build the filter, check who matches, then save it." @close="createOpen = false">
				<div class="row wrap"><Field label="Segment name" required class="grow"><input class="inp" v-model="seg.label" placeholder="e.g. Hot leads without a call" /></Field><label v-if="isManager" class="check" style="margin-top:22px"><input type="checkbox" v-model="seg.public" /><span>Share with everyone</span></label></div>
				<div class="card pad"><FilterBuilder :rules="a.rules" /></div>
				<AudienceInsight :definition="defn" :ready="ready" />
				<template #foot><Btn @click="createOpen = false">Cancel</Btn><Btn variant="primary" :loading="saving" @click="create">Save segment</Btn></template>
			</Modal>
		</div>`,
	}
})()
