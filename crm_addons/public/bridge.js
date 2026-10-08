/* CRM Pro Pack bridge.
 * Loaded on demand by the scripts the app installs into Frappe CRM. It opens the add-on screens (iframes
 * served by this app) on top of the CRM page, so CRM's own source code never has to change.
 *
 *   window.crmAddons.config()                 -> settings for the current user
 *   window.crmAddons.openCalendar({view})     -> the calendar / agenda
 *   window.crmAddons.openEditor({reference_doctype, reference_docname, meeting, onSaved})
 *   window.crmAddons.openMeeting(name)
 *   window.crmAddons.openDashboard(hash?)     the Sales Dashboard (hash e.g. "#nurturing" for Lead Nurturing)
 *   window.crmAddons.openFollowUps(hash?)     the Follow-ups workspace (hash: #overdue #today #upcoming #done)
 *   window.crmAddons.openCampaigns(hash?)     the Campaign Manager (hash e.g. "#/c/CAMP-00001")
 *   window.crmAddons.openFollowUp({reference_docname, entry})   the "Add follow-up" form for a Lead
 *   window.crmAddons.close()                  close whatever is open
 *   window.addEventListener("crm-addons:changed", ...)  fires after a save / cancel
 *
 * The calendar, the dashboards, the follow-ups and the campaigns all open the same way: a large pop-up over
 * the CRM (an iframe loaded with embed=1 and the CRM's theme; the hash is passed through after the query).
 * The page inside has an "Open in a new tab" button for the full screen version. One pop-up at a time. It is
 * closed by a click on the backdrop, by Esc, by the page's own Close button (postMessage {type: "close"}), by
 * the browser's Back button, and before the CRM tab is moved on by {type: "navigate", url}.
 */
