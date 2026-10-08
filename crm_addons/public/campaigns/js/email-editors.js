/* Campaign Manager: the three ways to write an email (visual builder, HTML editor, rich text) plus the shared
 * "send a test email" dialog and the server-side preview helper. */
(() => {
	const { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue
	const CM = window.CM
	const C = CM.components

	/** Debounced server rendering of a (possibly unsaved) subject + html with sample data. */
	CM.useRender = (getSubject, getHtml, wait = 450) => {
		const out = reactive({ subject: '', html: '', unknown: [], loading: false, error: '', sample: true })
		const id = CM.uid() // each preview has its own "latest" slot
		let seq = 0
		const run = CM.debounce(async () => {
			const my = ++seq; out.loading = true
			try {
				const r = await CM.apiLatest('render-preview:' + id, 'render_email_preview', { subject: getSubject() || '', html: getHtml() || '' })
				if (my !== seq) return
				Object.assign(out, { subject: r.subject, html: r.html, unknown: r.unknown, error: '' })
			} catch (e) { if (my === seq) out.error = e.message } finally { if (my === seq) out.loading = false }
		}, wait)
		watch(() => [getSubject(), getHtml()], run, { immediate: true })
		onBeforeUnmount(() => { run.cancel(); CM.cancel('render-preview:' + id) })
		return out
	}

	// ------------------------------------------------------------------ small pieces
	C.ColorInp = {
		props: { modelValue: String },
		emits: ['update:modelValue'],
		template: `<div class="color"><input type="color" :value="modelValue" aria-label="Pick colour" @input="$emit('update:modelValue', $event.target.value)" /><input class="inp mono" :value="modelValue" maxlength="9" aria-label="Colour code" @input="$emit('update:modelValue', $event.target.value)" /></div>`,
	}
	C.EmailChips = {
		props: { modelValue: { type: Array, default: () => [] }, max: { type: Number, default: 10 }, placeholder: { type: String, default: 'name@company.com' } },
		emits: ['update:modelValue'],
		setup(props, { emit }) {
			const text = ref(''); const bad = ref('')
			const ok = (s) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s)
			function commit() {
				const parts = text.value.split(/[\s,;]+/).filter(Boolean)
				if (!parts.length) return
				const next = [...props.modelValue]; const wrong = []
				parts.forEach((p) => { p = p.toLowerCase(); if (!ok(p)) wrong.push(p); else if (!next.includes(p) && next.length < props.max) next.push(p) })
				emit('update:modelValue', next); text.value = wrong.join(' '); bad.value = wrong.length ? `Not a valid email address: ${wrong.join(', ')}` : ''
			}
			const remove = (e) => emit('update:modelValue', props.modelValue.filter((x) => x !== e))
			function key(e) { if (['Enter', ',', ';', ' '].includes(e.key) && text.value.trim()) { e.preventDefault(); e.stopPropagation(); commit() } else if (e.key === 'Backspace' && !text.value && props.modelValue.length) remove(props.modelValue[props.modelValue.length - 1]) }
			return { text, bad, commit, remove, key }
		},
		template: `<div><div class="chips-in inp" :class="{ bad: bad }"><span v-for="e in modelValue" :key="e" class="tchip-x">{{ e }}<button type="button" :aria-label="'Remove ' + e" @click="remove(e)"><Ico name="x" size="sm" /></button></span><input v-model="text" :placeholder="modelValue.length ? '' : placeholder" aria-label="Email addresses" @keydown="key" @blur="commit" @paste.prevent="text += $event.clipboardData.getData('text'); commit()" /></div><div v-if="bad" class="err small" style="margin-top:4px;color:var(--red)">{{ bad }}</div></div>`,
	}

	// ------------------------------------------------------------------ send a test email
	C.SendTest = {
		props: { subject: String, html: String, template: String, attachments: { type: Array, default: () => [] }, lead: String },
		emits: ['close'],
		setup(props, { emit }) {
			const emails = ref([]); const state = ref('idle'); const message = ref('')
			const max = computed(() => (CM.shared.config && CM.shared.config.test_email_max) || 10)
			onMounted(async () => { await CM.loadShared(); const me = CM.shared.config && CM.shared.config.sender_email; if (me && !emails.value.length) emails.value = [me] })
			async function send() {
				if (!emails.value.length) { state.value = 'error'; message.value = 'Add at least one email address.'; return }
				state.value = 'sending'; message.value = ''
				try {
					const r = await CM.api('send_test_email', { emails: emails.value, subject: props.subject, html: props.html, email_template: props.template || undefined, attachments: props.attachments, lead: props.lead || undefined })
					state.value = 'ok'; message.value = `Sent to ${r.to.join(', ')}. It uses sample data and the subject starts with [Test].`
					CM.toast('Test email sent')
				} catch (e) { state.value = 'error'; message.value = e.message }
			}
			return { emails, state, message, max, send }
		},
		template: `
		<Modal title="Send a test email" subtitle="Check how it looks in a real inbox before it goes to your audience." @close="$emit('close')" @submit="send">
			<Field label="Send to" :hint="'Up to ' + max + ' addresses. Separate with comma or Enter.'"><EmailChips v-model="emails" :max="max" /></Field>
			<div class="alert"><Ico name="info" /><div class="grow">The test is filled with sample lead data, the subject starts with <b>[Test]</b>, and nothing is recorded on any lead or campaign.</div></div>
			<div v-if="state === 'ok'" class="alert ok" role="status"><Ico name="check-circle" /><div class="grow">{{ message }}</div></div>
			<div v-if="state === 'error'" class="alert err" role="alert"><Ico name="alert" /><div class="grow">{{ message }}</div></div>
			<template #foot><Btn @click="$emit('close')">{{ state === 'ok' ? 'Done' : 'Cancel' }}</Btn><Btn variant="primary" icon="send" :loading="state === 'sending'" @click="send">{{ state === 'sending' ? 'Sending' : state === 'ok' ? 'Send again' : 'Send test' }}</Btn></template>
		</Modal>`,
	}

	// ------------------------------------------------------------------ visual builder
	C.Builder = {
		props: { doc: Object },
		setup(props) {
			const selId = ref(null); const over = ref(-1); const dragging = ref(null); const panel = ref(null)
			const blocks = computed(() => props.doc.blocks)
			const sel = computed(() => blocks.value.find((b) => b.id === selId.value))
			const selIndex = computed(() => blocks.value.findIndex((b) => b.id === selId.value))
			const groups = computed(() => { const g = {}; Object.entries(CM.BLOCKS).forEach(([k, v]) => (g[v.group] = g[v.group] || []).push({ type: k, ...v })); return Object.entries(g) })
			// the canvas HTML of every block is computed once per change of the blocks, not on every hover / drag event
				const rowsHtml = computed(() => Object.fromEntries(props.doc.blocks.map((b) => [b.id, CM.renderBlockRow(b, props.doc.settings, true)])))
				const row = (b) => rowsHtml.value[b.id] || ''
			function add(type, at) { const last = blocks.value[blocks.value.length - 1]; const b = CM.newBlock(type); const i = at ?? (selIndex.value >= 0 ? selIndex.value + 1 : last && last.type === 'footer' ? blocks.value.length - 1 : blocks.value.length); blocks.value.splice(i, 0, b); selId.value = b.id }
			function move(i, d) { const j = i + d; if (j < 0 || j >= blocks.value.length) return; const [b] = blocks.value.splice(i, 1); blocks.value.splice(j, 0, b) }
			function dup(i) { const c = CM.clone(blocks.value[i]); c.id = CM.uid(); blocks.value.splice(i + 1, 0, c); selId.value = c.id }
			function del(i) { blocks.value.splice(i, 1); selId.value = null }
			function dragNew(e, type) { e.dataTransfer.setData('text/plain', 'new:' + type); e.dataTransfer.effectAllowed = 'copy'; dragging.value = 'new' }
			function dragMove(e, i) { e.dataTransfer.setData('text/plain', 'move:' + i); e.dataTransfer.effectAllowed = 'move'; dragging.value = 'move' }
			function dragOver(e, i) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); over.value = i + (e.clientY > r.top + r.height / 2 ? 1 : 0) }
			function drop(e) {
				e.preventDefault(); const data = e.dataTransfer.getData('text/plain'); let at = over.value < 0 ? blocks.value.length : over.value
				over.value = -1; dragging.value = null
				if (data.startsWith('new:')) add(data.slice(4), at)
				else if (data.startsWith('move:')) { const from = +data.slice(5); const [b] = blocks.value.splice(from, 1); if (from < at) at--; blocks.value.splice(at, 0, b); selId.value = b.id }
			}
			function endDrag() { over.value = -1; dragging.value = null }
			function insertVar(key, token) { const el = panel.value && panel.value.querySelector(`[data-key="${key}"]`); CM.insertAtCursor(el, token) }
			const schema = computed(() => (sel.value ? CM.BLOCKS[sel.value.type].schema : []))
			async function pickImage(files) { /* handled by Uploader */ }
			function setColsCount() { const p = sel.value.props; p.count = +p.count; while (p.cols.length < p.count) p.cols.push({ heading: 'Heading', text: 'Text' }) }
			const addLink = () => sel.value.props.links.push({ network: 'Website', url: 'https://' })
			const networks = ['Facebook', 'Instagram', 'LinkedIn', 'YouTube', 'X', 'WhatsApp', 'Website']
			return { selId, over, dragging, panel, blocks, sel, selIndex, groups, row, add, move, dup, del, dragNew, dragMove, dragOver, drop, endDrag, insertVar, schema, setColsCount, addLink, networks, CM, fonts: CM.FONTS }
		},
		template: `
		<div class="bld">
			<aside class="bld-pal" aria-label="Blocks">
				<div class="lbl" style="padding:2px 4px 8px">Add a block</div>
				<template v-for="g in groups" :key="g[0]"><div class="pal-g">{{ g[0] }}</div>
					<button v-for="b in g[1]" :key="b.type" type="button" class="pal-i" draggable="true" :title="'Click to add, or drag into the email'" @click="add(b.type)" @dragstart="dragNew($event, b.type)" @dragend="endDrag"><Ico :name="b.icon" /><span>{{ b.label }}</span></button>
				</template>
			</aside>
			<section class="bld-cv" :style="{ background: doc.settings.bg }" @click.self="selId = null" @dragover.prevent @drop="drop">
				<div class="cv-card" :style="{ maxWidth: doc.settings.width + 'px', background: doc.settings.contentBg }" @click.self="selId = null">
					<template v-for="(b, i) in blocks" :key="b.id">
						<div v-if="over === i && dragging" class="drop-line"></div>
						<div class="blk" :class="{ sel: b.id === selId }" tabindex="0" role="button" :aria-label="CM.BLOCKS[b.type].label + ' block'" @click="selId = b.id" @keydown.enter.self="selId = b.id" @keydown.delete.self="del(i)" draggable="true" @dragstart="dragMove($event, i)" @dragend="endDrag" @dragover="dragOver($event, i)">
							<div class="blk-body" v-html="row(b)"></div>
							<div class="blk-tools" @click.stop><span class="blk-tag">{{ CM.BLOCKS[b.type].label }}</span><button type="button" title="Move up" aria-label="Move up" :disabled="i === 0" @click="move(i, -1)"><Ico name="arrow-up" size="sm" /></button><button type="button" title="Move down" aria-label="Move down" :disabled="i === blocks.length - 1" @click="move(i, 1)"><Ico name="arrow-down" size="sm" /></button><button type="button" title="Duplicate" aria-label="Duplicate" @click="dup(i)"><Ico name="copy" size="sm" /></button><button type="button" title="Delete" aria-label="Delete block" @click="del(i)"><Ico name="trash" size="sm" /></button></div>
						</div>
					</template>
					<div v-if="over === blocks.length && dragging" class="drop-line"></div>
					<div v-if="!blocks.length" class="cv-empty" @dragover.prevent="over = 0"><Ico name="plus" size="lg" /><b>Drag a block here</b><span>or click a block on the left</span></div>
					<div v-else class="cv-end" @dragover.prevent="over = blocks.length"></div>
				</div>
			</section>
			<aside ref="panel" class="bld-prop" aria-label="Block settings">
				<template v-if="sel">
					<div class="row" style="margin-bottom:12px"><div class="grow"><div class="lbl">Selected block</div><b style="font-size:15px">{{ CM.BLOCKS[sel.type].label }}</b></div><Btn size="sm" variant="ghost" icon="trash" aria-label="Delete block" @click="del(selIndex)" /></div>
					<div class="col" style="gap:14px">
					<template v-for="f in schema" :key="f.key || f.type">
						<template v-if="f.type === 'cols'"><div v-for="(c, ci) in sel.props.cols.slice(0, +sel.props.count)" :key="ci" class="card pad" style="padding:12px;box-shadow:none"><div class="lbl" style="margin-bottom:6px">Column {{ ci + 1 }}</div><input class="inp" v-model="c.heading" aria-label="Column heading" placeholder="Heading" style="margin-bottom:8px" /><textarea class="inp" v-model="c.text" aria-label="Column text" rows="3"></textarea></div></template>
						<template v-else-if="f.type === 'links'"><div class="col" style="gap:8px"><div class="lbl">Links</div><div v-for="(l, li) in sel.props.links" :key="li" class="row" style="gap:6px"><div style="width:118px"><Dd v-model="l.network" :options="networks" size="sm" /></div><input class="inp grow" style="height:32px" v-model="l.url" aria-label="Link address" placeholder="https://" /><Btn size="sm" variant="ghost" icon="x" aria-label="Remove link" @click="sel.props.links.splice(li, 1)" /></div><Btn size="sm" icon="plus" @click="addLink">Add link</Btn></div></template>
						<Field v-else :label="f.label" :hint="f.hint">
							<div v-if="f.type === 'text'" class="row" style="gap:6px"><input class="inp grow" :data-key="f.key" v-model="sel.props[f.key]" :placeholder="f.placeholder" /><VarMenu v-if="f.vars" label="" size="sm" @pick="(t) => insertVar(f.key, t)" /></div>
							<template v-else-if="f.type === 'textarea'"><textarea class="inp" :data-key="f.key" rows="4" v-model="sel.props[f.key]"></textarea><div v-if="f.vars" style="margin-top:6px"><VarMenu @pick="(t) => insertVar(f.key, t)" /></div></template>
							<textarea v-else-if="f.type === 'code'" class="inp mono" :data-key="f.key" rows="8" spellcheck="false" v-model="sel.props[f.key]"></textarea>
							<Dd v-else-if="f.type === 'select'" v-model="sel.props[f.key]" :options="f.options" @change="f.key === 'count' && setColsCount()" />
							<ColorInp v-else-if="f.type === 'color'" v-model="sel.props[f.key]" />
							<input v-else-if="f.type === 'number'" class="inp" type="number" :min="f.min" :max="f.max" v-model.number="sel.props[f.key]" />
							<div v-else-if="f.type === 'switch'"><Switch v-model="sel.props[f.key]" :label="f.label" /></div>
							<div v-else-if="f.type === 'image'" class="col" style="gap:8px"><Uploader :model-value="sel.props.src ? [{ file_url: sel.props.src, file_name: sel.props.src.split('/').pop(), file_size: 0 }] : []" :is-private="false" :multiple="false" accept="image/*" :max-mb="5" title="Drop an image or browse" hint="PNG, JPG or GIF up to 5 MB. Stored publicly so email apps can show it." @update:model-value="(v) => (sel.props.src = v[0] ? v[0].file_url : '')" /><input class="inp" v-model="sel.props.src" placeholder="...or paste an image address (https://)" aria-label="Image address" /></div>
						</Field>
					</template></div>
				</template>
				<template v-else>
					<div class="lbl" style="margin-bottom:2px">Email style</div><p class="small muted" style="margin:0 0 14px">Click a block to edit it. These settings apply to the whole email.</p>
					<div class="col" style="gap:14px">
						<Field label="Page background"><ColorInp v-model="doc.settings.bg" /></Field>
						<Field label="Content background"><ColorInp v-model="doc.settings.contentBg" /></Field>
						<Field label="Content width (px)"><input class="inp" type="number" min="420" max="720" v-model.number="doc.settings.width" /></Field>
						<Field label="Font"><Dd v-model="doc.settings.font" :options="fonts" /></Field>
					</div>
				</template>
			</aside>
		</div>`,
	}

	// ------------------------------------------------------------------ HTML editor (code | preview)
	C.HtmlEditor = {
		props: { modelValue: String, subject: String },
		emits: ['update:modelValue'],
		setup(props, { emit }) {
			const ta = ref(null); const pre = ref(null); const gutter = ref(null); const problems = ref(null); const view = ref('split')
			const lines = computed(() => (props.modelValue || '').split('\n').length)
			// The coloured overlay re-parses the whole source. Small emails are coloured on every keystroke; a medium one trails
			// the typing by 120 ms (the textarea shows its own text meanwhile, so nothing typed is ever invisible); a huge
			// one (> 120 KB) is shown without colours. Typing stays instant at any size.
			const HL_MAX = 120000
			const colour = (t) => (t.length > HL_MAX ? CM.escape(t) + '\n' : CM.highlightHtml(t))
			const hl = ref(colour(props.modelValue || '')); const stale = ref(false)
			let hlTimer = 0
			watch(() => props.modelValue, (v) => {
				const t = v || ''; clearTimeout(hlTimer)
				if (t.length <= 12000 || t.length > HL_MAX) { hl.value = colour(t); stale.value = false } else { stale.value = true; hlTimer = setTimeout(() => { hl.value = colour(t); stale.value = false }, 120) }
			})
			onBeforeUnmount(() => clearTimeout(hlTimer))
			// one text node for the line numbers instead of one element per line (a 15 000 line email made 15 000 elements)
			const nums = computed(() => { const n = lines.value; let out = '1'; for (let i = 2; i <= n; i++) out += '\n' + i; return out })
			const set = (v) => emit('update:modelValue', v)
			function sync() { if (!ta.value) return; pre.value.scrollTop = ta.value.scrollTop; pre.value.scrollLeft = ta.value.scrollLeft; gutter.value.scrollTop = ta.value.scrollTop }
			function key(e) {
				if (e.key === 'Tab') { e.preventDefault(); const t = e.target, s = t.selectionStart; t.setRangeText('  ', s, t.selectionEnd, 'end'); set(t.value) }
			}
			function format() { set(CM.formatHtml(props.modelValue || '')); problems.value = null; CM.toast('Formatted') }
			async function validate() {
				const list = CM.validateHtml(props.modelValue || '')
				let unknown = []
				try { unknown = (await CM.api('render_email_preview', { subject: props.subject || '', html: props.modelValue || '' })).unknown } catch (e) { /* offline */ }
				if (unknown.length) list.push('Unknown variable(s): ' + unknown.join(', ') + '. Use the Insert variable list.')
				problems.value = list
			}
			const insert = (t) => { CM.insertAtCursor(ta.value, t) }
			const render = CM.useRender(() => props.subject, () => props.modelValue)
			return { ta, pre, gutter, problems, view, lines, nums, stale, hl, sync, key, format, validate, insert, render, set, fromName: computed(() => CM.shared.config && CM.shared.config.sender_name), fromEmail: computed(() => CM.shared.config && CM.shared.config.sender_email) }
		},
		template: `
		<div class="he">
			<div class="he-bar"><Btn size="sm" icon="sparkles" @click="format">Format</Btn><Btn size="sm" icon="check-circle" @click="validate">Validate</Btn><VarMenu @pick="insert" /><span class="grow"></span><Seg v-model="view" :options="[{ value: 'code', label: 'Code' }, { value: 'split', label: 'Split' }, { value: 'preview', label: 'Preview' }]" /></div>
			<div v-if="problems" class="alert" :class="problems.length ? 'warn' : 'ok'" role="status" style="margin-bottom:10px"><Ico :name="problems.length ? 'alert' : 'check-circle'" /><div class="grow"><b v-if="!problems.length">Looks good.</b> No problems found.<template v-if="problems.length"><div v-for="p in problems" :key="p">{{ p }}</div></template></div><Btn size="sm" variant="ghost" icon="x" aria-label="Dismiss" @click="problems = null" /></div>
			<div class="he-split" :class="view">
				<div v-show="view !== 'preview'" class="he-code"><div ref="gutter" class="he-gutter" aria-hidden="true"><div v-for="n in lines" :key="n">{{ n }}</div></div><div class="he-ed"><pre ref="pre" class="he-hl" aria-hidden="true" v-html="hl"></pre><textarea ref="ta" class="he-ta" spellcheck="false" wrap="off" aria-label="HTML code" :value="modelValue" @input="set($event.target.value)" @scroll="sync" @keydown="key"></textarea></div></div>
				<div v-show="view !== 'code'" class="he-pv"><EmailPreview :subject="render.subject || subject" :html="render.html" :from-name="fromName" :from-email="fromEmail" :loading="render.loading" note="Filled with sample data" /></div>
			</div>
		</div>`,
	}

	// ------------------------------------------------------------------ rich text editor
	C.RichEditor = {
		props: { modelValue: String, subject: String },
		emits: ['update:modelValue'],
		setup(props, { emit }) {
			const ed = ref(null); let saved = null; const linkOpen = ref(false); const link = reactive({ url: 'https://', text: '' }); const imgOpen = ref(false); const img = reactive({ url: '', files: [] })
			onMounted(() => { ed.value.innerHTML = CM.sanitizeHtml(props.modelValue || ''); document.addEventListener('selectionchange', track) })
			onBeforeUnmount(() => document.removeEventListener('selectionchange', track))
			watch(() => props.modelValue, (v) => { if (ed.value && v !== ed.value.innerHTML) ed.value.innerHTML = CM.sanitizeHtml(v || '') })
			function track() { const s = getSelection(); if (s.rangeCount && ed.value && ed.value.contains(s.anchorNode)) saved = s.getRangeAt(0).cloneRange() }
			function restore() { ed.value.focus(); if (saved) { const s = getSelection(); s.removeAllRanges(); s.addRange(saved) } }
			const changed = () => emit('update:modelValue', ed.value.innerHTML)
			function cmd(c, v) { restore(); document.execCommand(c, false, v || null); changed() }
			function insertText(t) { restore(); document.execCommand('insertText', false, t); changed() }
			function openLink() { track(); link.text = getSelection().toString(); link.url = 'https://'; linkOpen.value = true }
			function applyLink() { linkOpen.value = false; restore(); if (getSelection().toString()) document.execCommand('createLink', false, link.url); else document.execCommand('insertHTML', false, `<a href="${CM.escape(link.url)}">${CM.escape(link.text || link.url)}</a>`); changed() }
			function openImg() { track(); img.url = ''; img.files = []; imgOpen.value = true }
			function applyImg() { const u = img.files[0] ? img.files[0].file_url : img.url; imgOpen.value = false; if (!u) return; restore(); document.execCommand('insertImage', false, u); changed() }
			function paste(e) { e.preventDefault(); const t = (e.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, t) }
			const tools = [
				['bold', 'bold', 'Bold'], ['italic', 'italic', 'Italic'], ['underline', 'underline', 'Underline'], ['|'],
				['formatBlock:h1', 'H1', 'Heading'], ['formatBlock:h2', 'H2', 'Subheading'], ['formatBlock:p', 'P', 'Paragraph'], ['|'],
				['insertUnorderedList', 'list', 'Bullet list'], ['insertOrderedList', 'list-ol', 'Numbered list'], ['|'],
			]
			const run = (t) => { const [c, v] = t[0].split(':'); cmd(c, v ? '<' + v + '>' : null) }
			const render = CM.useRender(() => props.subject, () => CM.richToEmail(props.modelValue || ''))
			const show = ref(true)
			return { ed, changed, cmd, tools, run, openLink, openImg, applyLink, applyImg, link, img, linkOpen, imgOpen, paste, insertText, render, show, fromName: computed(() => CM.shared.config && CM.shared.config.sender_name), fromEmail: computed(() => CM.shared.config && CM.shared.config.sender_email) }
		},
		template: `
		<div class="re">
			<div class="re-bar" role="toolbar" aria-label="Formatting">
				<template v-for="(t, i) in tools" :key="i"><span v-if="t[0] === '|'" class="re-sep"></span><button v-else type="button" class="btn ghost icon sm" :title="t[2]" :aria-label="t[2]" @mousedown.prevent @click="run(t)"><b v-if="/^(H1|H2|P)$/.test(t[1])" style="font-size:12px">{{ t[1] }}</b><Ico v-else :name="t[1]" /></button></template>
				<button type="button" class="btn ghost icon sm" title="Link" aria-label="Insert link" @mousedown.prevent @click="openLink"><Ico name="link" /></button>
				<button type="button" class="btn ghost icon sm" title="Image" aria-label="Insert image" @mousedown.prevent @click="openImg"><Ico name="image" /></button>
				<button type="button" class="btn ghost icon sm" title="Undo" aria-label="Undo" @mousedown.prevent @click="cmd('undo')"><Ico name="undo" /></button>
				<button type="button" class="btn ghost icon sm" title="Clear formatting" aria-label="Clear formatting" @mousedown.prevent @click="cmd('removeFormat')"><Ico name="x" /></button>
				<span class="re-sep"></span><VarMenu @pick="insertText" /><span class="grow"></span><Seg v-model="show" :options="[{ value: true, label: 'Preview on' }, { value: false, label: 'Off' }]" />
			</div>
			<div class="re-split" :class="{ one: !show }">
				<div class="re-page"><div ref="ed" class="re-ed" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Email content" @input="changed" @paste="paste"></div></div>
				<div v-if="show" class="he-pv"><EmailPreview :subject="render.subject || subject" :html="render.html" :from-name="fromName" :from-email="fromEmail" :loading="render.loading" note="Filled with sample data" /></div>
			</div>
			<Modal v-if="linkOpen" size="sm" title="Insert link" top @close="linkOpen = false" @submit="applyLink"><Field label="Link address"><input class="inp" v-model="link.url" placeholder="https://" autofocus /></Field><Field v-if="!link.text" label="Text to show"><input class="inp" v-model="link.text" /></Field><template #foot><Btn @click="linkOpen = false">Cancel</Btn><Btn variant="primary" @click="applyLink">Insert</Btn></template></Modal>
			<Modal v-if="imgOpen" size="sm" title="Insert image" top @close="imgOpen = false" @submit="applyImg"><Uploader v-model="img.files" :is-private="false" :multiple="false" accept="image/*" :max-mb="5" title="Drop an image or browse" hint="Stored publicly so email apps can show it." /><Field label="...or an image address"><input class="inp" v-model="img.url" placeholder="https://" /></Field><template #foot><Btn @click="imgOpen = false">Cancel</Btn><Btn variant="primary" @click="applyImg">Insert</Btn></template></Modal>
		</div>`,
	}
})()
