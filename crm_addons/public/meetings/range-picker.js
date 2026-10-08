/* CRM Pro Pack - the shared date-range picker (Vue 3, no build step).
 * Loaded by dashboard.html and followups.html before their own script, it registers
 * window.CRMRangePicker.create(options) which returns the component both pages use.
 *
 *   create({
 *     Ico,                       the icon component of the page
 *     presets: [[key, label]],   the preset list, in order
 *     presetRange(key),          -> [Date, Date] (inclusive days) or null for "any time"
 *     rangeOf(model),            -> [Date, Date] or null; model is { preset, from, to }
 *     fmtRange(a, b),            label text for a range
 *     anyLabel,                  label when rangeOf() is null (e.g. "Due: any time")
 *     duePrefix,                 label prefix for a custom range (e.g. "Due: ")
 *     compare,                   true when the page compares with the previous period (adds the tooltip note)
 *   })
 *
 * One range means one thing everywhere: the days from the first to the last, both included, in the
 * browser's calendar. Keyboard: Enter / Space / ArrowDown on the button opens it; Up / Down walk the
 * presets; in the calendar the arrow keys move by a day / a week, PageUp / PageDown by a month,
 * Home / End to the start / end of the week; Esc closes it (and only it) and returns the focus.
 */
(function () {
	var pad = function (n) { return String(n).padStart(2, '0') }
	var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
	var parseDay = function (s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]) }
	var addDays = function (d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n) }
	var DAY = 86400000
	var days = function (a, b) { return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY) + 1 }

	/** The period of the same length that ends the day before ``a`` (what "previous period" means everywhere). */
	function previousPeriod(a, b) {
		var n = days(a, b)
		return [addDays(a, -n), addDays(a, -1), n]
	}

	function create(o) {
		var V = window.Vue
		var ref = V.ref, reactive = V.reactive, computed = V.computed, onMounted = V.onMounted, onBeforeUnmount = V.onBeforeUnmount, nextTick = V.nextTick
		var PRESETS = o.presets
		var fmtRange = o.fmtRange

		return {
			components: { Ico: o.Ico },
			props: { modelValue: Object },
			emits: ['update:modelValue'],
			setup: function (props, ctx) {
				var emit = ctx.emit
				var open = ref(false)
				var btn = ref(null)
				var pop = ref(null)
				var style = ref({})
				var cursor = ref(new Date())
				var focusDay = ref('')
				var draft = reactive({ from: '', to: '' })
				var hover = ref('')

				var current = computed(function () { return o.rangeOf(props.modelValue) })
				var label = computed(function () {
					var preset = PRESETS.find(function (p) { return p[0] === props.modelValue.preset })
					if (!current.value) return o.anyLabel || 'Any time'
					return (preset ? preset[1] + '  ·  ' : (o.duePrefix || '')) + fmtRange(current.value[0], current.value[1])
				})
				var note = computed(function () {
					var c = current.value
					if (!c) return ''
					var n = days(c[0], c[1])
					var text = n + (n === 1 ? ' day' : ' days') + ', both ends included'
					if (!o.compare) return text
					var p = previousPeriod(c[0], c[1])
					return text + '. Compared with the previous ' + (p[2] === 1 ? 'day' : p[2] + ' days') + ' (' + fmtRange(p[0], p[1]) + ')'
				})
				var tip = computed(function () { return label.value.replace(/\s+/g, ' ') + (note.value ? '\n' + note.value : '') })

				function place() {
					if (!btn.value) return
					var r = btn.value.getBoundingClientRect()
					var vw = window.innerWidth, vh = window.innerHeight
					var el = pop.value
					var w = el ? el.offsetWidth : Math.min(508, vw - 16)
					var h = el ? el.scrollHeight + 2 : 400
					var below = vh - r.bottom - 14, above = r.top - 14
					var s = { left: Math.max(8, Math.min(r.left, vw - w - 8)) + 'px' }
					if (h <= below || below >= above) { s.top = r.bottom + 6 + 'px'; s.maxHeight = Math.max(160, below) + 'px' }
					else { s.bottom = vh - r.top + 6 + 'px'; s.maxHeight = Math.max(160, above) + 'px' }
					style.value = s
				}
				function show() {
					var base = current.value || [new Date(), new Date()]
					draft.from = ymd(base[0])
					draft.to = ymd(base[1])
					cursor.value = new Date(base[1].getFullYear(), base[1].getMonth(), 1)
					focusDay.value = ymd(base[1])
					hover.value = ''
					place()
					open.value = true
					nextTick(function () {
						place() // again, now that the real size is known
						if (!pop.value) return
						var on = pop.value.querySelector('.presets .pick-opt.on') || (props.modelValue.preset === 'custom' ? pop.value.querySelector('.day[tabindex="0"]') : null) || pop.value.querySelector('.presets .pick-opt')
						if (on) on.focus()
					})
				}
				function close(giveBack) {
					var inside = pop.value && pop.value.contains(document.activeElement)
					open.value = false
					if ((giveBack || inside) && btn.value) btn.value.focus()
				}
				function choosePreset(key) {
					var r = o.presetRange(key)
					emit('update:modelValue', r ? { preset: key, from: ymd(r[0]), to: ymd(r[1]) } : { preset: key, from: '', to: '' })
					close(true)
				}
				function apply() {
					if (!draft.from) return
					var from = draft.from, to = draft.to || draft.from
					if (to < from) { var t = from; from = to; to = t }
					emit('update:modelValue', { preset: 'custom', from: from, to: to })
					close(true)
				}
				var monthTitle = computed(function () { return cursor.value.toLocaleDateString([], { month: 'long', year: 'numeric' }) })
				function step(n) { cursor.value = new Date(cursor.value.getFullYear(), cursor.value.getMonth() + n, 1) }
				var cells = computed(function () {
					var y = cursor.value.getFullYear(), m = cursor.value.getMonth()
					var lead = (new Date(y, m, 1).getDay() + 6) % 7
					var total = new Date(y, m + 1, 0).getDate()
					var out = Array.from({ length: lead }, function () { return null })
					for (var d = 1; d <= total; d++) out.push(new Date(y, m, d))
					return out
				})
				var bounds = computed(function () {
					var a = draft.from, b = draft.to || (hover.value && draft.from ? hover.value : '')
					return a && b ? (a <= b ? [a, b] : [b, a]) : [a, a]
				})
				function pickDay(d) {
					var s = ymd(d)
					focusDay.value = s
					if (!draft.from || draft.to) { draft.from = s; draft.to = '' } else if (s < draft.from) { draft.to = draft.from; draft.from = s } else draft.to = s
				}
				function cls(d) {
					var s = ymd(d), b = bounds.value
					return { on: s === b[0] || s === b[1], mid: s > b[0] && s < b[1], today: s === ymd(new Date()) }
				}
				// the day that can be reached with Tab; every other day is reached with the arrow keys
				var tabDay = computed(function () {
					var f = focusDay.value
					var inMonth = f && f.slice(0, 7) === ymd(cursor.value).slice(0, 7)
					return inMonth ? f : ymd(new Date(cursor.value.getFullYear(), cursor.value.getMonth(), 1))
				})
				function moveFocus(target) {
					var s = ymd(target)
					focusDay.value = s
					cursor.value = new Date(target.getFullYear(), target.getMonth(), 1)
					if (draft.from && !draft.to) hover.value = s
					nextTick(function () {
						var b = pop.value && pop.value.querySelector('[data-day="' + s + '"]')
						if (b) b.focus()
					})
				}
				function onDayKey(e, d) {
					var t = null
					switch (e.key) {
						case 'ArrowLeft': t = addDays(d, -1); break
						case 'ArrowRight': t = addDays(d, 1); break
						case 'ArrowUp': t = addDays(d, -7); break
						case 'ArrowDown': t = addDays(d, 7); break
						case 'Home': t = addDays(d, -((d.getDay() + 6) % 7)); break
						case 'End': t = addDays(d, 6 - ((d.getDay() + 6) % 7)); break
						case 'PageUp': t = new Date(d.getFullYear(), d.getMonth() - (e.shiftKey ? 12 : 1), Math.min(d.getDate(), new Date(d.getFullYear(), d.getMonth() - (e.shiftKey ? 12 : 1) + 1, 0).getDate())); break
						case 'PageDown': t = new Date(d.getFullYear(), d.getMonth() + (e.shiftKey ? 12 : 1), Math.min(d.getDate(), new Date(d.getFullYear(), d.getMonth() + (e.shiftKey ? 12 : 1) + 1, 0).getDate())); break
						default: return
					}
					e.preventDefault()
					moveFocus(t)
				}
				function onPresetKey(e) {
					if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
					var list = Array.prototype.slice.call(pop.value.querySelectorAll('.presets .pick-opt'))
					var i = list.indexOf(document.activeElement)
					if (i < 0) return
					e.preventDefault()
					list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus()
				}
				function onBtnKey(e) {
					if (!open.value && e.key === 'ArrowDown') { e.preventDefault(); show() }
				}
				// Esc closes the picker and nothing else: stop it before the page (which closes the pop-up) sees it
				function onEsc(e) {
					if (open.value && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
				}
				function onDoc(e) { if (open.value && !(pop.value && pop.value.contains(e.target)) && !(btn.value && btn.value.contains(e.target))) open.value = false }
				function onFocusOut(e) {
					var to = e.relatedTarget
					if (open.value && to && !(pop.value && pop.value.contains(to)) && !(btn.value && btn.value.contains(to))) open.value = false
				}
				function onResize() { if (open.value) place() }
				onMounted(function () {
					document.addEventListener('mousedown', onDoc)
					document.addEventListener('keydown', onEsc, true)
					window.addEventListener('resize', onResize)
				})
				onBeforeUnmount(function () {
					document.removeEventListener('mousedown', onDoc)
					document.removeEventListener('keydown', onEsc, true)
					window.removeEventListener('resize', onResize)
				})
				var longDay = function (d) { return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) }
				return { open: open, btn: btn, pop: pop, style: style, label: label, tip: tip, note: note, show: show, close: close, choosePreset: choosePreset, apply: apply, monthTitle: monthTitle, step: step, cells: cells, pickDay: pickDay, cls: cls, draft: draft, hover: hover, PRESETS: PRESETS, ymdOf: ymd, tabDay: tabDay, onDayKey: onDayKey, onPresetKey: onPresetKey, onBtnKey: onBtnKey, onFocusOut: onFocusOut, longDay: longDay }
			},
			template: '\n<div class="pick" @focusout="onFocusOut">\n' +
				'\t<button type="button" class="pick-btn range" ref="btn" :class="{ open }" :title="tip" @click="open ? close(false) : show()" @keydown="onBtnKey" aria-haspopup="dialog" :aria-expanded="open">\n' +
				'\t\t<ico name="calendar" class="lead" /><span class="pick-label">{{ label }}</span>\n' +
				'\t\t<svg class="ico chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>\n' +
				'\t</button>\n' +
				'\t<div class="pick-pop range-pop" ref="pop" v-if="open" :style="style" role="dialog" aria-label="Choose dates">\n' +
				'\t\t<div class="presets" role="group" aria-label="Quick ranges" @keydown="onPresetKey">\n' +
				'\t\t\t<button v-for="p in PRESETS" :key="p[0]" type="button" class="pick-opt" :class="{ on: modelValue.preset === p[0] }" :aria-pressed="modelValue.preset === p[0]" @click="choosePreset(p[0])"><span class="pick-label">{{ p[1] }}</span></button>\n' +
				'\t\t</div>\n' +
				'\t\t<div class="cal">\n' +
				'\t\t\t<div class="cal-head"><button type="button" class="btn ghost icon" @click="step(-1)" aria-label="Previous month"><ico name="left" /></button><b aria-live="polite">{{ monthTitle }}</b><button type="button" class="btn ghost icon" @click="step(1)" aria-label="Next month"><ico name="right" /></button></div>\n' +
				'\t\t\t<div class="cal-grid dow" aria-hidden="true"><span v-for="(d, i) in [\'M\',\'T\',\'W\',\'T\',\'F\',\'S\',\'S\']" :key="i">{{ d }}</span></div>\n' +
				'\t\t\t<div class="cal-grid" role="group" aria-label="Days" @mouseleave="hover = \'\'">\n' +
				'\t\t\t\t<template v-for="(d, i) in cells" :key="i">\n' +
				'\t\t\t\t\t<span v-if="!d"></span>\n' +
				'\t\t\t\t\t<button v-else type="button" class="day" :class="cls(d)" :data-day="ymdOf(d)" :tabindex="ymdOf(d) === tabDay ? 0 : -1" :aria-label="longDay(d)" :aria-pressed="cls(d).on || cls(d).mid" @click="pickDay(d)" @keydown="onDayKey($event, d)" @mouseenter="hover = ymdOf(d)">{{ d.getDate() }}</button>\n' +
				'\t\t\t\t</template>\n' +
				'\t\t\t</div>\n' +
				'\t\t\t<div class="cal-foot">\n' +
				'\t\t\t\t<input class="control" type="date" v-model="draft.from" aria-label="From" /><span class="sub">to</span><input class="control" type="date" v-model="draft.to" aria-label="To" @keydown.enter.prevent="apply" />\n' +
				'\t\t\t\t<button type="button" class="btn primary" :disabled="!draft.from" @click="apply">Apply</button>\n' +
				'\t\t\t</div>\n' +
				'\t\t\t<div class="cal-note sub" v-if="note">{{ note }}</div>\n' +
				'\t\t</div>\n' +
				'\t</div>\n' +
				'</div>',
		}
	}

	window.CRMRangePicker = { create: create, previousPeriod: previousPeriod, days: days }
})()
