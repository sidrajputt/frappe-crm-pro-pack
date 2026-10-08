/* Campaign Manager: application shell (left rail, router, global dialogs) and mount. */
(() => {
	const { createApp, computed, watch, nextTick, onMounted, onBeforeUnmount, ref } = Vue
	const CM = window.CM
	const V = CM.views

	const NAV = [
		{ key: 'campaigns', label: 'Campaigns', icon: 'send', path: '/campaigns' },
		{ key: 'automations', label: 'Automations', icon: 'zap', path: '/automations' },
		{ key: 'email', label: 'Email templates', icon: 'mail', path: '/templates/email' },
		{ key: 'whatsapp', label: 'WhatsApp templates', icon: 'whatsapp', path: '/templates/whatsapp' },
		{ key: 'audiences', label: 'Audiences', icon: 'users', path: '/audiences' },
		{ key: 'reports', label: 'Reports', icon: 'chart', path: '/reports' },
		{ key: 'hygiene', label: 'List clean-up', icon: 'shield', path: '/hygiene', managerOnly: true },
	]

	const App = {
		setup() {
			const r = CM.route
			const view = computed(() => {
				const p = r.parts
				switch (p[0]) {
					case 'new': return { comp: 'CampaignWizard', key: 'new' }
					case 'campaigns':
						if (p[1] === 'new') return { comp: 'CampaignWizard', key: 'new' }
						if (p[1] === 'edit' && p[2]) return { comp: 'CampaignWizard', key: 'edit' + p[2], props: { name: p[2] } }
						return { comp: 'CampaignList', key: 'list' }
					case 'edit': return { comp: 'CampaignWizard', key: 'edit' + p[1], props: { name: p[1] } }
					case 'c': return { comp: 'CampaignDetail', key: 'c' + p[1], props: { name: p[1] } }
					case 'templates':
						if (p[1] === 'whatsapp') return { comp: 'WhatsAppTemplates', key: 'wa' }
						if (p[2] === 'new' || p[2] === 'edit') return { comp: 'EmailEditorRoute', key: 'ee' }
						return { comp: 'EmailTemplates', key: 'email' }
					case 'audiences': return { comp: 'Audiences', key: 'aud' }
					case 'reports': return { comp: 'Reports', key: 'rep' }
						case 'hygiene': return { comp: 'ListHealth', key: 'hyg' }
						case 'automations':
							if (p[1] === 'new') return { comp: 'AutomationEditor', key: 'anew' + (r.query.preset || '') }
							if (p[1] === 'edit' && p[2]) return { comp: 'AutomationEditor', key: 'aedit' + p[2], props: { name: p[2] } }
							return { comp: 'AutomationList', key: 'alist' }
					default: return { comp: 'CampaignList', key: 'list' }
				}
			})
			const active = computed(() => { const p = r.parts; return p[0] === 'templates' ? (p[1] === 'whatsapp' ? 'whatsapp' : 'email') : p[0] === 'audiences' ? 'audiences' : p[0] === 'reports' ? 'reports' : p[0] === 'hygiene' ? 'hygiene' : p[0] === 'automations' ? 'automations' : 'campaigns' })
			onMounted(() => CM.loadShared())
			// the left panel can shrink to icons only; the choice is remembered in this browser
			let saved = false; try { saved = localStorage.getItem('cm_rail_collapsed') === '1' } catch (e) { /* storage blocked: start expanded */ }
			const collapsed = ref(saved)
			const toggleRail = () => { collapsed.value = !collapsed.value; try { localStorage.setItem('cm_rail_collapsed', collapsed.value ? '1' : '0') } catch (e) { /* not remembered */ } }
			// Settings are for the administrator and System Managers only (the server decides; hidden until it has said so)
			const canConfigure = computed(() => !!(CM.shared.config && CM.shared.config.can_configure))
			// a new screen starts at the top (the content pane is the same element for every screen)
			watch(() => view.value.key, () => nextTick(() => CM.scrollTop()))
			// Pop-up mode: Escape closes the pop-up, but only when nothing else wants the key (a dialog, drawer, menu or
			// the full-screen editor takes it first), and never while typing in a field.
			function onEsc(e) {
				if (e.key !== 'Escape' || e.defaultPrevented || CM.overlayOpen()) return
				const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) { t.blur(); return }
				CM.requestClose()
			}
			if (CM.embed) { onMounted(() => { window.addEventListener('keydown', onEsc); try { window.focus() } catch (e) { /* the host page focuses the frame too */ } }); onBeforeUnmount(() => window.removeEventListener('keydown', onEsc)) }
			const nav = computed(() => NAV.filter((n) => !n.managerOnly || (CM.shared.config && CM.shared.config.is_manager)))
			return { view, active, NAV: nav, collapsed, toggleRail, canConfigure, shared: CM.shared, go: CM.go, embedded: CM.embed, close: () => CM.requestClose(), newTab: CM.openInTab }
		},
		template: `
		<div class="app" :class="{ 'rail-collapsed': collapsed }">
			<nav class="rail" :class="{ collapsed }" aria-label="Campaign Manager">
					<div class="brand"><span class="brand-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.5.5 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg></span><div class="brand-txt"><b>Campaign Manager</b><span>CRM Pro Pack</span></div></div>
					<div class="nav-sec">Manage</div>
					<a v-for="n in NAV" :key="n.key" :href="'#' + n.path" class="nav" :class="{ on: active === n.key }" :title="collapsed ? n.label : null" :aria-label="n.label" :aria-current="active === n.key ? 'page' : null"><Ico :name="n.icon" /><span class="nav-l">{{ n.label }}</span></a>
					<div class="rail-foot">
						<a v-if="canConfigure" class="nav" href="/pro-pack-setup" target="_blank" rel="noopener" :title="collapsed ? 'Settings' : null" aria-label="Settings"><Ico name="settings" /><span class="nav-l">Settings</span><Ico name="external" size="sm" class="nav-x" style="margin-left:auto" /></a>
						<a v-if="!embedded" class="nav" href="/crm" :title="collapsed ? 'Back to CRM' : null" aria-label="Back to CRM"><Ico name="arrow-left" /><span class="nav-l">Back to CRM</span></a>
						<button type="button" class="nav rail-toggle" @click="toggleRail" :title="collapsed ? 'Expand the menu' : 'Collapse the menu'" :aria-label="collapsed ? 'Expand the menu' : 'Collapse the menu'" :aria-expanded="String(!collapsed)"><Ico :name="collapsed ? 'chevron-right' : 'chevron-left'" /><span class="nav-l">Collapse menu</span></button>
					</div>
				</nav>
			<main class="main">
				<div v-if="shared.error" class="page" style="padding-bottom:0"><div class="alert err"><Ico name="alert" /><div class="grow">{{ shared.error }}</div></div></div>
				<component :is="view.comp" :key="view.key" v-bind="view.props || {}" />
			</main>
			<div v-if="embedded" class="embed-ctl" role="toolbar" aria-label="Pop-up"><button type="button" class="btn ghost icon" title="Open in a new tab" aria-label="Open in a new tab" @click="newTab"><Ico name="external" /></button><button type="button" class="btn ghost icon" title="Close (Esc)" aria-label="Close" @click="close"><Ico name="x" /></button></div>
			<Toasts /><ConfirmHost />
		</div>`,
	}

	const app = createApp(App)
	Object.entries(CM.components).forEach(([k, v]) => app.component(k, v))
	Object.entries(V).forEach(([k, v]) => app.component(k, v))
	app.config.globalProperties.$wa = (n) => '{{' + n + '}}'
	app.config.globalProperties.$tok = (n) => '{{ ' + n + ' }}'
	app.config.errorHandler = (err, inst, info) => { console.error('[campaigns]', err, info); CM.toast('Something went wrong on this page. ' + (err && err.message ? err.message : ''), 'err') }
	document.title = 'Campaign Manager'
	app.mount('#app')
})()