(function () {
	if (window.crmAddons) return
	// One version for everything: the page below loads its own scripts and styles with the same ?v=
	var VER = ((document.currentScript && document.currentScript.src) || "").split("v=")[1] || String(Date.now())
	VER = VER.split("&")[0]
	// every screen: where it lives, its frame title, and whether it is a large pop-up (the editors are small panels)
	var KINDS = {
		calendar: { url: "/assets/crm_addons/meetings/index.html?v=" + VER, title: "Meetings", large: true },
		dashboard: { url: "/assets/crm_addons/meetings/dashboard.html?v=" + VER, title: "Sales Dashboard", large: true },
		followups: { url: "/assets/crm_addons/meetings/followups.html?v=" + VER, title: "Follow-ups", large: true },
		campaigns: { url: "/assets/crm_addons/campaigns/index.html?v=" + VER, title: "Campaign Manager", large: true },
		editor: { url: "/assets/crm_addons/meetings/index.html?v=" + VER, title: "Meeting", large: false },
		followup: { url: "/assets/crm_addons/meetings/index.html?v=" + VER, title: "Add follow-up", large: false },
	}
	var layer = null
	var frameEl = null
	var layerKind = ""
	var pending = null
	var returnFocus = null
	var configPromise = null

	function config() {
		if (!configPromise) {
			// a request that never answers must not leave every caller waiting for ever
			var ctl = typeof AbortController === "function" ? new AbortController() : null
			var timer = ctl ? setTimeout(function () { ctl.abort() }, 20000) : null
			configPromise = fetch("/api/method/crm_addons.api.get_client_config", { credentials: "same-origin", signal: ctl ? ctl.signal : undefined })
				.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)) })
				.then(function (j) { return j.message })
				.then(function (v) { clearTimeout(timer); return v }, function (e) { clearTimeout(timer); configPromise = null; throw e })
		}
		return configPromise
	}

	// the CRM's theme: its own <html data-theme>, else the 'theme' it keeps in this browser
	function theme() {
		var t = document.documentElement.getAttribute("data-theme")
		if (!t) { try { t = localStorage.getItem("theme") } catch (e) { t = "" } }
		return t === "dark" || t === "light" ? t : ""
	}

	function close() {
		var had = layer
		if (had) {
			document.removeEventListener("keydown", onKey, true)
			had.remove()
		}
		layer = null
		frameEl = null
		layerKind = ""
		pending = null
		if (had && returnFocus && document.contains(returnFocus)) { try { returnFocus.focus({ preventScroll: true }) } catch (e) { /* ignore */ } }
		returnFocus = null
	}

	// Focus is in the CRM page (not in the frame) when this runs, so the page inside cannot handle Esc itself.
	function onKey(e) { if (e.key === "Escape" && layer) { e.preventDefault(); e.stopPropagation(); close() } }

	function hashOf(h) { h = h ? String(h) : ""; return h && h.charAt(0) !== "#" ? "#" + h : h }

	function open(kind, params, opts, hash) {
		close()
		var K = KINDS[kind]
		var large = K.large
		var q = new URLSearchParams(Object.assign({ embed: "1", theme: theme() }, params || {}))
		if (kind === "editor" || kind === "followup") q.set("mode", kind)

		returnFocus = document.activeElement && document.activeElement !== document.body ? document.activeElement : null
		layer = document.createElement("div")
		layer.setAttribute("data-crm-addons", kind)
		layer.setAttribute("role", "dialog")
		layer.setAttribute("aria-modal", "true")
		layer.setAttribute("aria-label", K.title)
		// pointer-events: CRM's own dialogs lock the page (body { pointer-events: none }) and we are a child of the body
		layer.style.cssText = "position:fixed;inset:0;z-index:2147483000;pointer-events:auto;overscroll-behavior:contain;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:" + (!large ? "16px" : "clamp(8px,3vh,32px) clamp(8px,3vw,40px)")
		var frame = document.createElement("iframe")
		frame.src = K.url + "&" + q.toString() + hashOf(hash)
		frame.title = K.title
		frame.allow = "clipboard-write"
		frame.style.cssText = "border:0;background:var(--bg,#fff);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.35);width:" + (!large ? "min(680px,100%);height:min(720px,100%)" : "min(1240px,100%);height:100%")
		layer.appendChild(frame)
		frameEl = frame
		layerKind = kind
		layer.addEventListener("mousedown", function (e) { if (e.target === layer) close() })
		document.body.appendChild(layer)
		document.addEventListener("keydown", onKey, true)
		pending = opts || {}
		// the page inside gets the keyboard (Esc, shortcuts) once it is there
		frame.addEventListener("load", function () { if (frameEl === frame) { try { frame.focus() } catch (e) { /* ignore */ } } })
		try { frame.focus() } catch (e) { /* ignore */ }
	}

	window.addEventListener("message", function (e) {
		if (e.origin !== location.origin || !e.data || e.data.source !== "crm-addons") return
		// only the pop-up that is open now may speak: a page that was closed a moment ago must not close the next one
		if (!frameEl || e.source !== frameEl.contentWindow) return
		var d = e.data
		if (d.type === "saved") {
			window.dispatchEvent(new CustomEvent("crm-addons:changed", { detail: d.meeting }))
			if (pending && typeof pending.onSaved === "function") pending.onSaved(d.meeting)
			if (d.followup) window.dispatchEvent(new CustomEvent("crm-addons:follow-up-saved", { detail: d }))
		} else if (d.type === "resize") {
			// the editor is a small panel: fit it to the form instead of leaving empty space
			if (frameEl && !KINDS[layerKind].large && d.height) frameEl.style.height = Math.min(d.height + 2, window.innerHeight - 32) + "px"
		} else if (d.type === "close") {
			close()
		} else if (d.type === "navigate" && d.url) {
			// a lead / meeting / campaign link inside a pop-up: the CRM tab goes there, the pop-up goes away
			try {
				var u = new URL(d.url, location.origin)
				close()
				// the server writes absolute links with the site's configured host name, which can differ from the address
				// this tab was opened on (an IP, another domain): the path is what matters, and it stays on this origin
				if (u.origin === location.origin || /^\/(crm|app)(\/|$)/.test(u.pathname)) window.location.assign(u.pathname + u.search + u.hash)
			} catch (err) { close() }
		}
	})
	// Back / Forward moved the CRM somewhere else: a pop-up left over the new page would be a trap
	window.addEventListener("popstate", function () { close() })

	window.crmAddons = {
		version: 2,
		config: config,
		close: close,
		openCalendar: function (p) { open("calendar", p) },
		openEditor: function (p) {
			p = p || {}
			var params = {}
			if (p.meeting) params.meeting = String(p.meeting.name || p.meeting)
			else {
				if (p.reference_doctype) params.reference_doctype = p.reference_doctype
				if (p.reference_docname) params.reference_name = p.reference_docname
			}
			open("editor", params, p)
		},
		// large pop-ups; the page inside has an "Open in a new tab" button for the full screen version
		openDashboard: function (hash) { open("dashboard", {}, null, typeof hash === "string" ? hash : "") },
		openFollowUps: function (hash) { open("followups", {}, null, typeof hash === "string" ? hash : "") },
		openCampaigns: function (hash) { open("campaigns", {}, null, typeof hash === "string" ? hash : "") },
		openFollowUp: function (p) {
			p = p || {}
			var params = {}
			if (p.reference_docname) params.reference_name = p.reference_docname
			if (p.entry) params.followup = String(p.entry.name || p.entry)
			open("followup", params, p)
		},
		openMeeting: function (name) { open("calendar", { meeting: String(name), view: "agenda" }) },
	}
})()
