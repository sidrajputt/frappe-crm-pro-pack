/* Campaign Manager: reusable components (button, dropdown, menu, modal, drawer, tabs, badges, stepper, uploader,
 * empty state, skeleton, previews, charts). Registered on CM.components and mounted globally by app.js. */
(() => {
	const { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue
	const CM = window.CM
	const C = CM.components

	// ------------------------------------------------------------------ icon / button / field
	C.Ico = {
		props: { name: String, size: String },
		computed: { path() { return CM.ICONS[this.name] || '' } },
		template: `<svg class="ico" :class="size" viewBox="0 0 24 24" aria-hidden="true" v-html="path"></svg>`,
	}
	C.Btn = {
		props: { variant: String, size: String, icon: String, loading: Boolean, disabled: Boolean, type: { type: String, default: 'button' } },
		template: `<button class="btn" :class="[variant, size]" :type="type" :disabled="disabled || loading"><span v-if="loading" class="spin"></span><Ico v-else-if="icon" :name="icon" /><slot /></button>`,
	}
	C.Field = {
		props: { label: String, hint: String, error: String, required: Boolean, htmlFor: String },
		template: `<div class="field"><label v-if="label" :for="htmlFor">{{ label }}<span v-if="required" class="req">*</span></label><slot /><div v-if="error" class="err" role="alert">{{ error }}</div><div v-else-if="hint" class="hint">{{ hint }}</div></div>`,
	}
	C.Inp = {
		props: { modelValue: [String, Number], icon: String, clearable: Boolean, bad: Boolean },
		emits: ['update:modelValue'],
		template: `<div class="inp-wrap"><Ico v-if="icon" :name="icon" /><input class="inp" :class="{ bad }" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" v-bind="$attrs" /><button v-if="clearable && modelValue" type="button" class="clear" aria-label="Clear" @click="$emit('update:modelValue', '')"><Ico name="x" size="sm" /></button></div>`,
		inheritAttrs: false,
	}
	C.Seg = {
		props: { modelValue: [String, Number, Boolean], options: Array, icons: Boolean },
		emits: ['update:modelValue'],
		template: `<div class="seg" :class="{ icons }" role="group"><button v-for="o in options" :key="o.value" type="button" :class="{ on: o.value === modelValue }" :title="o.label" :aria-label="o.label" :aria-pressed="o.value === modelValue" @click="$emit('update:modelValue', o.value)"><Ico v-if="o.icon" :name="o.icon" /><span v-if="!icons">{{ o.label }}</span></button></div>`,
	}
	C.Switch = {
		props: { modelValue: Boolean, label: String },
		emits: ['update:modelValue'],
		template: `<button type="button" role="switch" class="switch" :class="{ on: modelValue }" :aria-checked="modelValue" :aria-label="label" @click="$emit('update:modelValue', !modelValue)"></button>`,
	}

	// ------------------------------------------------------------------ popover plumbing
	function usePop(getAnchor, { width = 0, maxH = 340, align = 'left', layout, onClose } = {}) {
		const open = ref(false); const style = ref({}); const pop = ref(null)
		function place(e) {
			if (e && e.type === 'scroll' && pop.value && pop.value.contains(e.target)) return // scrolling the list itself never moves the anchor
			const a = getAnchor(); if (!a) return
			const r = a.getBoundingClientRect()
			if (layout) { style.value = layout(r); return }
			const below = innerHeight - r.bottom, above = r.top
			const w = Math.max(width, r.width)
			const up = below < 240 && above > below
			const left = align === 'right' ? Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) : Math.max(8, Math.min(r.left, innerWidth - w - 8))
			style.value = { left: left + 'px', minWidth: w + 'px', ...(up ? { bottom: innerHeight - r.top + 6 + 'px', maxHeight: Math.min(maxH, above - 16) + 'px' } : { top: r.bottom + 6 + 'px', maxHeight: Math.min(maxH, below - 16) + 'px' }) }
		}
		function outside(e) { if (pop.value && !pop.value.contains(e.target) && !(getAnchor() && getAnchor().contains(e.target))) close() }
		function key(e) { if (e.key === 'Escape' && open.value) { e.stopPropagation(); close() } }
		let tracked = false
		const track = (on) => { if (on !== tracked) { tracked = on; CM.overlays.pops += on ? 1 : -1 } }
		function openIt() { if (open.value) return; track(true); place(); open.value = true; document.addEventListener('mousedown', outside, true); window.addEventListener('keydown', key, true); window.addEventListener('resize', place); window.addEventListener('scroll', place, true) }
		function close(silent) { const was = open.value; track(false); open.value = false; document.removeEventListener('mousedown', outside, true); window.removeEventListener('keydown', key, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); if (was && onClose && silent !== true) onClose() }
		onBeforeUnmount(() => close(true))
		return { open, style, pop, openIt, close, toggle: () => (open.value ? close() : openIt()), place }
	}

	CM.usePop = usePop

	C.Dd = {
		props: { modelValue: [String, Number, Boolean, Object], options: { type: Array, default: () => [] }, placeholder: { type: String, default: 'Select' }, searchable: Boolean, size: String, disabled: Boolean, prefix: String, bad: Boolean, width: Number, ariaLabel: String, allowEmpty: String },
		emits: ['update:modelValue', 'change'],
		setup(props, { emit }) {
			const trig = ref(null); const q = ref(''); const hi = ref(-1)
			const p = usePop(() => trig.value, { width: props.width || 0 })
			const norm = computed(() => props.options.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) })))
			const shown = computed(() => {
				const term = q.value.trim().toLowerCase()
				const list = term ? norm.value.filter((o) => (o.label + ' ' + (o.sub || '') + ' ' + o.value).toLowerCase().includes(term)) : norm.value
				return props.allowEmpty && !term ? [{ value: '', label: props.allowEmpty }, ...list] : list
			})
			const current = computed(() => norm.value.find((o) => o.value === props.modelValue))
			function toggle() { if (props.disabled) return; if (!p.open.value) { q.value = ''; hi.value = Math.max(0, shown.value.findIndex((o) => o.value === props.modelValue)) } p.toggle(); if (p.open.value && props.searchable) nextTick(() => p.pop.value && p.pop.value.querySelector('input') && p.pop.value.querySelector('input').focus()) }
			function pick(o) { if (o.disabled) return; emit('update:modelValue', o.value); emit('change', o.value); p.close(); if (trig.value) trig.value.focus() }
			function onKey(e) {
				if (!p.open.value) { if (['ArrowDown', 'Enter', ' '].includes(e.key)) { e.preventDefault(); toggle() } return }
				if (e.key === 'ArrowDown') { e.preventDefault(); hi.value = Math.min(shown.value.length - 1, hi.value + 1) }
				else if (e.key === 'ArrowUp') { e.preventDefault(); hi.value = Math.max(0, hi.value - 1) }
				else if (e.key === 'Enter') { e.preventDefault(); if (shown.value[hi.value]) pick(shown.value[hi.value]) }
			}
			watch(q, () => { hi.value = 0 })
			return { ...p, trig, q, hi, shown, current, toggle, pick, onKey } // ours last: p has a toggle of its own, and ours also clears the search and focuses it
		},
		template: `
		<div class="dd">
			<button ref="trig" type="button" class="dd-btn" :class="[size, { open, bad }]" :disabled="disabled" :aria-label="ariaLabel || placeholder" aria-haspopup="listbox" :aria-expanded="open" @click="toggle" @keydown="onKey">
				<span v-if="prefix" class="pre">{{ prefix }}</span>
				<Ico v-if="current && current.icon" :name="current.icon" />
				<span class="lab" :class="{ ph: !current }">{{ current ? current.label : placeholder }}</span>
				<Ico name="chevron-down" size="sm" class="chev" />
			</button>
			<Teleport to="body">
				<div v-if="open" ref="pop" class="pop" :style="style" role="listbox" @keydown="onKey">
					<div v-if="searchable" class="pop-search"><input class="inp" style="height:32px" v-model="q" placeholder="Search" aria-label="Search options" @keydown="onKey" /></div>
					<div class="pop-list">
						<template v-for="(o, i) in shown" :key="String(o.value) + i">
							<div v-if="o.group" class="pop-head">{{ o.group }}</div>
							<button type="button" class="opt" :class="{ on: o.value === modelValue, hi: i === hi, dis: o.disabled }" role="option" :aria-selected="o.value === modelValue" @mouseenter="hi = i" @click="pick(o)">
								<Ico v-if="o.icon" :name="o.icon" />
								<span class="grow"><span class="ellipsis" style="display:block">{{ o.label }}</span><span v-if="o.sub" class="sub">{{ o.sub }}</span></span>
								<span v-if="o.badge" class="badge neutral nodot">{{ o.badge }}</span>
								<Ico v-if="o.value === modelValue && o.value !== ''" name="check" size="sm" class="tick" />
							</button>
						</template>
						<div v-if="!shown.length" class="pop-empty">Nothing found</div>
					</div>
				</div>
			</Teleport>
		</div>`,
	}

	C.Menu = {
		props: { items: Array, align: { type: String, default: 'right' }, label: { type: String, default: 'More actions' } },
		setup(props) {
			const trig = ref(null)
			const p = usePop(() => trig.value, { width: 190, align: props.align })
			return { trig, ...p }
		},
		template: `
		<span class="menu-wrap" style="display:inline-flex" @click.stop>
			<span ref="trig" style="display:inline-flex" @click="toggle"><slot><button type="button" class="btn ghost icon sm" :aria-label="label" aria-haspopup="menu"><Ico name="more" /></button></slot></span>
			<Teleport to="body">
				<div v-if="open" ref="pop" class="pop" :style="style" role="menu">
					<div class="pop-list">
						<template v-for="(it, i) in items.filter(Boolean)" :key="i">
							<div v-if="it.sep" class="opt-sep"></div>
							<button v-else type="button" class="opt" :class="{ danger: it.danger, dis: it.disabled }" role="menuitem" @click="!it.disabled && (close(), it.run && it.run())"><Ico v-if="it.icon" :name="it.icon" /><span class="grow">{{ it.label }}</span></button>
						</template>
					</div>
				</div>
			</Teleport>
		</span>`,
	}

	// ------------------------------------------------------------------ modal / drawer / confirm / toasts
	const stack = []
	function useDialog(emit, props) {
		const id = Symbol(); let gone = false
		function key(e) { if (e.key === 'Escape' && stack[stack.length - 1] === id && !props.persistent) { e.stopPropagation(); emit('close') } }
		function release() {
			const i = stack.indexOf(id); if (i >= 0) stack.splice(i, 1)
			CM.overlays.dialogs = stack.length
			window.removeEventListener('keydown', key)
			if (!stack.length) document.body.style.overflow = '' // the scroll lock is only ever on while a dialog is open
		}
		onMounted(() => {
			if (gone) return // removed again before it was ever shown (same tick): take nothing
			stack.push(id); CM.overlays.dialogs = stack.length; window.addEventListener('keydown', key); document.body.style.overflow = 'hidden'
		})
		onBeforeUnmount(() => { gone = true; release() })
	}
	C.Modal = {
		props: { title: String, subtitle: String, size: String, persistent: Boolean, top: Boolean },
		emits: ['close', 'submit'],
		setup(props, { emit }) {
			useDialog(emit, props)
			const el = ref(null)
			onMounted(() => nextTick(() => { const f = el.value && el.value.querySelector('[autofocus], .modal-b input:not([type=checkbox]), .modal-b textarea'); if (f) f.focus() }))
			function onEnter(e) { if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && !e.target.closest('.pop')) { e.preventDefault(); emit('submit') } }
			return { el, onEnter }
		},
		template: `
		<Teleport to="body">
			<div class="overlay" :class="{ top }" @mousedown.self="!persistent && $emit('close')">
				<div ref="el" class="modal" :class="size" role="dialog" aria-modal="true" :aria-label="title" @keydown.enter="onEnter">
					<div v-if="title || $slots.head" class="modal-h"><div class="grow"><slot name="head"><h2>{{ title }}</h2><p v-if="subtitle">{{ subtitle }}</p></slot></div><button type="button" class="btn ghost icon sm" aria-label="Close" @click="$emit('close')"><Ico name="x" /></button></div>
					<div class="modal-b"><slot /></div>
					<div v-if="$slots.foot" class="modal-f"><slot name="foot" /></div>
				</div>
			</div>
		</Teleport>`,
	}
	C.Drawer = {
		props: { title: String, subtitle: String, wide: Boolean },
		emits: ['close'],
		setup(props, { emit }) { useDialog(emit, props) },
		template: `
		<Teleport to="body">
			<div class="overlay drawer-o" @mousedown.self="$emit('close')">
				<aside class="drawer" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
					<div class="modal-h" style="padding-bottom:12px;border-bottom:1px solid var(--border)"><div class="grow"><slot name="head"><h2>{{ title }}</h2><p v-if="subtitle">{{ subtitle }}</p></slot></div><button type="button" class="btn ghost icon sm" aria-label="Close" @click="$emit('close')"><Ico name="x" /></button></div>
					<div class="modal-b" style="flex:1"><slot /></div>
					<div v-if="$slots.foot" class="modal-f"><slot name="foot" /></div>
				</aside>
			</div>
		</Teleport>`,
	}
	C.ConfirmHost = {
		setup() {
			const s = CM.confirmState
			const done = (v) => { const r = s.resolve; s.resolve = null; s.open = false; if (r) r(v) }
			return { s, done }
		},
		template: `
		<Modal v-if="s.open" size="sm" :title="s.title" top @close="done(false)" @submit="done(true)">
			<p style="margin:0;color:var(--text-soft)">{{ s.message }}</p>
			<div v-if="s.detail" class="alert warn"><Ico name="alert" /><div class="grow">{{ s.detail }}</div></div>
			<template #foot><Btn @click="done(false)">Cancel</Btn><Btn :variant="s.danger ? 'danger solid' : 'primary'" autofocus @click="done(true)">{{ s.confirmText }}</Btn></template>
		</Modal>`,
	}
	C.Toasts = {
		setup() { return { toasts: CM.toasts } },
		template: `<div class="toasts" role="status" aria-live="polite"><div v-for="t in toasts" :key="t.id" class="toast" :class="t.type"><Ico :name="t.type === 'err' ? 'alert' : t.type === 'warn' ? 'info' : 'check-circle'" />{{ t.message }}</div></div>`,
	}

	// ------------------------------------------------------------------ tabs / badges / states
	C.Tabs = {
		props: { modelValue: String, items: Array },
		emits: ['update:modelValue'],
		template: `<div class="tabs" role="tablist"><button v-for="t in items" :key="t.key" type="button" class="tab" :class="{ on: t.key === modelValue }" role="tab" :aria-selected="t.key === modelValue" @click="$emit('update:modelValue', t.key)"><Ico v-if="t.icon" :name="t.icon" />{{ t.label }}<span v-if="t.count != null" class="n">{{ t.count }}</span></button></div>`,
	}
	C.StatusBadge = {
		props: { value: String },
		computed: { tone() { return CM.STATUS_TONE[this.value] || 'neutral' }, live() { return ['Running', 'Queued', 'Sending'].includes(this.value) } },
		template: `<span class="badge" :class="[tone, { pulse: live }]">{{ value }}</span>`,
	}
	C.ChannelBadge = {
		props: { value: String, short: Boolean },
		computed: { icon() { return this.value === 'Email' ? 'mail' : this.value === 'WhatsApp' ? 'whatsapp' : 'layers' }, cls() { return this.value === 'Multi-channel' ? 'Multi' : this.value } },
		template: `<span class="ch" :class="cls"><Ico :name="icon" size="sm" />{{ value }}</span>`,
	}
	C.ChannelBadges = {
		props: { channels: Array, multi: { type: Boolean, default: true } },
		template: `<span class="row" style="gap:5px;flex-wrap:wrap"><ChannelBadge v-if="multi && channels && channels.length > 1" value="Multi-channel" :title="channels.join(' + ')" /><template v-else><ChannelBadge v-for="c in channels" :key="c" :value="c" /></template><span v-if="!channels || !channels.length" class="faint small">No channel yet</span></span>`,
	}
	C.Empty = {
		props: { icon: String, title: String, text: String },
		template: `<div class="empty"><div class="art"><Ico :name="icon || 'inbox'" size="xl" /></div><h3>{{ title }}</h3><p>{{ text }}</p><div class="row wrap" style="justify-content:center"><slot /></div></div>`,
	}
	C.ErrorState = {
		props: { message: String, retry: Boolean },
		emits: ['retry'],
		template: `<div class="empty"><div class="art" style="background:var(--red-soft);color:var(--red)"><Ico name="alert" size="xl" /></div><h3>This did not load</h3><p>{{ message || 'Something went wrong. Please try again.' }}</p><Btn v-if="retry !== false" icon="refresh" @click="$emit('retry')">Try again</Btn></div>`,
	}
	C.Skel = {
		props: { w: [String, Number], h: { type: [String, Number], default: 16 }, r: [String, Number] },
		template: `<div class="skel" :style="{ width: typeof w === 'number' ? w + 'px' : w || '100%', height: typeof h === 'number' ? h + 'px' : h, borderRadius: r ? r + 'px' : '' }"></div>`,
	}
	C.Pager = {
		props: { page: Number, size: Number, total: Number },
		emits: ['update:page'],
		template: `<div v-if="total > size" class="pager"><span class="small muted">{{ page * size + 1 }}-{{ Math.min(total, (page + 1) * size) }} of {{ total.toLocaleString() }}</span><Btn size="sm" icon="chevron-left" :disabled="page === 0" aria-label="Previous page" @click="$emit('update:page', page - 1)" /><Btn size="sm" icon="chevron-right" :disabled="(page + 1) * size >= total" aria-label="Next page" @click="$emit('update:page', page + 1)" /></div>`,
	}
	C.Avatar = {
		props: { name: String, size: { type: Number, default: 28 } },
		computed: { bg() { let h = 0; for (const c of String(this.name)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 45%)` } },
		template: `<span :style="{ width: size + 'px', height: size + 'px', background: bg, fontSize: size * 0.4 + 'px' }" style="display:inline-grid;place-items:center;border-radius:50%;color:#fff;font-weight:650;flex:none">{{ CMi(name) }}</span>`,
		setup() { return { CMi: CM.initials } },
	}
	C.Stepper = {
		props: { steps: Array, current: Number, reached: Number },
		emits: ['go'],
		template: `
		<nav class="stepper" aria-label="Progress">
			<template v-for="(s, i) in steps" :key="s.key">
				<div v-if="i" class="stp-line" :class="{ done: i <= current }"></div>
				<button type="button" class="stp" :class="{ on: i === current, done: i < current }" :disabled="i > reached" :aria-current="i === current ? 'step' : null" @click="$emit('go', i)">
					<span class="dot"><Ico v-if="i < current" name="check" size="sm" /><template v-else>{{ i + 1 }}</template></span>
					<span class="t">{{ s.title }}<span class="d">{{ s.desc }}</span></span>
				</button>
			</template>
		</nav>`,
	}

	// ------------------------------------------------------------------ uploader
	C.Uploader = {
		props: { modelValue: { type: Array, default: () => [] }, isPrivate: { type: Boolean, default: true }, accept: String, maxMb: { type: Number, default: 10 }, totalMb: Number, multiple: { type: Boolean, default: true }, title: String, hint: String },
		emits: ['update:modelValue'],
		setup(props, { emit }) {
			const jobs = reactive([]); const over = ref(false); const input = ref(null)
			const used = computed(() => props.modelValue.reduce((a, f) => a + (f.file_size || 0), 0))
			async function add(fileList) {
				const files = [...fileList]
				if (!props.multiple) files.splice(1)
				for (const file of files) {
					const job = reactive({ id: CM.uid(), name: file.name, size: file.size, progress: 0, error: '' })
					jobs.push(job)
					if (file.size > props.maxMb * 1048576) { job.error = `Too large: ${CM.size(file.size)} (limit ${props.maxMb} MB)`; continue }
					if (props.totalMb && props.multiple && used.value + file.size > props.totalMb * 1048576) { job.error = `Attachments may total ${props.totalMb} MB per email`; continue }
					try {
						const res = await CM.upload(file, { isPrivate: props.isPrivate, onProgress: (p) => (job.progress = p) })
						jobs.splice(jobs.indexOf(job), 1)
						emit('update:modelValue', props.multiple ? [...props.modelValue.filter((f) => f.file_url !== res.file_url), res] : [res])
					} catch (e) { job.error = e.message }
				}
			}
			const remove = (f) => emit('update:modelValue', props.modelValue.filter((x) => x.file_url !== f.file_url))
			async function onPick(e) { const el = e.target; try { await add(el.files) } finally { el.value = '' } }
			const dismiss = (j) => jobs.splice(jobs.indexOf(j), 1)
			const ext = (n) => (String(n).split('.').pop() || '').slice(0, 4)
			function drop(e) { over.value = false; if (e.dataTransfer && e.dataTransfer.files.length) add(e.dataTransfer.files) }
			return { jobs, over, input, add, onPick, remove, dismiss, ext, drop, size: CM.size, used }
		},
		template: `
		<div>
			<div class="drop" :class="{ over }" tabindex="0" role="button" aria-label="Upload files" @click="input.click()" @keydown.enter.prevent="input.click()" @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="drop">
				<div class="art"><Ico name="upload" size="lg" /></div>
				<div class="grow"><b>{{ title || (multiple ? 'Drop files here or browse' : 'Drop a file here or browse') }}</b><span>{{ hint || ('Up to ' + maxMb + ' MB per file') }}<template v-if="totalMb && multiple"> - {{ size(used) }} of {{ totalMb }} MB used</template></span></div>
				<Btn size="sm" tabindex="-1">Browse</Btn>
				<input ref="input" type="file" :accept="accept" :multiple="multiple" hidden @change="onPick($event)" />
			</div>
			<div v-if="modelValue.length || jobs.length" class="files">
				<div v-for="f in modelValue" :key="f.file_url" class="file"><div class="fi">{{ ext(f.file_name) }}</div><div class="meta"><b class="ellipsis">{{ f.file_name }}</b><span class="small muted">{{ size(f.file_size || 0) }}</span></div><Btn size="sm" variant="ghost" icon="trash" :aria-label="'Remove ' + f.file_name" @click="remove(f)" /></div>
				<div v-for="j in jobs" :key="j.id" class="file" :class="{ err: j.error }">
					<div class="fi"><Ico :name="j.error ? 'alert' : 'upload'" /></div>
					<div class="meta"><b class="ellipsis">{{ j.name }}</b><span v-if="j.error" class="small" style="color:var(--red)">{{ j.error }}</span><div v-else class="bar" style="margin-top:6px"><i :style="{ width: j.progress + '%' }"></i></div></div>
					<span v-if="!j.error" class="small muted">{{ j.progress }}%</span><Btn v-else size="sm" variant="ghost" icon="x" aria-label="Dismiss" @click="dismiss(j)" />
				</div>
			</div>
		</div>`,
	}

	// ------------------------------------------------------------------ insert variable
	C.VarMenu = {
		props: { size: String, label: { type: String, default: 'Insert variable' }, only: String },
		emits: ['pick'],
		setup(props, { emit }) {
			const trig = ref(null); const q = ref('')
			const p = usePop(() => trig.value, { width: 300, maxH: 380 })
			const vars = computed(() => {
				const all = (CM.shared.fields && CM.shared.fields.variables) || []
				const term = q.value.trim().toLowerCase()
				const list = all.filter((v) => !term || (v.name + ' ' + v.label).toLowerCase().includes(term))
				const pri = ['first_name', 'last_name', 'lead_name', 'email', 'mobile_no', 'organization']
				return {
					common: list.filter((v) => pri.includes(v.name)).sort((a, b) => pri.indexOf(a.name) - pri.indexOf(b.name)),
					computed: list.filter((v) => v.kind === 'computed'),
					other: list.filter((v) => v.kind === 'field' && !pri.includes(v.name)),
				}
			})
			function toggleMenu() { q.value = ''; p.toggle(); if (p.open.value) nextTick(() => p.pop.value && p.pop.value.querySelector('input') && p.pop.value.querySelector('input').focus()) }
			function pick(v) { emit('pick', '{{ ' + v.name + ' }}', v); p.close() }
			return { trig, q, vars, toggleMenu, pick, ...p }
		},
		template: `
		<span style="display:inline-flex">
			<button ref="trig" type="button" class="btn" :class="size || 'sm'" @mousedown.prevent @click="toggleMenu"><Ico name="variable" />{{ label }}</button>
			<Teleport to="body">
				<div v-if="open" ref="pop" class="pop" :style="style" @mousedown.prevent.self>
					<div class="pop-search"><input class="inp" style="height:32px" v-model="q" placeholder="Search variables" aria-label="Search variables" /></div>
					<div class="pop-list">
						<template v-for="g in [['Common', vars.common], ['Sender and dates', vars.computed], ['All lead fields', vars.other]]" :key="g[0]">
							<template v-if="g[1].length"><div class="pop-head">{{ g[0] }}</div>
							<button v-for="v in g[1]" :key="v.name" type="button" class="opt" @mousedown.prevent @click="pick(v)"><span class="grow"><span class="ellipsis" style="display:block">{{ v.label }}</span></span><span class="mono tiny faint">{{ $tok(v.name) }}</span></button></template>
						</template>
						<div v-if="!vars.common.length && !vars.computed.length && !vars.other.length" class="pop-empty">No variable found</div>
					</div>
				</div>
			</Teleport>
		</span>`,
	}

	// ------------------------------------------------------------------ email previews
	// Plain content (no layout table of its own) gets a margin so text never touches the edge of the frame; designed emails
	// (built with tables, with their own background and spacing) are left full-bleed as the sender made them.
	const emailDoc = (html) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><style>html,body{margin:0;padding:0}body{box-sizing:border-box;${/<table[\s>]/i.test(html || '') ? '' : 'padding:22px 26px;'}overflow-wrap:anywhere;background:#fff;color:#222;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;-webkit-text-size-adjust:100%}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${html || ''}</body></html>`
	CM.emailDoc = emailDoc
	C.EmailFrame = {
		props: { subject: String, html: String, fromName: String, fromEmail: String, toName: String, device: { type: String, default: 'desktop' }, loading: Boolean, minH: { type: Number, default: 360 } },
		setup(props) {
			const frame = ref(null); const h = ref(props.minH)
			function measure() { try { const d = frame.value.contentDocument; if (d && d.body) h.value = Math.max(props.minH, d.documentElement.scrollHeight + 4) } catch (e) { /* sandbox */ } }
			// images that arrive after the page changes its height: measure again (capture phase: image load does not bubble)
			function loaded() { measure(); try { frame.value.contentDocument.addEventListener('load', () => setTimeout(measure, 30), true) } catch (e) { /* sandbox */ } }
			watch(() => [props.html, props.device], () => nextTick(() => setTimeout(measure, 60)))
			return { frame, h, measure, loaded, doc: computed(() => emailDoc(props.html)), initial: CM.initials }
		},
		template: `
		<div class="dev" :class="device">
			<div v-if="device === 'mobile'" class="ph" aria-label="Phone preview">
				<span class="ph-btn a"></span><span class="ph-btn b"></span><span class="ph-btn c"></span>
				<div class="ph-bezel"><div class="ph-screen">
					<div class="ph-status"><b>9:41</b><span class="ph-notch" aria-hidden="true"></span><span class="ph-sig" aria-hidden="true"><i></i><i></i><i></i><i></i><em></em></span></div>
					<div class="ph-app"><Ico name="chevron-left" size="sm" /><span>Inbox</span></div>
					<div class="mc-head"><div class="mc-subject">{{ subject || '(no subject)' }}</div><div class="row" style="gap:8px"><Avatar :name="fromName || 'You'" :size="30" /><div class="grow" style="min-width:0"><div class="ellipsis"><b>{{ fromName || 'Your name' }}</b></div><div class="small faint ellipsis">to {{ toName || 'Asha Sharma' }}</div></div><span class="tiny faint">Now</span></div></div>
					<div class="mc-body"><div v-if="loading" class="mc-load"><span class="spin"></span></div><iframe ref="frame" title="Email preview" sandbox="allow-same-origin" :srcdoc="doc" :style="{ height: h + 'px' }" @load="loaded"></iframe></div>
				</div><span class="ph-home" aria-hidden="true"></span></div>
			</div>
			<div v-else class="win">
				<div class="win-bar" aria-hidden="true"><i></i><i></i><i></i><span class="win-url">Inbox</span></div>
				<div class="mc">
					<div class="mc-head">
						<div class="mc-subject">{{ subject || '(no subject)' }}</div>
						<div class="row" style="gap:10px"><Avatar :name="fromName || 'You'" :size="34" /><div class="grow"><div class="ellipsis"><b>{{ fromName || 'Your name' }}</b> <span class="faint small">&lt;{{ fromEmail || 'you@company.com' }}&gt;</span></div><div class="small faint ellipsis">to {{ toName || 'Asha Sharma' }}</div></div><span class="small faint">Now</span></div>
					</div>
					<div class="mc-body"><div v-if="loading" class="mc-load"><span class="spin"></span></div><iframe ref="frame" title="Email preview" sandbox="allow-same-origin" :srcdoc="doc" :style="{ height: h + 'px' }" @load="loaded"></iframe></div>
				</div>
			</div>
		</div>`,
	}
	C.EmailPreview = {
		props: { subject: String, html: String, fromName: String, fromEmail: String, toName: String, loading: Boolean, note: String },
		setup() { const device = ref('desktop'); const full = ref(false); return { device, full } },
		template: `
		<div class="pv">
			<div class="pv-bar"><Seg v-model="device" :options="[{ value: 'desktop', label: 'Desktop', icon: 'monitor' }, { value: 'mobile', label: 'Mobile', icon: 'phone' }]" /><span class="grow small faint ellipsis">{{ note }}</span><Btn size="sm" icon="maximize" @click="full = true">Full screen</Btn></div>
			<div class="pv-stage"><EmailFrame v-bind="$props" :device="device" /></div>
			<Modal v-if="full" size="full" :title="subject || 'Email preview'" top @close="full = false">
				<template #head><div class="row grow"><h2 class="grow ellipsis" style="margin:0;font-size:17px">{{ subject || 'Email preview' }}</h2><Seg v-model="device" :options="[{ value: 'desktop', label: 'Desktop', icon: 'monitor' }, { value: 'mobile', label: 'Mobile', icon: 'phone' }]" /></div></template>
				<div class="pv-stage" style="background:transparent"><EmailFrame v-bind="$props" :device="device" :min-h="520" /></div>
			</Modal>
		</div>`,
	}
	// Template thumbnails are scaled-down iframes, which are expensive. Only the ones on screen are created, and at most one
	// is started every 60 ms, so opening a library of 100 templates never blocks the page.
	const thumbQueue = []; let thumbBusy = false
	function thumbNext() {
		if (thumbBusy) return; thumbBusy = true
		const run = () => { const job = thumbQueue.shift(); if (job) job(); if (thumbQueue.length) setTimeout(run, 60); else thumbBusy = false }
		setTimeout(run, 0)
	}
	const thumbIO = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting && e.target.__thumbShow) { const f = e.target.__thumbShow; e.target.__thumbShow = null; thumbIO.unobserve(e.target); thumbQueue.push(f); thumbNext() } }), { rootMargin: '200px' }) : null
	C.Thumb = {
		props: { html: String, height: { type: Number, default: 190 } },
		setup(props) {
			const box = ref(null); const scale = ref(0.4); const live = ref(false)
			let ro
			onMounted(() => {
				const fit = () => { if (box.value) scale.value = box.value.clientWidth / 640 }; fit(); ro = new ResizeObserver(fit); ro.observe(box.value)
				const show = () => { live.value = true }
				if (thumbIO) { box.value.__thumbShow = show; thumbIO.observe(box.value) } else show()
			})
			onBeforeUnmount(() => { ro && ro.disconnect(); if (box.value) { box.value.__thumbShow = null; thumbIO && thumbIO.unobserve(box.value) } })
			return { box, scale, live, doc: computed(() => emailDoc(props.html)) }
		},
		template: `<div ref="box" class="thumb" :style="{ height: height + 'px' }"><iframe v-if="live" tabindex="-1" aria-hidden="true" sandbox="" :srcdoc="doc" :style="{ transform: 'scale(' + scale + ')', height: height / scale + 'px' }"></iframe></div>`,
	}

	// ------------------------------------------------------------------ WhatsApp bubble
	function waFormat(text) {
		let s = CM.escape(text)
		s = s.replace(/```([\s\S]+?)```/g, '<code>$1</code>').replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/_([^_\n]+)_/g, '<i>$1</i>').replace(/~([^~\n]+)~/g, '<s>$1</s>')
		return s
	}
	/** Fill {{1}} {{2}} in a Meta template body with values (array or {n: value}); unfilled ones are shown as chips. */
	CM.waFill = (body, values) => {
		const get = (n) => (Array.isArray(values) ? values[n - 1] : values && values[n])
		const slots = []
		const marked = String(body || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) => { slots.push(Number(n)); return '\u0001' + (slots.length - 1) + '\u0002' })
		return waFormat(marked).replace(/\u0001(\d+)\u0002/g, (_m, i) => {
			const n = slots[Number(i)]; const v = get(n)
			return v ? `<mark class="wa-val">${CM.escape(v)}</mark>` : `<mark class="wa-var">{{${n}}}</mark>`
		})
	}
	C.WaBubble = {
		props: { header: String, headerType: String, body: String, footer: String, buttons: { type: Array, default: () => [] }, values: [Array, Object], mediaUrl: String, time: { type: String, default: '10:42' }, sender: String, compact: Boolean },
		computed: {
			bodyHtml() { return CM.waFill(this.body, this.values) },
			headerHtml() { return this.header ? CM.waFill(this.header, this.values) : '' },
			type() { return String(this.headerType || '').toUpperCase() },
		},
		methods: { bicon(t) { return t === 'Visit Website' ? 'external' : t === 'Call Phone' ? 'phone' : 'send' } },
		template: `
		<div class="wa-phone" :class="{ compact }">
			<div v-if="!compact" class="wa-top"><Ico name="arrow-left" /><span class="wa-av">{{ sender ? sender[0] : 'B' }}</span><div class="grow"><b>{{ sender || 'Your business' }}</b><span>Business account</span></div></div>
			<div class="wa-chat">
				<div class="wa-day">TODAY</div>
				<div class="wa-bubble">
					<div v-if="type === 'IMAGE' || type === 'VIDEO'" class="wa-media"><img v-if="mediaUrl && type === 'IMAGE'" :src="mediaUrl" alt="" /><template v-else><Ico :name="type === 'VIDEO' ? 'play' : 'image'" size="xl" /><span>{{ type === 'VIDEO' ? 'Video header' : 'Image header' }}</span></template></div>
					<div v-else-if="type === 'DOCUMENT'" class="wa-doc"><Ico name="file" size="lg" /><div class="grow"><b>Document.pdf</b><span>PDF - header document</span></div></div>
					<div v-if="headerHtml && (type === 'TEXT' || !type)" class="wa-head" v-html="headerHtml"></div>
					<div class="wa-body" v-html="bodyHtml"></div>
					<div v-if="footer" class="wa-foot">{{ footer }}</div>
					<div class="wa-time">{{ time }} <svg viewBox="0 0 18 12" width="15" height="10" fill="none" stroke="#53bdeb" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m1 6 3.5 3.5L11 2"/><path d="m7 9.5 1 .5L15 2"/></svg></div>
				</div>
				<div v-for="(b, i) in buttons" :key="i" class="wa-btn"><Ico :name="bicon(b.button_type)" size="sm" />{{ b.button_label }}</div>
			</div>
		</div>`,
	}

	// ------------------------------------------------------------------ charts (SVG)
	C.DayChart = {
		props: { days: Array, series: Array, height: { type: Number, default: 220 } },
		setup(props) {
			const W = 720, padL = 38, padB = 26, padT = 10
			const geo = computed(() => {
				const days = props.days || []; const H = props.height
				const max = Math.max(1, ...days.map((d) => Math.max(...props.series.map((s) => d[s.key] || 0))))
				const nice = (() => { const raw = max / 4; const p = Math.pow(10, Math.floor(Math.log10(raw))); const m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p * 4 })()
				const innerW = W - padL - 8, innerH = H - padB - padT
				const slot = innerW / Math.max(1, days.length)
				const bw = Math.min(26, (slot * 0.78) / props.series.length)
				const bars = []
				days.forEach((d, i) => props.series.forEach((s, j) => {
					const v = d[s.key] || 0, hh = (v / nice) * innerH
					bars.push({ k: i + s.key, x: padL + slot * i + (slot - bw * props.series.length) / 2 + bw * j, y: padT + innerH - hh, w: bw - 1, h: Math.max(v ? 2 : 0, hh), color: s.color, tip: `${d.date}: ${s.label} ${v}` })
				}))
				const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ y: padT + innerH - t * innerH, label: Math.round(nice * t).toLocaleString() }))
				const every = Math.ceil(days.length / 8)
				const labels = days.map((d, i) => ({ x: padL + slot * i + slot / 2, label: CM.fmtShort(d.date), show: i % every === 0 }))
				return { bars, ticks, labels, H }
			})
			return { geo, W, padL }
		},
		template: `
		<svg class="chart" :viewBox="'0 0 ' + W + ' ' + geo.H" role="img" aria-label="Messages per day">
			<g class="gridlines"><line v-for="t in geo.ticks" :key="t.y" :x1="padL" :x2="W - 8" :y1="t.y" :y2="t.y" /></g>
			<text v-for="t in geo.ticks" :key="'t' + t.y" :x="padL - 6" :y="t.y + 4" text-anchor="end">{{ t.label }}</text>
			<rect v-for="b in geo.bars" :key="b.k" :x="b.x" :y="b.y" :width="b.w" :height="b.h" :fill="b.color" rx="2"><title>{{ b.tip }}</title></rect>
			<template v-for="l in geo.labels" :key="l.x"><text v-if="l.show" :x="l.x" :y="geo.H - 8" text-anchor="middle">{{ l.label }}</text></template>
		</svg>`,
	}
	C.Donut = {
		props: { parts: Array, size: { type: Number, default: 150 }, center: [String, Number], sub: String },
		computed: {
			arcs() {
				const total = this.parts.reduce((a, p) => a + p.value, 0) || 1; const r = 54, c = 2 * Math.PI * r; let off = 0
				return this.parts.filter((p) => p.value > 0).map((p) => { const len = (p.value / total) * c; const a = { ...p, dash: `${len} ${c - len}`, off: -off }; off += len; return a })
			},
		},
		template: `<svg :width="size" :height="size" viewBox="0 0 140 140" role="img"><circle cx="70" cy="70" r="54" fill="none" stroke="var(--input)" stroke-width="16" /><circle v-for="a in arcs" :key="a.label" cx="70" cy="70" r="54" fill="none" :stroke="a.color" stroke-width="16" :stroke-dasharray="a.dash" :stroke-dashoffset="a.off" transform="rotate(-90 70 70)"><title>{{ a.label }}: {{ a.value }}</title></circle><text x="70" y="70" text-anchor="middle" style="font-size:24px;font-weight:700;fill:var(--text)">{{ center }}</text><text x="70" y="88" text-anchor="middle" style="font-size:10.5px;fill:var(--text-faint)">{{ sub }}</text></svg>`,
	}
	C.Funnel = {
		props: { steps: Array },
		computed: { top() { return Math.max(1, ...this.steps.map((s) => s.value)) } },
		methods: { pct: CM.pctText, num: CM.num },
		template: `<div class="funnel"><div v-for="(s, i) in steps" :key="s.label" class="fn"><div class="fn-h"><span>{{ s.label }}</span><span><b>{{ num(s.value) }}</b> <span class="faint small" v-if="i">{{ pct(s.value, steps[i - 1].value) }} of previous</span></span></div><div class="bar tall"><i :style="{ width: Math.max(s.value ? 1.5 : 0, (s.value / top) * 100) + '%', background: s.color || 'var(--accent)' }"></i></div></div></div>`,
	}
	C.HBars = {
		props: { rows: Array, color: { type: String, default: 'var(--accent)' } },
		computed: { top() { return Math.max(1, ...this.rows.map((r) => r.value)) } },
		template: `<div class="hbars"><div v-for="r in rows" :key="r.label" class="hb"><span class="hb-l ellipsis" :title="r.label">{{ r.label }}</span><div class="bar tall"><i :style="{ width: (r.value / top) * 100 + '%', background: r.color || color }"></i></div><b>{{ r.value.toLocaleString() }}</b></div></div>`,
	}
	C.MiniBar = {
		props: { parts: Array },
		template: `<div class="minibar"><i v-for="p in parts" :key="p.label" :style="{ flex: p.value, background: p.color }" :title="p.label + ': ' + p.value"></i></div>`,
	}
})()
