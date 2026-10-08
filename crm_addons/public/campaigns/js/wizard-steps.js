/* Campaign Manager: the content step's building blocks (email step card, WhatsApp step card with variable mapping). */
(() => {
	const { ref, reactive, computed, watch, onMounted } = Vue
	const CM = window.CM
	const C = CM.components

	CM.COND_OPTIONS = [
		{ value: '', label: 'Always send' },
		{ value: 'Previous step was sent', label: 'If the previous message was sent' },
		{ value: 'Previous step was read or opened', label: 'If the previous message was read or opened' },
		{ value: 'Previous step was not read or opened', label: 'If the previous message was not read' },
		{ value: 'Previous step failed or was skipped', label: 'If the previous message failed or was skipped' },
	]
	CM.tplCache = reactive({})
	CM.getEmailTemplate = async (name) => { if (!name) return null; if (!CM.tplCache[name]) { try { CM.tplCache[name] = await CM.api('get_email_template', { name }) } catch (e) { CM.tplCache[name] = { missing: true, template_name: name, subject: '', body_html: '' } } } return CM.tplCache[name] }

	/** Timing and condition of one journey step (progressive: only shown for follow-ups). */
	C.StepTiming = {
		props: { step: Object, index: Number, auto: Boolean },
		setup(props) {
			const open = ref(props.index > 0 && (props.step.day_offset > 0 || !!props.step.condition))
			const text = computed(() => {
				const day = Number(props.step.day_offset) || 0; const cond = (CM.COND_OPTIONS.find((o) => o.value === props.step.condition) || {}).label
				return (day ? `On day ${day}` : props.auto ? 'Right after the lead joins' : 'When the campaign starts') + (props.step.condition ? ', ' + cond.replace('If the', 'if the').replace('Only if', 'if') : '')
			})
			return { open, text, CM }
		},
		template: `
		<div v-if="index > 0" class="timing-w">
			<div v-if="!open" class="row small" style="gap:8px"><Ico name="clock" size="sm" /><span class="muted">Sent: <b style="color:var(--text)">{{ text }}</b></span><button type="button" class="linkbtn" style="color:var(--accent)" @click="open = true">Change timing</button></div>
			<div v-else class="timing">
				<Field label="Send on day"><div class="row" style="gap:8px"><input class="inp" style="width:84px" type="number" min="0" max="365" v-model.number="step.day_offset" aria-label="Day after the campaign starts" /><span class="small muted">{{ auto ? 'days after the lead joins' : 'days after the campaign starts' }}</span></div></Field>
				<Field label="Only send"><Dd v-model="step.condition" :options="CM.COND_OPTIONS" /></Field>
			</div>
		</div>`,
	}

	C.EmailStep = {
		props: { step: Object, index: Number, showErrors: Boolean, auto: Boolean },
		emits: ['remove', 'pick', 'edit', 'create', 'preview'],
		setup(props) {
			const tpl = ref(null); const filesOpen = ref(false)
			const load = async () => { tpl.value = await CM.getEmailTemplate(props.step.email_template) }
			watch(() => props.step.email_template, load); onMounted(() => { load(); filesOpen.value = props.step.attachments.length > 0 })
			const limit = computed(() => (CM.shared.config && CM.shared.config.attachment_limit_mb) || 10)
			return { tpl, filesOpen, limit, CM }
		},
		template: `
		<div class="stc card">
			<div class="stc-h"><span class="stc-n">{{ index + 1 }}</span><ChannelBadge value="Email" /><span class="grow small muted">{{ index > 0 && (step.day_offset > 0 || step.condition) ? 'Follow-up' : '' }}</span><Btn v-if="index > 0" size="sm" variant="ghost" icon="trash" aria-label="Remove this step" @click="$emit('remove')" /></div>
			<div class="stc-b">
				<StepTiming :step="step" :index="index" :auto="auto" />
				<div v-if="!step.email_template" class="pick-empty" :class="{ bad: showErrors }"><Ico name="mail" size="lg" /><div class="grow"><b>Choose an email template</b><div class="small muted">Templates hold the subject and the design. Pick one, or create a new one.</div><div v-if="showErrors" class="small" style="color:var(--red);margin-top:4px">Choose a template to continue.</div></div><Btn variant="primary" @click="$emit('pick')">Choose template</Btn><Btn icon="plus" @click="$emit('create')">New</Btn></div>
				<div v-else class="tsel">
					<div class="tsel-th"><Thumb v-if="tpl && !tpl.missing" :html="CM.sampleFill(tpl.body_html)" :height="120" /><div v-else class="skel" style="height:120px"></div></div>
					<div class="grow" style="min-width:0"><div class="lbl">Email template</div><b style="font-size:15px" class="ellipsis">{{ step.email_template }}</b><div v-if="tpl && tpl.missing" class="small" style="color:var(--red)">This template no longer exists. Choose another.</div><div v-else-if="tpl" class="small muted ellipsis">Subject: {{ tpl.subject }}</div>
						<div class="row wrap" style="margin-top:10px;gap:6px"><Btn size="sm" @click="$emit('pick')">Change</Btn><Btn size="sm" icon="edit" :disabled="!CM.shared.config || !CM.shared.config.is_manager" :title="CM.shared.config && CM.shared.config.is_manager ? '' : 'Only managers can edit templates'" @click="$emit('edit')">Edit template</Btn><Btn size="sm" icon="eye" @click="$emit('preview')">Preview</Btn></div></div>
				</div>
				<div><button type="button" class="linkbtn" @click="filesOpen = !filesOpen"><Ico :name="filesOpen ? 'chevron-down' : 'chevron-right'" size="sm" /><Ico name="paperclip" size="sm" /> Attachments {{ step.attachments.length ? '(' + step.attachments.length + ')' : '' }}<span class="faint small"> - optional, sent with this email only</span></button>
					<div v-if="filesOpen" style="margin-top:10px"><Uploader v-model="step.attachments" :max-mb="limit" :total-mb="limit" :hint="'PDF, images, documents. Up to ' + limit + ' MB in total per email. Files attached to the template are sent too.'" /></div></div>
			</div>
		</div>`,
	}

	C.WaStep = {
		props: { step: Object, index: Number, templates: Array, showErrors: Boolean, auto: Boolean },
		emits: ['remove'],
		setup(props) {
			const tpl = computed(() => (props.templates || []).find((t) => t.name === props.step.wa_template))
			const options = computed(() => (props.templates || []).slice().sort((x, y) => Number(y.approved) - Number(x.approved) || x.template_name.localeCompare(y.template_name)).map((t) => ({ value: t.name, label: t.template_name, sub: t.approved ? (t.category || '').toLowerCase() + ' - ' + (t.language_code || 'en') : 'Not approved: ' + CM.waState.label(t.state), disabled: !t.approved, icon: 'whatsapp', badge: t.approved ? undefined : CM.waState.label(t.state) })))
			function pick(n) { props.step.wa_template = n; const t = props.templates.find((x) => x.name === n); const map = {}; ;(t ? t.placeholders : []).forEach((p, i) => { map[p] = props.step.variable_map[p] || ['{{ first_name }}', '{{ owner_name }}', '{{ organization }}', '{{ email }}'][i] || '' }); props.step.variable_map = map; props.step.wa_attach = '' }
			const vals = computed(() => (tpl.value ? tpl.value.placeholders.map((p) => CM.sampleFill(props.step.variable_map[p] || '')) : []))
			const missing = computed(() => (tpl.value ? tpl.value.placeholders.filter((p) => !String(props.step.variable_map[p] || '').trim()) : []))
			const insert = (p, tok) => { const el = document.querySelector(`[data-wa="${props.index}-${p}"]`); CM.insertAtCursor(el, tok) }
			const needsMedia = computed(() => tpl.value && ['IMAGE', 'DOCUMENT', 'VIDEO'].includes(String(tpl.value.header_type).toUpperCase()))
			const media = computed({ get: () => (props.step.wa_attach ? [{ file_url: props.step.wa_attach, file_name: props.step.wa_attach.split('/').pop(), file_size: 0 }] : []), set: (v) => { props.step.wa_attach = v[0] ? v[0].file_url : '' } })
			const ready = computed(() => CM.shared.config && CM.shared.config.whatsapp.ready)
			return { tpl, options, pick, vals, missing, insert, needsMedia, media, ready, CM }
		},
		template: `
		<div class="stc card">
			<div class="stc-h"><span class="stc-n">{{ index + 1 }}</span><ChannelBadge value="WhatsApp" /><span class="grow small muted">{{ index > 0 && (step.day_offset > 0 || step.condition) ? 'Follow-up' : '' }}</span><Btn v-if="index > 0" size="sm" variant="ghost" icon="trash" aria-label="Remove this step" @click="$emit('remove')" /></div>
			<div class="stc-b">
				<StepTiming :step="step" :index="index" :auto="auto" />
				<div v-if="!ready" class="alert warn"><Ico name="alert" /><div class="grow">No active WhatsApp account is set up in frappe_whatsapp, so a WhatsApp message cannot be sent yet. You can still prepare the campaign.</div></div>
				<div class="wa-grid">
					<div class="col" style="gap:14px">
						<Field label="WhatsApp template" required :error="showErrors && !step.wa_template ? 'Choose an approved template to continue.' : ''"><Dd :model-value="step.wa_template" :options="options" searchable placeholder="Choose an approved template" :bad="showErrors && !step.wa_template" @update:model-value="pick" /></Field>
						<div class="small faint" v-if="!templates.length">No templates yet. Create and get templates approved in Meta; they appear after sync. <a href="#/templates/whatsapp">WhatsApp templates</a></div>
						<template v-if="tpl">
							<div v-if="tpl.placeholders.length"><div class="lbl" style="margin-bottom:8px">Fill the variables</div>
								<div v-for="(p, i) in tpl.placeholders" :key="p" class="wa-map"><span class="wa-map-n mono">{{ $wa(p) }}</span><div class="grow"><input class="inp" :class="{ bad: showErrors && !step.variable_map[p] }" v-model="step.variable_map[p]" :data-wa="index + '-' + p" placeholder="Type text or insert a variable" :aria-label="'Value for variable ' + p" /><div class="tiny faint" style="margin-top:3px">Sample: {{ tpl.samples[i] || '-' }}</div></div><VarMenu label="" size="sm" @pick="(t) => insert(p, t)" /></div>
								<div v-if="showErrors && missing.length" class="small" style="color:var(--red)">Fill {{ missing.map($wa).join(', ') }} to continue. A lead with an empty value is skipped.</div></div>
							<div v-else class="small muted">This template has no variables.</div>
							<div v-if="needsMedia"><div class="lbl" style="margin-bottom:6px">Header {{ tpl.header_type.toLowerCase() }} (optional)</div><Uploader v-model="media" :is-private="false" :multiple="false" :accept="tpl.header_type === 'IMAGE' ? 'image/*' : tpl.header_type === 'VIDEO' ? 'video/*' : '.pdf,.doc,.docx,.xls,.xlsx'" :max-mb="5" title="Upload header media" hint="Stored publicly so WhatsApp can fetch it. Leave empty to use the template's own sample." /></div>
						</template>
					</div>
					<div class="wa-side"><WaBubble v-if="tpl" :header="tpl.header" :header-type="tpl.header_type" :body="tpl.template" :footer="tpl.footer" :buttons="tpl.buttons" :values="vals" :media-url="step.wa_attach" compact /><div v-else class="wa-ph"><Ico name="whatsapp" size="xl" /><span>Pick a template to see the message</span></div></div>
				</div>
			</div>
		</div>`,
	}
})()
