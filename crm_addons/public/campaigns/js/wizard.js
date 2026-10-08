/* Campaign Manager: create / edit a campaign. Five guided steps with a live summary, draft autosave,
 * inline validation and a two-step confirmation before anything is sent. */
(() => {
	const { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue
	const CM = window.CM
	const C = CM.components
	const V = CM.views
	const A = () => CM.audience

	const STEPS = [
		{ key: 'details', title: 'Details', desc: 'Name your campaign' },
		{ key: 'audience', title: 'Audience', desc: 'Who receives it' },
		{ key: 'content', title: 'Channel and content', desc: 'What you send' },
		{ key: 'preview', title: 'Preview and test', desc: 'Check it first' },
		{ key: 'review', title: 'Schedule and review', desc: 'Send it' },
	]
	const TYPES = ['Marketing', 'Follow-up', 'Announcement', 'Reminder', 'Other']
	const newStep = (channel, day = 0) => ({ uid: CM.uid(), channel, day_offset: day, condition: '', email_template: '', wa_template: '', wa_account: '', variable_map: {}, wa_attach: '', attachments: [] })
	const pad = (n) => String(n).padStart(2, '0')
	const tzList = () => { try { return Intl.supportedValuesOf('timeZone') } catch (e) { return ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney'] } }

	V.CampaignWizard = {
		props: { name: String },
		setup(props) {
			const route = CM.route
			const id = ref(props.name || null); const loading = ref(!!props.name); const loadError = ref('')
			const step = ref(0); const reached = ref(props.name ? 4 : 0)
			const tried = reactive({ 0: false, 2: false, 4: false })
			const form = reactive({ campaign_name: '', campaign_type: 'Marketing', description: '', tags: '', notes: '', stop_on_reply: false, consent_confirmed: false, send_mode: 'Send Now', date: '', time: '09:00', timezone: '', status: 'Draft', track_clicks: true, window_enabled: false, window_start: '09:00', window_end: '18:00', window_weekdays_only: false, trigger_event: 'Lead created', trigger_status: '' })
			const rules = reactive([]) // lead updates: when a lead replies / clicks / ..., do this
			const newRule = () => ({ uid: CM.uid(), event: 'Replied', action: 'Add a note to the lead', value: '' })
			const addRule = () => rules.push(newRule())
			const isAuto = computed(() => form.send_mode === 'Trigger')
			const a = reactive({ mode: 'CRM Filters', rules: [], saved_view: '', selected: [] })
			const steps = reactive([])
			const result = ref(null) // audience insight (count + summary)
			const saving = ref(false); const savedAt = ref(''); const dirty = ref(false); const launching = ref(false)
			const waTemplates = ref([]); const waLoaded = ref(false)
			const pickFor = ref(null); const editTpl = reactive({ open: false, name: '', mode: '', index: -1 }); const previewTpl = ref(null)
			const confirmOpen = ref(false); const done = ref(null); const advanced = ref(false)
			const cfg = computed(() => CM.shared.config || {})
			const channelsUsed = computed(() => ['Email', 'WhatsApp'].filter((c) => steps.some((s) => s.channel === c)))
			const hasWa = computed(() => channelsUsed.value.includes('WhatsApp'))
			const needsConsent = computed(() => hasWa.value && cfg.value.consent_mode === 'Require opt-in')

			// ------------------------------------------------------------ load an existing draft / start from a shortcut
			async function init() {
				await CM.loadShared()
				form.timezone = 'Asia/Kolkata'
				loadWa()
				if (props.name) {
					try {
						const d = await CM.api('get_campaign', { name: props.name })
						if (!['Draft', 'Scheduled'].includes(d.status)) { CM.go('/c/' + encodeURIComponent(props.name)); return }
						Object.assign(form, { campaign_name: d.campaign_name, campaign_type: d.campaign_type || 'Marketing', description: d.description || '', tags: d.tags || '', notes: d.notes || '', stop_on_reply: !!d.stop_on_reply, consent_confirmed: !!d.consent_confirmed, send_mode: d.send_mode || 'Send Now', timezone: d.timezone || form.timezone, status: d.status, track_clicks: d.track_clicks === undefined ? true : !!d.track_clicks, window_enabled: !!d.window_enabled, window_start: hhmm(d.window_start, '09:00'), window_end: hhmm(d.window_end, '18:00'), window_weekdays_only: !!d.window_weekdays_only, trigger_event: d.trigger_event || 'Lead created', trigger_status: d.trigger_status || '' })
						rules.splice(0, rules.length, ...(d.rules || []).map((r) => ({ uid: CM.uid(), event: r.event, action: r.action, value: r.value || '' })))
						if (d.scheduled_at) { const x = String(d.scheduled_at).replace(' ', 'T'); form.date = x.slice(0, 10); form.time = x.slice(11, 16) }
						a.mode = d.audience_mode || 'CRM Filters'; a.saved_view = d.saved_view || ''
						a.rules = A().rulesFromJson(d.audience_filters)
						try { a.selected = JSON.parse(d.selected_records || '[]') } catch (e) { a.selected = [] }
						steps.splice(0, steps.length, ...d.steps.map((s) => ({ uid: CM.uid(), channel: s.channel, day_offset: s.day_offset || 0, condition: s.condition || '', email_template: s.email_template || '', wa_template: s.wa_template || '', wa_account: s.wa_account || '', variable_map: safeJson(s.variable_map, {}), wa_attach: s.wa_attach || '', attachments: safeJson(s.attachments, []).map((u) => ({ file_url: u, file_name: String(u).split('/').pop(), file_size: 0 })) })))
						const want = Number(route.query.step); if (want >= 1 && want <= 5) step.value = want - 1
					} catch (e) { loadError.value = e.message } finally { loading.value = false }
				} else {
					if (route.query.segment) { a.mode = 'Saved Segment'; a.saved_view = route.query.segment; try { const seg = (await CM.api('list_segments', { with_counts: 0 })).find((x) => x.name === route.query.segment); if (seg) form.campaign_name = seg.label + ' campaign' } catch (e) { /* the audience step shows the segment list */ } }
					if (route.query.wa) { steps.push(newStep('WhatsApp')); await loadWa(); const t = waTemplates.value.find((x) => x.name === route.query.wa); if (t) { steps[0].wa_template = t.name; const m = {}; t.placeholders.forEach((p, i) => (m[p] = ['{{ first_name }}', '{{ owner_name }}'][i] || '')); steps[0].variable_map = m }; form.campaign_name = form.campaign_name || (t ? t.template_name.replace(/_/g, ' ') + ' campaign' : '') }
				}
				await nextTick(); dirty.value = false
				if (props.name) refreshAudience()
			}
			const hhmm = (v, d) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(v || '')); return m ? m[1].padStart(2, '0') + ':' + m[2] : d }
			const safeJson = (s, d) => { try { return typeof s === 'string' ? JSON.parse(s || 'null') ?? d : s ?? d } catch (e) { return d } }
			async function loadWa() { if (waLoaded.value) return; try { const r = await CM.api('list_whatsapp_templates', {}); waTemplates.value = r.rows; waLoaded.value = true } catch (e) { /* shown in the step */ } }
			onMounted(() => { init(); window.addEventListener('beforeunload', warn); autosaveTimer = setInterval(() => { if (dirty.value && form.campaign_name.trim() && !saving.value && !done.value && !loading.value) save(true) }, 30000) })
			let autosaveTimer
			// closing the CRM pop-up keeps the work: a named draft with unsaved changes is saved first
			const closeGuard = async () => { if (dirty.value && !done.value && form.campaign_name.trim()) await save(true); return true }
			onMounted(() => CM.closeGuards.add(closeGuard))
			onBeforeUnmount(() => { window.removeEventListener('beforeunload', warn); clearInterval(autosaveTimer); CM.closeGuards.delete(closeGuard) })
			const warn = (e) => { if (dirty.value && !done.value) { e.preventDefault(); e.returnValue = '' } }
			watch([form, a, steps, rules], () => { if (!loading.value) dirty.value = true }, { deep: true })

			// the summary panel and the review need the audience numbers on every step, not just on the audience step
			let aseq = 0
			async function refreshAudience() {
				if (step.value === 1 || !A().ready(a) || (a.mode === 'Selected Records' && !a.selected.length)) return
				const my = ++aseq
				try { const r = await CM.apiLatest('audience', 'audience_insight', { definition: A().definition(a), channels: ['Email', 'WhatsApp'], consent_confirmed: form.consent_confirmed ? 1 : 0, start: 0, page_length: 1, with_summary: 1 }); if (my === aseq && step.value !== 1) result.value = { count: r.count, summary: r.summary } } catch (e) { /* the audience step shows the error */ }
			}
			watch(step, (v, old) => { if (old === 1 && v !== 1) { /* the audience step already reported */ } else if (v !== 1 && !result.value) refreshAudience() })

			// ------------------------------------------------------------ save
			function payload() {
				const p = {
					campaign_name: form.campaign_name.trim(), campaign_type: form.campaign_type, description: form.description, tags: form.tags, notes: form.notes,
					audience_mode: a.mode, audience_filters: a.mode === 'CRM Filters' ? A().rulesToJson(a.rules) : '[]', selected_records: JSON.stringify(a.mode === 'Selected Records' ? a.selected : []), saved_view: a.mode === 'Saved Segment' ? a.saved_view : '',
					consent_confirmed: form.consent_confirmed ? 1 : 0, stop_on_reply: form.stop_on_reply ? 1 : 0, send_mode: form.send_mode, timezone: form.timezone,
					scheduled_at: form.send_mode === 'Schedule' && form.date ? `${form.date} ${form.time || '09:00'}:00` : null,
					track_clicks: form.track_clicks ? 1 : 0, window_enabled: form.window_enabled ? 1 : 0, window_start: form.window_start + ':00', window_end: form.window_end + ':00', window_weekdays_only: form.window_weekdays_only ? 1 : 0,
					trigger_event: isAuto.value ? form.trigger_event : '', trigger_status: isAuto.value && form.trigger_event === 'Lead status changed' ? form.trigger_status : '',
					rules: rules.filter((r) => r.event && r.action).map((r) => ({ event: r.event, action: r.action, value: String(r.value == null ? '' : r.value).trim() })),
					steps: steps.map((s) => ({ channel: s.channel, day_offset: Number(s.day_offset) || 0, condition: s.condition || '', email_template: s.channel === 'Email' ? s.email_template : '', wa_template: s.channel === 'WhatsApp' ? s.wa_template : '', wa_account: s.wa_account || '', variable_map: s.channel === 'WhatsApp' ? JSON.stringify(s.variable_map) : '', wa_attach: s.channel === 'WhatsApp' ? s.wa_attach : '', attachments: s.channel === 'Email' ? JSON.stringify(s.attachments.map((f) => f.file_url)) : '' })),
				}
				return p
			}
			async function save(silent) {
				if (!form.campaign_name.trim()) { if (!silent) CM.toast('Name the campaign first.', 'warn'); return false }
				if (saving.value) return false
				saving.value = true
				try {
					const d = await CM.api('save_campaign', { data: payload(), name: id.value || undefined })
					if (!id.value) { id.value = d.name; history.replaceState(null, '', '#/campaigns/edit/' + encodeURIComponent(d.name)) }
					savedAt.value = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); dirty.value = false
					if (!silent) CM.toast('Draft saved')
					return true
				} catch (e) { CM.toast(e.message, silent ? 'warn' : 'err'); return false } finally { saving.value = false }
			}

			// ------------------------------------------------------------ validation per step
			const errs = computed(() => ({
				name: form.campaign_name.trim() ? '' : 'Give your campaign a name so you can find it later.',
				audience: isAuto.value && a.mode === 'Selected Records' ? 'An automatic campaign needs filters or a saved segment, not a hand-picked list.' : !isAuto.value && result.value && result.value.count === 0 ? 'No leads match yet. Adjust the audience to continue.' : !A().ready(a) ? 'Finish the audience first.' : a.mode === 'Selected Records' && !a.selected.length ? 'Pick at least one lead.' : '',
				content: !steps.length ? 'Choose at least one channel.' : steps.some((s) => (s.channel === 'Email' ? !s.email_template : !s.wa_template || (waTemplates.value.find((t) => t.name === s.wa_template) || { placeholders: [] }).placeholders.some((p) => !String(s.variable_map[p] || '').trim()))) ? 'Complete every message.' : '',
				schedule: form.send_mode === 'Schedule' ? (!form.date || !form.time ? 'Choose a date and time.' : new Date(`${form.date}T${form.time}`) <= new Date() ? 'Choose a time in the future.' : '') : isAuto.value && !form.trigger_event ? 'Choose what starts the campaign for a lead.' : '',
				window: form.window_enabled && (!form.window_start || !form.window_end || form.window_start >= form.window_end) ? 'The sending hours must end after they begin.' : '',
				rules: rules.map((r, i) => (r.action === 'Set lead status' && !r.value ? `Update ${i + 1}: choose a status.` : r.action === 'Create a follow-up' && !(Number(r.value) >= 0 && Number(r.value) <= 365 && String(r.value).trim() !== '') ? `Update ${i + 1}: enter the days (0 to 365) until the follow-up.` : r.action === 'Add a note to the lead' && !String(r.value).trim() ? `Update ${i + 1}: write the note.` : '')).find(Boolean) || '',
			}))
			const stepOk = (i) => (i === 0 ? !errs.value.name : i === 1 ? !errs.value.audience : i === 2 ? !errs.value.content : i === 3 ? true : !errs.value.schedule && !errs.value.window && !errs.value.rules)
			async function go(i) {
				if (i > step.value) { for (let k = step.value; k < i; k++) if (!stepOk(k)) { tried[k] = true; step.value = k; CM.toast(([errs.value.name, errs.value.audience, errs.value.content][k]) || 'Complete this step first.', 'warn'); return } }
				if (i !== step.value && form.campaign_name.trim() && dirty.value) await save(true)
				step.value = i; reached.value = Math.max(reached.value, i); CM.scrollTop()
			}
			const next = () => go(step.value + 1)
			const back = () => go(step.value - 1)
			async function leave() {
				if (dirty.value && !done.value) {
					const ok = await CM.confirm({ title: 'Leave without saving?', message: form.campaign_name.trim() ? 'Your latest changes are not saved yet. Save them as a draft, or discard them.' : 'This campaign has no name yet, so it was not saved.', confirmText: form.campaign_name.trim() ? 'Save draft and leave' : 'Discard and leave' })
					if (!ok) return
					if (form.campaign_name.trim()) await save(true)
				}
				dirty.value = false; CM.go(id.value ? '/c/' + encodeURIComponent(id.value) : '/campaigns')
			}

			// ------------------------------------------------------------ channels and steps
			function toggleChannel(ch) {
				const has = steps.some((s) => s.channel === ch)
				if (has) { const idx = steps.map((s, i) => (s.channel === ch ? i : -1)).filter((i) => i >= 0).reverse(); idx.forEach((i) => steps.splice(i, 1)) }
				else { const lastDay = steps.length ? steps[steps.length - 1].day_offset : 0; steps.push(newStep(ch, steps.length ? 0 : 0)); if (steps.length > 1 && steps[0].channel !== ch) steps[steps.length - 1].day_offset = 0 }
				if (!steps.length) return
				steps.sort((x, y) => x.day_offset - y.day_offset)
			}
			function addFollowUp(ch) { const day = steps.length ? Math.max(...steps.map((s) => Number(s.day_offset) || 0)) + 2 : 0; const s = newStep(ch, day); s.condition = 'Previous step was not read or opened'; steps.push(s); advanced.value = true }
			async function removeStep(i) { if (await CM.confirm({ title: 'Remove this step?', message: 'The message and its settings are removed from the campaign.', confirmText: 'Remove step', danger: true })) steps.splice(i, 1) }
			function chooseTemplate(i) { pickFor.value = i }
			function picked(t) { steps[pickFor.value].email_template = t.name; CM.tplCache[t.name] = t; pickFor.value = null }
			function createTemplate(i) { editTpl.index = i; editTpl.name = ''; editTpl.mode = 'builder'; editTpl.open = true; pickFor.value = null }
			function editTemplate(i) { editTpl.index = i; editTpl.name = steps[i].email_template; editTpl.mode = ''; editTpl.open = true }
			function tplSaved(n) { delete CM.tplCache[n]; if (editTpl.index >= 0 && !steps[editTpl.index].email_template) steps[editTpl.index].email_template = n; editTpl.name = n; CM.getEmailTemplate(n) }
			const stepLabel = (s, i) => `Step ${i + 1}: ${s.channel}${s.day_offset ? ' on day ' + s.day_offset : ''}`

			// ------------------------------------------------------------ preview and test step
			const pv = reactive({ idx: 0, lead: '', leadLabel: '', pick: false, data: null, loading: false, error: '' })
			let pseq = 0
			async function loadPreview() {
				const s = steps[pv.idx]; if (!s) return
				const my = ++pseq; pv.loading = true; pv.error = ''
				try {
					const d = await CM.apiLatest('preview-step', 'preview_step', { step: { channel: s.channel, email_template: s.email_template, wa_template: s.wa_template, variable_map: JSON.stringify(s.variable_map), wa_account: s.wa_account }, lead: pv.lead || undefined, sample: pv.lead ? 0 : 1 })
					if (my === pseq) pv.data = d
				} catch (e) { if (my === pseq) { pv.error = e.message; pv.data = null } } finally { if (my === pseq) pv.loading = false }
			}
			watch(() => [step.value, pv.idx, pv.lead], () => { if (step.value === 3) loadPreview() })
			watch(step, (v) => { if (v === 3) { if (pv.idx >= steps.length) pv.idx = 0; loadPreview() } })
			const pvLeads = ref([]); const pvNames = computed(() => pvLeads.value)
			const testOpen = ref(false); const waTest = reactive({ number: '', state: 'idle', message: '' })
			async function sendWaTest() {
				const s = steps[pv.idx]; waTest.state = 'sending'; waTest.message = ''
				try {
					const r = await CM.api('send_test_whatsapp', { step: { channel: 'WhatsApp', wa_template: s.wa_template, variable_map: JSON.stringify(s.variable_map), wa_account: s.wa_account, wa_attach: s.wa_attach }, number: waTest.number, lead: pv.lead || undefined })
					waTest.state = 'ok'; waTest.message = 'Sent to +' + r.to + '. It can take a few seconds to arrive.'
				} catch (e) { waTest.state = 'error'; waTest.message = e.message }
			}
			const pvStep = computed(() => steps[pv.idx])
			const pvBubble = computed(() => (pv.data && pv.data.channel === 'WhatsApp' ? { header: pv.data.header, header_type: pv.data.header_type, body: pv.data.body, footer: pv.data.footer, buttons: (pv.data.buttons || []).map((b) => ({ button_label: b })) } : null))
			const stepTabs = computed(() => steps.map((s, i) => ({ value: i, label: `${i + 1}. ${s.channel}`, icon: s.channel === 'Email' ? 'mail' : 'whatsapp' })))

			// ------------------------------------------------------------ review and launch
			const eligible = computed(() => {
				const r = result.value; if (!r || !r.summary) return null
				return channelsUsed.value.reduce((o, c) => ({ ...o, [c]: r.summary[c] ? r.summary[c].eligible : 0 }), {})
			})
			const totalMessages = computed(() => { if (!eligible.value) return null; return steps.reduce((n, s) => n + (eligible.value[s.channel] || 0), 0) })
			const warnings = computed(() => {
				const w = []; const r = result.value
				if (r && r.summary && !isAuto.value) channelsUsed.value.forEach((c) => { const sm = r.summary[c]; const skipped = r.summary.total - sm.eligible; if (!sm.eligible) w.push({ tone: 'err', text: `No lead can receive ${c}. Check the audience.` }); else if (skipped > 0) w.push({ tone: 'warn', text: `${CM.num(skipped)} lead${skipped > 1 ? 's' : ''} will be skipped on ${c} (${Object.entries(sm.reasons).map(([k, v]) => v + ' ' + k.toLowerCase().replace(' in this campaign', '')).join(', ')}).` }) })
				if (needsConsent.value && !form.consent_confirmed && r && r.summary && r.summary.WhatsApp && r.summary.WhatsApp.reasons['Not opted in to WhatsApp']) w.push({ tone: 'warn', text: 'WhatsApp requires consent. Leads without WhatsApp opt-in are skipped unless you confirm consent in the advanced options.' })
				if (cfg.value.email && !cfg.value.email.ready && channelsUsed.value.includes('Email')) w.push({ tone: 'err', text: 'No outgoing Email Account is set up on this site.' })
				if (channelsUsed.value.includes('WhatsApp') && !(cfg.value.whatsapp && cfg.value.whatsapp.ready)) w.push({ tone: 'err', text: 'No active WhatsApp account is configured in frappe_whatsapp.' })
				return w
			})
			const blocked = computed(() => warnings.value.some((x) => x.tone === 'err') || (!isAuto.value && result.value && result.value.count === 0))
			const triggerText = computed(() => (form.trigger_event === 'Lead status changed' ? (form.trigger_status ? 'When a lead\'s status changes to ' + form.trigger_status : 'When a lead\'s status changes') : 'When a new lead is created'))
			const windowText = computed(() => (form.window_enabled ? `${form.window_start} to ${form.window_end}${form.window_weekdays_only ? ', Monday to Friday' : ''} (${form.timezone})` : 'Any time'))
			const whenText = computed(() => (isAuto.value ? 'Automatic: ' + triggerText.value.charAt(0).toLowerCase() + triggerText.value.slice(1) : form.send_mode === 'Schedule' && form.date ? new Date(`${form.date}T${form.time}`).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) + ' (' + form.timezone + ')' : 'As soon as you launch'))
			async function openConfirm() {
				tried[4] = true
				for (const m of [errs.value.schedule, errs.value.window, errs.value.rules]) if (m) return CM.toast(m, 'warn')
				for (let k = 0; k < 3; k++) if (!stepOk(k)) { await go(k); tried[k] = true; return CM.toast('Complete this step before launching.', 'warn') }
				const ok = await save(true); if (!ok) return
				try { await CM.api('validate_launch', { name: id.value }) } catch (e) { return CM.toast(e.message, 'err', 9000) }
				confirmOpen.value = true
			}
			async function launch() {
				launching.value = true
				try { await CM.api('launch', { name: id.value }); confirmOpen.value = false; dirty.value = false; done.value = { scheduled: form.send_mode === 'Schedule', auto: isAuto.value, when: whenText.value, count: isAuto.value ? null : totalMessages.value }; CM.scrollTop() } catch (e) { CM.toast(e.message, 'err', 9000); confirmOpen.value = false } finally { launching.value = false }
			}
			const TRIGGERS = ['Lead created', 'Lead status changed']
			const tzOptions = computed(() => tzList().map((z) => ({ value: z, label: z.replace(/_/g, ' ') })))
			const minDate = CM.ymd(new Date())
			return { id, loading, loadError, step, reached, tried, form, rules, addRule, isAuto, triggerText, windowText, TRIGGERS, a, steps, result, saving, savedAt, dirty, launching, waTemplates, pickFor, editTpl, previewTpl, confirmOpen, done, advanced, cfg, channelsUsed, hasWa, needsConsent, errs, stepOk, go, next, back, leave, save, toggleChannel, addFollowUp, removeStep, chooseTemplate, picked, createTemplate, editTemplate, tplSaved, stepLabel, pv, pvBubble, loadPreview, testOpen, waTest, sendWaTest, pvStep, stepTabs, eligible, totalMessages, warnings, blocked, whenText, openConfirm, launch, tzOptions, minDate, STEPS, TYPES, CM, init, onResult: (r) => (result.value = r), go2: CM.go, newCampaign: () => { location.hash = '#/campaigns/new'; location.reload() } }
		},
		template: `
		<div class="wz">
			<div v-if="loading" class="page"><Skel w="260" h="30" /><Skel h="60" r="12" /><Skel h="320" r="12" /></div>
			<div v-else-if="loadError" class="page"><ErrorState :message="loadError" @retry="init" /></div>

			<div v-else-if="done" class="page" style="max-width:720px;padding-top:56px">
				<div class="card pad fin"><div class="fin-ico"><Ico name="check-circle" size="xl" /></div><h1>{{ done.auto ? 'Automatic campaign is on' : done.scheduled ? 'Campaign scheduled' : 'Campaign launched' }}</h1><p class="muted">{{ done.auto ? 'It is running now. ' + done.when + ', the lead is added and the messages follow your plan. Pause or cancel it from the campaign page.' : done.scheduled ? 'It will start ' + done.when + '.' : 'Messages are being queued now and sent in small batches.' }} <template v-if="done.count != null">About {{ CM.num(done.count) }} messages in total.</template></p>
					<div class="row wrap" style="justify-content:center;margin-top:8px"><Btn variant="primary" icon="chart" @click="go2('/c/' + encodeURIComponent(id))">View campaign</Btn><Btn icon="plus" @click="newCampaign">Create another</Btn><Btn variant="ghost" @click="go2('/campaigns')">Back to campaigns</Btn></div>
					<div class="fin-tips"><div><Ico name="clock" /><b>Watch it live</b><span>The campaign page refreshes by itself while it sends.</span></div><div><Ico name="pause" /><b>Stay in control</b><span>Pause or cancel from the campaign page at any time.</span></div><div><Ico name="ban" /><b>Opt-outs are honoured</b><span>Unsubscribes and STOP replies are skipped automatically.</span></div></div></div>
			</div>

			<template v-else>
				<header class="wz-top">
					<div class="wz-top-in">
						<div class="row" style="gap:10px"><Btn variant="ghost" icon="arrow-left" @click="leave">Campaigns</Btn><span class="te-sep"></span><b class="ellipsis" style="max-width:300px">{{ form.campaign_name || 'New campaign' }}</b><span class="badge neutral nodot">{{ id ? form.status : 'Draft' }}</span><span class="grow"></span><span v-if="saving" class="small faint"><span class="spin" style="width:12px;height:12px"></span> Saving</span><span v-else-if="savedAt" class="small faint"><Ico name="check" size="sm" /> Draft saved {{ savedAt }}</span><span v-else-if="dirty" class="small faint">Not saved yet</span><Btn :loading="saving" icon="save" :disabled="!form.campaign_name.trim()" @click="save(false)">Save draft</Btn></div>
						<Stepper :steps="STEPS" :current="step" :reached="reached" @go="go" />
					</div>
				</header>
				<div class="wz-body">
					<main class="wz-main">
						<!-- 1 Details -->
						<section v-if="step === 0" class="card pad wz-card">
							<div class="card-h"><div class="grow"><h2 class="wz-h">Name your campaign</h2><p>Only you and your team see this. Pick something you will recognise in a list.</p></div></div>
							<div class="col" style="gap:16px">
								<Field label="Campaign name" required :error="tried[0] && errs.name"><input class="inp" :class="{ bad: tried[0] && errs.name }" v-model="form.campaign_name" placeholder="e.g. MBA October admissions reminder" maxlength="140" autofocus aria-label="Campaign name" @keydown.enter="next" /></Field>
								<Field label="Campaign type" hint="Helps you group campaigns in reports."><div class="chips"><button v-for="t in TYPES" :key="t" type="button" class="fchip" :class="{ on: form.campaign_type === t }" @click="form.campaign_type = t">{{ t }}</button></div></Field>
								<details class="more"><summary><Ico name="chevron-right" size="sm" /> More options <span class="faint small">description, tags, notes</span></summary><div class="col" style="gap:14px;margin-top:12px"><Field label="Description"><textarea class="inp" v-model="form.description" rows="2" placeholder="What is this campaign for?"></textarea></Field><Field label="Tags" hint="Comma separated, e.g. mba, october"><input class="inp" v-model="form.tags" /></Field><Field label="Internal notes"><textarea class="inp" v-model="form.notes" rows="2"></textarea></Field></div></details>
							</div>
						</section>

						<!-- 2 Audience -->
						<section v-else-if="step === 1" class="wz-card">
							<div class="wz-intro"><h2 class="wz-h">Who should receive it?</h2><p class="muted">Choose how to build your audience. You will see how many leads match, who can receive each channel, and why anyone is excluded.</p></div>
							<AudienceBuilder :a="a" :consent="form.consent_confirmed" @result="onResult" />
							<div v-if="tried[1] && errs.audience" class="alert err" style="margin-top:14px"><Ico name="alert" /><div class="grow">{{ errs.audience }}</div></div>
						</section>

						<!-- 3 Content -->
						<section v-else-if="step === 2" class="wz-card">
							<div class="wz-intro"><h2 class="wz-h">Choose channels and write the message</h2><p class="muted">Send by email, WhatsApp, or both. Add follow-ups if you want a short journey.</p></div>
							<div class="chan-cards">
								<button type="button" class="mcard" :class="{ on: channelsUsed.includes('Email') }" :aria-pressed="channelsUsed.includes('Email')" @click="toggleChannel('Email')"><span class="mi email"><Ico name="mail" size="lg" /></span><span class="grow"><b>Email</b><span class="small muted" style="display:block">Designed emails with attachments</span></span><Ico v-if="channelsUsed.includes('Email')" name="check-circle" class="tickc" /></button>
								<button type="button" class="mcard" :class="{ on: channelsUsed.includes('WhatsApp'), off: cfg.whatsapp && !cfg.whatsapp.installed }" :aria-pressed="channelsUsed.includes('WhatsApp')" :disabled="cfg.whatsapp && !cfg.whatsapp.installed" @click="toggleChannel('WhatsApp')"><span class="mi wa"><Ico name="whatsapp" size="lg" /></span><span class="grow"><b>WhatsApp</b><span class="small muted" style="display:block">{{ cfg.whatsapp && !cfg.whatsapp.installed ? 'frappe_whatsapp is not installed' : 'Meta-approved templates' }}</span></span><Ico v-if="channelsUsed.includes('WhatsApp')" name="check-circle" class="tickc" /></button>
							</div>
							<div v-if="tried[2] && errs.content" class="alert err" style="margin-top:14px"><Ico name="alert" /><div class="grow">{{ errs.content }}</div></div>
							<div class="col" style="gap:16px;margin-top:18px">
								<template v-for="(s, i) in steps" :key="s.uid">
									<EmailStep v-if="s.channel === 'Email'" :step="s" :index="i" :show-errors="tried[2]" @remove="removeStep(i)" @pick="chooseTemplate(i)" @create="createTemplate(i)" @edit="editTemplate(i)" @preview="previewTpl = s.email_template" />
									<WaStep v-else :step="s" :index="i" :templates="waTemplates" :show-errors="tried[2]" @remove="removeStep(i)" />
								</template>
							</div>
							<div v-if="steps.length" class="row wrap" style="margin-top:16px"><Menu v-if="channelsUsed.length > 1" align="left" :items="[{ label: 'Email follow-up', icon: 'mail', run: () => addFollowUp('Email') }, { label: 'WhatsApp follow-up', icon: 'whatsapp', run: () => addFollowUp('WhatsApp') }]"><Btn icon="plus">Add a follow-up message</Btn></Menu><Btn v-else icon="plus" @click="addFollowUp(channelsUsed[0])">Add a follow-up message</Btn><span class="small faint">Optional: send another message a few days later, only to leads who did not read the first one.</span></div>
							<details v-if="steps.length" class="more" style="margin-top:20px" :open="advanced"><summary><Ico name="chevron-right" size="sm" /> Advanced options</summary><div class="col" style="gap:14px;margin-top:12px">
								<label class="check"><input type="checkbox" v-model="form.stop_on_reply" :disabled="steps.length < 2" /><span>Stop the journey for a lead who replies<span class="small muted" style="display:block">{{ steps.length < 2 ? 'Available when the campaign has follow-up messages.' : 'Later messages are skipped once the lead writes back.' }}</span></span></label>
								<label v-if="channelsUsed.includes('Email')" class="check"><input type="checkbox" v-model="form.track_clicks" /><span>Track link clicks in emails<span class="small muted" style="display:block">Links are routed through your own site so you can see who clicked what. Recipients see no difference. Switch off if you prefer plain links.</span></span></label>
								<label v-if="needsConsent" class="check"><input type="checkbox" v-model="form.consent_confirmed" /><span>I confirm these leads agreed to receive WhatsApp messages<span class="small muted" style="display:block">Meta requires opt-in for marketing templates. Without this, only leads marked as opted in are messaged. Your confirmation is recorded.</span></span></label>
							</div></details>
						</section>

						<!-- 4 Preview and test -->
						<section v-else-if="step === 3" class="wz-card">
							<div class="wz-intro"><h2 class="wz-h">Preview and test</h2><p class="muted">See exactly what a lead will receive, then send yourself a test.</p></div>
							<div class="row wrap pv-tools"><Seg v-if="steps.length > 1" v-model="pv.idx" :options="stepTabs" /><span class="grow"></span><div class="row" style="gap:8px"><span class="small muted">Preview as</span><Seg :model-value="pv.pick ? 'lead' : 'sample'" :options="[{ value: 'sample', label: 'Sample lead' }, { value: 'lead', label: 'A real lead' }]" @update:model-value="(v) => { pv.pick = v === 'lead'; if (!pv.pick) { pv.lead = ''; pv.leadLabel = '' } }" /></div></div>
							<div v-if="pv.pick && !pv.lead" class="card pad" style="margin-bottom:14px"><div class="lbl" style="margin-bottom:6px">Choose a lead</div><LeadPicker :model-value="[]" @add="(l) => { pv.lead = l.name; pv.leadLabel = l.lead_name || l.name }" /></div>
							<div v-if="pv.lead" class="small muted" style="margin-bottom:10px">Previewing as <b>{{ pv.leadLabel }}</b> <a href="#" @click.prevent="pv.lead = ''; pv.leadLabel = ''; pv.pick = false">use sample data</a></div>
							<div v-if="pv.error" class="alert err"><Ico name="alert" /><div class="grow">{{ pv.error }}</div></div>
							<div class="pv-grid" v-if="pvStep">
								<div class="card pad" style="min-height:300px"><template v-if="pvStep.channel === 'Email'"><EmailPreview :subject="pv.data && pv.data.subject" :html="pv.data && pv.data.html" :from-name="cfg.sender_name" :from-email="cfg.sender_email" :to-name="pv.data && pv.data.lead && pv.data.lead.lead_name" :loading="pv.loading" /></template>
									<template v-else><div v-if="pv.loading && !pvBubble" class="chart-empty"><span class="spin"></span></div><div v-else-if="pvBubble" class="wa-stage"><WaBubble v-bind="{ header: pvBubble.header, headerType: pvBubble.header_type, body: pvBubble.body, footer: pvBubble.footer, buttons: pvBubble.buttons }" :media-url="pvStep.wa_attach" /></div><div v-if="pv.data && pv.data.missing && pv.data.missing.length" class="alert warn" style="margin-top:12px"><Ico name="alert" /><div class="grow">Variable(s) {{ pv.data.missing.join(', ') }} are empty for this lead, so this lead would be skipped.</div></div></template></div>
								<div class="col" style="gap:14px"><div class="card pad pv-test"><div class="pv-test-h"><span class="pv-test-i"><Ico name="send" /></span><div class="grow"><h3>Send a test</h3><p>Check it on a real device before the audience gets it.</p></div></div>
									<template v-if="pvStep.channel === 'Email'"><Btn variant="primary" icon="send" :disabled="!pvStep.email_template" @click="testOpen = true">Send test email</Btn><p class="small faint" style="margin:10px 0 0">Goes only to the addresses you enter. Nothing is recorded on any lead.</p></template>
									<template v-else><div v-if="!cfg.whatsapp || !cfg.whatsapp.ready" class="alert warn"><Ico name="info" /><div class="grow"><b>Preview only.</b> A test message needs an active WhatsApp account in frappe_whatsapp. The preview above still shows exactly what leads receive.</div></div><template v-else><Field label="Send to this WhatsApp number" hint="Use international format. Billed by Meta like any template message."><input class="inp" v-model="waTest.number" placeholder="+91 98765 43210" aria-label="WhatsApp number for the test" /></Field><div style="margin-top:10px"><Btn variant="primary" icon="send" :loading="waTest.state === 'sending'" :disabled="!waTest.number || !pvStep.wa_template" @click="sendWaTest">Send test message</Btn></div><div v-if="waTest.state === 'ok'" class="alert ok" style="margin-top:10px"><Ico name="check-circle" /><div class="grow">{{ waTest.message }}</div></div><div v-if="waTest.state === 'error'" class="alert err" style="margin-top:10px"><Ico name="alert" /><div class="grow">{{ waTest.message }}</div></div></template></template></div>
								</div>
							</div>
						</section>

						<!-- 5 Schedule and review -->
						<section v-else class="wz-card">
							<div class="wz-intro"><h2 class="wz-h">Schedule and review</h2><p class="muted">Choose when it goes out, then check everything one last time.</p></div>
							<div class="card pad"><div class="card-h"><div class="grow"><h3>When should it be sent?</h3></div></div>
								<div class="send-opts"><button type="button" class="mcard" :class="{ on: form.send_mode === 'Send Now' }" :aria-pressed="form.send_mode === 'Send Now'" @click="form.send_mode = 'Send Now'"><span class="mi"><Ico name="zap" size="lg" /></span><span class="grow"><b>Send now</b><span class="small muted" style="display:block">Starts as soon as you launch</span></span></button><button type="button" class="mcard" :class="{ on: form.send_mode === 'Schedule' }" :aria-pressed="form.send_mode === 'Schedule'" @click="form.send_mode = 'Schedule'"><span class="mi"><Ico name="calendar" size="lg" /></span><span class="grow"><b>Schedule for later</b><span class="small muted" style="display:block">Pick a date, time and time zone</span></span></button></div>
								<div v-if="form.send_mode === 'Schedule'" class="sched"><Field label="Date" :error="tried[4] && errs.schedule"><input class="inp" type="date" :min="minDate" v-model="form.date" aria-label="Date" /></Field><Field label="Time"><input class="inp" type="time" v-model="form.time" aria-label="Time" /></Field><div class="small muted" style="align-self:end;padding-bottom:10px">Times are in Indian time (IST).</div></div>
								<div v-if="isAuto" class="alert" style="margin-top:14px"><Ico name="info" /><div class="grow">This is an automatic campaign made earlier. New automatic flows (start when a lead is created or changes status) are made under <a href="#/automations">Automations</a>.</div></div></div>
							<div class="card pad" style="margin-top:16px"><div class="card-h"><div class="grow"><h3>Sending hours</h3><p>Keep messages to working hours (Indian time, IST). Anything due outside them waits until the hours open.</p></div></div>
								<label class="check"><input type="checkbox" v-model="form.window_enabled" /><span>Only send during these hours</span></label>
								<div v-if="form.window_enabled" class="sched"><Field label="From" :error="tried[4] && errs.window"><input class="inp" type="time" v-model="form.window_start" aria-label="Sending hours start" /></Field><Field label="Until"><input class="inp" type="time" v-model="form.window_end" aria-label="Sending hours end" /></Field><label class="check" style="align-self:end;padding-bottom:10px"><input type="checkbox" v-model="form.window_weekdays_only" /><span>Monday to Friday only</span></label></div></div>
							<div class="card pad" style="margin-top:16px"><div class="ready-h"><span class="ready-ico" :class="{ bad: blocked }"><Ico :name="blocked ? 'alert' : 'check-circle'" size="lg" /></span><div class="grow"><h3 style="margin:0;font-size:17px">{{ blocked ? 'Fix a few things before launching' : 'Your campaign is ready' }}</h3><p class="muted" style="margin:2px 0 0">{{ blocked ? 'See the warnings below.' : 'Review the details, then launch when you are ready.' }}</p></div></div>
								<dl class="dl review">
									<dt>Audience</dt><dd><b>{{ isAuto ? 'Future leads' : result ? CM.num(result.count) : '-' }}</b><template v-if="!isAuto"> leads</template><template v-else> that match</template> <span class="muted">- {{ a.mode === 'Saved Segment' ? 'saved segment' : a.mode === 'Selected Records' ? 'hand-picked' : 'CRM filters' }}</span><div v-if="eligible" class="row wrap" style="gap:8px;margin-top:4px"><span v-for="(n, c) in eligible" :key="c" class="small"><ChannelBadge :value="c" /> {{ CM.num(n) }} can receive</span></div></dd>
									<dt>Messages</dt><dd><div v-for="(s, i) in steps" :key="s.uid" class="row" style="gap:8px;margin-bottom:4px"><ChannelBadge :value="s.channel" /><span>{{ s.channel === 'Email' ? s.email_template : (waTemplates.find((t) => t.name === s.wa_template) || { template_name: s.wa_template }).template_name }}</span><span class="small faint">{{ s.day_offset > 0 ? 'on day ' + s.day_offset : 'on launch' }}</span></div></dd>
									<dt>Schedule</dt><dd>{{ whenText }}</dd>
									<dt>Sending hours</dt><dd>{{ windowText }}</dd>
									<dt v-if="rules.length">Lead updates</dt><dd v-if="rules.length"><div v-for="r in rules" :key="r.uid" class="small">When a lead {{ r.event.toLowerCase() }}: {{ r.action.toLowerCase() }}<template v-if="r.value"> ({{ r.value }})</template></div></dd>
									<dt>Name</dt><dd>{{ form.campaign_name }} <span class="faint">({{ form.campaign_type }})</span></dd>
								</dl>
								<div v-if="warnings.length" class="col" style="gap:8px;margin-top:14px"><div v-for="w in warnings" :key="w.text" class="alert" :class="w.tone === 'err' ? 'err' : 'warn'"><Ico name="alert" /><div class="grow">{{ w.text }}</div></div></div>
							</div>
						</section>

						<footer class="wz-nav">
							<Btn v-if="step > 0" icon="arrow-left" @click="back">Back</Btn><span class="grow"></span>
							<Btn v-if="step < 4" variant="primary" @click="next">Continue <Ico name="arrow-right" /></Btn>
							<template v-else><Btn :loading="saving" icon="save" @click="save(false)">Save draft</Btn><Btn variant="primary" size="lg" :icon="isAuto ? 'refresh' : form.send_mode === 'Schedule' ? 'calendar' : 'send'" :disabled="blocked" @click="openConfirm">{{ isAuto ? 'Start automatic campaign' : form.send_mode === 'Schedule' ? 'Schedule campaign' : 'Launch campaign' }}</Btn></template>
						</footer>
					</main>

					<aside class="wz-side"><div class="card pad sum">
						<div class="lbl">Campaign summary</div><div class="sum-name">{{ form.campaign_name || 'Untitled campaign' }}</div>
						<div class="sum-row"><Ico name="users" size="sm" /><div class="grow"><div class="sum-k">Audience</div><div v-if="result" class="sum-v"><b>{{ CM.num(result.count) }}</b> leads <span v-if="eligible" class="small muted"><template v-for="(n, c) in eligible" :key="c"> - {{ CM.num(n) }} on {{ c }}</template></span></div><div v-else class="sum-v faint">Not set yet</div></div></div>
						<div class="sum-row"><Ico name="layers" size="sm" /><div class="grow"><div class="sum-k">Channels</div><div v-if="channelsUsed.length"><ChannelBadges :channels="channelsUsed" :multi="false" /><div class="small muted" style="margin-top:3px">{{ steps.length }} message{{ steps.length > 1 ? 's' : '' }}<template v-if="steps.length > 1"> - {{ Math.max(...steps.map((s) => Number(s.day_offset) || 0)) ? 'over ' + Math.max(...steps.map((s) => Number(s.day_offset) || 0)) + ' days' : 'all at launch' }}</template></div></div><div v-else class="sum-v faint">Not chosen yet</div></div></div>
						<div class="sum-row"><Ico name="calendar" size="sm" /><div class="grow"><div class="sum-k">Schedule</div><div class="sum-v">{{ whenText }}</div></div></div>
						<div v-if="warnings.length" class="sum-warn"><div v-for="w in warnings.slice(0, 3)" :key="w.text" class="small" :class="w.tone === 'err' ? 'bad' : 'warn'"><Ico name="alert" size="sm" /> {{ w.text }}</div></div>
						<div v-else-if="channelsUsed.length && result" class="small" style="color:var(--green)"><Ico name="check-circle" size="sm" /> No problems found</div>
					</div></aside>
				</div>

				<TemplatePicker v-if="pickFor !== null" title="Choose an email template" subtitle="Shared templates, usable by every campaign and follow-up." :selected="steps[pickFor] && steps[pickFor].email_template" :allow-create="cfg.is_manager" @pick="picked" @create="createTemplate(pickFor)" @close="pickFor = null" />
				<TemplateEditor v-if="editTpl.open" embedded :name="editTpl.name || undefined" :mode="editTpl.mode" @saved="tplSaved" @close="editTpl.open = false" />
				<PreviewModal v-if="previewTpl" :title="previewTpl" :subject="(CM.tplCache[previewTpl] || {}).subject" :html="(CM.tplCache[previewTpl] || {}).body_html" @close="previewTpl = null" />
				<SendTest v-if="testOpen && pvStep" :template="pvStep.email_template" :attachments="pvStep.attachments.map((f) => f.file_url)" :lead="pv.lead" @close="testOpen = false" />
				<Modal v-if="confirmOpen" size="sm" :title="isAuto ? 'Start this automatic campaign?' : form.send_mode === 'Schedule' ? 'Schedule this campaign?' : 'Send this campaign now?'" @close="confirmOpen = false" @submit="launch">
					<p style="margin:0">{{ isAuto ? 'It starts now and keeps running. ' + whenText + ', a matching lead is added and messaged automatically.' : form.send_mode === 'Schedule' ? 'It will start ' + whenText + '.' : 'Messages start going out immediately.' }}</p>
					<div v-if="!isAuto" class="confirm-box"><div class="confirm-n">{{ totalMessages != null ? CM.num(totalMessages) : CM.num(result && result.count) }}</div><div class="muted small">{{ totalMessages != null ? 'messages will be sent' : 'leads in the audience' }}<template v-if="eligible"> ({{ Object.entries(eligible).map(([c, n]) => CM.num(n) + ' ' + c).join(', ') }})</template></div></div>
					<div class="alert warn"><Ico name="alert" /><div class="grow">Sent messages cannot be recalled. You can pause or cancel the campaign at any time.</div></div>
					<template #foot><Btn @click="confirmOpen = false">Go back</Btn><Btn variant="primary" :icon="form.send_mode === 'Schedule' ? 'calendar' : 'send'" :loading="launching" @click="launch">{{ isAuto ? 'Yes, start it' : form.send_mode === 'Schedule' ? 'Yes, schedule it' : 'Yes, send now' }}</Btn></template>
				</Modal>
			</template>
		</div>`,
	}
})()
