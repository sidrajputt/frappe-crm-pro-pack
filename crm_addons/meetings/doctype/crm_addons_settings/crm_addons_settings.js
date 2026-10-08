// Settings page: shows a live setup checklist and the admin guide.
frappe.ui.form.on("CRM Addons Settings", {
	refresh(frm) {
		frm.disable_save_on_unsaved = false;
		frm.dashboard.add_comment(
			__("There is a friendlier version of this page with switches, explanations for every option and a setup checklist:") +
				' <a href="/pro-pack-setup"><b>' + __("Open the setup page") + "</b></a>",
			"blue",
			true
		);
		frm.add_custom_button(__("Open the setup page"), () => window.open("/pro-pack-setup", "_blank")).addClass("btn-primary");
		frm.add_custom_button(__("Test Google connection"), () => {
			frappe.call({
				method: "crm_addons.api.test_google_connection",
				freeze: true,
				callback: (r) => {
					const m = r.message || {};
					frappe.msgprint({ title: __("Google connection"), message: m.message, indicator: m.ok ? "green" : "red" });
				},
			});
		});
		frm.add_custom_button(__("Open Google Calendar setup"), () => frappe.set_route("List", "Google Calendar"));
		frm.add_custom_button(__("Open meetings calendar"), () => window.open("/assets/crm_addons/meetings/index.html", "_blank"));
		frm.trigger("render_setup");
	},

	render_setup(frm) {
		const wrapper = frm.fields_dict.setup_html.$wrapper;
		wrapper.html(`<div class="text-muted">${__("Checking setup...")}</div>`);
		frappe.call({
			method: "crm_addons.api.get_setup_status",
			callback: (r) => {
				const s = r.message;
				if (!s) return;
				const esc = frappe.utils.escape_html;
				const checks = s.checks
					.map(
						(c) => `<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:8px">
							<span style="font-size:16px;line-height:1.2">${c.ok ? "&#9989;" : "&#9888;&#65039;"}</span>
							<div><b>${esc(c.label)}</b><div class="text-muted">${esc(c.message || "")}</div></div></div>`
					)
					.join("");
				const providers = s.providers
					.map((p) => {
						const badge = !p.implemented
							? `<span class="indicator-pill gray">${__("Coming soon")}</span>`
							: p.ready
							? `<span class="indicator-pill green">${__("Ready")}</span>`
							: `<span class="indicator-pill orange">${__("Needs setup")}</span>`;
						return `<div style="display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--border-color)">
							<div><b>${esc(p.label)}</b><div class="text-muted small">${esc(p.description || "")}</div></div>${badge}</div>`;
					})
					.join("");
				wrapper.html(`
					<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:24px">
						<div><h5>${__("Setup status")}</h5>${checks}</div>
						<div><h5>${__("Meeting providers")}</h5>${providers}</div>
					</div>
					<details style="margin-top:16px" open>
						<summary><b>${__("Admin guide: connect Google Meet in 5 steps")}</b></summary>
						<ol style="margin-top:10px;line-height:1.7">
							<li>${__("In Google Cloud Console create a project, enable the")} <b>Google Calendar API</b>, ${__("and create an OAuth client of type")} <b>Web application</b>.</li>
							<li>${__("Add this Authorized redirect URI:")}<br><code>${esc(s.redirect_uri)}</code></li>
							<li>${__("Under Google Settings, enable the integration and enter the Client ID and Client Secret.")}</li>
							<li>${__("Create a Google Calendar record for a company account (for example sales@yourcompany.com), tick")} <b>Enable</b> ${__("and")} <b>Push to Google Calendar</b>, ${__("then click")} <b>Authorize Google Calendar Access</b>.</li>
							<li>${__("Choose that record as the")} <b>${__("Company Google Calendar")}</b> ${__("below and save. Sales users now schedule meetings without ever signing in to Google.")}</li>
						</ol>
						<p class="text-muted">${__("If the Google consent screen is in Testing mode, add the company account as a Test user, and note that Google expires the login every 7 days until the app is published.")}</p>
					</details>`);
			},
		});
	},
});
