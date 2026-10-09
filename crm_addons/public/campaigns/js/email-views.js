/* Campaign Manager: Email Templates section (library, creation chooser, full-screen editor, picker). */
(() => {
	const { ref, reactive, computed, watch, onMounted, onBeforeUnmount } = Vue
	const CM = window.CM
	const C = CM.components
	const V = CM.views

	const MODES = { builder: 'Visual Builder', html: 'HTML', rich: 'Rich Text' }
	const MODE_INFO = [
		{ key: 'builder', icon: 'layers', title: 'Visual builder', text: 'Drag and drop blocks: headings, images, buttons, columns. No code needed.', tag: 'Recommended' },
		{ key: 'html', icon: 'code', title: 'HTML editor', text: 'Paste or write your own HTML with a live preview, formatting and validation.' },
		{ key: 'rich', icon: 'edit', title: 'Rich text', text: 'Write like a document: bold, links, lists, headings and images.' },
	]
	const SAMPLE = { first_name: 'Siddharth', last_name: 'Singh', lead_name: 'Siddharth Singh', email: 'siddharth.singh@example.com', organization: 'Acme Learning', sender_name: 'Siddharth Singh', owner_name: 'Siddharth Singh', mobile_no: '+91 98765 43210', today: new Date().toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }) }
	CM.sampleFill = (s) => String(s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => SAMPLE[k] ?? '')
	const isManager = () => !!(CM.shared.config && CM.shared.config.is_manager)
	const favs = ref(CM.store.json('cm-fav-email', []))
	watch(favs, (v) => CM.store.set('cm-fav-email', JSON.stringify(v)), { deep: true })
	const toggleFav = (n) => { const i = favs.value.indexOf(n); i >= 0 ? favs.value.splice(i, 1) : favs.value.push(n) }

	const STARTER = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:10px"><tr><td style="padding:32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#3b4252">\n<h1 style="margin:0 0 14px;font-size:26px;color:#14161a">Hello {{ first_name }}</h1>\n<p style="margin:0 0 14px">Write your message here.</p>\n<p style="margin:0">Regards,<br>{{ sender_name }}</p>\n</td></tr></table></td></tr></table>'
	const RICH_STARTER = '<h1>Hello {{ first_name }}</h1><p>Write your message here. Use the toolbar for formatting, links and images.</p><p>Regards,<br>{{ sender_name }}</p>'

	// ------------------------------------------------------------------ preview dialog
	C.PreviewModal = {
		props: { subject: String, html: String, title: String, template: String },
		emits: ['close'],
		setup(props) {
			const r = CM.useRender(() => props.subject, () => props.html, 50)
			return { r, fromName: computed(() => CM.shared.config && CM.shared.config.sender_name), fromEmail: computed(() => CM.shared.config && CM.shared.config.sender_email) }
		},
		template: `
		<Modal size="xl" :title="title || 'Preview'" subtitle="Shown with sample lead data (Siddharth Singh, Acme Learning)." @close="$emit('close')">
			<div v-if="r.unknown.length" class="alert warn"><Ico name="alert" /><div class="grow">Unknown variable(s): <b>{{ r.unknown.join(', ') }}</b>. They will be sent empty.</div></div>
			<EmailPreview :subject="r.subject || subject" :html="r.html" :from-name="fromName" :from-email="fromEmail" :loading="r.loading" />
		</Modal>`,
	}

	// ------------------------------------------------------------------ editor (full screen)
	C.TemplateEditor = {
		props: { name: String, mode: String, from: String, embedded: Boolean },
		emits: ['saved', 'close'],
		setup(props, { emit }) {
			const loading = ref(!!(props.name || props.from)); const error = ref(''); const saving = ref(false); const savedAt = ref('')
			const t = reactive({ template_name: '', subject: '', category: '', mode: MODES[props.mode] || 'Visual Builder', enabled: 1 })
			const builder = reactive(CM.defaultBuilder()); const html = ref(STARTER); const rich = ref(RICH_STARTER)
			const files = ref([]); const showFiles = ref(false); const testOpen = ref(false); const previewOpen = ref(false); const subjectEl = ref(null)
			const existing = computed(() => !!props.name)
			let baseline = ''
			const finalHtml = computed(() => (t.mode === 'Visual Builder' ? CM.renderBuilder(builder) : t.mode === 'Rich Text' ? CM.richToEmail(rich.value) : html.value))
			const snapshot = () => JSON.stringify([t.template_name, t.subject, t.category, t.mode, t.mode === 'Visual Builder' ? builder : t.mode === 'Rich Text' ? rich.value : html.value, files.value.map((f) => f.file_url)])
			const dirty = computed(() => !loading.value && snapshot() !== baseline)
			if (!props.name && !props.from) { t.subject = ''; baseline = '' }
			async function load() {
				const src = props.name || props.from
				if (!src) { baseline = snapshot(); return }
				loading.value = true; error.value = ''
				try {
					const d = await CM.api('get_email_template', { name: src })
					t.template_name = props.name ? d.template_name : ''; t.subject = d.subject; t.category = d.category || ''; t.enabled = d.enabled
					t.mode = d.editor_mode || 'HTML'
					html.value = d.body_html
					if (t.mode === 'Visual Builder') { try { const j = JSON.parse(d.builder_json); if (j && j.blocks) Object.assign(builder, { settings: j.settings, blocks: j.blocks.map((b) => ({ ...b, id: b.id || CM.uid() })) }); else t.mode = 'HTML' } catch (e) { t.mode = 'HTML' } }
					if (t.mode === 'Rich Text') rich.value = CM.richFromEmail(d.body_html)
					if (props.name) files.value = d.attachments
					if (props.name && d.attachments.length) showFiles.value = true
				} catch (e) { error.value = e.message } finally { loading.value = false; baseline = snapshot() }
			}
			const closeGuard = async () => !dirty.value || !!(await CM.confirm({ title: 'Close without saving?', message: 'This template has changes that are not saved yet.', confirmText: 'Close and discard', danger: true }))
			onMounted(() => { CM.loadShared(); load(); window.addEventListener('beforeunload', warn); window.addEventListener('keydown', key); CM.closeGuards.add(closeGuard) })
			onBeforeUnmount(() => { window.removeEventListener('beforeunload', warn); window.removeEventListener('keydown', key); CM.closeGuards.delete(closeGuard) })
			const warn = (e) => { if (dirty.value) { e.preventDefault(); e.returnValue = '' } }
			const key = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() } }
			const problems = computed(() => {
				const p = {}
				if (!t.template_name.trim()) p.name = 'Give the template a name.'
				if (!t.subject.trim()) p.subject = 'Add a subject line.'
				return p
			})
			async function save() {
				if (saving.value) return
				if (Object.keys(problems.value).length) { CM.toast(Object.values(problems.value)[0], 'warn'); tried.value = true; return }
				saving.value = true
				try {
					const body = { template_name: t.template_name.trim(), subject: t.subject, body_html: finalHtml.value, category: t.category, editor_mode: t.mode, enabled: t.enabled, attachments: files.value.map((f) => f.file_url), builder_json: t.mode === 'Visual Builder' ? JSON.stringify(builder) : '' }
					const d = await CM.api('save_email_template', { data: body, name: props.name || undefined })
					baseline = snapshot(); savedAt.value = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
					CM.toast('Template saved'); emit('saved', d.name)
					if (!props.embedded && !props.name) CM.replace('/templates/email/edit/' + encodeURIComponent(d.name))
				} catch (e) { CM.toast(e.message, 'err') } finally { saving.value = false }
			}
			const tried = ref(false)
			async function back() {
				if (dirty.value && !(await CM.confirm({ title: 'Discard your changes?', message: 'You have changes that are not saved yet.', confirmText: 'Discard changes', danger: true }))) return
				if (props.embedded) emit('close'); else CM.go('/templates/email')
			}
			async function toHtml() {
				if (!(await CM.confirm({ title: 'Switch to the HTML editor?', message: 'You can edit the code directly. You will not be able to go back to the visual builder for this template.', confirmText: 'Switch to HTML' }))) return
				html.value = CM.formatHtml(finalHtml.value); t.mode = 'HTML'
			}
			const insertSubject = (tok) => CM.insertAtCursor(subjectEl.value, tok)
			const limit = computed(() => (CM.shared.config && CM.shared.config.attachment_limit_mb) || 10)
			return { t, builder, html, rich, files, showFiles, testOpen, previewOpen, subjectEl, loading, error, saving, savedAt, existing, dirty, finalHtml, save, back, toHtml, insertSubject, limit, problems, tried, cats: computed(() => (CM.shared.config ? CM.shared.config.email_categories : [])), load, modeLabel: computed(() => t.mode) }
		},
		template: `
		<div class="te" role="dialog" aria-label="Email template editor">
			<header class="te-bar">
				<Btn variant="ghost" icon="arrow-left" @click="back">{{ embedded ? 'Close' : 'Templates' }}</Btn>
				<span class="te-sep"></span>
				<div class="grow" style="max-width:360px"><input class="inp te-name" :class="{ bad: tried && problems.name }" v-model="t.template_name" :readonly="existing" placeholder="Template name" aria-label="Template name" :title="existing ? 'The name cannot be changed after the template is created' : ''" /></div>
				<span class="badge neutral nodot">{{ modeLabel }}</span>
				<span v-if="dirty" class="small faint">Unsaved changes</span><span v-else-if="savedAt" class="small faint"><Ico name="check" size="sm" /> Saved {{ savedAt }}</span>
				<span class="grow"></span>
				<Menu v-if="t.mode !== 'HTML'" :items="[{ label: 'Switch to HTML editor', icon: 'code', run: toHtml }]"><Btn variant="ghost" icon="more" aria-label="More" /></Menu>
				<Btn icon="eye" :disabled="!finalHtml" @click="previewOpen = true">Preview</Btn>
				<Btn icon="send" @click="testOpen = true">Send test</Btn>
				<Btn variant="primary" icon="save" :loading="saving" @click="save">Save template</Btn>
			</header>
			<div v-if="loading" class="te-state"><span class="spin"></span></div>
			<div v-else-if="error" class="te-state"><ErrorState :message="error" @retry="load" /></div>
			<template v-else>
				<div class="te-sub">
					<Field label="Subject line" :error="tried && problems.subject" class="grow" style="max-width:640px"><div class="row" style="gap:6px"><input ref="subjectEl" class="inp grow" :class="{ bad: tried && problems.subject }" v-model="t.subject" placeholder="e.g. {{ first_name }}, your counselling session is ready" aria-label="Subject line" /><VarMenu size="" @pick="insertSubject" /></div></Field>
					<Field label="Category"><div style="width:180px"><Dd v-model="t.category" :options="cats" placeholder="No category" allow-empty="No category" /></div></Field>
					<Field label="Attachments"><Btn icon="paperclip" @click="showFiles = !showFiles">{{ files.length ? files.length + ' attached' : 'Add files' }}</Btn></Field>
				</div>
				<div v-if="showFiles" class="te-files"><Uploader v-model="files" :max-mb="limit" :total-mb="limit" :hint="'Sent with every email that uses this template. Up to ' + limit + ' MB in total.'" /></div>
				<div class="te-body">
					<Builder v-if="t.mode === 'Visual Builder'" :doc="builder" />
					<HtmlEditor v-else-if="t.mode === 'HTML'" v-model="html" :subject="t.subject" />
					<RichEditor v-else v-model="rich" :subject="t.subject" />
				</div>
			</template>
			<SendTest v-if="testOpen" :subject="t.subject" :html="finalHtml" :template="existing && !dirty ? name : ''" :attachments="files.map((f) => f.file_url)" @close="testOpen = false" />
			<PreviewModal v-if="previewOpen" :subject="t.subject" :html="finalHtml" :title="t.template_name || 'Preview'" @close="previewOpen = false" />
		</div>`,
	}

	// ------------------------------------------------------------------ pick a template (start from / choose for a step)
	C.TemplatePicker = {
		props: { title: String, subtitle: String, selected: String, allowCreate: Boolean, onlyActive: { type: Boolean, default: true } },
		emits: ['pick', 'close', 'create'],
		setup(props) {
			const items = ref([]); const loading = ref(true); const error = ref(''); const q = ref('')
			async function load() { loading.value = true; try { items.value = await CM.api('list_email_templates', { enabled: props.onlyActive ? 1 : undefined }); error.value = '' } catch (e) { error.value = e.message } finally { loading.value = false } }
			onMounted(load)
			const shown = computed(() => items.value.filter((i) => !q.value || (i.template_name + i.subject).toLowerCase().includes(q.value.toLowerCase())))
			return { items, loading, error, q, shown, load, CM }
		},
		template: `
		<Modal size="xl" :title="title || 'Choose a template'" :subtitle="subtitle" @close="$emit('close')">
			<div class="row"><div class="grow"><Inp v-model="q" icon="search" placeholder="Search templates" clearable aria-label="Search templates" /></div><Btn v-if="allowCreate" icon="plus" @click="$emit('create')">New template</Btn></div>
			<div v-if="loading" class="tgrid"><Skel v-for="n in 6" :key="n" h="230" r="12" /></div>
			<ErrorState v-else-if="error" :message="error" @retry="load" />
			<Empty v-else-if="!shown.length" icon="mail" title="No templates found" :text="items.length ? 'Try a different search.' : 'Create your first email template to use it here.'"><Btn v-if="allowCreate" variant="primary" icon="plus" @click="$emit('create')">New template</Btn></Empty>
			<div v-else class="tgrid"><button v-for="t in shown" :key="t.name" type="button" class="tcard card hover pick" :class="{ on: t.name === selected }" @click="$emit('pick', t)"><Thumb :html="CM.sampleFill(t.body_html)" :height="150" /><div class="tcard-b"><b class="ellipsis">{{ t.template_name }}</b><span class="small muted ellipsis">{{ t.subject }}</span></div></button></div>
		</Modal>`,
		methods: {},
	}

	// ------------------------------------------------------------------ library
	V.EmailTemplates = {
		setup() {
			const items = ref([]); const loading = ref(true); const error = ref('')
			const q = reactive({ search: '', category: '', fav: false, archived: false })
			const createOpen = ref(false); const startOpen = ref(false); const preview = ref(null)
			async function load() { loading.value = true; error.value = ''; try { items.value = await CM.api('list_email_templates', {}) } catch (e) { error.value = e.message } finally { loading.value = false } }
			onMounted(() => { CM.loadShared(); load() })
			const shown = computed(() => {
				const term = q.search.trim().toLowerCase()
				return items.value
					.filter((i) => (q.archived ? !i.enabled : !!i.enabled) && (!q.category || i.category === q.category) && (!q.fav || favs.value.includes(i.name)) && (!term || `${i.template_name} ${i.subject} ${i.description || ''}`.toLowerCase().includes(term)))
					.sort((a, b) => favs.value.includes(b.name) - favs.value.includes(a.name))
			})
			const archivedCount = computed(() => items.value.filter((i) => !i.enabled).length)
			const cats = computed(() => (CM.shared.config ? CM.shared.config.email_categories : []))
			const create = (mode) => { createOpen.value = false; CM.go('/templates/email/new?mode=' + mode) }
			const startFrom = (t) => { startOpen.value = false; CM.go('/templates/email/new?mode=' + (Object.keys(MODES).find((k) => MODES[k] === t.editor_mode) || 'html') + '&from=' + encodeURIComponent(t.name)) }
			async function duplicate(t) { try { const d = await CM.api('duplicate_email_template', { name: t.name }); CM.toast('Duplicated as ' + d.name); load() } catch (e) { CM.toast(e.message, 'err') } }
			async function archive(t, on) {
				if (on && !(await CM.confirm({ title: 'Archive "' + t.template_name + '"?', message: 'Archived templates cannot be chosen for new campaigns. Campaigns already using it keep working. You can restore it any time.', confirmText: 'Archive' }))) return
				try { await CM.api('save_email_template', { data: { enabled: on ? 0 : 1 }, name: t.name }); CM.toast(on ? 'Template archived' : 'Template restored'); load() } catch (e) { CM.toast(e.message, 'err') }
			}
			async function remove(t) {
				const ok = await CM.confirm({ title: 'Delete "' + t.template_name + '"?', message: t.used_in ? `This template is used by ${t.used_in} campaign(s) and cannot be deleted. Archive it instead.` : 'This permanently deletes the template.', confirmText: t.used_in ? 'Archive instead' : 'Delete template', danger: !t.used_in })
				if (!ok) return
				if (t.used_in) return archiveNow(t)
				try { await CM.api('delete_email_template', { name: t.name }); CM.toast('Template deleted'); load() } catch (e) { CM.toast(e.message, 'err') }
			}
			async function archiveNow(t) { try { await CM.api('save_email_template', { data: { enabled: 0 }, name: t.name }); CM.toast('Template archived'); load() } catch (e) { CM.toast(e.message, 'err') } }
			function menu(t) {
				if (!isManager()) return [{ label: 'Preview', icon: 'eye', run: () => (preview.value = t) }]
				return [{ label: 'Edit', icon: 'edit', run: () => CM.go('/templates/email/edit/' + encodeURIComponent(t.name)) }, { label: 'Preview', icon: 'eye', run: () => (preview.value = t) }, { label: 'Duplicate', icon: 'copy', run: () => duplicate(t) }, { sep: true }, t.enabled ? { label: 'Archive', icon: 'bookmark', run: () => archive(t, true) } : { label: 'Restore', icon: 'refresh', run: () => archive(t, false) }, { label: 'Delete', icon: 'trash', danger: true, run: () => remove(t) }]
			}
			return { items, loading, error, q, shown, load, createOpen, startOpen, preview, cats, create, startFrom, menu, favs, toggleFav, isManager, archivedCount, CM, MODE_INFO, open: (t) => (isManager() ? CM.go('/templates/email/edit/' + encodeURIComponent(t.name)) : (preview.value = t)) }
		},
		template: `
		<div class="page">
			<div class="pg-head"><div class="grow"><h1>Email templates</h1><p>Reusable emails for campaigns and follow-ups. Build once, personalise with variables, use everywhere.</p></div><div class="actions"><Btn v-if="isManager()" variant="primary" icon="plus" @click="createOpen = true">Create template</Btn></div></div>
			<div class="row wrap tool">
				<div style="width:300px;max-width:100%"><Inp v-model="q.search" icon="search" placeholder="Search templates" clearable aria-label="Search templates" /></div>
				<div style="width:190px"><Dd v-model="q.category" :options="cats" placeholder="All categories" allow-empty="All categories" size="sm" /></div>
				<button type="button" class="fchip" :class="{ on: q.fav }" @click="q.fav = !q.fav"><Ico name="star" size="sm" />Favourites</button>
				<button type="button" class="fchip" :class="{ on: q.archived }" @click="q.archived = !q.archived"><Ico name="bookmark" size="sm" />Archived <span class="n">{{ archivedCount }}</span></button>
			</div>
			<div v-if="loading" class="tgrid"><div v-for="n in 6" :key="n" class="card"><Skel h="190" r="12" /><div class="tcard-b"><Skel w="60%" h="14" /><Skel w="90%" h="12" /></div></div></div>
			<ErrorState v-else-if="error" :message="error" @retry="load" />
			<Empty v-else-if="!shown.length" icon="mail" :title="items.length ? 'No templates match' : 'No email templates yet'" :text="items.length ? 'Try a different search or filter.' : 'Create your first template with the visual builder, or paste your own HTML.'"><Btn v-if="isManager() && !items.length" variant="primary" icon="plus" @click="createOpen = true">Create template</Btn></Empty>
			<div v-else class="tgrid">
				<article v-for="t in shown" :key="t.name" class="tcard card hover" tabindex="0" @click="open(t)" @keydown.enter="open(t)">
					<div class="tcard-th"><Thumb :html="CM.sampleFill(t.body_html)" /><button type="button" class="star" :class="{ on: favs.includes(t.name) }" :aria-pressed="favs.includes(t.name)" :aria-label="favs.includes(t.name) ? 'Remove from favourites' : 'Add to favourites'" @click.stop="toggleFav(t.name)"><Ico name="star" /></button><span v-if="!t.enabled" class="badge neutral nodot arch">Archived</span></div>
					<div class="tcard-b"><div class="row"><b class="grow ellipsis">{{ t.template_name }}</b><Menu :items="menu(t)" /></div><span class="small muted ellipsis">{{ t.subject }}</span>
						<div class="row" style="gap:6px;margin-top:6px;flex-wrap:nowrap"><span v-if="t.category" class="tchip">{{ t.category }}</span><span class="tchip"><Ico :name="t.editor_mode === 'Visual Builder' ? 'layers' : t.editor_mode === 'Rich Text' ? 'edit' : 'code'" size="sm" style="margin-right:4px" />{{ t.editor_mode }}</span></div><div class="tiny faint" style="margin-top:2px">{{ t.used_in ? 'Used in ' + t.used_in + ' campaign' + (t.used_in > 1 ? 's' : '') : 'Not used yet' }} - updated {{ CM.ago(t.modified) }}</div></div></div>
				</article>
			</div>
			<Modal v-if="createOpen" size="lg" title="How would you like to create your email?" subtitle="You can always change the content later." @close="createOpen = false">
				<div class="mode-grid"><button v-for="m in MODE_INFO" :key="m.key" type="button" class="mode card hover" @click="create(m.key)"><span class="art"><Ico :name="m.icon" size="xl" /></span><b>{{ m.title }}</b><span class="muted small">{{ m.text }}</span><span v-if="m.tag" class="badge blue nodot">{{ m.tag }}</span></button>
					<button type="button" class="mode card hover" @click="createOpen = false; startOpen = true"><span class="art"><Ico name="copy" size="xl" /></span><b>Start from a template</b><span class="muted small">Copy one of your existing templates and change it.</span></button></div>
			</Modal>
			<TemplatePicker v-if="startOpen" title="Start from a template" subtitle="A copy is created. The original is not changed." :only-active="false" @pick="startFrom" @close="startOpen = false" />
			<PreviewModal v-if="preview" :subject="preview.subject" :html="preview.body_html" :title="preview.template_name" @close="preview = null" />
		</div>`,
	}

	V.EmailEditorRoute = {
		setup() {
			const p = computed(() => CM.route.parts)
			return { p, route: CM.route }
		},
		template: `<TemplateEditor :key="route.path + '|' + (route.query.mode || '') + '|' + (route.query.from || '')" :name="p[2] === 'edit' ? p[3] : undefined" :mode="route.query.mode" :from="route.query.from" />`,
	}
})()
