/* CRM Pro Pack bridge.
 * Loaded on demand by the scripts the app installs into Frappe CRM. It opens the
 * meetings UI (an iframe served by this app) on top of the CRM page, so CRM's own
 * source code never has to change.
 *
 *   window.crmAddons.config()                 -> settings for the current user
 *   window.crmAddons.openCalendar({view})     -> the calendar / agenda
 *   window.crmAddons.openEditor({reference_doctype, reference_docname, meeting, onSaved})
 *   window.crmAddons.openMeeting(name)
 *   window.crmAddons.openDashboard()                      the Sales Dashboard, in a new tab
 *   window.crmAddons.openFollowUp({reference_docname, entry})   the "Add follow-up" form for a Lead
 *   window.addEventListener("crm-addons:changed", ...)  fires after a save / cancel
 */
(function () {
	if (window.crmAddons) return
	// One version for everything: the page below loads its own scripts and styles with the same ?v=
	var VER = ((document.currentScript && document.currentScript.src) || "").split("v=")[1] || String(Date.now())
	var BASE = "/assets/crm_addons/meetings/index.html?v=" + VER
	var DASH = "/assets/crm_addons/meetings/dashboard.html?v=" + VER
	var layer = null
	var frameEl = null
	var layerKind = ''
	var pending = null
	var configPromise = null

	function config() {
		if (!configPromise) {
			configPromise = fetch("/api/method/crm_addons.api.get_client_config", { credentials: "same-origin" })
				.then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)) })
				.then(function (j) { return j.message })
				.catch(function (e) { configPromise = null; throw e })
		}
		return configPromise
	}

	function theme() { return document.documentElement.getAttribute("data-theme") || "" }

	function close() {
		if (!layer) return
		document.removeEventListener("keydown", onKey, true)
		layer.remove()
		layer = null
		frameEl = null
		pending = null
	}

	function onKey(e) { if (e.key === "Escape" && layer) { /* the page inside handles Escape; this is a fallback */ } }

	function open(kind, params, opts) {
		close()
		var large = kind === "calendar" || kind === "dashboard"
		var q = new URLSearchParams(Object.assign({ embed: "1", theme: theme() }, params || {}))
		if (kind === "editor" || kind === "followup") q.set("mode", kind)

		layer = document.createElement("div")
		layer.setAttribute("data-crm-addons", kind)
		layer.style.cssText = "position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.5);display:flex;align-items:center;justify-content:center;padding:" + (!large ? "16px" : "clamp(8px,3vh,32px) clamp(8px,3vw,40px)")
		var frame = document.createElement("iframe")
		frame.src = (kind === "dashboard" ? DASH : BASE) + "&" + q.toString()
		frame.title = kind === "dashboard" ? "Sales Dashboard" : "Meetings"
		frame.allow = "clipboard-write"
		frame.style.cssText = "border:0;background:var(--bg,#fff);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.35);width:" + (!large ? "min(680px,100%);height:min(720px,100%)" : "min(1240px,100%);height:100%")
		layer.appendChild(frame)
		frameEl = frame
		layerKind = kind
		layer.addEventListener("mousedown", function (e) { if (e.target === layer) close() })
		document.body.appendChild(layer)
		document.addEventListener("keydown", onKey, true)
		pending = opts || {}
		setTimeout(function () { try { frame.focus() } catch (e) { /* ignore */ } }, 50)
	}

	window.addEventListener("message", function (e) {
		if (e.origin !== location.origin || !e.data || e.data.source !== "crm-addons") return
		var d = e.data
		if (d.type === "saved") {
			window.dispatchEvent(new CustomEvent("crm-addons:changed", { detail: d.meeting }))
			if (pending && typeof pending.onSaved === "function") pending.onSaved(d.meeting)
			if (d.followup) window.dispatchEvent(new CustomEvent("crm-addons:follow-up-saved", { detail: d }))
		} else if (d.type === "resize") {
			// the editor is a small panel: fit it to the form instead of leaving empty space
			if (frameEl && layerKind !== "calendar" && layerKind !== "dashboard" && d.height) frameEl.style.height = Math.min(d.height + 2, window.innerHeight - 32) + "px"
		} else if (d.type === "close") {
			close()
		} else if (d.type === "navigate" && d.url) {
			try {
				var u = new URL(d.url, location.origin)
				close()
				if (u.origin === location.origin) window.location.assign(u.pathname + u.search + u.hash)
			} catch (err) { /* ignore */ }
		}
	})

	window.crmAddons = {
		version: 1,
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
		// full screen, in a tab of its own
		openDashboard: function () { window.open(DASH, "_blank") },
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
