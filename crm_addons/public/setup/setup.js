/* CRM Pro Pack setup page: a guided front for the CRM Addons Settings record.
 * Left: the sections. Top of the first section: a live checklist that says what still needs doing and how.
 * Every option has a switch or field, a short label and an (i) button with the details. Changes are saved together. */
;(() => {
	const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue
	const SCHEMA = window.SETUP_SCHEMA || []

	// ------------------------------------------------------------------ theme (same rules as the other pages)
	const params = new URLSearchParams(location.search)
	function readTheme() {
		let t = params.get('theme')
		try { const v = String(localStorage.getItem('theme') || '').replace(/"/g, ''); if (!t && (v === 'dark' || v === 'light')) t = v } catch (e) { /* storage blocked */ }
		try { const v = localStorage.getItem('crm_addons_theme'); if (!t && (v === 'dark' || v === 'light')) t = v } catch (e) { /* storage blocked */ }
		return t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
	}
	const applyTheme = () => { const t = readTheme(); if (document.documentElement.getAttribute('data-theme') !== t) document.documentElement.setAttribute('data-theme', t) }
	applyTheme()
	window.addEventListener('storage', applyTheme)

	// ------------------------------------------------------------------ server calls
	let csrf = null
	async function token() {
		if (csrf) return csrf
		const r = await fetch('/api/method/crm_addons.api.get_csrf_token', { credentials: 'same-origin' })
		csrf = (await r.json()).message
		return csrf
	}
	const plain = (s) => { const d = document.createElement('div'); d.innerHTML = s; return d.textContent || '' }
	async function call(method, args) {
		const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 45000)
		try {
			const res = await fetch('/api/method/' + method, { method: 'POST', credentials: 'same-origin', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Frappe-CSRF-Token': await token() }, body: JSON.stringify(args || {}) })
			let body = {}; try { body = await res.json() } catch (e) { /* not json */ }
			if (!res.ok) {
				let msg = ''
				try { msg = JSON.parse(body._server_messages || '[]').map((m) => JSON.parse(m).message).join(' ') } catch (e) { /* none */ }
				const err = new Error(plain(msg) || (res.status === 403 ? 'You do not have permission to open this page.' : res.status === 401 ? 'Please log in to the CRM first.' : 'Something went wrong (' + res.status + ').'))
				err.status = res.status; throw err
			}
			return body.message
		} catch (e) {
			if (e && e.name === 'AbortError') throw new Error('The server took too long to answer. Please try again.')
			throw e
		} finally { clearTimeout(timer) }
	}

	// ------------------------------------------------------------------ small components
	const ICONS = {
		calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
		phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
		trend: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
		layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
		send: '<path d="M14.5 21.7a.5.5 0 0 0 .9 0l6.5-19a.5.5 0 0 0-.6-.6l-19 6.5a.5.5 0 0 0 0 .9l7.9 3.2a2 2 0 0 1 1.1 1.1z"/><path d="m21.9 2.1-10.9 10.9"/>',
		bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
		coin: '<circle cx="12" cy="12" r="9"/><path d="M14.8 9a3 3 0 0 0-2.8-1.5c-1.7 0-3 1-3 2.3 0 3 6 1.6 6 4.5 0 1.3-1.3 2.2-3 2.2a3.2 3.2 0 0 1-3-1.6M12 6v1.5M12 16.5V18"/>',
		check: '<path d="M20 6 9 17l-5-5"/>', list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
		alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3z"/><path d="M12 9v4M12 17h.01"/>',
		external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
		search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
		refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.7 2.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.7-2.7L3 16M8 16H3v5"/>',
		chevron: '<path d="m9 18 6-6-6-6"/>', home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
	}
	const Ico = { props: { name: String, size: { type: Number, default: 18 } }, template: `<svg class="ico" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="path"></svg>`, computed: { path() { return ICONS[this.name] || '' } } }

	// the (i) button: details on hover, keyboard focus or tap
	let openInfo = null
	const Info = {
		props: { info: Object, label: String },
		setup(props) {
			const open = ref(false); const side = ref('left'); const btn = ref(null)
			const close = () => { open.value = false; if (openInfo === close) openInfo = null }
			function show() {
				if (openInfo && openInfo !== close) openInfo()
				open.value = true; openInfo = close
				nextTick(() => { try { const r = btn.value.getBoundingClientRect(); side.value = r.left + 360 > window.innerWidth ? 'right' : 'left' } catch (e) { /* keep default */ } })
			}
			const toggle = () => (open.value ? close() : show())
			const onDoc = (e) => { if (open.value && btn.value && !btn.value.parentNode.contains(e.target)) close() }
			const onKey = (e) => { if (e.key === 'Escape') close() }
			onMounted(() => { document.addEventListener('click', onDoc); document.addEventListener('keydown', onKey) })
			onBeforeUnmount(() => { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey); close() })
			return { open, side, btn, show, close, toggle }
		},
		template: `<span class="info" @mouseenter="show" @mouseleave="close">
			<button ref="btn" type="button" class="info-b" :aria-label="'More about: ' + label" :aria-expanded="open" @click.stop="toggle" @focus="show" @blur="close">i</button>
			<span v-if="open" class="info-pop" :class="side" role="tooltip">
				<b class="info-t">{{ label }}</b>
				<span class="info-p">{{ info.what }}</span>
				<span v-if="info.eg" class="info-p eg"><i>For example</i> {{ info.eg }}</span>
				<span v-if="info.note" class="info-p note"><Ico name="alert" :size="14" /> {{ info.note }}</span>
			</span>
		</span>`,
		components: { Ico },
	}

	const Toggle = {
		props: { modelValue: [Number, Boolean], disabled: Boolean, label: String, id: String },
		emits: ['update:modelValue'],
		template: `<button :id="id" type="button" role="switch" class="sw" :class="{ on: !!modelValue }" :aria-checked="!!modelValue" :aria-label="label" :disabled="disabled" @click="$emit('update:modelValue', modelValue ? 0 : 1)"><span class="sw-k"></span><span class="sw-t">{{ modelValue ? 'On' : 'Off' }}</span></button>`,
	}

	// ------------------------------------------------------------------ the app
	const App = {
		components: { Ico, Info, Toggle },
		setup() {
			const loading = ref(true); const error = ref(''); const denied = ref(false)
			const server = ref({}) // values as saved
			const draft = reactive({}) // values being edited
			const choices = ref({}); const status = ref({ checks: [], todo: 0, ready: 0, total: 0 })
			const tab = ref(params.get('tab') || 'start'); const q = ref('')
			const saving = ref(false); const toast = reactive({ text: '', tone: '' })
			const open = reactive({}); const test = reactive({ busy: false, text: '', ok: false }); const rechecking = ref(false)
			const itemMap = {}; SCHEMA.forEach((g) => g.items.forEach((it) => { if (it.k) { itemMap[it.k] = it; it.group = g.key } }))

			const norm = (it, v) => (it && it.t === 'switch' ? (v ? 1 : 0) : it && (it.t === 'num') ? (v === '' || v == null ? 0 : Number(v)) : it && it.t === 'money' ? (v === '' || v == null ? '' : Number(v)) : v == null ? '' : v)
			function load(values) { server.value = values; Object.keys(draft).forEach((k) => delete draft[k]); Object.assign(draft, JSON.parse(JSON.stringify(values))) }
			async function init() {
				loading.value = true; error.value = ''; denied.value = false
				try {
					const r = await call('crm_addons.setup_page.get_setup')
					load(r.values); choices.value = r.choices; status.value = r.status
				} catch (e) { if (e.status === 403) denied.value = true; error.value = e.message } finally { loading.value = false }
			}
			onMounted(() => { init(); document.addEventListener('keydown', onKey); window.addEventListener('beforeunload', warn) })
			onBeforeUnmount(() => { document.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', warn) })

			// ---- what can be edited right now
			const met = (it) => { if (!it.when) return true; const [k, v] = Array.isArray(it.when) ? it.when : [it.when, undefined]; return v === undefined ? !!draft[k] : draft[k] === v }
			const parentLabel = (it) => { const k = Array.isArray(it.when) ? it.when[0] : it.when; const p = itemMap[k]; return p ? p.label : '' }
			const lockText = (it) => { const k = Array.isArray(it.when) ? it.when[0] : it.when; const p = itemMap[k]; if (!p) return ''; return Array.isArray(it.when) ? `Available when “${p.label}” is ${it.when[1]}.` : `Turn on “${p.label}” to change this.` }
			function problem(it) {
				if (!it.k || it.t === 'switch' || !met(it)) return ''
				const v = draft[it.k]
				if (it.t === 'num') {
					if (v === '' || v == null || Number.isNaN(Number(v))) return 'Enter a number.'
					if (!Number.isInteger(Number(v))) return 'Use a whole number.'
					if (it.min != null && Number(v) < it.min) return `Must be at least ${it.min}.`
					if (it.max != null && Number(v) > it.max) return `Must be at most ${it.max}.`
				}
				if (it.t === 'money' && v !== '' && v != null && (Number.isNaN(Number(v)) || Number(v) < 0)) return 'Enter a price of 0 or more.'
				if (it.k === 'default_country_code' && v && !/^\+?\d{1,4}$/.test(String(v).trim())) return 'Digits only, for example 91.'
				return ''
			}
			const dirtyKeys = computed(() => Object.keys(server.value).filter((k) => itemMap[k] && norm(itemMap[k], draft[k]) !== norm(itemMap[k], server.value[k])))
			const problems = computed(() => dirtyKeys.value.filter((k) => problem(itemMap[k])))
			const optionsOf = (it) => (it.choices ? (choices.value[it.choices] || []) : it.options || []).map((o) => (typeof o === 'object' ? o : { value: o, label: o }))

			// ---- sections shown
			const term = computed(() => q.value.trim().toLowerCase())
			const matches = (it) => !term.value || (it.label || '').toLowerCase().includes(term.value) || ((it.info && (it.info.what + ' ' + (it.info.eg || '') + ' ' + (it.info.note || ''))) || '').toLowerCase().includes(term.value)
			const groups = computed(() => SCHEMA.map((g) => {
				const items = g.items.filter((it) => it.h || matches(it))
				const real = items.filter((it) => it.k)
				const kept = items.filter((it, i) => !it.h || (items[i + 1] && !items[i + 1].h)) // drop a heading with nothing under it
				return { ...g, shown: term.value ? kept : g.items, count: real.length, changed: g.items.filter((it) => it.k && dirtyKeys.value.includes(it.k)).length }
			}))
			const visible = computed(() => (term.value ? groups.value.filter((g) => g.count) : groups.value.filter((g) => g.key === tab.value)))
			const noResults = computed(() => term.value && !visible.value.length)

			// ---- saving
			function say(text, tone) { toast.text = text; toast.tone = tone || ''; clearTimeout(say.t); say.t = setTimeout(() => (toast.text = ''), tone === 'err' ? 9000 : 3500) }
			async function save() {
				if (!dirtyKeys.value.length || saving.value) return
				if (problems.value.length) { const it = itemMap[problems.value[0]]; go(it.group, it.k); return say('Fix the highlighted option first: ' + problem(it), 'err') }
				saving.value = true
				try {
					const changed = {}; dirtyKeys.value.forEach((k) => (changed[k] = norm(itemMap[k], draft[k])))
					const r = await call('crm_addons.setup_page.save_setup', { values: JSON.stringify(changed) })
					load(r.values); status.value = r.status
					say('Saved. Pages that are already open pick up the change when they are refreshed.')
				} catch (e) { say(e.message, 'err') } finally { saving.value = false }
			}
			const discard = () => Object.assign(draft, JSON.parse(JSON.stringify(server.value)))
			const warn = (e) => { if (dirtyKeys.value.length) { e.preventDefault(); e.returnValue = '' } }
			function onKey(e) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save() } }

			// ---- navigation and the checklist
			function go(group, key) { q.value = ''; tab.value = group; nextTick(() => { const el = key && document.getElementById('f-' + key); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); try { el.focus({ preventScroll: true }) } catch (e) { /* fine */ } const row = el.closest('.row-i'); if (row) { row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1800) } } }) }
			function goToField(c) { const key = c.field || (c.key === 'google' ? 'google_calendar' : ''); if (key && itemMap[key]) go(itemMap[key].group, key) }
			async function recheck() { rechecking.value = true; try { const r = await call('crm_addons.setup_page.get_setup'); status.value = r.status; choices.value = r.choices } catch (e) { say(e.message, 'err') } finally { rechecking.value = false } }
			async function testGoogle() {
				test.busy = true; test.text = ''
				try { const r = await call('crm_addons.api.test_google_connection'); test.ok = !!r.ok; test.text = r.message } catch (e) { test.ok = false; test.text = e.message } finally { test.busy = false }
			}
			async function copy(text) { try { await navigator.clipboard.writeText(text); say('Copied') } catch (e) { say('Select the text and copy it.', 'err') } }
			const stateText = { ok: 'Ready', todo: 'Needs setup', optional: 'Optional' }
			const urls = (c) => (c.steps || []).map((s) => { const m = /(https?:\/\/\S+)/.exec(s); return m ? m[1] : '' })
			return { loading, error, denied, draft, server, choices, status, tab, q, groups, visible, noResults, term, saving, toast, open, test, rechecking, dirtyKeys, problems, problem, met, lockText, optionsOf, init, save, discard, go, goToField, recheck, testGoogle, copy, stateText, urls, SCHEMA, parentLabel, itemMap }
		},
		template: `
		<div class="shell">
			<header class="top">
				<div class="top-in">
					<div class="grow"><h1>CRM Pro Pack setup</h1><p>Switch features on or off, set how they behave, and see what still needs connecting.</p></div>
					<div class="search"><Ico name="search" :size="16" /><input v-model="q" type="search" placeholder="Find an option" aria-label="Find an option" /></div>
					<a class="btn" href="/crm"><Ico name="home" :size="16" /> Back to CRM</a>
				</div>
			</header>

			<div v-if="loading" class="body"><div class="skel" v-for="n in 5" :key="n"></div></div>
			<div v-else-if="error" class="body"><div class="card pad center"><Ico name="lock" :size="28" /><h2>{{ denied ? 'Only a System Manager can open this page' : 'The page could not load' }}</h2><p class="muted">{{ error }}</p><button v-if="!denied" class="btn primary" type="button" @click="init">Try again</button></div></div>

			<div v-else class="body">
				<nav class="side" aria-label="Sections">
					<button type="button" class="tabb" :class="{ on: tab === 'start' && !term }" @click="q = ''; tab = 'start'"><Ico name="list" :size="17" /><span>Setup checklist</span><span v-if="status.todo" class="pill warn">{{ status.todo }}</span><Ico v-else name="check" :size="15" class="okc" /></button>
					<div class="side-h">Options</div>
					<button v-for="g in groups" :key="g.key" type="button" class="tabb" :class="{ on: tab === g.key && !term }" @click="q = ''; tab = g.key"><Ico :name="g.icon" :size="17" /><span>{{ g.title }}</span><span v-if="g.changed" class="dot" title="Unsaved changes"></span></button>
				</nav>

				<main class="main">
					<!-- checklist -->
					<section v-if="tab === 'start' && !term" class="stack">
						<div class="card pad">
							<div class="row"><div class="grow"><h2>Setup checklist</h2><p class="muted">{{ status.todo ? status.todo + (status.todo > 1 ? ' things need' : ' thing needs') + ' your attention. Open one to see how to set it up.' : 'Everything this app needs is set up.' }}</p></div><button class="btn" type="button" :disabled="rechecking" @click="recheck"><Ico name="refresh" :size="16" /> {{ rechecking ? 'Checking...' : 'Check again' }}</button></div>
							<div class="prog" role="progressbar" :aria-valuenow="status.ready" aria-valuemin="0" :aria-valuemax="status.total"><i :style="{ width: (status.total ? 100 * status.ready / status.total : 0) + '%' }"></i></div>
							<div class="small muted">{{ status.ready }} of {{ status.total }} ready</div>
						</div>
						<article v-for="c in status.checks" :key="c.key" class="card chk" :class="c.state">
							<div class="chk-h" @click="open[c.key] = !open[c.key]" role="button" tabindex="0" :aria-expanded="!!open[c.key]" @keydown.enter="open[c.key] = !open[c.key]">
								<span class="chk-i"><Ico :name="c.state === 'ok' ? 'check' : c.state === 'todo' ? 'alert' : 'list'" :size="17" /></span>
								<div class="grow"><b>{{ c.label }}</b><div class="small muted">{{ c.message }}</div></div>
								<span class="pill" :class="c.state">{{ stateText[c.state] }}</span><Ico name="chevron" :size="16" class="chev" :class="{ down: open[c.key] }" />
							</div>
							<div v-if="open[c.key]" class="chk-b">
								<p v-if="c.why" class="small"><b>Why it matters.</b> {{ c.why }}</p>
								<template v-if="c.state !== 'ok' && c.steps && c.steps.length"><b class="small">How to set it up</b><ol class="steps"><li v-for="(s, i) in c.steps" :key="i">{{ s }}</li></ol></template>
								<div class="row wrap" style="gap:8px">
									<a v-if="c.fix" class="btn primary" :href="c.fix.url" target="_blank" rel="noopener">{{ c.fix.label }} <Ico name="external" :size="14" /></a>
									<button v-if="c.field || c.key === 'google'" class="btn" type="button" @click="goToField(c)">{{ c.key === 'google' ? 'Choose the calendar' : 'Go to the setting' }}</button>
									<button v-if="c.key === 'google'" class="btn" type="button" :disabled="test.busy" @click="testGoogle">{{ test.busy ? 'Testing...' : 'Test the connection' }}</button>
								</div>
								<div v-if="c.key === 'google' && test.text" class="note-box" :class="test.ok ? 'ok' : 'bad'">{{ test.text }}</div>
							</div>
						</article>
					</section>

					<!-- options -->
					<section v-for="g in visible" :key="g.key" class="stack">
						<div class="card pad">
							<div class="row"><span class="g-i"><Ico :name="g.icon" :size="19" /></span><div class="grow"><h2>{{ g.title }}</h2><p class="muted">{{ g.desc }}</p></div></div>
							<template v-for="(it, i) in g.shown" :key="(it.k || it.h) + i">
								<h3 v-if="it.h" class="sub">{{ it.h }}</h3>
								<div v-else class="row-i" :class="{ locked: !met(it), child: it.when, bad: problem(it) }">
									<div class="row-l">
										<div class="lab"><label :for="'f-' + it.k">{{ it.label }}</label><Info :info="it.info" :label="it.label" /></div>
										<div v-if="!met(it)" class="hint"><Ico name="lock" :size="12" /> {{ lockText(it) }}</div>
										<div v-else-if="problem(it)" class="err">{{ problem(it) }}</div>
									</div>
									<div class="row-c">
										<Toggle v-if="it.t === 'switch'" :id="'f-' + it.k" v-model="draft[it.k]" :label="it.label" :disabled="!met(it)" />
										<template v-else-if="it.t === 'num'"><input :id="'f-' + it.k" class="inp num" type="number" inputmode="numeric" :min="it.min" :max="it.max" step="1" v-model="draft[it.k]" :disabled="!met(it)" /><span class="unit">{{ it.unit }}</span></template>
										<template v-else-if="it.t === 'money'"><input :id="'f-' + it.k" class="inp num" type="number" inputmode="decimal" min="0" step="any" :placeholder="it.placeholder" v-model="draft[it.k]" :disabled="!met(it)" /></template>
										<select v-else-if="it.t === 'select'" :id="'f-' + it.k" class="inp" v-model="draft[it.k]" :disabled="!met(it)"><option v-if="it.empty" value="">{{ it.empty }}</option><option v-for="o in optionsOf(it)" :key="o.value" :value="o.value">{{ o.label }}</option></select>
										<textarea v-else-if="it.t === 'area'" :id="'f-' + it.k" class="inp area" rows="3" v-model="draft[it.k]" :disabled="!met(it)"></textarea>
										<input v-else :id="'f-' + it.k" class="inp" type="text" :placeholder="it.placeholder" v-model="draft[it.k]" :disabled="!met(it)" autocomplete="off" />
									</div>
								</div>
							</template>
						</div>
					</section>
					<div v-if="noResults" class="card pad center"><Ico name="search" :size="26" /><h2>No option matches “{{ q }}”</h2><p class="muted">Try another word, for example “reminder”, “WhatsApp” or “hide”.</p></div>
				</main>
			</div>

			<div v-if="!loading && !error && dirtyKeys.length" class="savebar" role="region" aria-label="Unsaved changes">
				<div class="savebar-in"><span><b>{{ dirtyKeys.length }}</b> unsaved change{{ dirtyKeys.length > 1 ? 's' : '' }}<span v-if="problems.length" class="errtxt"> - {{ problems.length }} need{{ problems.length > 1 ? '' : 's' }} fixing</span></span><span class="grow"></span><button class="btn" type="button" :disabled="saving" @click="discard">Discard</button><button class="btn primary" type="button" :disabled="saving" @click="save">{{ saving ? 'Saving...' : 'Save changes' }}</button></div>
			</div>
			<div v-if="toast.text" class="toast" :class="toast.tone" role="status">{{ toast.text }}</div>
		</div>`,
	}
	createApp(App).mount('#app')
	document.title = 'Pro Pack Setup'
})()
