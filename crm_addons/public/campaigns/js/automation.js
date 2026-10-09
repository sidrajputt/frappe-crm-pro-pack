/* Campaign Manager: Automations. "When this happens to a lead, do these things."
 * A list of automations with an On switch each, and an editor in four short blocks: name, when, only for leads that match, then do. */
(() => {
	const { ref, reactive, computed, watch, onMounted, onBeforeUnmount } = Vue
	const CM = window.CM
	const C = CM.components
	const V = CM.views

	const GROUPS = [
		{ title: 'Something about a lead', events: [['Lead created', 'A new lead is created', 'users'], ['Lead status changed', 'A lead\'s status changes', 'refresh']] },
		{ title: 'Something about a message you sent', events: [['Lead replied', 'A lead replies', 'inbox'], ['Lead clicked a link', 'A lead clicks a link', 'link'], ['Lead opened or read', 'A lead opens or reads it', 'eye'], ['Message failed or bounced', 'It fails or bounces', 'alert'], ['Lead opted out', 'A lead opts out', 'ban']] },
	]
	const ACTION_INFO = {
		'Send messages': { icon: 'send', text: 'Send messages', hint: 'An email or WhatsApp message, or a short sequence of them.' },
		'Set lead status': { icon: 'flag', text: 'Change the lead\'s status', hint: 'Move the lead to another status.' },
		'Create a follow-up': { icon: 'phone', text: 'Create a follow-up', hint: 'A reminder for the lead\'s owner to get in touch.' },
		'Add a note to the lead': { icon: 'edit', text: 'Add a note', hint: 'Leave a note on the lead\'s timeline.' },
	}
	const safeJson = (s, d) => { try { return typeof s === 'string' ? JSON.parse(s || 'null') ?? d : s ?? d } catch (e) { return d } }
	const hhmm = (v, d) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '')); return m ? m[1].padStart(2, '0') + ':' + m[2] : d }
	const newStep = (channel, day = 0) => ({ uid: CM.uid(), channel, day_offset: day, condition: '', email_template: '', wa_template: '', wa_account: '', variable_map: {}, wa_attach: '', attachments: [] })
	const tzList = () => { try { return Intl.supportedValuesOf('timeZone') } catch (e) { return ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York'] } }

	// ------------------------------------------------------------------ the list
	V.AutomationList = {
		setup() {
			const rows = ref([]); const loading = ref(true); const error = ref(''); const q = ref(''); const busy = ref('')
			let seq = 0
			async function load() {
				const my = ++seq; loading.value = true; error.value = ''
				try { const r = await CM.auto('list_automations', { search: q.value }); if (my === seq) rows.value = r } catch (e) { if (my === seq) error.value = e.message } finally { if (my === seq) loading.value = false }
			}
			const debounced = CM.debounce(load, 300)
			watch(q, debounced)
			onMounted(() => { CM.loadShared(); load() })
			onBeforeUnmount(() => debounced.cancel())
			async function toggle(r) {
				busy.value = r.name
				try { const out = await CM.auto('set_enabled', { name: r.name, enabled: r.enabled ? 0 : 1 }); Object.assign(r, out); CM.toast(out.enabled ? 'Automation is on' : 'Automation is off') } catch (e) { CM.toast(e.message, 'err', 8000) } finally { busy.value = '' }
			}
			async function dup(r) { try { const d = await CM.auto('duplicate_automation', { name: r.name }); CM.toast('Copied. It starts off.'); CM.go('/automations/edit/' + encodeURIComponent(d.name)) } catch (e) { CM.toast(e.message, 'err') } }
			async function del(r) {
				if (!(await CM.confirm({ title: 'Delete "' + r.automation_name + '"?', message: r.runs ? 'It stops now. Messages it already sent stay in the Campaign Manager reports, and notes and follow-ups it made stay on the leads.' : 'It has not run for any lead yet.', confirmText: 'Delete automation', danger: true }))) return
				try { await CM.auto('delete_automation', { name: r.name }); CM.toast('Automation deleted'); load() } catch (e) { CM.toast(e.message, 'err') }
			}
			const menu = (r) => [{ label: 'Edit', icon: 'edit', run: () => CM.go('/automations/edit/' + encodeURIComponent(r.name)) }, r.campaign && { label: 'Messages and results', icon: 'chart', run: () => CM.go('/c/' + encodeURIComponent(r.campaign)) }, { label: 'Duplicate', icon: 'copy', run: () => dup(r) }, { sep: true }, { label: 'Delete', icon: 'trash', danger: true, run: () => del(r) }].filter(Boolean)
			const PRESETS = [
				{ key: 'welcome', icon: 'users', title: 'Welcome every new lead', text: 'When a lead is created, send them a first email.' },
				{ key: 'reply', icon: 'inbox', title: 'Follow up when a lead replies', text: 'Create a follow-up for the owner the day after a reply.' },
				{ key: 'click', icon: 'link', title: 'Act on interest', text: 'When a lead clicks a link, change their status and remind the owner.' },
			]
			return { rows, loading, error, q, busy, load, toggle, menu, PRESETS, ACTION_INFO, CM, go: CM.go }
		},
		template: `
		<div class="page">
			<div class="pg-head"><div class="grow"><h1>Automations</h1><p>Do things for you when something happens to a lead: send messages, change a status, create a follow-up. Each lead goes through an automation once.</p></div><div class="actions"><Btn variant="primary" icon="plus" @click="go('/automations/new')">Create automation</Btn></div></div>
			<div v-if="rows.length || q" class="row wrap tool"><div style="width:280px;max-width:100%"><Inp v-model="q" icon="search" placeholder="Search automations" clearable aria-label="Search automations" /></div></div>
			<div v-if="loading" class="card pad col"><Skel v-for="n in 3" :key="n" h="64" /></div>
			<ErrorState v-else-if="error" :message="error" @retry="load" />
			<template v-else-if="!rows.length && !q">
				<div class="card pad auto-start"><div class="grow"><h3>Start from an idea</h3><p class="small muted">Pick one, adjust it, and turn it on. You can change everything.</p></div></div>
				<div class="auto-presets"><button v-for="p in PRESETS" :key="p.key" type="button" class="card hover auto-preset" @click="go('/automations/new?preset=' + p.key)"><span class="mi"><Ico :name="p.icon" size="lg" /></span><b>{{ p.title }}</b><span class="small muted">{{ p.text }}</span></button></div>
			</template>
			<Empty v-else-if="!rows.length" icon="search" title="No automation matches" text="Try another word." />
			<div v-else class="col" style="gap:10px">
				<article v-for="r in rows" :key="r.name" class="card auto-row" :class="{ off: !r.enabled }">
					<button type="button" class="sw" :class="{ on: r.enabled }" role="switch" :aria-checked="!!r.enabled" :aria-label="(r.enabled ? 'Turn off ' : 'Turn on ') + r.automation_name" :disabled="busy === r.name" @click="toggle(r)"><span class="sw-k"></span></button>
					<div class="grow auto-main" role="link" tabindex="0" @click="go('/automations/edit/' + encodeURIComponent(r.name))" @keydown.enter="go('/automations/edit/' + encodeURIComponent(r.name))">
						<div class="row" style="gap:8px"><b class="ellipsis">{{ r.automation_name }}</b><span v-if="!r.enabled" class="badge neutral nodot">Off</span><span v-else-if="r.campaign_status === 'Paused'" class="badge amber nodot">Messages paused</span></div>
						<div class="small muted"><b>When</b> {{ r.trigger.charAt(0).toLowerCase() + r.trigger.slice(1) }}<span v-if="r.has_conditions"> and the lead matches your conditions</span></div>
						<div class="row wrap" style="gap:6px;margin-top:6px"><span v-for="(a, i) in r.actions" :key="i" class="tchip"><Ico :name="ACTION_INFO[a.action].icon" size="sm" /> {{ a.text }}</span></div>
					</div>
					<div class="auto-stats"><div><b>{{ CM.num(r.runs) }}</b><span>leads</span></div><div><b>{{ CM.num(r.runs_7d) }}</b><span>last 7 days</span></div><div v-if="r.campaign"><b>{{ CM.num(r.messaged) }}</b><span>messaged</span></div></div>
					<Menu :items="menu(r)" />
				</article>
			</div>
		</div>`,
	}

	// ------------------------------------------------------------------ the editor
	V.AutomationEditor = {
		props: { name: String },
		setup(props) {
			const route = CM.route
			const id = ref(props.name || null); const loading = ref(!!props.name); const loadError = ref('')
			const saving = ref(false); const dirty = ref(false); const tried = ref(false); const status = ref('')
			const form = reactive({ automation_name: '', description: '', trigger_event: 'Lead created', trigger_status: '', trigger_campaign: '', enabled: false, consent_confirmed: false, stop_on_reply: false, track_clicks: true, window_enabled: false, window_start: '09:00', window_end: '18:00', window_weekdays_only: false, timezone: '' })
			const a = reactive({ mode: 'CRM Filters', rules: [], saved_view: '', selected: [] })
			const actions = reactive([]); const steps = reactive([])
			const condOpen = ref(false); const moreOpen = ref(false)
			const sel = ref('when') // which step of the flow is open on the right: 'when', 'cond' or an action's uid
			const campaigns = ref([]); const waTemplates = ref([]); const waLoaded = ref(false)
			const pickFor = ref(null); const editTpl = reactive({ open: false, name: '', mode: '', index: -1 }); const previewTpl = ref(null)
			const cfg = computed(() => CM.shared.config || {})
			const statuses = computed(() => cfg.value.lead_statuses || [])
			const isMessageEvent = computed(() => !['Lead created', 'Lead status changed'].includes(form.trigger_event))
			const sends = computed(() => actions.some((x) => x.action === 'Send messages'))
			const channelsUsed = computed(() => ['Email', 'WhatsApp'].filter((c) => steps.some((s) => s.channel === c)))
			const hasWa = computed(() => channelsUsed.value.includes('WhatsApp'))
			const needsConsent = computed(() => hasWa.value && cfg.value.consent_mode === 'Require opt-in')
			const newAction = (action, value = '') => ({ uid: CM.uid(), action, value })
			const loadWa = async () => { if (waLoaded.value) return; try { waTemplates.value = (await CM.api('list_whatsapp_templates', {})).rows; waLoaded.value = true } catch (e) { /* shown in the step */ } }

			async function init() {
				await CM.loadShared(); form.timezone = 'Asia/Kolkata'; loadWa()
				try { campaigns.value = (await CM.api('list_campaigns', { page_length: 100 })).rows } catch (e) { /* the scope list stays empty */ }
				if (props.name) {
					try {
						const d = await CM.auto('get_automation', { name: props.name })
						Object.assign(form, { automation_name: d.automation_name, description: d.description || '', trigger_event: d.trigger_event, trigger_status: d.trigger_status || '', trigger_campaign: d.trigger_campaign || '', enabled: !!d.enabled, consent_confirmed: !!d.consent_confirmed, stop_on_reply: !!d.stop_on_reply, track_clicks: d.track_clicks === undefined ? true : !!d.track_clicks, window_enabled: !!d.window_enabled, window_start: hhmm(d.window_start, '09:00'), window_end: hhmm(d.window_end, '18:00'), window_weekdays_only: !!d.window_weekdays_only, timezone: d.timezone || form.timezone })
						a.mode = d.audience_mode || 'CRM Filters'; a.saved_view = d.saved_view || ''; a.rules = CM.audience.rulesFromJson(d.audience_filters)
						condOpen.value = a.rules.length > 0 || a.mode === 'Saved Segment'
						actions.splice(0, actions.length, ...d.actions.map((x) => newAction(x.action, x.value || '')))
						steps.splice(0, steps.length, ...d.steps.map((s) => ({ uid: CM.uid(), channel: s.channel, day_offset: s.day_offset || 0, condition: s.condition || '', email_template: s.email_template || '', wa_template: s.wa_template || '', wa_account: s.wa_account || '', variable_map: safeJson(s.variable_map, {}), wa_attach: s.wa_attach || '', attachments: safeJson(s.attachments, []).map((u) => ({ file_url: u, file_name: String(u).split('/').pop(), file_size: 0 })) })))
						status.value = d.enabled ? (d.campaign_status === 'Paused' ? 'Messages paused' : 'On') : 'Off'
					} catch (e) { loadError.value = e.message } finally { loading.value = false }
				} else {
					const p = route.query.preset
					if (p === 'welcome') { form.automation_name = 'Welcome new leads'; form.trigger_event = 'Lead created'; actions.push(newAction('Send messages')); steps.push(newStep('Email')) }
					else if (p === 'reply') { form.automation_name = 'Follow up when a lead replies'; form.trigger_event = 'Lead replied'; actions.push(newAction('Create a follow-up', '1'), newAction('Add a note to the lead', 'Replied to a campaign message')) }
					else if (p === 'click') { form.automation_name = 'Act on interest'; form.trigger_event = 'Lead clicked a link'; actions.push(newAction('Set lead status', statuses.value.find((s) => /interest/i.test(s)) || ''), newAction('Create a follow-up', '1')) }
					else actions.push(newAction('Add a note to the lead'))
				}
				dirty.value = false
			}
			onMounted(() => { init(); window.addEventListener('beforeunload', warn) })
			onBeforeUnmount(() => window.removeEventListener('beforeunload', warn))
			const warn = (e) => { if (dirty.value) { e.preventDefault(); e.returnValue = '' } }
			watch([form, a, actions, steps], () => { if (!loading.value) dirty.value = true }, { deep: true })
			watch(() => form.trigger_event, (v) => { if (!isMessageEvent.value) form.trigger_campaign = ''; if (v !== 'Lead status changed') form.trigger_status = '' })

			// ---- actions
			const addMenu = computed(() => Object.keys(ACTION_INFO).filter((k) => k !== 'Send messages' || !sends.value).map((k) => ({ label: ACTION_INFO[k].text, icon: ACTION_INFO[k].icon, run: () => addActionAndOpen(k) })))
			function addAction(k) { actions.push(newAction(k)); if (k === 'Send messages' && !steps.length) steps.push(newStep('Email')) }
			function removeAction(i) { actions.splice(i, 1) }
			function moveAction(i, d) { const j = i + d; if (j < 0 || j >= actions.length) return; actions.splice(j, 0, actions.splice(i, 1)[0]) }
			const actionError = (x) => (x.action === 'Set lead status' && !x.value ? 'Choose a status.' : x.action === 'Create a follow-up' && !(String(x.value).trim() !== '' && Number(x.value) >= 0 && Number(x.value) <= 365) ? 'Enter the days (0 to 365).' : x.action === 'Add a note to the lead' && !String(x.value).trim() ? 'Write the note.' : '')

			// ---- the message steps (same pieces as a campaign)
			function toggleChannel(ch) {
				if (steps.some((s) => s.channel === ch)) { for (let i = steps.length - 1; i >= 0; i--) if (steps[i].channel === ch) steps.splice(i, 1) } else steps.push(newStep(ch))
				steps.sort((x, y) => x.day_offset - y.day_offset)
			}
			function addFollowUp(ch) { const day = steps.length ? Math.max(...steps.map((s) => Number(s.day_offset) || 0)) + 2 : 0; const s = newStep(ch, day); s.condition = 'Previous step was not read or opened'; steps.push(s) }
			async function removeStep(i) { if (await CM.confirm({ title: 'Remove this message?', message: 'It is removed from the sequence.', confirmText: 'Remove', danger: true })) steps.splice(i, 1) }
			const chooseTemplate = (i) => { pickFor.value = i }
			function picked(t) { steps[pickFor.value].email_template = t.name; CM.tplCache[t.name] = t; pickFor.value = null }
			function createTemplate(i) { editTpl.index = i; editTpl.name = ''; editTpl.mode = 'builder'; editTpl.open = true; pickFor.value = null }
			function editTemplate(i) { editTpl.index = i; editTpl.name = steps[i].email_template; editTpl.mode = ''; editTpl.open = true }
			function tplSaved(n) { delete CM.tplCache[n]; if (editTpl.index >= 0 && !steps[editTpl.index].email_template) steps[editTpl.index].email_template = n; editTpl.name = n; CM.getEmailTemplate(n) }
			const stepIncomplete = (s) => (s.channel === 'Email' ? !s.email_template : !s.wa_template || (waTemplates.value.find((t) => t.name === s.wa_template) || { placeholders: [] }).placeholders.some((p) => !String(s.variable_map[p] || '').trim()))

			// ---- checks and saving
			const errs = computed(() => ({
				name: form.automation_name.trim() ? '' : 'Give the automation a name so you can find it later.',
				actions: !actions.length ? 'Add at least one thing for it to do.' : (actions.map((x) => actionError(x)).find(Boolean) || ''),
				messages: sends.value && (!steps.length || steps.some(stepIncomplete)) ? 'Complete every message.' : '',
				window: form.window_enabled && form.window_start >= form.window_end ? 'The sending hours must end after they begin.' : '',
				segment: a.mode === 'Saved Segment' && condOpen.value && !a.saved_view ? 'Choose a saved segment, or use filters.' : '',
			}))
			const firstError = computed(() => errs.value.name || errs.value.actions || errs.value.messages || errs.value.window || errs.value.segment)
			function payload(enable) {
				const useCond = condOpen.value
				return {
					automation_name: form.automation_name.trim(), description: form.description, trigger_event: form.trigger_event, trigger_status: form.trigger_event === 'Lead status changed' ? form.trigger_status : '', trigger_campaign: isMessageEvent.value ? form.trigger_campaign : '',
					audience_mode: useCond ? a.mode : 'CRM Filters', saved_view: useCond && a.mode === 'Saved Segment' ? a.saved_view : '', audience_filters: useCond && a.mode === 'CRM Filters' ? CM.audience.rulesToJson(a.rules) : '[]',
					consent_confirmed: form.consent_confirmed ? 1 : 0, stop_on_reply: form.stop_on_reply ? 1 : 0, track_clicks: form.track_clicks ? 1 : 0, window_enabled: form.window_enabled ? 1 : 0, window_start: form.window_start + ':00', window_end: form.window_end + ':00', window_weekdays_only: form.window_weekdays_only ? 1 : 0, timezone: form.timezone,
					enabled: enable === undefined ? (form.enabled ? 1 : 0) : enable ? 1 : 0,
					actions: actions.map((x) => ({ action: x.action, value: x.action === 'Send messages' ? '' : String(x.value == null ? '' : x.value).trim() })),
					steps: sends.value ? steps.map((s) => ({ channel: s.channel, day_offset: Number(s.day_offset) || 0, condition: s.condition || '', email_template: s.channel === 'Email' ? s.email_template : '', wa_template: s.channel === 'WhatsApp' ? s.wa_template : '', wa_account: s.wa_account || '', variable_map: s.channel === 'WhatsApp' ? JSON.stringify(s.variable_map) : '', wa_attach: s.channel === 'WhatsApp' ? s.wa_attach : '', attachments: s.channel === 'Email' ? JSON.stringify(s.attachments.map((f) => f.file_url)) : '' })) : [],
				}
			}
			async function save(enable) {
				tried.value = true
				if (firstError.value) { CM.toast(firstError.value, 'warn'); return false }
				saving.value = true
				try {
					const d = await CM.auto('save_automation', { data: payload(enable), name: id.value || undefined })
					id.value = d.name; form.enabled = !!d.enabled; dirty.value = false; status.value = d.enabled ? 'On' : 'Off'
					if (!props.name && location.hash.indexOf('/automations/new') >= 0) history.replaceState(null, '', '#/automations/edit/' + encodeURIComponent(d.name))
					CM.toast(enable ? 'Saved and turned on' : 'Saved')
					return true
				} catch (e) { CM.toast(e.message, 'err', 9000); return false } finally { saving.value = false }
			}
			async function leave() {
				if (dirty.value && !(await CM.confirm({ title: 'Leave without saving?', message: 'Your changes are not saved yet.', confirmText: 'Leave' }))) return
				dirty.value = false; CM.go('/automations')
			}
			const selAction = computed(() => actions.find((x) => x.uid === sel.value) || null)
			watch(() => actions.length, () => { if (sel.value !== 'when' && sel.value !== 'cond' && !selAction.value) sel.value = actions.length ? actions[actions.length - 1].uid : 'when' })
			const whenText = computed(() => {
				const e = form.trigger_event
				if (e === 'Lead status changed') return form.trigger_status ? 'Status changes to ' + form.trigger_status : 'A lead\'s status changes'
				return eventLabel(e)
			})
			const condText = computed(() => (!condOpen.value ? 'Every lead' : a.mode === 'Saved Segment' ? (a.saved_view ? 'Saved segment' : 'Choose a segment') : a.rules.length ? a.rules.length + (a.rules.length > 1 ? ' filters' : ' filter') : 'Every lead'))
			const actionText = (x) => (x.action === 'Send messages' ? (steps.length ? steps.length + (steps.length > 1 ? ' messages' : ' message') + ' (' + (channelsUsed.value.join(' + ') || 'choose a channel') + ')' : 'Choose the messages') : x.action === 'Set lead status' ? 'Status: ' + (x.value || 'choose one') : x.action === 'Create a follow-up' ? 'In ' + (x.value === '' ? '...' : x.value) + ' day(s)' : x.value ? '"' + String(x.value).slice(0, 34) + '"' : 'Write the note')
			function addActionAndOpen(k) { addAction(k); sel.value = actions[actions.length - 1].uid }
			function removeSelected() { const i = actions.findIndex((x) => x.uid === sel.value); if (i >= 0) { actions.splice(i, 1); sel.value = actions.length ? actions[Math.max(0, i - 1)].uid : 'when' } }
			const nodeBad = (key) => tried.value && (key === 'when' ? false : key === 'cond' ? !!errs.value.segment : (() => { const x = actions.find((y) => y.uid === key); return !!x && (!!actionError(x) || (x.action === 'Send messages' && (!!errs.value.messages || !!errs.value.window))) })())
			const tzOptions = computed(() => tzList().map((z) => ({ value: z, label: z.replace(/_/g, ' ') })))
			const eventLabel = (k) => { for (const g of GROUPS) { const e = g.events.find((x) => x[0] === k); if (e) return e[1] } return k }
			const campaignOptions = computed(() => [{ value: '', label: 'Any campaign' }, ...campaigns.value.map((c) => ({ value: c.name, label: c.campaign_name }))])
			return { sel, selAction, whenText, condText, actionText, removeSelected, nodeBad, id, loading, loadError, saving, dirty, tried, status, form, a, actions, steps, condOpen, moreOpen, campaigns, waTemplates, pickFor, editTpl, previewTpl, cfg, statuses, isMessageEvent, sends, channelsUsed, hasWa, needsConsent, addMenu, addAction, removeAction, moveAction, actionError, toggleChannel, addFollowUp, removeStep, chooseTemplate, picked, createTemplate, editTemplate, tplSaved, errs, firstError, save, leave, tzOptions, eventLabel, campaignOptions, GROUPS, ACTION_INFO, CM, init, go: CM.go }
		},
		template: `
		<div class="page auto-ed">
			<div v-if="loading" class="col"><Skel w="260" h="30" /><Skel h="120" r="12" /><Skel h="200" r="12" /></div>
			<ErrorState v-else-if="loadError" :message="loadError" @retry="init" />
			<template v-else>
				<header class="ae-bar">
					<Btn variant="ghost" icon="arrow-left" aria-label="Back to automations" @click="leave" />
					<div class="ae-name"><input v-model="form.automation_name" maxlength="140" placeholder="Name this automation" aria-label="Automation name" :class="{ bad: tried && errs.name }" /><div v-if="tried && errs.name" class="err small">{{ errs.name }}</div></div>
					<span v-if="status" class="badge nodot" :class="status === 'On' ? 'green' : status === 'Off' ? 'neutral' : 'amber'">{{ status }}</span><span v-if="dirty" class="small faint">Not saved</span>
					<span class="grow"></span>
					<Btn @click="leave">Cancel</Btn><Btn :loading="saving" icon="save" @click="save()">Save</Btn><Btn v-if="!form.enabled" variant="primary" :loading="saving" icon="zap" @click="save(true)">Save and turn on</Btn>
				</header>

				<div class="flow-grid">
					<nav class="flow" aria-label="What the automation does">
						<button type="button" class="fnode" :class="{ on: sel === 'when' }" @click="sel = 'when'"><span class="fi"><Ico name="flag" /></span><span class="ft"><b>When</b><span>{{ whenText }}</span></span></button>
						<i class="fline"></i>
						<button type="button" class="fnode soft" :class="{ on: sel === 'cond', bad: nodeBad('cond') }" @click="sel = 'cond'"><span class="fi"><Ico name="filter" /></span><span class="ft"><b>Only if</b><span>{{ condText }}</span></span></button>
						<template v-for="(x, i) in actions" :key="x.uid">
							<i class="fline"></i>
							<button type="button" class="fnode" :class="{ on: sel === x.uid, bad: nodeBad(x.uid) }" @click="sel = x.uid"><span class="fi act"><Ico :name="ACTION_INFO[x.action].icon" /></span><span class="ft"><b>{{ i === 0 ? 'Then' : 'And then' }}</b><span>{{ ACTION_INFO[x.action].text }}<em>{{ actionText(x) }}</em></span></span></button>
						</template>
						<i class="fline"></i>
						<Menu align="left" :items="addMenu"><button type="button" class="fadd"><Ico name="plus" size="sm" /> Add a step</button></Menu>
						<p v-if="tried && errs.actions && !actions.length" class="err small" style="margin:8px 0 0">{{ errs.actions }}</p>
					</nav>

					<section class="fpanel card">
						<!-- when -->
						<template v-if="sel === 'when'">
							<div class="fp-h"><div class="grow"><h2>When this happens</h2><p>The event that starts the automation, for one lead at a time.</p></div></div>
							<div v-for="g in GROUPS" :key="g.title" class="ae-grp"><div class="lbl">{{ g.title }}</div><div class="ae-evs"><button v-for="e in g.events" :key="e[0]" type="button" class="ae-ev" :class="{ on: form.trigger_event === e[0] }" :aria-pressed="form.trigger_event === e[0]" @click="form.trigger_event = e[0]"><Ico :name="e[2]" size="sm" />{{ e[1] }}</button></div></div>
							<div v-if="form.trigger_event === 'Lead status changed'" class="ae-sub"><Field label="Changed to" hint="Leave empty to start on any status change."><Dd v-model="form.trigger_status" :options="statuses" allow-empty="Any status" searchable /></Field></div>
							<div v-if="isMessageEvent" class="ae-sub"><Field label="For messages of" hint="A reply, click or opt-out counts when a message from a campaign reached the lead in the last 30 days."><Dd v-model="form.trigger_campaign" :options="campaignOptions" searchable /></Field></div>
						</template>

						<!-- only if -->
						<template v-else-if="sel === 'cond'">
							<div class="fp-h"><div class="grow"><h2>Only if the lead matches</h2><p>{{ condOpen ? 'The event decides who; these conditions narrow it down.' : 'No conditions: it runs for every lead the event happens to.' }}</p></div><Btn size="sm" :icon="condOpen ? 'x' : 'plus'" @click="condOpen = !condOpen">{{ condOpen ? 'Remove conditions' : 'Add conditions' }}</Btn></div>
							<AudienceBuilder v-if="condOpen" :a="a" :modes="['CRM Filters', 'Saved Segment']" :insight="false" />
							<div v-if="tried && errs.segment" class="alert err"><Ico name="alert" /><div class="grow">{{ errs.segment }}</div></div>
						</template>

						<!-- an action -->
						<template v-else-if="selAction">
							<div class="fp-h"><span class="ae-act-i"><Ico :name="ACTION_INFO[selAction.action].icon" /></span><div class="grow"><h2>{{ ACTION_INFO[selAction.action].text }}</h2><p>{{ ACTION_INFO[selAction.action].hint }}</p></div>
								<button type="button" class="btn ghost icon sm" :disabled="actions.indexOf(selAction) === 0" aria-label="Move earlier" @click="moveAction(actions.indexOf(selAction), -1)"><Ico name="arrow-up" /></button><button type="button" class="btn ghost icon sm" :disabled="actions.indexOf(selAction) === actions.length - 1" aria-label="Move later" @click="moveAction(actions.indexOf(selAction), 1)"><Ico name="arrow-down" /></button><button type="button" class="btn ghost icon sm" aria-label="Remove this step" @click="removeSelected"><Ico name="trash" /></button></div>
							<div v-if="selAction.action === 'Set lead status'"><Field label="Status" :error="tried && actionError(selAction)"><Dd v-model="selAction.value" :options="statuses" placeholder="Choose a status" searchable aria-label="Status" /></Field></div>
							<div v-else-if="selAction.action === 'Create a follow-up'"><Field label="Follow-up for the lead owner" :error="tried && actionError(selAction)"><div class="row" style="gap:8px"><span class="small muted">In</span><input class="inp" style="width:84px" type="number" min="0" max="365" v-model="selAction.value" aria-label="Days" /><span class="small muted">days from now</span></div></Field></div>
							<div v-else-if="selAction.action === 'Add a note to the lead'"><Field label="Note" :error="tried && actionError(selAction)"><input class="inp" v-model="selAction.value" maxlength="200" placeholder="Note to add on the lead" aria-label="Note" /></Field></div>
							<template v-else>
								<div class="chan-cards">
									<button type="button" class="mcard" :class="{ on: channelsUsed.includes('Email') }" :aria-pressed="channelsUsed.includes('Email')" @click="toggleChannel('Email')"><span class="mi email"><Ico name="mail" size="lg" /></span><span class="grow"><b>Email</b></span><Ico v-if="channelsUsed.includes('Email')" name="check-circle" class="tickc" /></button>
									<button type="button" class="mcard" :class="{ on: channelsUsed.includes('WhatsApp'), off: cfg.whatsapp && !cfg.whatsapp.installed }" :aria-pressed="channelsUsed.includes('WhatsApp')" :disabled="cfg.whatsapp && !cfg.whatsapp.installed" @click="toggleChannel('WhatsApp')"><span class="mi wa"><Ico name="whatsapp" size="lg" /></span><span class="grow"><b>WhatsApp</b><span class="small muted" style="display:block">{{ cfg.whatsapp && !cfg.whatsapp.installed ? 'frappe_whatsapp is not installed' : '' }}</span></span><Ico v-if="channelsUsed.includes('WhatsApp')" name="check-circle" class="tickc" /></button>
								</div>
								<div v-if="tried && errs.messages" class="alert err"><Ico name="alert" /><div class="grow">{{ errs.messages }}</div></div>
								<div class="col" style="gap:14px">
									<template v-for="(s, i) in steps" :key="s.uid">
										<EmailStep v-if="s.channel === 'Email'" :step="s" :index="i" :auto="true" :show-errors="tried" @remove="removeStep(i)" @pick="chooseTemplate(i)" @create="createTemplate(i)" @edit="editTemplate(i)" @preview="previewTpl = s.email_template" />
										<WaStep v-else :step="s" :index="i" :auto="true" :templates="waTemplates" :show-errors="tried" @remove="removeStep(i)" />
									</template>
								</div>
								<div v-if="steps.length" class="row wrap"><Menu v-if="channelsUsed.length > 1" align="left" :items="[{ label: 'Email follow-up', icon: 'mail', run: () => addFollowUp('Email') }, { label: 'WhatsApp follow-up', icon: 'whatsapp', run: () => addFollowUp('WhatsApp') }]"><Btn icon="plus">Add a follow-up message</Btn></Menu><Btn v-else icon="plus" @click="addFollowUp(channelsUsed[0])">Add a follow-up message</Btn></div>
								<details class="more" :open="moreOpen"><summary><Ico name="chevron-right" size="sm" /> Sending options</summary><div class="col" style="gap:14px;margin-top:12px">
									<label class="check"><input type="checkbox" v-model="form.window_enabled" /><span>Only send during these hours (Indian time)<span class="small muted" style="display:block">Anything due outside them waits until they open.</span></span></label>
									<div v-if="form.window_enabled" class="sched"><Field label="From" :error="tried && errs.window"><input class="inp" type="time" v-model="form.window_start" /></Field><Field label="Until"><input class="inp" type="time" v-model="form.window_end" /></Field><label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" v-model="form.window_weekdays_only" /><span>Monday to Friday only</span></label></div>
									<label v-if="channelsUsed.includes('Email')" class="check"><input type="checkbox" v-model="form.track_clicks" /><span>Track link clicks in emails</span></label>
									<label class="check"><input type="checkbox" v-model="form.stop_on_reply" :disabled="steps.length < 2" /><span>Stop the sequence for a lead who replies<span class="small muted" style="display:block">{{ steps.length < 2 ? 'Available with follow-up messages.' : 'Later messages are skipped once the lead writes back.' }}</span></span></label>
									<label v-if="needsConsent" class="check"><input type="checkbox" v-model="form.consent_confirmed" /><span>I confirm these leads agreed to receive WhatsApp messages<span class="small muted" style="display:block">Without this, only leads marked as opted in are messaged on WhatsApp.</span></span></label>
								</div></details>
							</template>
						</template>
					</section>
				</div>

				<TemplatePicker v-if="pickFor !== null" title="Choose an email template" subtitle="Shared templates, usable by every campaign and automation." :selected="steps[pickFor] && steps[pickFor].email_template" :allow-create="cfg.is_manager" @pick="picked" @create="createTemplate(pickFor)" @close="pickFor = null" />
				<TemplateEditor v-if="editTpl.open" embedded :name="editTpl.name || undefined" :mode="editTpl.mode" @saved="tplSaved" @close="editTpl.open = false" />
				<PreviewModal v-if="previewTpl" :title="previewTpl" :subject="(CM.tplCache[previewTpl] || {}).subject" :html="(CM.tplCache[previewTpl] || {}).body_html" @close="previewTpl = null" />
			</template>
		</div>`,
	}
})()
